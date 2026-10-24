//! Paying by hand and the extra costs (docs/game-interactions-review-2026-10-23.md, build plan
//! section 9; GPay, GMana, GCosts) on real casts: cards from tests/fixtures/pay-cards.json (a slice
//! of phase's card data: basic lands, Battlefield Forge, Sol Ring, Strike It Rich, Gut Shot,
//! Dismember, Burst Lightning, Thrill of Possibility, Stoke the Flames, Treasure Cruise, Raging
//! Goblin, Lightning Bolt, Maha, Its Feathers Night and others) put straight onto a board at seat
//! 0's main phase, then cast through `act` as the board does.

use engine::game::deck_loading::create_object_from_card_face;
use engine::game::layers::evaluate_layers;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

use crate::act::{Answer, Kind};
use crate::pay::{PayMode, PaymentView};
use crate::{Act, ChoiceError, Decision, Engine, Match, OptionKind, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pay-cards.json")).unwrap()
}

/// A two-person game at seat 0's turn 3 main phase with priority: `field` on seat 0's
/// battlefield (untapped, none summoning sick), `hand` in its hand, `theirs` on seat 1's
/// battlefield and `grave` in seat 0's graveyard. Seat 0's commander, Combat Celebrant ({2}{R}),
/// is in the command zone. Returns the ids in the order given: field, hand, theirs, grave.
fn table(e: &Engine, field: &[&str], hand: &[&str], theirs: &[&str], grave: &[&str]) -> (Match, Vec<ObjectId>) {
    let deck = |land: &str| SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec![land.into(); 99] };
    let mut m = e.new_match_first(3, vec![deck("Plains"), deck("Plains")], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    let make = |m: &mut Match, name: &str, seat: u8, zone: Zone| {
        let face = e.database().get_face_by_name(name).unwrap_or_else(|| panic!("{name} isn't in the fixture"));
        let id = create_object_from_card_face(&mut m.state, face, PlayerId(seat));
        let p = &mut m.state.players[usize::from(seat)];
        p.library.retain(|c| *c != id);
        match zone {
            Zone::Battlefield => m.state.battlefield.push_back(id),
            Zone::Hand => p.hand.push_back(id),
            _ => p.graveyard.push_back(id),
        }
        let o = m.state.objects.get_mut(&id).unwrap();
        o.zone = zone;
        o.summoning_sick = false;
        o.controller = PlayerId(seat);
        id
    };
    let mut ids = vec![];
    for n in field {
        ids.push(make(&mut m, n, 0, Zone::Battlefield));
    }
    for n in hand {
        ids.push(make(&mut m, n, 0, Zone::Hand));
    }
    for n in theirs {
        ids.push(make(&mut m, n, 1, Zone::Battlefield));
    }
    for n in grave {
        ids.push(make(&mut m, n, 0, Zone::Graveyard));
    }
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = Phase::PreCombatMain;
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    (m, ids)
}

