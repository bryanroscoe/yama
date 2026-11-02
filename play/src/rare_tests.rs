//! The rarer cards and rules (rare.rs, remember.rs; GRareCards, GRareRules) on real casts: cards
//! from tests/fixtures/rare-cards.json (a slice of phase's card data: basic lands, Combat
//! Celebrant, Kenrith, the Returned King, Exalted Angel, Saw It Coming, Ninja of the Deep Hours,
//! Jegantha, the Wellspring, Gisela and Bruna, Last Thoughts, Fates' Reversal, Wibbly-wobbly,
//! Timey-wimey, Rotating Fireplace, Serum Powder, Rhystic Study, Opt, Shock and a few creatures)
//! put straight onto a board of two people at seat 0's main phase, then answered through `act` as
//! the board does. Decisions the engine raises only with its loop detection on (shortcuts) are
//! checked from states built by hand here, and from real loops in loop_tests.rs.

use engine::game::layers::evaluate_layers;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use serde_json::json;

use crate::act::{Answer, Kind};
use crate::pay::PayMode;
use crate::{Act, AttackAt, ChoiceError, Engine, Match, OptionKind, Pending, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rare-cards.json")).unwrap()
}

/// Where a card starts.
#[derive(Clone, Copy)]
enum At {
    Field,
    Hand,
    /// On seat 1's battlefield.
    Theirs,
}

/// A game of two people (Ana, seat 0, and Ben) at seat 0's turn 3 main phase with priority: each
/// card where it's asked for, untapped and able to attack. Returns the ids in the order given.
fn table(cards: &[(&str, At)]) -> (Match, Vec<ObjectId>) {
    let e = engine();
    let deck = |seat: usize| {
        let mut main: Vec<String> = cards.iter().filter(|(_, at)| usize::from(matches!(at, At::Theirs)) == seat).map(|(n, _)| n.to_string()).collect();
        main.resize(99, "Mountain".into());
        SeatDeck { commander: vec!["Combat Celebrant".into()], main, ..Default::default() }
    };
    let mut m = e.new_match_first(3, vec![deck(0), deck(1)], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    let mut ids = vec![];
    for (name, at) in cards {
        let seat = usize::from(matches!(at, At::Theirs));
        let p = &m.state.players[seat];
        let id = p
            .library
            .iter()
            .chain(p.hand.iter())
            .copied()
            .find(|id| m.state.objects[id].name == *name && !ids.contains(id))
            .unwrap_or_else(|| panic!("{name} isn't in the deck"));
        let p = &mut m.state.players[seat];
        p.library.retain(|c| *c != id);
        p.hand.retain(|c| *c != id);
        let zone = match at {
            At::Field | At::Theirs => {
                m.state.battlefield.push_back(id);
                Zone::Battlefield
            }
            At::Hand => {
                m.state.players[seat].hand.push_back(id);
                Zone::Hand
            }
        };
        let o = m.state.objects.get_mut(&id).unwrap();
        o.zone = zone;
        o.summoning_sick = false;
        o.controller = PlayerId(seat as u8);
        ids.push(id);
    }
    main_phase(&mut m);
    (m, ids)
}

fn main_phase(m: &mut Match) {
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = Phase::PreCombatMain;
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
}

fn lands(n: usize, name: &'static str) -> Vec<(&'static str, At)> {
    vec![(name, At::Field); n]
}

fn pending_of(m: &Match, seat: u8) -> Pending {
    let d = m.decision(seat).unwrap_or_else(|| panic!("seat {seat} doesn't decide; {:?} does", m.waiting_on()));
    d.pending.unwrap_or_else(|| panic!("no pending for {:?}", m.state.waiting_for))
}

fn pending(m: &Match) -> Pending {
    pending_of(m, 0)
}

fn act_as(m: &mut Match, seat: u8, a: Act) {
    let d = m.decision(seat).unwrap_or_else(|| panic!("seat {seat} doesn't decide"));
    m.act(seat, d.revision, &a).unwrap_or_else(|e| panic!("{a:?} refused: {e}"));
}

fn act(m: &mut Match, a: Act) {
    act_as(m, 0, a);
}

fn refused(m: &mut Match, a: Act) -> String {
    let d = m.decision(0).unwrap();
    match m.act(0, d.revision, &a) {
        Err(ChoiceError::DoesntFit(why)) | Err(ChoiceError::Rejected(why)) => why,
        other => panic!("{a:?} wasn't refused: {other:?}"),
    }
}

fn cast(m: &mut Match, id: ObjectId) {
    act(m, Act::CastSpell { object: id.0, payment: PayMode::Auto });
}

/// Everyone passes until someone is asked something other than priority, or the stack is empty
/// with seat 0 to act. Returns the seat asked.
fn settle(m: &mut Match) -> u8 {
    for _ in 0..80 {
        let seat = *m.waiting_on().first().expect("someone decides");
        let d = m.decision(seat).unwrap();
        if d.pending.is_some() {
            return seat;
        }
        if seat == 0 && m.state.stack.is_empty() && matches!(m.state.waiting_for, WaitingFor::Priority { .. }) {
            return 0;
        }
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap_or_else(|| panic!("seat {seat} has more than a pass: {:?}", d.prompt));
        m.choose(seat, d.revision, pass.index).unwrap();
    }
    panic!("the stack didn't settle");
}

fn ids(p: &Pending) -> Vec<String> {
    p.options.iter().map(|o| o.id.clone()).collect()
}

fn untap_all(m: &mut Match) {
    for id in m.state.battlefield.clone() {
        m.state.objects.get_mut(&id).unwrap().tapped = false;
    }
}

/// A seat's whole view, as the server sends it, for checking what it never names.
fn wire(m: &Match, seat: Option<u8>) -> String {
    serde_json::to_string(&m.view(seat)).unwrap()
}

// ── morph and face-down cards ───────────────────────────────────────────────

#[test]
fn a_morph_is_cast_face_down_and_only_its_controller_sees_what_it_is() {
    let mut cards = lands(6, "Plains");
    cards.push(("Exalted Angel", At::Hand));
    let (mut m, cs) = table(&cards);
    let angel = cs[6];
    cast(&mut m, angel);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseAlternativeCast, "face_down", "Pay the mana cost, or cast it face down?"));
    let costs: Vec<_> = p.options.iter().map(|o| (o.id.as_str(), o.cost.as_deref())).collect();
    assert_eq!(costs, [("normal", Some("{4}{W}{W}")), ("alternative", Some("{3}"))]);
    act(&mut m, Act::ChooseAlternativeCast { alternative: true });
    // On the stack: a face-down spell, named only for its caster.
    let mine = m.view(Some(0));
    let theirs = m.view(Some(1));
    assert_eq!(mine.stack[0].name, "A face-down spell");
    assert_eq!(mine.stack[0].under.as_deref(), Some("Exalted Angel"));
    assert_eq!(theirs.stack[0].under, None);
    assert!(!wire(&m, Some(1)).contains("Exalted Angel"), "Ben's view never names it");
    assert!(!wire(&m, None).contains("Exalted Angel"), "nor does a spectator's");
    settle(&mut m);
    // On the battlefield: a 2/2 with no name; its controller knows what it is.
    let tile = |m: &Match, seat: Option<u8>| m.view(seat).battlefield.into_iter().find(|c| c.id == angel.0).unwrap();
    let (a, b) = (tile(&m, Some(0)), tile(&m, Some(1)));
    assert!(a.face_down && b.face_down);
    assert_eq!((a.name.as_str(), a.power, a.toughness), ("Face-down card", Some(2), Some(2)));
    assert_eq!(a.under.as_deref(), Some("Exalted Angel"));
    assert_eq!((b.name.as_str(), b.under.as_deref(), b.power), ("Face-down card", None, Some(2)));
    assert!(!wire(&m, Some(1)).contains("Exalted Angel"));
    // Turning it face up is a special action with its morph cost, offered to its controller only.
    untap_all(&mut m);
    let d = m.decision(0).unwrap();
    let up = d.options.iter().find(|o| o.kind == OptionKind::FaceUp).expect("turn it face up");
    assert_eq!((up.label.as_str(), up.cost.as_deref(), up.object), ("Turn Exalted Angel face up for {2}{W}{W}", Some("{2}{W}{W}"), Some(angel.0)));
    assert!(refused(&mut m, Act::TurnFaceUp { object: cs[0].0 }).contains("can't be done now"));
    let wire_act = serde_json::to_value(Act::TurnFaceUp { object: angel.0 }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "turn_face_up", "object": angel.0 }));
    assert_eq!(serde_json::from_value::<Act>(wire_act).unwrap(), Act::TurnFaceUp { object: angel.0 });
    act(&mut m, Act::TurnFaceUp { object: angel.0 });
    // Face up, everyone sees it.
    let b = tile(&m, Some(1));
    assert!(!b.face_down);
    assert_eq!(b.name, "Exalted Angel");
}

