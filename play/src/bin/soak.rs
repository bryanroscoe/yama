//! Soak test: 4-player Commander games with phase's AI on every seat, each recorded as a replay
//! log, then restored from a snapshot and replayed from the log to check both reproduce the game.
//! Started as the engine research spike (docs/engine-integration.md).
//!
//! Every AI answer that a person would send as an `act` message (cards to pick, trigger order,
//! modes, X, targets, may prompts, damage splits; see `yama_play::act`) goes through that path
//! instead: checked against the seat's `Pending` and applied to a copy, exactly as the server
//! does for a person. An answer the AI found legal but `act` refuses fails the soak.
//!
//! Games run with the engine's loop detection as live games have it (`yama_play::PLAY_LOOPS`);
//! YAMA_SOAK_LOOPS=off plays them without. Each game prints one line saying how it ended: a win,
//! a win by a loop (a loop nobody could break, or a shortcut everyone accepted), a draw, the turn
//! limit, a turn that never ends (stopped as live games stop the AI: `yama_play::STALL_ACTION_LIMIT`
//! actions in a row with nothing changing on the board, or `TURN_ACTION_LIMIT` in one turn), or a
//! failure.
//!
//! Usage: soak <card-data.json> [max_turns=8] [seed or first-last=7] [difficulty=Easy] [decks_dir]
//!             [deck files, comma-separated; seats take them in turn]
//! A deck file is "qty name" lines with the commander first, or Commander and Deck sections.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use engine::ai_support::{AiDecisionContract, legal_actions_for_viewer};
use engine::database::CardDatabase;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::filter_state_for_viewer;
use engine::game::replay::{ReplayPlayer, reconstruct_initial_state};
use engine::types::actions::GameAction;
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, LoopDetectionMode, PersistedGameState, PersistedRestoreFinalization, WaitingFor};
use engine::types::log::{LogImportance, LogSegment};
use engine::types::match_config::MatchConfig;
use engine::types::player::PlayerId;
use engine::types::replay::{ReplayHeader, ReplayLog};
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{AiConfig, AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use yama_play::act::{Act, Refusal, answer};

/// Actions in one game after which it stops.
const GAME_ACTIONS: usize = 100_000;

fn assert_send_sync<T: Send + Sync>() {}
fn assert_send<T: Send>() {}

/// A deck file: Commander and Deck sections (the lab's format), or "qty name" lines with the
/// commander first (Bryan's older full lists).
fn read_deck(path: &str) -> (String, Vec<String>) {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("deck file {path}: {e}"));
    let expand = |lines: &[(u32, String)]| lines.iter().flat_map(|(q, n)| std::iter::repeat_n(n.clone(), *q as usize)).collect::<Vec<_>>();
    if let Ok(file) = yama_play::lab::parse_deck(&text) {
        let mut commander = expand(&file.commander);
        return (commander.remove(0), expand(&file.main));
    }
    let mut names = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (qty, name) = line.split_once(' ').expect("qty name");
        for _ in 0..qty.parse::<usize>().unwrap() {
            names.push(name.trim().to_string());
        }
    }
    let commander = names.remove(0);
    (commander, names)
}

fn summary(s: &GameState) -> String {
    let lives: Vec<String> = s.players.iter().map(|p| format!("P{}:{}{}", p.id.0, p.life, if p.is_eliminated { "(out)" } else { "" })).collect();
    format!("turn={} active=P{} {}", s.turn_number, s.active_player.0, lives.join(" "))
}

fn log_text(segments: &[LogSegment]) -> String {
    segments
        .iter()
        .map(|s| match s {
            LogSegment::Text(t) => t.clone(),
            LogSegment::CardName { name, .. } => name.clone(),
            LogSegment::PlayerName { name, .. } => name.clone(),
            LogSegment::Number(n) => n.to_string(),
            LogSegment::Mana(m) => m.clone(),
            LogSegment::Zone(z) => format!("{z:?}"),
            LogSegment::Keyword(k) => k.clone(),
        })
        .collect()
}

