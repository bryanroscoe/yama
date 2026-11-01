//! phase's own board on a Yama game (board.rs): what each viewer is sent, and the moves it sends.

use engine::types::actions::{DebugAction, GameAction, ResolveAllScope};
use engine::types::player::PlayerId;
use engine::types::game_state::{MulliganBottomEntry, OpeningHandBottomReason, WaitingFor};
use engine::types::interaction::{InteractionOpportunityResponse, InteractionResponse, InteractionSessionId, InteractionSubmission};
use engine::types::phase::Phase;
use engine::types::zones::Zone;
use engine::game::interaction::{bind_interaction_authority, resolve_interaction_response};
use server_core::session::DecisionSnapshot;

use crate::board::{self, SPECTATOR, ServerMessage};
use crate::{Engine, Match, SeatDeck};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/combat-cards.json")).unwrap()
}

/// Seat 0 plays Mountains; seat 1's hand and library are Grizzly Bears and Islands, so any of
/// those names in another viewer's frame is a leak.
fn game(e: &Engine) -> Match {
    let mountains = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
    let mut bears = vec!["Grizzly Bears".to_string(); 50];
    bears.extend(vec!["Island".to_string(); 49]);
    let bears = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: bears };
    let mut m = e.new_match_first(7, vec![mountains, bears], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    m
}

fn json(msg: &ServerMessage) -> String {
    serde_json::to_string(msg).unwrap()
}

fn batched_draw_uses_its_post_action_authority(was_controlled: bool) {
    use engine::types::events::GameEvent;
    use engine::types::game_state::ActionResult;
    let e = engine();
    let mut m = game(&e);
    // Visibility fixtures for two post-action snapshots: player 1 draws on
    // turn 3, then a later turn begins with different control authority.
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(1);
    m.state.phase = Phase::Draw;
    m.state.turn_decision_controller = was_controlled.then_some(PlayerId(0));
    m.state.priority_player = m.state.turn_decision_controller.unwrap_or(PlayerId(1));
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(1) };
    m.prepare_board().unwrap();
    m.take_board_tail();
    let drawn = m.state.players[1].hand[0];
    let draw = ActionResult::applied(vec![
        GameEvent::CardsDrawn { player_id: PlayerId(1), count: 1 },
        GameEvent::CardDrawn { player_id: PlayerId(1), object_id: drawn, nth_in_turn: 1, nth_in_step: 1 },
    ], m.state.waiting_for.clone());
    m.accepted(&draw, None);

    m.state.turn_number = 4;
    m.state.phase = Phase::Upkeep;
    m.state.turn_decision_controller = (!was_controlled).then_some(PlayerId(0));
    m.state.priority_player = m.state.turn_decision_controller.unwrap_or(PlayerId(1));
    let next_turn = ActionResult::applied(vec![
        GameEvent::TurnStarted { player_id: PlayerId(1), turn_number: 4 },
    ], m.state.waiting_for.clone());
    m.accepted(&next_turn, None);
    let tail = m.take_board_tail();
    for (viewer, may_see_draw) in [(PlayerId(0), was_controlled), (PlayerId(1), true), (SPECTATOR, false)] {
        let ServerMessage::StateUpdate { events, .. } = board::state_update(m.engine_state(), viewer, m.revision, "g", &tail) else { panic!("state update") };
        assert_eq!(events.iter().any(|event| matches!(event, GameEvent::CardDrawn { object_id, .. } if *object_id == drawn)), may_see_draw,
            "draw visibility must use the draw's post-action authority for {viewer:?}");
        assert!(matches!(events.first(), Some(GameEvent::CardsDrawn { count: 1, .. })));
        assert!(matches!(events.last(), Some(GameEvent::TurnStarted { turn_number: 4, .. })), "public events stay ordered");
    }
}

#[test]
fn batched_events_do_not_retroactively_grant_private_draw_access() {
    batched_draw_uses_its_post_action_authority(false);
}

#[test]
fn batched_events_keep_previously_authorized_private_draws() {
    batched_draw_uses_its_post_action_authority(true);
}

#[test]
fn batched_events_capture_starts_at_first_board_opening() {
    use engine::types::events::GameEvent;
    use engine::types::game_state::ActionResult;
    let e = engine();
    let mut m = game(&e);
    let action = ActionResult::applied(vec![GameEvent::CardsDrawn { player_id: PlayerId(0), count: 1 }], m.state.waiting_for.clone());
    m.accepted(&action, None);
    assert!(m.take_board_tail().is_empty(), "unused Phase boards keep no event projections");
    m.prepare_board().unwrap();
    m.accepted(&action, None);
    let tail = m.take_board_tail();
    for viewer in [PlayerId(0), PlayerId(1), SPECTATOR] {
        let ServerMessage::StateUpdate { events, .. } = board::state_update(m.engine_state(), viewer, m.revision, "g", &tail) else { panic!("state update") };
        assert!(matches!(events.as_slice(), [GameEvent::CardsDrawn { count: 1, .. }]));
    }
    assert!(m.take_board_tail().is_empty(), "a publication drains every viewer together");
}

