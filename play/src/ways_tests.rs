//! Ways to cast, permanents and counters (ways.rs; GCastWays, GPermanents, GCounters) on real
//! casts: cards from tests/fixtures/ways-cards.json (a slice of phase's card data: basic lands,
//! Isamaru, Clone, Bonesplitter, Birthday Escape, Anointed Procession, Fatehold Charm, Steady
//! Progress, Resourceful Defense, Hopeful Initiate, Rhys, Bloodbraid Elf, Geological Appraiser,
//! Bonecrusher Giant, Fiery Temper, Faithless Looting, Halvar, Mulldrifter, Vulpikeet, Saw It
//! Coming, Think Twice, Raise the Alarm, Sundering Growth and others) put straight onto a board at
//! seat 0's main phase, then answered through `act` as the board does. Decisions that need more
//! set-up than a test should carry are checked from the engine's state built by hand.

use engine::game::filter_state_for_viewer;
use engine::game::layers::evaluate_layers;
use engine::types::ability::TargetRef;
use engine::types::counter::CounterType;
use engine::types::game_state::{CastOfferKind, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use serde_json::json;

use crate::act::{Answer, CounterCount, CounterMove, Kind};
use crate::pay::PayMode;
use crate::{Act, ChoiceError, Decision, Engine, Match, OptionKind, Pending, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ways-cards.json")).unwrap()
}

/// Where a card starts in `table`.
#[derive(Clone, Copy)]
enum At {
    Field,
    Hand,
    Theirs,
    Grave,
    /// On top of seat 0's library, the first given on top.
    Top,
}

/// A two-person game at seat 0's turn 3 main phase with priority, both people deciding: each
/// card where it's asked for (untapped, none summoning sick). The cards are dealt into the decks,
/// so two-faced and adventurer cards are whole, then moved from the library. Seat 0's commander,
/// Combat Celebrant, is in the command zone. Returns the ids in the order given.
fn table(e: &Engine, cards: &[(&str, At)]) -> (Match, Vec<ObjectId>) {
    let seat_of = |at: &At| if matches!(at, At::Theirs) { 1usize } else { 0 };
    let deck = |seat: usize| {
        let mut main: Vec<String> = cards.iter().filter(|(_, at)| seat_of(at) == seat).map(|(n, _)| n.to_string()).collect();
        main.resize(99, "Plains".into());
        SeatDeck { commander: vec!["Combat Celebrant".into()], main }
    };
    let mut m = e.new_match_first(3, vec![deck(0), deck(1)], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    let mut ids = vec![];
    let mut tops = vec![];
    for (name, at) in cards {
        let seat = seat_of(at);
        let id = m.state.players[seat]
            .library
            .iter()
            .copied()
            .find(|id| m.state.objects[id].name == *name && !ids.contains(id))
            .unwrap_or_else(|| panic!("{name} isn't in the deck"));
        let p = &mut m.state.players[seat];
        p.library.retain(|c| *c != id);
        let zone = match at {
            At::Field | At::Theirs => {
                m.state.battlefield.push_back(id);
                Zone::Battlefield
            }
            At::Hand => {
                p.hand.push_back(id);
                Zone::Hand
            }
            At::Grave => {
                p.graveyard.push_back(id);
                Zone::Graveyard
            }
            At::Top => {
                tops.push(id);
                Zone::Library
            }
        };
        let o = m.state.objects.get_mut(&id).unwrap();
        o.zone = zone;
        o.summoning_sick = false;
        o.controller = PlayerId(seat as u8);
        ids.push(id);
    }
    for id in tops.into_iter().rev() {
        m.state.players[0].library.push_front(id);
    }
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = Phase::PreCombatMain;
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    (m, ids)
}

fn lands(n: usize, name: &'static str) -> Vec<(&'static str, At)> {
    vec![(name, At::Field); n]
}

fn decide(m: &Match) -> Decision {
    m.decision(0).expect("seat 0 decides")
}

fn pending(m: &Match) -> Pending {
    decide(m).pending.unwrap_or_else(|| panic!("no pending for {:?}", m.state.waiting_for))
}

fn act(m: &mut Match, a: Act) {
    let d = decide(m);
    m.act(0, d.revision, &a).unwrap_or_else(|e| panic!("{a:?} refused: {e}"));
}

fn refused(m: &mut Match, a: Act) -> String {
    let d = decide(m);
    match m.act(0, d.revision, &a) {
        Err(ChoiceError::DoesntFit(why)) | Err(ChoiceError::Rejected(why)) => why,
        other => panic!("{a:?} wasn't refused: {other:?}"),
    }
}

/// Cast a card through `act`, paid automatically.
fn cast(m: &mut Match, id: ObjectId) {
    act(m, Act::CastSpell { object: id.0, payment: PayMode::Auto });
}

/// Both people pass until seat 0 is asked something other than priority, or the stack is empty
/// with seat 0 to act. A target is taken as the first one offered.
fn settle(m: &mut Match) {
    for _ in 0..60 {
        let seat = *m.waiting_on().first().expect("someone decides");
        let d = m.decision(seat).unwrap();
        if let Some(p) = &d.pending {
            if seat == 0 {
                return;
            }
            panic!("seat {seat} was asked {:?}", p.prompt);
        }
        if seat == 0 && m.state.stack.is_empty() && matches!(m.state.waiting_for, WaitingFor::Priority { .. }) {
            return;
        }
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap_or_else(|| panic!("seat {seat} has more than a pass: {:?}", d.prompt));
        m.choose(seat, d.revision, pass.index).unwrap();
    }
    panic!("the stack didn't settle");
}

/// Pick the target `t` for the spell being cast (and every later slot's first option).
fn aim(m: &mut Match, t: TargetView) {
    act(m, Act::ChooseTarget { target: Some(t) });
}

fn on_field(m: &Match, id: ObjectId) -> bool {
    m.state.battlefield.contains(&id)
}

fn counters(m: &Match, id: ObjectId, t: &CounterType) -> u32 {
    m.state.objects[&id].counters.get(t).copied().unwrap_or(0)
}

fn ids(p: &Pending) -> Vec<String> {
    p.options.iter().map(|o| o.id.clone()).collect()
}

// ── permanents ──────────────────────────────────────────────────────────────

#[test]
fn the_legend_rule_keeps_the_one_chosen() {
    let e = engine();
    let mut cards = lands(2, "Plains");
    cards.push(("Isamaru, Hound of Konda", At::Field));
    cards.push(("Isamaru, Hound of Konda", At::Hand));
    let (mut m, ids_) = table(&e, &cards);
    let (old, new) = (ids_[2], ids_[3]);
    cast(&mut m, new);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseLegend, "legend", "Choose the Isamaru, Hound of Konda to keep"));
    assert_eq!((p.min, p.max), (1, 1));
    let mut both = ids(&p);
    both.sort();
    let mut want = vec![old.0.to_string(), new.0.to_string()];
    want.sort();
    assert_eq!(both, want);
    assert!(p.options.iter().all(|o| o.zone.as_deref() == Some("battlefield")));
    // Only one of the two, and only through the legend answer.
    assert!(refused(&mut m, Act::ChooseLegend { keep: 999_999 }).contains("isn't one of the choices"));
    assert!(refused(&mut m, Act::ChooseRingBearer { target: old.0 }).contains("doesn't fit"));
    let wire = serde_json::to_value(Act::ChooseLegend { keep: old.0 }).unwrap();
    assert_eq!(wire, json!({ "kind": "choose_legend", "keep": old.0 }));
    assert_eq!(serde_json::from_value::<Act>(wire).unwrap(), Act::ChooseLegend { keep: old.0 });
    act(&mut m, Act::ChooseLegend { keep: old.0 });
    assert!(on_field(&m, old));
    assert!(!on_field(&m, new) && m.state.players[0].graveyard.contains(&new), "the other went to the graveyard");
    assert!(m.log.actions.iter().any(|a| format!("{:?}", a.action).starts_with("ChooseLegend")), "it's in the replay log");
}