fn decide(m: &Match) -> Decision {
    m.decision(0).expect("seat 0 decides")
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

fn payment(m: &Match) -> PaymentView {
    decide(m).payment.expect("seat 0 is paying")
}

/// Both seats pass until the stack is empty and seat 0 has priority again.
fn settle(m: &mut Match) {
    for _ in 0..40 {
        if m.state.stack.is_empty() && matches!(m.state.waiting_for, WaitingFor::Priority { player } if player == PlayerId(0)) {
            return;
        }
        let seat = *m.waiting_on().first().expect("someone decides");
        let d = m.decision(seat).unwrap();
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap_or_else(|| panic!("seat {seat} has more than a pass: {:?}", d.prompt));
        m.choose(seat, d.revision, pass.index).unwrap();
    }
    panic!("the stack didn't settle");
}

fn tapped(m: &Match, id: ObjectId) -> bool {
    m.state.objects[&id].tapped
}

fn life(m: &Match, seat: usize) -> i32 {
    m.state.players[seat].life
}

/// The key of `source`'s choice that adds `mana` ("R"), from the payment the board is shown.
fn key(p: &PaymentView, source: ObjectId, mana: &str) -> String {
    let s = p.sources.iter().find(|s| s.id == source.0).unwrap_or_else(|| panic!("{source:?} isn't a source: {p:?}"));
    s.choices.iter().find(|c| c.mana.contains(&mana)).unwrap_or_else(|| panic!("{} makes no {mana}: {:?}", s.name, s.choices)).key.clone()
}

fn commander(m: &Match) -> ObjectId {
    m.state.command_zone.iter().copied().find(|id| m.state.objects[id].owner == PlayerId(0)).unwrap()
}

#[test]
fn paying_by_hand_taps_lands_and_a_rock_untaps_a_land_and_pays() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain", "Mountain", "Sol Ring"], &[], &[], &[]);
    let (mountain, other, sol) = (ids[0], ids[1], ids[2]);
    let celebrant = commander(&m);
    // "I'll tap": casting opens the payment.
    act(&mut m, Act::CastSpell { object: celebrant.0, payment: PayMode::Manual });
    let p = payment(&m);
    assert_eq!(p.paying_for.as_ref().map(|f| f.name.as_str()), Some("Combat Celebrant"));
    assert_eq!(p.cost, "{2}{R}");
    assert_eq!(p.pips.iter().map(|x| (x.symbol.as_str(), x.paid)).collect::<Vec<_>>(), [("R", false), ("1", false), ("1", false)]);
    assert!(p.pay_rest && p.cancel);
    let mut names: Vec<&str> = p.sources.iter().map(|s| s.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["Mountain", "Mountain", "Sol Ring"]);
    let rock = p.sources.iter().find(|s| s.id == sol.0).unwrap();
    assert_eq!((rock.choices[0].kind, rock.choices[0].text.as_str()), ("ability", "{T}: Add {C}{C}."));
    assert!(rock.choices[0].penalty.is_none(), "a rock just makes mana");
    // Tap a Mountain, give it back, and tap it again.
    act(&mut m, Act::TapMana { source: mountain.0, choice: Some(key(&p, mountain, "R")) });
    assert!(tapped(&m, mountain));
    let p = payment(&m);
    assert_eq!(p.untap, [mountain.0]);
    assert_eq!(p.pool.iter().map(|x| (x.mana, x.name.as_str())).collect::<Vec<_>>(), [("R", "Mountain")]);
    assert!(p.pips[0].paid && !p.pips[1].paid);
    act(&mut m, Act::UntapMana { source: mountain.0 });
    assert!(!tapped(&m, mountain));
    assert!(payment(&m).pool.is_empty());
    // A source that isn't tapped can't be untapped.
    assert!(refused(&mut m, Act::UntapMana { source: other.0 }).contains("can be untapped"));
    act(&mut m, Act::TapMana { source: mountain.0, choice: None });
    act(&mut m, Act::TapMana { source: sol.0, choice: None });
    let p = payment(&m);
    assert!(p.pips.iter().all(|x| x.paid), "{:?}", p.pips);
    // The main button pays: the engine's pass during payment.
    let d = decide(&m);
    let rest = d.options.iter().find(|o| o.kind == OptionKind::PayRest).expect("pay the rest");
    m.choose(0, d.revision, rest.index).unwrap();
    settle(&mut m);
    assert!(m.state.battlefield.contains(&celebrant), "Combat Celebrant resolved");
    assert!(!tapped(&m, other), "the other Mountain wasn't needed");
}

