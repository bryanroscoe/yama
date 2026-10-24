//! Everyone takes part, choosing a player, and the library (together.rs, library.rs; GTogether,
//! GRareRules, GLibrary) on real casts: cards from tests/fixtures/together-cards.json (a slice of
//! phase's card data: basic lands, Council's Judgment, Fact or Fiction, Ensnared by the Mara,
//! Krark's Thumb and Mana Screw, Krark's Other Thumb and Contact Other Plane, Cultivate, Not
//! Forgotten, Telling Time, Manifest Dread, Cram Session, Lash Out, Dewdrop Cure, Pendant of
//! Prosperity, Port Town, Hei Bai and others) put straight onto a board of two to four people at
//! seat 0's main phase, then answered through `act` as the board does. Decisions that need more
//! set-up than a test should carry are checked from the engine's state built by hand.

use engine::game::filter_state_for_viewer;
use engine::game::layers::evaluate_layers;
use engine::types::actions::GameAction;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use serde_json::json;

use crate::act::{Answer, Kind};
use crate::pay::PayMode;
use crate::together::{Pile, TogetherView};
use crate::{Act, ChoiceError, Engine, Match, OptionKind, Pending, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/together-cards.json")).unwrap()
}

/// Where a card starts in `table`.
#[derive(Clone, Copy)]
enum At {
    Field,
    Hand,
    /// On top of seat 0's library, the first given on top.
    Top,
    /// On a seat's battlefield.
    Theirs(u8),
    /// In a seat's graveyard.
    Grave(u8),
}