#[test]
fn a_clone_chooses_what_it_copies_on_the_board() {
    let e = engine();
    let mut cards = lands(4, "Island");
    cards.push(("Clone", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs));
    cards.push(("Savannah Lions", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    let (clone, bears, lions) = (ids_[4], ids_[5], ids_[6]);
    cast(&mut m, clone);
    settle(&mut m);
    // Clone's "you may" comes first: the engine's yes or no for its replacement effect.
    let p = pending(&m);
    assert_eq!((p.kind, p.answer), (Kind::Yesno, Answer::ChooseReplacement));
    assert_eq!(p.prompt, "Have Clone enter as a copy of any creature on the battlefield?");
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Copy"), Some("Don't copy")));
    act(&mut m, Act::ChooseReplacement { index: 0 });
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseTarget, "clone", "Choose a permanent for Clone to copy"));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Clone"));
    assert!(ids(&p).contains(&bears.0.to_string()) && ids(&p).contains(&lions.0.to_string()), "{:?}", p.options);
    assert_eq!((p.min, p.max, p.up_to), (1, 1, false), "the engine has no answer for copying nothing");
    assert!(refused(&mut m, Act::ChooseTarget { target: None }).contains("needs a target"));
    aim(&mut m, TargetView::Object { id: bears.0 });
    settle(&mut m);
    assert_eq!(m.state.objects[&clone].name, "Grizzly Bears");
}

#[test]
fn equip_picks_the_creature_when_the_engine_asks() {
    let e = engine();
    let (mut m, ids_) = table(&e, &[("Bonesplitter", At::Field), ("Savannah Lions", At::Field), ("Grizzly Bears", At::Field), ("Grizzly Bears", At::Theirs)]);
    let (splitter, lions, bears, theirs) = (ids_[0], ids_[1], ids_[2], ids_[3]);
    // Equip at priority is the card's ability with its target (the board's targeting); the
    // engine's own announcement asks for the creature next.
    let vs = filter_state_for_viewer(&m.state, PlayerId(0));
    let announce = engine::types::actions::GameAction::Equip { equipment_id: splitter, target_id: splitter };
    assert_eq!(m.label(&vs, &announce), "Equip Bonesplitter");
    m.state.waiting_for = WaitingFor::EquipTarget { player: PlayerId(0), equipment_id: splitter, valid_targets: vec![lions, bears] };
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::Equip, "equip", "Equip Bonesplitter: choose a creature"));
    assert_eq!(ids(&p), [lions.0.to_string(), bears.0.to_string()]);
    assert_eq!(p.source.as_ref().map(|s| s.id), Some(splitter.0));
    assert!(refused(&mut m, Act::Equip { equipment: lions.0, target: bears.0 }).contains("different card"));
    assert!(refused(&mut m, Act::Equip { equipment: splitter.0, target: theirs.0 }).contains("isn't one of the choices"));
    assert_eq!(serde_json::to_value(Act::Equip { equipment: splitter.0, target: bears.0 }).unwrap(), json!({ "kind": "equip", "equipment": splitter.0, "target": bears.0 }));
    act(&mut m, Act::Equip { equipment: splitter.0, target: bears.0 });
    settle(&mut m);
    assert_eq!(m.state.objects[&splitter].attached_to.map(|t| format!("{t:?}")), Some(format!("{:?}", engine::game::game_object::AttachTarget::Object(bears))));
}

