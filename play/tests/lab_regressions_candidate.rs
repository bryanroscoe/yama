//! Candidate v0.119/cbd552b4 seeded scenarios. Original fixtures remain immutable.
//! Frozen production failures and a successful control. These are gameplay acceptance tests:
//! reproducing an error is a failure, even when the runner exits successfully or repeats it.
//! Run with the pinned card data, one test at a time:
//!   YAMA_ENGINE_CARD_DATA=... cargo test --workspace candidate_v0119 -- --ignored --test-threads=1

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
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/engine/card-data-cbd552b41f962f5b.json"))
}

fn check(fixture: &str) {
    // Current and historical builds share a target directory. Refuse a cached
    // Git-less export stamp: gameplay success without exact runner provenance
    // is not an acceptance result for this checkout.
    let runner_revision = lab::RUNNER.split("-dirty-").next().unwrap();
    assert!(runner_revision.len() == 40 && runner_revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "candidate acceptance needs an exact Yama runner revision, got {}", lab::RUNNER);
    if let Ok(git) = std::process::Command::new("git").args(["rev-parse", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR")).output()
        && git.status.success()
    {
        assert_eq!(runner_revision, String::from_utf8_lossy(&git.stdout).trim(),
            "candidate runner belongs to a different source checkout");
    }
    let provenance: serde_json::Value = serde_json::from_str(include_str!("fixtures/lab-regressions/candidate-v0119.json")).unwrap();
    assert_eq!(provenance["phase"], include_str!("../../deploy/phase-rev").trim());
    assert_eq!(provenance["card_sha256"], yama_play::CARD_DATA_SHA256);
    let mut case: Case = serde_json::from_str(fixture).expect("frozen fixture parses");
    let path = card_data();
    assert!(path.is_file(), "missing card data at {}; set YAMA_ENGINE_CARD_DATA", path.display());
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(&path).expect("candidate card data is readable");
    assert_eq!(
        Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        yama_play::CARD_DATA_SHA256,
        "candidate requires verified data bytes"
    );
    assert_eq!(case.card_data, "1e5608e61683de41", "original input identity changed");
    case.card_data = "cbd552b41f962f5b".into();
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    let engine = ENGINE.get_or_init(|| Engine::load(&path).expect("card data loads"));
    assert_eq!(case.spec.decks, case.decks.iter().map(|d| d.id.clone()).collect::<Vec<_>>(), "seat order is frozen");
    let decks = case
        .decks
        .iter()
        .map(|d| {
            let lines: Vec<_> =
                d.cards.iter().map(|c| DeckLine { oracle_id: &c.oracle_id, name: &c.name, qty: c.qty, commander: c.commander }).collect();
            let (deck, report) = engine.resolve_deck(&lines);
            assert!(report.missing.is_empty(), "{}: unknown cards {:?}", d.id, report.missing);
            assert_eq!(deck.main.len() + deck.commander.len(), 100, "{}: complete deck", d.id);
            deck
        })
        .collect();
    let opts = GameOptions { turn_action_cap: case.turn_action_cap, ..Default::default() };
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
    assert!(matches!(result.end, End::Win | End::Draw), "{} did not finish normally: {}", case.spec.game, result.to_line());
    assert!(result.error.is_none(), "{} retained an error", case.spec.game);
    println!("CANDIDATE_RESULT {}", result.to_line());
    if let Some(historical) = case.expected_control {
        // Preserve the historical winner=3/turn=54/actions=2072. A new expectation is
        // established only after investigating this independently versioned candidate.
        let config: serde_json::Value = serde_json::from_str(include_str!("fixtures/lab-regressions/candidate-v0119.json")).unwrap();
        println!("CANDIDATE_PROVENANCE {config}");
        assert_eq!(
            config["historical_control"],
            serde_json::json!({
                "winner":historical.winner,"turns":historical.turns,"actions":historical.actions
            }),
            "historical baseline tuple remains frozen"
        );
        let expected: Control = serde_json::from_value(config["control"].clone())
            .expect("candidate control expectation not established; inspect result and divergence first");
        assert_eq!(
            (result.winner, result.turns, result.actions),
            (expected.winner, expected.turns, expected.actions),
            "successful control changed"
        );
    }
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0119_lorehold_priority_session_finishes() {
    check(include_str!("fixtures/lab-regressions/d566002e-18-variant.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0119_tricky_terrain_priority_session_finishes() {
    check(include_str!("fixtures/lab-regressions/12ea113b-8-base.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the Adventure-offer defect"]
fn candidate_v0119_multiverse_adventure_offer_finishes() {
    check(include_str!("fixtures/lab-regressions/8b516e4e-147-solo.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the combat-tax defect"]
fn candidate_v0119_multiverse_combat_tax_finishes() {
    check(include_str!("fixtures/lab-regressions/8b516e4e-143-solo.json"));
}

#[test]
#[ignore = "full seeded scenario on pinned card data"]
fn candidate_v0119_world_shaper_control() {
    check(include_str!("fixtures/lab-regressions/24915300-25-base.json"));
}