#[test]
fn every_viewer_sees_only_what_they_may() {
    let e = engine();
    let mut m = game(&e);
    let tail = m.take_board_tail();
    let ana = json(&board::state_update(m.engine_state(), PlayerId(0), m.revision, "g", &tail));
    assert!(ana.contains("Mountain"), "Ana sees her own hand");
    assert!(!ana.contains("Grizzly Bears") && !ana.contains("Island"), "Ana must not see Ben's hand or library");
    let ben = json(&board::game_started(m.engine_state(), PlayerId(1), m.names(), m.revision, "g", None));
    assert!(ben.contains("Grizzly Bears") || ben.contains("Island"), "Ben sees his own hand");
    assert!(!ben.contains("Mountain"), "Ben must not see Ana's hand or library");
    let watcher = json(&board::state_update(m.engine_state(), SPECTATOR, m.revision, "g", &tail));
    for name in ["Mountain", "Grizzly Bears", "Island"] {
        assert!(!watcher.contains(name), "a watcher must not see {name} in a hand or library");
    }
}

#[test]
fn only_a_deciding_seat_gets_actions() {
    let e = engine();
    let m = game(&e);
    let deciding = m.waiting_on();
    assert!(!deciding.is_empty());
    for seat in 0..2u8 {
        let ServerMessage::StateUpdate { legal_actions, .. } =
            board::state_update(m.engine_state(), PlayerId(seat), m.revision, "g", &Default::default())
        else {
            panic!("a state update");
        };
        assert_eq!(!legal_actions.is_empty(), deciding.contains(&seat), "seat {seat}");
    }
    let ServerMessage::StateUpdate { legal_actions, legal_actions_by_object, spell_costs, .. } =
        board::state_update(m.engine_state(), SPECTATOR, m.revision, "g", &Default::default())
    else {
        panic!("a state update");
    };
    assert!(legal_actions.is_empty() && legal_actions_by_object.is_empty() && spell_costs.is_empty());
}

#[test]
fn a_board_move_is_logged_and_replays() {
    let e = engine();
    let mut m = game(&e);
    m.prepare_board().unwrap();
    let seat = m.waiting_on()[0];
    let action = DecisionSnapshot::from_state(m.engine_state()).legal_actions.into_iter().next().expect("an action");
    let (before, logged) = (m.revision, m.actions_logged());
    m.submit(seat, action).unwrap();
    assert!(m.revision > before);
    assert_eq!(m.actions_logged(), logged + 1);
    // What happened goes to the board once.
    m.take_board_tail();
    let again = m.take_board_tail();
    assert!(again.is_empty());
    let resumed = e.resume(&m.replay_json(), &[]).unwrap();
    assert_eq!(resumed.actions_logged(), m.actions_logged());
    assert_eq!(serde_json::to_value(&resumed.engine_state().waiting_for).unwrap(), serde_json::to_value(&m.engine_state().waiting_for).unwrap());
}

#[test]
fn a_board_cannot_cheat() {
    let e = engine();
    let mut m = game(&e);
    let logged = m.actions_logged();
    assert!(m.submit(0, GameAction::Debug(DebugAction::RunStateBasedActions)).is_err());
    assert!(m.submit(0, GameAction::GrantDebugPermission { player_id: PlayerId(0) }).is_err());
    // Someone not deciding can't act (only their own settings, which change nothing in the game).
    if let Some(idle) = (0..2u8).find(|s| !m.waiting_on().contains(s)) {
        assert!(m.submit(idle, GameAction::PassPriority).is_err());
    }
    assert_eq!(m.actions_logged(), logged);
}

#[test]
fn concessions_use_yamas_bookkeeping_and_replay_identically() {
    let e = engine();
    let mut m = game(&e);
    let seat = m.waiting_on()[0];
    m.set_full_control(seat, true);
    assert!(m.controls.contains_key(&seat));
    let before = m.replay_json();
    assert!(m.submit(seat, GameAction::Concede { player_id: PlayerId(seat) }).is_err());
    assert_eq!(m.replay_json(), before);
    assert!(!m.view(None).players.iter().find(|p| p.seat == seat).unwrap().conceded);

    m.concede(seat).unwrap();
    let resumed = e.resume(&m.replay_json(), &[]).unwrap();
    assert!(m.view(None).players.iter().find(|p| p.seat == seat).unwrap().conceded);
    let conceded = |m: &Match| m.view(None).players.iter().map(|p| (p.seat, p.conceded)).collect::<Vec<_>>();
    assert_eq!(conceded(&m), conceded(&resumed));
    assert!(!m.controls.contains_key(&seat));
    assert!(m.log_lines().iter().any(|line| line.text.contains("conceded")));
}