#[test]
fn a_painland_hurts_and_cancelling_gives_back_only_what_it_can() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Battlefield Forge", "Mountain", "Mountain"], &[], &[], &[]);
    let (forge, mountain) = (ids[0], ids[1]);
    let celebrant = commander(&m);
    act(&mut m, Act::CastSpell { object: celebrant.0, payment: PayMode::Manual });
    let p = payment(&m);
    let f = p.sources.iter().find(|s| s.id == forge.0).unwrap();
    // {C} for free, {R} or {W} for 1 damage, as the engine classifies them.
    let damage: Vec<_> = f.choices.iter().map(|c| (c.mana.join(""), c.penalty.map(|x| (x.kind, x.amount)))).collect();
    assert!(damage.contains(&("C".into(), None)), "{damage:?}");
    assert!(damage.contains(&("R".into(), Some(("damage", Some(1))))), "{damage:?}");
    act(&mut m, Act::TapMana { source: forge.0, choice: Some(key(&p, forge, "R")) });
    assert_eq!(life(&m, 0), 39);
    act(&mut m, Act::TapMana { source: mountain.0, choice: None });
    let p = payment(&m);
    // The Mountain can be untapped; the Forge's damage is done, and the board says so.
    assert_eq!(p.untap, [mountain.0]);
    assert_eq!(p.kept.iter().map(|k| (k.name.as_str(), k.penalty.kind)).collect::<Vec<_>>(), [("Battlefield Forge", "damage")]);
    assert!(refused(&mut m, Act::UntapMana { source: forge.0 }).contains("can be untapped"));
    // Cancel: the spell goes back, the Mountain untaps with it, and the damage stays.
    act(&mut m, Act::CancelCast);
    assert!(m.state.command_zone.contains(&celebrant));
    assert!(!tapped(&m, mountain), "cancelling untaps what the engine can give back");
    assert!(tapped(&m, forge));
    assert_eq!(life(&m, 0), 39);
    assert!(m.kept.is_empty(), "the note ends with the payment");
    // Each step is in the replay log: the untap before the cancel.
    let kinds: Vec<String> = m.log.actions.iter().rev().take(2).map(|a| format!("{:?}", a.action).split([' ', '{', '(']).next().unwrap().to_string()).collect();
    assert_eq!(kinds, ["CancelCast", "UntapLandForMana"]);
}

/// Strike It Rich makes a Treasure; then the commander needs it as well as two Mountains.
fn with_treasure(e: &Engine) -> (Match, ObjectId) {
    let (mut m, ids) = table(e, &["Mountain", "Mountain", "Mountain"], &["Strike It Rich"], &[], &[]);
    act(&mut m, Act::CastSpell { object: ids[3].0, payment: PayMode::Ask });
    settle(&mut m);
    let treasure = m.state.battlefield.iter().copied().find(|id| m.state.objects[id].name == "Treasure").expect("a Treasure");
    // Strike It Rich took one Mountain; the commander takes the other two and the Treasure.
    let celebrant = commander(&m);
    act(&mut m, Act::CastSpell { object: celebrant.0, payment: PayMode::Ask });
    (m, treasure)
}

#[test]
fn a_treasure_asks_before_it_is_sacrificed_and_keep_it_pays_by_hand() {
    let e = engine();
    let (mut m, treasure) = with_treasure(&e);
    let d = decide(&m);
    let p = d.pending.expect("the Treasure prompt");
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::TapMana, "mana_source", "Sacrifice Treasure for mana?"));
    assert_eq!(p.options.iter().map(|o| o.id.clone()).collect::<Vec<_>>(), [treasure.0.to_string()]);
    assert_eq!(serde_json::to_value(&p).unwrap()["defaultAnswer"], serde_json::json!([treasure.0.to_string()]));
    // The automatic part is done: two Mountains' mana is in the pool.
    assert_eq!(d.payment.unwrap().pool.len(), 2);
    // Keep it: pay by hand, with the Treasure still there to use or not.
    act(&mut m, Act::KeepMana);
    assert!(matches!(m.state.waiting_for, WaitingFor::ManaPayment { .. }));
    let p = payment(&m);
    let t = p.sources.iter().find(|s| s.id == treasure.0).expect("the Treasure is a source");
    assert_eq!(t.choices[0].penalty.map(|x| x.kind), Some("sacrifice"));
    assert!(m.state.battlefield.contains(&treasure));
}

#[test]
fn a_treasure_sacrificed_asks_its_colour_and_stays_gone() {
    let e = engine();
    let (mut m, treasure) = with_treasure(&e);
    act(&mut m, Act::TapMana { source: treasure.0, choice: None });
    // Any colour: the engine asks which.
    let p = decide(&m).pending.expect("a colour");
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseManaColor, "color", "Choose a colour of mana"));
    assert!(p.options.iter().any(|o| o.id == "R" && o.name == "Red"), "{:?}", p.options);
    assert!(refused(&mut m, Act::ChooseManaColor { mana: vec!["R".into(), "G".into()], combination: false }).contains("colours"));
    act(&mut m, Act::ChooseManaColor { mana: vec!["R".into()], combination: false });
    assert!(!m.state.battlefield.contains(&treasure));
    // Back at the payment: paid in full, with the Treasure noted as gone for good.
    let p = payment(&m);
    assert!(p.pips.iter().all(|x| x.paid), "{p:?}");
    assert_eq!(p.kept.iter().map(|k| k.penalty.kind).collect::<Vec<_>>(), ["sacrifice"]);
    let d = decide(&m);
    m.choose(0, d.revision, d.options.iter().find(|o| o.kind == OptionKind::PayRest).unwrap().index).unwrap();
    settle(&mut m);
    assert!(m.state.battlefield.contains(&commander_on_field(&m)));
}

