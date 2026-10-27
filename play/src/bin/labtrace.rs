//! Debugging aid for the simulation lab: replays one schedule line the way the batch runner
//! plays it (same setup, same AI configuration and seed derivation, same fallback rule, same
//! per-turn loop guard) and writes a readable trace to stdout:
//!   - every non-pass action, with the controller of each target object as "(sN)";
//!   - the engine's public headline log lines (all of them with --all-log);
//!   - the focus seat's board at the start of each of its turns, plus every permanent that
//!     carries an everything counter, with its types and mana abilities;
//!   - "SUMMARY {json}": the focus seat's casts, activations, attacks, everything counters
//!     placed (whose permanent), damage taken by source, and lands/hand/life per own turn;
//!   - "SEATS {json}": every seat's casts, lands per own turn, attacks and result, as a baseline.
//!
//! On the build that played the game, the outcome equals the game's line in the results file
//! (--expect prints that line for comparison). A build from other source can play differently.
//! There is no CPU-time cap or hang watchdog here: a game that hung in the batch runner hangs.
//! Written for docs/lab/sim-blind-spots-2026-10-19.md in commander-decks.
//!
//! Usage:
//!   labtrace --card-data <file> --decks-root <dir> --schedule <file.jsonl> --game <id>
//!            [--focus <deck id substring>] [--difficulty Easy|Medium|Hard] [--all-log]
//!            [--expect <results.jsonl>] [--loops]
//!
//! --difficulty overrides the schedule line's level (the replay is then a different game).
//! --loops plays with the engine's loop detection on, as `lab --loops` and live games do (a
//! different game too, once a loop is found).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use engine::database::CardDatabase;
use engine::game::combat::AttackTarget;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::replay::reconstruct_initial_state;
use engine::types::ability::TargetRef;
use engine::types::actions::GameAction;
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::log::{LogImportance, LogSegment, LogVisibility};
use engine::types::match_config::MatchConfig;
use engine::types::player::PlayerId;
use engine::types::replay::ReplayHeader;
use engine::types::zones::Zone;
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{AiConfig, AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::PreparedAiDecision;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use yama_play::Engine;
use yama_play::lab::{GameSpec, STACK, load_deck};

struct Args {
    card_data: PathBuf,
    decks_root: PathBuf,
    schedule: PathBuf,
    game: String,
    focus: Option<String>,
    difficulty: Option<String>,
    all_log: bool,
    expect: Option<PathBuf>,
    loops: bool,
}

fn parse_args() -> Result<Args, String> {
    let argv: Vec<String> = std::env::args().collect();
    let mut a = Args {
        card_data: PathBuf::new(),
        decks_root: PathBuf::new(),
        schedule: PathBuf::new(),
        game: String::new(),
        focus: None,
        difficulty: None,
        all_log: false,
        expect: None,
        loops: false,
    };
    let mut it = argv.iter().skip(1);
    while let Some(flag) = it.next() {
        let mut v = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--card-data" => a.card_data = PathBuf::from(v()?),
            "--decks-root" => a.decks_root = PathBuf::from(v()?),
            "--schedule" => a.schedule = PathBuf::from(v()?),
            "--game" => a.game = v()?,
            "--focus" => a.focus = Some(v()?),
            "--difficulty" => a.difficulty = Some(v()?),
            "--expect" => a.expect = Some(PathBuf::from(v()?)),
            "--all-log" => a.all_log = true,
            "--loops" => a.loops = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if a.game.is_empty() {
        return Err("--game is required".into());
    }
    Ok(a)
}

fn name(s: &GameState, id: &ObjectId) -> String {
    match s.objects.get(id) {
        Some(o) if !o.name.is_empty() => o.name.clone(),
        _ => format!("#{}", id.0),
    }
}

fn owned_name(s: &GameState, id: &ObjectId) -> String {
    match s.objects.get(id) {
        Some(o) => format!("{} (s{})", name(s, id), o.controller.0),
        None => name(s, id),
    }
}

fn label(s: &GameState, action: &GameAction) -> String {
    let tgt = |t: &TargetRef| match t {
        TargetRef::Object(id) => owned_name(s, id),
        TargetRef::Player(p) => format!("seat {}", p.0),
    };
    match action {
        GameAction::PlayLand { object_id, .. } => format!("PLAY LAND {}", name(s, object_id)),
        GameAction::CastSpell { object_id, targets, .. } => {
            let t: Vec<String> = targets.iter().map(|t| owned_name(s, t)).collect();
            if t.is_empty() { format!("CAST {}", name(s, object_id)) } else { format!("CAST {} -> {}", name(s, object_id), t.join(", ")) }
        }
        GameAction::ActivateAbility { source_id, .. } => format!("ACTIVATE {} ({action:?})", name(s, source_id)).chars().take(200).collect(),
        GameAction::DeclareAttackers { attacks, .. } if attacks.is_empty() => "no attack".into(),
        GameAction::DeclareAttackers { attacks, .. } => {
            let parts: Vec<String> = attacks
                .iter()
                .map(|(a, t)| {
                    let who = match t {
                        AttackTarget::Player(p) => format!("seat {}", p.0),
                        AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => name(s, id),
                    };
                    format!("{} -> {who}", name(s, a))
                })
                .collect();
            format!("ATTACK {}", parts.join("; "))
        }
        GameAction::DeclareBlockers { assignments } if assignments.is_empty() => "no block".into(),
        GameAction::DeclareBlockers { assignments } => {
            format!("BLOCK {}", assignments.iter().map(|(b, a)| format!("{} blocks {}", owned_name(s, b), owned_name(s, a))).collect::<Vec<_>>().join("; "))
        }
        GameAction::SelectTargets { targets } => format!("targets {}", targets.iter().map(tgt).collect::<Vec<_>>().join(", ")),
        GameAction::ChooseTarget { target: Some(t) } => format!("target {}", tgt(t)),
        GameAction::SelectCards { cards } => format!("select [{}]", cards.iter().map(|c| name(s, c)).collect::<Vec<_>>().join(", ")),
        _ => {
            let mut d = format!("{action:?}");
            d.truncate(160);
            d
        }
    }
}

fn segments_text(segments: &[LogSegment]) -> String {
    segments
        .iter()
        .map(|s| match s {
            LogSegment::Text(t) => t.clone(),
            LogSegment::CardName { name, .. } => name.clone(),
            LogSegment::PlayerName { name, .. } => name.clone(),
            LogSegment::Number(n) => n.to_string(),
            LogSegment::Mana(m) => m.clone(),
            LogSegment::Zone(z) => format!("{z:?}").to_lowercase(),
            LogSegment::Keyword(k) => k.clone(),
        })
        .collect()
}

fn describe_obj(s: &GameState, id: &ObjectId) -> String {
    let Some(o) = s.objects.get(id) else { return format!("#{}", id.0) };
    let mut out = o.name.clone();
    let types: Vec<String> = o.card_types.core_types.iter().map(|t| format!("{t:?}")).collect();
    let _ = write!(out, " [{}", types.join(" "));
    let n = o.card_types.subtypes.len();
    if n > 12 {
        let _ = write!(out, "; {n} subtypes incl. {}", o.card_types.subtypes.iter().take(6).cloned().collect::<Vec<_>>().join(","));
    } else if n > 0 {
        let _ = write!(out, "; {}", o.card_types.subtypes.join(","));
    }
    out.push(']');
    if let (Some(p), Some(t)) = (o.power, o.toughness) {
        let _ = write!(out, " {p}/{t}");
    }
    if o.tapped {
        out.push_str(" tapped");
    }
    if !o.counters.is_empty() {
        let c: BTreeMap<String, u32> = o.counters.iter().map(|(k, v)| (format!("{k:?}"), *v)).collect();
        let _ = write!(out, " counters {c:?}");
    }
    let mana = o.abilities.iter().filter(|a| engine::game::mana_abilities::is_mana_ability(a)).count();
    if o.card_types.core_types.iter().any(|t| format!("{t:?}") == "Land") {
        let _ = write!(out, " mana_abilities={mana}");
    }
    if !o.keywords.is_empty() {
        let k: Vec<String> = o.keywords.iter().take(6).map(|k| format!("{k:?}")).collect();
        let _ = write!(out, " kw {}", k.join(","));
    }
    out
}

fn board(s: &GameState, seat: u8) -> String {
    let mut out = String::new();
    let lives: Vec<String> = s.players.iter().map(|p| format!("s{}:{}{}", p.id.0, p.life, if p.is_eliminated { "(out)" } else { "" })).collect();
    let _ = writeln!(out, "  life {}", lives.join(" "));
    let p = &s.players[seat as usize];
    let _ = writeln!(out, "  hand ({}): {}", p.hand.len(), p.hand.iter().map(|c| name(s, c)).collect::<Vec<_>>().join(" | "));
    let _ = writeln!(out, "  library {} graveyard {}", p.library.len(), p.graveyard.len());
    let cz: Vec<String> = s.command_zone.iter().filter(|id| s.objects.get(id).is_some_and(|o| o.owner.0 == seat)).map(|id| name(s, id)).collect();
    let _ = writeln!(out, "  command zone: {}", cz.join(", "));
    let casts: Vec<String> = s.commander_cast_count.iter().filter(|(id, _)| s.objects.get(id).is_some_and(|o| o.owner.0 == seat)).map(|(id, n)| format!("{} x{n}", name(s, id))).collect();
    let _ = writeln!(out, "  commander casts: {}", casts.join(", "));
    let mut lands = Vec::new();
    let mut other = Vec::new();
    for id in &s.battlefield {
        let Some(o) = s.objects.get(id) else { continue };
        if o.controller.0 != seat {
            continue;
        }
        let is_land = o.card_types.core_types.iter().any(|t| format!("{t:?}") == "Land");
        if is_land { lands.push(describe_obj(s, id)) } else { other.push(describe_obj(s, id)) }
    }
    let _ = writeln!(out, "  lands ({}):", lands.len());
    for l in lands {
        let _ = writeln!(out, "    {l}");
    }
    let _ = writeln!(out, "  other permanents ({}):", other.len());
    for l in other {
        let _ = writeln!(out, "    {l}");
    }
    // Every permanent (any controller) with an everything counter: checks Omo's static abilities.
    for id in &s.battlefield {
        let Some(o) = s.objects.get(id) else { continue };
        if o.counters.keys().any(|k| format!("{k:?}").to_lowercase().contains("everything")) {
            let _ = writeln!(out, "  EVERYTHING (s{}): {}", o.controller.0, describe_obj(s, id));
        }
    }
    // Opponents' board sizes.
    for q in &s.players {
        if q.id.0 == seat {
            continue;
        }
        let mine: Vec<&ObjectId> = s.battlefield.iter().filter(|id| s.objects.get(id).is_some_and(|o| o.controller == q.id)).collect();
        let creatures = mine.iter().filter(|id| s.objects.get(id).is_some_and(|o| o.card_types.core_types.iter().any(|t| format!("{t:?}") == "Creature"))).count();
        let _ = writeln!(out, "  seat {}: {} permanents, {} creatures, hand {}", q.id.0, mine.len(), creatures, q.hand.len());
    }
    out
}

fn main() {
    let h = std::thread::Builder::new().stack_size(STACK).spawn(run).unwrap();
    std::process::exit(h.join().unwrap_or(101));
}

fn run() -> i32 {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("labtrace: {e}");
            return 2;
        }
    };
    let text = std::fs::read_to_string(&args.schedule).expect("read schedule");
    let line = text.lines().find(|l| l.contains(&format!("\"game\":\"{}\"", args.game))).expect("game not in schedule");
    let (mut spec, mut difficulty) = GameSpec::parse(line).expect("schedule line");
    if let Some(d) = &args.difficulty {
        spec.difficulty = d.clone();
        difficulty = AiDifficulty::from_label(d);
    }
    let engine = Engine::load(&args.card_data).expect("card data");
    let decks: Vec<_> = spec.decks.iter().map(|id| load_deck(&engine, &args.decks_root, id).expect("deck").0).collect();
    let focus: Option<u8> = args.focus.as_ref().and_then(|f| spec.decks.iter().position(|d| d.contains(f.as_str())).map(|i| i as u8));
    println!("game {} seed {} difficulty {} decks {:?} focus seat {:?}", spec.game, spec.seed, spec.difficulty, spec.decks, focus);

    let db: &Arc<CardDatabase> = engine.database();
    let lists: Vec<PlayerDeckList> = decks.into_iter().map(|d| PlayerDeckList { main_deck: d.main, commander: d.commander, ..Default::default() }).collect();
    let players = lists.len() as u8;
    let mut it = lists.into_iter();
    let deck_list = DeckList { player: it.next().unwrap(), opponent: it.next().unwrap(), ai_decks: it.collect(), ..Default::default() };
    let header = ReplayHeader {
        format_config: FormatConfig::commander(),
        match_config: MatchConfig {
            loop_detection: if args.loops { yama_play::PLAY_LOOPS } else { yama_play::LoopDetectionMode::Off },
            ..MatchConfig::default()
        },
        player_count: players,
        first_player: Some(0),
        seed: spec.seed,
        deck_data: Some(deck_list),
    };
    let mut state = reconstruct_initial_state(&header, Some(db)).expect("setup");
    state.debug_mode = false;
    let seats: HashSet<PlayerId> = (0..players).map(PlayerId).collect();
    let configs: HashMap<PlayerId, AiConfig> =
        (0..players).map(|i| (PlayerId(i), create_config_for_players(difficulty, Platform::Native, players).into_measurement(spec.seed))).collect();
    let session = AiSession::arc_from_game(&state);
    let mut rng = StdRng::seed_from_u64(spec.seed ^ 0x9e37_79b9_7f4a_7c15);

    let mut actions = 0usize;
    let mut last_turn = 0u32;
    let mut out_seen: Vec<bool> = vec![false; players as usize];
    let mut eliminations: Vec<(u8, u32)> = Vec::new();
    let mut settlements = 0usize;
    // Focus-seat statistics, printed as one JSON line at the end.
    let mut casts: Vec<(u32, String)> = Vec::new();
    let mut lands_played = 0u32;
    let mut activations: BTreeMap<String, u32> = BTreeMap::new();
    let mut attacks = 0u32;
    let mut attackers = 0u32;
    let mut per_turn: Vec<(u32, usize, usize, usize, i32)> = Vec::new();
    let mut everything_seen: HashSet<u64> = HashSet::new();
    let mut everything: Vec<serde_json::Value> = Vec::new();
    let mut damage_taken: BTreeMap<String, i64> = BTreeMap::new();
    let mut kept_hand: Option<usize> = None;
    let mut mulligans = 0u32;
    let is_type = |o: &engine::game::game_object::GameObject, t: &str| o.card_types.core_types.iter().any(|c| format!("{c:?}") == t);
    // Every seat, for a baseline: (global turn, card) casts, lands at the start of each own turn, attacks.
    let np = players as usize;
    let mut all_casts: Vec<Vec<(u32, String)>> = vec![Vec::new(); np];
    let mut all_lands: Vec<Vec<usize>> = vec![Vec::new(); np];
    let mut all_attacks: Vec<u32> = vec![0; np];
    let mut turn_start_actions = 0usize;
    let ending: String = loop {
        if state.turn_number != last_turn {
            last_turn = state.turn_number;
            turn_start_actions = actions;
            println!("== turn {} (active seat {}) ==", state.turn_number, state.active_player.0);
            let a = state.active_player.0 as usize;
            if a < np {
                let lands = state.battlefield.iter().filter_map(|id| state.objects.get(id)).filter(|o| o.controller.0 as usize == a && is_type(o, "Land")).count();
                all_lands[a].push(lands);
            }
            if let Some(f) = focus {
                if state.active_player.0 == f {
                    print!("{}", board(&state, f));
                    let mine: Vec<_> = state.battlefield.iter().filter_map(|id| state.objects.get(id)).filter(|o| o.controller.0 == f).collect();
                    let lands = mine.iter().filter(|o| is_type(o, "Land")).count();
                    let creatures = mine.iter().filter(|o| is_type(o, "Creature")).count();
                    per_turn.push((state.turn_number, lands, creatures, state.players[f as usize].hand.len(), state.players[f as usize].life));
                }
            }
        }
        if let WaitingFor::GameOver { winner } = &state.waiting_for {
            break format!("game over, winner {:?}", winner.map(|w| w.0));
        }
        let alive: Vec<u8> = (0..players).filter(|s| !out_seen[*s as usize]).collect();
        if alive.len() <= 1 {
            break format!("last seat standing {:?}", alive);
        }
        if state.turn_number > spec.max_turns {
            break "turn cap".into();
        }
        if actions >= spec.max_actions {
            break "action cap".into();
        }
        // The batch runner's per-turn loop guard (MAX_TURN_ACTIONS).
        if actions - turn_start_actions >= yama_play::lab::MAX_TURN_ACTIONS {
            break "action cap (loop guard)".into();
        }
        match eligible_ai_decision(&state, &seats) {
            Some((owner, actor)) => {
                let decision = PreparedAiDecision::new(&state, owner);
                let chosen = decision.choose_action_with_session(&configs[&actor], &mut rng, &session).or_else(|| {
                    let f = phase_ai::search::fallback_action(&state, &configs[&actor], decision.contract());
                    if f.is_some() {
                        println!("  [fallback_action used for seat {}]", actor.0);
                    }
                    f
                });
                let contract = decision.into_contract();
                let Some(action) = chosen else { break format!("AI for seat {} found no action", actor.0) };
                let is_pass = matches!(action, GameAction::PassPriority);
                let lbl = if is_pass { String::new() } else { label(&state, &action) };
                match &action {
                    GameAction::CastSpell { object_id, .. } => all_casts[actor.0 as usize].push((state.turn_number, name(&state, object_id))),
                    GameAction::DeclareAttackers { attacks: a, .. } if !a.is_empty() => all_attacks[actor.0 as usize] += 1,
                    _ => {}
                }
                if Some(actor.0) == focus {
                    match &action {
                        GameAction::PlayLand { .. } => lands_played += 1,
                        GameAction::CastSpell { object_id, .. } => casts.push((state.turn_number, name(&state, object_id))),
                        GameAction::ActivateAbility { source_id, .. } => *activations.entry(name(&state, source_id)).or_default() += 1,
                        GameAction::DeclareAttackers { attacks: a, .. } if !a.is_empty() => {
                            attacks += 1;
                            attackers += a.len() as u32;
                        }
                        GameAction::MulliganDecision { choice } => {
                            if format!("{choice:?}").contains("Mulligan") {
                                mulligans += 1;
                            } else {
                                kept_hand = Some(state.players[actor.0 as usize].hand.len());
                            }
                        }
                        _ => {}
                    }
                }
                // With --loops, ordinary passes, as live games and `lab --loops` have them.
                let stack_pass = !args.loops && verified_ai_stack_pass_player(&state, &action).is_some();
                let applied = if stack_pass {
                    apply_verified_ai_priority_pass(&mut state, actor, &contract, action)
                } else {
                    apply_interaction(&mut state, actor, owner, action)
                };
                let result = match applied {
                    Ok(r) => r,
                    Err(e) => break format!("engine refused seat {}'s action: {e}", actor.0),
                };
                actions += 1;
                if !is_pass {
                    let star = if Some(actor.0) == focus { "*" } else { " " };
                    println!("{star}T{} s{} {}", state.turn_number, actor.0, lbl);
                }
                for e in &result.log_entries {
                    if let Some(f) = focus {
                        let t = segments_text(&e.segments);
                        let to = format!(" damage to Player {}", f + 1);
                        if let Some(pos) = t.find(&to) {
                            if t[pos + to.len()..].is_empty() {
                                // "<source> deals N [combat ]damage to Player K"
                                if let Some(d) = t.find(" deals ") {
                                    let src = t[..d].to_string();
                                    let n: i64 = t[d + 7..].split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
                                    *damage_taken.entry(src).or_default() += n;
                                }
                            }
                        }
                    }
                    let public = e.presentation.visibility == LogVisibility::Public;
                    let essential = e.presentation.importance == LogImportance::Essential;
                    if args.all_log || (public && essential) {
                        println!("    | {}", segments_text(&e.segments));
                    }
                }
            }
            None if matches!(state.waiting_for, WaitingFor::PhysicalContest { .. }) && settlements < 1000 => {
                if !phase_ai::contest::settle_headless_contest(&mut state, &seats, &mut rng) {
                    break "could not settle contest".into();
                }
                settlements += 1;
            }
            None => break "stalled".into(),
        }
        for id in &state.battlefield {
            let Some(o) = state.objects.get(id) else { continue };
            if o.counters.keys().any(|k| format!("{k:?}").to_lowercase().contains("everything")) && everything_seen.insert(id.0) {
                let mana = o.abilities.iter().filter(|a| engine::game::mana_abilities::is_mana_ability(a)).count();
                everything.push(serde_json::json!({"turn": state.turn_number, "name": o.name, "controller": o.controller.0,
                    "land": is_type(o, "Land"), "creature": is_type(o, "Creature"), "subtypes": o.card_types.subtypes.len(), "mana_abilities": mana}));
                println!("  [everything counter now on {} (s{}): {}]", o.name, o.controller.0, describe_obj(&state, id));
            }
        }
        for p in &state.players {
            let s = p.id.0 as usize;
            if p.is_eliminated && !out_seen[s] {
                out_seen[s] = true;
                eliminations.push((p.id.0, state.turn_number));
                println!("!! seat {} eliminated on turn {} (life {}, poison {})", s, state.turn_number, p.life, p.poison_counters);
            }
        }
    };
    println!("== end: {ending}; turns {} actions {} eliminations {:?}", state.turn_number, actions, eliminations);
    if let Some(f) = focus {
        println!("final board of focus seat {f}:");
        print!("{}", board(&state, f));
        // Where the focus seat's cards ended up.
        let gy: Vec<String> = state.players[f as usize].graveyard.iter().map(|c| name(&state, c)).collect();
        println!("  graveyard: {}", gy.join(" | "));
        let ex: Vec<String> = state.exile.iter().filter(|id| state.objects.get(id).is_some_and(|o| o.owner.0 == f && o.zone == Zone::Exile)).map(|c| name(&state, c)).collect();
        println!("  exile: {}", ex.join(" | "));
    }
    if let Some(f) = focus {
        let summary = serde_json::json!({
            "game": spec.game, "seat": f, "difficulty": spec.difficulty, "ending": ending, "turns": state.turn_number,
            "eliminations": eliminations, "mulligans": mulligans, "kept_hand": kept_hand, "lands_played": lands_played,
            "casts": casts, "activations": activations, "attacks": attacks, "attackers": attackers, "per_turn": per_turn,
            "everything": everything, "damage_taken": damage_taken,
        });
        println!("SUMMARY {summary}");
    }
    let seats_json: Vec<serde_json::Value> = (0..np)
        .map(|i| {
            let won = ending.ends_with(&format!("Some({i})"));
            serde_json::json!({"seat": i, "deck": spec.decks[i], "won": won, "casts": all_casts[i], "lands_at_own_turn": all_lands[i],
                "attacks": all_attacks[i], "out": eliminations.iter().find(|(s, _)| *s as usize == i).map(|(_, t)| *t)})
        })
        .collect();
    println!("SEATS {}", serde_json::json!({"game": spec.game, "difficulty": spec.difficulty, "ending": ending, "turns": state.turn_number, "seats": seats_json}));
    if let Some(path) = &args.expect {
        let want = std::fs::read_to_string(path).ok().and_then(|t| t.lines().find(|l| l.contains(&format!("\"game\":\"{}\"", spec.game))).map(str::to_string));
        println!("expected result line: {}", want.unwrap_or_else(|| "(not found)".into()));
    }
    0
}