fn controlled_turn(e: &Engine) -> Match {
    let mut m = game(e);
    m.state.turn_number = 3;
    m.state.phase = Phase::PreCombatMain;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(1);
    m.state.turn_decision_controller = Some(PlayerId(1));
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    bind_interaction_authority(&mut m.state, InteractionSessionId("controlled-board".into())).unwrap();
    m
}

#[test]
fn a_turn_controller_can_submit_a_raw_move_for_the_controlled_player() {
    let e = engine();
    let mut m = controlled_turn(&e);
    let ServerMessage::StateUpdate { legal_actions, .. } =
        board::state_update(m.engine_state(), PlayerId(1), m.revision, "g", &Default::default())
    else { panic!("a state update") };
    let action = legal_actions.into_iter().find(|a| matches!(a, GameAction::PlayLand { .. })).expect("the controller is offered a land play");
    let GameAction::PlayLand { object_id, .. } = &action else { unreachable!() };
    let object_id = *object_id;
    let before = serde_json::to_value(m.engine_state()).unwrap();
    let logged = m.actions_logged();
    assert!(m.submit(0, action.clone()).is_err(), "the controlled player cannot submit");
    assert_eq!(serde_json::to_value(m.engine_state()).unwrap(), before);
    assert_eq!(m.actions_logged(), logged);
    m.submit(1, action).unwrap();
    let land = &m.state.objects[&object_id];
    assert_eq!((land.zone, land.controller), (Zone::Battlefield, PlayerId(0)), "the action belongs to the controlled player");
    assert_eq!(m.actions_logged(), logged + 1);
}

#[test]
fn a_turn_controller_can_submit_an_opaque_interaction_for_the_controlled_player() {
    let e = engine();
    let mut m = controlled_turn(&e);
    let ServerMessage::StateUpdate { viewer_interaction, .. } =
        board::state_update(m.engine_state(), PlayerId(1), m.revision, "g", &Default::default())
    else { panic!("a state update") };
    let (submission, object_id) = viewer_interaction.opportunities.iter().find_map(|opportunity| {
        let InteractionOpportunityResponse::ExactChoices { choices } = &opportunity.response else { return None };
        choices.iter().find_map(|choice| {
            let submission = InteractionSubmission {
                interaction_id: opportunity.interaction_id.clone(),
                response: InteractionResponse::Choose { choice_id: choice.id.clone() },
            };
            match resolve_interaction_response(&m.state, PlayerId(1), &submission).ok()? {
                GameAction::PlayLand { object_id, .. } => Some((submission, object_id)),
                _ => None,
            }
        })
    }).expect("the controller is offered a land-play interaction");
    let before = serde_json::to_value(m.engine_state()).unwrap();
    let logged = m.actions_logged();
    assert!(m.submit_interaction(0, submission.clone()).is_err(), "the controlled player cannot use the controller's capability");
    assert_eq!(serde_json::to_value(m.engine_state()).unwrap(), before);
    assert_eq!(m.actions_logged(), logged);
    assert!(matches!(m.submit_interaction_action(1, submission).unwrap(), GameAction::PlayLand { .. }));
    let land = &m.state.objects[&object_id];
    assert_eq!((land.zone, land.controller), (Zone::Battlefield, PlayerId(0)));
    assert_eq!(m.actions_logged(), logged + 1);
}

fn simultaneous_controlled_decisions(e: &Engine, count: u8, reverse: bool) -> Match {
    let mut m = game(e);
    m.state.active_player = PlayerId(0);
    m.state.turn_decision_controller = Some(PlayerId(1));
    let mut pending = vec![MulliganBottomEntry { player: PlayerId(0), count }, MulliganBottomEntry { player: PlayerId(1), count }];
    if reverse { pending.reverse(); }
    // Exercise the engine's simultaneous-slot contract, including restored
    // state with one actor authorized for multiple owners.
    m.state.waiting_for = WaitingFor::OpeningHandBottomCards { pending, reason: OpeningHandBottomReason::TinyLeadersMultiCommander };
    bind_interaction_authority(&mut m.state, InteractionSessionId("multiple-board-owners".into())).unwrap();
    m
}

