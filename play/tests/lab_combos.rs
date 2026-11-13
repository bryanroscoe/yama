//! Lab games as they are played since 13 Nov 2026: with the engine's loop detection, and each
//! seat's AI told the combos known in its list. Cards come from tests/fixtures/loop-cards.json.

use std::path::Path;
use std::sync::Mutex;

use yama_play::lab::{self, End, GameOptions, GameSpec, Live};
use yama_play::{Difficulty, Engine, SeatCombo, SeatDeck};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/loop-cards.json")).unwrap()
}

fn deck(cards: &[(&str, usize)]) -> SeatDeck {
    let main: Vec<String> = cards.iter().flat_map(|(name, n)| vec![name.to_string(); *n]).collect();
    assert_eq!(main.len(), 99);
    SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main }
}

fn spec() -> GameSpec {
    GameSpec { game: "lab-combos".into(), seed: 11, decks: vec!["drain".into(), "lands".into()], difficulty: "Easy".into(), max_turns: 40, max_actions: 20_000, max_seconds: 120, pilots: None }
}

/// A deck of the drain (Marauding Blight-Priest, Bloodthirsty Conqueror, Chaplain's Blessing)
/// against a deck of nothing but Plains.
fn decks() -> Vec<SeatDeck> {
    vec![
        deck(&[("Swamp", 22), ("Plains", 12), ("Marauding Blight-Priest", 22), ("Bloodthirsty Conqueror", 21), ("Chaplain's Blessing", 22)]),
        deck(&[("Plains", 99)]),
    ]
}

#[test]
fn a_lab_game_plays_with_loop_detection_and_seat_combos() {
    let e = engine();
    let drain = SeatCombo { id: "drain".into(), cards: vec!["Marauding Blight-Priest".into(), "Bloodthirsty Conqueror".into(), "Chaplain's Blessing".into()] };
    let opts = GameOptions { combos: vec![vec![drain], vec![]], ..GameOptions::default() };
    assert!(opts.loops, "the default");
    let live = Mutex::new(Live::new());
    let r = lab::play_game_isolated(&e, &spec(), Difficulty::Easy, decks(), "fixture", &opts, &live).result;
    assert_eq!((r.end, r.winner, r.error.as_deref()), (End::Win, Some(0), None), "{}", r.to_line());
    assert_eq!(r.engine, lab::ENGINE, "labelled as played with loop detection");
    assert!(r.engine.ends_with("+loops"));
}

#[test]
fn a_lab_game_without_loop_detection_keeps_the_earlier_label() {
    let e = engine();
    let opts = GameOptions { loops: false, ..GameOptions::default() };
    let live = Mutex::new(Live::new());
    let r = lab::play_game_isolated(&e, &spec(), Difficulty::Easy, decks(), "fixture", &opts, &live).result;
    assert!(!r.end.failed(), "{}", r.to_line());
    assert_eq!(r.engine, lab::ENGINE_WITHOUT_LOOPS);
    assert!(!r.engine.contains("+loops"));
}
