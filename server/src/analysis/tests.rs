//! The Rust analysis must reproduce the calibration prototype's numbers (cases.json: per-card
//! points, land quality and six whole decks), plus a few rules worth naming on their own.

use super::classify::{Cat, card_points};
use super::*;
use crate::deck_checks::Combo;
use serde_json::Value;

const CASES: &str = include_str!("cases.json");

fn facts(v: &Value) -> Facts {
    let s = |k: &str| v[k].as_str().map(String::from);
    Facts {
        name: s("name").unwrap(),
        cmc: v["cmc"].as_f64().unwrap_or(0.0),
        mana_cost: s("mana_cost").unwrap_or_default(),
        type_line: s("type_line").unwrap_or_default(),
        oracle_text: s("oracle_text").unwrap_or_default(),
        power: s("power"),
        color_identity: s("color_identity").unwrap_or_default(),
        produced_mana: s("produced_mana"),
        game_changer: v["game_changer"].as_bool(),
    }
}

fn cases() -> Value {
    serde_json::from_str(CASES).unwrap()
}

#[test]
fn every_card_scores_as_calibrated() {
    let mut wrong = vec![];
    for c in cases()["cards"].as_array().unwrap() {
        let f = facts(&c["facts"]);
        let Some(want) = c["points"].as_object() else { continue };
        let got = card_points(&f, false);
        let got_keys: Vec<&str> = got.iter().map(|(k, _)| k.key()).collect();
        let mut want_keys: Vec<&str> = want.keys().map(|k| k.as_str()).collect();
        want_keys.sort_by_key(|k| Cat::from_key(k).unwrap());
        let close = got_keys == want_keys && got.iter().all(|(k, v)| (v - want[k.key()].as_f64().unwrap()).abs() < 0.011);
        if !close {
            wrong.push(format!("{}: got {:?}, want {:?}", f.name, got.iter().map(|(k, v)| (k.key(), *v)).collect::<Vec<_>>(), want));
        }
    }
    assert!(wrong.is_empty(), "{} cards differ:\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn every_land_scores_as_calibrated() {
    let mut wrong = vec![];
    for c in cases()["cards"].as_array().unwrap() {
        let f = facts(&c["facts"]);
        for (k, want) in c["lands"].as_object().unwrap() {
            let (label, q) = lands::quality(&f, k.parse().unwrap());
            if label != want[0].as_str().unwrap() || (q - want[1].as_f64().unwrap()).abs() > 1e-9 {
                wrong.push(format!("{} ({k} colors): got {label} {q}, want {want}", f.name));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

fn check(combos: &Value) -> Option<CheckResult> {
    let list = combos.as_array()?;
    let strings = |v: &Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect::<Vec<_>>();
    Some(CheckResult {
        checked_at: String::new(),
        bracket_tag: "C".into(),
        bracket_label: "",
        bracket: Some(2),
        game_changers: vec![],
        mld: vec![],
        extra_turns: vec![],
        combos: list
            .iter()
            .map(|x| Combo {
                id: String::new(),
                cards: strings(&x["cards"]),
                templates: strings(&x["templates"]),
                results: strings(&x["results"]),
                definitely_two_card: x["definitely_two_card"].as_bool().unwrap(),
                arguably_two_card: x["arguably_two_card"].as_bool().unwrap(),
                mana_needed: None,
                flags: vec![],
                bracket_tag: None,
            })
            .collect(),
        unrecognized: vec![],
    })
}

#[test]
fn whole_decks_score_as_calibrated() {
    let cases = cases();
    let facts_by_id: HashMap<String, Facts> =
        cases["cards"].as_array().unwrap().iter().map(|c| (c["facts"]["oracle_id"].as_str().unwrap().to_string(), facts(&c["facts"]))).collect();
    for d in cases["decks"].as_array().unwrap() {
        let name = d["name"].as_str().unwrap();
        let list: Vec<DeckCard> = serde_json::from_value(d["list"].clone()).unwrap();
        let entries: Vec<Entry> = list.iter().map(|c| Entry { card: c, facts: facts_by_id.get(&c.oracle_id) }).collect();
        let check = check(&d["combos"]);
        let a = analyze(&entries, check.as_ref(), &mut Cache::default());
        let want = &d["expected"];
        assert!((a.power - want["power"].as_f64().unwrap()).abs() < 0.11, "{name}: power {} vs {}", a.power, want["power"]);
        for v in &a.vectors {
            let key = serde_json::to_value(v.key).unwrap();
            let w = want["vectors"][key.as_str().unwrap()].as_f64().unwrap();
            assert!((v.score - w).abs() <= 1.0, "{name}: {} {} vs {w}", v.label, v.score);
        }
        let themes: Vec<&str> = a.themes.iter().map(|t| t.label.as_str()).collect();
        let want_themes: Vec<&str> = want["themes"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        assert_eq!(themes, want_themes, "{name}: themes");
        assert_eq!(a.combos.checked, check.is_some(), "{name}");
    }
}

fn card(name: &str, cmc: f64, type_line: &str, text: &str) -> Facts {
    Facts { name: name.into(), cmc, type_line: type_line.into(), oracle_text: text.into(), ..Facts::default() }
}

#[test]
fn reads_this_type_as_the_card_itself() {
    // Current Oracle text says "this artifact", not the card's name.
    let stone = card("Mind Stone", 2.0, "Artifact", "{T}: Add {C}.\n{1}, {T}, Sacrifice this artifact: Draw a card.");
    let pts = card_points(&stone, false);
    assert_eq!(pts.iter().map(|(c, _)| c.key()).collect::<Vec<_>>(), ["rocks", "cantrips"], "{pts:?}");
}

#[test]
fn counts_one_color_of_a_choice() {
    // "{R} or {W}" is one mana, so a two-mana Talisman is a rock, not fast mana.
    let t = card("Talisman of Conviction", 2.0, "Artifact", "{T}: Add {C}.\n{T}: Add {R} or {W}. This artifact deals 1 damage to you.");
    assert_eq!(card_points(&t, false), vec![(Cat::Rocks, 5.0)]);
}

#[test]
fn lords_and_team_boosts_earn_points() {
    let pts = |name: &str, cmc: f64, ty: &str, text: &str| card_points(&card(name, cmc, ty, text), false);
    let payoff = |p: &Points| p.iter().find(|(c, _)| *c == Cat::Payoffs).map(|(_, v)| *v);
    // A typed lord, old wording and new, and the size of the bonus.
    assert_eq!(payoff(&pts("Predatory Sliver", 2.0, "Creature — Sliver", "Sliver creatures you control get +1/+1.")), Some(2.5));
    assert_eq!(payoff(&pts("Bonesplitter Sliver", 4.0, "Creature — Sliver", "All Sliver creatures get +2/+0.")), Some(3.5));
    assert_eq!(payoff(&pts("Crucible of Fire", 4.0, "Enchantment", "Dragon creatures you control get +3/+3.")), Some(4.5));
    assert_eq!(payoff(&pts("Icon of Ancestry", 3.0, "Artifact", "As this artifact enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.")), Some(2.5));
    assert_eq!(payoff(&pts("Skeleton Crew", 4.0, "Creature — Skeleton Pirate", "Each other creature you control that's a Skeleton or Pirate gets +1/+1.")), Some(2.5));
    // Keywords handed to the team, and a bonus with a keyword.
    assert_eq!(payoff(&pts("Galerider Sliver", 1.0, "Creature — Sliver", "Sliver creatures you control have flying.")), Some(2.5));
    assert_eq!(payoff(&pts("Bonescythe Sliver", 4.0, "Creature — Sliver", "Sliver creatures you control have double strike.")), Some(4.0));
    assert_eq!(payoff(&pts("Hofri Ghostforge", 5.0, "Legendary Creature — Dwarf Cleric", "Spirits you control get +1/+1 and have trample and haste.")), Some(3.0));
    assert_eq!(payoff(&pts("Shifting Sliver", 4.0, "Creature — Sliver", "Slivers can't be blocked except by Slivers.")), Some(2.5));
    // A creature type whose plural has no "s", and a keyword beside protection.
    assert_eq!(payoff(&pts("Lord of Atlantis", 2.0, "Creature — Merfolk", "Other Merfolk get +1/+1 and have islandwalk.")), Some(3.0));
    assert_eq!(payoff(&pts("Test Myr", 3.0, "Artifact Creature — Myr", "Myr you control get +1/+1.")), Some(2.5));
    let shelob = pts("Test Spider", 6.0, "Legendary Creature — Spider Demon", "Other Spiders you control have deathtouch and ward {2}.");
    assert_eq!(shelob, vec![(Cat::Protection, 3.5), (Cat::Payoffs, 2.5)], "{shelob:?}");
    // The whole team taps for mana: a mana creature. The whole team is protected: protection.
    assert_eq!(pts("Manaweft Sliver", 2.0, "Creature — Sliver", "Sliver creatures you control have \"{T}: Add one mana of any color.\""), vec![(Cat::Dorks, 4.0)]);
    assert_eq!(pts("Crystalline Sliver", 2.0, "Creature — Sliver", "All Slivers have shroud."), vec![(Cat::Protection, 3.5)]);
    // A kind of creature given haste is haste, as the whole team's is.
    assert_eq!(pts("Test Warchief", 3.0, "Creature — Goblin", "Goblins you control have haste."), vec![(Cat::Haste, 2.0)]);
    let shredder = pts("Test Shredder", 3.0, "Creature — Sliver", "Sliver creatures you control have flying and haste.");
    assert_eq!(shredder, vec![(Cat::Haste, 2.0), (Cat::Payoffs, 2.5)], "{shredder:?}");
    // What helps the opponents' creatures is no team boost.
    assert_eq!(pts("Test Taunt", 3.0, "Enchantment", "Creatures your opponents control get +1/+0 and attack each combat if able."), vec![]);
    assert_eq!(pts("Test Gift", 3.0, "Enchantment", "Creatures your opponents control have hexproof."), vec![]);
    // A pump for one turn is a finisher's business, one creature's bonus is nobody's team, and
    // things that aren't creatures aren't a team.
    assert_eq!(payoff(&pts("Trumpet Blast", 3.0, "Instant", "Attacking creatures get +2/+0 until end of turn.")), None);
    assert_eq!(payoff(&pts("Test Aura", 2.0, "Enchantment — Aura", "Enchant creature\nEnchanted creature gets +2/+2 and has flying.")), None);
    assert_eq!(payoff(&pts("Test Hoard", 5.0, "Creature — Dragon", "Treasures you control have \"{T}, Sacrifice this artifact: Add two mana of any one color.\"")), None);
    let lantern = pts("Test Lantern", 3.0, "Artifact", "Lands you control have \"{T}: Add one mana of any color.\"\n{T}: Add one mana of any color.");
    assert_eq!(lantern.iter().map(|(c, _)| c.key()).collect::<Vec<_>>(), ["rocks"], "{lantern:?}");
}

#[test]
fn proliferate_and_planeswalker_support_earn_points() {
    let payoff = |name: &str, ty: &str, text: &str| card_points(&card(name, 3.0, ty, text), false).iter().find(|(c, _)| *c == Cat::Payoffs).map(|(_, v)| *v);
    assert_eq!(payoff("Test Spell", "Instant", "Draw a card. Proliferate."), Some(2.0));
    assert_eq!(payoff("Test Sage", "Creature — Elf Druid", "Landfall — Whenever a land you control enters, proliferate."), Some(3.0));
    assert_eq!(payoff("Test Veil", "Legendary Artifact", "{4}, {T}: For each planeswalker you control, you may activate one of its loyalty abilities once this turn as though none of its loyalty abilities had been activated this turn."), Some(3.0));
    assert_eq!(payoff("Test Summons", "Sorcery", "Look at the top seven cards of your library. Put up to two planeswalker cards from among them onto the battlefield."), Some(4.0));
    // Shutting loyalty abilities off is no support for them.
    assert_eq!(payoff("Test Sun", "Legendary Artifact", "Players can't activate planeswalkers' loyalty abilities."), None);
}

#[test]
fn three_more_themes_are_named() {
    let entry = |i: usize, f: &Facts| (DeckCard { oracle_id: format!("o{i}"), name: f.name.clone(), qty: 1, board: Board::Main }, f.clone());
    let keys = |cards: Vec<Facts>| -> Vec<String> {
        let list: Vec<(DeckCard, Facts)> = cards.iter().enumerate().map(|(i, f)| entry(i, f)).collect();
        let entries: Vec<Entry> = list.iter().map(|(c, f)| Entry { card: c, facts: Some(f) }).collect();
        analyze(&entries, None, &mut Cache::default()).themes.into_iter().map(|t| t.key).collect()
    };
    let many = |n: usize, ty: &str, text: &str| -> Vec<Facts> { (0..n).map(|i| card(&format!("Card {i}"), 3.0, ty, text)).collect() };
    assert_eq!(keys(many(6, "Legendary Planeswalker — Test", "+1: Draw a card.")), ["planeswalkers"]);
    assert_eq!(keys(many(6, "Enchantment", "Whenever you cast a legendary spell, draw a card.")), ["legends"]);
    assert_eq!(keys(many(6, "Sorcery", "Goad target creature.")), ["goad"]);
    // Proliferate on its own is a counters deck, or poison: no planeswalker theme.
    assert_eq!(keys(many(6, "Instant", "Proliferate.")), Vec::<String>::new());
    // Cards that only name planeswalkers or legends in passing make no theme.
    assert_eq!(keys(many(6, "Instant", "Destroy target creature or planeswalker.")), Vec::<String>::new());
    assert_eq!(keys(many(6, "Sorcery", "Return target creature or planeswalker card from your graveyard to your hand.")), ["graveyard"]);
    assert_eq!(keys(many(6, "Instant", "This spell costs {2} less to cast if it targets a legendary creature. Destroy target creature.")), Vec::<String>::new());
    // "You or planeswalkers you control" is how a card keeps attackers off you: table politics,
    // not a planeswalker theme.
    assert_eq!(keys(many(6, "Enchantment", "Creatures can't attack you or planeswalkers you control unless their controller pays {2}.")), ["goad"]);
}

#[test]
fn the_commander_counts_half_again() {
    let engine = card("Tymna the Weaver", 3.0, "Legendary Creature — Human Cleric", "Lifelink\nAt the beginning of your postcombat main phase, you may pay X life, where X is the number of opponents that were dealt combat damage this turn. If you do, draw X cards.");
    let alone = card_points(&engine, false);
    let commanding = card_points(&engine, true);
    assert_eq!(alone.len(), commanding.len());
    for ((_, a), (_, c)) in alone.iter().zip(&commanding) {
        assert!((c - a * 1.5).abs() < 1e-9);
    }
}

#[test]
fn an_empty_list_scores_the_bottom_with_a_wide_margin() {
    let a = analyze(&[], None, &mut Cache::default());
    assert_eq!(a.power, 1.0);
    assert!(!a.combos.checked);
    assert!(a.margin >= 0.5, "no combo check widens it: {}", a.margin);
    assert_eq!(a.power_bracket, 2);
}

#[test]
fn every_copy_shows_and_counts() {
    let rock = card("Test Rock", 2.0, "Artifact", "{T}: Add {C}.");
    let deck = |qty| DeckCard { oracle_id: "o-rock".into(), name: "Test Rock".into(), qty, board: Board::Main };
    let speed = |a: &DeckAnalysis| a.vectors.iter().find(|v| v.key == classify::Vector::Speed).unwrap().clone();
    let (one, three) = (deck(1), deck(3));
    let a1 = analyze(&[Entry { card: &one, facts: Some(&rock) }], None, &mut Cache::default());
    let a3 = analyze(&[Entry { card: &three, facts: Some(&rock) }], None, &mut Cache::default());
    let rocks = &speed(&a3).groups[0].cards[0];
    assert_eq!((rocks.name.as_str(), rocks.copies, rocks.points), ("Test Rock", 3, 5.0));
    assert!(speed(&a3).score > speed(&a1).score, "three copies count three times");
}

#[test]
fn cards_spellbook_did_not_know_widen_the_margin() {
    let mut r = check(&serde_json::json!([])).unwrap();
    let known = analyze(&[], Some(&r), &mut Cache::default());
    r.unrecognized = vec!["Homebrew One".into(), "Homebrew Two".into()];
    let partial = analyze(&[], Some(&r), &mut Cache::default());
    assert_eq!(partial.combos.unrecognized, 2);
    assert!((partial.margin - known.margin - 0.2).abs() < 1e-9, "{} vs {}", partial.margin, known.margin);
}

#[test]
fn unresolved_names_count_as_unknown_cards() {
    let rock = card("Test Rock", 2.0, "Artifact", "{T}: Add {C}.");
    let one = DeckCard { oracle_id: "o-rock".into(), name: "Test Rock".into(), qty: 1, board: Board::Main };
    let r = check(&serde_json::json!([])).unwrap();
    let mut a = analyze(&[Entry { card: &one, facts: Some(&rock) }], Some(&r), &mut Cache::default());
    let before = a.margin;
    add_unresolved(&mut a, &["Sol Rnig".into(), "Homebrew".into()]);
    assert_eq!(a.unknown_cards, ["Sol Rnig", "Homebrew"]);
    assert!((a.margin - before - 0.2).abs() < 1e-9, "{} vs {before}", a.margin);
    assert_eq!(a.confidence, "medium");
    // One card that can't be read is already not "every card read".
    let mut one = analyze(&[Entry { card: &one, facts: Some(&rock) }], Some(&r), &mut Cache::default());
    assert_eq!((one.margin, one.confidence), (0.7, "high"), "everything read: the measured base");
    add_unresolved(&mut one, &["Sol Rnig".into()]);
    assert_eq!((one.margin, one.confidence), (0.8, "medium"));
}

#[test]
fn the_bracket_reading_keeps_power_and_the_card_rules_apart() {
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // A stock precon holding one Game Changer: it plays like Bracket 2, and the rules say 3.
    let precon = reading(3.8, 0.7, Some(&names(&["Narset, Parter of Veils"])), None, false);
    assert_eq!((precon.plays_like, precon.rules), ([2, 2], Some(3)));
    assert_eq!(precon.flags, ["1 Game Changer: Narset, Parter of Veils"]);
    // A tuned list with none: the rules allow Bracket 2, and the margin reaches Bracket 3.
    let tuned = reading(4.6, 0.7, Some(&[]), None, false);
    assert_eq!((tuned.plays_like, tuned.rules, tuned.flags.len()), ([2, 3], Some(2), 0));
    // Four Game Changers are Bracket 4 by the rules whatever the power.
    assert_eq!(reading(5.5, 0.7, Some(&names(&["a", "b", "c", "d"])), None, false).rules, Some(4));
    // No flags in the card data and no check: the rules can't be read.
    assert_eq!(reading(7.5, 0.7, None, None, false), Reading { plays_like: [3, 4], rules: None, flags: vec![] });

    // A Spellbook check adds what it flags, and its tag can only raise the rules reading.
    let mut r = check(&serde_json::json!([])).unwrap();
    r.mld = names(&["Ruination"]);
    (r.bracket_tag, r.bracket) = ("R".into(), Some(4));
    let ruined = reading(3.0, 0.7, Some(&[]), Some(&r), false);
    assert_eq!((ruined.plays_like, ruined.rules), ([2, 2], Some(4)));
    assert_eq!(ruined.flags, ["Mass land denial: Ruination"]);
    (r.bracket_tag, r.bracket) = ("C".into(), Some(2));
    r.mld.clear();
    assert_eq!(reading(3.0, 0.7, Some(&names(&["Rhystic Study"])), Some(&r), false).rules, Some(3));
    // A tag raised by something the flags don't list still says whose reading it is.
    (r.bracket_tag, r.bracket_label, r.bracket) = ("S".into(), "Spicy", Some(3));
    let spicy = reading(3.0, 0.7, Some(&[]), Some(&r), false);
    assert_eq!((spicy.rules, spicy.flags.as_slice()), (Some(3), ["Commander Spellbook's estimate: Spicy".to_string()].as_slice()));
    (r.bracket_tag, r.bracket_label, r.bracket) = ("C".into(), "Core", Some(2));
    // Without Yama's own flags, Spellbook's list of Game Changers stands in.
    r.game_changers = names(&["Rhystic Study", "The One Ring"]);
    let stand_in = reading(3.0, 0.7, None, Some(&r), false);
    assert_eq!((stand_in.rules, stand_in.flags.as_slice()), (Some(3), ["2 Game Changers: Rhystic Study, The One Ring".to_string()].as_slice()));
}

#[test]
fn a_list_reads_its_own_game_changers_and_a_wider_margin_moves_what_it_plays_like() {
    let study = Facts { game_changer: Some(true), ..card("Test Study", 3.0, "Enchantment", "Whenever an opponent casts a spell, you may draw a card.") };
    let rock = Facts { game_changer: Some(false), ..card("Test Rock", 2.0, "Artifact", "{T}: Add {C}.") };
    let cards = [
        DeckCard { oracle_id: "o-study".into(), name: "Test Study".into(), qty: 1, board: Board::Main },
        DeckCard { oracle_id: "o-rock".into(), name: "Test Rock".into(), qty: 1, board: Board::Main },
    ];
    let mut a = analyze(&[Entry { card: &cards[0], facts: Some(&study) }, Entry { card: &cards[1], facts: Some(&rock) }], None, &mut Cache::default());
    assert_eq!((a.bracket.plays_like, a.bracket.rules), ([2, 2], Some(3)));
    assert_eq!(a.bracket.flags, ["1 Game Changer: Test Study"]);
    assert_eq!(a.power_bracket, 2);
    // A card with no flag yet: no count, so no rules reading.
    let unflagged = card("Test Rock", 2.0, "Artifact", "{T}: Add {C}.");
    let b = analyze(&[Entry { card: &cards[0], facts: Some(&study) }, Entry { card: &cards[1], facts: Some(&unflagged) }], None, &mut Cache::default());
    assert_eq!(b.bracket.rules, None);
    // What was found stands when part of the list can't be read; "nothing found" does not.
    let missing = DeckCard { oracle_id: "o-missing".into(), name: "Not In The Data".into(), qty: 1, board: Board::Main };
    let partly = analyze(&[Entry { card: &cards[0], facts: Some(&study) }, Entry { card: &missing, facts: None }], None, &mut Cache::default());
    assert_eq!(partly.bracket.rules, Some(3));
    let clean = analyze(&[Entry { card: &cards[1], facts: Some(&rock) }], None, &mut Cache::default());
    assert_eq!(clean.bracket.rules, Some(2));
    let unread = analyze(&[Entry { card: &cards[1], facts: Some(&rock) }, Entry { card: &missing, facts: None }], None, &mut Cache::default());
    assert_eq!(unread.bracket.rules, None, "the missing card could be a Game Changer");
    let mut pasted = clean.clone();
    add_unresolved(&mut pasted, &["Rhystic Stuudy".into()]);
    assert_eq!(pasted.bracket.rules, None);
    // The reading follows the margin when unresolved names widen it.
    a.power = 4.4;
    add_unresolved(&mut a, &["Sol Rnig".into(), "Homebrew".into(), "Another".into(), "More".into(), "Again".into()]);
    assert_eq!(a.bracket.plays_like, [2, 3], "margin {}", a.margin);
    assert_eq!(a.bracket.rules, Some(3), "a Game Changer that was found still counts");
}
