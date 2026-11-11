//! How long the server takes over a person's move in an online game, from the `act` message
//! received to every seat's view sent (docs/play-performance.md). Plays 4-player games on Bryan's
//! decks with phase's full card data and a file database, with phase's AI making the people's
//! moves (untimed), and times what the server does for each one, with the same code the game
//! thread and the sockets run:
//!
//! - the move itself (`Match::choose`, `declare_*` or `act`) and passing for people with nothing
//!   to do (`auto_pass`);
//! - building every view (`snapshot`: a spectator's and each person's);
//! - each connection's message: card details, the dressed decision and the JSON (`view_message`);
//! - saving the game (`persist`), which the game thread does after sending the views.
//!
//! The move, the passes and the views are timed in the game thread's CPU time (`yama_play::Busy`),
//! so other work on the machine doesn't inflate them; the whole round trip, the messages (card
//! details come from SQLite) and saving are wall-clock time.
//!
//! The AI's own thinking is left out (playbench measures it), except in "move to the next
//! decision", the wait a person has while the computer plays. Runs: one person with loop detection
//! on (as online games now are), the same with the board shown after every hand-over between the
//! computer and a pass made for a person (as before `ai_batch`), loop detection off, and four
//! people. Each move's messages are also built the way they were before `ViewMessage`, to compare.
//! Ignored by default; run in release with the card data:
//!   YAMA_ENGINE_CARD_DATA=... cargo test --release -p yama-server play::bench -- --ignored --nocapture

use super::*;
use std::time::{Duration, Instant};
use yama_play::lab::{parse_deck, resolve_deck_file};

const DECKS: [&str; 4] = ["riders-of-rohan-3-after-prints", "prismari-artistry-3-after-prints", "lorehold-spirit-3-after-prints", "world-shaper-3-after-prints"];
const MAX_TURNS: u32 = 25;

#[derive(Default)]
struct Sample(Vec<f64>);

impl Sample {
    fn add(&mut self, d: Duration) {
        self.0.push(d.as_secs_f64() * 1000.0);
    }
    fn line(&self) -> String {
        let mut v = self.0.clone();
        if v.is_empty() {
            return "n=0".into();
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |q: f64| v[((v.len() as f64 - 1.0) * q).round() as usize];
        format!("p50 {:>8.3}  p95 {:>8.3}  max {:>9.3}  (n={})", at(0.5), at(0.95), v[v.len() - 1], v.len())
    }
}

#[derive(Default)]
struct Timings {
    round_trip: Sample,
    /// The same, in the game thread's CPU time: the part the machine's other work doesn't inflate
    /// (card details come from SQLite on another thread, so they count only in wall-clock time).
    round_trip_cpu: Sample,
    apply: Sample,
    auto_pass: Sample,
    views: Sample,
    message: Sample,
    /// The same message built as it was before 2026-10-24 (a JSON value first, the whole view
    /// copied), for comparison; not part of the move's time.
    message_before: Sample,
    /// Inside the move and the passes made after it: telling every viewer what happened, and
    /// re-issuing people's decisions (`Match::take_costs`, CPU time).
    feed: Sample,
    remark: Sample,
    persist: Sample,
    /// The server's own work around each batch of AI moves: views and saving.
    ai_batch_overhead: Sample,
    /// From the views of a person's move sent to that person's next decision: the computer's
    /// turns and moves in between with the AI's thinking, the views and the saves (wall clock).
    until_next: Sample,
    replay_kb: Vec<f64>,
}

fn seat(n: u8, human: bool) -> SeatCfg {
    SeatCfg {
        seat: n,
        kind: if human { "human" } else { "ai" }.into(),
        user_id: human.then(|| format!("user-{n}")),
        name: format!("Seat {}", n + 1),
        deck_id: None,
        deck_version_id: None,
        deck_name: None,
        color_identity: String::new(),
        commander: None,
        difficulty: (!human).then(|| "Medium".into()),
        bracket: None,
    }
}

/// Card rows for every name the engine knows in these decks, as Scryfall's import would leave
/// them (text from the engine's card data, made-up image links), so card lookups do real work.
async fn seed_cards(pool: &SqlitePool, decks: &[SeatDeck]) {
    let mut names: Vec<&String> = decks.iter().flat_map(|d| d.commander.iter().chain(&d.main)).collect();
    names.sort();
    names.dedup();
    for (i, name) in names.iter().enumerate() {
        let oracle_id = format!("bench-{i}");
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, type_line, oracle_text, image_normal, image_art_crop, artist, updated_at) VALUES (?, ?, 'Card', ?, ?, ?, 'Artist', '2026-10-24')",
        )
        .bind(&oracle_id)
        .bind(name.as_str())
        .bind(format!("Rules text of {name}, long enough to look like real rules text on a card."))
        .bind(format!("https://cards.scryfall.io/normal/front/{i}.jpg"))
        .bind(format!("https://cards.scryfall.io/art_crop/front/{i}.jpg"))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name.as_str()).bind(&oracle_id).execute(pool).await.unwrap();
    }
}

