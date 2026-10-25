//! Determinism of games people play: full 4-player AI games on Bryan's decks, through `Match` as
//! the server drives it.
//!
//! - Each game is played twice from its seed, on different threads at once: every action (the
//!   replay log), every view of every seat and a spectator's after every action, and the final
//!   state must be identical.
//! - A game resumed from its saved replay log part way through (as after a server restart) must
//!   go on exactly as the uninterrupted game did: the same actions, views and final state.
//!
//! The decks are copies in tests/fixtures/decks: the soak's two full lists
//! (commander-decks decks/Fantastic_Four_Upgraded_100.txt and Riders_of_Rohan_Upgraded_100.txt),
//! four of Bryan's current plans (decks/compare/*-3-after-prints.txt, 2026-10-24) and the
//! Prismari Performance precon (data/sim/decks/precons), whose commander's endless trigger the
//! games must also handle the same way every time.
//!
//! These play whole games on phase's full card data (YAMA_ENGINE_CARD_DATA, else
//! data/engine/card-data-2905717cc9fe0f53.json at the repo root), so they're ignored by default.
//! Run them in release:
//!   YAMA_ENGINE_CARD_DATA=... cargo test --release -p yama-play --test determinism -- --ignored --nocapture

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

use yama_play::lab::{parse_deck, resolve_deck_file};
use yama_play::{Difficulty, Engine, LogLine, Match, SeatDeck, Setup};

/// Turns a game may last here before it's cut off (the same in every run, so still compared).
const MAX_TURNS: u32 = 60;

fn card_data() -> Option<PathBuf> {
    let path = std::env::var("YAMA_ENGINE_CARD_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/engine/card-data-2905717cc9fe0f53.json"));
    if path.exists() {
        Some(path)
    } else {
        eprintln!("skipped: no card data at {} (set YAMA_ENGINE_CARD_DATA)", path.display());
        None
    }
}

/// A fixture deck: Commander and Deck sections, or "qty name" lines with the commander first.
fn deck(engine: &Engine, file: &str) -> SeatDeck {
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decks").join(file)).expect("deck file");
    let text = if text.lines().any(|l| l.trim().eq_ignore_ascii_case("commander")) {
        text
    } else {
        let mut lines = text.lines();
        let commander = lines.next().unwrap_or_default();
        format!("Commander\n{commander}\nDeck\n{}", lines.collect::<Vec<_>>().join("\n"))
    };
    resolve_deck_file(engine, file, &parse_deck(&text).expect("deck parses")).expect("deck resolves")
}