fn commander_on_field(m: &Match) -> ObjectId {
    m.state.battlefield.iter().copied().find(|id| m.state.objects[id].name == "Combat Celebrant").expect("the commander resolved")
}

#[test]
fn always_auto_sacrifices_without_asking() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain", "Mountain", "Mountain"], &["Strike It Rich"], &[], &[]);
    act(&mut m, Act::CastSpell { object: ids[3].0, payment: PayMode::Ask });
    settle(&mut m);
    let celebrant = commander(&m);
    act(&mut m, Act::CastSpell { object: celebrant.0, payment: PayMode::Auto });
    // Either it's cast, or the engine asks only for the Treasure's colour.
    if let Some(p) = m.decision(0).and_then(|d| d.pending) {
        assert_eq!(p.answer, Answer::ChooseManaColor);
        act(&mut m, Act::ChooseManaColor { mana: vec!["R".into()], combination: false });
    }
    settle(&mut m);
    commander_on_field(&m);
}

#[test]
fn phyrexian_mana_is_paid_with_mana_or_life_per_symbol() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain", "Swamp"], &["Gut Shot", "Dismember"], &["Grizzly Bears"], &[]);
    let (gut, dismember) = (ids[2], ids[3]);
    act(&mut m, Act::CastSpell { object: gut.0, payment: PayMode::Ask });
    // Gut Shot targets first.
    act(&mut m, Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) });
    let p = decide(&m).pending.expect("Phyrexian mana");
    assert_eq!((p.answer, p.purpose, p.min, p.max), (Answer::PayPhyrexian, "phyrexian", 0, 1));
    assert_eq!((p.options[0].name.as_str(), p.options[0].cost.as_deref(), p.options[0].eligible), ("{R/P}", Some("{R}"), true));
    // The default costs no life: a Mountain can pay it.
    assert_eq!(serde_json::to_value(&p).unwrap()["defaultAnswer"], serde_json::json!([]));
    assert!(refused(&mut m, Act::PayPhyrexian { life: vec![] }).contains("each Phyrexian symbol"));
    act(&mut m, Act::PayPhyrexian { life: vec![true] });
    assert_eq!(life(&m, 0), 38, "2 life for the symbol");
    settle(&mut m);
    // Dismember's two {B/P} with one Swamp: either may be mana, not both.
    act(&mut m, Act::CastSpell { object: dismember.0, payment: PayMode::Ask });
    let mut target_steps = 0;
    while let Some(p) = m.decision(0).and_then(|d| d.pending).filter(|p| p.answer == Answer::ChooseTarget) {
        let t = p.options.iter().find(|o| o.eligible).unwrap().id.clone();
        act(&mut m, Act::ChooseTarget { target: Some(TargetView::Object { id: t.parse().unwrap() }) });
        target_steps += 1;
        assert!(target_steps < 3);
    }
    let p = decide(&m).pending.expect("Phyrexian mana");
    assert_eq!(p.answer, Answer::PayPhyrexian);
    assert_eq!(p.rest.as_deref(), Some("{1}"));
    // The default is a way the mana can pay: one symbol with the Swamp, the other with life.
    let default = serde_json::to_value(&p).unwrap()["defaultAnswer"].clone();
    assert_eq!(default.as_array().map(Vec::len), Some(1), "{default}");
    let why = refused(&mut m, Act::PayPhyrexian { life: vec![false, false] });
    assert!(why.contains("mana to pay that way"), "{why}");
}

