//! The event feed per viewer (feed.rs): what each seat and spectator is told, and what they never
//! are. Boards are set up straight in the engine's state (as view_tests.rs does); cards then move
//! through the engine's own debug actions and state-based actions, so the events are the engine's.

use engine::game::deck_loading::create_object_from_card_face;
use engine::game::filter_state_for_viewer;
use engine::game::sba::check_state_based_actions;
use engine::types::ability::TargetRef;
use engine::types::actions::{DebugAction, GameAction};
use engine::types::events::{GameEvent, LifeTotalReading};
use engine::types::game_state::CommanderDamageEntry;
use engine::types::identifiers::{CardId, ObjectId};
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

use crate::feed::{Hit, How, Seen, What, Why};
use crate::{Difficulty, Engine, Match, SeatDeck};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/combat-cards.json")).unwrap()
}

/// Distinct names in the library, so a drawn card's name can't come from anywhere else.
fn deck() -> SeatDeck {
    let spells = ["Grizzly Bears", "Lightning Bolt", "Pacifism", "Raging Goblin", "Typhoid Rats", "Raise the Alarm", "Glorybringer", "Boggart Brute"];
    let mut main: Vec<String> = Vec::new();
    for i in 0..99 {
        main.push(if i % 3 == 0 { spells[i / 3 % spells.len()].to_string() } else { "Mountain".to_string() });
    }
    SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main }
}

fn game(e: &Engine, seats: usize) -> Match {
    let mut m = e.new_match_first(7, vec![deck(); seats], &[], Some(0)).unwrap();
    m.set_names((0..seats).map(|i| format!("P{i}")).collect());
    m
}

/// A card made in `seat`'s library and moved by hand to `zone` (no events: board set-up).
fn card(m: &mut Match, e: &Engine, name: &str, seat: u8, zone: Zone) -> ObjectId {
    let face = e.database().get_face_by_name(name).unwrap_or_else(|| panic!("{name} isn't in the fixture"));
    let id = create_object_from_card_face(&mut m.state, face, PlayerId(seat));
    let p = &mut m.state.players[usize::from(seat)];
    p.library.retain(|c| *c != id);
    match zone {
        Zone::Battlefield => m.state.battlefield.push_back(id),
        Zone::Hand => p.hand.push_back(id),
        Zone::Graveyard => p.graveyard.push_back(id),
        Zone::Exile => m.state.exile.push_back(id),
        Zone::Library => p.library.push_back(id),
        _ => unreachable!(),
    }
    let o = m.state.objects.get_mut(&id).unwrap();
    o.zone = zone;
    o.controller = PlayerId(seat);
    id
}

fn record(m: &mut Match, events: &[GameEvent]) {
    let conceded = m.conceded.clone();
    m.feed.record(events, &m.state, &conceded);
}

/// One of the engine's debug actions (a sandbox move, draw or reveal through its real pipeline),
/// taken as any action is: its events go to the feed.
fn debug(m: &mut Match, action: DebugAction) -> Vec<GameEvent> {
    let result = apply_debug(m, action);
    m.accepted(&result, None);
    result.events
}

fn apply_debug(m: &mut Match, action: DebugAction) -> engine::types::game_state::ActionResult {
    m.state.debug_mode = true;
    let result = engine::game::engine::apply(&mut m.state, PlayerId(0), GameAction::Debug(action)).expect("debug action");
    m.state.debug_mode = false;
    result
}

fn move_to(m: &mut Match, id: ObjectId, zone: Zone) -> Vec<GameEvent> {
    debug(m, DebugAction::MoveToZone { object_id: id, to_zone: zone, library_position: None, simulate: false })
}

/// The `What`s `viewer` was told, without their numbering.
fn told(m: &Match, viewer: Option<u8>) -> Vec<What> {
    m.events(viewer).into_iter().map(|h| h.what).collect()
}

fn every_seen(w: &What) -> Vec<Seen> {
    let mut out = vec![];
    match w {
        What::Cast { card, .. } | What::Land { card, .. } | What::Activated { card, .. } | What::Token { card, .. } | What::Counters { card, .. } | What::Control { card, .. } | What::Transformed { card } => out.push(card.clone()),
        What::Moved { card, by, .. } => out.extend([Some(card.clone()), by.clone()].into_iter().flatten()),
        What::Damage { source, to, .. } => {
            out.push(source.clone());
            if let Hit::Card { card } = to {
                out.push(card.clone());
            }
        }
        What::Attack { attacks, .. } => out.extend(attacks.iter().map(|a| a.card.clone())),
        What::Block { blocks, .. } => out.extend(blocks.iter().flatten().cloned()),
        What::Revealed { cards, .. } | What::Looked { cards, .. } | What::Drew { cards, .. } => out.extend(cards.iter().cloned()),
        _ => {}
    }
    out
}

