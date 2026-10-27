//! Frozen production failures and a successful control. These are gameplay acceptance tests:
//! reproducing an error is a failure, even when the runner exits successfully or repeats it.
//! Run with the pinned card data, in release, one test at a time:
//!   YAMA_ENGINE_CARD_DATA=... cargo test --release -p yama-play --test lab_regressions -- --ignored --test-threads=1

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use yama_play::lab::{self, End, GameOptions, GameSpec, Live};
use yama_play::{DeckLine, Engine};

#[derive(Deserialize)]
struct Card {
    name: String,
    #[serde(default)]
    oracle_id: String,
    qty: u32,
    #[serde(default)]
    commander: bool,
}

#[derive(Deserialize)]
struct Deck {
    id: String,
    cards: Vec<Card>,
}

#[derive(Deserialize)]
struct Control {
    winner: Option<u8>,
    turns: u32,
    actions: usize,
}

#[derive(Deserialize)]
struct Case {
    spec: GameSpec,
    card_data: String,
    turn_action_cap: usize,
    decks: Vec<Deck>,
    expected_control: Option<Control>,
}

fn card_data() -> PathBuf {
    std::env::var_os("YAMA_ENGINE_CARD_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../data/engine/card-data-1e5608e61683de41.json")
        })
}

fn check(fixture: &str) {
    let case: Case = serde_json::from_str(fixture).expect("frozen fixture parses");
    let path = card_data();
    assert!(
        path.is_file(),
        "missing card data at {}; set YAMA_ENGINE_CARD_DATA",
        path.display()
    );
    assert_eq!(
        lab::card_data_hash(&path),
        case.card_data,
        "replay requires the fixture's card data"
    );
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    let engine = ENGINE.get_or_init(|| Engine::load(&path).expect("card data loads"));
    assert_eq!(
        case.spec.decks,
        case.decks.iter().map(|d| d.id.clone()).collect::<Vec<_>>(),
        "seat order is frozen"
    );
    let decks = case
        .decks
        .iter()
        .map(|d| {
            let lines: Vec<_> = d
                .cards
                .iter()
                .map(|c| DeckLine {
                    oracle_id: &c.oracle_id,
                    name: &c.name,
                    qty: c.qty,
                    commander: c.commander,
                })
                .collect();
            let (deck, report) = engine.resolve_deck(&lines);
            assert!(
                report.missing.is_empty(),
                "{}: unknown cards {:?}",
                d.id,
                report.missing
            );
            assert_eq!(
                deck.main.len() + deck.commander.len(),
                100,
                "{}: complete deck",
                d.id
            );
            deck
        })
        .collect();
    let opts = GameOptions {
        turn_action_cap: case.turn_action_cap,
        ..Default::default()
    };
    let result = lab::play_game_isolated(
        engine,
        &case.spec,
        case.spec.check().expect("schedule checks"),
        decks,
        &case.card_data,
        &opts,
        &Mutex::new(Live::new()),
    )
    .result;
    assert!(
        matches!(result.end, End::Win | End::Draw),
        "{} did not finish normally: {}",
        case.spec.game,
        result.to_line()
    );
    assert!(
        result.error.is_none(),
        "{} retained an error",
        case.spec.game
    );
    if let Some(expected) = case.expected_control {
        assert_eq!(
            (result.winner, result.turns, result.actions),
            (expected.winner, expected.turns, expected.actions),
            "successful control changed"
        );
    }
}

#[test]
#[ignore = "full production replay; currently reproduces the priority-session defect"]
fn lorehold_priority_session_finishes() {
    check(include_str!(
        "fixtures/lab-regressions/d566002e-18-variant.json"
    ));
}

#[test]
#[ignore = "full production replay; currently reproduces the priority-session defect"]
fn tricky_terrain_priority_session_finishes() {
    check(include_str!(
        "fixtures/lab-regressions/12ea113b-8-base.json"
    ));
}

#[test]
#[ignore = "full production replay; currently reproduces the Adventure-offer defect"]
fn multiverse_adventure_offer_finishes() {
    check(include_str!(
        "fixtures/lab-regressions/8b516e4e-147-solo.json"
    ));
}

#[test]
#[ignore = "full production replay; currently reproduces the combat-tax defect"]
fn multiverse_combat_tax_finishes() {
    check(include_str!(
        "fixtures/lab-regressions/8b516e4e-143-solo.json"
    ));
}

#[test]
#[ignore = "full production replay on pinned card data"]
fn successful_world_shaper_control_is_unchanged() {
    check(include_str!(
        "fixtures/lab-regressions/24915300-25-base.json"
    ));
}