#[test]
fn kicker_is_a_choice_between_the_two_costs() {
    let e = engine();
    let field = ["Mountain"; 5];
    let (mut m, ids) = table(&e, &field, &["Burst Lightning"], &[], &[]);
    act(&mut m, Act::CastSpell { object: ids[5].0, payment: PayMode::Ask });
    // phase takes the target first, then the kicker.
    act(&mut m, Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) });
    let p = decide(&m).pending.expect("kicker");
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::DecideOptionalCost, "kicker", "Pay the kicker, {4}?"));
    let rows: Vec<_> = p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.cost.as_deref())).collect();
    assert_eq!(rows, [("pay", "Kicked", Some("{4}{R}")), ("skip", "Not kicked", Some("{R}"))]);
    act(&mut m, Act::DecideOptionalCost { pay: true });
    settle(&mut m);
    assert_eq!(life(&m, 1), 36, "kicked: 4 damage");
    assert!(ids[..5].iter().all(|id| tapped(&m, *id)), "five mana paid");
}

#[test]
fn ward_warns_that_the_spell_is_countered_then_asks_for_the_discard() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain"], &["Lightning Bolt", "Plains"], &["Maha, Its Feathers Night"], &[]);
    let (bolt, plains, maha) = (ids[1], ids[2], ids[3]);
    act(&mut m, Act::CastSpell { object: bolt.0, payment: PayMode::Ask });
    act(&mut m, Act::ChooseTarget { target: Some(TargetView::Object { id: maha.0 }) });
    // Ward triggers; both pass until the ward asks seat 0 to pay.
    for _ in 0..20 {
        if m.decision(0).and_then(|d| d.pending).is_some() {
            break;
        }
        let seat = m.waiting_on()[0];
        let d = m.decision(seat).unwrap();
        m.choose(seat, d.revision, d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap().index).unwrap();
    }
    let p = decide(&m).pending.expect("ward");
    assert_eq!((p.kind, p.answer), (Kind::Yesno, Answer::PayUnlessCost));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Maha, Its Feathers Night"));
    assert_eq!(p.warn.as_deref(), Some("If you don't discard, your Lightning Bolt is countered."));
    act(&mut m, Act::PayUnlessCost { pay: true });
    let p = decide(&m).pending.expect("the discard");
    assert_eq!((p.answer, p.purpose, p.prompt.as_str(), p.min, p.max), (Answer::SelectCards, "ward", "Ward: discard a card", 1, 1));
    act(&mut m, Act::SelectCards { cards: vec![plains.0] });
    assert!(m.state.players[0].graveyard.contains(&plains));
    settle(&mut m);
    assert!(m.state.players[0].graveyard.contains(&bolt), "the Bolt resolved");
}

#[test]
fn a_discard_cost_is_a_pick_from_the_hand() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain", "Mountain"], &["Thrill of Possibility", "Plains"], &[], &[]);
    act(&mut m, Act::CastSpell { object: ids[2].0, payment: PayMode::Ask });
    let p = decide(&m).pending.expect("the discard");
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::SelectCards, "cost", "Discard a card to cast Thrill of Possibility"));
    // The hand is Plains, the starting hand's and this one.
    assert!(p.options.iter().all(|o| o.name == "Plains") && p.options.iter().any(|o| o.id == ids[3].0.to_string()));
    assert_eq!((p.min, p.max), (1, 1));
    assert!(decide(&m).options.iter().any(|o| o.kind == OptionKind::Cancel), "and it can be cancelled");
    act(&mut m, Act::SelectCards { cards: vec![ids[3].0] });
    settle(&mut m);
    assert!(m.state.players[0].graveyard.contains(&ids[3]));
}

#[test]
fn convoke_taps_creatures_toward_the_cost() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain", "Mountain", "Mountain", "Raging Goblin"], &["Stoke the Flames"], &[], &[]);
    let goblin = ids[3];
    act(&mut m, Act::CastSpell { object: ids[4].0, payment: PayMode::Ask });
    act(&mut m, Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) });
    let p = payment(&m);
    assert_eq!(p.convoke, Some("convoke"));
    let g = p.sources.iter().find(|s| s.id == goblin.0).expect("the Goblin can convoke");
    let ways: Vec<_> = g.choices.iter().map(|c| (c.kind, c.text.as_str())).collect();
    assert!(ways.contains(&("convoke", "Tap it to pay {R}")) && ways.contains(&("convoke", "Tap it to pay {1}")), "{ways:?}");
    act(&mut m, Act::TapMana { source: goblin.0, choice: Some("convoke:R".into()) });
    assert!(tapped(&m, goblin));
    let p = payment(&m);
    assert_eq!(p.pool.iter().filter(|x| x.convoke).count(), 1);
    for id in &ids[..3] {
        act(&mut m, Act::TapMana { source: id.0, choice: None });
    }
    assert!(payment(&m).pips.iter().all(|x| x.paid));
    let d = decide(&m);
    m.choose(0, d.revision, d.options.iter().find(|o| o.kind == OptionKind::PayRest).unwrap().index).unwrap();
    settle(&mut m);
    assert_eq!(life(&m, 1), 36);
}