#[test]
fn raw_actions_select_the_matching_owner_independently_of_pending_order() {
    let e = engine();
    for reverse in [false, true] {
        for owner in 0..2usize {
            let mut m = simultaneous_controlled_decisions(&e, 1, reverse);
            let object_id = m.state.players[owner].hand[0];
            let other_hand = m.state.players[1 - owner].hand.clone();
            let logged = m.actions_logged();
            m.submit(1, GameAction::SelectCards { cards: vec![object_id] }).unwrap();
            assert!(!m.state.players[owner].hand.contains(&object_id));
            assert_eq!(m.state.players[owner].library.back(), Some(&object_id));
            assert_eq!(m.state.players[1 - owner].hand, other_hand);
            let WaitingFor::OpeningHandBottomCards { pending, .. } = &m.state.waiting_for else { panic!("one decision remains") };
            assert_eq!(pending.iter().map(|entry| entry.player).collect::<Vec<_>>(), vec![PlayerId((1 - owner) as u8)]);
            assert_eq!(m.actions_logged(), logged + 1);
        }
    }
}

#[test]
fn ambiguous_raw_actions_preserve_state_and_an_opaque_id_selects_the_owner() {
    let e = engine();
    let mut m = simultaneous_controlled_decisions(&e, 0, false);
    let interaction_id = m.state.active_interaction_slots.iter().find(|slot| slot.semantic_owner == 1).unwrap().interaction_id.clone();
    let before = serde_json::to_value(m.engine_state()).unwrap();
    let logged = m.actions_logged();
    assert!(m.submit(1, GameAction::SelectCards { cards: vec![] }).is_err(), "a raw payload naming neither slot is ambiguous");
    assert_eq!(serde_json::to_value(m.engine_state()).unwrap(), before);
    assert_eq!(m.actions_logged(), logged);
    m.submit_interaction(1, InteractionSubmission { interaction_id, response: InteractionResponse::Select { choice_ids: vec![] } }).unwrap();
    let WaitingFor::OpeningHandBottomCards { pending, .. } = &m.state.waiting_for else { panic!("one decision remains") };
    assert_eq!(pending.iter().map(|entry| entry.player).collect::<Vec<_>>(), vec![PlayerId(0)]);
    assert_eq!(m.actions_logged(), logged + 1);
}

#[test]
fn an_off_prompt_grantor_can_revoke_only_their_own_consent() {
    let e = engine();
    for opaque in [false, true] {
        let mut m = controlled_turn(&e);
        m.state.turn_decision_controller = None;
        m.state.priority_player = PlayerId(0);
        bind_interaction_authority(&mut m.state, InteractionSessionId("board-consent".into())).unwrap();
        m.submit(0, GameAction::BeginResolveAll { max_resolutions: 1, scope: ResolveAllScope::Shared }).unwrap();
        let WaitingFor::ResolveAllConsent { epoch, representative: PlayerId(1) } = m.state.waiting_for else { panic!("the other player is asked for consent") };
        assert!(!server_core::is_acting(&m.state, PlayerId(0)), "the grantor is off prompt");
        let revoke = GameAction::RevokeResolveAllConsent { epoch, representative: PlayerId(0) };
        let ServerMessage::StateUpdate { viewer_interaction, .. } =
            board::state_update(m.engine_state(), PlayerId(0), m.revision, "g", &Default::default())
        else { panic!("a state update") };
        let submission = viewer_interaction.opportunities.iter().find_map(|opportunity| {
            let InteractionOpportunityResponse::ExactChoices { choices } = &opportunity.response else { return None };
            choices.iter().find_map(|choice| {
                let submission = InteractionSubmission { interaction_id: opportunity.interaction_id.clone(), response: InteractionResponse::Choose { choice_id: choice.id.clone() } };
                (resolve_interaction_response(&m.state, PlayerId(0), &submission).ok()? == revoke).then_some(submission)
            })
        }).expect("the engine offers the grantor a revoke capability");
        let before = serde_json::to_value(m.engine_state()).unwrap();
        let logged = m.actions_logged();
        let refused = if opaque { m.submit_interaction(1, submission.clone()) } else { m.submit(1, revoke.clone()) };
        assert!(refused.is_err(), "another seat cannot use the grantor's authority");
        assert_eq!(serde_json::to_value(m.engine_state()).unwrap(), before);
        assert_eq!(m.actions_logged(), logged);
        if opaque { m.submit_interaction(0, submission).unwrap(); } else { m.submit(0, revoke).unwrap(); }
        assert!(m.state.resolve_all_consent_run.is_none());
        assert!(matches!(m.state.waiting_for, WaitingFor::Priority { player: PlayerId(0) }));
        assert_eq!(m.actions_logged(), logged + 1);
    }
}