#[test]
fn the_ring_tempts_you_and_you_choose_a_bearer() {
    let e = engine();
    let mut cards = lands(1, "Island");
    cards.push(("Birthday Escape", At::Hand));
    cards.push(("Savannah Lions", At::Field));
    cards.push(("Grizzly Bears", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    let (escape, lions, bears) = (ids_[1], ids_[2], ids_[3]);
    cast(&mut m, escape);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseRingBearer, "ring", "The Ring tempts you: choose your Ring-bearer"));
    assert!(p.current.is_none(), "no Ring-bearer yet");
    assert!(ids(&p).contains(&lions.0.to_string()) && ids(&p).contains(&bears.0.to_string()));
    act(&mut m, Act::ChooseRingBearer { target: lions.0 });
    assert_eq!(m.state.ring_bearer.get(&PlayerId(0)).copied().flatten(), Some(lions));
}

#[test]
fn a_ring_bearer_now_is_marked_as_the_current_one() {
    let e = engine();
    let (mut m, ids_) = table(&e, &[("Savannah Lions", At::Field), ("Grizzly Bears", At::Field)]);
    m.state.ring_bearer.insert(PlayerId(0), Some(ids_[1]));
    m.state.waiting_for = WaitingFor::ChooseRingBearer { player: PlayerId(0), candidates: ids_.clone() };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
    assert_eq!(p.current, Some(ids_[1].0.to_string()));
}

#[test]
fn empower_jace_chooses_among_jace_tokens_with_their_loyalty() {
    let e = engine();
    let mut cards = lands(1, "Plains");
    cards.extend(lands(1, "Island"));
    cards.push(("Anointed Procession", At::Field));
    cards.push(("Fatehold Charm", At::Hand));
    let (mut m, ids_) = table(&e, &cards);
    let charm = ids_[3];
    cast(&mut m, charm);
    // Fatehold Charm's first mode draws a card and empowers Jace 2.
    let p = pending(&m);
    assert_eq!(p.answer, Answer::SelectModes);
    act(&mut m, Act::SelectModes { indices: vec![0] });
    settle(&mut m);
    // Anointed Procession made two Jace tokens: which one gets the counters.
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SelectCards, "empower", "Empower Jace 2: choose a Jace token"));
    assert_eq!(p.total, Some(2));
    assert_eq!(p.options.len(), 2);
    assert!(p.options.iter().all(|o| o.name == "Jace" && o.zone.as_deref() == Some("battlefield")), "{:?}", p.options);
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Fatehold Charm"));
    let pick: u64 = p.options[1].id.parse().unwrap();
    let other: u64 = p.options[0].id.parse().unwrap();
    assert!(refused(&mut m, Act::SelectCards { cards: vec![pick, other] }).contains("exactly 1"));
    act(&mut m, Act::SelectCards { cards: vec![pick] });
    settle(&mut m);
    assert_eq!(counters(&m, ObjectId(pick), &CounterType::Loyalty), 2);
    assert!(!on_field(&m, ObjectId(other)), "the other Jace had no loyalty and left");
}

#[test]
fn populate_explore_and_a_token_host_are_one_card_on_the_board() {
    let e = engine();
    let (mut m, ids_) = table(&e, &[("Savannah Lions", At::Field), ("Grizzly Bears", At::Field), ("Raise the Alarm", At::Hand)]);
    let vs = |m: &Match| filter_state_for_viewer(&m.state, PlayerId(0));
    let src = ids_[2];
    m.state.waiting_for = WaitingFor::PopulateChoice { player: PlayerId(0), source_id: src, valid_tokens: vec![ids_[0], ids_[1]] };
    let p = Pending::of(&vs(&m), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.answer, p.purpose, p.prompt.as_str(), p.options.len()), (Answer::ChooseTarget, "populate", "Populate: choose a creature token to copy", 2));
    assert!(p.admits(&Act::ChooseTarget { target: Some(TargetView::Object { id: ids_[1].0 }) }).is_ok());
    assert!(p.admits(&Act::ChooseTarget { target: Some(TargetView::Object { id: src.0 }) }).is_err());
    // Nothing to copy: the engine answers itself, so the buttons do.
    m.state.waiting_for = WaitingFor::PopulateChoice { player: PlayerId(0), source_id: src, valid_tokens: vec![] };
    assert!(Pending::of(&vs(&m), PlayerId(0), &[], &[]).is_none());
    // Token hosts can be players too, named by seat.
    let ability = engine::types::ability::ResolvedAbility::new(
        engine::types::ability::Effect::Unimplemented { name: "test".into(), description: None },
        vec![],
        src,
        PlayerId(0),
    );
    m.state.waiting_for = WaitingFor::ChooseTokenHost {
        player: PlayerId(0),
        source_id: src,
        legal_targets: vec![TargetRef::Object(ids_[0]), TargetRef::Player(PlayerId(1))],
        pending_ability: Box::new(ability.clone()),
    };
    let p = Pending::of(&vs(&m), PlayerId(0), &[], &["Ana".into(), "Ben".into()]).unwrap();
    assert_eq!((p.answer, p.purpose), (Answer::ChooseTarget, "host"));
    assert_eq!(p.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Savannah Lions", "Ben"]);
    m.state.waiting_for = WaitingFor::ExploreChoice { player: PlayerId(0), source_id: src, choosable: vec![ids_[0]], remaining: vec![ids_[0], ids_[1]], pending_effect: Box::new(ability) };
    let p = Pending::of(&vs(&m), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.purpose, p.prompt.as_str(), ids(&p)), ("explore", "Choose which explores next", vec![ids_[0].0.to_string()]));
}