/// A game of `players` people at seat 0's turn 3 main phase with priority: each card where it's
/// asked for (untapped, none summoning sick). Every seat's commander is Combat Celebrant, in the
/// command zone. Returns the ids in the order given.
fn table(e: &Engine, players: usize, cards: &[(&str, At)]) -> (Match, Vec<ObjectId>) {
    let seat_of = |at: &At| match at {
        At::Theirs(s) | At::Grave(s) => usize::from(*s),
        _ => 0,
    };
    let deck = |seat: usize| {
        let mut main: Vec<String> = cards.iter().filter(|(_, at)| seat_of(at) == seat).map(|(n, _)| n.to_string()).collect();
        main.resize(99, "Plains".into());
        SeatDeck { commander: vec!["Combat Celebrant".into()], main }
    };
    let mut m = e.new_match_first(3, (0..players).map(deck).collect(), &[], Some(0)).unwrap();
    m.set_names(["Ana", "Ben", "Cy", "Di"].iter().take(players).map(|n| n.to_string()).collect());
    let mut ids = vec![];
    let mut tops = vec![];
    for (name, at) in cards {
        let seat = seat_of(at);
        // From the library, or the opening hand where the deal put it there.
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
            At::Field | At::Theirs(_) => {
                m.state.battlefield.push_back(id);
                Zone::Battlefield
            }
            At::Hand => {
                p.hand.push_back(id);
                Zone::Hand
            }
            At::Grave(_) => {
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

fn refused_as(m: &mut Match, seat: u8, a: Act) -> String {
    let d = m.decision(seat).unwrap();
    match m.act(seat, d.revision, &a) {
        Err(ChoiceError::DoesntFit(why)) | Err(ChoiceError::Rejected(why)) => why,
        other => panic!("{a:?} wasn't refused: {other:?}"),
    }
}

fn refused(m: &mut Match, a: Act) -> String {
    refused_as(m, 0, a)
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

/// Choose `t` as the target, unless the engine chose the only one itself.
fn aim_if_asked(m: &mut Match, t: TargetView) {
    if m.decision(0).and_then(|d| d.pending).is_some_and(|p| p.purpose == "target") {
        act(m, Act::ChooseTarget { target: Some(t) });
    }
}

fn ids(p: &Pending) -> Vec<String> {
    p.options.iter().map(|o| o.id.clone()).collect()
}

/// A seat's own view of the table-wide decision.
fn together(m: &Match, seat: u8) -> Option<TogetherView> {
    m.view(Some(seat)).together
}

/// Every name a seat's view of a decision shows, from the pending and the table-wide view.
fn names_seen(m: &Match, seat: u8) -> Vec<String> {
    let v = m.view(Some(seat));
    let mut out: Vec<String> = v.decision.iter().filter_map(|d| d.pending.as_ref()).flat_map(|p| p.options.iter().chain(&p.shown).map(|o| o.name.clone())).collect();
    out.extend(v.together.iter().flat_map(|t| t.card_names()));
    out
}

// ── votes ─────────────────────────────────────────────────────────────────

#[test]
fn a_vote_goes_round_the_table_and_everyone_sees_the_votes() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Council's Judgment", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs(1)));
    cards.push(("Savannah Lions", At::Theirs(2)));
    let (mut m, ids_) = table(&e, 3, &cards);
    let (judgment, bears, lions) = (ids_[3], ids_[4], ids_[5]);
    cast(&mut m, judgment);
    assert_eq!(settle(&mut m), 0, "starting with you");
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SubmitVoteCandidate, "vote", "Vote for a permanent"));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Council's Judgment"));
    assert_eq!(p.total, Some(1), "one vote each");
    // The permanents you don't control, by their place in the engine's list.
    let names: Vec<&str> = p.options.iter().map(|o| o.name.as_str()).collect();
    assert!(names.contains(&"Grizzly Bears") && names.contains(&"Savannah Lions"), "{names:?}");
    let place = |p: &Pending, name: &str| -> u32 { p.options.iter().find(|o| o.name == name).unwrap().id.parse().unwrap() };
    // Every seat sees the vote: no votes yet, Ana voting, then Ben and Cy.
    for seat in 0..3 {
        let Some(TogetherView::Vote { ballots, voters, options, .. }) = together(&m, seat) else { panic!("seat {seat} doesn't see the vote") };
        assert!(ballots.is_empty());
        assert_eq!(voters.iter().map(|v| (v.seat, v.state)).collect::<Vec<_>>(), [(0, "voting"), (1, "next"), (2, "next")]);
        assert!(options.iter().any(|o| o.id == Some(bears.0) && o.name.as_deref() == Some("Grizzly Bears")));
    }
    assert!(refused(&mut m, Act::SubmitVoteCandidate { candidate: 99 }).contains("isn't one of the choices"));
    assert!(refused(&mut m, Act::ChooseOption { choice: "Grizzly Bears".into() }).contains("doesn't fit"));
    let wire = serde_json::to_value(Act::SubmitVoteCandidate { candidate: 1 }).unwrap();
    assert_eq!(wire, json!({ "kind": "submit_vote_candidate", "candidate": 1 }));
    assert_eq!(serde_json::from_value::<Act>(wire).unwrap(), Act::SubmitVoteCandidate { candidate: 1 });
    act(&mut m, Act::SubmitVoteCandidate { candidate: place(&p, "Grizzly Bears") });
    // Ben votes next; Cy sees Ana's vote.
    let p1 = pending_of(&m, 1);
    assert_eq!(p1.purpose, "vote");
    let Some(TogetherView::Vote { ballots, voters, .. }) = together(&m, 2) else { panic!() };
    assert_eq!(ballots, [(0, place(&p, "Grizzly Bears") as usize)]);
    assert_eq!(voters.iter().map(|v| (v.seat, v.state)).collect::<Vec<_>>(), [(0, "voted"), (1, "voting"), (2, "next")]);
    act_as(&mut m, 1, Act::SubmitVoteCandidate { candidate: place(&p1, "Grizzly Bears") });
    let p2 = pending_of(&m, 2);
    act_as(&mut m, 2, Act::SubmitVoteCandidate { candidate: place(&p2, "Savannah Lions") });
    settle(&mut m);
    // The most votes are exiled.
    assert!(m.state.exile.contains(&bears), "the Bears had the most votes");
    assert!(m.state.battlefield.contains(&lions));
    assert!(together(&m, 0).is_none(), "the vote is over");
}

#[test]
fn an_ai_seat_votes_at_once_beside_people() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Council's Judgment", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs(1)));
    cards.push(("Savannah Lions", At::Theirs(2)));
    let seat_of = |at: &At| match at {
        At::Theirs(s) => usize::from(*s),
        _ => 0,
    };
    // Seat 1 is the computer: build the same table with an AI there.
    let deck = |seat: usize| {
        let mut main: Vec<String> = cards.iter().filter(|(_, at)| seat_of(at) == seat).map(|(n, _)| n.to_string()).collect();
        main.resize(99, "Plains".into());
        SeatDeck { commander: vec!["Combat Celebrant".into()], main }
    };
    let mut m = e.new_match_first(3, (0..3).map(deck).collect(), &[(1, crate::Difficulty::Easy)], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Computer".into(), "Cy".into()]);
    let put = |m: &mut Match, seat: usize, name: &str, zone: Zone| {
        let id = m.state.players[seat].library.iter().copied().find(|id| m.state.objects[id].name == name).unwrap();
        m.state.players[seat].library.retain(|c| *c != id);
        match zone {
            Zone::Hand => m.state.players[seat].hand.push_back(id),
            _ => m.state.battlefield.push_back(id),
        }
        let o = m.state.objects.get_mut(&id).unwrap();
        o.zone = zone;
        o.summoning_sick = false;
        id
    };
    for _ in 0..3 {
        put(&mut m, 0, "Plains", Zone::Battlefield);
    }
    let judgment = put(&mut m, 0, "Council's Judgment", Zone::Hand);
    put(&mut m, 1, "Grizzly Bears", Zone::Battlefield);
    put(&mut m, 2, "Savannah Lions", Zone::Battlefield);
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = Phase::PreCombatMain;
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    cast(&mut m, judgment);
    for _ in 0..20 {
        m.run_ai(50).unwrap();
        if matches!(m.state.waiting_for, WaitingFor::VoteChoice { .. }) {
            break;
        }
        let seat = m.waiting_on()[0];
        let d = m.decision(seat).unwrap();
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
        m.choose(seat, d.revision, pass.index).unwrap();
    }
    let p = pending(&m);
    act(&mut m, Act::SubmitVoteCandidate { candidate: p.options[0].id.parse().unwrap() });
    // The computer votes at once, and Cy is asked with both votes shown.
    m.run_ai(10).unwrap();
    assert_eq!(m.waiting_on(), [2], "the computer has voted");
    let Some(TogetherView::Vote { ballots, voters, .. }) = together(&m, 2) else { panic!() };
    assert_eq!(ballots.len(), 2);
    assert_eq!(voters.iter().map(|v| v.state).collect::<Vec<_>>(), ["voted", "voted", "voting"]);
    assert_eq!(pending_of(&m, 2).purpose, "vote");
}

#[test]
fn a_vote_for_words_is_answered_with_the_word() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Coercive Portal", At::Field)]);
    // Coercive Portal's upkeep vote, as the engine parks it.
    let portal = ids_[0];
    m.state.waiting_for = WaitingFor::VoteChoice {
        player: PlayerId(0),
        remaining_votes: 1,
        options: vec!["carnage".into(), "homage".into()],
        option_labels: vec!["carnage".into(), "homage".into()],
        remaining_voters: vec![(PlayerId(1), 1)],
        tallies: vec![0, 0],
        ballots: Default::default(),
        per_choice_effect: vec![],
        controller: PlayerId(0),
        source_id: portal,
        actor: engine::types::game_state::VoteActor::SubjectActs,
        tally_mode: Default::default(),
        candidate_objects: Default::default(),
        outcome_template: None,
        visibility: Default::default(),
        chain_root_targets: vec![],
    };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.answer, p.prompt.as_str()), (Answer::ChooseOption, "Vote for carnage or homage"));
    assert_eq!(ids(&p), ["carnage", "homage"]);
    assert!(p.admits(&Act::ChooseOption { choice: "homage".into() }).is_ok());
    assert!(p.admits(&Act::ChooseOption { choice: "both".into() }).is_err());
    assert!(p.admits(&Act::SubmitVoteCandidate { candidate: 0 }).is_err());
    // A secret vote shows nobody's ballots.
    if let WaitingFor::VoteChoice { ballots, visibility, .. } = &mut m.state.waiting_for {
        ballots.push_back((PlayerId(1), 0));
        *visibility = engine::types::ability::VoteVisibility::Secret;
    }
    let Some(TogetherView::Vote { ballots, secret, options, .. }) = together(&m, 1) else { panic!() };
    assert!(secret && ballots.is_empty());
    assert_eq!(options.iter().map(|o| o.name.clone().unwrap()).collect::<Vec<_>>(), ["carnage", "homage"]);
}

