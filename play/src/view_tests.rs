//! The board's stack, targeting and combat facts (docs/game-interactions-review-2026-10-23.md,
//! build plan sections 4 and 5), on exact boards: cards from tests/fixtures/combat-cards.json (a
//! slice of phase's card data) put straight onto the battlefield, then the engine's own prompt.

use engine::game::combat::{AttackTarget, CombatState, build_declare_attackers_waiting_for, build_declare_blockers_waiting_for};
use engine::game::deck_loading::create_object_from_card_face;
use engine::game::filter_state_for_viewer;
use engine::game::layers::evaluate_layers;
use engine::types::ability::TargetRef;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

use crate::act::{Act, Answer, Kind};
use crate::{AttackAt, ChoiceError, Engine, Match, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/combat-cards.json")).unwrap()
}

/// A two-seat game with `cards` (name, controller) on the battlefield, none of them summoning
/// sick, at seat 0's turn 3 in `phase`. Nothing else is set up: callers put the engine's prompt in.
fn board(e: &Engine, cards: &[(&str, u8)], phase: Phase) -> (Match, Vec<ObjectId>) {
    let deck = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
    let mut m = e.new_match_first(1, vec![deck.clone(), deck], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    let ids = cards
        .iter()
        .map(|(name, seat)| {
            let face = e.database().get_face_by_name(name).unwrap_or_else(|| panic!("{name} isn't in the fixture"));
            let id = create_object_from_card_face(&mut m.state, face, PlayerId(*seat));
            onto_battlefield(&mut m, id, *seat);
            let o = m.state.objects.get_mut(&id).unwrap();
            o.summoning_sick = false;
            o.controller = PlayerId(*seat);
            id
        })
        .collect();
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = phase;
    (m, ids)
}

/// Move a card the engine just made (in its owner's library) onto the battlefield, as a test
/// sets a board up: no entry effects (phase keeps its zone moves to itself outside tests).
fn onto_battlefield(m: &mut Match, id: ObjectId, seat: u8) {
    m.state.players[usize::from(seat)].library.retain(|c| *c != id);
    m.state.battlefield.push_back(id);
    m.state.objects.get_mut(&id).unwrap().zone = Zone::Battlefield;
}

/// `board` at seat 0's declare-attackers step, with the engine's prompt.
fn attacking(e: &Engine, cards: &[(&str, u8)]) -> (Match, Vec<ObjectId>) {
    let (mut m, ids) = board(e, cards, Phase::DeclareAttackers);
    m.state.combat = Some(CombatState::default());
    m.state.waiting_for = build_declare_attackers_waiting_for(&m.state);
    m.remark(None);
    (m, ids)
}

#[test]
fn a_target_in_a_hidden_zone_is_only_a_card() {
    let e = engine();
    let (m, ids) = board(&e, &[("Grizzly Bears", 1)], Phase::PreCombatMain);
    let theirs_in_library = m.state.players[1].library[0];
    let theirs_in_hand = m.state.players[1].hand[0];
    let mine_in_hand = m.state.players[0].hand[0];
    let vs = filter_state_for_viewer(&m.state, PlayerId(0));
    let seen = |id: ObjectId| m.stack_target(&vs, &TargetRef::Object(id), Some(0), false);

    // A permanent: its id, name and controller.
    let bear = seen(ids[0]);
    assert_eq!(bear.target, Some(TargetView::Object { id: ids[0].0 }));
    assert_eq!((bear.name.as_str(), bear.controller), ("Grizzly Bears", Some(1)));
    // A player: named.
    let ben = m.stack_target(&vs, &TargetRef::Player(PlayerId(1)), Some(0), false);
    assert_eq!((ben.target, ben.name.as_str()), (Some(TargetView::Player { seat: 1 }), "Ben"));
    // Someone else's library or hand: "a card", and no id to follow.
    for hidden in [theirs_in_library, theirs_in_hand] {
        let t = seen(hidden);
        assert_eq!((t.target, t.name.as_str(), t.controller), (None, "a card", None), "{hidden:?}");
    }
    // Your own hand you may see.
    assert_eq!(seen(mine_in_hand).target, Some(TargetView::Object { id: mine_in_hand.0 }));
    // A spectator sees no hand, unless every hand is face up (an all-AI game its owner watches).
    let spectator = engine::game::visibility::filter_state_for_unseated_viewer(&m.state);
    assert_eq!(m.stack_target(&spectator, &TargetRef::Object(mine_in_hand), None, false).target, None);
    assert!(m.stack_target(&m.state, &TargetRef::Object(theirs_in_hand), None, true).target.is_some());
}

#[test]
fn keywords_and_blocks_show_on_the_board() {
    let e = engine();
    let (mut m, ids) = board(&e, &[("Typhoid Rats", 0), ("Boggart Brute", 1), ("Grizzly Bears", 0)], Phase::DeclareBlockers);
    let (rats, brute, bears) = (ids[0], ids[1], ids[2]);
    let mut combat = CombatState::default();
    combat.attackers.push(engine::game::combat::AttackerInfo::new(brute, AttackTarget::Player(PlayerId(0)), PlayerId(0)));
    combat.blocker_to_attacker.insert(rats, vec![brute]);
    combat.blocker_assignments.insert(brute, vec![rats]);
    m.state.combat = Some(combat);
    for viewer in [Some(0), Some(1), None] {
        let v = m.view(viewer);
        let card = |id: ObjectId| v.battlefield.iter().find(|c| c.id == id.0).unwrap().clone();
        assert_eq!(card(rats).keywords, ["Deathtouch"], "{viewer:?}");
        assert_eq!(card(brute).keywords, ["Menace"]);
        assert!(card(bears).keywords.is_empty());
        // Everyone sees who blocks whom (CR 509.1g).
        assert_eq!(card(rats).blocks, [brute.0]);
        assert!(card(rats).blocking);
        assert_eq!((card(brute).attacking, card(brute).attacks, card(brute).attacks_card), (true, Some(0), None));
    }
}

#[test]
fn attackers_carry_their_requirements_restrictions_and_taxes() {
    let e = engine();
    // Ben's Propaganda taxes attacks on Ben; the Cyclops must attack; the Bears wear Pacifism.
    let (m, ids) = attacking(&e, &[("Bloodrock Cyclops", 0), ("Grizzly Bears", 0), ("Raging Goblin", 0), ("Propaganda", 1)]);
    let (cyclops, bears, goblin) = (ids[0], ids[1], ids[2]);
    let d = m.decision(0).expect("seat 0 declares attackers");
    let attack = d.attack.expect("the attack choice");
    let of = |id: ObjectId| attack.attackers.iter().find(|a| a.id == id.0).unwrap_or_else(|| panic!("{id:?} may attack"));
    assert_eq!(of(cyclops).must, Some(vec![]), "the Cyclops attacks if able, anyone will do");
    assert_eq!(of(cyclops).because, ["Bloodrock Cyclops"]);
    assert_eq!(of(goblin).must, None);
    // Propaganda: {2} for each creature attacking Ben, and only Ben.
    for id in [cyclops, bears, goblin] {
        assert_eq!(of(id).taxes, vec![(AttackAt::Player { seat: 1 }, "{2}".to_string())], "{id:?}");
    }
    let json = serde_json::to_value(&of(goblin)).unwrap();
    assert_eq!(json["taxes"], serde_json::json!([[{ "kind": "player", "seat": 1 }, "{2}"]]));
    assert!(json.get("must").is_none());
}

#[test]
fn a_creature_that_cant_attack_says_why() {
    let e = engine();
    let (mut m, ids) = board(&e, &[("Grizzly Bears", 0), ("Pacifism", 1)], Phase::DeclareAttackers);
    // Pacifism on the Bears.
    m.state.objects.get_mut(&ids[1]).unwrap().attached_to = Some(engine::game::game_object::AttachTarget::Object(ids[0]));
    m.state.objects.get_mut(&ids[0]).unwrap().attachments.push(ids[1]);
    evaluate_layers(&mut m.state);
    m.state.combat = Some(CombatState::default());
    m.state.waiting_for = build_declare_attackers_waiting_for(&m.state);
    m.remark(None);
    let attack = m.decision(0).unwrap().attack.unwrap();
    assert!(attack.attackers.iter().all(|a| a.id != ids[0].0), "the Bears can't attack");
    assert_eq!(attack.cant, vec![crate::Held { id: ids[0].0, because: vec!["Pacifism".into()] }]);
}

#[test]
fn blockers_carry_menace_and_their_requirements() {
    let e = engine();
    let (mut m, ids) = board(&e, &[("Boggart Brute", 0), ("Grizzly Bears", 1), ("Typhoid Rats", 1)], Phase::DeclareBlockers);
    let (brute, bears, rats) = (ids[0], ids[1], ids[2]);
    let mut combat = CombatState::default();
    combat.attackers.push(engine::game::combat::AttackerInfo::new(brute, AttackTarget::Player(PlayerId(1)), PlayerId(1)));
    m.state.combat = Some(combat);
    m.state.waiting_for = build_declare_blockers_waiting_for(&m.state, PlayerId(1));
    m.remark(None);
    let block = m.decision(1).expect("seat 1 blocks").block.expect("the block choice");
    assert_eq!(block.needs, vec![(brute.0, 2)], "menace needs two blockers");
    assert!(block.blockers.iter().any(|b| b.id == bears.0 && b.attackers == [brute.0] && !b.must));
    assert!(block.blockers.iter().any(|b| b.id == rats.0));
    // One blocker on a menace creature: refused in card names, and nothing changes.
    let before = m.revision;
    let err = m.declare_blockers(1, m.decision(1).unwrap().revision, &[(bears.0, brute.0)]).unwrap_err();
    assert!(matches!(err, ChoiceError::Rejected(_)), "{err}");
    assert!(err.to_string().contains("Boggart Brute"), "{err}");
    assert_eq!(m.revision, before);
}

#[test]
fn an_exerted_attacker_is_asked_and_answered_with_act() {
    let e = engine();
    let (mut m, ids) = attacking(&e, &[("Glorybringer", 0), ("Grizzly Bears", 1)]);
    let glory = ids[0];
    let d = m.decision(0).unwrap();
    m.declare_attackers(0, d.revision, &[(glory.0, AttackAt::Player { seat: 1 })]).unwrap();
    let d = m.decision(0).expect("asked to exert");
    let p = d.pending.clone().expect("exert is a yes or no");
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Yesno, Answer::ChooseExert, "exert"));
    assert_eq!(p.prompt, "Exert Glorybringer as it attacks?");
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Exert"), Some("Don't exert")));
    assert_eq!(p.source.as_ref().map(|s| s.id), Some(glory.0));
    // The wrong kind of answer is refused; the right one moves the game on.
    assert!(m.act(0, d.revision, &Act::PayCombatTax { accept: true }).is_err());
    m.act(0, d.revision, &Act::ChooseExert { exert: false }).unwrap();
    assert!(m.decision(0).and_then(|d| d.pending).is_none_or(|p| p.purpose != "exert"));
}

