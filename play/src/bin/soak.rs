//! Soak test: a 4-player Commander game with phase's AI on every seat, recorded as a replay log,
//! then restored from a snapshot and replayed from the log to check both reproduce the game.
//! Started as the engine research spike (docs/engine-integration.md).
//!
//! Every AI answer that a person would send as an `act` message (cards to pick, trigger order,
//! modes, X, targets, may prompts, damage splits; see `yama_play::act`) goes through that path
//! instead: checked against the seat's `Pending` and applied to a copy, exactly as the server
//! does for a person. An answer the AI found legal but `act` refuses fails the soak.
//!
//! Usage: soak <card-data.json> [max_turns=8] [seed=7] [difficulty=Easy] [decks_dir] [deck files, comma-separated]
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use engine::ai_support::{legal_actions_for_viewer, AiDecisionContract};
use engine::database::CardDatabase;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::filter_state_for_viewer;
use engine::game::replay::{reconstruct_initial_state, ReplayPlayer};
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, PersistedGameState, PersistedRestoreFinalization, WaitingFor};
use engine::types::log::{LogImportance, LogSegment};
use engine::types::match_config::MatchConfig;
use engine::types::player::PlayerId;
use engine::types::replay::{ReplayHeader, ReplayLog};
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{create_config_for_players, AiConfig, AiDifficulty, Platform};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::rngs::StdRng;
use rand::SeedableRng;
use yama_play::act::{answer, Act, Refusal};

fn assert_send_sync<T: Send + Sync>() {}
fn assert_send<T: Send>() {}