#[test]
fn a_morph_cost_with_no_printed_form_shows_no_cost_not_the_mana_cost() {
    use engine::types::ability::AbilityCost;
    use engine::types::keywords::{Keyword, MorphCost};
    let mut cards = lands(6, "Plains");
    cards.push(("Exalted Angel", At::Hand));
    let (mut m, cs) = table(&cards);
    let angel = cs[6];
    cast(&mut m, angel);
    act(&mut m, Act::ChooseAlternativeCast { alternative: true });
    settle(&mut m);
    assert_eq!(crate::rare::face_up_cost(&m.state, &angel).as_deref(), Some("{2}{W}{W}"));
    // A non-mana morph cost Yama can't print: the card still has a morph cost, so its mana
    // cost ({4}{W}{W}, a manifested creature's way up) must not stand in for it.
    let back = m.state.objects.get_mut(&angel).unwrap().back_face.as_mut().unwrap();
    for k in back.keywords.iter_mut() {
        if matches!(k, Keyword::Morph(_)) {
            *k = Keyword::Morph(MorphCost::NonMana(AbilityCost::CollectEvidence { amount: 3 }));
        }
    }
    assert_eq!(crate::rare::face_up_cost(&m.state, &angel), None);
}

#[test]
fn a_manifested_card_stays_hidden_from_everyone_but_its_controller() {
    let mut cards = lands(2, "Forest");
    cards.push(("Manifest Dread", At::Hand));
    let (mut m, cs) = table(&cards);
    cast(&mut m, cs[2]);
    assert_eq!(settle(&mut m), 0);
    let p = pending(&m);
    assert_eq!(p.purpose, "manifest");
    let pick = p.options[0].id.parse::<u64>().unwrap();
    let name = p.options[0].name.clone();
    act(&mut m, Act::SelectCards { cards: vec![pick] });
    settle(&mut m);
    let mine = m.view(Some(0)).battlefield.into_iter().find(|c| c.id == pick).unwrap();
    let theirs = m.view(Some(1)).battlefield.into_iter().find(|c| c.id == pick).unwrap();
    assert_eq!(mine.under.as_deref(), Some(name.as_str()));
    assert_eq!((theirs.name.as_str(), theirs.under.as_deref()), ("Face-down card", None));
}

// ── ninjutsu ──────────────────────────────────────────────────────────────

/// Pass priority until `until` holds.
fn pass_until(m: &mut Match, until: impl Fn(&Match) -> bool) {
    for _ in 0..30 {
        if until(m) {
            return;
        }
        let seat = *m.waiting_on().first().unwrap();
        let d = m.decision(seat).unwrap();
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap_or_else(|| panic!("no pass for seat {seat}: {}", d.prompt));
        m.choose(seat, d.revision, pass.index).unwrap();
    }
    assert!(until(m), "didn't get there: {:?}", m.state.waiting_for);
}