#[test]
fn an_attack_tax_is_asked_after_the_declaration() {
    let e = engine();
    let (mut m, ids) = attacking(&e, &[("Grizzly Bears", 0), ("Raging Goblin", 0), ("Propaganda", 1)]);
    // Mana to pay with.
    for _ in 0..4 {
        let face = e.database().get_face_by_name("Mountain").unwrap();
        let id = create_object_from_card_face(&mut m.state, face, PlayerId(0));
        onto_battlefield(&mut m, id, 0);
    }
    let d = m.decision(0).unwrap();
    let at = AttackAt::Player { seat: 1 };
    m.declare_attackers(0, d.revision, &[(ids[0].0, at), (ids[1].0, at)]).unwrap();
    let d = m.decision(0).expect("asked to pay");
    let p = d.pending.clone().expect("the tax is a yes or no");
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Yesno, Answer::PayCombatTax, "tax"));
    assert_eq!(p.prompt, "Pay {4} to attack with Grizzly Bears and Raging Goblin?");
    assert_eq!(p.yes_label.as_deref(), Some("Pay {4}"));
    // Not paying keeps the taxed creatures home.
    m.act(0, d.revision, &Act::PayCombatTax { accept: false }).unwrap();
    let v = m.view(Some(0));
    assert!(v.battlefield.iter().all(|c| !c.attacking), "no one attacks without paying");
}

