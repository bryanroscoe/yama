//! LLM seats in lab games, with a fake transport (no model is called).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use yama_play::lab::{self, End, GameOptions, GameSpec, Live, LlmSetup};
use yama_play::pilot::{LlmFailure, LlmRequest, LlmText, LlmTransport};
use yama_play::{Difficulty, Engine, SeatDeck};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/support-cards.json")).unwrap()
}

fn deck() -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Forest".into(); 99] }
}

fn spec(pilots: &[&str]) -> GameSpec {
    GameSpec {
        game: "llm-test".into(),
        seed: 3,
        decks: pilots.iter().enumerate().map(|(i, _)| format!("d{i}")).collect(),
        difficulty: "Easy".into(),
        max_turns: 6,
        max_actions: 5_000,
        max_seconds: 60,
        pilots: Some(pilots.iter().map(|p| p.to_string()).collect()),
    }
}

/// Answers every request with the same text, and counts requests.
struct Fixed {
    reply: Result<String, LlmFailure>,
    calls: AtomicUsize,
    saw_options: Mutex<bool>,
    saw_key: Mutex<bool>,
}

impl LlmTransport for Fixed {
    fn complete(&self, req: &LlmRequest) -> Result<LlmText, LlmFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if req.user.contains("[0]") && req.user.contains("[1]") {
            *self.saw_options.lock().unwrap() = true;
        }
        if let (Some(k), Some(d)) = (req.user.find("OBJECT KEY"), req.user.find("--- DECISION ---")) {
            assert!(k < d, "the key sits in the data, before the decision");
            assert!(req.user.contains("Object ") && req.user.contains(" = "));
            *self.saw_key.lock().unwrap() = true;
        }
        self.reply.clone().map(|text| LlmText { text, input_tokens: 10, output_tokens: 2, ..Default::default() })
    }
}

fn play(spec: &GameSpec, reply: Result<String, LlmFailure>, max_calls: usize) -> (lab::GameReport, Arc<Fixed>) {
    let e = engine();
    let t = Arc::new(Fixed { reply, calls: AtomicUsize::new(0), saw_options: Mutex::new(false), saw_key: Mutex::new(false) });
    let opts = GameOptions {
        llm: Some(Arc::new(LlmSetup { transport: t.clone(), max_calls_per_seat: max_calls, max_failure_streak: 5, log: None, object_key: true })),
        ..GameOptions::default()
    };
    let decks = vec![deck(); spec.decks.len()];
    let live = Mutex::new(Live::new());
    let report = lab::play_game_isolated(&e, spec, Difficulty::Easy, decks, "fixture", &opts, &live);
    (report, t)
}

#[test]
fn an_llm_seat_chooses_from_the_engine_issued_options() {
    let s = spec(&["llm:fake-model", "easy"]);
    let (report, t) = play(&s, Ok(r#"{"choice": 0, "reason": "first option"}"#.into()), 1_000);
    let r = &report.result;
    assert!(!r.end.failed(), "{:?}", r.error);
    assert_eq!(r.pilots.as_deref(), Some(&["llm:fake-model".to_string(), "easy".to_string()][..]));
    let llm = r.llm.as_ref().expect("llm stats");
    assert_eq!(llm.len(), 1);
    let st = &llm[0];
    assert_eq!((st.seat, st.pilot.as_str()), (0, "llm:fake-model"));
    assert!(st.calls > 0, "{st:?}");
    assert_eq!(st.calls, t.calls.load(Ordering::SeqCst));
    assert_eq!(st.chosen, st.calls, "every reply named a legal option: {st:?}");
    assert_eq!(st.fallback_count(), 0, "{st:?}");
    assert_eq!(st.input_tokens, 10 * st.calls as u64);
    assert!(*t.saw_options.lock().unwrap(), "the prompt numbers the options");
    assert!(*t.saw_key.lock().unwrap(), "an option naming an object gets the object key");
    assert_eq!(st.prompt, "phase-llm+object-key");
}

#[test]
fn unreadable_replies_fall_back_without_stopping_the_game() {
    let s = spec(&["easy", "llm:fake-model"]);
    let (report, _) = play(&s, Ok("I would attack with everything!".into()), 1_000);
    let r = &report.result;
    assert!(!r.end.failed(), "{:?}", r.error);
    let st = &r.llm.as_ref().unwrap()[0];
    assert_eq!(st.seat, 1);
    assert_eq!(st.chosen, 0);
    assert_eq!(st.fallbacks.get("undecodable").copied(), Some(st.calls));
    assert!(report.notes.iter().any(|n| n.contains("fell back")), "{:?}", report.notes);
}

#[test]
fn an_out_of_range_choice_is_refused() {
    let s = spec(&["llm:fake-model", "easy"]);
    let (report, _) = play(&s, Ok(r#"{"choice": 999}"#.into()), 1_000);
    let st = &report.result.llm.as_ref().unwrap()[0];
    assert!(!report.result.end.failed());
    assert_eq!(st.fallbacks.get("out_of_range").copied(), Some(st.calls));
}

#[test]
fn the_call_cap_hands_the_rest_of_the_game_to_the_heuristic() {
    let s = spec(&["llm:fake-model", "easy"]);
    let (report, t) = play(&s, Ok(r#"{"choice": 0}"#.into()), 2);
    let st = &report.result.llm.as_ref().unwrap()[0];
    assert_eq!(t.calls.load(Ordering::SeqCst), 2);
    assert_eq!(st.calls, 2);
    assert!(st.fallbacks.get("cap").copied().unwrap_or(0) > 0, "{st:?}");
    assert!(!report.result.end.failed());
}

#[test]
fn a_dead_service_ends_the_game_as_an_error_not_a_heuristic_game() {
    let s = spec(&["llm:fake-model", "easy"]);
    let (report, t) = play(&s, Err(LlmFailure::Service("usage limit reached".into())), 1_000);
    let r = &report.result;
    assert_eq!(r.end, End::Error);
    assert_eq!(t.calls.load(Ordering::SeqCst), 5);
    assert!(r.error.as_deref().unwrap().contains("5 failures in a row"), "{:?}", r.error);
    assert!(r.placements.is_empty());
}

#[test]
fn a_game_with_an_llm_pilot_needs_a_transport() {
    let e = engine();
    let s = spec(&["llm:fake-model", "easy"]);
    let live = Mutex::new(Live::new());
    let report = lab::play_game_isolated(&e, &s, Difficulty::Easy, vec![deck(), deck()], "fixture", &GameOptions::default(), &live);
    assert_eq!(report.result.end, End::Error);
    assert!(report.result.error.unwrap().contains("no LLM transport"));
}

#[test]
fn heuristic_pilots_per_seat_play_without_a_transport() {
    let e = engine();
    let mut s = spec(&["veryeasy", "hard", "easy"]);
    s.max_turns = 4;
    let live = Mutex::new(Live::new());
    let report = lab::play_game_isolated(&e, &s, Difficulty::Easy, vec![deck(), deck(), deck()], "fixture", &GameOptions::default(), &live);
    assert!(!report.result.end.failed(), "{:?}", report.result.error);
    assert!(report.result.llm.is_none());
    assert_eq!(report.result.pilots.as_ref().unwrap().len(), 3);
}
