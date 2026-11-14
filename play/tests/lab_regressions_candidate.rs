//! Candidate v0.119/cbd552b4 seeded scenarios. Original fixtures remain immutable.
//! Frozen production failures and a successful control. These are gameplay acceptance tests:
//! reproducing an error is a failure, even when the runner exits successfully or repeats it.
//! Run with the pinned card data, one test at a time:
//!   YAMA_V0119_ACCEPTANCE_TEST_BINARY=... YAMA_V0119_CARD_DATA=... cargo test --workspace candidate_v0119 -- --ignored --test-threads=1
//! Prepare the frozen executable first; see runtime/README.md. Known historical gameplay failures remain failures.

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

fn card_data(sha: &str) -> PathBuf {
    std::env::var_os("YAMA_ENGINE_CARD_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../data/engine/card-data-{}.json", &sha[..16])))
}

pub(crate) fn check_current(fixture: &str, configuration: &str) {
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
    let provenance: serde_json::Value = serde_json::from_str(configuration).unwrap();
    assert_eq!(provenance["phase"], include_str!("../../deploy/phase-rev").trim());
    assert_eq!(provenance["card_sha256"], yama_play::CARD_DATA_SHA256);
    let mut case: Case = serde_json::from_str(fixture).expect("frozen fixture parses");
    let hash = provenance["card_sha256"].as_str().expect("versioned card hash");
    let path = card_data(hash);
    assert!(path.is_file(), "missing card data at {}; set YAMA_ENGINE_CARD_DATA", path.display());
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(&path).expect("candidate card data is readable");
    assert_eq!(
        Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        yama_play::CARD_DATA_SHA256,
        "candidate requires verified data bytes"
    );
    assert_eq!(case.card_data, "1e5608e61683de41", "original input identity changed");
    case.card_data = hash[..16].into();
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
    // These scenarios were recorded without loop detection.
    let opts = GameOptions { turn_action_cap: case.turn_action_cap, loops: false, ..Default::default() };
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
        let config: serde_json::Value = serde_json::from_str(configuration).unwrap();
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

// The preserved suite runs on the bound v0.119 export, never on this checkout's
// newer engine. Build its integration executable as documented in runtime/README.md.
fn frozen_identity(result: &serde_json::Value, provenance: &serde_json::Value) {
    let phase = provenance["phase"].as_str().unwrap();
    let hash = provenance["card_sha256"].as_str().unwrap();
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../runtime/v0119/historical.json")).unwrap();
    assert_eq!(result["engine"], format!("phase-rs v0.119.0+yama-{phase}"));
    assert_eq!(result["card_data"], &hash[..16]);
    assert_eq!(result["runner"].as_str().unwrap().split("-dirty-").next().unwrap(), manifest["yama"].as_str().unwrap());
}

fn check_v0119(name: &str, fixture: &str) {
    assert!(std::env::var_os("YAMA_V0119_ACCEPTANCE_CHILD").is_none(),
        "YAMA_V0119_ACCEPTANCE_TEST_BINARY points at a current harness, not the frozen v0.119 integration executable");
    let provenance: serde_json::Value = serde_json::from_str(include_str!("fixtures/lab-regressions/candidate-v0119.json")).unwrap();
    let hash = provenance["card_sha256"].as_str().unwrap();
    let path = std::env::var_os("YAMA_V0119_CARD_DATA").map(PathBuf::from).unwrap_or_else(|| card_data(hash));
    use sha2::{Digest, Sha256};
    assert_eq!(Sha256::digest(std::fs::read(&path).expect("verified v0.119 data")).iter().map(|b| format!("{b:02x}")).collect::<String>(), hash);
    let binary = std::env::var_os("YAMA_V0119_ACCEPTANCE_TEST_BINARY")
        .expect("set YAMA_V0119_ACCEPTANCE_TEST_BINARY to the frozen export's integration executable (runtime/README.md)");
    let output = std::process::Command::new(binary)
        .args([format!("lab_regressions_candidate::{name}"), "--exact".into(), "--ignored".into(), "--nocapture".into(), "--test-threads=1".into()])
        .env("YAMA_ENGINE_CARD_DATA", path).env("YAMA_V0119_ACCEPTANCE_CHILD", "1")
        .output().expect("run frozen v0.119 acceptance executable");
    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{stdout}");
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "frozen v0.119 scenario failed; its gameplay failure is not waived");
    let line = stdout.lines().find_map(|l| l.split_once("CANDIDATE_RESULT ").map(|(_, value)| value)).expect("frozen test emitted a result");
    let result: serde_json::Value = serde_json::from_str(line).unwrap();
    frozen_identity(&result, &provenance);
    let case: Case = serde_json::from_str(fixture).unwrap();
    assert_eq!(result["game"], case.spec.game);
    assert_eq!(result["seed"], case.spec.seed);
    assert_eq!(result["decks"], serde_json::to_value(case.spec.decks).unwrap());
    assert!(matches!(result["end"].as_str(), Some("win" | "draw")) && result["error"].is_null());
    if case.expected_control.is_some() {
        assert_eq!(result["winner"], provenance["control"]["winner"]);
        assert_eq!(result["turns"], provenance["control"]["turns"]);
        assert_eq!(result["actions"], provenance["control"]["actions"]);
    }
}