#[test]
fn a_vehicle_is_crewed_with_act() {
    let e = engine();
    let (mut m, ids) = board(&e, &[("Smuggler's Copter", 0), ("Grizzly Bears", 0), ("Typhoid Rats", 0)], Phase::PreCombatMain);
    let (copter, bears, rats) = (ids[0], ids[1], ids[2]);
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    m.remark(None);
    // Crewing starts from priority, as one of the engine's options for the Copter.
    let d = m.decision(0).unwrap();
    let crew = d.options.iter().find(|o| o.object == Some(copter.0)).expect("the Copter can be crewed");
    assert_eq!(crew.label, "Crew Smuggler's Copter");
    m.choose(0, d.revision, crew.index).unwrap();
    let d = m.decision(0).expect("choosing the crew");
    let p = d.pending.clone().expect("crew is a pick");
    assert_eq!((p.kind, p.answer, p.purpose, p.need), (Kind::Pick, Answer::CrewVehicle, "crew", Some(1)));
    assert_eq!(p.prompt, "Crew Smuggler's Copter: tap creatures with total power 1 or more");
    let power = |id: ObjectId| p.options.iter().find(|o| o.id == id.0.to_string()).and_then(|o| o.power);
    assert_eq!((power(bears), power(rats)), (Some(2), Some(1)));
    // Not enough power, a creature that isn't offered, another vehicle: refused, game unchanged.
    let before = m.revision;
    let crew = |vehicle: ObjectId, creatures: Vec<ObjectId>| Act::CrewVehicle { vehicle: vehicle.0, creatures: creatures.iter().map(|c| c.0).collect() };
    assert_eq!(m.act(0, d.revision, &crew(copter, vec![])).unwrap_err().to_string(), "Tap creatures with total power 1 or more.");
    assert!(m.act(0, d.revision, &crew(copter, vec![copter])).is_err());
    assert!(m.act(0, d.revision, &crew(bears, vec![rats])).is_err());
    assert_eq!(m.revision, before);
    m.act(0, d.revision, &crew(copter, vec![rats])).unwrap();
    // The Rats tapped to crew it; the Copter's crew ability is on the stack (CR 702.122a).
    assert!(m.state.objects[&rats].tapped);
    assert!(!m.state.objects[&bears].tapped);
}