/// One game to play: its seed, the four seats' decks and the AI's level.
struct Game {
    seed: u64,
    decks: [&'static str; 4],
    level: Difficulty,
}

const FF: &str = "Fantastic_Four_Upgraded_100.txt";
const ROHAN: &str = "Riders_of_Rohan_Upgraded_100.txt";
const RIDERS: &str = "riders-of-rohan-3-after-prints.txt";
const PRISMARI: &str = "prismari-artistry-3-after-prints.txt";
const LOREHOLD: &str = "lorehold-spirit-3-after-prints.txt";
const WORLD: &str = "world-shaper-3-after-prints.txt";
const ZAFFAI: &str = "prismari-performance.txt";

fn games() -> Vec<Game> {
    vec![
        Game { seed: 7, decks: [FF, ROHAN, FF, ROHAN], level: Difficulty::Easy },
        Game { seed: 11, decks: [RIDERS, PRISMARI, LOREHOLD, WORLD], level: Difficulty::Easy },
        Game { seed: 12, decks: [WORLD, RIDERS, PRISMARI, LOREHOLD], level: Difficulty::Medium },
        Game { seed: 13, decks: [ZAFFAI, FF, RIDERS, PRISMARI], level: Difficulty::Easy },
    ]
}

fn new_match(engine: &Engine, g: &Game) -> Match {
    let decks = g.decks.iter().map(|f| deck(engine, f)).collect();
    let ai: Vec<(u8, Difficulty)> = (0..4).map(|s| (s, g.level)).collect();
    let mut m = engine.new_match_with(g.seed, decks, &ai, Setup { first: None, loops: yama_play::PLAY_LOOPS }).expect("game starts");
    m.set_names(vec!["Ana".into(), "Ben".into(), "Cy".into(), "Di".into()]);
    m
}

fn hash(text: &str) -> u64 {
    // SipHash with fixed keys: the same text hashes the same in every run and process.
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What playing a game produced.
#[derive(Default)]
struct Record {
    /// After each action: the replay log's length and a hash of every seat's view and a
    /// spectator's, as the server would send them.
    steps: Vec<(usize, u64)>,
    replay: String,
    end: String,
    /// The game as saved at some points: (actions in the log, replay log, log lines).
    saved: Vec<(usize, String, Vec<LogLine>)>,
}

fn views(m: &Match) -> u64 {
    let all: Vec<String> = (0..4).map(Some).chain([None]).map(|seat| serde_json::to_string(&m.view(seat)).expect("view serializes")).collect();
    hash(&all.join("\n"))
}

/// Play on until the game ends, MAX_TURNS is passed, or the AI stops, recording as it goes, and
/// saving the game when the log reaches each of `save_at`.
fn play_out(m: &mut Match, rec: &mut Record, save_at: &[usize]) {
    loop {
        if m.is_over() {
            rec.end = format!("over, winner {:?}", m.winner());
            break;
        }
        if m.turn() > MAX_TURNS {
            rec.end = "turn limit".into();
            break;
        }
        match m.run_ai(1) {
            Ok(1) => {}
            Ok(_) if m.settle_ai_contest() => {}
            Ok(_) => {
                rec.end = "nobody can act".into();
                break;
            }
            Err(e) => {
                rec.end = format!("AI stopped: {e:#}");
                break;
            }
        }
        let logged = m.actions_logged();
        rec.steps.push((logged, views(m)));
        if save_at.contains(&logged) {
            rec.saved.push((logged, m.replay_json(), m.log_lines().to_vec()));
        }
    }
    rec.replay = m.replay_json();
}

/// The final state, in a form two runs can compare: the engine's own equality, and its JSON with
/// object keys sorted.
fn state_json(m: &Match) -> String {
    serde_json::to_value(m.engine_state()).expect("state serializes").to_string()
}

#[test]
#[ignore = "plays full games on phase's full card data; run in release with --ignored"]
fn full_ai_games_play_the_same_twice() {
    let Some(path) = card_data() else { return };
    let engine = Engine::load(&path).expect("card data");
    let games = games();
    // Every game twice, all at once on threads of their own (the AI recurses deeply).
    let results: Vec<(Record, Match)> = std::thread::scope(|s| {
        let handles: Vec<_> = games
            .iter()
            .flat_map(|g| [g, g])
            .map(|g| {
                let engine = &engine;
                std::thread::Builder::new()
                    .stack_size(32 << 20)
                    .spawn_scoped(s, move || {
                        let mut m = new_match(engine, g);
                        let mut rec = Record::default();
                        play_out(&mut m, &mut rec, &[]);
                        (rec, m)
                    })
                    .unwrap()
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("game thread")).collect()
    });
    for (g, pair) in games.iter().zip(results.chunks(2)) {
        let ((a, ma), (b, mb)) = (&pair[0], &pair[1]);
        eprintln!("seed {}: {} actions, {} turns, {}", g.seed, a.steps.len(), ma.turn(), a.end);
        assert_eq!(a.end, b.end, "seed {}: same ending", g.seed);
        assert!(a.replay == b.replay, "seed {}: the replay logs differ", g.seed);
        if let Some(i) = a.steps.iter().zip(&b.steps).position(|(x, y)| x != y) {
            panic!("seed {}: the views first differ after action {}", g.seed, a.steps[i].0);
        }
        assert_eq!(a.steps.len(), b.steps.len(), "seed {}", g.seed);
        assert!(ma.engine_state() == mb.engine_state(), "seed {}: the final states differ", g.seed);
        assert!(state_json(ma) == state_json(mb), "seed {}: the final states' JSON differs", g.seed);
    }
}

#[test]
#[ignore = "plays full games on phase's full card data; run in release with --ignored"]
fn a_resumed_game_goes_on_as_the_uninterrupted_one() {
    let Some(path) = card_data() else { return };
    let engine = Engine::load(&path).expect("card data");
    let g = Game { seed: 21, decks: [RIDERS, PRISMARI, LOREHOLD, WORLD], level: Difficulty::Easy };
    let save_at = [150, 600, 1_100];
    let mut whole = new_match(&engine, &g);
    let mut a = Record::default();
    play_out(&mut whole, &mut a, &save_at);
    eprintln!("seed {}: {} actions, {} turns, {}; saved at {:?}", g.seed, a.steps.len(), whole.turn(), a.end, a.saved.iter().map(|s| s.0).collect::<Vec<_>>());
    assert!(!a.saved.is_empty(), "the game was saved at least once");
    let ai: Vec<(u8, Difficulty)> = (0..4).map(|s| (s, g.level)).collect();
    for (at, replay, lines) in &a.saved {
        // As the server does after a restart: replay the log, then put back the saved log lines.
        let mut m = engine.resume(replay, &ai).expect("resumes");
        m.set_names(vec!["Ana".into(), "Ben".into(), "Cy".into(), "Di".into()]);
        m.set_log_lines(lines.clone());
        let before = a.steps.iter().find(|(n, _)| n == at).expect("a step at the save").1;
        assert_eq!(views(&m), before, "resumed at {at}: the views right after resuming");
        let mut b = Record::default();
        play_out(&mut m, &mut b, &[]);
        let rest: Vec<_> = a.steps.iter().filter(|(n, _)| n > at).cloned().collect();
        if let Some(i) = rest.iter().zip(&b.steps).position(|(x, y)| x != y) {
            panic!("resumed at {at}: the game first differs after action {}", rest[i].0);
        }
        assert_eq!(rest.len(), b.steps.len(), "resumed at {at}: as many actions");
        assert_eq!(a.end, b.end, "resumed at {at}");
        assert!(a.replay == b.replay, "resumed at {at}: the replay logs differ");
        assert!(whole.engine_state() == m.engine_state(), "resumed at {at}: the final states differ");
        assert!(state_json(&whole) == state_json(&m), "resumed at {at}: the final states' JSON differs");
    }
}