// ── counters ────────────────────────────────────────────────────────────────

#[test]
fn proliferate_picks_any_permanents_and_players_with_counters() {
    let e = engine();
    let mut cards = lands(3, "Island");
    cards.push(("Steady Progress", At::Hand));
    cards.push(("Savannah Lions", At::Field));
    cards.push(("Grizzly Bears", At::Theirs));
    let (mut m, ids_) = table(&e, &cards);
    let (progress, lions, bears) = (ids_[3], ids_[4], ids_[5]);
    m.state.objects.get_mut(&lions).unwrap().counters.insert(CounterType::Plus1Plus1, 2);
    m.state.objects.get_mut(&bears).unwrap().counters.insert(CounterType::Minus1Minus1, 1);
    m.state.players[1].poison_counters = 3;
    evaluate_layers(&mut m.state);
    cast(&mut m, progress);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SelectTargets, "proliferate", "Proliferate"));
    assert_eq!((p.min, p.up_to), (0, true));
    let l = p.options.iter().find(|o| o.id == lions.0.to_string()).expect("the Lions have counters");
    assert_eq!(l.counters, vec![("+1/+1".to_string(), 2)]);
    let ben = p.options.iter().find(|o| o.id == "p1").expect("Ben has poison counters");
    assert_eq!((ben.name.as_str(), ben.zone.as_deref(), ben.counters.clone()), ("Ben", Some("player"), vec![("poison".to_string(), 3)]));
    assert!(p.options.iter().all(|o| o.id != "p0"), "Ana has no counters");
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Steady Progress"));
    let twice = Act::SelectTargets { targets: vec![TargetView::Object { id: lions.0 }, TargetView::Object { id: lions.0 }] };
    assert!(refused(&mut m, twice).contains("twice"));
    assert!(refused(&mut m, Act::SelectTargets { targets: vec![TargetView::Player { seat: 0 }] }).contains("isn't one of the choices"));
    let pick = Act::SelectTargets { targets: vec![TargetView::Object { id: lions.0 }, TargetView::Player { seat: 1 }] };
    assert_eq!(serde_json::to_value(&pick).unwrap(), json!({ "kind": "select_targets", "targets": [{ "kind": "object", "id": lions.0 }, { "kind": "player", "seat": 1 }] }));
    act(&mut m, pick);
    settle(&mut m);
    assert_eq!(counters(&m, lions, &CounterType::Plus1Plus1), 3);
    assert_eq!(counters(&m, bears, &CounterType::Minus1Minus1), 1, "the Bears weren't chosen");
    assert_eq!(m.state.players[1].poison_counters, 4);
}

