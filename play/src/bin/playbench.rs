//! How fast games people play run, on Bryan's decks (docs/play-performance.md). Plays 4-player
//! games with phase's AI on every seat through `Match`, as the server does, and times:
//!
//! - each AI decision (the AI choosing, from `Match::ai_thinking`), by difficulty;
//! - the engine applying it with Yama's bookkeeping (the rest of `Match::run_ai`);
//! - building each seat's view after every action (`Match::view`: the board, the event feed, the
//!   decision with its `pending`), and a spectator's, with its JSON;
//! - each game turn (AI and engine time from one turn's start to the next);
//! - the same games with the engine's loop detection off and on (`Setup::loops`), and with the
//!   AI's wall-clock budget on and off (`AI_CLOCK`).
//!
//! Times are the game thread's CPU time (`yama_play::Busy`), so other work on the machine doesn't
//! count; a game's own length ("secs" in each game's line) is wall-clock time.
//!
//! The server's own part of a person's move (from the `act` message to every seat's view sent) is
//! measured by the server's `play_bench` test, which uses the same games.
//!
//! Usage: playbench <card-data.json> [--games N] [--difficulties Easy,Medium,Hard,VeryHard]
//!          [--max-turns T] [--decks DIR] [--loops off|on|both] [--clock off|on|both]
//!          [--no-views] [--profile] [--json FILE]
//! --profile also times the parts of a seat's view: the engine's filtered copy of the game for
//! that seat, its derived presentation, and the seat's decision.
//! Build it in release: `cargo build --release -p yama-play --bin playbench`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use yama_play::lab::{parse_deck, resolve_deck_file};
use yama_play::{Busy, Difficulty, Engine, LoopDetectionMode, SeatDeck, Setup};

/// Bryan's lists the games use (copies in play/tests/fixtures/decks, from commander-decks
/// decks/compare/*-3-after-prints.txt on 2026-10-24), one per seat.
const DECKS: [&str; 4] = ["riders-of-rohan-3-after-prints", "prismari-artistry-3-after-prints", "lorehold-spirit-3-after-prints", "world-shaper-3-after-prints"];

