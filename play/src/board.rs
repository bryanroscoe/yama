//! phase's own board (phase's web client, served at `/board/`) on a Yama game.
//!
//! The client speaks phase-server's WebSocket protocol (`server_core::protocol`). Yama answers
//! the part of it a seated player or a watcher needs, with the same builders phase-server uses
//! (`crates/phase-server/src/main.rs`, `build_game_started_message` and
//! `build_state_update_message`): every seat gets the game filtered for it
//! (`server_core::filter_state_for_player`: every library and every other hand are "Hidden
//! Card"), and only the acting seat gets legal actions, costs and per-card actions.

use std::collections::HashMap;

use engine::ai_support::{
    activation_block_reasons_for_viewer, auto_pass_recommended_for_viewer, end_continuous_effect_offers,
    mana_payment_shortcut_actions, with_viewer_actions,
};
use engine::game::derived_views::derive_filtered_views;
use engine::game::interaction::{derive_viewer_interaction, object_action_payloads};
use engine::types::events::GameEvent;
use engine::types::game_state::GameState;
use engine::types::log::GameLogEntry;
pub use server_core::protocol::{ClientMessage, ServerMessage, ServerMode};
use server_core::session::{DecisionSnapshot, FullSessionKey};
use server_core::{filter_events_for_player, filter_state_for_player, is_acting};

pub use engine::types::action_rejection::ActionRejection as Rejection;
pub use engine::types::interaction::InteractionSubmission;
pub use engine::types::{actions::GameAction, player::PlayerId};
pub use server_core::protocol::PROTOCOL_VERSION;

/// The viewer phase uses for someone watching: no seat, nothing private, no actions.
pub const SPECTATOR: PlayerId = PlayerId(u8::MAX);

/// The host's standing settings for an existing game's attachment. This Yama
/// envelope extension is separate from Phase's engine state and wire payload.
#[derive(serde::Serialize)]
pub struct GameplayPreferences {
    phase_stops: Vec<engine::types::phase::PhaseStop>,
    priority_passing_mode: engine::types::game_state::PriorityPassingMode,
    full_control: bool,
    un_card_actions_enabled: bool,
}

impl crate::Match {
    pub fn board_preferences(&self, seat: u8) -> GameplayPreferences {
        use engine::types::game_state::PriorityPassingMode;
        use engine::types::phase::{Phase, PhaseStop, PhaseStopScope};
        let controls = self.controls(seat);
        let mut phase_stops = Vec::new();
        if let Some(stops) = &controls.stops {
            // Yama accepts string step names in its original board. Only known
            // engine phases can be represented in Phase's typed controls.
            for name in stops.own.union(&stops.others) {
                let Ok(phase) = serde_json::from_value::<Phase>(name.clone().into()) else { continue };
                let scope = match (stops.own.contains(name), stops.others.contains(name)) {
                    (true, true) => PhaseStopScope::AllTurns,
                    (true, false) => PhaseStopScope::OwnTurn,
                    (false, _) => PhaseStopScope::OpponentsTurns,
                };
                phase_stops.push(PhaseStop { phase, scope });
            }
        }
        // A temporary hold uses engine FullControl too, but must neither turn on
        // the standing UI toggle nor become a new standing preference on attach.
        let priority_passing_mode = match self.engine_state().priority_passing_mode(PlayerId(seat)) {
            PriorityPassingMode::FullControl => PriorityPassingMode::Standard,
            mode => mode,
        };
        GameplayPreferences {
            phase_stops, priority_passing_mode, full_control: controls.full_control,
            un_card_actions_enabled: self.engine_state().un_actions.is_enabled(PlayerId(seat)),
        }
    }
}

/// Changes since the last publication, projected immediately after each action.
/// Later visibility changes must never reclassify an earlier private event.
#[derive(Debug, Clone, Default)]
pub struct Tail {
    events: HashMap<PlayerId, Vec<GameEvent>>,
    log_entries: Vec<GameLogEntry>,
}

/// Most events a tail keeps when no board takes them: a full board is sent every time, so
/// dropping the oldest only loses animations.
const TAIL_LIMIT: usize = 2_000;

impl Tail {
    pub fn is_empty(&self) -> bool {
        self.events.is_empty() && self.log_entries.is_empty()
    }

    pub(crate) fn push(&mut self, state: &GameState, events: &[GameEvent], log_entries: &[GameLogEntry]) {
        if !events.is_empty() {
            for viewer in state.players.iter().map(|player| player.id).chain(std::iter::once(SPECTATOR)) {
                let filtered = filter_events_for_player(events, state, viewer);
                if filtered.is_empty() { continue; }
                let seen = self.events.entry(viewer).or_default();
                seen.extend(filtered);
                if seen.len() > TAIL_LIMIT {
                    seen.drain(..seen.len() - TAIL_LIMIT);
                }
            }
        }
        self.log_entries.extend(log_entries.iter()
            .filter(|entry| entry.presentation.visibility == engine::types::log::LogVisibility::Public)
            .cloned());
        if self.log_entries.len() > TAIL_LIMIT {
            self.log_entries.drain(..self.log_entries.len() - TAIL_LIMIT);
        }
    }
}

/// The game's identity on the wire. phase's client keeps it and checks every update against
/// it; a Yama game has one generation.
pub fn session_key(game_code: &str) -> FullSessionKey {
    FullSessionKey { game_code: game_code.to_string(), generation: 1 }
}