#[test]
fn proliferating_nothing_is_an_answer() {
    let e = engine();
    let mut cards = lands(3, "Island");
    cards.push(("Steady Progress", At::Hand));
    cards.push(("Savannah Lions", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    m.state.objects.get_mut(&ids_[4]).unwrap().counters.insert(CounterType::Plus1Plus1, 1);
    cast(&mut m, ids_[3]);
    settle(&mut m);
    act(&mut m, Act::SelectTargets { targets: vec![] });
    settle(&mut m);
    assert_eq!(counters(&m, ids_[4], &CounterType::Plus1Plus1), 1);
}

#[test]
fn counters_move_up_to_what_there_is() {
    let e = engine();
    let mut cards = lands(5, "Plains");
    cards.push(("Resourceful Defense", At::Field));
    cards.push(("Savannah Lions", At::Field));
    cards.push(("Grizzly Bears", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    let (defense, lions, bears) = (ids_[5], ids_[6], ids_[7]);
    m.state.objects.get_mut(&lions).unwrap().counters.insert(CounterType::Plus1Plus1, 3);
    evaluate_layers(&mut m.state);
    let d = decide(&m);
    let ability = d.options.iter().find(|o| o.object == Some(defense.0) && o.kind == OptionKind::Ability).expect("Resourceful Defense's ability");
    m.choose(0, d.revision, ability.index).unwrap();
    aim(&mut m, TargetView::Object { id: lions.0 });
    aim(&mut m, TargetView::Object { id: bears.0 });
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Split, Answer::MoveCounters, "move_counters"));
    assert_eq!(p.prompt, "Move counters from Savannah Lions to Grizzly Bears");
    assert_eq!((p.total, p.up_to, p.origin.clone(), p.unit), (Some(3), true, Some(lions.0.to_string()), Some("counters")));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Resourceful Defense"));
    let o = &p.options[0];
    assert_eq!((o.id.clone(), o.group.as_deref(), o.cap), (bears.0.to_string(), Some("P1P1"), Some(3)));
    let mv = |n| Act::MoveCounters { moves: vec![CounterMove { on: bears.0, counter: "P1P1".into(), count: n }] };
    assert!(refused(&mut m, mv(4)).contains("only 3"));
    assert!(refused(&mut m, Act::MoveCounters { moves: vec![CounterMove { on: lions.0, counter: "P1P1".into(), count: 1 }] }).contains("aren't one of the choices"));
    assert_eq!(serde_json::to_value(mv(2)).unwrap(), json!({ "kind": "move_counters", "moves": [{ "on": bears.0, "counter": "P1P1", "count": 2 }] }));
    act(&mut m, mv(2));
    settle(&mut m);
    assert_eq!((counters(&m, lions, &CounterType::Plus1Plus1), counters(&m, bears, &CounterType::Plus1Plus1)), (1, 2));
}

#[test]
fn counters_removed_as_an_ability_resolves_are_any_number_of_each_kind() {
    let e = engine();
    let mut cards = lands(1, "Plains");
    cards.push(("Rhys, the Evermore", At::Field));
    cards.push(("Savannah Lions", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    let (rhys, lions) = (ids_[1], ids_[2]);
    m.state.objects.get_mut(&lions).unwrap().counters.insert(CounterType::Stun, 2);
    m.state.objects.get_mut(&lions).unwrap().counters.insert(CounterType::Plus1Plus1, 1);
    evaluate_layers(&mut m.state);
    let d = decide(&m);
    let ability = d.options.iter().find(|o| o.object == Some(rhys.0) && o.kind == OptionKind::Ability).expect("Rhys's ability");
    m.choose(0, d.revision, ability.index).unwrap();
    if decide(&m).pending.is_some_and(|p| p.purpose == "target") {
        aim(&mut m, TargetView::Object { id: lions.0 });
    }
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Split, Answer::RemoveCounters, "remove_counters"));
    assert_eq!(p.prompt, "Remove any number of counters from Savannah Lions");
    let mut kinds: Vec<(String, String, Option<u32>)> = p.options.iter().map(|o| (o.id.clone(), o.name.clone(), o.cap)).collect();
    kinds.sort();
    assert_eq!(kinds, [("P1P1".to_string(), "+1/+1 counters".to_string(), Some(1)), ("stun".to_string(), "stun counters".to_string(), Some(2))]);
    let rm = |n| Act::RemoveCounters { counters: vec![CounterCount { counter: "stun".into(), count: n }] };
    assert!(refused(&mut m, rm(3)).contains("only 2"));
    act(&mut m, rm(2));
    settle(&mut m);
    assert_eq!((counters(&m, lions, &CounterType::Stun), counters(&m, lions, &CounterType::Plus1Plus1)), (0, 1));
}

#[test]
fn counters_removed_from_among_creatures_pay_a_cost_exactly() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Hopeful Initiate", At::Field));
    cards.push(("Savannah Lions", At::Field));
    cards.push(("Bonesplitter", At::Theirs));
    let (mut m, ids_) = table(&e, &cards);
    let (initiate, lions, splitter) = (ids_[3], ids_[4], ids_[5]);
    m.state.objects.get_mut(&initiate).unwrap().counters.insert(CounterType::Plus1Plus1, 1);
    m.state.objects.get_mut(&lions).unwrap().counters.insert(CounterType::Plus1Plus1, 2);
    evaluate_layers(&mut m.state);
    let d = decide(&m);
    let ability = d.options.iter().find(|o| o.object == Some(initiate.0) && o.kind == OptionKind::Ability).expect("Hopeful Initiate's ability");
    m.choose(0, d.revision, ability.index).unwrap();
    // The target may come before or after the cost, as the engine orders them.
    for _ in 0..3 {
        let p = pending(&m);
        if p.answer == Answer::RemoveCounterCost {
            break;
        }
        assert_eq!(p.purpose, "target", "{p:?}");
        aim(&mut m, TargetView::Object { id: splitter.0 });
    }
    let p = pending(&m);
    assert_eq!((p.kind, p.purpose, p.total, p.up_to), (Kind::Split, "counter_cost", Some(2), false));
    assert_eq!(p.prompt, "Remove 2 +1/+1 counters from among your permanents to activate Hopeful Initiate");
    let caps: Vec<(String, Option<u32>)> = p.options.iter().map(|o| (o.id.clone(), o.cap)).collect();
    assert!(caps.contains(&(initiate.0.to_string(), Some(1))) && caps.contains(&(lions.0.to_string(), Some(2))), "{caps:?}");
    let take = |a: u32, b: u32| Act::RemoveCounterCost {
        counters: [(initiate, a), (lions, b)].into_iter().filter(|(_, n)| *n > 0).map(|(id, n)| CounterMove { on: id.0, counter: "P1P1".into(), count: n }).collect(),
    };
    assert!(refused(&mut m, take(1, 0)).contains("exactly 2"));
    assert!(refused(&mut m, take(2, 0)).contains("only 1"));
    act(&mut m, take(1, 1));
    assert_eq!((counters(&m, initiate, &CounterType::Plus1Plus1), counters(&m, lions, &CounterType::Plus1Plus1)), (0, 1));
}

// ── ways to cast ────────────────────────────────────────────────────────────

#[test]
fn cascade_shows_the_run_and_casts_the_hit_free() {
    let e = engine();
    let mut cards = lands(2, "Mountain");
    cards.extend(lands(2, "Forest"));
    cards.push(("Bloodbraid Elf", At::Hand));
    cards.push(("Forest", At::Top));
    cards.push(("Grizzly Bears", At::Top));
    let (mut m, ids_) = table(&e, &cards);
    let (elf, miss, hit) = (ids_[4], ids_[5], ids_[6]);
    cast(&mut m, elf);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Yesno, Answer::CastOffer, "cascade"));
    assert_eq!(p.prompt, "Cast Grizzly Bears without paying its mana cost?");
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Cast it free"), Some("Don't cast")));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Bloodbraid Elf"));
    // The cards it went through, in order, then the one it found: only that one is cast.
    assert_eq!(p.options.iter().map(|o| (o.id.clone(), o.name.as_str(), o.eligible)).collect::<Vec<_>>(), [(miss.0.to_string(), "Forest", false), (hit.0.to_string(), "Grizzly Bears", true)]);
    assert!(p.options.iter().all(|o| o.zone.as_deref() == Some("exile")));
    // Exiled cards are face up: the other seat's view names the same cards, and nothing else of
    // the library.
    let theirs = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(1)), PlayerId(0), &[], &[]).unwrap();
    assert_eq!(theirs.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Forest", "Grizzly Bears"]);
    assert!(m.decision(1).is_none(), "the other seat isn't asked");
    assert_eq!(serde_json::to_value(Act::CastOffer { cast: true, payment: PayMode::Ask }).unwrap(), json!({ "kind": "cast_offer", "cast": true, "payment": "ask" }));
    assert!(refused(&mut m, Act::DecideOptionalEffect { accept: false }).contains("doesn't fit"), "cascade isn't declined with a plain no");
    act(&mut m, Act::CastOffer { cast: true, payment: PayMode::Ask });
    settle(&mut m);
    assert!(on_field(&m, hit), "Grizzly Bears was cast free");
    assert!(m.state.players[0].library.contains(&miss), "the miss went to the bottom");
}