fn read_deck(path: &str) -> (String, Vec<String>) {
    let text = std::fs::read_to_string(path).expect("deck file");
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

fn main() {
    // Deep AI search overflows the default stack; phase uses 32 MiB too.
    std::thread::Builder::new().stack_size(32 << 20).spawn(run).unwrap().join().unwrap();
}

fn run() {
    let args: Vec<String> = std::env::args().collect();
    let card_data = args.get(1).map(String::as_str).unwrap_or("data/engine/card-data-eb309108eb0df708.json");
    let max_turns: u32 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(8);
    let seed: u64 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(7);
    let difficulty = args.get(4).map(|s| AiDifficulty::from_label(s)).unwrap_or(AiDifficulty::Easy);

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

    // Seats: FF, Rohan, FF, Rohan.
    let deck_list = DeckList {
        player: lists[0].clone(),
        opponent: lists[1].clone(),
        ai_decks: vec![lists[0].clone(), lists[1].clone()],
        ..Default::default()
    };
    let header = ReplayHeader {
        format_config: FormatConfig::commander(),
        match_config: MatchConfig::default(),
        player_count: 4,
        first_player: None,
        seed,
        deck_data: Some(deck_list),
    };
    let t = Instant::now();
    let mut state = reconstruct_initial_state(&header, Some(&db)).expect("initial state");
    state.all_card_names = db.card_names().into();
    println!("game created in {:.2}s: {}", t.elapsed().as_secs_f64(), summary(&state));
    for p in &state.players {
        println!("  P{} library={} hand={} command_zone_ids={:?}", p.id.0, p.library.len(), p.hand.len(),
            state.command_zone.iter().filter(|id| state.objects.get(id).map(|o| o.owner == p.id).unwrap_or(false)).map(|id| state.objects.get(id).unwrap().name.clone()).collect::<Vec<_>>());
    }

    let ai_players: HashSet<PlayerId> = (0..4).map(PlayerId).collect();
    let configs: HashMap<PlayerId, AiConfig> = (0..4)
        .map(|i| (PlayerId(i), create_config_for_players(difficulty, Platform::Native, 4)))
        .collect();
    let session = AiSession::arc_from_game(&state);
    let mut rng = StdRng::seed_from_u64(seed);
    let mut log = ReplayLog::new(header.clone());

    let t = Instant::now();
    let mut actions = 0usize;
    // Answers sent through `act`, by kind, and any it refused.
    let mut acted: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut act_refused: Vec<String> = Vec::new();
    let mut stop_reason = String::from("turn limit");
    let mut shown = 0usize;
    loop {
        if matches!(state.waiting_for, WaitingFor::GameOver { .. }) {
            stop_reason = format!("game over: {:?}", state.waiting_for);
            break;
        }
        if state.turn_number > max_turns {
            break;
        }
        if actions >= 20_000 {
            stop_reason = "action cap".into();
            break;
        }
        let Some((owner, actor)) = eligible_ai_decision(&state, &ai_players) else {
            stop_reason = format!("no eligible actor: {:?}", state.waiting_for);
            break;
        };
        // Server-side check a human submission would get: is the AI's choice in the seat's legal list?
        let contract = AiDecisionContract::issue(&state, owner);
        let Some(action) = choose_action_with_session(&state, owner, &configs[&actor], &mut rng, &session) else {
            stop_reason = format!("AI returned no action for P{}", actor.0);
            break;
        };
        let turn_before = state.turn_number;
        // The AI's answer as a person would send it, where `act` covers it.
        let as_person = Act::from_action(&action).and_then(|a| {
            let vs = filter_state_for_viewer(&state, owner);
            let candidates: Vec<_> = contract.candidates.iter().map(|c| c.action.clone()).collect();
            (matches!(a, Act::CancelCast) || yama_play::Pending::of(&vs, owner, &candidates, &[]).is_some()).then_some(a)
        });
        let result = if let Some(a) = as_person {
            match answer(&mut state, owner, &a) {
                Ok(done) => {
                    *acted.entry(a.kind()).or_default() += 1;
                    log.push_action(done.actor, done.action);
                    Ok(done.result)
                }
                Err(why) => {
                    // `act` refused an answer the AI found legal: a gap in `Pending`. Record it and
                    // play the AI's answer directly so the game goes on.
                    act_refused.push(format!("P{} {:?}: {}", owner.0, a, match why {
                        Refusal::NotYours => "not their decision".to_string(),
                        Refusal::DoesntFit(w) | Refusal::Engine(w) => w,
                    }));
                    let r = apply_interaction(&mut state, actor, owner, action.clone());
                    if r.is_ok() { log.push_action(actor, action.clone()); }
                    r
                }
            }
        } else if verified_ai_stack_pass_player(&state, &action).is_some() {
            let r = apply_verified_ai_priority_pass(&mut state, actor, &contract, action.clone());
            if r.is_ok() { log.push_verified_ai_priority_pass(actor, owner); }
            r
        } else {
            let r = apply_interaction(&mut state, actor, owner, action.clone());
            if r.is_ok() { log.push_action(actor, action.clone()); }
            r
        };
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                stop_reason = format!("apply failed for P{}: {e}", actor.0);
                break;
            }
        };
        actions += 1;
        for entry in &result.log_entries {
            if entry.presentation.importance == LogImportance::Essential && shown < 60 {
                let text: String = entry.segments.iter().map(|s| match s {
                    LogSegment::Text(t) => t.clone(),
                    LogSegment::CardName { name, .. } => name.clone(),
                    LogSegment::PlayerName { name, .. } => name.clone(),
                    LogSegment::Number(n) => n.to_string(),
                    LogSegment::Mana(m) => m.clone(),
                    LogSegment::Zone(z) => format!("{z:?}"),
                    LogSegment::Keyword(k) => k.clone(),
                }).collect();
                println!("  [t{} {:?}] {text}", entry.turn, entry.category);
                shown += 1;
            }
        }
        if state.turn_number != turn_before {
            println!("-- {}  (actions={actions}, {:.1}s)", summary(&state), t.elapsed().as_secs_f64());
        }
    }
    let elapsed = t.elapsed().as_secs_f64();
    println!("stopped: {stop_reason}");
    println!("played {actions} actions in {elapsed:.1}s ({:.1} ms/action)", elapsed * 1000.0 / actions.max(1) as f64);
    println!("final: {}", summary(&state));
    println!("act: {} answers sent as a person would ({acted:?}), {} refused", acted.values().sum::<usize>(), act_refused.len());
    for r in &act_refused {
        println!("  act refused: {r}");
    }
    println!("commander damage: {:?}", state.commander_damage);

    // Per-seat views and legal actions.
    for i in 0..4u8 {
        let viewer = PlayerId(i);
        let view = filter_state_for_viewer(&state, viewer);
        let mut hidden_named = 0;
        let mut opp_hand = 0;
        for p in &view.players {
            if p.id == viewer { continue; }
            for id in p.hand.iter() {
                opp_hand += 1;
                let full = state.objects.get(id).map(|o| o.name.clone());
                let seen = view.objects.get(id).map(|o| o.name.clone());
                if seen.is_some() && seen == full { hidden_named += 1; }
            }
        }
        let lib_visible = view.players.iter().filter(|p| p.id != viewer).flat_map(|p| p.library.iter()).filter(|id| view.objects.get(id).map(|o| !o.name.is_empty()).unwrap_or(false)).count();
        let (legal, _, _) = legal_actions_for_viewer(&state, viewer);
        let view_json = serde_json::to_vec(&view).map(|v| v.len()).unwrap_or(0);
        println!("view P{i}: opp-hand cards={opp_hand}, opp-hand names still visible={hidden_named}, named opp-library objects={lib_visible}, legal actions now={}, view json={} KB", legal.len(), view_json / 1024);
    }

    // Persistence sizes.
    let log_json = serde_json::to_string(&log).unwrap();
    println!("replay log: {} actions, {} KB json", log.actions.len(), log_json.len() / 1024);
    let snap_json = serde_json::to_string(&PersistedGameState::capture(state.clone())).unwrap();
    println!("snapshot (PersistedGameState::capture): {} KB json", snap_json.len() / 1024);
    let restored: PersistedGameState = serde_json::from_str(&snap_json).expect("snapshot decodes");
    let restored = restored
        .prepare_for_restore(PersistedRestoreFinalization::DeferUntilRehydrated)
        .map_err(|e| e.to_string())
        .and_then(|p| p.finalize_after_rehydration(|s| {
            s.all_card_names = db.card_names().into();
            engine::game::rehydrate_game_from_card_db_with_finalization(s, &db, engine::game::CardDbRehydrationFinalization::Defer);
            engine::game::install_card_db(s, Arc::clone(&db));
            Ok(())
        }).map_err(|e| e.to_string()));
    match &restored {
        Ok(r) => println!("snapshot restore: ok, {}", summary(r)),
        Err(e) => println!("snapshot restore: FAILED {e}"),
    }

    // Replay from header + action log and compare.
    let log2: ReplayLog = serde_json::from_str(&log_json).unwrap();
    let t = Instant::now();
    let mut player = ReplayPlayer::load(log2, Some(&db)).expect("replay load");
    let n = player.len();
    match player.seek(n) {
        Ok(replayed) => {
            let same = summary(replayed) == summary(&state);
            let zones = |s: &GameState| s.players.iter().map(|p| (p.library.len(), p.hand.len(), p.graveyard.len())).collect::<Vec<_>>();
            println!("replay: {n} actions re-applied in {:.1}s; summary match={same}; zones match={}; battlefield size {} vs {}",
                t.elapsed().as_secs_f64(), zones(replayed) == zones(&state), replayed.battlefield.len(), state.battlefield.len());
            println!("replay final: {}", summary(replayed));
        }
        Err(e) => println!("replay FAILED: {e}"),
    }
    if !act_refused.is_empty() {
        std::process::exit(1);
    }
}
