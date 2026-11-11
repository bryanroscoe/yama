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