#[test]
fn declining_a_cascade_puts_the_run_on_the_bottom() {
    let e = engine();
    let mut cards = lands(2, "Mountain");
    cards.extend(lands(2, "Forest"));
    cards.push(("Bloodbraid Elf", At::Hand));
    cards.push(("Grizzly Bears", At::Top));
    let (mut m, ids_) = table(&e, &cards);
    cast(&mut m, ids_[4]);
    settle(&mut m);
    act(&mut m, Act::CastOffer { cast: false, payment: PayMode::Ask });
    settle(&mut m);
    assert!(!on_field(&m, ids_[5]));
    assert_eq!(m.state.players[0].library.back().copied(), Some(ids_[5]));
}

#[test]
fn discover_casts_free_or_puts_the_card_into_your_hand_unseen() {
    let e = engine();
    let mut cards = lands(4, "Mountain");
    cards.push(("Geological Appraiser", At::Hand));
    cards.push(("Plains", At::Top));
    cards.push(("Savannah Lions", At::Top));
    let (mut m, ids_) = table(&e, &cards);
    let (appraiser, hit) = (ids_[4], ids_[6]);
    cast(&mut m, appraiser);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose), (Answer::CastOffer, "discover"));
    assert_eq!(p.prompt, "Cast Savannah Lions without paying its mana cost, or put it into your hand?");
    assert_eq!(p.no_label.as_deref(), Some("Put it into your hand"));
    act(&mut m, Act::CastOffer { cast: false, payment: PayMode::Ask });
    settle(&mut m);
    assert!(m.state.players[0].hand.contains(&hit));
    // In seat 0's hand now: seat 1 doesn't see it.
    let theirs = filter_state_for_viewer(&m.state, PlayerId(1));
    assert_ne!(Match::name_in(&theirs, &hit), "Savannah Lions");
}

#[test]
fn an_adventurer_card_is_cast_as_either_half() {
    let e = engine();
    let mut cards = lands(5, "Mountain");
    cards.push(("Bonecrusher Giant", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs));
    let (mut m, ids_) = table(&e, &cards);
    let (giant, bears) = (ids_[5], ids_[6]);
    act(&mut m, Act::CastSpell { object: giant.0, payment: PayMode::Auto });
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseAdventureFace, "adventure", "Which half do you cast?"));
    assert_eq!(
        p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.cost.as_deref(), o.eligible)).collect::<Vec<_>>(),
        [("creature", "Bonecrusher Giant", Some("{2}{R}"), true), ("adventure", "Stomp", Some("{1}{R}"), true)]
    );
    assert_eq!(p.card_names(), ["Bonecrusher Giant", "Bonecrusher Giant", "Stomp"], "the server sends both faces' details");
    assert!(refused(&mut m, Act::ChooseModalFace { back_face: true }).contains("doesn't fit"));
    act(&mut m, Act::ChooseAdventureFace { creature: false });
    // Stomp: any target.
    aim(&mut m, TargetView::Object { id: bears.0 });
    settle(&mut m);
    assert!(m.state.exile.contains(&giant), "on an adventure, in exile");
    // Later, from exile: an option that says so.
    let d = decide(&m);
    let again = d.options.iter().find(|o| o.object == Some(giant.0)).expect("cast it from exile");
    assert_eq!((again.kind, again.label.as_str()), (OptionKind::Spell, "Cast Bonecrusher Giant from exile"));
}

#[test]
fn a_modal_card_with_two_spell_faces_asks_which_face() {
    let e = engine();
    let mut cards = lands(4, "Plains");
    cards.push(("Halvar, God of Battle", At::Hand));
    let (mut m, ids_) = table(&e, &cards);
    let halvar = ids_[4];
    act(&mut m, Act::CastSpell { object: halvar.0, payment: PayMode::Auto });
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseModalFace, "face", "Which face do you cast?"));
    assert_eq!(
        p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.cost.as_deref())).collect::<Vec<_>>(),
        [("front", "Halvar, God of Battle", Some("{2}{W}{W}")), ("back", "Sword of the Realms", Some("{1}{W}"))]
    );
    act(&mut m, Act::ChooseModalFace { back_face: true });
    settle(&mut m);
    assert_eq!(m.state.objects[&halvar].name, "Sword of the Realms");
    assert!(on_field(&m, halvar));
}