/// Seat 0 attacks Ben with everything; Ben's creature blocks seat 0's `blocked`.
fn after_blocks(cards: &[(&str, At)], blocked: usize) -> (Match, Vec<ObjectId>) {
    let (mut m, cs) = table(cards);
    pass_until(&mut m, |m| matches!(m.state.waiting_for, WaitingFor::DeclareAttackers { .. }));
    let d = m.decision(0).unwrap();
    let attacks: Vec<(u64, AttackAt)> = d.attack.unwrap().attackers.iter().map(|a| (a.id, AttackAt::Player { seat: 1 })).collect();
    m.declare_attackers(0, d.revision, &attacks).unwrap();
    pass_until(&mut m, |m| matches!(m.state.waiting_for, WaitingFor::DeclareBlockers { .. }));
    let d = m.decision(1).unwrap();
    let theirs = d.block.as_ref().unwrap().blockers[0].id;
    m.declare_blockers(1, d.revision, &[(theirs, cs[blocked].0)]).unwrap();
    pass_until(&mut m, |m| m.waiting_on() == [0]);
    (m, cs)
}

#[test]
fn ninjutsu_returns_only_an_unblocked_attacker() {
    let mut cards = lands(2, "Island");
    cards.extend([("Ninja of the Deep Hours", At::Hand), ("Grizzly Bears", At::Field), ("Savannah Lions", At::Field), ("Grizzly Bears", At::Theirs)]);
    let (mut m, cs) = after_blocks(&cards, 3);
    let (ninja, bears, lions) = (cs[2], cs[3], cs[4]);
    // The usual stops would pass this window; a ninja in hand keeps it (turns.rs).
    m.auto_pass(&[0, 1]);
    assert_eq!(m.waiting_on(), [0], "Ana is asked after blockers");
    let d = m.decision(0).unwrap();
    let ninjutsu: Vec<_> = d.options.iter().filter(|o| o.kind == OptionKind::Ninjutsu).collect();
    // One option per attacker it may return: only the unblocked Lions.
    assert_eq!(ninjutsu.len(), 1);
    let o = ninjutsu[0];
    assert_eq!((o.label.as_str(), o.cost.as_deref(), o.object, o.target.clone()), ("Ninjutsu {1}{U}: return Savannah Lions", Some("{1}{U}"), Some(ninja.0), Some(TargetView::Object { id: lions.0 })));
    assert!(refused(&mut m, Act::Ninjutsu { card: ninja.0, attacker: bears.0 }).contains("can't be done now"), "the Bears are blocked");
    let wire_act = serde_json::to_value(Act::Ninjutsu { card: ninja.0, attacker: lions.0 }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "ninjutsu", "card": ninja.0, "attacker": lions.0 }));
    act(&mut m, Act::Ninjutsu { card: ninja.0, attacker: lions.0 });
    assert!(m.state.players[0].hand.contains(&lions), "the Lions return to hand");
    let n = m.view(Some(0)).battlefield.into_iter().find(|c| c.id == ninja.0).expect("the ninja is on the battlefield");
    assert!(n.attacking && n.tapped && !n.blocked);
}

// ── foretell ─────────────────────────────────────────────────────────────

#[test]
fn foretelling_is_a_labelled_special_action_and_the_card_stays_hidden() {
    let mut cards = lands(2, "Island");
    cards.push(("Saw It Coming", At::Hand));
    let (mut m, cs) = table(&cards);
    let saw = cs[2];
    let d = m.decision(0).unwrap();
    let o = d.options.iter().find(|o| o.kind == OptionKind::Foretell).expect("foretell it");
    assert_eq!((o.label.as_str(), o.object), ("Foretell Saw It Coming for {2}", Some(saw.0)));
    act(&mut m, Act::Foretell { object: saw.0 });
    assert_eq!(m.state.objects[&saw].zone, Zone::Exile);
    let mine = m.view(Some(0)).exile.into_iter().find(|c| c.id == saw.0).unwrap();
    let theirs = m.view(Some(1)).exile.into_iter().find(|c| c.id == saw.0).unwrap();
    assert!(mine.face_down && theirs.face_down);
    assert_eq!(mine.name, "Saw It Coming");
    assert_eq!((theirs.name.as_str(), theirs.under.as_deref()), ("Face-down card", None));
    assert!(!wire(&m, Some(1)).contains("Saw It Coming"));
    // It isn't in hand any more.
    assert!(refused(&mut m, Act::Foretell { object: saw.0 }).contains("can't be done now"));
}

// ── companion and Serum Powder ──────────────────────────────────────────────