// ── piles ─────────────────────────────────────────────────────────────────

#[test]
fn fact_or_fiction_is_split_by_an_opponent_and_chosen_by_its_caster() {
    let e = engine();
    let mut cards = lands(4, "Island");
    cards.push(("Fact or Fiction", At::Hand));
    for name in ["Opt", "Divination", "Sol Ring", "Esper Sentinel", "Llanowar Elves", "Telling Time"] {
        cards.push((name, At::Top));
    }
    let (mut m, ids_) = table(&e, 3, &cards);
    let fof = ids_[4];
    let five: Vec<ObjectId> = ids_[5..10].to_vec();
    let sixth = ids_[10];
    cast(&mut m, fof);
    assert_eq!(settle(&mut m), 0);
    // With two opponents, the caster chooses who separates (a seat picker).
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChoosePlayer, "pile_opponent", "Choose the opponent who separates the piles"));
    assert_eq!(ids(&p), ["p1", "p2"]);
    assert!(p.options.iter().all(|o| o.zone.as_deref() == Some("player")));
    let Some(TogetherView::Piles { step, cards: shown, chooser, .. }) = together(&m, 2) else { panic!() };
    assert_eq!((step, chooser, shown.len()), ("opponent", 0, 5));
    assert!(refused(&mut m, Act::ChoosePlayer { seat: 0 }).contains("isn't one of the choices"));
    act(&mut m, Act::ChoosePlayer { seat: 1 });
    // Ben splits the five revealed cards.
    let p = pending_of(&m, 1);
    assert_eq!((p.kind, p.answer, p.purpose), (Kind::Pick, Answer::SubmitPilePartition, "piles_split"));
    assert_eq!((p.min, p.max), (0, 5));
    let mut got: Vec<u64> = p.options.iter().map(|o| o.id.parse().unwrap()).collect();
    got.sort();
    let mut want: Vec<u64> = five.iter().map(|c| c.0).collect();
    want.sort();
    assert_eq!(got, want);
    assert!(p.options.iter().all(|o| o.name != "a card" && o.name != "Hidden Card"), "revealed, so named: {:?}", p.options);
    // Everyone sees the revealed cards and who splits; nobody sees the sixth card.
    for seat in 0..3 {
        let Some(TogetherView::Piles { step, splitter, cards: shown, .. }) = together(&m, seat) else { panic!() };
        assert_eq!((step, splitter), ("split", Some(1)));
        assert!(shown.iter().all(|c| c.name.is_some()), "seat {seat}: {shown:?}");
        assert!(!names_seen(&m, seat).contains(&"Telling Time".to_string()), "the sixth card stays hidden from seat {seat}");
        assert!(!shown.iter().any(|c| c.id == Some(sixth.0)));
    }
    assert!(refused_as(&mut m, 1, Act::SubmitPilePartition { pile_a: vec![sixth.0] }).contains("isn't one of the cards"));
    assert!(refused_as(&mut m, 1, Act::SubmitPilePartition { pile_a: vec![five[0].0, five[0].0] }).contains("twice"));
    assert_eq!(
        serde_json::to_value(Act::SubmitPilePartition { pile_a: vec![five[0].0] }).unwrap(),
        json!({ "kind": "submit_pile_partition", "pile_a": [five[0].0] })
    );
    act_as(&mut m, 1, Act::SubmitPilePartition { pile_a: vec![five[0].0] });
    // Ana chooses: pile A is one card, pile B four.
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChoosePile, "piles_choose", "Choose a pile"));
    assert_eq!(p.options.iter().map(|o| (o.id.as_str(), o.text.as_deref())).collect::<Vec<_>>(), [("a", Some("1 card")), ("b", Some("4 cards"))]);
    assert_eq!(p.shown.iter().filter(|c| c.group.as_deref() == Some("a")).count(), 1);
    assert_eq!(p.shown.iter().filter(|c| c.group.as_deref() == Some("b")).count(), 4);
    for seat in 0..3 {
        let Some(TogetherView::Piles { step, pile_a, pile_b, .. }) = together(&m, seat) else { panic!() };
        assert_eq!((step, pile_a.len(), pile_b.len()), ("choose", 1, 4));
    }
    assert_eq!(serde_json::to_value(Act::ChoosePile { pile: Pile::B }).unwrap(), json!({ "kind": "choose_pile", "pile": "b" }));
    act(&mut m, Act::ChoosePile { pile: Pile::B });
    settle(&mut m);
    let hand = &m.state.players[0].hand;
    assert!(five[1..].iter().all(|c| hand.contains(c)), "pile B went to the hand");
    assert!(m.state.players[0].graveyard.contains(&five[0]), "pile A went to the graveyard");
}