#[test]
fn an_alternative_cost_is_offered_beside_the_mana_cost() {
    let e = engine();
    let mut cards = lands(5, "Island");
    cards.push(("Mulldrifter", At::Hand));
    let (mut m, ids_) = table(&e, &cards);
    let drifter = ids_[5];
    act(&mut m, Act::CastSpell { object: drifter.0, payment: PayMode::Auto });
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseAlternativeCast, "alt_cost", "Pay the mana cost, or evoke?"));
    assert_eq!(
        p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.cost.as_deref())).collect::<Vec<_>>(),
        [("normal", "Mana cost", Some("{4}{U}")), ("alternative", "Evoke", Some("{2}{U}"))]
    );
    act(&mut m, Act::ChooseAlternativeCast { alternative: true });
    settle(&mut m);
    // Evoked: its draw and its evoke sacrifice trigger together.
    let p = pending(&m);
    assert_eq!(p.answer, Answer::OrderTriggers);
    assert!(p.options.iter().any(|o| o.text.as_deref().is_some_and(|t| t.contains("evoke cost was paid"))), "{:?}", p.options);
    act(&mut m, Act::OrderTriggers { order: vec![0, 1] });
    settle(&mut m);
    assert!(m.state.players[0].graveyard.contains(&drifter));
}

#[test]
fn mutate_goes_over_or_under() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Vulpikeet", At::Hand));
    cards.push(("Emeria Angel", At::Field));
    let (mut m, ids_) = table(&e, &cards);
    let (vulpikeet, angel) = (ids_[3], ids_[4]);
    let d = decide(&m);
    let mutate = d.options.iter().filter(|o| o.object == Some(vulpikeet.0)).map(|o| o.label.clone()).collect::<Vec<_>>();
    // The mutate cast is one of the card's options, or the engine asks after Cast.
    act(&mut m, Act::CastSpell { object: vulpikeet.0, payment: PayMode::Auto });
    for _ in 0..3 {
        match decide(&m).pending.map(|p| p.answer) {
            Some(Answer::ChooseAlternativeCast) => act(&mut m, Act::ChooseAlternativeCast { alternative: true }),
            Some(Answer::ChooseCastingVariant) => {
                let p = pending(&m);
                let i = p.options.iter().position(|o| o.name == "Mutate").unwrap_or_else(|| panic!("{:?} / {mutate:?}", p.options));
                act(&mut m, Act::ChooseCastingVariant { index: i });
            }
            Some(Answer::ChooseTarget) => aim(&mut m, TargetView::Object { id: angel.0 }),
            _ => break,
        }
    }
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseMutateSide, "mutate", "Put Vulpikeet on top of Emeria Angel, or underneath?"));
    assert_eq!(p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.power)).collect::<Vec<_>>(), [("top", "Vulpikeet", Some(2)), ("bottom", "Emeria Angel", Some(3))]);
    act(&mut m, Act::ChooseMutateSide { top: true });
    settle(&mut m);
    assert_eq!(m.state.objects[&angel].name, "Vulpikeet", "the merged creature has the top card's name");
}

#[test]
fn madness_casts_for_its_cost_or_goes_to_the_graveyard() {
    let e = engine();
    let mut cards = lands(2, "Mountain");
    cards.push(("Faithless Looting", At::Hand));
    cards.push(("Fiery Temper", At::Hand));
    cards.push(("Plains", At::Hand));
    let (mut m, ids_) = table(&e, &cards);
    let (looting, temper, plains) = (ids_[2], ids_[3], ids_[4]);
    cast(&mut m, looting);
    settle(&mut m);
    // Discard two: Fiery Temper and the Plains.
    let p = pending(&m);
    assert_eq!(p.purpose, "discard");
    act(&mut m, Act::SelectCards { cards: vec![temper.0, plains.0] });
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Yesno, Answer::CastOffer, "madness"));
    assert_eq!(p.prompt, "Cast Fiery Temper for its madness cost {R}?");
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Cast for {R}"), Some("Put it into your graveyard")));
    assert_eq!(p.options.iter().map(|o| (o.name.as_str(), o.zone.as_deref(), o.eligible)).collect::<Vec<_>>(), [("Fiery Temper", Some("exile"), true)]);
    // The engine's own "no" also declines it.
    assert!(p.admits(&Act::DecideOptionalEffect { accept: false }).is_ok());
    act(&mut m, Act::CastOffer { cast: true, payment: PayMode::Auto });
    aim(&mut m, TargetView::Player { seat: 1 });
    settle(&mut m);
    assert_eq!(m.state.players[1].life, 37);
}

#[test]
fn a_miracle_reveal_and_its_cast_are_yes_or_no() {
    let e = engine();
    let (mut m, ids_) = table(&e, &[("Fiery Temper", At::Hand)]);
    let vs = |m: &Match| filter_state_for_viewer(&m.state, PlayerId(0));
    let card = ids_[0];
    let cost = engine::types::mana::ManaCost::Cost { shards: vec![engine::types::mana::ManaCostShard::Blue], generic: 1 };
    m.state.waiting_for = WaitingFor::MiracleReveal { player: PlayerId(0), object_id: card, cost: cost.clone() };
    let p = Pending::of(&vs(&m), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.purpose, p.prompt.as_str(), p.yes_label.as_deref()), ("miracle_reveal", "Reveal Fiery Temper for its miracle cost {1}{U}?", Some("Reveal it")));
    // No cast offered (it can't be paid): only the no.
    assert!(!p.options[0].eligible);
    assert!(p.admits(&Act::CastOffer { cast: true, payment: PayMode::Ask }).is_err());
    assert!(p.admits(&Act::CastOffer { cast: false, payment: PayMode::Ask }).is_ok());
    // The card is in seat 0's hand: built from seat 1's view, it isn't named.
    let theirs = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(1)), PlayerId(0), &[], &[]).unwrap();
    assert!(!theirs.prompt.contains("Fiery Temper") && theirs.options.iter().all(|o| o.name != "Fiery Temper"), "{theirs:?}");
    m.state.waiting_for = WaitingFor::CastOffer { player: PlayerId(0), kind: CastOfferKind::Miracle { object_id: card, cost } };
    let p = Pending::of(&vs(&m), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.purpose, p.prompt.as_str(), p.no_label.as_deref()), ("miracle", "Cast Fiery Temper for its miracle cost {1}{U}?", Some("Don't cast")));
}