#[test]
fn enlist_taps_one_of_the_engines_creatures_or_none() {
    let e = engine();
    let (mut m, ids) = attacking(&e, &[("Coalition Skyknight", 0), ("Grizzly Bears", 0), ("Raging Goblin", 1)]);
    let (knight, bears) = (ids[0], ids[1]);
    let d = m.decision(0).unwrap();
    m.declare_attackers(0, d.revision, &[(knight.0, AttackAt::Player { seat: 1 })]).unwrap();
    let d = m.decision(0).expect("asked to enlist");
    let p = d.pending.clone().expect("enlist is a pick");
    assert_eq!((p.kind, p.answer, p.purpose, p.min, p.max, p.up_to), (Kind::Pick, Answer::ChooseEnlist, "enlist", 0, 1, true));
    assert_eq!(p.prompt, "Tap a creature to enlist for Coalition Skyknight?");
    assert!(p.options.iter().any(|o| o.id == bears.0.to_string() && o.eligible));
    assert!(m.act(0, d.revision, &Act::ChooseEnlist { target: Some(knight.0) }).is_err(), "the attacker itself can't enlist");
    m.act(0, d.revision, &Act::ChooseEnlist { target: Some(bears.0) }).unwrap();
    assert!(m.state.objects[&bears].tapped, "the Bears tapped for enlist");
}

/// A card the engine just made, put into its owner's hand.
fn into_hand(m: &mut Match, e: &Engine, name: &str, seat: u8) -> ObjectId {
    let face = e.database().get_face_by_name(name).unwrap();
    let id = create_object_from_card_face(&mut m.state, face, PlayerId(seat));
    m.state.players[usize::from(seat)].library.retain(|c| *c != id);
    m.state.players[usize::from(seat)].hand.push_back(id);
    m.state.objects.get_mut(&id).unwrap().zone = Zone::Hand;
    id
}