#[test]
fn a_move_keeps_the_engines_reason_and_drops_the_id_into_a_hidden_zone() {
    let e = engine();
    let mut m = game(&e, 2);
    let bears = card(&mut m, &e, "Grizzly Bears", 1, Zone::Battlefield);
    let goblin = card(&mut m, &e, "Raging Goblin", 1, Zone::Battlefield);
    m.state.turn_number = 5;

    // Destroyed by lethal damage: the engine's state-based action (CR 704.5g).
    m.state.objects.get_mut(&bears).unwrap().damage_marked = 2;
    let mut events = vec![];
    check_state_based_actions(&mut m.state, &mut events);
    assert!(events.iter().any(|e| matches!(e, GameEvent::CreatureDestroyed { object_id, source_id: None } if *object_id == bears)), "{events:?}");
    record(&mut m, &events);
    // Bounced: back to its owner's hand.
    move_to(&mut m, goblin, Zone::Hand);

    for viewer in [Some(0), Some(1), None] {
        let moves: Vec<What> = told(&m, viewer).into_iter().filter(|w| matches!(w, What::Moved { .. })).collect();
        assert_eq!(moves.len(), 2, "{viewer:?}: {moves:?}");
        let What::Moved { card, how, to, from, creature, owner, .. } = &moves[0] else { unreachable!() };
        assert_eq!((card.name.as_deref(), card.id, *how, *to, *from, *creature, *owner), (Some("Grizzly Bears"), Some(bears.0), How::Destroyed, "graveyard", Some("battlefield"), true, 1));
        // Into a hand: everyone saw it leave the battlefield, so it's named, but only its owner
        // keeps the id to follow it.
        let What::Moved { card, to, .. } = &moves[1] else { unreachable!() };
        assert_eq!((card.name.as_deref(), *to), (Some("Raging Goblin"), "hand"));
        assert_eq!(card.id, (viewer == Some(1)).then_some(goblin.0), "{viewer:?}");
    }
    // Milled: library to graveyard is public (CR 701.17c). The sandbox mill moves the card
    // without the engine's `Milled` event, which a real mill sends beside the move.
    let top = m.state.players[1].library[0];
    let milled = m.state.objects[&top].name.clone();
    let mut events = apply_debug(&mut m, DebugAction::Mill { player_id: PlayerId(1), count: 1 }).events;
    events.push(GameEvent::Milled { player_id: PlayerId(1), object_id: top, to: Zone::Graveyard });
    record(&mut m, &events);
    for viewer in [Some(0), Some(1), None] {
        let last = told(&m, viewer).into_iter().rev().find(|w| matches!(w, What::Moved { .. })).unwrap();
        let What::Moved { card, how, from, to, .. } = last else { unreachable!() };
        assert_eq!((card.name, card.id, how, from, to), (Some(milled.clone()), Some(top.0), How::Milled, Some("library"), "graveyard"), "{viewer:?}");
    }
    // The graveyard card says how it got there, for everyone.
    for viewer in [Some(0), Some(1), None] {
        let v = m.view(viewer);
        let came = v.players[1].graveyard.iter().find(|c| c.id == bears.0).unwrap().came.unwrap();
        assert_eq!((came.turn, came.how, came.from), (5, How::Destroyed, Some("battlefield")));
    }
}

#[test]
fn a_hidden_move_is_told_to_nobody_and_a_face_down_card_stays_unnamed() {
    let e = engine();
    let mut m = game(&e, 2);
    // A card from seat 1's hand onto its library: neither side is public.
    let hidden = card(&mut m, &e, "Glorybringer", 1, Zone::Hand);
    move_to(&mut m, hidden, Zone::Library);
    for viewer in [Some(0), Some(1), None] {
        assert!(!told(&m, viewer).iter().flat_map(every_seen).any(|s| s.name.as_deref() == Some("Glorybringer")), "{viewer:?}");
    }

    // A foretold card, face down in exile: its owner may look at it (CR 702.143a), nobody else.
    let foretold = card(&mut m, &e, "Lightning Bolt", 0, Zone::Exile);
    let o = m.state.objects.get_mut(&foretold).unwrap();
    o.face_down = true;
    o.foretold = true;
    let mine = m.view(Some(0)).exile.into_iter().find(|c| c.id == foretold.0).unwrap();
    assert_eq!((mine.name.as_str(), mine.face_down), ("Lightning Bolt", true));
    for viewer in [Some(1), None] {
        let theirs = m.view(viewer).exile.into_iter().find(|c| c.id == foretold.0).unwrap();
        assert_eq!((theirs.name.as_str(), theirs.face_down), ("Face-down card", true), "{viewer:?}");
    }
}