// ── a villainous choice ───────────────────────────────────────────────────

#[test]
fn a_villainous_choice_is_each_opponents_and_everyone_sees_who_chose() {
    let e = engine();
    let mut cards = lands(4, "Mountain");
    cards.push(("Ensnared by the Mara", At::Hand));
    let (mut m, ids_) = table(&e, 3, &cards);
    cast(&mut m, ids_[4]);
    let seat = settle(&mut m);
    assert_eq!(seat, 1, "the first opponent faces it");
    let p = pending_of(&m, 1);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseBranch, "branch", "Choose one"));
    assert_eq!(p.options.len(), 2);
    assert!(p.options.iter().all(|o| o.name.len() > 20), "the engine's words for each branch: {:?}", p.options);
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Ensnared by the Mara"));
    let Some(TogetherView::Branch { facing, controller, .. }) = together(&m, 0) else { panic!() };
    assert_eq!(controller, 0);
    assert_eq!(facing, [(1, "choosing"), (2, "waiting")]);
    assert!(refused_as(&mut m, 1, Act::ChooseBranch { index: 5 }).contains("isn't one of the choices"));
    act_as(&mut m, 1, Act::ChooseBranch { index: 1 });
    let seat = settle(&mut m);
    assert_eq!(seat, 2);
    let Some(TogetherView::Branch { facing, .. }) = together(&m, 1) else { panic!() };
    assert_eq!(facing, [(1, "chose"), (2, "choosing")], "who chose shows, not what");
}

// ── coins and dice ────────────────────────────────────────────────────────

#[test]
fn krarks_thumb_keeps_one_of_two_coins() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Krark's Thumb", At::Field), ("Mana Screw", At::Field), ("Plains", At::Field)]);
    let screw = ids_[1];
    let d = m.decision(0).unwrap();
    let use_it = d.options.iter().find(|o| o.object == Some(screw.0) && o.kind == OptionKind::Ability).expect("Mana Screw can be used");
    m.choose(0, d.revision, use_it.index).unwrap();
    // Pay and resolve: the coins come as it resolves.
    for _ in 0..20 {
        if matches!(m.state.waiting_for, WaitingFor::CoinFlipKeepChoice { .. }) {
            break;
        }
        let seat = m.waiting_on()[0];
        let d = m.decision(seat).unwrap();
        let next = d.options.iter().find(|o| matches!(o.kind, OptionKind::Pass | OptionKind::PayRest)).unwrap_or(&d.options[0]);
        m.choose(seat, d.revision, next.index).unwrap();
    }
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SelectCoinFlips, "coin", "Keep one coin"));
    assert_eq!((p.min, p.max), (1, 1));
    assert_eq!(p.options.len(), 2);
    assert!(p.options.iter().all(|o| o.name == "Heads" || o.name == "Tails"));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Mana Screw"), "the card flipping");
    assert!(refused(&mut m, Act::SelectCoinFlips { keep: vec![0, 1] }).contains("exactly 1"));
    assert!(refused(&mut m, Act::SelectCoinFlips { keep: vec![2] }).contains("isn't one of the coins"));
    act(&mut m, Act::SelectCoinFlips { keep: vec![1] });
    assert!(!matches!(m.state.waiting_for, WaitingFor::CoinFlipKeepChoice { .. }));
}