/// A game whose seat 0 has Jegantha as its companion (Kenrith's deck meets its condition) and
/// Serum Powder in its library, before the game begins.
fn companion_game(main0: &str) -> Match {
    let e = engine();
    let deck = |card: &str, n: usize| {
        let mut main = vec![card.to_string(); n];
        main.resize(99, "Mountain".into());
        main
    };
    let d0 = SeatDeck { commander: vec!["Kenrith, the Returned King".into()], main: deck(main0, 99), companion: vec!["Jegantha, the Wellspring".into()] };
    let d1 = SeatDeck { commander: vec!["Combat Celebrant".into()], main: deck("Mountain", 99), companion: vec![] };
    let mut m = e.new_match_first(3, vec![d0, d1], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    m
}

#[test]
fn a_companion_is_revealed_for_everyone_and_put_into_hand_for_3() {
    let mut m = companion_game("Mountain");
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::DeclareCompanion, "companion", "Reveal a companion?"));
    assert_eq!(ids(&p), ["Jegantha, the Wellspring"]);
    assert_eq!((p.min, p.max, p.up_to), (0, 1, true));
    assert_eq!(p.default_answer, Some(json!(["Jegantha, the Wellspring"])));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Jegantha, the Wellspring"));
    assert_eq!(p.card_names(), ["Jegantha, the Wellspring", "Jegantha, the Wellspring"], "the server sends its image");
    assert!(refused(&mut m, Act::DeclareCompanion { name: Some("Yorion, Sky Nomad".into()) }).contains("isn't one of the choices"));
    let wire_act = serde_json::to_value(Act::DeclareCompanion { name: Some("Jegantha, the Wellspring".into()) }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "declare_companion", "name": "Jegantha, the Wellspring" }));
    act(&mut m, Act::DeclareCompanion { name: Some("Jegantha, the Wellspring".into()) });
    // Public for the whole game.
    for seat in [Some(0), Some(1), None] {
        let v = m.view(seat);
        let c = v.players[0].companion.as_ref().unwrap_or_else(|| panic!("{seat:?} sees no companion"));
        assert_eq!((c.name.as_str(), c.used), ("Jegantha, the Wellspring", false));
        assert!(v.players[1].companion.is_none());
    }
    // In the main phase, with {3}: put it into your hand (CR 702.139a).
    for _ in 0..3 {
        let id = *m.state.players[0].library.iter().find(|id| m.state.objects[id].name == "Mountain").unwrap();
        m.state.players[0].library.retain(|c| *c != id);
        m.state.battlefield.push_back(id);
        m.state.objects.get_mut(&id).unwrap().zone = Zone::Battlefield;
    }
    main_phase(&mut m);
    let d = m.decision(0).unwrap();
    let o = d.options.iter().find(|o| o.kind == OptionKind::Companion).expect("put it into your hand");
    assert_eq!((o.label.as_str(), o.cost.as_deref()), ("Pay {3}: put Jegantha, the Wellspring into your hand", Some("{3}")));
    act(&mut m, Act::CompanionToHand);
    assert!(m.state.players[0].hand.iter().any(|id| m.state.objects[id].name == "Jegantha, the Wellspring"));
    assert!(m.view(Some(1)).players[0].companion.as_ref().unwrap().used);
    assert!(refused(&mut m, Act::CompanionToHand).contains("can't be done now"), "once a game");
}

#[test]
fn no_companion_is_an_answer_too() {
    let mut m = companion_game("Mountain");
    act(&mut m, Act::DeclareCompanion { name: None });
    assert!(m.view(Some(1)).players[0].companion.is_none());
    assert!(matches!(m.state.waiting_for, WaitingFor::MulliganDecision { .. }));
}

#[test]
fn serum_powder_exiles_the_hand_and_draws_as_many_without_a_mulligan() {
    let mut m = companion_game("Serum Powder");
    act(&mut m, Act::DeclareCompanion { name: None });
    let d = m.decision(0).unwrap();
    let powder = d.options.iter().find(|o| o.kind == OptionKind::SerumPowder).expect("Serum Powder at the mulligan");
    assert_eq!(powder.label, "Serum Powder: exile your hand, then draw that many cards");
    let card = powder.object.unwrap();
    let hand: Vec<ObjectId> = m.state.players[0].hand.iter().copied().collect();
    act(&mut m, Act::UseSerumPowder { object: card });
    assert_eq!(m.state.players[0].hand.len(), hand.len());
    assert!(hand.iter().all(|id| m.state.objects[id].zone == Zone::Exile), "the old hand is exiled");
    let d = m.decision(0).unwrap();
    assert_eq!(d.mulligan.as_ref().map(|v| (v.mulligans, v.free)), Some((0, true)), "not a mulligan");
    assert!(refused(&mut m, Act::UseSerumPowder { object: card }).contains("can't be done now"), "that one is exiled");
}

// ── cipher ───────────────────────────────────────────────────────────────

#[test]
fn a_cipher_spell_is_encoded_on_a_creature_or_not() {
    let mut cards = lands(4, "Island");
    cards.extend([("Last Thoughts", At::Hand), ("Grizzly Bears", At::Field), ("Savannah Lions", At::Field), ("Grizzly Bears", At::Theirs)]);
    let (mut m, cs) = table(&cards);
    let (thoughts, bears, lions, theirs) = (cs[4], cs[5], cs[6], cs[7]);
    cast(&mut m, thoughts);
    assert_eq!(settle(&mut m), 0);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::CipherEncode, "cipher", "Encode Last Thoughts on a creature you control?"));
    let mut got = ids(&p);
    got.sort();
    let mut want = vec![bears.0.to_string(), lions.0.to_string()];
    want.sort();
    assert_eq!(got, want, "your creatures only");
    assert_eq!((p.min, p.max), (0, 1));
    assert!(refused(&mut m, Act::CipherEncode { creature: Some(theirs.0) }).contains("isn't one of the choices"));
    act(&mut m, Act::CipherEncode { creature: Some(lions.0) });
    assert_eq!(m.state.objects[&thoughts].zone, Zone::Exile, "encoded in exile");
}

// ── dungeons ─────────────────────────────────────────────────────────────