#[test]
fn draws_are_named_only_for_the_player_drawing() {
    let e = engine();
    let mut m = game(&e, 2);
    let top = m.state.players[1].library[0];
    let name = m.state.objects[&top].name.clone();
    // The engine's real draw (CR 121.1).
    let events = debug(&mut m, DebugAction::DrawCards { player_id: PlayerId(1), count: 1 });
    assert!(events.iter().any(|e| matches!(e, GameEvent::CardDrawn { object_id, .. } if *object_id == top)), "{events:?}");
    let drew = |viewer: Option<u8>| told(&m, viewer).into_iter().find(|w| matches!(w, What::Drew { .. })).unwrap();
    let What::Drew { seat, count, cards } = drew(Some(1)) else { unreachable!() };
    assert_eq!((seat, count, cards.len()), (1, 1, 1));
    assert_eq!((cards[0].name.as_deref(), cards[0].id), (Some(name.as_str()), Some(top.0)));
    for viewer in [Some(0), None] {
        assert_eq!(drew(viewer), What::Drew { seat: 1, count: 1, cards: vec![] }, "{viewer:?}");
        // Nothing else they were told names or points at it.
        assert!(!told(&m, viewer).iter().flat_map(every_seen).any(|s| s.id == Some(top.0) || s.name.as_deref() == Some(name.as_str())), "{viewer:?}");
    }
    // Counted for the game's numbers either way.
    assert_eq!(m.feed.stats(&m.state).seats[1].drew, 1);
}

#[test]
fn reveals_go_to_everyone_and_a_private_look_only_to_the_seat_looking() {
    let e = engine();
    let mut m = game(&e, 3);
    let a = card(&mut m, &e, "Glorybringer", 2, Zone::Hand);
    let b = card(&mut m, &e, "Pacifism", 2, Zone::Hand);

    // Seat 2 reveals its hand (Duress-style): names for everyone, but no ids to follow the
    // cards back into the hand.
    let reveal = GameEvent::CardsRevealed { player: PlayerId(2), card_ids: vec![a, b], card_names: vec!["Glorybringer".into(), "Pacifism".into()] };
    record(&mut m, &[reveal]);
    for viewer in [Some(0), Some(1), Some(2), None] {
        let shown = told(&m, viewer).into_iter().find(|w| matches!(w, What::Revealed { .. })).unwrap();
        let What::Revealed { seat, cards } = shown else { unreachable!() };
        assert_eq!(seat, 2);
        assert_eq!(cards.iter().map(|c| (c.name.as_deref(), c.id)).collect::<Vec<_>>(), [(Some("Glorybringer"), None), (Some("Pacifism"), None)]);
    }

    // The top of a library revealed by the engine (CR 701.20a): named for all, never located.
    let top = m.state.players[1].library[0];
    let name = m.state.objects[&top].name.clone();
    debug(&mut m, DebugAction::Reveal { player_id: PlayerId(1), count: 1 });
    for viewer in [Some(0), Some(1), Some(2), None] {
        let last = told(&m, viewer).into_iter().rev().find(|w| matches!(w, What::Revealed { .. })).unwrap();
        assert_eq!(last, What::Revealed { seat: 1, cards: vec![Seen { id: None, name: Some(name.clone()), face_down: false }] }, "{viewer:?}");
    }

    // Seat 0 looks at seat 2's hand (Peek-style, CR 701.20e): only seat 0 is told, once.
    m.state.private_look_player = Some(PlayerId(0));
    m.state.private_look_ids = vec![a, b];
    record(&mut m, &[]);
    record(&mut m, &[]);
    let looks = |viewer: Option<u8>| told(&m, viewer).into_iter().filter(|w| matches!(w, What::Looked { .. })).collect::<Vec<_>>();
    assert_eq!(looks(Some(0)).len(), 1);
    let What::Looked { seat, whose, cards } = &looks(Some(0))[0] else { unreachable!() };
    assert_eq!((*seat, *whose), (0, Some(2)));
    assert_eq!(cards.iter().map(|c| c.name.as_deref()).collect::<Vec<_>>(), [Some("Glorybringer"), Some("Pacifism")]);
    for viewer in [Some(1), Some(2), None] {
        assert!(looks(viewer).is_empty(), "{viewer:?}");
    }
}