/// The first frame: who this server is. No binary envelopes, heartbeat contract or command
/// correlation are offered, so the client sends and expects plain JSON text.
pub fn hello() -> ServerMessage {
    ServerMessage::ServerHello {
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        build_commit: "yama".to_string(),
        protocol_version: PROTOCOL_VERSION,
        mode: ServerMode::Full,
        lobby_protocol_version: None,
        public_url: None,
        wire_formats: Vec::new(),
        heartbeat: None,
        command_correlation: None,
        state_codecs: Vec::new(),
        selected_state_codec: None,
    }
}

/// Everything one viewer is sent about the game as it stands.
struct Seen {
    is_actor: bool,
    filtered: GameState,
    legal_actions: Vec<GameAction>,
    decision: DecisionSnapshot,
}

fn seen(state: &GameState, viewer: PlayerId) -> Seen {
    let decision = DecisionSnapshot::from_state(state);
    let is_actor = viewer != SPECTATOR && is_acting(state, viewer);
    let legal_actions =
        if is_actor { with_viewer_actions(state, viewer, decision.legal_actions.clone()) } else { Vec::new() };
    Seen { is_actor, filtered: filter_state_for_player(state, viewer), legal_actions, decision }
}

/// phase-server's `GameStarted` for `viewer` (a seat, or [`SPECTATOR`]): sent when a board
/// attaches to a game already under way. `token` is the seat's reconnect token, echoed back.
/// The live host calls [`crate::Match::prepare_board`] before publishing Phase frames.
pub fn game_started(
    state: &GameState,
    viewer: PlayerId,
    names: &[String],
    revision: u64,
    game_code: &str,
    token: Option<String>,
) -> ServerMessage {
    let s = seen(state, viewer);
    let derived = derive_filtered_views(state, &s.filtered, (viewer != SPECTATOR).then_some(viewer));
    let viewer_interaction = derive_viewer_interaction(state, &s.filtered, viewer);
    ServerMessage::GameStarted {
        state_revision: revision,
        your_player: viewer,
        opponent_name: None,
        player_names: names.to_vec(),
        auto_pass_recommended: s.is_actor && auto_pass_recommended_for_viewer(state, viewer, &s.decision.legal_actions),
        end_continuous_effect_offers: if s.is_actor { end_continuous_effect_offers(&s.legal_actions) } else { Vec::new() },
        mana_payment_shortcut_actions: if s.is_actor {
            mana_payment_shortcut_actions(state, &s.decision.legal_actions_by_object)
        } else {
            Vec::new()
        },
        spell_costs: if s.is_actor { s.decision.spell_costs.clone() } else { HashMap::new() },
        legal_actions_by_object: if s.is_actor {
            object_action_payloads(&s.decision.legal_actions_by_object)
        } else {
            HashMap::new()
        },
        activation_block_reasons: if s.is_actor { activation_block_reasons_for_viewer(state, viewer) } else { HashMap::new() },
        legal_actions: s.legal_actions,
        state: s.filtered,
        derived,
        viewer_interaction,
        player_token: token,
        full_key: Some(session_key(game_code)),
        events: Vec::new(),
        rewind_targets: Vec::new(),
    }
}

/// phase-server's `StateUpdate` for `viewer`: the whole game as they may see it, and what
/// happened since the last one (filtered for them).
pub fn state_update(state: &GameState, viewer: PlayerId, revision: u64, game_code: &str, tail: &Tail) -> ServerMessage {
    let s = seen(state, viewer);
    let derived = derive_filtered_views(state, &s.filtered, (viewer != SPECTATOR).then_some(viewer));
    let viewer_interaction = derive_viewer_interaction(state, &s.filtered, viewer);
    // Events already carry their action-time projection. Re-filtering against
    // this later state could grant or revoke access to historical private data.
    let log_entries = tail.log_entries.clone();
    ServerMessage::StateUpdate {
        full_key: Some(session_key(game_code)),
        state_revision: revision,
        events: tail.events.get(&viewer).cloned().unwrap_or_default(),
        auto_pass_recommended: s.is_actor && auto_pass_recommended_for_viewer(state, viewer, &s.decision.legal_actions),
        end_continuous_effect_offers: end_continuous_effect_offers(&s.legal_actions),
        mana_payment_shortcut_actions: if s.is_actor {
            mana_payment_shortcut_actions(state, &s.decision.legal_actions_by_object)
        } else {
            Vec::new()
        },
        eliminated_players: state.eliminated_players.clone(),
        log_entries,
        spell_costs: if s.is_actor { s.decision.spell_costs.clone() } else { HashMap::new() },
        legal_actions_by_object: if s.is_actor {
            object_action_payloads(&s.decision.legal_actions_by_object)
        } else {
            HashMap::new()
        },
        activation_block_reasons: if s.is_actor { activation_block_reasons_for_viewer(state, viewer) } else { HashMap::new() },
        legal_actions: s.legal_actions,
        state: s.filtered,
        derived,
        viewer_interaction,
        rewind_targets: Vec::new(),
    }
}

/// Why a board's action is refused before the engine sees it: Yama games have no sandbox, and
/// phase's own size limits on client payloads apply.
pub fn screen(action: &GameAction) -> Result<(), String> {
    // Concessions must go through Match::concede, including its replay metadata,
    // controls cleanup and public announcement.
    if matches!(action, GameAction::Concede { .. }) {
        return Err("use Yama's concession message".into());
    }
    if matches!(
        action,
        GameAction::Debug(_) | GameAction::GrantDebugPermission { .. } | GameAction::RevokeDebugPermission { .. }
    ) {
        return Err("debug actions aren't allowed in Yama games".into());
    }
    server_core::game_action_payload_guard::guard_game_action_payload(action)
}