#[test]
fn venturing_chooses_a_dungeon_then_a_room_on_its_map() {
    let mut cards = lands(4, "Swamp");
    cards.extend([("Fates' Reversal", At::Hand), ("Fates' Reversal", At::Hand)]);
    let (mut m, cs) = table(&cards);
    cast(&mut m, cs[4]);
    assert_eq!(settle(&mut m), 0);
    // Fates' Reversal may return a creature first; there are none, so it ventures.
    let mut p = pending(&m);
    if p.purpose != "dungeon" {
        act(&mut m, Act::SelectCards { cards: vec![] });
        settle(&mut m);
        p = pending(&m);
    }
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseDungeon, "dungeon", "Venture into the dungeon: choose a dungeon"));
    assert_eq!(ids(&p), ["LostMineOfPhandelver", "DungeonOfTheMadMage", "TombOfAnnihilation"]);
    let lost = &p.options[0];
    assert_eq!((lost.name.as_str(), lost.text.as_deref()), ("Lost Mine of Phandelver", Some("Cave Entrance: Scry 1.")));
    assert_eq!(lost.img.as_deref(), Some("https://cards.scryfall.io/normal/front/5/9/59b11ff8-f118-4978-87dd-509dc0c8c932.jpg"));
    assert_eq!(p.dungeons.len(), 3);
    let map = &p.dungeons[0];
    assert_eq!((map.id.as_str(), map.rooms.len(), map.current), ("LostMineOfPhandelver", 7, None));
    assert_eq!((map.rooms[0].name.as_str(), map.rooms[0].next.as_slice()), ("Cave Entrance", [1u8, 2].as_slice()));
    assert!(refused(&mut m, Act::ChooseDungeon { dungeon: "Undercity".into() }).contains("isn't one of the choices"));
    act(&mut m, Act::ChooseDungeon { dungeon: "LostMineOfPhandelver".into() });
    // Cave Entrance: scry 1.
    if settle(&mut m) == 0 && pending(&m).purpose == "scry" {
        act(&mut m, Act::SelectCards { cards: vec![] });
    }
    settle(&mut m);
    untap_all(&mut m);
    cast(&mut m, cs[5]);
    settle(&mut m);
    let mut p = pending(&m);
    if p.purpose != "dungeon_room" {
        act(&mut m, Act::SelectCards { cards: vec![] });
        settle(&mut m);
        p = pending(&m);
    }
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseDungeonRoom, "dungeon_room", "Lost Mine of Phandelver: choose the next room"));
    let rooms: Vec<_> = p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.text.as_deref())).collect();
    assert_eq!(rooms, [("1", "Goblin Lair", Some("Create a 1/1 red Goblin creature token.")), ("2", "Mine Tunnels", Some("Create a Treasure token."))]);
    assert_eq!(p.dungeons.len(), 1);
    assert_eq!(p.dungeons[0].current, Some(0), "the marker is on Cave Entrance");
    assert!(refused(&mut m, Act::ChooseDungeonRoom { room: 6 }).contains("can't move to that room"));
    let wire_act = serde_json::to_value(Act::ChooseDungeonRoom { room: 2 }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "choose_dungeon_room", "room": 2 }));
    act(&mut m, Act::ChooseDungeonRoom { room: 2 });
    assert_eq!(m.state.dungeon_progress[&PlayerId(0)].current_room, 2);
}

// ── time travel ──────────────────────────────────────────────────────────

#[test]
fn time_travel_removes_and_adds_in_one_answer() {
    let mut cards = lands(3, "Island");
    cards.extend([("Wibbly-wobbly, Timey-wimey", At::Hand), ("Rotating Fireplace", At::Field), ("Grizzly Bears", At::Field)]);
    let (mut m, cs) = table(&cards);
    let (wibbly, fire, bears) = (cs[3], cs[4], cs[5]);
    for (id, n) in [(fire, 2), (bears, 1)] {
        m.state.objects.get_mut(&id).unwrap().counters.insert(engine::types::counter::CounterType::Time, n);
    }
    cast(&mut m, wibbly);
    assert_eq!(settle(&mut m), 0);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.step), (Kind::Pick, Answer::TimeTravel, "time_travel", Some("remove")));
    let fire_row = p.options.iter().find(|o| o.id == fire.0.to_string()).unwrap();
    assert_eq!(fire_row.counters, [("time".to_string(), 2)]);
    let (f, b) = (TargetView::Object { id: fire.0 }, TargetView::Object { id: bears.0 });
    assert!(refused(&mut m, Act::TimeTravel { remove: vec![f.clone()], add: vec![f.clone()] }).contains("one change for each"));
    let wire_act = serde_json::to_value(Act::TimeTravel { remove: vec![f.clone()], add: vec![b.clone()] }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "time_travel", "remove": [{ "kind": "object", "id": fire.0 }], "add": [{ "kind": "object", "id": bears.0 }] }));
    act(&mut m, Act::TimeTravel { remove: vec![f], add: vec![b] });
    let time = |id: ObjectId| m.state.objects[&id].counters.get(&engine::types::counter::CounterType::Time).copied().unwrap_or(0);
    assert_eq!((time(fire), time(bears)), (1, 2));
    assert!(!matches!(m.state.waiting_for, WaitingFor::TimeTravelChoice { .. }), "both steps are answered");
}

#[test]
fn leaving_every_time_counter_answers_both_steps() {
    let mut cards = lands(3, "Island");
    cards.extend([("Wibbly-wobbly, Timey-wimey", At::Hand), ("Rotating Fireplace", At::Field)]);
    let (mut m, cs) = table(&cards);
    m.state.objects.get_mut(&cs[4]).unwrap().counters.insert(engine::types::counter::CounterType::Time, 2);
    cast(&mut m, cs[3]);
    settle(&mut m);
    act(&mut m, Act::TimeTravel { remove: vec![], add: vec![] });
    assert!(!matches!(m.state.waiting_for, WaitingFor::TimeTravelChoice { .. }));
    assert_eq!(m.state.objects[&cs[4]].counters.get(&engine::types::counter::CounterType::Time).copied(), Some(2));
}

// ── meld ─────────────────────────────────────────────────────────────────

#[test]
fn gisela_and_bruna_meld_at_the_end_step_without_asking_when_there_is_one_pair() {
    let cards = [("Gisela, the Broken Blade", At::Field), ("Bruna, the Fading Light", At::Field)];
    let (mut m, _) = table(&cards);
    m.state.phase = Phase::PostCombatMain;
    let melded = |m: &Match| m.state.battlefield.iter().any(|id| m.state.objects[id].name == "Brisela, Voice of Nightmares");
    pass_until(&mut m, |m| m.decision(0).and_then(|d| d.pending).is_some() || melded(m));
    // The engine asks which pair only when there's more than one (MeldPairChoice, below).
    assert!(melded(&m));
    assert!(m.view(Some(1)).battlefield.iter().any(|c| c.name == "Brisela, Voice of Nightmares"));
}