fn main() {
    // Deep AI search overflows the default stack; phase uses 32 MiB too.
    let code = std::thread::Builder::new().stack_size(32 << 20).spawn(run).unwrap().join().unwrap();
    std::process::exit(code);
}

/// How one game went.
struct Played {
    end: String,
    turns: u32,
    actions: usize,
    secs: f64,
    /// Answers sent through `act`, by kind, and the ones it refused.
    acted: BTreeMap<&'static str, usize>,
    refused: Vec<String>,
    /// Loop decisions met: shortcuts offered and proposed, proposals answered, repeat decisions.
    loops: BTreeMap<&'static str, usize>,
    /// The replay log reproduced the game, and the snapshot restored.
    replay_ok: bool,
    snapshot_ok: bool,
    /// The AI's longest decision: seconds of CPU time, the turn, and what it was deciding.
    slowest: (f64, u32, String),
    /// CPU seconds spent by the AI choosing, and by the engine applying the choices.
    ai_secs: f64,
    engine_secs: f64,
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let card_data = args.get(1).map(String::as_str).unwrap_or("data/engine/card-data-19b30ee31fc29d11.json");
    let max_turns: u32 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(8);
    let seeds: Vec<u64> = match args.get(3).map(String::as_str) {
        Some(range) if range.contains('-') => {
            let (a, b) = range.split_once('-').unwrap();
            (a.parse().expect("first seed")..=b.parse().expect("last seed")).collect()
        }
        Some(one) => vec![one.parse().expect("seed")],
        None => vec![7],
    };
    let difficulty = args.get(4).map(|s| AiDifficulty::from_label(s)).unwrap_or(AiDifficulty::Easy);
    let loops = match std::env::var("YAMA_SOAK_LOOPS").as_deref() {
        Ok("off") => LoopDetectionMode::Off,
        _ => yama_play::PLAY_LOOPS,
    };

    // Compile-time thread-safety facts.
    assert_send_sync::<GameState>();
    assert_send_sync::<CardDatabase>();
    assert_send_sync::<AiSession>();
    assert_send::<AiConfig>();
    println!("compile-time: GameState, CardDatabase, AiSession are Send+Sync; AiConfig is Send");

    let t = Instant::now();
    let db = Arc::new(CardDatabase::from_export(Path::new(card_data)).expect("card db"));
    println!("card db: {} cards loaded in {:.1}s", db.card_count(), t.elapsed().as_secs_f64());

    // Map Bryan's decks: name -> face -> oracle_id -> face round trip.
    let decks_dir = args.get(5).map(String::as_str).unwrap_or("../commander-decks/decks");
    let mut lists = Vec::new();
    let files: Vec<String> = args
        .get(6)
        .map(|f| f.split(',').map(str::to_string).collect())
        .unwrap_or_else(|| vec!["Fantastic_Four_Upgraded_100.txt".into(), "Riders_of_Rohan_Upgraded_100.txt".into()]);
    for file in &files {
        let (commander, main) = read_deck(&format!("{decks_dir}/{file}"));
        let mut missing = Vec::new();
        let mut no_oracle = Vec::new();
        let mut oracle_mismatch = Vec::new();
        for name in std::iter::once(&commander).chain(main.iter()) {
            match db.get_face_by_name(name) {
                None => missing.push(name.clone()),
                Some(face) => match &face.scryfall_oracle_id {
                    None => no_oracle.push(name.clone()),
                    Some(oid) => {
                        let back = db.get_face_by_oracle_id(oid).map(|f| f.name.clone());
                        if back.as_deref() != Some(face.name.as_str()) {
                            oracle_mismatch.push(format!("{name} -> {oid} -> {back:?}"));
                        }
                    }
                },
            }
        }
        println!("{file}: commander={commander} main={} unresolved={missing:?} no_oracle_id={no_oracle:?} oracle_roundtrip_mismatch={oracle_mismatch:?}", main.len());
        lists.push(PlayerDeckList { main_deck: main, commander: vec![commander], ..Default::default() });
    }
    // Four seats, taking the decks in turn: FF, Rohan, FF, Rohan by default.
    let seats: Vec<PlayerDeckList> = (0..4).map(|i| lists[i % lists.len()].clone()).collect();
    println!("loop detection {loops:?}, difficulty {difficulty:?}, {} seeds, up to {max_turns} turns", seeds.len());