#[test]
fn a_die_is_ignored_only_where_the_engine_allows() {
    // "Roll two d20s and ignore the lower" (Pixie Guide) asks only when the lowest are tied; the
    // engine names the rolls that may be ignored.
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Contact Other Plane", At::Hand)]);
    m.state.waiting_for = WaitingFor::DieKeepChoice { player: PlayerId(0), results: vec![4, 17, 4], ignorable_indices: vec![0, 2], ignore_count: 1 };
    let vs = filter_state_for_viewer(&m.state, PlayerId(0));
    let p = Pending::of(&vs, PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SelectDieRolls, "die", "Ignore one roll"));
    assert_eq!(p.options.iter().map(|o| (o.name.as_str(), o.eligible)).collect::<Vec<_>>(), [("4", true), ("17", false), ("4", true)]);
    assert_eq!((p.min, p.max), (1, 1));
    assert!(p.admits(&Act::SelectDieRolls { ignore: vec![1] }).unwrap_err().contains("can't be ignored"));
    assert!(p.admits(&Act::SelectDieRolls { ignore: vec![0, 2] }).unwrap_err().contains("exactly 1"));
    assert!(p.admits(&Act::SelectDieRolls { ignore: vec![2] }).is_ok());
    assert!(p.admits(&Act::SelectCoinFlips { keep: vec![2] }).is_err());
    let _ = ids_;
}

// ── choosing a player ─────────────────────────────────────────────────────

#[test]
fn a_gift_goes_to_the_opponent_chosen() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Dewdrop Cure", At::Hand));
    let (mut m, ids_) = table(&e, 3, &cards);
    cast(&mut m, ids_[3]);
    // Promise the gift (an optional cost), then choose who gets it.
    for _ in 0..6 {
        let p = pending(&m);
        if p.purpose == "gift" {
            break;
        }
        match p.answer {
            Answer::DecideOptionalCost => act(&mut m, Act::DecideOptionalCost { pay: true }),
            Answer::SelectCards => act(&mut m, Act::SelectCards { cards: vec![] }),
            Answer::ChooseTarget => act(&mut m, Act::ChooseTarget { target: None }),
            other => panic!("asked {other:?}: {}", p.prompt),
        }
    }
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChoosePlayer, "gift", "Choose who gets the gift"));
    assert_eq!(ids(&p), ["p1", "p2"]);
    assert_eq!(p.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Ben", "Cy"]);
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Dewdrop Cure"));
    assert_eq!(serde_json::to_value(Act::ChoosePlayer { seat: 2 }).unwrap(), json!({ "kind": "choose_player", "seat": 2 }));
    let hand = m.state.players[2].hand.len();
    act(&mut m, Act::ChoosePlayer { seat: 2 });
    settle(&mut m);
    assert_eq!(m.state.players[2].hand.len(), hand + 1, "Cy drew the gift");
    assert!(m.log.actions.iter().any(|a| matches!(a.action, GameAction::ChooseGiftRecipient { opponent: PlayerId(2) })), "the engine's own answer is in the replay log");
}

#[test]
fn a_permanent_enters_under_the_opponent_chosen() {
    let e = engine();
    let mut cards = lands(3, "Plains");
    cards.push(("Pendant of Prosperity", At::Hand));
    let (mut m, ids_) = table(&e, 3, &cards);
    let pendant = ids_[3];
    cast(&mut m, pendant);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChoosePlayer, "entry_controller", "Choose the opponent it enters under"));
    act(&mut m, Act::ChoosePlayer { seat: 1 });
    settle(&mut m);
    assert_eq!(m.state.objects[&pendant].controller, PlayerId(1));
}

#[test]
fn every_seat_picker_maps_to_its_own_engine_answer() {
    let e = engine();
    let (mut m, ids_) = table(&e, 4, &[("Lash Out", At::Hand), ("Cuombajj Witches", At::Field)]);
    let vs = |m: &Match| filter_state_for_viewer(&m.state, PlayerId(0));
    let names: Vec<String> = ["Ana", "Ben", "Cy", "Di"].iter().map(|s| s.to_string()).collect();
    let who = vec![PlayerId(1), PlayerId(3)];
    let ability = Box::new(engine::types::ability::ResolvedAbility::new(
        engine::types::ability::Effect::Unimplemented { name: "test".into(), description: None },
        vec![],
        ids_[0],
        PlayerId(0),
    ));
    let cases: Vec<(WaitingFor, &str, GameAction)> = vec![
        (WaitingFor::EntryControllerChoice { player: PlayerId(0), candidates: who.clone() }, "entry_controller", GameAction::ChooseEntryController { opponent: PlayerId(3) }),
        (WaitingFor::ClashChooseOpponent { player: PlayerId(0), candidates: who.clone(), ability: ability.clone() }, "clash_opponent", GameAction::ChooseClashOpponent { opponent: PlayerId(3) }),
        (
            WaitingFor::ChooseFromZoneOpponentChooser { player: PlayerId(0), candidates: who.clone(), ability: ability.clone(), purpose: Default::default() },
            "zone_chooser",
            GameAction::ChooseZoneOpponentChooser { opponent: PlayerId(3) },
        ),
    ];
    for (w, purpose, action) in cases {
        m.state.waiting_for = w;
        let p = Pending::of(&vs(&m), PlayerId(0), &[], &names).unwrap();
        assert_eq!((p.answer, p.purpose), (Answer::ChoosePlayer, purpose));
        assert_eq!(p.options.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.controller)).collect::<Vec<_>>(), [("p1", "Ben", Some(1)), ("p3", "Di", Some(3))]);
        assert!(p.admits(&Act::ChoosePlayer { seat: 2 }).is_err(), "Cy isn't a candidate");
        assert_eq!(crate::together::player_action(p.purpose, 3), Some(action.clone()));
        assert_eq!(Act::from_action(&action), Some(Act::ChoosePlayer { seat: 3 }));
    }
    assert!(Pending::of(&vs(&m), PlayerId(1), &[], &names).is_none(), "only the deciding seat is asked");
}