/// How the AI's turns are shown: in batches (`ai_batch`, since 2026-10-24), or after every
/// hand-over between the computer and a pass made for a person, as `ai_turns` did before.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Cadence {
    Batched,
    EveryHandOver,
}

#[allow(clippy::too_many_arguments)]
async fn play(engine: &Engine, pool: &SqlitePool, decks: &[SeatDeck], seed: u64, people: u8, loops: yama_play::LoopDetectionMode, cadence: Cadence, t: &mut Timings) -> String {
    let seats: Vec<SeatCfg> = (0..4).map(|n| seat(n, n < people)).collect();
    let humans: Vec<u8> = (0..people).collect();
    let ai: Vec<(u8, Difficulty)> = (people..4).map(|s| (s, Difficulty::Medium)).collect();
    let mut m = engine.new_match_with(seed, decks.to_vec(), &ai, Setup { first: None, loops }).unwrap();
    m.set_names(seats.iter().map(|s| s.name.clone()).collect());
    let game_id = format!("bench-{seed}-{people}-{loops:?}-{cadence:?}");
    sqlx::query("INSERT INTO games (id, mode, created_by, format, status, starting_life, started_at) VALUES (?, 'online', 'bench', 'commander', 'in_progress', 40, ?)")
        .bind(&game_id)
        .bind(now())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES (?, ?, 'bench', 'live', '[]', ?, ?)")
        .bind(&game_id)
        .bind(&game_id)
        .bind(now())
        .bind(now())
        .execute(pool)
        .await
        .unwrap();
    let infos = serde_json::to_value(seat_infos(&seats, &HashMap::new(), &HashMap::new())).unwrap();
    // One connection per person, each with its own card cache, as the sockets have.
    let mut caches: Vec<HashMap<String, Option<CardMeta>>> = (0..people).map(|_| HashMap::new()).collect();
    let mut caches_before = caches.clone();
    let mut moves = 0;
    while !m.is_over() && m.turn() <= MAX_TURNS {
        // The AI seats' turns, as `ai_turns` runs them: the AI's thinking isn't timed, the views
        // and the save after each batch are.
        let waiting = Instant::now();
        loop {
            let batch = match cadence {
                Cadence::Batched => ai_batch(&mut m, &humans),
                Cadence::EveryHandOver => {
                    let passed = m.auto_pass(&humans);
                    match m.run_ai(AI_BATCH) {
                        Ok(n) if passed + n == 0 => Batch { moved: 0, settled: true, fault: None },
                        Ok(n) => Batch { moved: passed + n + m.auto_pass(&humans), settled: m.is_over(), fault: None },
                        Err(fault) => Batch { moved: passed, settled: true, fault: Some(fault) },
                    }
                }
            };
            if batch.moved > 0 {
                let s = Instant::now();
                m.take_board_tail();
                let snap = snapshot(&m, &seats);
                for (i, p) in humans.iter().enumerate() {
                    let _ = view_message(pool, &snap.views[&Some(*p)], Some(*p), &infos, &mut caches[i]).await;
                }
                persist(pool, &game_id, &m, false).await.unwrap();
                t.ai_batch_overhead.add(s.elapsed());
            }
            if let Some(e) = batch.fault {
                return format!("AI stopped: {e:#}");
            }
            if batch.settled {
                break;
            }
        }
        if moves > 0 {
            t.until_next.add(waiting.elapsed());
        }
        if m.is_over() {
            break;
        }
        let Some(&who) = m.waiting_on().iter().find(|s| humans.contains(s)) else { return "nobody can act".into() };
        // A person's move, chosen by the AI (standing in for the person, so not timed) and sent
        // as the board would send it. The server's work starts when the move arrives.
        let Some(mv) = m.ai_move_for(who, Difficulty::Medium) else { return "no move for a person".into() };
        m.take_costs();
        let start = Instant::now();
        let cpu = yama_play::Busy::start();
        if let Err(e) = m.send_move(who, &mv) {
            // The AI's answer doesn't fit what a person may send: pass or keep instead.
            let d = m.decision(who).unwrap();
            let i = d.options.iter().find(|o| matches!(o.kind, yama_play::OptionKind::Pass | yama_play::OptionKind::Keep)).or(d.options.first()).map(|o| o.index);
            if i.is_none_or(|i| m.choose(who, d.revision, i).is_err()) {
                return format!("move refused: {e}");
            }
        }
        t.apply.add(cpu.elapsed());
        let s = yama_play::Busy::start();
        m.auto_pass(&humans);
        t.auto_pass.add(s.elapsed());
        let costs = m.take_costs();
        t.feed.add(costs.feed);
        t.remark.add(costs.remark);
        let s = yama_play::Busy::start();
        m.take_board_tail();
        let snap = snapshot(&m, &seats);
        t.views.add(s.elapsed());
        for (i, p) in humans.iter().enumerate() {
            let s = Instant::now();
            let _ = view_message(pool, &snap.views[&Some(*p)], Some(*p), &infos, &mut caches[i]).await;
            t.message.add(s.elapsed());
        }
        t.round_trip.add(start.elapsed());
        t.round_trip_cpu.add(cpu.elapsed());
        for (i, p) in humans.iter().enumerate() {
            let s = Instant::now();
            let view = &snap.views[&Some(*p)];
            let cards = card_meta(pool, &view_names(view), &mut caches_before[i]).await;
            let mut copy = view.clone();
            dress_pending(&mut copy, &cards);
            let _ = serde_json::json!({ "type": "view", "you": Some(*p), "seats": infos, "cards": cards, "view": copy }).to_string();
            t.message_before.add(s.elapsed());
        }
        let s = Instant::now();
        persist(pool, &game_id, &m, false).await.unwrap();
        t.persist.add(s.elapsed());
        moves += 1;
    }
    t.replay_kb.push(m.replay_json().len() as f64 / 1024.0);
    format!("{} after {} turns, {moves} people's moves, {} actions", if m.is_over() { "over" } else { "turn limit" }, m.turn(), m.actions_logged())
}