#[test]
fn the_meld_pair_shape_reads_the_engines_choices() {
    let cards = [("Gisela, the Broken Blade", At::Field), ("Bruna, the Fading Light", At::Field)];
    let (mut m, cs) = table(&cards);
    let sel = |s: ObjectId, p: ObjectId| {
        serde_json::from_value::<engine::types::game_state::MeldSelection>(json!({
            "source_id": s.0, "partner_id": p.0, "controller": 0,
            "expected_source": "Gisela, the Broken Blade", "expected_partner": "Bruna, the Fading Light", "result": "Brisela, Voice of Nightmares"
        }))
        .unwrap()
    };
    m.state.waiting_for = WaitingFor::MeldPairChoice { player: PlayerId(0), choices: vec![sel(cs[0], cs[1]), sel(cs[1], cs[0])] };
    let p = pending(&m);
    assert_eq!(p.options.len(), 2);
    assert_eq!(p.default_answer, None, "two pairs: nothing chosen yet");
    assert_eq!(p.shown.iter().filter(|c| c.group.as_deref() == Some(p.options[1].id.as_str())).count(), 3);
    let a = Act::ChooseMeldPair { source: cs[1].0, partner: cs[0].0 };
    assert!(p.admits(&a).is_ok());
    assert!(p.admits(&Act::ChooseMeldPair { source: cs[0].0, partner: cs[0].0 }).is_err());
    assert_eq!(a.to_action(), Some(engine::types::actions::GameAction::ChooseMeldPair { source_id: cs[1], partner_id: cs[0] }));
}

#[test]
fn a_permanent_entering_attacking_chooses_whom_it_attacks() {
    let cards = [("Grizzly Bears", At::Field)];
    let (mut m, cs) = table(&cards);
    m.state.waiting_for = WaitingFor::EntryAttackTargetChoice {
        player: PlayerId(0),
        object_id: cs[0],
        valid_targets: vec![engine::game::combat::AttackTarget::Player(PlayerId(1))],
    };
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseEntryAttackTarget, "entry_attack", "Choose what Grizzly Bears attacks"));
    assert_eq!(ids(&p), ["p1"]);
    let a = Act::ChooseEntryAttackTarget { target: TargetView::Player { seat: 1 } };
    assert!(p.admits(&a).is_ok());
    assert!(p.admits(&Act::ChooseEntryAttackTarget { target: TargetView::Player { seat: 0 } }).is_err());
    assert_eq!(
        crate::rare::action_for(&m.state.waiting_for, &[], &a),
        Some(engine::types::actions::GameAction::ChooseEntryAttackTarget { target: engine::game::combat::AttackTarget::Player(PlayerId(1)) })
    );
}

// ── loop shortcuts and repeating ──────────────────────────────────────────

fn proposal(count: engine::analysis::decision_template::IterationCount) -> engine::analysis::loop_check::ShortcutProposal {
    serde_json::from_value(json!({
        "proposer": 0, "predicted_winner": 0, "count": count, "unbounded": [{ "Life": 1 }, "TokensCreated"],
        "win_kind": "LethalDamage", "road": "Ring"
    }))
    .unwrap()
}

#[test]
fn a_shortcut_is_accepted_or_shortened_and_everyone_sees_it() {
    use engine::analysis::decision_template::IterationCount;
    let e = engine();
    let deck = || SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99], ..Default::default() };
    let mut m = e.new_match_first(3, vec![deck(), deck(), deck()], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into(), "Cy".into()]);
    main_phase(&mut m);
    m.state.waiting_for = WaitingFor::RespondToShortcut { player: PlayerId(1), remaining_players: vec![PlayerId(2)], proposal: proposal(IterationCount::Fixed(20)) };
    let p = pending_of(&m, 1);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Number, Answer::RespondToShortcut, "shortcut_response", "Ana proposes a shortcut: repeat 20 times"));
    assert_eq!((p.min, p.max, p.total), (0, 19, Some(20)), "shorten to any place before the end");
    let s = p.shortcut.as_ref().unwrap();
    assert_eq!(s.grows, ["Ben's life", "Tokens created"]);
    assert_eq!(s.wins.as_deref(), Some("An opponent's life reaches 0"));
    assert_eq!(s.responders, [(1, "deciding"), (2, "next")]);
    // Cy, still to answer, sees the same proposal and who is answering.
    let Some(crate::TogetherView::Shortcut { shortcut, .. }) = m.view(Some(2)).together else { panic!("Cy sees the shortcut") };
    assert_eq!((shortcut.proposer, shortcut.count, shortcut.responders.clone()), (0, Some(20), vec![(1, "deciding"), (2, "next")]));
    assert!(p.admits(&Act::RespondToShortcut { stop_at: None }).is_ok());
    assert!(p.admits(&Act::RespondToShortcut { stop_at: Some(5) }).is_ok());
    assert!(p.admits(&Act::RespondToShortcut { stop_at: Some(20) }).unwrap_err().contains("between 0 and 19"));
    assert_eq!(
        crate::rare::action_for(&m.state.waiting_for, &[], &Act::RespondToShortcut { stop_at: Some(5) }),
        Some(engine::types::actions::GameAction::RespondToShortcut { response: engine::analysis::loop_check::ShortcutResponse::Shorten { at_iteration: 5 } })
    );
    // A loop until a player loses has no count to stop below.
    m.state.waiting_for = WaitingFor::RespondToShortcut { player: PlayerId(1), remaining_players: vec![], proposal: proposal(IterationCount::UntilLethal) };
    let p = pending_of(&m, 1);
    assert_eq!((p.prompt.as_str(), p.total), ("Ana proposes a shortcut: repeat until a player loses", None));
    assert_eq!(p.shortcut.as_ref().unwrap().responders, [(1, "deciding"), (2, "answered")]);
}