    let mut ends: BTreeMap<String, usize> = BTreeMap::new();
    let mut failed = 0;
    let verbose = seeds.len() == 1;
    for seed in &seeds {
        let played = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| play(&db, &seats, *seed, difficulty, max_turns, loops, verbose)));
        let p = match played {
            Ok(p) => p,
            Err(payload) => {
                let why = payload.downcast_ref::<String>().cloned().or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                println!("seed {seed}: PANIC {why}");
                *ends.entry("panic".into()).or_default() += 1;
                failed += 1;
                continue;
            }
        };
        let ok = p.refused.is_empty() && p.replay_ok && p.snapshot_ok;
        println!(
            "seed {seed}: {} after {} turns, {} actions, {:.1}s (CPU: AI {:.1}s, engine {:.1}s; slowest AI decision {:.2}s, turn {}, {}); act {} answers ({} refused); loops {:?}; replay {}; snapshot {}",
            p.end,
            p.turns,
            p.actions,
            p.secs,
            p.ai_secs,
            p.engine_secs,
            p.slowest.0,
            p.slowest.1,
            p.slowest.2,
            p.acted.values().sum::<usize>(),
            p.refused.len(),
            p.loops,
            if p.replay_ok { "matches" } else { "DIFFERS" },
            if p.snapshot_ok { "ok" } else { "FAILED" },
        );
        for r in &p.refused {
            println!("  act refused: {r}");
        }
        *ends.entry(p.end.split(':').next().unwrap_or("").to_string()).or_default() += 1;
        if !ok {
            failed += 1;
        }
    }
    println!("ends: {ends:?}");
    println!("{failed} of {} games failed a check", seeds.len());
    i32::from(failed > 0)
}