#[test]
fn a_clash_asks_whom_then_each_player_places_their_card() {
    let e = engine();
    let mut cards = lands(2, "Mountain");
    cards.push(("Lash Out", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs(1)));
    cards.push(("Sol Ring", At::Top));
    let (mut m, ids_) = table(&e, 3, &cards);
    let (lash, bears, ring) = (ids_[2], ids_[3], ids_[4]);
    cast(&mut m, lash);
    aim_if_asked(&mut m, TargetView::Object { id: bears.0 });
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChoosePlayer, "clash_opponent", "Choose an opponent to clash with"));
    act(&mut m, Act::ChoosePlayer { seat: 2 });
    let seat = settle(&mut m);
    // In turn order from the active player: Ana places hers first.
    assert_eq!(seat, 0);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::ChooseTopOrBottom, "clash", "Put Sol Ring on the top or bottom of your library?"));
    assert_eq!(ids(&p), ["top", "bottom"]);
    assert_eq!(p.shown.first().map(|c| c.name.as_str()), Some("Sol Ring"));
    assert_eq!(p.shown.len(), 2, "both revealed cards are shown");
    // Everyone sees both revealed cards, Ben too, who isn't clashing.
    let Some(TogetherView::Clash { cards: shown, placing, .. }) = together(&m, 1) else { panic!("Ben doesn't see the clash") };
    assert_eq!(placing, 0);
    assert_eq!(shown.iter().map(|(seat, c)| (*seat, c.name.clone().unwrap())).next(), Some((0, "Sol Ring".to_string())));
    assert_eq!(shown[1].0, 2);
    assert!(shown.iter().all(|(_, c)| c.id.is_none()), "they're in libraries: no ids to follow");
    act(&mut m, Act::ChooseTopOrBottom { top: false });
    let p = pending_of(&m, 2);
    assert_eq!(p.purpose, "clash");
    act_as(&mut m, 2, Act::ChooseTopOrBottom { top: true });
    settle(&mut m);
    assert_eq!(m.state.players[0].library.back(), Some(&ring), "Ana's card went to the bottom");
}

// ── the library ───────────────────────────────────────────────────────────

#[test]
fn the_owner_puts_a_card_on_top_or_bottom_of_their_library() {
    let e = engine();
    let mut cards = lands(4, "Island");
    cards.push(("Misleading Motes", At::Hand));
    cards.push(("Grizzly Bears", At::Theirs(1)));
    let (mut m, ids_) = table(&e, 2, &cards);
    let (motes, bears) = (ids_[4], ids_[5]);
    cast(&mut m, motes);
    aim_if_asked(&mut m, TargetView::Object { id: bears.0 });
    // The creature's owner chooses (CR 401.4).
    assert_eq!(settle(&mut m), 1);
    let p = pending_of(&m, 1);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::ChooseTopOrBottom, "top_or_bottom", "Put Grizzly Bears on the top or bottom of your library?"));
    assert_eq!(ids(&p), ["top", "bottom"]);
    assert_eq!(p.shown.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Grizzly Bears"]);
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Misleading Motes"));
    assert!(m.decision(0).is_none(), "Ana waits");
    assert_eq!(serde_json::to_value(Act::ChooseTopOrBottom { top: true }).unwrap(), json!({ "kind": "choose_top_or_bottom", "top": true }));
    act_as(&mut m, 1, Act::ChooseTopOrBottom { top: false });
    settle(&mut m);
    assert_eq!(m.state.players[1].library.back(), Some(&bears));
}

#[test]
fn top_or_bottom_names_whose_library() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Grizzly Bears", At::Grave(1))]);
    m.state.waiting_for = WaitingFor::TopOrBottomChoice { player: PlayerId(0), object_id: ids_[0] };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &["Ana".into(), "Ben".into()]).unwrap();
    assert_eq!(p.prompt, "Put Grizzly Bears on the top or bottom of Ben's library?");
    assert!(p.admits(&Act::ChooseTopOrBottom { top: true }).is_ok());
    assert!(p.admits(&Act::SelectCards { cards: vec![ids_[0].0] }).is_err());
}

#[test]
fn cultivate_splits_the_lands_it_found() {
    let e = engine();
    let mut cards = lands(3, "Forest");
    cards.push(("Cultivate", At::Hand));
    // A Forest and a Mountain in the library to find.
    cards.push(("Forest", At::Top));
    cards.push(("Mountain", At::Top));
    let (mut m, ids_) = table(&e, 2, &cards);
    let (forest, mountain) = (ids_[4], ids_[5]);
    cast(&mut m, ids_[3]);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!(p.purpose, "search");
    act(&mut m, Act::SelectCards { cards: vec![forest.0, mountain.0] });
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Pick, Answer::SelectCards, "partition", "Which card goes onto the battlefield tapped?"));
    assert_eq!(p.places, ["Onto the battlefield tapped", "Into your hand"]);
    assert_eq!((p.min, p.max), (1, 1));
    assert!(p.default_answer.is_some(), "the engine's own split is the default");
    assert!(refused(&mut m, Act::SelectCards { cards: vec![forest.0, mountain.0] }).contains("exactly 1"));
    act(&mut m, Act::SelectCards { cards: vec![mountain.0] });
    settle(&mut m);
    assert!(m.state.battlefield.contains(&mountain) && m.state.objects[&mountain].tapped);
    assert!(m.state.players[0].hand.contains(&forest));
}