#[test]
fn the_engines_answers_to_shortcuts_read_back_as_acts() {
    use engine::analysis::decision_template::IterationCount;
    use engine::types::actions::{GameAction, PrecastCopyShortcutResponse};
    let cases = [
        (GameAction::DeclareShortcut { count: IterationCount::Fixed(7), template: None }, Act::ProposeShortcut { count: Some(7) }),
        (GameAction::DeclareShortcut { count: IterationCount::UntilLethal, template: None }, Act::ProposeShortcut { count: None }),
        (GameAction::DeclineShortcut, Act::DeclineShortcut),
        (GameAction::PrecastCopyShortcut { epoch: 3, response: PrecastCopyShortcutResponse::Shorten { breakpoint_id: 41 } }, Act::RespondToShortcut { stop_at: Some(41) }),
    ];
    for (action, want) in cases {
        assert_eq!(Act::from_action(&action), Some(want));
    }
    // The precast offer: propose or play it out, as a yes or no.
    let cards = [("Grizzly Bears", At::Field)];
    let (mut m, _) = table(&cards);
    m.state.waiting_for = WaitingFor::PrecastCopyShortcutOffer { proposer: PlayerId(0), epoch: 3, route_count: 1 };
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Yesno, Answer::ProposeShortcut, "precast_shortcut"));
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Propose the shortcut"), Some("Keep playing it out")));
    assert_eq!(
        crate::rare::action_for(&m.state.waiting_for, &[], &Act::ProposeShortcut { count: None }),
        Some(GameAction::PrecastCopyShortcut { epoch: 3, response: PrecastCopyShortcutResponse::Propose { route_id: 3 } })
    );
    assert!(p.admits(&Act::ProposeShortcut { count: Some(2) }).is_err());
}

#[test]
fn repeating_a_process_is_a_yes_or_no() {
    let cards = [("Grizzly Bears", At::Field)];
    let (mut m, cs) = table(&cards);
    let ability: engine::types::ability::ResolvedAbility = serde_json::from_value(json!({
        "effect": { "type": "Draw", "count": { "type": "Fixed", "value": 1 }, "target": { "type": "Controller" } },
        "targets": [], "source_id": cs[0].0, "controller": 0, "kind": "Spell", "description": "Draw a card."
    }))
    .unwrap();
    m.state.waiting_for = WaitingFor::RepeatDecision { player: PlayerId(0), ability: Box::new(ability) };
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Yesno, Answer::DecideOptionalEffect, "repeat", "Repeat this process? Draw a card."));
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Repeat it"), Some("Stop")));
}

// ── answers Yama remembers (remember.rs) ─────────────────────────────────────

/// Your commander from the command zone onto the battlefield, ready to be Shocked.
fn commander_out(m: &mut Match) -> ObjectId {
    let cel = *m.state.command_zone.iter().find(|id| m.state.objects[id].owner == PlayerId(0)).unwrap();
    m.state.command_zone.retain(|c| *c != cel);
    m.state.battlefield.push_back(cel);
    let o = m.state.objects.get_mut(&cel).unwrap();
    o.zone = Zone::Battlefield;
    o.summoning_sick = false;
    evaluate_layers(&mut m.state);
    cel
}

/// Shock your own commander (a 4/1): it dies and the engine asks about the command zone.
fn shock(m: &mut Match, shock: ObjectId, cel: ObjectId) {
    cast(m, shock);
    if m.decision(0).and_then(|d| d.pending).is_some_and(|p| p.purpose == "target") {
        act(m, Act::ChooseTarget { target: Some(TargetView::Object { id: cel.0 }) });
    }
    settle(m);
}

#[test]
fn yama_remembers_sending_your_commander_to_the_command_zone() {
    let mut cards = lands(3, "Mountain");
    cards.extend([("Shock", At::Hand), ("Shock", At::Hand), ("Shock", At::Hand)]);
    let (mut m, cs) = table(&cards);
    let cel = commander_out(&mut m);
    shock(&mut m, cs[3], cel);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Yesno, Answer::DecideOptionalEffect, "commander_zone", "Put Combat Celebrant into the command zone?"));
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref(), p.remember), (Some("Command zone"), Some("Graveyard"), Some("yama")));
    let wire_act = serde_json::to_value(Act::RememberAnswer { accept: true }).unwrap();
    assert_eq!(wire_act, json!({ "kind": "remember_answer", "accept": true }));
    act(&mut m, Act::RememberAnswer { accept: true });
    assert!(m.state.command_zone.contains(&cel));
    let answers = m.view(Some(0)).turns.unwrap().answers;
    let a = answers.iter().find(|a| a.kind == "yama").expect("listed with the engine's");
    assert_eq!((a.name.as_str(), a.answer.as_str(), a.owner), ("Combat Celebrant", "Always to the command zone", None));
    assert!(m.view(Some(1)).turns.unwrap().answers.is_empty(), "Ben has none");
    // Next time Yama answers for you, says so in your log only, and the line can turn it off.
    let cel = commander_out(&mut m);
    shock(&mut m, cs[4], cel);
    assert_eq!(pending(&m).purpose, "commander_zone", "the engine asks");
    // The server passes for people after every move; that's where Yama answers.
    assert!(m.auto_pass(&[0, 1]) >= 1);
    assert!(m.state.command_zone.contains(&cel), "Yama put it back");
    let mine = m.view(Some(0));
    let line = mine.log.iter().rev().find(|l| l.auto.is_some()).expect("a log line for the automatic answer");
    assert_eq!(line.text, "Yama put Combat Celebrant into the command zone, as you asked.");
    assert_eq!(line.auto.as_deref(), Some(a.id.as_str()));
    assert!(!m.view(Some(1)).log.iter().any(|l| l.text.starts_with("Yama")), "only you see it");
    let fed = mine.events.iter().rev().find_map(|h| match &h.what {
        crate::feed::What::Automatic { answer, did, .. } => Some((answer.clone(), did.clone())),
        _ => None,
    });
    assert_eq!(fed, Some((a.id.clone(), Some("put Combat Celebrant into the command zone".to_string()))));
    // Turn off: a setting, sent any time.
    m.act(0, 0, &a.forget).unwrap();
    assert!(m.view(Some(0)).turns.unwrap().answers.iter().all(|x| x.kind != "yama"));
    assert!(m.act(0, 0, &a.forget).unwrap_err().to_string().contains("already off"));
    let cel = commander_out(&mut m);
    shock(&mut m, cs[5], cel);
    m.auto_pass(&[0, 1]);
    assert_eq!(pending(&m).purpose, "commander_zone", "asked again");
}