fn play(db: &Arc<CardDatabase>, seats: &[PlayerDeckList], seed: u64, difficulty: AiDifficulty, max_turns: u32, loops: LoopDetectionMode, verbose: bool) -> Played {
    let deck_list = DeckList { player: seats[0].clone(), opponent: seats[1].clone(), ai_decks: seats[2..].to_vec(), ..Default::default() };
    let header = ReplayHeader {
        format_config: FormatConfig::commander(),
        match_config: MatchConfig { loop_detection: loops, ..MatchConfig::default() },
        player_count: seats.len() as u8,
        first_player: None,
        seed,
        deck_data: Some(deck_list),
    };
    let t = Instant::now();
    let mut state = reconstruct_initial_state(&header, Some(db)).expect("initial state");
    state.debug_mode = false;
    state.all_card_names = db.card_names().into();
    if verbose {
        println!("game created in {:.2}s: {}", t.elapsed().as_secs_f64(), summary(&state));
        for p in &state.players {
            let commanders: Vec<String> = state
                .command_zone
                .iter()
                .filter(|id| state.objects.get(id).map(|o| o.owner == p.id).unwrap_or(false))
                .map(|id| state.objects.get(id).unwrap().name.clone())
                .collect();
            println!("  P{} library={} hand={} command_zone_ids={commanders:?}", p.id.0, p.library.len(), p.hand.len());
        }
    }

    let players = seats.len() as u8;
    let ai_players: HashSet<PlayerId> = (0..players).map(PlayerId).collect();
    // The AI as live games configure it: without the wall-clock budget unless AI_CLOCK says so.
    let config = |_| {
        let c = create_config_for_players(difficulty, Platform::Native, players);
        if yama_play::AI_CLOCK { c } else { c.into_measurement(seed) }
    };
    let configs: HashMap<PlayerId, AiConfig> = (0..players).map(|i| (PlayerId(i), config(i))).collect();
    let session = AiSession::arc_from_game(&state);
    let mut rng = StdRng::seed_from_u64(seed);
    let mut log = ReplayLog::new(header.clone());

    let t = Instant::now();
    let mut actions = 0usize;
    let mut acted: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut refused: Vec<String> = Vec::new();
    let mut loop_seen: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut end = String::from("turn limit");
    let mut shown = 0usize;
    let (mut turn_seen, mut turn_start) = (state.turn_number, 0usize);
    let mut moved_on = (yama_play::progress_mark(&state), 0usize);
    let mut recent: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut slowest = (0.0, 0, String::new());
    let (mut ai_secs, mut engine_secs) = (0.0, 0.0);
    loop {
        if let WaitingFor::GameOver { winner } = &state.waiting_for {
            // A loop win leaves the loop's unbounded resources marked for the winner (CR 732.2a).
            let by_loop = winner.is_some_and(|w| state.unbounded_resources.get(&w).is_some_and(|axes| !axes.is_empty()));
            end = match winner {
                Some(w) if by_loop => format!("loop win: P{}", w.0),
                Some(w) => format!("win: P{}", w.0),
                None => "draw".into(),
            };
            break;
        }
        if state.turn_number > max_turns {
            break;
        }
        if state.turn_number != turn_seen {
            (turn_seen, turn_start) = (state.turn_number, actions);
        }
        let mark = yama_play::progress_mark(&state);
        if mark != moved_on.0 {
            moved_on = (mark, actions);
        }
        if actions - moved_on.1 >= yama_play::STALL_ACTION_LIMIT || actions - turn_start >= yama_play::TURN_ACTION_LIMIT {
            // The last few actions say what was repeating.
            let last: Vec<String> = recent.iter().cloned().collect();
            end = format!("turn that never ends: turn {} at {}; last actions: {}", state.turn_number, state.waiting_for.variant_name(), last.join(" | "));
            break;
        }
        if actions >= GAME_ACTIONS {
            end = "action cap".into();
            break;
        }
        match &state.waiting_for {
            WaitingFor::LoopShortcut { .. } => *loop_seen.entry("offered").or_default() += 1,
            WaitingFor::RespondToShortcut { .. } => *loop_seen.entry("answered").or_default() += 1,
            WaitingFor::PrecastCopyShortcutOffer { .. } | WaitingFor::RespondToPrecastCopyShortcut { .. } => *loop_seen.entry("precast").or_default() += 1,
            WaitingFor::RepeatDecision { .. } => *loop_seen.entry("repeat").or_default() += 1,
            _ => {}
        }
        let Some((owner, actor)) = eligible_ai_decision(&state, &ai_players) else {
            end = format!("no eligible actor: {}", state.waiting_for.variant_name());
            break;
        };
        // Server-side check a human submission would get: is the AI's choice in the seat's legal list?
        let contract = AiDecisionContract::issue(&state, owner);
        // The AI searches as in live games: a copy with loop detection off (`ai_search_state`).
        let searched = yama_play::ai_search_state(&state);
        let thinking = yama_play::Busy::start();
        let chosen = choose_action_with_session(searched.as_ref(), owner, &configs[&actor], &mut rng, &session);
        let thought = thinking.elapsed().as_secs_f64();
        ai_secs += thought;
        if thought > slowest.0 {
            slowest = (thought, state.turn_number, format!("P{} at {}", owner.0, state.waiting_for.variant_name()));
        }
        let Some(action) = chosen else {
            end = format!("AI returned no action for P{} at {}", actor.0, state.waiting_for.variant_name());
            break;
        };
        if matches!(action, GameAction::DeclareShortcut { .. }) {
            *loop_seen.entry("proposed").or_default() += 1;
        }
        let turn_before = state.turn_number;
        let top = state.stack.last().and_then(|e| state.objects.get(&e.source_id)).map(|o| o.name.clone()).unwrap_or_default();
        let mut said = format!("P{} {action:?}", actor.0);
        said.truncate(140);
        recent.push_back(format!("{said} [top: {top}]"));
        if recent.len() > 8 {
            recent.pop_front();
        }
        // The AI's answer as a person would send it, where `act` covers it.
        // While paying, a mana ability is a tap, and every tap and cast goes through `act` too.
        let paying = yama_play::pay::paying(&state.waiting_for, owner);
        let as_act = if paying { Act::from_payment_action(&action) } else { Act::from_action(&action) };
        let as_person = as_act.and_then(|a| {
            let vs = filter_state_for_viewer(&state, owner);
            let candidates: Vec<_> = contract.candidates.iter().map(|c| c.action.clone()).collect();
            let covered = match a {
                // Special actions are matched to the engine's own options (rare.rs).
                Act::CancelCast
                | Act::CastSpell { .. }
                | Act::Ninjutsu { .. }
                | Act::TurnFaceUp { .. }
                | Act::Foretell { .. }
                | Act::CompanionToHand
                | Act::UseSerumPowder { .. } => true,
                Act::TapMana { .. } | Act::UntapMana { .. } | Act::KeepMana => paying,
                _ => yama_play::Pending::of(&vs, owner, &candidates, &[]).is_some(),
            };
            covered.then_some(a)
        });
        let applying = yama_play::Busy::start();
        let result = if let Some(a) = as_person {
            match answer(&mut state, owner, &a) {
                Ok(done) => {
                    *acted.entry(a.kind()).or_default() += 1;
                    for a in done.actions {
                        log.push_action(done.actor, a);
                    }
                    Ok(done.result)
                }
                Err(why) => {
                    // `act` refused an answer the AI found legal: a gap in `Pending`. Record it and
                    // play the AI's answer directly so the game goes on.
                    let why = match why {
                        Refusal::NotYours => "not their decision".to_string(),
                        Refusal::DoesntFit(w) | Refusal::Engine(w) => w,
                    };
                    let pending = yama_play::Pending::of(&filter_state_for_viewer(&state, owner), owner, &contract.candidates.iter().map(|c| c.action.clone()).collect::<Vec<_>>(), &[]);
                    let about = pending.map(|p| format!("{} ({}, {} to {})", p.prompt, p.purpose, p.min, p.max)).unwrap_or_default();
                    refused.push(format!("P{} {a:?} at {} {about}: {why}", owner.0, state.waiting_for.variant_name()));
                    let r = apply_interaction(&mut state, actor, owner, action.clone());
                    if r.is_ok() {
                        log.push_action(actor, action.clone());
                    }
                    r
                }
            }
        } else if !loops.samples() && verified_ai_stack_pass_player(&state, &action).is_some() {
            // With loop detection on, passes are ordinary engine passes, as in live games
            // (`Match::plain_passes`).
            let r = apply_verified_ai_priority_pass(&mut state, actor, &contract, action.clone());
            if r.is_ok() {
                log.push_verified_ai_priority_pass(actor, owner);
            }
            r
        } else {
            let r = apply_interaction(&mut state, actor, owner, action.clone());
            if r.is_ok() {
                log.push_action(actor, action.clone());
            }
            r
        };
        engine_secs += applying.elapsed().as_secs_f64();
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                end = format!("apply failed for P{}: {e}", actor.0);
                break;
            }
        };
        actions += 1;
        if verbose {
            for entry in &result.log_entries {
                if entry.presentation.importance == LogImportance::Essential && shown < 60 {
                    println!("  [t{} {:?}] {}", entry.turn, entry.category, log_text(&entry.segments));
                    shown += 1;
                }
            }
            if state.turn_number != turn_before {
                println!("-- {}  (actions={actions}, {:.1}s)", summary(&state), t.elapsed().as_secs_f64());
            }
        }
    }
    let secs = t.elapsed().as_secs_f64();
    if verbose {
        println!("stopped: {end}");
        println!("played {actions} actions in {secs:.1}s ({:.1} ms/action)", secs * 1000.0 / actions.max(1) as f64);
        println!("final: {}", summary(&state));
        println!("act: {} answers sent as a person would ({acted:?}), {} refused", acted.values().sum::<usize>(), refused.len());
        println!("commander damage: {:?}", state.commander_damage);
        show_views(&state, players);
    }

    // Persistence: the snapshot restores, and the replay log reproduces the game.
    let log_json = serde_json::to_string(&log).unwrap();
    let snap_json = serde_json::to_string(&PersistedGameState::capture(state.clone())).unwrap();
    let restored: PersistedGameState = serde_json::from_str(&snap_json).expect("snapshot decodes");
    let restored = restored.prepare_for_restore(PersistedRestoreFinalization::DeferUntilRehydrated).map_err(|e| e.to_string()).and_then(|p| {
        p.finalize_after_rehydration(|s| {
            s.all_card_names = db.card_names().into();
            engine::game::rehydrate_game_from_card_db_with_finalization(s, db, engine::game::CardDbRehydrationFinalization::Defer);
            engine::game::install_card_db(s, Arc::clone(db));
            Ok(())
        })
        .map_err(|e| e.to_string())
    });
    let snapshot_ok = match &restored {
        Ok(r) => summary(r) == summary(&state),
        Err(e) => {
            println!("snapshot restore: FAILED {e}");
            false
        }
    };
    let log2: ReplayLog = serde_json::from_str(&log_json).unwrap();
    let mut player = ReplayPlayer::load(log2, Some(db)).expect("replay load");
    let n = player.len();
    let replay_ok = match player.seek(n) {
        Ok(replayed) => {
            let mut replayed = replayed.clone();
            // Replays are rebuilt in debug mode; the game never is.
            replayed.debug_mode = state.debug_mode;
            let same = replayed == state && summary(&replayed) == summary(&state);
            if verbose {
                println!("replay: {n} actions re-applied; state matches={same}; replay log {} KB", log_json.len() / 1024);
            }
            same
        }
        Err(e) => {
            println!("replay FAILED: {e}");
            false
        }
    };
    Played { end, turns: state.turn_number, actions, secs, acted, refused, loops: loop_seen, replay_ok, snapshot_ok, slowest, ai_secs, engine_secs }
}