#[test]
fn delve_exiles_graveyard_cards_toward_the_cost() {
    let e = engine();
    let field = ["Island"; 4];
    let (mut m, ids) = table(&e, &field, &["Treasure Cruise"], &[], &["Plains", "Plains", "Plains", "Plains"]);
    act(&mut m, Act::CastSpell { object: ids[4].0, payment: PayMode::Ask });
    let p = payment(&m);
    assert_eq!(p.convoke, Some("delve"));
    let grave: Vec<_> = p.sources.iter().filter(|s| s.zone == "graveyard").collect();
    assert_eq!(grave.len(), 4);
    assert_eq!(grave[0].choices[0].kind, "delve");
    for id in &ids[5..] {
        act(&mut m, Act::TapMana { source: id.0, choice: None });
    }
    for id in &ids[..4] {
        act(&mut m, Act::TapMana { source: id.0, choice: None });
    }
    let d = decide(&m);
    m.choose(0, d.revision, d.options.iter().find(|o| o.kind == OptionKind::PayRest).unwrap().index).unwrap();
    settle(&mut m);
    assert!(ids[5..].iter().all(|id| m.state.exile.contains(id)), "the four cards were exiled");
}

#[test]
fn the_auto_tap_preview_names_the_lands_paying_would_tap() {
    let e = engine();
    let (m, ids) = table(&e, &["Mountain", "Mountain", "Mountain", "Mountain"], &["Lightning Bolt"], &[], &[]);
    let celebrant = commander(&m);
    let mut sources = m.auto_tap_preview(0, celebrant.0);
    sources.sort_unstable();
    assert_eq!(sources.len(), 3, "{{2}}{{R}} taps three Mountains");
    assert!(sources.iter().all(|s| ids[..4].iter().any(|id| id.0 == *s)));
    // Nothing changed, and nothing is previewed for a card that can't be cast or another seat.
    assert!(ids[..4].iter().all(|id| !tapped(&m, *id)));
    assert!(m.auto_tap_preview(1, celebrant.0).is_empty());
    assert!(m.auto_tap_preview(0, 999_999).is_empty());
}

#[test]
fn casting_through_act_needs_your_priority_and_a_card_you_can_cast() {
    let e = engine();
    let (mut m, ids) = table(&e, &["Mountain"], &["Treasure Cruise"], &[], &[]);
    assert!(refused(&mut m, Act::CastSpell { object: ids[1].0, payment: PayMode::Ask }).contains("can't be cast"));
    assert!(refused(&mut m, Act::TapMana { source: ids[0].0, choice: None }).contains("nothing to pay"));
    assert!(refused(&mut m, Act::KeepMana).contains("buttons"));
    // The wire form.
    let json = serde_json::to_value(Act::CastSpell { object: 7, payment: PayMode::Manual }).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "cast_spell", "object": 7, "payment": "manual" }));
    let back: Act = serde_json::from_value(serde_json::json!({ "kind": "cast_spell", "object": 7 })).unwrap();
    assert_eq!(back, Act::CastSpell { object: 7, payment: PayMode::Ask });
}