#[test]
fn foretell_and_flashback_say_so_on_their_options() {
    let e = engine();
    let mut cards = lands(3, "Island");
    cards.push(("Saw It Coming", At::Hand));
    cards.push(("Think Twice", At::Grave));
    let (mut m, ids_) = table(&e, &cards);
    let (saw, twice) = (ids_[3], ids_[4]);
    let d = decide(&m);
    let labels = |d: &Decision, id: ObjectId| d.options.iter().filter(|o| o.object == Some(id.0)).map(|o| o.label.clone()).collect::<Vec<_>>();
    assert!(labels(&d, saw).contains(&"Foretell Saw It Coming for {2}".to_string()), "{:?}", labels(&d, saw));
    assert!(labels(&d, twice).contains(&"Cast Think Twice with flashback".to_string()), "{:?}", labels(&d, twice));
    // Foretell it: in exile, its later cast says what it costs (it needs a spell to target, so
    // the label is read straight from the card).
    let i = d.options.iter().find(|o| o.label == "Foretell Saw It Coming for {2}").unwrap().index;
    m.choose(0, d.revision, i).unwrap();
    settle(&mut m);
    assert!(m.state.exile.contains(&saw));
    assert!(m.state.objects[&saw].face_down, "foretold cards are face down");
    assert_eq!(Match::cast_label(&filter_state_for_viewer(&m.state, PlayerId(0)), &saw), "Cast Saw It Coming for its foretell cost {1}{U}");
    // Nobody else learns which card it is.
    assert_ne!(Match::cast_label(&filter_state_for_viewer(&m.state, PlayerId(1)), &saw), "Cast Saw It Coming for its foretell cost {1}{U}");
}

#[test]
fn casting_variants_and_faces_check_their_answers() {
    let e = engine();
    let (mut m, ids_) = table(&e, &[("Think Twice", At::Grave)]);
    let card = ids_[0];
    let opt = |variant| engine::types::game_state::CastingVariantChoiceOption {
        variant,
        face: engine::types::game_state::CastingVariantFace::Current,
        mana_cost: engine::types::mana::ManaCost::Cost { shards: vec![engine::types::mana::ManaCostShard::Blue], generic: 2 },
        additional_cost: None,
        authority: None,
    };
    m.state.waiting_for = WaitingFor::CastingVariantChoice {
        player: PlayerId(0),
        object_id: card,
        card_id: m.state.objects[&card].card_id,
        payment_mode: Default::default(),
        options: vec![opt(engine::types::game_state::CastingVariant::Flashback), opt(engine::types::game_state::CastingVariant::Normal)],
    };
    let vs = filter_state_for_viewer(&m.state, PlayerId(0));
    let offered = [engine::types::actions::GameAction::ChooseCastingVariant { index: 0 }];
    let p = Pending::of(&vs, PlayerId(0), &offered, &[]).unwrap();
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseCastingVariant, "variant", "Choose how to cast Think Twice"));
    assert_eq!(
        p.options.iter().map(|o| (o.name.as_str(), o.cost.as_deref(), o.eligible)).collect::<Vec<_>>(),
        [("Flashback", Some("{2}{U}"), true), ("Cast it normally", Some("{2}{U}"), false)]
    );
    assert!(p.admits(&Act::ChooseCastingVariant { index: 0 }).is_ok());
    assert!(p.admits(&Act::ChooseCastingVariant { index: 1 }).is_err(), "only what the engine offers");
    assert_eq!(
        Act::ChooseCastingVariant { index: 0 }.to_action(),
        Some(engine::types::actions::GameAction::ChooseCastingVariant { index: 0 })
    );
}

#[test]
fn every_new_answer_round_trips_through_the_engines_action() {
    use engine::types::actions::GameAction;
    let answers = [
        Act::ChooseAdventureFace { creature: true },
        Act::ChooseModalFace { back_face: true },
        Act::ChooseAlternativeCast { alternative: true },
        Act::ChooseCastingVariant { index: 2 },
        Act::ChooseMutateSide { top: false },
        Act::ChooseLegend { keep: 7 },
        Act::ChooseRingBearer { target: 8 },
        Act::Equip { equipment: 9, target: 10 },
        Act::SelectTargets { targets: vec![TargetView::Object { id: 3 }, TargetView::Player { seat: 1 }] },
        Act::MoveCounters { moves: vec![CounterMove { on: 4, counter: "P1P1".into(), count: 2 }] },
        Act::RemoveCounters { counters: vec![CounterCount { counter: "loyalty".into(), count: 1 }] },
        Act::RemoveCounterCost { counters: vec![CounterMove { on: 5, counter: "M1M1".into(), count: 1 }] },
    ];
    for a in answers {
        let action: GameAction = a.to_action().unwrap_or_else(|| panic!("{a:?} has no engine action"));
        assert_eq!(Act::from_action(&action), Some(a.clone()), "{action:?}");
        let wire = serde_json::to_value(&a).unwrap();
        assert_eq!(serde_json::from_value::<Act>(wire).unwrap(), a);
    }
    // A cast offer is matched to the engine's own options instead.
    assert_eq!(Act::CastOffer { cast: true, payment: PayMode::Ask }.to_action(), None);
    let decline = engine::types::actions::GameAction::CascadeChoice { choice: engine::types::actions::CastChoice::Decline };
    assert_eq!(Act::from_action(&decline), Some(Act::CastOffer { cast: false, payment: PayMode::Ask }));
}