/// Seat 0 casts Lightning Bolt at its own Grizzly Bears, then `second` at the Bolt; both seats
/// are people and pass otherwise. Stops at the first decision `stop` accepts.
fn bolt_then(second: &str, stop: impl Fn(&Match) -> bool) -> (Match, Vec<ObjectId>) {
    let e = engine();
    let (mut m, ids) = board(&e, &[("Grizzly Bears", 0), ("Mountain", 0), ("Mountain", 0), ("Mountain", 0), ("Mountain", 0), ("Mountain", 0), ("Typhoid Rats", 1)], Phase::PreCombatMain);
    into_hand(&mut m, &e, "Lightning Bolt", 0);
    into_hand(&mut m, &e, second, 0);
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    m.remark(None);
    let bears = ids[0].0;
    for _ in 0..12 {
        if stop(&m) {
            return (m, ids);
        }
        let seat = m.waiting_on()[0];
        let d = m.decision(seat).unwrap();
        let bolt_cast = m.state.stack.iter().any(|s| m.state.objects.get(&s.source_id).is_some_and(|o| o.name == "Lightning Bolt"));
        let pick = if let Some(p) = d.pending.as_ref().filter(|p| p.purpose == "target") {
            // The Bolt at the Bears; the second spell at the Bolt.
            let want = if p.source.as_ref().is_some_and(|s| s.name == "Lightning Bolt") { bears.to_string() } else { p.options[0].id.clone() };
            m.act(seat, d.revision, &Act::ChooseTarget { target: Some(target_of(&want)) }).unwrap();
            continue;
        } else if !bolt_cast {
            d.options.iter().position(|o| o.label == "Cast Lightning Bolt").unwrap()
        } else {
            d.options.iter().position(|o| o.label == format!("Cast {second}")).unwrap_or(0)
        };
        m.choose(seat, d.revision, pick).unwrap();
    }
    panic!("never got there");
}

fn target_of(id: &str) -> TargetView {
    match id.strip_prefix('p') {
        Some(seat) => TargetView::Player { seat: seat.parse().unwrap() },
        None => TargetView::Object { id: id.parse().unwrap() },
    }
}

fn pending_for(m: &Match, purpose: &str) -> Option<crate::Pending> {
    m.decision(0).and_then(|d| d.pending).filter(|p| p.purpose == purpose)
}

#[test]
fn a_spell_on_the_stack_names_its_targets_for_everyone() {
    let (m, ids) = bolt_then("Reverberate", |m| m.decision(0).is_some_and(|d| d.options.iter().any(|o| o.label == "Cast Reverberate")));
    for viewer in [Some(0), Some(1), None] {
        let v = m.view(viewer);
        let bolt = v.stack.iter().find(|s| s.name == "Lightning Bolt").expect("the Bolt is on the stack");
        assert!(!bolt.casting);
        assert_eq!(bolt.targets.len(), 1, "{viewer:?}");
        assert_eq!(bolt.targets[0].target, Some(TargetView::Object { id: ids[0].0 }));
        assert_eq!((bolt.targets[0].name.as_str(), bolt.targets[0].controller), ("Grizzly Bears", Some(0)));
        assert!(bolt.text.is_none(), "a spell's words are its Oracle text");
        let json = serde_json::to_value(bolt).unwrap();
        assert_eq!(json["targets"][0]["target"], serde_json::json!({ "kind": "object", "id": ids[0].0 }));
    }
}

#[test]
fn a_spell_being_cast_shows_no_targets_yet() {
    let (m, _) = bolt_then("Reverberate", |m| pending_for(m, "target").is_some());
    let v = m.view(Some(0));
    let casting = v.stack.last().expect("announced on the stack (CR 601.2a)");
    assert!(casting.casting);
    assert!(casting.targets.is_empty());
    // The target pending says where it is in the spell's targets.
    let p = pending_for(&m, "target").unwrap();
    assert_eq!((p.slot, p.picked.len()), (None, 0));
}