#[test]
fn payment_answers_round_trip_through_the_engines_actions() {
    use engine::types::actions::GameAction;
    use engine::types::game_state::ShardChoice;
    let tap = GameAction::TapForConvoke { object_id: ObjectId(4), mana_type: engine::types::mana::ManaType::Green };
    assert_eq!(Act::from_action(&tap), Some(Act::TapMana { source: 4, choice: Some("convoke:G".into()) }));
    let ab = GameAction::ActivateAbility { source_id: ObjectId(5), ability_index: 0 };
    assert_eq!(Act::from_action(&ab), None, "an ability at priority is an ordinary option");
    assert_eq!(Act::from_payment_action(&ab), Some(Act::TapMana { source: 5, choice: Some("ability:0".into()) }));
    let phy = GameAction::SubmitPhyrexianChoices { choices: vec![ShardChoice::PayLife, ShardChoice::PayMana] };
    let a = Act::from_action(&phy).unwrap();
    assert_eq!(a, Act::PayPhyrexian { life: vec![true, false] });
    assert_eq!(a.to_action(), Some(phy));
    let colours = Act::ChooseManaColor { mana: vec!["W".into(), "U".into()], combination: true };
    assert_eq!(Act::from_action(&colours.to_action().unwrap()), Some(colours));
    assert_eq!(Act::UntapMana { source: 3 }.to_action(), Some(GameAction::UntapLandForMana { object_id: ObjectId(3) }));
    assert_eq!(Act::KeepMana.to_action(), Some(GameAction::BackToManaPayment));
    assert_eq!(Act::DecideOptionalCost { pay: false }.kind(), "decide_optional_cost");
}


/// A real spell being cast and its ability, to build the engine's rarer payment prompts around.
fn casting(e: &Engine) -> (Match, ObjectId, Box<engine::types::game_state::PendingCast>) {
    let (mut m, ids) = table(e, &["Mountain", "Mountain", "Mountain"], &[], &["Grizzly Bears"], &[]);
    let celebrant = commander(&m);
    act(&mut m, Act::CastSpell { object: celebrant.0, payment: PayMode::Manual });
    let pending = m.state.pending_cast.clone().expect("a spell being cast");
    (m, ids[3], pending)
}

fn pending_of(m: &Match, candidates: &[engine::types::actions::GameAction]) -> crate::Pending {
    let vs = engine::game::filter_state_for_viewer(&m.state, PlayerId(0));
    crate::Pending::of(&vs, PlayerId(0), candidates, &[]).expect("a pending decision")
}