#[test]
fn telling_time_puts_one_on_top_and_one_on_the_bottom() {
    let e = engine();
    let mut cards = lands(2, "Island");
    cards.push(("Telling Time", At::Hand));
    cards.push(("Opt", At::Top));
    cards.push(("Sol Ring", At::Top));
    cards.push(("Divination", At::Top));
    let (mut m, ids_) = table(&e, 2, &cards);
    let (opt, ring, div) = (ids_[3], ids_[4], ids_[5]);
    cast(&mut m, ids_[2]);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!(p.purpose, "dig");
    act(&mut m, Act::SelectCards { cards: vec![opt.0] });
    let p = pending(&m);
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Order, Answer::SelectCards, "dig_split", "Put a card on top and a card on the bottom"));
    assert_eq!((p.top_count, p.fixed_split, p.min, p.max), (Some(1), false, 2, 2));
    assert!(refused(&mut m, Act::SelectCards { cards: vec![div.0] }).contains("exactly 2"));
    act(&mut m, Act::SelectCards { cards: vec![div.0, ring.0] });
    settle(&mut m);
    assert_eq!(m.state.players[0].library.front(), Some(&div));
    assert_eq!(m.state.players[0].library.back(), Some(&ring));
    assert!(m.state.players[0].hand.contains(&opt));
}

#[test]
fn an_owner_only_orders_a_split_someone_else_made() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Opt", At::Top), ("Sol Ring", At::Top), ("Divination", At::Top)]);
    let (a, b, c) = (ids_[0], ids_[1], ids_[2]);
    m.state.waiting_for = WaitingFor::DigRestSplitChoice {
        player: PlayerId(0),
        library_owner: PlayerId(0),
        cards: vec![a, b, c],
        top_count: 2,
        bottom_count: 1,
        scope: engine::types::ability::DigRestSplitScope::OrderOnly,
        source_id: None,
        completion: None,
    };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
    assert!(p.fixed_split);
    assert!(p.admits(&Act::SelectCards { cards: vec![b.0, a.0, c.0] }).is_ok(), "reordering within the top pile");
    assert!(p.admits(&Act::SelectCards { cards: vec![a.0, c.0, b.0] }).unwrap_err().contains("within each pile"));
}

#[test]
fn manifest_dread_is_chosen_from_cards_only_its_player_sees() {
    let e = engine();
    let mut cards = lands(2, "Forest");
    cards.push(("Manifest Dread", At::Hand));
    cards.push(("Sol Ring", At::Top));
    cards.push(("Divination", At::Top));
    let (mut m, ids_) = table(&e, 2, &cards);
    let (ring, div) = (ids_[3], ids_[4]);
    cast(&mut m, ids_[2]);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose), (Answer::SelectCards, "manifest"));
    assert_eq!(p.places, ["Onto the battlefield face down", "Into your graveyard"]);
    let names: Vec<&str> = p.options.iter().map(|o| o.name.as_str()).collect();
    assert!(names.contains(&"Sol Ring") && names.contains(&"Divination"), "{names:?}");
    // The other seat isn't told: no decision, nothing table-wide, no names.
    assert!(m.decision(1).is_none());
    assert!(together(&m, 1).is_none());
    let theirs = filter_state_for_viewer(&m.state, PlayerId(1));
    assert!(Pending::of(&theirs, PlayerId(0), &[], &[]).map_or(true, |p| p.options.iter().all(|o| o.name != "Sol Ring" && o.name != "Divination")));
    act(&mut m, Act::SelectCards { cards: vec![div.0] });
    settle(&mut m);
    assert!(m.state.players[0].graveyard.contains(&ring));
}

#[test]
fn learn_discards_to_draw_or_does_nothing() {
    let e = engine();
    let mut cards = lands(2, "Forest");
    cards.push(("Cram Session", At::Hand));
    cards.push(("Grizzly Bears", At::Hand));
    let (mut m, ids_) = table(&e, 2, &cards);
    let bears = ids_[3];
    cast(&mut m, ids_[2]);
    settle(&mut m);
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::Learn, "learn", "Learn: discard a card to draw a card?"));
    assert_eq!((p.min, p.max, p.up_to), (0, 1, true));
    assert!(ids(&p).contains(&bears.0.to_string()));
    assert_eq!(serde_json::to_value(Act::Learn { discard: Some(bears.0) }).unwrap(), json!({ "kind": "learn", "discard": bears.0 }));
    act(&mut m, Act::Learn { discard: Some(bears.0) });
    settle(&mut m);
    assert!(m.state.players[0].graveyard.contains(&bears));
}