struct Args {
    card_data: PathBuf,
    games: u64,
    difficulties: Vec<Difficulty>,
    max_turns: u32,
    decks: PathBuf,
    loops: Vec<LoopDetectionMode>,
    clock: Vec<bool>,
    views: bool,
    profile: bool,
    json: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let argv: Vec<String> = std::env::args().collect();
    let mut a = Args {
        card_data: PathBuf::from(argv.get(1).ok_or("usage: playbench <card-data.json> [options]")?),
        games: 2,
        difficulties: vec![Difficulty::Easy, Difficulty::Medium, Difficulty::Hard, Difficulty::VeryHard],
        max_turns: 40,
        decks: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decks"),
        loops: vec![LoopDetectionMode::Off, LoopDetectionMode::Interactive],
        clock: vec![false],
        views: true,
        profile: false,
        json: None,
    };
    let mut it = argv.iter().skip(2);
    while let Some(flag) = it.next() {
        let mut v = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        let both = |s: &str| -> Result<Vec<bool>, String> {
            match s {
                "off" => Ok(vec![false]),
                "on" => Ok(vec![true]),
                "both" => Ok(vec![false, true]),
                other => Err(format!("{other:?}: use off, on or both")),
            }
        };
        match flag.as_str() {
            "--games" => a.games = v()?.parse().map_err(|e| format!("--games: {e}"))?,
            "--difficulties" => a.difficulties = v()?.split(',').map(Difficulty::from_label).collect(),
            "--max-turns" => a.max_turns = v()?.parse().map_err(|e| format!("--max-turns: {e}"))?,
            "--decks" => a.decks = PathBuf::from(v()?),
            "--loops" => a.loops = both(&v()?)?.into_iter().map(|on| if on { yama_play::PLAY_LOOPS } else { LoopDetectionMode::Off }).collect(),
            "--clock" => a.clock = both(&v()?)?,
            "--no-views" => a.views = false,
            "--profile" => a.profile = true,
            "--json" => a.json = Some(PathBuf::from(v()?)),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

/// Durations in milliseconds, summarized.
#[derive(Default, Clone)]
struct Sample(Vec<f64>);

impl Sample {
    fn add(&mut self, d: Duration) {
        self.0.push(d.as_secs_f64() * 1000.0);
    }
    fn stats(&self) -> serde_json::Value {
        let mut v = self.0.clone();
        if v.is_empty() {
            return serde_json::json!({ "n": 0 });
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |q: f64| v[((v.len() as f64 - 1.0) * q).round() as usize];
        let total: f64 = v.iter().sum();
        serde_json::json!({ "n": v.len(), "p50": round(at(0.5)), "p95": round(at(0.95)), "max": round(*v.last().unwrap()), "mean": round(total / v.len() as f64), "total_s": round(total / 1000.0) })
    }
    fn line(&self) -> String {
        let s = self.stats();
        if s["n"] == 0 {
            return "n=0".into();
        }
        format!("p50 {:>8.3}  p95 {:>8.3}  max {:>9.3}  (n={}, total {:.1}s)", s["p50"].as_f64().unwrap(), s["p95"].as_f64().unwrap(), s["max"].as_f64().unwrap(), s["n"], s["total_s"].as_f64().unwrap())
    }
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// One configuration's measurements, pooled over its games.
#[derive(Default)]
struct Run {
    think: Sample,
    engine: Sample,
    step: Sample,
    turn: Sample,
    view_seat: Sample,
    view_spectator: Sample,
    view_json: Sample,
    view_kb: Vec<f64>,
    filter: Sample,
    derive: Sample,
    decision: Sample,
    games: Vec<serde_json::Value>,
}

fn main() {
    let code = std::thread::Builder::new().stack_size(32 << 20).spawn(run).unwrap().join().unwrap();
    std::process::exit(code);
}

fn run() -> i32 {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let t = Instant::now();
    let engine = Engine::load(&args.card_data).expect("card data");
    eprintln!("card data: {} cards in {:.1}s", engine.card_count(), t.elapsed().as_secs_f64());
    let decks: Vec<SeatDeck> = DECKS
        .iter()
        .map(|id| {
            let text = std::fs::read_to_string(args.decks.join(format!("{id}.txt"))).expect("deck file");
            resolve_deck_file(&engine, id, &parse_deck(&text).expect("deck")).expect("deck resolves")
        })
        .collect();

    let mut report = serde_json::Map::new();
    for difficulty in &args.difficulties {
        for clock in &args.clock {
            for loops in &args.loops {
                let key = format!("{difficulty:?} clock={} loops={loops:?}", if *clock { "on" } else { "off" });
                let mut run = Run::default();
                for game in 0..args.games {
                    let seed = 1_000 + game;
                    play(&engine, &decks, seed, *difficulty, *clock, *loops, args.max_turns, args.views, args.profile, &mut run);
                    eprintln!("{key}: game {seed}: {}", run.games.last().unwrap());
                }
                println!("== {key}");
                println!("  AI decision ms        {}", run.think.line());
                println!("  engine per action ms  {}", run.engine.line());
                println!("  turn (AI+engine) ms   {}", run.turn.line());
                if args.views {
                    println!("  view per seat ms      {}", run.view_seat.line());
                    println!("  spectator view ms     {}", run.view_spectator.line());
                    println!("  view JSON ms          {}", run.view_json.line());
                    if args.profile {
                        println!("    filtered copy ms    {}", run.filter.line());
                        println!("    derived views ms    {}", run.derive.line());
                        println!("    decision ms         {}", run.decision.line());
                    }
                    let kb = &run.view_kb;
                    if !kb.is_empty() {
                        println!("  view size KB          mean {:.1}  max {:.1}", kb.iter().sum::<f64>() / kb.len() as f64, kb.iter().cloned().fold(0.0, f64::max));
                    }
                }
                report.insert(
                    key,
                    serde_json::json!({
                        "ai_decision_ms": run.think.stats(), "engine_action_ms": run.engine.stats(), "step_ms": run.step.stats(),
                        "turn_ms": run.turn.stats(), "view_seat_ms": run.view_seat.stats(), "view_spectator_ms": run.view_spectator.stats(),
                        "view_json_ms": run.view_json.stats(), "filter_ms": run.filter.stats(), "derive_ms": run.derive.stats(),
                        "decision_ms": run.decision.stats(), "games": run.games,
                    }),
                );
            }
        }
    }
    if let Some(path) = &args.json {
        std::fs::write(path, serde_json::to_string_pretty(&serde_json::Value::Object(report)).unwrap()).expect("writing --json");
    }
    0
}

#[allow(clippy::too_many_arguments)]
fn play(engine: &Engine, decks: &[SeatDeck], seed: u64, difficulty: Difficulty, clock: bool, loops: LoopDetectionMode, max_turns: u32, views: bool, profile: bool, run: &mut Run) {
    let ai: Vec<(u8, Difficulty)> = (0..4).map(|s| (s, difficulty)).collect();
    let mut m = engine.new_match_with(seed, decks.to_vec(), &ai, Setup { first: None, loops }).expect("game");
    m.set_ai_clock(clock);
    m.set_ai_fallback(true);
    let started = Instant::now();
    let (mut turn, mut turn_time) = (m.turn(), Duration::ZERO);
    let mut actions = 0usize;
    let mut ended = "turn limit".to_string();
    while m.turn() <= max_turns {
        if m.is_over() {
            ended = match m.winner() {
                Some(w) => format!("win {w}"),
                None => "draw".into(),
            };
            break;
        }
        let t = Busy::start();
        let n = match m.run_ai(1) {
            Ok(n) => n,
            Err(e) => {
                ended = format!("error: {e:#}");
                break;
            }
        };
        let step = t.elapsed();
        if n == 0 {
            if m.settle_ai_contest() {
                continue;
            }
            ended = "stuck".into();
            break;
        }
        actions += 1;
        let think = m.ai_thinking();
        run.think.add(think);
        run.engine.add(step.saturating_sub(think));
        run.step.add(step);
        if m.turn() != turn {
            run.turn.add(turn_time);
            (turn, turn_time) = (m.turn(), Duration::ZERO);
        }
        turn_time += step;
        if views {
            for seat in 0..4u8 {
                let t = Busy::start();
                let v = m.view(Some(seat));
                run.view_seat.add(t.elapsed());
                let t = Busy::start();
                let json = serde_json::to_string(&v).unwrap();
                run.view_json.add(t.elapsed());
                run.view_kb.push(json.len() as f64 / 1024.0);
                if profile {
                    let state = m.engine_state();
                    let me = engine::types::player::PlayerId(seat);
                    let t = Busy::start();
                    let filtered = engine::game::filter_state_for_viewer(state, me);
                    run.filter.add(t.elapsed());
                    let t = Busy::start();
                    let _ = engine::game::derived_views::derive_filtered_views(state, &filtered, Some(me));
                    run.derive.add(t.elapsed());
                    let t = Busy::start();
                    let _ = m.decision(seat);
                    run.decision.add(t.elapsed());
                }
            }
            let t = Busy::start();
            let _ = m.view(None);
            run.view_spectator.add(t.elapsed());
        }
        if actions > 20_000 {
            ended = "action cap".into();
            break;
        }
    }
    let mut summary = BTreeMap::new();
    summary.insert("seed", serde_json::json!(seed));
    summary.insert("end", serde_json::json!(ended));
    summary.insert("turns", serde_json::json!(m.turn()));
    summary.insert("actions", serde_json::json!(actions));
    summary.insert("secs", serde_json::json!(round(started.elapsed().as_secs_f64())));
    run.games.push(serde_json::json!(summary));
}