#[test]
fn the_rarer_costs_take_the_shapes_of_the_widgets() {
    use engine::types::ability::{AbilityCost, AdditionalCost, AdditionalCostOrigin, AdditionalCostRepeatability, ChoiceType, QuantityExpr};
    use engine::types::actions::GameAction;
    use engine::types::game_state::{CostResume, ManaChoiceContext, ManaChoicePrompt, PayCostKind};
    use engine::types::mana::{ManaCost, ManaCostShard, ManaType};
    let e = engine();
    let (mut m, bears, cast) = casting(&e);
    let mountains: Vec<ObjectId> = m.state.battlefield.iter().copied().filter(|id| m.state.objects[id].name == "Mountain").collect();
    let me = PlayerId(0);

    // An activation's alternative costs: only those the engine can pay are offered.
    m.state.waiting_for = WaitingFor::ActivationCostOneOfChoice {
        player: me,
        costs: vec![AbilityCost::Mana { cost: ManaCost::Cost { shards: vec![], generic: 2 } }, AbilityCost::PayLife { amount: QuantityExpr::Fixed { value: 3 } }],
        pending_cast: cast.clone(),
    };
    let p = pending_of(&m, &[GameAction::ChooseActivationCostBranch { index: 1 }]);
    assert_eq!((p.answer, p.purpose), (Answer::ChooseCostBranch, "cost_branch"));
    assert_eq!(p.options.iter().map(|o| (o.name.as_str(), o.eligible)).collect::<Vec<_>>(), [("{2}", false), ("Pay 3 life", true)]);
    assert!(p.admits(&Act::ChooseCostBranch { index: 1 }).is_ok());
    assert!(p.admits(&Act::ChooseCostBranch { index: 0 }).is_err());

    // A creature type to behold: the engine's list, as a name widget.
    m.state.waiting_for = WaitingFor::CostTypeChoice {
        player: me,
        choice_type: ChoiceType::CreatureType { options: vec![] },
        options: vec!["Goblin".into(), "Human".into()],
        pending_cast: cast.clone(),
    };
    let p = pending_of(&m, &[]);
    assert_eq!((p.kind, p.answer, p.prompt.as_str(), p.free_entry), (Kind::Text, Answer::ChooseOption, "Choose a creature type", Some(false)));
    assert!(p.admits(&Act::ChooseOption { choice: "Goblin".into() }).is_ok());
    assert!(p.admits(&Act::ChooseOption { choice: "Elf".into() }).is_err());

    // Several mana of any colours: a split of the total; a filter land's combinations: a pick.
    let ability = Box::new(cast.ability.as_ref().clone());
    m.state.waiting_for = WaitingFor::ChooseManaColor {
        player: me,
        choice: ManaChoicePrompt::AnyCombination { count: 2, options: vec![ManaType::White, ManaType::Green] },
        context: ManaChoiceContext::ResolvingEffect(ability.clone()),
    };
    let p = pending_of(&m, &[]);
    assert_eq!((p.kind, p.purpose, p.total, p.unit), (Kind::Split, "colors", Some(2), Some("mana")));
    assert!(p.admits(&Act::ChooseManaColor { mana: vec!["W".into(), "G".into()], combination: true }).is_ok());
    assert!(p.admits(&Act::ChooseManaColor { mana: vec!["W".into()], combination: true }).is_err(), "one for each mana");
    m.state.waiting_for = WaitingFor::ChooseManaColor {
        player: me,
        choice: ManaChoicePrompt::Combination { options: vec![vec![ManaType::White, ManaType::Blue], vec![ManaType::Blue, ManaType::Blue]] },
        context: ManaChoiceContext::ResolvingEffect(ability.clone()),
    };
    let p = pending_of(&m, &[]);
    assert_eq!(p.options.iter().map(|o| (o.id.as_str(), o.name.as_str())).collect::<Vec<_>>(), [("WU", "{W}{U}"), ("UU", "{U}{U}")]);
    assert!(p.admits(&Act::ChooseManaColor { mana: vec!["W".into(), "U".into()], combination: true }).is_ok());

    // Sacrificing as a cost: a pick of the permanents, named by what it's for.
    m.state.waiting_for = WaitingFor::PayCost {
        player: me,
        kind: PayCostKind::Sacrifice,
        choices: mountains.clone(),
        count: 1,
        min_count: 0,
        resume: CostResume::Spell { spell: cast.clone() },
    };
    let p = pending_of(&m, &[]);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str(), p.min, p.max), (Answer::SelectCards, "cost", "Sacrifice a permanent to cast Combat Celebrant", 1, 1));

    // Ward asking for permanents with enough total power, and a bounce as an unless cost.
    m.state.waiting_for = WaitingFor::WardSacrificeChoice { player: me, permanents: mountains.clone(), pending_effect: ability.clone(), remaining: 1, min_total_power: Some(2) };
    let p = pending_of(&m, &[]);
    assert_eq!((p.purpose, p.need, p.up_to), ("ward", Some(2), true));
    m.state.waiting_for = WaitingFor::UnlessBounceChoice { player: me, permanents: mountains.clone(), pending_effect: ability.clone(), remaining: 2 };
    assert_eq!(pending_of(&m, &[]).prompt, "Return a permanent to its owner's hand, 2 to go");

    // An optional cost that isn't kicker, and a multikicker asking again.
    let optional = |cost: AdditionalCost, times_kicked: u32, origin: AdditionalCostOrigin| WaitingFor::OptionalCostChoice {
        player: me,
        cost,
        times_kicked,
        origin,
        gift_kind: None,
        pending_cast: cast.clone(),
    };
    m.state.waiting_for = optional(
        AdditionalCost::Optional { cost: AbilityCost::PayLife { amount: QuantityExpr::Fixed { value: 2 } }, repeatability: AdditionalCostRepeatability::Once },
        0,
        AdditionalCostOrigin::Other,
    );
    let p = pending_of(&m, &[GameAction::DecideOptionalCost { pay: false }]);
    assert_eq!((p.purpose, p.prompt.as_str()), ("optional", "Extra cost: Pay 2 life?"));
    assert_eq!(serde_json::to_value(&p).unwrap()["defaultAnswer"], serde_json::json!(["skip"]));
    m.state.waiting_for = optional(
        AdditionalCost::Kicker { costs: vec![AbilityCost::Mana { cost: ManaCost::Cost { shards: vec![ManaCostShard::Red], generic: 1 } }], repeatability: AdditionalCostRepeatability::Once },
        2,
        AdditionalCostOrigin::Kicker,
    );
    let p = pending_of(&m, &[]);
    assert_eq!(p.prompt, "Kicked 2 times. Kick it again for {1}{R}?");
    assert_eq!(p.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Kick again", "Stop kicking"]);
    let _ = bears;
}