#[test]
fn historical_acceptance_rejects_current_engine_or_data_identity() {
    let config: serde_json::Value = serde_json::from_str(include_str!("fixtures/lab-regressions/candidate-v0119.json")).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../runtime/v0119/historical.json")).unwrap();
    let good = serde_json::json!({"engine":format!("phase-rs v0.119.0+yama-{}",config["phase"].as_str().unwrap()),"card_data":"cbd552b41f962f5b","runner":manifest["yama"]});
    frozen_identity(&good, &config);
    for (field, value) in [
        ("engine", serde_json::json!(lab::ENGINE)),
        ("card_data", serde_json::json!(&yama_play::CARD_DATA_SHA256[..16])),
        ("runner", serde_json::json!(lab::RUNNER)),
    ] {
        let mut wrong = good.clone();
        wrong[field] = value;
        assert!(std::panic::catch_unwind(|| frozen_identity(&wrong, &config)).is_err(), "{field} must remain independently pinned");
    }
}

#[test]
fn historical_acceptance_refuses_recursive_current_harness_dispatch() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["lab_regressions_candidate::candidate_v0119_world_shaper_control", "--exact", "--ignored", "--nocapture"])
        .env("YAMA_V0119_ACCEPTANCE_CHILD", "1")
        .output().unwrap();
    assert!(!output.status.success());
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(text.contains("points at a current harness, not the frozen v0.119 integration executable"), "{text}");
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0119_lorehold_priority_session_finishes() {
    check_v0119("candidate_v0119_lorehold_priority_session_finishes", include_str!("fixtures/lab-regressions/d566002e-18-variant.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0119_tricky_terrain_priority_session_finishes() {
    check_v0119("candidate_v0119_tricky_terrain_priority_session_finishes", include_str!("fixtures/lab-regressions/12ea113b-8-base.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the Adventure-offer defect"]
fn candidate_v0119_multiverse_adventure_offer_finishes() {
    check_v0119("candidate_v0119_multiverse_adventure_offer_finishes", include_str!("fixtures/lab-regressions/8b516e4e-147-solo.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the combat-tax defect"]
fn candidate_v0119_multiverse_combat_tax_finishes() {
    check_v0119("candidate_v0119_multiverse_combat_tax_finishes", include_str!("fixtures/lab-regressions/8b516e4e-143-solo.json"));
}

#[test]
#[ignore = "full seeded scenario on pinned card data"]
fn candidate_v0119_world_shaper_control() {
    check_v0119("candidate_v0119_world_shaper_control", include_str!("fixtures/lab-regressions/24915300-25-base.json"));
}