#[test]
#[ignore = "plays full games on phase's full card data; run in release with --ignored"]
fn a_persons_move_round_trip() {
    // The game thread's big stack (the AI recurses deeply), with a runtime of its own for the
    // database, as the server's game threads use its runtime's handle.
    std::thread::Builder::new().stack_size(STACK).spawn(bench).unwrap().join().unwrap();
}

fn bench() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let path = std::env::var("YAMA_ENGINE_CARD_DATA").map(std::path::PathBuf::from).expect("YAMA_ENGINE_CARD_DATA");
    let engine = Engine::load(&path).unwrap();
    let dir = tempfile::tempdir().unwrap();
    // A file database with the server's own settings (WAL), not an in-memory one.
    let pool = rt.block_on(crate::db::connect(&format!("sqlite://{}", dir.path().join("bench.db").display()), std::time::Duration::from_millis(crate::perf::SLOW_QUERY_MS))).unwrap();
    rt.block_on(sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('bench', 'bench@example.com', 'bench', ?)").bind(now()).execute(&pool))
        .unwrap();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/decks");
    let decks: Vec<SeatDeck> = DECKS
        .iter()
        .map(|id| resolve_deck_file(&engine, id, &parse_deck(&std::fs::read_to_string(fixtures.join(format!("{id}.txt"))).unwrap()).unwrap()).unwrap())
        .collect();
    rt.block_on(seed_cards(&pool, &decks));
    let (on, off) = (yama_play::PLAY_LOOPS, yama_play::LoopDetectionMode::Off);
    let runs = [(1u8, on, Cadence::Batched), (1, on, Cadence::EveryHandOver), (1, off, Cadence::EveryHandOver), (4, on, Cadence::Batched)];
    for (people, loops, cadence) in runs {
        let mut t = Timings::default();
        for seed in [31u64, 32] {
            let ended = rt.block_on(play(&engine, &pool, &decks, seed, people, loops, cadence, &mut t));
            println!("{people} people, loops {loops:?}, {cadence:?}, seed {seed}: {ended}");
        }
        println!("== {people} people and {} AI seats, loops {loops:?}, AI turns shown {cadence:?} (ms)", 4 - people);
        println!("  move to every view sent   {}", t.round_trip.line());
        println!("    in CPU time             {}", t.round_trip_cpu.line());
        println!("    the move                {}", t.apply.line());
        println!("    passing for people      {}", t.auto_pass.line());
        println!("    (of these two: the feed  {})", t.feed.line());
        println!("    (and decisions re-issued {})", t.remark.line());
        println!("    every view              {}", t.views.line());
        println!("    one connection's message {}", t.message.line());
        println!("      as built before        {}", t.message_before.line());
        println!("  saving after it           {}", t.persist.line());
        println!("  views and save per AI batch {}  (total {:.1}s)", t.ai_batch_overhead.line(), t.ai_batch_overhead.0.iter().sum::<f64>() / 1000.0);
        println!("  move to the next decision  {}", t.until_next.line());
        println!("  replay log at the end KB  {:?}", t.replay_kb);
    }
}