#[test]
fn damage_reads_with_the_life_it_cost_and_runs_fold_into_one_line() {
    let e = engine();
    let mut m = game(&e, 2);
    let bears = card(&mut m, &e, "Grizzly Bears", 0, Zone::Battlefield);
    let rats = card(&mut m, &e, "Typhoid Rats", 1, Zone::Battlefield);
    m.state.players[1].life = 38;
    let events = vec![
        GameEvent::SpellCast { card_id: CardId(0), controller: PlayerId(0), object_id: bears, cast_mana_value: None },
        // The engine reports the life lost just before the damage that caused it.
        GameEvent::LifeChanged { player_id: PlayerId(1), amount: -2, new_total: LifeTotalReading(Some(38)) },
        GameEvent::DamageDealt { source_id: bears, target: TargetRef::Player(PlayerId(1)), amount: 2, is_combat: true, excess: 0, source_incarnation: None },
        GameEvent::DamageDealt { source_id: rats, target: TargetRef::Object(bears), amount: 1, is_combat: true, excess: 0, source_incarnation: None },
        GameEvent::CounterAdded { object_id: bears, counter_type: engine::types::counter::CounterType::Plus1Plus1, count: 1, actor: PlayerId(0) },
        GameEvent::CounterAdded { object_id: bears, counter_type: engine::types::counter::CounterType::Plus1Plus1, count: 1, actor: PlayerId(0) },
    ];
    record(&mut m, &events);
    let lines = told(&m, Some(0));
    assert!(!lines.iter().any(|w| matches!(w, What::Life { .. })), "the life change folds into the damage: {lines:?}");
    let damage: Vec<&What> = lines.iter().filter(|w| matches!(w, What::Damage { .. })).collect();
    assert_eq!(damage.len(), 2);
    let What::Damage { source, by, to, amount, combat, life } = damage[0] else { unreachable!() };
    assert_eq!((source.name.as_deref(), *by, to, *amount, *combat, *life), (Some("Grizzly Bears"), Some(0), &Hit::Player { seat: 1 }, 2, true, Some([40, 38])));
    let counters: Vec<&What> = lines.iter().filter(|w| matches!(w, What::Counters { .. })).collect();
    assert_eq!(counters.len(), 1);
    assert!(matches!(counters[0], What::Counters { counter, delta: 2, .. } if counter == "plus1plus1"));
    let stats = m.feed.stats(&m.state);
    assert_eq!((stats.seats[0].spells, stats.seats[0].damage, stats.seats[1].damage), (1, 2, 0));
}

#[test]
fn a_knockout_carries_its_cause_and_the_leaving_sweep_stays_out() {
    let e = engine();
    let mut m = game(&e, 4);
    let commander = *m.state.command_zone.iter().find(|id| m.state.objects[*id].owner == PlayerId(0)).unwrap();
    // Seat 1 at 0 life, seat 2 at 21 commander damage from seat 0's commander, seat 3 poisoned.
    m.state.players[1].life = 0;
    m.state.commander_damage.push(CommanderDamageEntry { player: PlayerId(2), commander, damage: 21 });
    let mut events = vec![];
    check_state_based_actions(&mut m.state, &mut events);
    record(&mut m, &events);
    let outs = m.outs().to_vec();
    assert_eq!(outs.len(), 2, "{outs:?}");
    let by_seat = |s: u8| outs.iter().find(|o| o.seat == s).unwrap().clone();
    assert_eq!((by_seat(1).why, by_seat(1).inferred), (Why::Life { life: 0 }, true));
    assert_eq!(by_seat(2).why, Why::Commander { name: "Combat Celebrant".into(), seat: 0, damage: 21 });
    assert!(by_seat(2).inferred);
    // Both went out in the same moment.
    assert_eq!(by_seat(1).batch, by_seat(2).batch);
    for viewer in [Some(0), Some(1), Some(3), None] {
        let lines = told(&m, viewer);
        assert!(lines.contains(&What::Out { seat: 1 }) && lines.contains(&What::Out { seat: 2 }), "{viewer:?}");
        // Their libraries and hands leaving the game aren't narrated card by card...
        assert!(!lines.iter().any(|w| matches!(w, What::Moved { owner: 1 | 2, to: "exile", .. })), "{viewer:?}: {lines:?}");
        // ...but a card of theirs left in exile says why it's there.
        let gone: Vec<_> = m.view(viewer).exile.into_iter().filter(|c| c.owner == 1).collect();
        assert!(!gone.is_empty());
        assert!(gone.iter().all(|c| c.came.is_some_and(|came| came.how == How::Left)), "{viewer:?}");
    }

    // A concession is Yama's own record, not a reading of the board.
    m.concede(3).unwrap();
    let out = m.outs().iter().find(|o| o.seat == 3).unwrap().clone();
    assert_eq!((out.why, out.inferred), (Why::Conceded, false));
    assert!(m.is_over());
    let v = m.view(Some(0));
    assert_eq!(v.winner, Some(0));
    assert!(v.events.iter().any(|h| h.what == What::Over { winner: Some(0) }));
    let stats = v.stats.expect("stats once it's over");
    assert_eq!(stats.seats.len(), 4);
    assert_eq!(stats.seats[0].commander_damage, 21);
}

