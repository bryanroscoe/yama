//! Runs referee scenarios (`referee/scenarios/*.json`) in phase and writes each final state in the
//! JSON shape the Forge runner writes, so `referee/compare.py` can diff the two engines.
//!
//! `referee --card-data PATH --out OUT.json SCENARIO.json...`
//!
//! A scenario sets up a board (no triggers fire for it), then plays its script: each step is
//! played when its seat has priority. Targets come from the script; with `"auto_targets": true`
//! the runner picks them itself (see [`preference`]) and reports them in `resolved`, a copy of the
//! scenario with every choice written out, for the Forge run to follow. Every other decision goes
//! to phase's AI. Seats never start anything on their own.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use engine::database::CardDatabase;
use engine::game::deck_loading::create_object_from_card_face;
use engine::game::engine::{apply, apply_interaction};
use engine::game::game_object::AttachTarget;
use engine::game::layers::{flush_layers, mark_layers_full};
use engine::game::mana_abilities::is_mana_ability;
use engine::types::ability::{AbilityKind, TargetRef};
use engine::types::actions::{AlternativeCastDecision, GameAction};
use engine::types::counter::parse_counter_type;
use engine::types::format::FormatConfig;
use engine::types::game_state::{
    CastPaymentMode, GameState, ShardChoice, StackEntryKind, WaitingFor,
};
use engine::types::identifiers::ObjectId;
use engine::types::log::{GameLogEntry, LogSegment};
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_ACTIONS: usize = 400;

#[derive(Deserialize)]
struct Scenario {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    seed: Option<u64>,
    #[serde(default)]
    active: u8,
    #[serde(default)]
    turn: Option<u32>,
    #[serde(default)]
    phase: Option<String>,
    seats: Vec<Seat>,
    #[serde(default)]
    script: Vec<Step>,
    #[serde(default)]
    trigger_targets: Vec<TriggerTargets>,
    #[serde(default)]
    auto_targets: bool,
}

#[derive(Deserialize, Default)]
struct Seat {
    life: Option<i32>,
    poison: Option<u32>,
    #[serde(default)]
    battlefield: Vec<CardSpec>,
    #[serde(default)]
    hand: Vec<CardSpec>,
    #[serde(default)]
    graveyard: Vec<CardSpec>,
    #[serde(default)]
    library: Vec<CardSpec>,
    #[serde(default)]
    exile: Vec<CardSpec>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CardSpec {
    Name(String),
    Full {
        card: String,
        #[serde(default)]
        tapped: bool,
        #[serde(default)]
        sick: bool,
        #[serde(default)]
        damage: u32,
        #[serde(default)]
        counters: BTreeMap<String, u32>,
    },
}

#[derive(Deserialize, Debug, Clone)]
struct Step {
    seat: u8,
    cast: Option<String>,
    activate: Option<String>,
    play: Option<String>,
    #[serde(default)]
    ability: usize,
    #[serde(default)]
    targets: Vec<TargetSpec>,
    /// Mode indices for a modal spell, in printed order.
    #[serde(default)]
    modes: Option<Vec<usize>>,
}

/// Targets for one triggered ability from `source`, used by the first trigger from that card
/// that asks for targets.
#[derive(Deserialize, Debug, Clone)]
struct TriggerTargets {
    source: String,
    targets: Vec<TargetSpec>,
}

#[derive(Deserialize, Debug, Clone)]
struct TargetSpec {
    seat: u8,
    card: Option<String>,
    zone: Option<String>,
}

fn main() {
    let mut card_data = None;
    let mut from_mtgjson = false;
    let mut out = None;
    let mut files = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--card-data" => card_data = args.next().map(PathBuf::from),
            // Parse the cards from an MTGJSON AtomicCards file at load time (the engine's own
            // `CardDatabase::from_mtgjson`), so parser changes show without regenerating card data.
            "--mtgjson" => {
                card_data = args.next().map(PathBuf::from);
                from_mtgjson = true;
            }
            "--out" => out = args.next().map(PathBuf::from),
            _ => files.push(PathBuf::from(a)),
        }
    }
    let (Some(card_data), Some(out)) = (card_data, out) else {
        eprintln!("usage: referee --card-data PATH --out OUT.json SCENARIO.json...");
        std::process::exit(64);
    };
    let started = Instant::now();
    let db = Arc::new(
        if from_mtgjson {
            CardDatabase::from_mtgjson(&card_data)
        } else {
            CardDatabase::from_export(&card_data)
        }
        .unwrap_or_else(|e| panic!("loading {}: {e}", card_data.display())),
    );
    eprintln!(
        "card data loaded in {:.1}s",
        started.elapsed().as_secs_f64()
    );
    // Debugging aid: REFEREE_DUMP="Name|Name" prints those cards' parsed faces.
    if let Ok(names) = std::env::var("REFEREE_DUMP") {
        for name in names.split('|') {
            match db.get_face_by_name(name) {
                Some(face) => eprintln!(
                    "DUMP {name}: {}",
                    serde_json::to_string(face).unwrap_or_else(|e| e.to_string())
                ),
                None => eprintln!("DUMP {name}: not found"),
            }
        }
    }

    let mut results = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file)
            .unwrap_or_else(|e| panic!("reading {}: {e}", file.display()));
        let raw: Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("parsing {}: {e}", file.display()));
        let name = raw["name"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| file_stem(file));
        let t = Instant::now();
        let mut result = match serde_json::from_value::<Scenario>(raw.clone()) {
            Err(e) => json!({ "error": format!("bad scenario: {e}") }),
            Ok(sc) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&sc, &raw, &db)))
                {
                    Ok(v) => v,
                    Err(p) => json!({ "error": format!("phase panicked: {}", panic_text(&p)) }),
                }
            }
        };
        let obj = result.as_object_mut().expect("object");
        obj.insert("engine".into(), json!("phase"));
        obj.insert("scenario".into(), json!(name));
        obj.insert("ms".into(), json!(t.elapsed().as_millis() as u64));
        results.push(result);
    }
    std::fs::write(&out, serde_json::to_string_pretty(&results).expect("json"))
        .unwrap_or_else(|e| panic!("writing {}: {e}", out.display()));
}

