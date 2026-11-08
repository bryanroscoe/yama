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