#[test]
fn two_players_out_at_once_draw_the_game() {
    let e = engine();
    let mut m = game(&e, 2);
    m.state.players[0].life = 0;
    m.state.players[1].life = -2;
    let mut events = vec![];
    check_state_based_actions(&mut m.state, &mut events);
    record(&mut m, &events);
    assert_eq!(m.state.game_end.as_ref().map(|g| g.winner), Some(None));
    assert!(told(&m, None).contains(&What::Over { winner: None }));
    let outs = m.outs();
    assert_eq!(outs.len(), 2);
    assert_eq!(outs[0].batch, outs[1].batch);
    assert_eq!(outs.iter().find(|o| o.seat == 1).unwrap().why, Why::Life { life: -2 });
}

/// Nothing in `viewer`'s happenings after `from` points at a card `viewer` can't identify now, or
/// names someone else's draw or private look.
fn ids_are_visible(m: &Match, viewer: Option<u8>, from: u64) {
    let vs = match viewer {
        Some(seat) => filter_state_for_viewer(&m.state, PlayerId(seat)),
        None => engine::game::visibility::filter_state_for_unseated_viewer(&m.state),
    };
    for h in m.events(viewer).iter().filter(|h| h.seq > from) {
        for s in every_seen(&h.what) {
            let Some(id) = s.id else { continue };
            if let Some(o) = vs.objects.get(&ObjectId(id)) {
                assert_ne!(o.name, "Hidden Card", "{viewer:?} is pointed at a card it can't see: {h:?}");
            }
        }
        if let What::Drew { seat, cards, .. } = &h.what {
            assert!(viewer == Some(*seat) || cards.is_empty(), "{viewer:?} was told what seat {seat} drew: {h:?}");
        }
        if let What::Looked { seat, .. } = &h.what {
            assert_eq!(viewer, Some(*seat));
        }
    }
}

#[test]
fn an_ai_game_tells_nobody_what_they_may_not_see_and_resumes_with_the_same_feed() {
    let e = Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/combat-cards.json")).unwrap();
    let ai = [(0, Difficulty::Easy), (1, Difficulty::Easy), (2, Difficulty::Easy)];
    let mut m = e.new_match_first(11, vec![deck(); 3], &ai, Some(0)).unwrap();
    m.set_ai_fallback(true);
    let viewers = [Some(0), Some(1), Some(2), None];
    let mut last = 0u64;
    for _ in 0..250 {
        if m.is_over() || m.run_ai(1).unwrap_or(0) == 0 {
            break;
        }
        for viewer in viewers {
            ids_are_visible(&m, viewer, last);
        }
        last = viewers.iter().filter_map(|v| m.events(*v).last().map(|h| h.seq)).max().unwrap_or(last);
    }
    assert!(m.turn() >= 3, "the game should get a few turns in (turn {})", m.turn());
    let mine = m.events(Some(0));
    assert!(mine.iter().any(|h| matches!(h.what, What::Turn { .. })));
    assert!(mine.iter().any(|h| matches!(&h.what, What::Drew { seat: 0, cards, .. } if !cards.is_empty())), "seat 0 sees its own draws");
    assert!(m.events(Some(1)).iter().any(|h| matches!(&h.what, What::Drew { seat: 0, cards, .. } if cards.is_empty())), "seat 1 sees seat 0 draw, unnamed");

    // A restart replays the log: the same feed, knockouts and numbers come back.
    let back = e.resume(&m.replay_json(), &ai).unwrap();
    for viewer in [Some(0), Some(1), Some(2), None] {
        assert_eq!(back.events(viewer), m.events(viewer), "{viewer:?}");
    }
    assert_eq!(back.outs(), m.outs());
    assert_eq!(back.feed.stats(&back.state), m.feed.stats(&m.state));
}