/// What each seat's filtered view still names of others' hidden cards, and its size.
fn show_views(state: &GameState, players: u8) {
    for i in 0..players {
        let viewer = PlayerId(i);
        let view = filter_state_for_viewer(state, viewer);
        let mut hidden_named = 0;
        let mut opp_hand = 0;
        for p in view.players.iter().filter(|p| p.id != viewer) {
            for id in p.hand.iter() {
                opp_hand += 1;
                let full = state.objects.get(id).map(|o| o.name.clone());
                let seen = view.objects.get(id).map(|o| o.name.clone());
                if seen.is_some() && seen == full {
                    hidden_named += 1;
                }
            }
        }
        let lib_visible = view
            .players
            .iter()
            .filter(|p| p.id != viewer)
            .flat_map(|p| p.library.iter())
            .filter(|id| view.objects.get(id).map(|o| !o.name.is_empty()).unwrap_or(false))
            .count();
        let (legal, _, _) = legal_actions_for_viewer(state, viewer);
        let view_json = serde_json::to_vec(&view).map(|v| v.len()).unwrap_or(0);
        println!(
            "view P{i}: opp-hand cards={opp_hand}, opp-hand names still visible={hidden_named}, named opp-library objects={lib_visible}, legal actions now={}, view json={} KB",
            legal.len(),
            view_json / 1024
        );
    }
}