#[test]
fn a_copy_gets_new_targets_with_act() {
    // Keeping the copy's target: the board sends the target it has, Yama sends "keep" (CR 707.10c).
    let (mut m, ids) = bolt_then("Reverberate", |m| pending_for(m, "copy").is_some());
    let d = m.decision(0).unwrap();
    let p = d.pending.clone().unwrap();
    assert_eq!((p.kind, p.answer, p.max), (Kind::Pick, Answer::ChooseTarget, 1));
    assert_eq!(p.prompt, "Choose a new target for the copy of Lightning Bolt");
    assert_eq!(p.current.as_deref(), Some(ids[0].0.to_string().as_str()));
    assert!(p.keep_rest);
    m.act(0, d.revision, &Act::ChooseTarget { target: Some(TargetView::Object { id: ids[0].0 }) }).unwrap();
    let v = m.view(Some(1));
    let bolts: Vec<_> = v.stack.iter().filter(|s| s.name == "Lightning Bolt").collect();
    assert_eq!(bolts.len(), 2);
    assert!(bolts.iter().all(|b| b.targets[0].target == Some(TargetView::Object { id: ids[0].0 })), "both at the Bears");

    // A new target for the copy: Ben.
    let (mut m, _) = bolt_then("Reverberate", |m| pending_for(m, "copy").is_some());
    let d = m.decision(0).unwrap();
    m.act(0, d.revision, &Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }).unwrap();
    let v = m.view(Some(1));
    let copy = v.stack.last().unwrap();
    assert_eq!((copy.name.as_str(), copy.targets[0].target.clone(), copy.targets[0].name.as_str()), ("Lightning Bolt", Some(TargetView::Player { seat: 1 }), "Ben"));

    // Or keep them all at once.
    let (mut m, _) = bolt_then("Reverberate", |m| pending_for(m, "copy").is_some());
    let d = m.decision(0).unwrap();
    m.act(0, d.revision, &Act::KeepAllCopyTargets).unwrap();
    assert!(pending_for(&m, "copy").is_none());
}

#[test]
fn a_spells_target_is_changed_with_act() {
    let (mut m, ids) = bolt_then("Bolt Bend", |m| pending_for(m, "retarget").is_some());
    let rats = ids[6];
    let d = m.decision(0).unwrap();
    let p = d.pending.clone().unwrap();
    assert_eq!((p.kind, p.answer, p.min, p.max), (Kind::Pick, Answer::RetargetSpell, 1, 1));
    assert_eq!(p.prompt, "Choose a new target for your Lightning Bolt");
    assert_eq!(p.current.as_deref(), Some(ids[0].0.to_string().as_str()));
    assert_eq!(p.default_answer, Some(serde_json::json!([ids[0].0.to_string()])));
    // Two targets for a spell with one, or something that isn't a choice: refused, nothing changes.
    let before = m.revision;
    let two = Act::RetargetSpell { new_targets: vec![Some(TargetView::Object { id: rats.0 }), None] };
    assert_eq!(m.act(0, d.revision, &two).unwrap_err().to_string(), "Choose one new target.");
    let elsewhere = Act::RetargetSpell { new_targets: vec![Some(TargetView::Object { id: 99_999 })] };
    assert!(m.act(0, d.revision, &elsewhere).is_err());
    assert_eq!(m.revision, before);
    m.act(0, d.revision, &Act::RetargetSpell { new_targets: vec![Some(TargetView::Object { id: rats.0 })] }).unwrap();
    let v = m.view(Some(1));
    let bolt = v.stack.iter().find(|s| s.name == "Lightning Bolt").unwrap();
    assert_eq!(bolt.targets[0].target, Some(TargetView::Object { id: rats.0 }));
}

#[test]
fn a_choice_of_targets_from_an_effect_is_a_pick() {
    // phase asks this when an accepted "you may sacrifice or tap" picks its object (CR 601.2c);
    // the pending ability here is the Bolt's, which is all the prompt needs.
    let (mut m, ids) = bolt_then("Reverberate", |m| m.decision(0).is_some_and(|d| d.options.iter().any(|o| o.label == "Cast Reverberate")));
    let ability = Box::new(m.state.stack[0].ability().unwrap().clone());
    m.state.waiting_for = WaitingFor::MultiTargetSelection { player: PlayerId(0), legal_targets: vec![ids[0], ids[6]], min_targets: 1, max_targets: 1, pending_ability: ability };
    let vs = filter_state_for_viewer(&m.state, PlayerId(0));
    let p = crate::Pending::of(&vs, PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.kind, p.answer, p.purpose, p.min, p.max, p.up_to), (Kind::Pick, Answer::SelectCards, "targets", 1, 1, false));
    assert_eq!(p.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Grizzly Bears", "Typhoid Rats"]);
    assert!(p.admits(&Act::SelectCards { cards: vec![ids[6].0] }).is_ok());
    assert!(p.admits(&Act::SelectCards { cards: vec![ids[0].0, ids[6].0] }).is_err());
}