fn file_stem(p: &Path) -> String {
    p.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn panic_text(p: &Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ---- one scenario ------------------------------------------------------------------------

/// The step being played: which script step, the object it plays, and the targets still to give.
struct Playing {
    index: usize,
    source: ObjectId,
    targets: VecDeque<TargetRef>,
    explicit: bool,
}

fn run(sc: &Scenario, raw: &Value, db: &Arc<CardDatabase>) -> Value {
    let n = sc.seats.len() as u8;
    let format = match sc.format.as_deref() {
        Some("commander") => FormatConfig::commander(),
        _ => FormatConfig::standard(),
    };
    let mut state = GameState::new(format, n, sc.seed.unwrap_or(1));
    engine::game::install_card_db(&mut state, Arc::clone(db));
    let mut log = Vec::new();

    if let Err(e) = set_up(&mut state, sc, db) {
        let mut v = snapshot(&state, &log);
        v["error"] = json!(e);
        return v;
    }

    let seats: HashSet<PlayerId> = (0..n).map(PlayerId).collect();
    let config = create_config_for_players(AiDifficulty::Medium, Platform::Native, n);
    let session = AiSession::arc_from_game(&state);
    let mut rng = StdRng::seed_from_u64(sc.seed.unwrap_or(1));
    let mut script: VecDeque<(usize, Step)> = sc.script.iter().cloned().enumerate().collect();
    let mut triggers: Vec<(String, VecDeque<TargetSpec>)> = sc
        .trigger_targets
        .iter()
        .map(|t| (t.source.clone(), t.targets.iter().cloned().collect()))
        .collect();
    let mut resolved = raw.clone();
    let mut resolved_triggers: Vec<Value> = Vec::new();
    let mut resolved_modes: Vec<Value> = Vec::new();
    let mut resolved_choices: Vec<Value> = Vec::new();
    let mut seen_on_stack: HashMap<ObjectId, usize> = HashMap::new();
    let mut playing: Option<Playing> = None;
    let mut error = None;

    'actions: for _ in 0..MAX_ACTIONS {
        // Every triggered ability that reached the stack: write its targets down (whether phase
        // asked for them or picked the only legal one) for the Forge run to give the same.
        if sc.auto_targets {
            for entry in state.stack.iter() {
                // An entry can sit on the stack before its targets are final; keep the last
                // targets seen, which are the ones it resolves with.
                let StackEntryKind::TriggeredAbility { source_id, .. } = &entry.kind else {
                    continue;
                };
                let targets = entry_targets(&entry.kind);
                if targets.is_empty() {
                    continue;
                }
                let source = state
                    .objects
                    .get(source_id)
                    .map(shown_name)
                    .unwrap_or_default();
                let mut entry_json = json!({
                    "source": source,
                    "targets": targets.iter().map(|t| target_spec(&state, t)).collect::<Vec<_>>(),
                });
                if let Some(split) = entry_division(&entry.kind, &targets) {
                    entry_json["divide"] = json!(split);
                }
                match seen_on_stack.get(&entry.id) {
                    Some(&i) => resolved_triggers[i] = entry_json,
                    None => {
                        seen_on_stack.insert(entry.id, resolved_triggers.len());
                        resolved_triggers.push(entry_json);
                    }
                }
            }
        }
        let (actor, action) = match &state.waiting_for {
            WaitingFor::GameOver { .. } => break,
            WaitingFor::Priority { player } => {
                let p = *player;
                // The step's spell or ability is on the stack (or resolved, for a land): check
                // the targets phase chose, or write them down when the runner picked them.
                if let Some(done) = playing.take() {
                    let chosen = stack_targets_of(&state, done.source);
                    if done.explicit {
                        let wanted: Vec<TargetRef> = sc.script[done.index]
                            .targets
                            .iter()
                            .filter_map(|t| find_target(&state, t).ok())
                            .collect();
                        if !done.targets.is_empty() && !same_targets(&chosen, &wanted) {
                            error = Some(format!(
                                "phase chose [{}] without asking; the script wanted [{}]",
                                targets_text(&state, &chosen),
                                targets_text(&state, &wanted)
                            ));
                            break;
                        }
                    } else if sc.auto_targets && !chosen.is_empty() {
                        // A sub-ability that acts on the same target ("its controller gains
                        // life") repeats it; the script names each target once.
                        let mut once: Vec<TargetRef> = Vec::new();
                        for t in chosen {
                            if !once.contains(&t) {
                                once.push(t);
                            }
                        }
                        resolved["script"][done.index]["targets"] = json!(
                            once.iter()
                                .map(|t| target_spec(&state, t))
                                .collect::<Vec<_>>()
                        );
                        if let Some(split) = stack_entry_of(&state, done.source)
                            .and_then(|e| entry_division(&e.kind, &once))
                        {
                            resolved["script"][done.index]["divide"] = json!(split);
                        }
                    }
                }
                match script.front() {
                    Some((_, step)) if step.seat == p.0 => {
                        let (index, step) = script.pop_front().expect("peeked");
                        match step_action(&state, &step) {
                            Ok((action, source, targets)) => {
                                playing = Some(Playing {
                                    index,
                                    source,
                                    explicit: !step.targets.is_empty(),
                                    targets,
                                });
                                (p, action)
                            }
                            Err(e) => {
                                error = Some(e);
                                break;
                            }
                        }
                    }
                    None if state.stack.is_empty() => break,
                    _ => (p, GameAction::PassPriority),
                }
            }
            WaitingFor::TargetSelection {
                player,
                target_slots,
                selection,
                ..
            } if playing.is_some() => {
                let step = playing.as_mut().expect("checked");
                let slot = &target_slots[selection.current_slot];
                // "Any number of" / "up to" slots past the first stay empty.
                let leave_empty = step.targets.is_empty()
                    && sc.auto_targets
                    && !step.explicit
                    && slot.optional
                    && selection.current_slot > 0;
                let t = if leave_empty {
                    None
                } else if let Some(t) = step.targets.pop_front() {
                    Some(t)
                } else if sc.auto_targets && !step.explicit {
                    match preferred(&state, *player, &open_targets(slot, selection)) {
                        Some(t) => Some(t),
                        None => {
                            error = Some("no legal target to pick".into());
                            break;
                        }
                    }
                } else {
                    error = Some(format!(
                        "phase asks for a target the script doesn't give ({} legal)",
                        slot.legal_targets.len()
                    ));
                    break;
                };
                if let Some(t) = &t {
                    if !slot.legal_targets.contains(t) {
                        error = Some(format!(
                            "phase says {} is not a legal target ({} legal)",
                            target_text(&state, t),
                            slot.legal_targets.len()
                        ));
                        break;
                    }
                }
                (*player, GameAction::ChooseTarget { target: t })
            }
            WaitingFor::TriggerTargetSelection {
                player,
                trigger_controller,
                target_slots,
                selection,
                source_id,
                ..
            } => {
                let source_name = source_id
                    .and_then(|id| state.objects.get(&id))
                    .map(|o| o.name.clone())
                    .unwrap_or_default();
                let slot = &target_slots[selection.current_slot];
                let scripted = triggers
                    .iter_mut()
                    .find(|(s, ts)| *s == source_name && !ts.is_empty())
                    .and_then(|(_, ts)| ts.pop_front());
                let (who, t) = match scripted {
                    Some(spec) => match find_target(&state, &spec) {
                        Ok(t) => (*player, Some(t)),
                        Err(e) => {
                            error = Some(e);
                            break;
                        }
                    },
                    None if sc.auto_targets => {
                        let chooser = trigger_controller.unwrap_or(*player);
                        if slot.optional && selection.current_slot > 0 {
                            (*player, None)
                        } else {
                            let Some(t) =
                                preferred(&state, chooser, &open_targets(slot, selection))
                            else {
                                error = Some("no legal trigger target to pick".into());
                                break;
                            };
                            (*player, Some(t))
                        }
                    }
                    None => match ai_answer(&mut state, &seats, &config, &mut rng, &session) {
                        Ok(r) => {
                            log.extend(r);
                            continue 'actions;
                        }
                        Err(e) => {
                            error = Some(e);
                            break;
                        }
                    },
                };
                if let Some(t) = &t {
                    if !slot.legal_targets.contains(t) {
                        error = Some(format!(
                            "phase says {} is not a legal target for {source_name}'s trigger",
                            target_text(&state, t)
                        ));
                        break;
                    }
                }
                (who, GameAction::ChooseTarget { target: t })
            }
            // Scripted casts pay the printed cost: no kicker or other optional cost, no evoke or
            // other alternative cost (the Forge run casts the card's first spell ability).
            // Fixed answers both runners give, so the two AIs' tastes don't split the result:
            // every "you may" is taken, surveil and scry keep every card on top, Phyrexian
            // mana is paid with mana.
            WaitingFor::OptionalEffectChoice { player, .. } => {
                (*player, GameAction::DecideOptionalEffect { accept: true })
            }
            WaitingFor::SurveilChoice { player, cards } | WaitingFor::ScryChoice { player, cards } => {
                (
                    *player,
                    GameAction::SelectCards {
                        cards: cards.clone(),
                    },
                )
            }
            WaitingFor::PhyrexianPayment { player, shards, .. } => (
                *player,
                GameAction::SubmitPhyrexianChoices {
                    choices: vec![ShardChoice::PayMana; shards.len()],
                },
            ),
            WaitingFor::OptionalCostChoice { player, .. } if playing.is_some() => {
                (*player, GameAction::DecideOptionalCost { pay: false })
            }
            WaitingFor::AlternativeCastChoice { player, .. } if playing.is_some() => (
                *player,
                GameAction::ChooseAlternativeCast {
                    choice: AlternativeCastDecision::Normal,
                },
            ),
            // The step names the card's front face (or first half): play and cast that, the
            // normal way, as the Forge runner does.
            WaitingFor::ModalFaceChoice { player, .. } if playing.is_some() => {
                (*player, GameAction::ChooseModalFace { back_face: false })
            }
            WaitingFor::CastingVariantChoice {
                player, options, ..
            } if playing.is_some() => {
                let rank = |o: &engine::types::game_state::CastingVariantChoiceOption| {
                    let normal = format!("{:?}", o.variant) == "Normal";
                    let face = format!("{:?}", o.face);
                    match (normal, face.as_str()) {
                        (true, "Current") => 0,
                        (true, "Left") => 1,
                        (true, _) => 2,
                        _ => 3,
                    }
                };
                let index = (0..options.len())
                    .min_by_key(|&i| rank(&options[i]))
                    .unwrap_or(0);
                (*player, GameAction::ChooseCastingVariant { index })
            }
            WaitingFor::ModeChoice { player, .. } if playing.is_some() => {
                let index = playing.as_ref().expect("checked").index;
                match &sc.script[index].modes {
                    Some(indices) => (
                        *player,
                        GameAction::SelectModes {
                            indices: indices.clone(),
                        },
                    ),
                    None => {
                        // phase's AI picks; write its pick down for the Forge run.
                        let player = *player;
                        let Some(action) =
                            choose_action_with_session(&state, player, &config, &mut rng, &session)
                        else {
                            error = Some("phase's AI found no modes to choose".into());
                            break;
                        };
                        if let GameAction::SelectModes { indices } = &action {
                            if sc.auto_targets {
                                resolved["script"][index]["modes"] = json!(indices);
                            }
                        }
                        (player, action)
                    }
                }
            }
            WaitingFor::AbilityModeChoice {
                player, source_id, ..
            } if sc.auto_targets => {
                let player = *player;
                let source = state
                    .objects
                    .get(source_id)
                    .map(shown_name)
                    .unwrap_or_default();
                let Some(action) =
                    choose_action_with_session(&state, player, &config, &mut rng, &session)
                else {
                    error = Some("phase's AI found no modes to choose".into());
                    break;
                };
                if let GameAction::SelectModes { indices } = &action {
                    resolved_modes.push(json!({ "source": source, "modes": indices }));
                }
                (player, action)
            }
            WaitingFor::NamedChoice {
                player,
                choice_type,
                options,
                ..
            } if sc.auto_targets => {
                let player = *player;
                match named_choice(&state, player, choice_type, options) {
                    Some((kind, value)) => {
                        resolved_choices.push(json!({ "kind": kind, "value": value }));
                        (player, GameAction::ChooseOption { choice: value })
                    }
                    None => match ai_answer(&mut state, &seats, &config, &mut rng, &session) {
                        Ok(r) => {
                            log.extend(r);
                            continue;
                        }
                        Err(e) => {
                            error = Some(e);
                            break;
                        }
                    },
                }
            }
            _ => match ai_answer(&mut state, &seats, &config, &mut rng, &session) {
                Ok(r) => {
                    log.extend(r);
                    continue;
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            },
        };
        match apply(&mut state, actor, action.clone()) {
            Ok(r) => log.extend(r.log_entries),
            Err(e) => {
                error = Some(format!("phase refused {action:?}: {e}"));
                break;
            }
        }
    }

    let mut v = snapshot(&state, &log);
    if error.is_none() {
        if let Some((_, step)) = script.front() {
            error = Some(format!("script step never ran: {step:?}"));
        } else if !matches!(
            state.waiting_for,
            WaitingFor::Priority { .. } | WaitingFor::GameOver { .. }
        ) || !state.stack.is_empty()
        {
            error = Some(format!("still running after {MAX_ACTIONS} actions"));
        }
    }
    if let Some(e) = error {
        v["error"] = json!(e);
    }
    if sc.auto_targets {
        resolved["auto_targets"] = json!(false);
        if !resolved_triggers.is_empty() {
            resolved["trigger_targets"] = json!(resolved_triggers);
        }
        if !resolved_modes.is_empty() {
            resolved["trigger_modes"] = json!(resolved_modes);
        }
        if !resolved_choices.is_empty() {
            resolved["named_choices"] = json!(resolved_choices);
        }
        v["resolved"] = resolved;
    }
    v
}

/// Let phase's AI answer whatever the game is waiting on.
fn ai_answer(
    state: &mut GameState,
    seats: &HashSet<PlayerId>,
    config: &phase_ai::config::AiConfig,
    rng: &mut StdRng,
    session: &Arc<AiSession>,
) -> Result<Vec<GameLogEntry>, String> {
    let Some((owner, actor)) = eligible_ai_decision(state, seats) else {
        return Err(format!(
            "nobody can act on {}",
            waiting_name(&state.waiting_for)
        ));
    };
    let Some(action) = choose_action_with_session(state, owner, config, rng, session) else {
        return Err(format!(
            "phase's AI found no answer to {}",
            waiting_name(&state.waiting_for)
        ));
    };
    apply_interaction(state, actor, owner, action.clone())
        .map(|r| r.log_entries)
        .map_err(|e| format!("phase refused its AI's {action:?}: {e}"))
}

/// The slot's legal targets that this ability hasn't already chosen.
fn open_targets(
    slot: &engine::types::game_state::TargetSelectionSlot,
    selection: &engine::types::game_state::TargetSelectionProgress,
) -> Vec<TargetRef> {
    // The engine's own list for this slot already applies "different targets" rules; a mode
    // chosen twice may reuse a target (CR 700.2d), so don't second-guess it.
    if !selection.current_legal_targets.is_empty() {
        return selection.current_legal_targets.clone();
    }
    slot.legal_targets
        .iter()
        .filter(|t| {
            !selection
                .selected_slots
                .iter()
                .any(|s| s.as_ref() == Some(*t))
        })
        .cloned()
        .collect()
}

/// The runner's own pick among legal targets, so both engines get the same one: an opponent's
/// creature, the opponent, their other permanents, cards in their graveyard; then the same of
/// the chooser's own; then anything else. Ties go to the name, then the oldest object.
fn preferred(state: &GameState, chooser: PlayerId, legal: &[TargetRef]) -> Option<TargetRef> {
    legal
        .iter()
        .min_by_key(|t| preference(state, chooser, t))
        .cloned()
}

fn preference(state: &GameState, chooser: PlayerId, t: &TargetRef) -> (u8, String, u64) {
    match t {
        TargetRef::Player(p) => (if *p == chooser { 15 } else { 1 }, String::new(), 0),
        TargetRef::Object(id) => {
            let Some(o) = state.objects.get(id) else {
                return (99, String::new(), 0);
            };
            let mine = match o.zone {
                Zone::Battlefield | Zone::Stack => o.controller == chooser,
                _ => o.owner == chooser,
            };
            let creature = o
                .card_types
                .core_types
                .iter()
                .any(|c| format!("{c:?}") == "Creature");
            let rank = match (o.zone, creature) {
                (Zone::Battlefield, true) => 0,
                (Zone::Battlefield, false) => 2,
                (Zone::Graveyard, _) => 3,
                (Zone::Stack, _) => 4,
                (Zone::Exile, _) => 5,
                _ => 6,
            };
            (
                rank + if mine { 10 } else { 0 },
                o.name.clone(),
                id.0 as u64,
            )
        }
    }
}

fn set_up(state: &mut GameState, sc: &Scenario, db: &CardDatabase) -> Result<(), String> {
    for (i, seat) in sc.seats.iter().enumerate() {
        let p = PlayerId(i as u8);
        state.players[i].life = seat.life.unwrap_or(20);
        state.players[i].poison_counters = seat.poison.unwrap_or(0);
        for (zone, cards) in [
            (Zone::Library, &seat.library),
            (Zone::Battlefield, &seat.battlefield),
            (Zone::Hand, &seat.hand),
            (Zone::Graveyard, &seat.graveyard),
            (Zone::Exile, &seat.exile),
        ] {
            for spec in cards {
                place(state, db, p, zone, spec)?;
            }
        }
    }
    let active = PlayerId(sc.active);
    state.active_player = active;
    state.priority_player = active;
    state.turn_number = sc.turn.unwrap_or(2);
    state.phase = match sc.phase.as_deref().unwrap_or("main1") {
        "upkeep" => Phase::Upkeep,
        "draw" => Phase::Draw,
        "main1" => Phase::PreCombatMain,
        "main2" => Phase::PostCombatMain,
        "end" => Phase::End,
        other => return Err(format!("unknown phase {other}")),
    };
    state.waiting_for = WaitingFor::Priority { player: active };
    // What loading decks does in a real game: printed-card metadata from the card data, and the
    // creature-type vocabulary from the whole corpus (CR 205.3m; changelings, "choose a creature
    // type", shared creature types).
    engine::game::rehydrate_game_from_card_db(state, db);
    let mut vocabulary = db.creature_type_vocabulary().to_vec();
    vocabulary.sort();
    state.all_creature_types = vocabulary;
    // Objects were placed by hand, so the layer system hasn't seen them yet.
    mark_layers_full(state);
    flush_layers(state);
    Ok(())
}

/// Create the card in the owner's library (where phase creates cards) and move it to `zone`
/// without a zone-change event, as the board would be at the start of the scenario.
fn place(
    state: &mut GameState,
    db: &CardDatabase,
    owner: PlayerId,
    zone: Zone,
    spec: &CardSpec,
) -> Result<ObjectId, String> {
    let name = match spec {
        CardSpec::Name(n) => n,
        CardSpec::Full { card, .. } => card,
    };
    let face = db
        .get_face_by_name(name)
        .ok_or_else(|| format!("phase doesn't know the card {name}"))?;
    let id = create_object_from_card_face(state, face, owner);
    let i = owner.0 as usize;
    if zone != Zone::Library {
        state.players[i].library.retain(|o| *o != id);
        match zone {
            Zone::Battlefield => state.battlefield.push_back(id),
            Zone::Hand => state.players[i].hand.push_back(id),
            Zone::Graveyard => state.players[i].graveyard.push_back(id),
            Zone::Exile => state.exile.push_back(id),
            _ => unreachable!("set_up only places these zones"),
        }
    }
    let obj = state.objects.get_mut(&id).expect("just created");
    obj.zone = zone;
    if zone == Zone::Battlefield {
        obj.summoning_sick = false;
    }
    if let CardSpec::Full {
        tapped,
        sick,
        damage,
        counters,
        ..
    } = spec
    {
        obj.tapped = *tapped;
        obj.summoning_sick = *sick;
        obj.damage_marked = *damage;
        for (kind, count) in counters {
            obj.counters.insert(parse_counter_type(kind), *count);
        }
    }
    Ok(id)
}

/// The action for a script step, the object it plays, and the targets to give when phase asks.
fn step_action(
    state: &GameState,
    step: &Step,
) -> Result<(GameAction, ObjectId, VecDeque<TargetRef>), String> {
    let seat = PlayerId(step.seat);
    let targets = step
        .targets
        .iter()
        .map(|t| find_target(state, t))
        .collect::<Result<VecDeque<_>, _>>()?;
    let in_hand = |name: &str| {
        state.players[seat.0 as usize]
            .hand
            .iter()
            .copied()
            .find(|id| state.objects[id].name == *name)
            .ok_or_else(|| format!("seat {} has no {name} in hand", seat.0))
    };
    if let Some(name) = &step.play {
        let id = in_hand(name)?;
        let card_id = state.objects[&id].card_id;
        return Ok((
            GameAction::PlayLand {
                object_id: id,
                card_id,
            },
            id,
            targets,
        ));
    }
    if let Some(name) = &step.cast {
        let id = in_hand(name)?;
        let card_id = state.objects[&id].card_id;
        return Ok((
            GameAction::CastSpell {
                object_id: id,
                card_id,
                targets: vec![],
                payment_mode: CastPaymentMode::Auto,
            },
            id,
            targets,
        ));
    }
    if let Some(name) = &step.activate {
        for id in state.battlefield.iter().copied() {
            let obj = &state.objects[&id];
            if obj.controller != seat || obj.name != *name {
                continue;
            }
            let index = obj
                .abilities
                .iter()
                .enumerate()
                .filter(|(_, a)| a.kind == AbilityKind::Activated && !is_mana_ability(a))
                .map(|(i, _)| i)
                .nth(step.ability);
            if let Some(ability_index) = index {
                return Ok((
                    GameAction::ActivateAbility {
                        source_id: id,
                        ability_index,
                        payment_mode: CastPaymentMode::Auto,
                    },
                    id,
                    targets,
                ));
            }
        }
        return Err(format!(
            "seat {} has no {name} with activated ability {}",
            seat.0, step.ability
        ));
    }
    Err(format!("unknown step {step:?}"))
}

fn find_target(state: &GameState, t: &TargetSpec) -> Result<TargetRef, String> {
    let seat = PlayerId(t.seat);
    let Some(name) = &t.card else {
        return Ok(TargetRef::Player(seat));
    };
    let zone = t.zone.as_deref().unwrap_or("battlefield");
    let pool: Vec<ObjectId> = match zone {
        "battlefield" => state
            .battlefield
            .iter()
            .copied()
            .filter(|id| state.objects[id].controller == seat)
            .collect(),
        "graveyard" => state.players[seat.0 as usize]
            .graveyard
            .iter()
            .copied()
            .collect(),
        "hand" => state.players[seat.0 as usize]
            .hand
            .iter()
            .copied()
            .collect(),
        "exile" => state
            .exile
            .iter()
            .copied()
            .filter(|id| state.objects[id].owner == seat)
            .collect(),
        "stack" => state.stack.iter().map(|e| e.id).collect(),
        other => return Err(format!("unknown target zone {other}")),
    };
    pool.into_iter()
        .find(|id| state.objects.get(id).is_some_and(|o| o.name == *name))
        .map(TargetRef::Object)
        .ok_or_else(|| format!("target not found: {name} ({zone}, seat {})", seat.0))
}

/// A target as the scenario writes it: a seat, or a card by name, the seat that controls it
/// (on the battlefield or stack) or owns it, and its zone.
fn target_spec(state: &GameState, t: &TargetRef) -> Value {
    match t {
        TargetRef::Player(p) => json!({ "seat": p.0 }),
        TargetRef::Object(id) => match state.objects.get(id) {
            None => json!({ "seat": 0, "card": "?" }),
            Some(o) => {
                let (seat, zone) = match o.zone {
                    Zone::Battlefield => (o.controller, "battlefield"),
                    Zone::Stack => (o.controller, "stack"),
                    Zone::Graveyard => (o.owner, "graveyard"),
                    Zone::Hand => (o.owner, "hand"),
                    Zone::Exile => (o.owner, "exile"),
                    _ => (o.owner, "library"),
                };
                if zone == "battlefield" {
                    json!({ "seat": seat.0, "card": o.name })
                } else {
                    json!({ "seat": seat.0, "card": o.name, "zone": zone })
                }
            }
        },
    }
}

/// Every target of the newest stack entry from `source`, its sub-abilities included.
fn stack_targets_of(state: &GameState, source: ObjectId) -> Vec<TargetRef> {
    stack_entry_of(state, source)
        .map(|e| entry_targets(&e.kind))
        .unwrap_or_default()
}

/// The step's own spell or activated ability, not a trigger it caused ("when you cast").
fn stack_entry_of(
    state: &GameState,
    source: ObjectId,
) -> Option<&engine::types::game_state::StackEntry> {
    state.stack.iter().rev().find(|e| match &e.kind {
        StackEntryKind::Spell { .. } => e.id == source || e.source_id == source,
        StackEntryKind::ActivatedAbility { .. } => e.source_id == source,
        _ => false,
    })
}

/// How a "divide N among" ability split its amount, one number per target in `targets` order
/// (0 for a target the split doesn't name). `None` when nothing on the entry is divided.
fn entry_division(kind: &StackEntryKind, targets: &[TargetRef]) -> Option<Vec<u32>> {
    let mut ability = match kind {
        StackEntryKind::Spell { ability, .. } => ability.as_deref(),
        StackEntryKind::ActivatedAbility { ability, .. }
        | StackEntryKind::TriggeredAbility { ability, .. } => Some(&**ability),
        _ => None,
    };
    while let Some(a) = ability {
        if let Some(split) = &a.distribution {
            return Some(
                targets
                    .iter()
                    .map(|t| split.iter().find(|(d, _)| d == t).map_or(0, |(_, n)| *n))
                    .collect(),
            );
        }
        ability = a.sub_ability.as_deref();
    }
    None
}

/// A stack entry's targets, its sub-abilities included, each once.
fn entry_targets(kind: &StackEntryKind) -> Vec<TargetRef> {
    let mut ability = match kind {
        StackEntryKind::Spell { ability, .. } => ability.as_deref(),
        StackEntryKind::ActivatedAbility { ability, .. }
        | StackEntryKind::TriggeredAbility { ability, .. } => Some(&**ability),
        _ => None,
    };
    let mut out: Vec<TargetRef> = Vec::new();
    while let Some(a) = ability {
        for t in &a.targets {
            if !out.contains(t) {
                out.push(t.clone());
            }
        }
        ability = a.sub_ability.as_deref();
    }
    out
}

/// The runner's fixed answer to a named choice, so both engines make the same one: the creature
/// type most of the chooser's creatures share, the colour most of their permanents have, the
/// opponent's best-known card name. `None` leaves it to phase's AI.
fn named_choice(
    state: &GameState,
    chooser: PlayerId,
    choice_type: &engine::types::ability::ChoiceType,
    options: &[String],
) -> Option<(&'static str, String)> {
    use engine::types::ability::ChoiceType;
    let mine: Vec<_> = state
        .battlefield
        .iter()
        .filter_map(|id| state.objects.get(id))
        .filter(|o| o.controller == chooser)
        .collect();
    let allowed = |v: &str| options.is_empty() || options.iter().any(|o| o == v);
    let most = |counts: BTreeMap<String, usize>| {
        counts
            .into_iter()
            .filter(|(v, _)| allowed(v))
            .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
            .map(|(v, _)| v)
    };
    match choice_type {
        ChoiceType::CreatureType { .. } => {
            let mut counts = BTreeMap::new();
            for o in &mine {
                if o.card_types
                    .core_types
                    .iter()
                    .any(|c| format!("{c:?}") == "Creature")
                {
                    for t in &o.card_types.subtypes {
                        *counts.entry(t.clone()).or_insert(0) += 1;
                    }
                }
            }
            let v = most(counts).or_else(|| {
                let mut o = options.to_vec();
                o.sort();
                o.into_iter().next()
            })?;
            Some(("creature_type", v))
        }
        ChoiceType::Color { .. } => {
            let mut counts = BTreeMap::new();
            for o in &mine {
                for c in &o.color {
                    *counts.entry(format!("{c:?}")).or_insert(0) += 1;
                }
            }
            let v = most(counts).or_else(|| options.first().cloned())?;
            Some(("color", v))
        }
        ChoiceType::CardName => {
            let v = if allowed("Serra Angel") {
                "Serra Angel".to_string()
            } else {
                options.first()?.clone()
            };
            Some(("card_name", v))
        }
        _ => None,
    }
}

fn same_targets(chosen: &[TargetRef], wanted: &[TargetRef]) -> bool {
    let mut left = chosen.to_vec();
    for w in wanted {
        match left.iter().position(|c| c == w) {
            Some(i) => {
                left.remove(i);
            }
            None => return false,
        }
    }
    left.is_empty()
}

fn targets_text(state: &GameState, ts: &[TargetRef]) -> String {
    ts.iter()
        .map(|t| target_text(state, t))
        .collect::<Vec<_>>()
        .join(", ")
}

fn target_text(state: &GameState, t: &TargetRef) -> String {
    match t {
        TargetRef::Player(p) => format!("seat {}", p.0),
        TargetRef::Object(id) => state
            .objects
            .get(id)
            .map_or_else(|| format!("object {}", id.0), |o| o.name.clone()),
    }
}

fn waiting_name(w: &WaitingFor) -> String {
    let s = format!("{w:?}");
    s.split([' ', '{', '('])
        .next()
        .unwrap_or_default()
        .to_string()
}

// ---- phase state -> shared JSON ------------------------------------------------------------

fn snapshot(state: &GameState, log: &[GameLogEntry]) -> Value {
    let names = |ids: &mut dyn Iterator<Item = ObjectId>| -> Vec<String> {
        let mut v: Vec<String> = ids
            .filter_map(|id| state.objects.get(&id).map(shown_name))
            .collect();
        v.sort();
        v
    };
    let seats: Vec<Value> = state
        .players
        .iter()
        .map(|p| {
            let mut bf: Vec<Value> = state
                .battlefield
                .iter()
                .filter_map(|id| state.objects.get(id))
                .filter(|o| o.controller == p.id)
                // Phased-out permanents are treated as though they don't exist (CR 702.26b).
                .filter(|o| matches!(o.phase_status, engine::game::game_object::PhaseStatus::PhasedIn))
                .map(|o| {
                    // A permanent with every creature type (changelings) reports one marker,
                    // as the Forge runner does, rather than hundreds of names.
                    let all_creature_types = !state.all_creature_types.is_empty()
                        && state
                            .all_creature_types
                            .iter()
                            .all(|t| o.card_types.subtypes.contains(t));
                    let mut types: Vec<String> = o
                        .card_types
                        .core_types
                        .iter()
                        .map(|t| format!("{t:?}"))
                        .chain(
                            o.card_types
                                .subtypes
                                .iter()
                                .filter(|t| !all_creature_types || !state.all_creature_types.contains(t))
                                .cloned(),
                        )
                        .collect();
                    if all_creature_types {
                        types.push("<all creature types>".into());
                    }
                    types.sort();
                    let mut c = json!({ "card": shown_name(o), "owner": o.owner.0, "tapped": o.tapped, "types": types });
                    if o
                        .card_types
                        .core_types
                        .iter()
                        .any(|t| format!("{t:?}") == "Creature")
                    {
                        c["power"] = json!(o.power.unwrap_or(0));
                        c["toughness"] = json!(o.toughness.unwrap_or(0));
                        c["damage"] = json!(o.damage_marked);
                    }
                    if o.is_token {
                        c["token"] = json!(true);
                    }
                    let counters: BTreeMap<String, u32> = o
                        .counters
                        .iter()
                        .filter(|(_, n)| **n > 0)
                        .map(|(k, n)| (k.display_phrase().to_lowercase(), *n))
                        .collect();
                    if !counters.is_empty() {
                        c["counters"] = json!(counters);
                    }
                    if let Some(host) = &o.attached_to {
                        c["attached_to"] = json!(attach_text(state, host));
                    }
                    c
                })
                .collect();
            bf.sort_by_key(|v| v.to_string());
            json!({
                "life": p.life,
                "poison": p.poison_counters,
                "lost": p.is_eliminated,
                "hand": names(&mut p.hand.iter().copied()),
                "graveyard": names(&mut p.graveyard.iter().copied()),
                "exile": names(&mut state.exile.iter().copied().filter(|id| state.objects.get(id).is_some_and(|o| o.owner == p.id))),
                "library": p.library.len(),
                "battlefield": bf,
            })
        })
        .collect();
    let stack: Vec<String> = state
        .stack
        .iter()
        .map(|e| {
            state
                .objects
                .get(&e.source_id)
                .map_or_else(String::new, |o| o.name.clone())
        })
        .collect();
    json!({
        "turn": state.turn_number,
        "phase": phase_name(state.phase),
        "active": state.active_player.0,
        "game_over": matches!(state.waiting_for, WaitingFor::GameOver { .. }),
        "seats": seats,
        "stack": stack,
        "log": log.iter().map(|e| segments_text(&e.segments)).collect::<Vec<_>>(),
    })
}

/// A face-down card's name is hidden information; both runners report it the same way.
fn shown_name(o: &engine::game::game_object::GameObject) -> String {
    if o.face_down {
        "(face down)".to_string()
    } else {
        o.name.clone()
    }
}

fn attach_text(state: &GameState, host: &AttachTarget) -> String {
    match host {
        AttachTarget::Object(id) => state
            .objects
            .get(id)
            .map_or_else(|| format!("object {}", id.0), |o| o.name.clone()),
        AttachTarget::Player(p) => format!("seat {}", p.0),
    }
}

/// Forge's phase names, lowercased, so the two sides compare.
fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Untap => "untap",
        Phase::Upkeep => "upkeep",
        Phase::Draw => "draw",
        Phase::PreCombatMain => "main1",
        Phase::BeginCombat => "combat_begin",
        Phase::DeclareAttackers => "combat_declare_attackers",
        Phase::DeclareBlockers => "combat_declare_blockers",
        Phase::CombatDamage => "combat_damage",
        Phase::EndCombat => "combat_end",
        Phase::PostCombatMain => "main2",
        Phase::End => "end_of_turn",
        Phase::Cleanup => "cleanup",
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