#[test]
fn only_a_decision_yama_can_remember_takes_a_remembered_answer() {
    let mut cards = lands(2, "Island");
    cards.push(("Opt", At::Hand));
    let (mut m, cs) = table(&cards);
    cast(&mut m, cs[2]);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!(p.purpose, "scry");
    assert!(refused(&mut m, Act::RememberAnswer { accept: true }).contains("can't be remembered"));
}

/// Seat 1 (Ben) has Rhystic Study and says yes to its "may" whenever Ana casts a spell.
fn rhystic(islands: usize, opts: usize) -> (Match, Vec<ObjectId>) {
    let mut cards = lands(islands, "Island");
    cards.extend(std::iter::repeat_n(("Opt", At::Hand), opts));
    cards.push(("Rhystic Study", At::Theirs));
    table(&cards)
}

/// Cast `opt` and let Ben's Rhystic Study ask (Ben says yes), then let Yama answer for Ana if it
/// remembers how. Returns whether Ana is still asked to pay.
fn opt_with_rhystic(m: &mut Match, opt: ObjectId) -> bool {
    cast(m, opt);
    for _ in 0..10 {
        let seat = *m.waiting_on().first().unwrap();
        let d = m.decision(seat).unwrap();
        match d.pending {
            Some(p) if seat == 1 && p.purpose == "may" => act_as(m, 1, Act::DecideOptionalEffect { accept: true }),
            Some(p) if seat == 0 && p.purpose == "pay" => {
                m.auto_pass(&[0, 1]);
                return m.decision(0).and_then(|d| d.pending).is_some_and(|p| p.purpose == "pay");
            }
            Some(p) if seat == 0 && p.purpose == "scry" => act(m, Act::SelectCards { cards: vec![] }),
            _ => {
                let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
                m.choose(seat, d.revision, pass.index).unwrap();
            }
        }
    }
    panic!("Rhystic Study didn't ask");
}

/// Resolve what's on the stack, keeping scried cards on top, until Ana has priority again.
fn finish(m: &mut Match) {
    for _ in 0..20 {
        let seat = settle(m);
        match m.decision(seat).and_then(|d| d.pending) {
            Some(p) if p.purpose == "scry" => act_as(m, seat, Act::SelectCards { cards: vec![] }),
            Some(p) => panic!("asked {} while finishing", p.purpose),
            None => return,
        }
    }
}

#[test]
fn always_pay_for_rhystic_study_pays_when_it_can_and_asks_when_it_cant() {
    let (mut m, cs) = rhystic(5, 3);
    let untapped = |m: &Match| m.state.battlefield.iter().filter(|id| m.state.objects[id].controller == PlayerId(0) && !m.state.objects[id].tapped).count();
    assert!(opt_with_rhystic(&mut m, cs[5]), "the first time, you're asked");
    let p = pending(&m);
    assert_eq!((p.purpose, p.remember, p.yes_label.as_deref()), ("pay", Some("yama"), Some("Pay {1}")));
    assert_eq!(p.source.as_ref().map(|s| (s.name.as_str(), s.controller)), Some(("Rhystic Study", 1)));
    act(&mut m, Act::RememberAnswer { accept: true });
    assert_eq!(untapped(&m), 3, "Opt and {{1}} paid");
    finish(&mut m);
    let mine = m.view(Some(0)).turns.unwrap().answers;
    let a = mine.iter().find(|a| a.kind == "yama").unwrap();
    assert_eq!((a.name.as_str(), a.owner, a.answer.as_str()), ("Rhystic Study", Some(1), "Always pay {1}"));
    // The second Opt: paid for you, and logged.
    let hand_before = m.state.players[1].hand.len();
    assert!(!opt_with_rhystic(&mut m, cs[6]), "Yama paid");
    assert_eq!(untapped(&m), 1);
    finish(&mut m);
    assert_eq!(m.state.players[1].hand.len(), hand_before, "Ben didn't draw");
    let line = m.view(Some(0)).log.into_iter().rev().find(|l| l.auto.is_some()).unwrap();
    assert_eq!(line.text, "Yama paid {1} for Ben's Rhystic Study, as you asked.");
    assert_eq!(line.seat, Some(0));
    // The third: one Island left for Opt and nothing to pay with, so you're asked.
    assert!(opt_with_rhystic(&mut m, cs[7]), "can't pay: asked");
    act(&mut m, Act::PayUnlessCost { pay: false });
    // Saved with the game and read back.
    let saved = serde_json::to_string(m.remembered()).unwrap();
    let mut again = rhystic(1, 1).0;
    again.set_remembered(serde_json::from_str(&saved).unwrap());
    assert_eq!(again.remembered(), m.remembered());
}