#[test]
fn a_reveal_land_reveals_a_card_or_none() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Port Town", At::Hand), ("Island", At::Hand)]);
    let (town, island) = (ids_[0], ids_[1]);
    let d = m.decision(0).unwrap();
    let play = d.options.iter().find(|o| o.object == Some(town.0) && o.kind == OptionKind::Land).unwrap();
    m.choose(0, d.revision, play.index).unwrap();
    let p = pending(&m);
    assert_eq!((p.answer, p.purpose, p.prompt.as_str()), (Answer::SelectCards, "reveal", "Reveal a card"));
    assert_eq!((p.min, p.max), (0, 1));
    act(&mut m, Act::SelectCards { cards: vec![island.0] });
    assert!(!m.state.objects[&town].tapped, "revealed, so it enters untapped");
}

#[test]
fn a_reveal_until_offers_the_card_it_found() {
    let e = engine();
    let (mut m, ids_) = table(&e, 2, &[("Hei Bai, Forest Guardian", At::Field), ("Sol Ring", At::Top), ("Honden of Seeing Winds", At::Top)]);
    let (hei, ring, honden) = (ids_[0], ids_[1], ids_[2]);
    // Revealed to everyone, as a reveal-until does.
    m.state.revealed_cards.insert(ring);
    m.state.revealed_cards.insert(honden);
    m.state.waiting_for = WaitingFor::RevealUntilKeptChoice {
        player: PlayerId(0),
        hit_card: honden,
        source_id: hei,
        accept_zone: Zone::Battlefield,
        decline_zone: Zone::Library,
        enter_tapped: Default::default(),
        enters_attacking: false,
        revealed_misses: vec![ring],
        rest_destination: Zone::Library,
        rest_order: Default::default(),
    };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
    assert_eq!((p.kind, p.answer, p.purpose, p.prompt.as_str()), (Kind::Yesno, Answer::DecideOptionalEffect, "kept", "Put Honden of Seeing Winds onto the battlefield?"));
    assert_eq!((p.yes_label.as_deref(), p.no_label.as_deref()), (Some("Onto the battlefield"), Some("Into your library")));
    assert_eq!(p.options.iter().map(|o| (o.name.as_str(), o.eligible)).collect::<Vec<_>>(), [("Sol Ring", false), ("Honden of Seeing Winds", true)]);
}

#[test]
fn life_totals_are_shared_out_from_the_engines_options() {
    let e = engine();
    let (mut m, _) = table(&e, 2, &[]);
    m.state.waiting_for = WaitingFor::RedistributeLifeTotals {
        player: PlayerId(0),
        options: vec![
            engine::types::game_state::LifeRedistributionOption { assignment: vec![(PlayerId(0), 40), (PlayerId(1), 12)] },
            engine::types::game_state::LifeRedistributionOption { assignment: vec![(PlayerId(0), 12), (PlayerId(1), 40)] },
        ],
    };
    let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &["Ana".into(), "Ben".into()]).unwrap();
    assert_eq!((p.answer, p.purpose), (Answer::RedistributeLife, "life"));
    assert_eq!(p.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Ana 40, Ben 12", "Ana 12, Ben 40"]);
    assert!(p.admits(&Act::RedistributeLife { option: 1 }).is_ok());
    assert!(p.admits(&Act::RedistributeLife { option: 2 }).is_err());
}

// ── round trips ───────────────────────────────────────────────────────────

#[test]
fn every_new_engine_answer_round_trips_through_act() {
    let actions = vec![
        GameAction::SubmitVoteCandidate { candidate_index: 2 },
        GameAction::SubmitPilePartition { pile_a: vec![ObjectId(4), ObjectId(9)] },
        GameAction::ChoosePile { pile: engine::types::game_state::PileSide::A },
        GameAction::ChoosePile { pile: engine::types::game_state::PileSide::B },
        GameAction::ChooseBranch { index: 1 },
        GameAction::SelectCoinFlips { keep_indices: vec![0] },
        GameAction::SelectDieRolls { ignore_indices: vec![1] },
        GameAction::ChooseTopOrBottom { top: false },
        GameAction::SubmitLifeRedistribution { option_index: 3 },
        crate::library::learn_action(Some(7)),
        crate::library::learn_action(None),
    ];
    for a in actions {
        let act = Act::from_action(&a).unwrap_or_else(|| panic!("{a:?} has no act"));
        assert_eq!(act.to_action(), Some(a.clone()), "{act:?}");
        let wire = serde_json::to_value(&act).unwrap();
        assert_eq!(serde_json::from_value::<Act>(wire).unwrap(), act);
    }
    // A player is mapped by the decision it answers.
    assert_eq!(Act::from_action(&GameAction::ChooseGiftRecipient { opponent: PlayerId(2) }), Some(Act::ChoosePlayer { seat: 2 }));
    assert_eq!(Act::ChoosePlayer { seat: 2 }.to_action(), None);
    for (purpose, a) in [
        ("gift", GameAction::ChooseGiftRecipient { opponent: PlayerId(2) }),
        ("announcer", GameAction::ChooseAnnouncingOpponent { opponent: PlayerId(2) }),
        ("pile_opponent", GameAction::ChoosePileOpponent { opponent: PlayerId(2) }),
    ] {
        assert_eq!(crate::together::player_action(purpose, 2), Some(a));
    }
}

