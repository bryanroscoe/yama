//! What a person's decisions say and keep, on real games over a small slice of phase's card
//! data (tests/fixtures/act-cards.json: basic lands, Opt, Preordain, Rampant Growth, Blaze,
//! Chandra, Torch of Defiance, Combat Celebrant, Solemn Simulacrum and Silverblade Paladin, taken
//! from card-data-eb309108eb0df708.json with the printing lists, legalities and metadata removed).

use std::collections::HashSet;
use std::path::Path;
use engine::types::game_state::YieldTarget;
use engine::types::identifiers::ObjectId;
use yama_play::act::{AnswerChange, Answer, Kind, RememberedReplacement, YieldChange};
use yama_play::{Act, ChoiceError, Decision, Difficulty, Engine, Match, OptionKind, SeatDeck, TargetView};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/act-cards.json")).unwrap()
}

fn deck(cards: &[(&str, usize)]) -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: cards.iter().flat_map(|(name, n)| vec![name.to_string(); *n]).collect() }
}

fn option(d: &Decision, kind: OptionKind) -> Option<usize> {
    d.options.iter().find(|o| o.kind == kind).map(|o| o.index)
}

/// Seat 0 plays by `pick` (an option index, or `None` to pass); every other seat is the AI.
/// Stops when `done` says so, and fails if that doesn't happen within `steps` actions.
fn drive(m: &mut Match, steps: usize, mut pick: impl FnMut(&Match, &Decision) -> Option<usize>, done: impl Fn(&Match) -> bool) {
    for _ in 0..steps {
        if done(m) {
            return;
        }
        assert!(!m.is_over(), "the game ended first");
        if let Some(d) = m.decision(0) {
            let i = pick(m, &d).or_else(|| option(&d, OptionKind::Pass)).or_else(|| option(&d, OptionKind::Keep)).unwrap_or(0);
            m.choose(0, d.revision, i).unwrap_or_else(|e| panic!("{e}: {:?}", d.options.get(i).map(|o| &o.label)));
        } else {
            assert!(m.run_ai(1).unwrap() > 0 || m.settle_ai_contest(), "nobody could act");
        }
    }
    panic!("not reached in {steps} actions");
}

/// Play a land when you can, then the first spell of `name`.
fn lands_then(name: &'static str) -> impl FnMut(&Match, &Decision) -> Option<usize> {
    move |_, d| {
        option(d, OptionKind::Land).or_else(|| d.options.iter().find(|o| o.kind == OptionKind::Spell && o.label.starts_with(&format!("Cast {name}"))).map(|o| o.index))
    }
}

#[test]
fn keep_names_the_hand_you_keep_after_a_mulligan() {
    let e = engine();
    let d = deck(&[("Mountain", 99)]);
    let mut m = e.new_match_first(3, vec![d.clone(), d.clone(), d], &[(1, Difficulty::Easy), (2, Difficulty::Easy)], Some(0)).unwrap();
    let first = m.decision(0).expect("everyone decides on their opening hand");
    let mull = first.mulligan.clone().expect("mulligan sizes");
    // Commander with three players: the first mulligan is free.
    assert_eq!((mull.keep, mull.next_keep, mull.mulligans, mull.free), (7, 7, 0, true));
    m.choose(0, first.revision, option(&first, OptionKind::Mulligan).unwrap()).unwrap();
    let second = m.decision(0).unwrap();
    let mull = second.mulligan.clone().unwrap();
    assert_eq!((mull.keep, mull.next_keep, mull.mulligans, mull.free), (7, 6, 1, false));
    m.choose(0, second.revision, option(&second, OptionKind::Mulligan).unwrap()).unwrap();
    let third = m.decision(0).unwrap();
    // Two mulligans, one free: keeping now means one card to the bottom.
    assert_eq!(third.mulligan.as_ref().map(|v| (v.keep, v.next_keep)), Some((6, 5)));
}

#[test]
fn a_decision_another_seat_doesnt_change_keeps_its_revision() {
    let e = engine();
    let d = deck(&[("Mountain", 99)]);
    // Two people and no AI: both decide on their hands at once.
    let mut m = e.new_match_first(5, vec![d.clone(), d], &[], Some(0)).unwrap();
    let mine = m.decision(0).unwrap();
    let theirs = m.decision(1).unwrap();
    m.choose(1, theirs.revision, option(&theirs, OptionKind::Keep).unwrap()).unwrap();
    assert!(m.revision > mine.revision);
    let still = m.decision(0).unwrap();
    assert_eq!(still.revision, mine.revision, "seat 1 keeping doesn't change seat 0's decision");
    // So seat 0's answer, sent before seat 1 kept, still counts.
    m.choose(0, mine.revision, option(&mine, OptionKind::Mulligan).unwrap()).unwrap();
    // An answer to a decision that did change is still refused.
    let next = m.decision(0).unwrap();
    assert_ne!(next.revision, mine.revision);
    assert!(m.choose(0, mine.revision, 0).is_err());
}

#[test]
fn a_planeswalkers_abilities_are_separate_options_in_their_own_words() {
    let e = engine();
    let me = deck(&[("Mountain", 40), ("Chandra, Torch of Defiance", 59)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(11, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    let chandra = |m: &Match| m.decision(0).is_some_and(|d| d.options.iter().any(|o| o.kind == OptionKind::Ability));
    drive(&mut m, 4000, lands_then("Chandra"), chandra);
    let d = m.decision(0).unwrap();
    let abilities: Vec<_> = d.options.iter().filter(|o| o.kind == OptionKind::Ability).collect();
    let labels: HashSet<&str> = abilities.iter().map(|o| o.label.as_str()).collect();
    let indexes: HashSet<usize> = abilities.iter().filter_map(|o| o.ability).collect();
    assert!(abilities.len() >= 2, "{:?}", d.options.iter().map(|o| &o.label).collect::<Vec<_>>());
    assert_eq!(labels.len(), abilities.len(), "every ability reads differently");
    assert_eq!(indexes.len(), abilities.len(), "and points at its own ability");
    assert!(labels.contains("+1: Add {R}{R}."), "{labels:?}");
    assert!(labels.iter().any(|l| l.starts_with("+1: Exile the top card of your library") && l.contains("Chandra, Torch of Defiance deals 2 damage")));
}

#[test]
fn your_own_spell_resolves_without_asking_unless_you_want_full_control() {
    let e = engine();
    let me = deck(&[("Island", 50), ("Opt", 49)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(4, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    // Cast Opt with two Islands up, so a second Opt could answer the first.
    let untapped = |m: &Match| m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Island" && !c.tapped).count();
    let opt_with_mana_left = move |m: &Match, d: &Decision| option(d, OptionKind::Land).or_else(|| (untapped(m) >= 2).then(|| d.options.iter().find(|o| o.label == "Cast Opt").map(|o| o.index)).flatten());
    let on_stack = |m: &Match| m.view(Some(0)).stack.iter().any(|s| s.name == "Opt") && m.decision(0).is_some();
    drive(&mut m, 4000, opt_with_mana_left, on_stack);
    assert!(m.decision(0).unwrap().options.iter().any(|o| o.kind == OptionKind::Spell), "a second Opt could respond");
    // Full control: you're asked about your own spell too.
    m.set_full_control(0, true);
    assert_eq!(m.auto_pass(&[0]), 0);
    assert!(m.decision(0).is_some());
    // Otherwise Yama passes for you, and the spell goes on to resolve once the others pass.
    m.set_full_control(0, false);
    assert!(m.auto_pass(&[0]) >= 1);
    assert_ne!(m.waiting_on(), vec![0], "the opponent gets their chance to respond");
}

/// Seat 0's current decision, if it's described by `purpose`.
fn pending(m: &Match, purpose: &str) -> Option<yama_play::Pending> {
    m.decision(0).and_then(|d| d.pending).filter(|p| p.purpose == purpose)
}

#[test]
fn a_scry_is_answered_in_full_and_only_by_its_seat() {
    let e = engine();
    let me = deck(&[("Island", 50), ("Opt", 49)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(4, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    drive(&mut m, 4000, lands_then("Opt"), |m| pending(m, "scry").is_some());
    let p = pending(&m, "scry").unwrap();
    assert_eq!((p.kind, p.answer, p.min, p.max, p.up_to, p.ordered, p.destination), (Kind::Pick, Answer::SelectCards, 0, 1, true, true, Some("top")));
    assert_eq!(p.prompt, "Scry 1");
    let looked = &p.options[0];
    // The deciding seat sees the library card it scries; nobody else is asked or told.
    assert!(looked.name == "Island" || looked.name == "Opt", "{looked:?}");
    assert_eq!(looked.zone.as_deref(), Some("library"));
    assert!(m.view(Some(1)).decision.is_none());
    assert!(m.view(None).decision.is_none());

    let revision = m.decision(0).unwrap().revision;
    let before = m.revision;
    // Another seat, a card that isn't offered, an answer of the wrong kind: refused, game unchanged.
    assert!(matches!(m.act(1, revision, &Act::SelectCards { cards: vec![] }), Err(ChoiceError::NotYourTurn)));
    let id: u64 = looked.id.parse().unwrap();
    let err = m.act(0, revision, &Act::SelectCards { cards: vec![id + 100_000] }).unwrap_err();
    assert_eq!(err.to_string(), "That card isn't one of the choices.");
    let err = m.act(0, revision, &Act::OrderTriggers { order: vec![0] }).unwrap_err();
    assert_eq!(err.to_string(), "That answer doesn't fit this decision.");
    assert_eq!(m.revision, before);
    // Keep it on top.
    m.act(0, revision, &Act::SelectCards { cards: vec![id] }).unwrap();
    assert!(m.revision > before);
    assert!(pending(&m, "scry").is_none());
}

#[test]
fn x_and_a_target_are_answered_with_act() {
    let e = engine();
    let me = deck(&[("Mountain", 50), ("Blaze", 49)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(9, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    // Cast Blaze once three Mountains are out.
    let mountains = |m: &Match| m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Mountain" && !c.tapped).count();
    let blaze = move |m: &Match, d: &Decision| option(d, OptionKind::Land).or_else(|| (mountains(m) >= 3).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Blaze")).map(|o| o.index)).flatten());
    drive(&mut m, 4000, blaze, |m| pending(m, "x").is_some() || pending(m, "target").is_some());
    // The engine may ask for the target or X first; answer whichever comes, then the other.
    for _ in 0..2 {
        let d = m.decision(0).unwrap();
        let p = d.pending.clone().unwrap();
        match p.purpose {
            "x" => {
                assert_eq!((p.kind, p.answer), (Kind::Number, Answer::ChooseX));
                assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Blaze"));
                let too_many = (p.max + 1) as u32;
                assert!(m.act(0, d.revision, &Act::ChooseX { value: too_many }).unwrap_err().to_string().starts_with("X must be between"));
                m.act(0, d.revision, &Act::ChooseX { value: 1 }).unwrap();
            }
            "target" => {
                assert_eq!((p.kind, p.answer), (Kind::Pick, Answer::ChooseTarget));
                assert!(p.options.iter().any(|o| o.id == "p1" && o.zone.as_deref() == Some("player")), "{:?}", p.options);
                m.act(0, d.revision, &Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }).unwrap();
            }
            other => panic!("unexpected {other}"),
        }
        if pending(&m, "x").is_none() && pending(&m, "target").is_none() {
            break;
        }
    }
    // Blaze is on the stack, cast with X = 1 at the opponent.
    assert!(m.view(Some(0)).stack.iter().any(|s| s.name == "Blaze"));
}

#[test]
fn a_search_offers_only_what_it_may_find() {
    let e = engine();
    let me = deck(&[("Forest", 40), ("Rampant Growth", 59)]);
    let them = deck(&[("Mountain", 99)]);
    let mut m = e.new_match_first(2, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    let forests = |m: &Match| m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Forest" && !c.tapped).count();
    let growth = move |m: &Match, d: &Decision| option(d, OptionKind::Land).or_else(|| (forests(m) >= 2).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Rampant Growth")).map(|o| o.index)).flatten());
    drive(&mut m, 4000, growth, |m| pending(m, "search").is_some());
    let d = m.decision(0).unwrap();
    let p = d.pending.unwrap();
    assert_eq!((p.kind, p.max), (Kind::Pick, 1));
    assert!(p.options.iter().all(|o| o.name == "Forest" && o.zone.as_deref() == Some("library")), "only basic lands: {:?}", p.options);
    // Rampant Growth isn't a basic land, so it isn't a choice, even though it's in the library.
    let hand_card = m.view(Some(0)).hand.iter().find(|c| c.name == "Rampant Growth").map(|c| c.id).unwrap();
    assert!(m.act(0, d.revision, &Act::SelectCards { cards: vec![hand_card] }).is_err());
    let forest: u64 = p.options[0].id.parse().unwrap();
    let lands = m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Forest").count();
    m.act(0, d.revision, &Act::SelectCards { cards: vec![forest] }).unwrap();
    assert_eq!(m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Forest").count(), lands + 1);
}

#[test]
fn every_answer_round_trips_through_the_engines_action() {
    let answers = [
        Act::SelectCards { cards: vec![3, 1] },
        Act::OrderTriggers { order: vec![1, 0] },
        Act::SelectModes { indices: vec![0, 2] },
        Act::ChooseX { value: 4 },
        Act::ChooseTarget { target: Some(TargetView::Object { id: 9 }) },
        Act::ChooseTarget { target: None },
        Act::CancelCast,
        Act::PayUnlessCost { pay: true },
        Act::DecideOptionalEffect { accept: false },
        Act::ChooseOption { choice: "Goblin".into() },
        Act::ChooseReplacement { index: 1 },
        Act::AssignCombatDamage { assignments: vec![(5, 2), (6, 1)], trample: 3, controller: 0, unblocked: false },
        Act::DistributeAmong { distribution: vec![(TargetView::Player { seat: 2 }, 2), (TargetView::Object { id: 4 }, 1)] },
        Act::DecideOptionalEffectAndRemember { accept: true, same_card: false },
        Act::DecideOptionalEffectAndRemember { accept: false, same_card: true },
        Act::ChooseReplacementAndRemember { choice: RememberedReplacement::Order { order: vec![1, 0] } },
        Act::ChooseReplacementAndRemember { choice: RememberedReplacement::Optional { index: 1 } },
        Act::ChoosePair { partner: Some(7) },
        Act::ChoosePair { partner: None },
        // A seat's own settings and Resolve all (play/src/turns.rs).
        Act::SetPriorityYield { change: YieldChange::Add { source: 12, every: true } },
        Act::SetPriorityYield { change: YieldChange::Remove { target: YieldTarget::ThisObject { source_id: ObjectId(12), incarnation: Some(2), trigger_description: None } } },
        Act::SetPriorityYield { change: YieldChange::ClearAll },
        Act::SetMayTriggerAutoChoice { change: AnswerChange::ClearAll },
        Act::SetReplacementAutoChoice { id: Some("r-1".into()) },
        Act::SetReplacementAutoChoice { id: None },
        Act::ReorderHand { order: vec![5, 3, 4] },
        Act::ResolveAll,
    ];
    for a in answers {
        assert_eq!(Act::from_action(&a.to_action()), Some(a.clone()));
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(serde_json::from_str::<Act>(&json).unwrap(), a, "{json}");
    }
}

#[test]
fn a_may_trigger_can_be_answered_and_remembered() {
    let e = engine();
    let me = deck(&[("Mountain", 50), ("Solemn Simulacrum", 49)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(6, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    let lands = |m: &Match| m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Mountain" && !c.tapped).count();
    let solemn = move |m: &Match, d: &Decision| option(d, OptionKind::Land).or_else(|| (lands(m) >= 4).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Solemn")).map(|o| o.index)).flatten());
    drive(&mut m, 4000, solemn, |m| pending(m, "may").is_some());
    let d = m.decision(0).unwrap();
    let p = d.pending.clone().unwrap();
    // Solemn's own trigger: the engine can remember the answer for this card.
    assert_eq!((p.kind, p.answer, p.remember), (Kind::Yesno, Answer::DecideOptionalEffect, Some("engine")));
    assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Solemn Simulacrum"));
    m.act(0, d.revision, &Act::DecideOptionalEffectAndRemember { accept: true, same_card: false }).unwrap();
    // Accepted: the search it offers comes next.
    assert!(pending(&m, "search").is_some(), "{:?}", m.decision(0).map(|d| d.prompt));
}

#[test]
fn soulbond_is_answered_with_a_partner() {
    let e = engine();
    let me = deck(&[("Mountain", 30), ("Plains", 30), ("Silverblade Paladin", 39)]);
    let them = deck(&[("Forest", 99)]);
    let mut m = e.new_match_first(8, vec![me, them], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    let untapped = |m: &Match| m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.types.iter().any(|t| t == "Land") && !c.tapped).count();
    let celebrant_out = |m: &Match| m.view(Some(0)).battlefield.iter().any(|c| c.controller == 0 && c.name == "Combat Celebrant");
    let play = move |m: &Match, d: &Decision| {
        option(d, OptionKind::Land)
            .or_else(|| (untapped(m) >= 3 && !celebrant_out(m)).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Combat Celebrant")).map(|o| o.index)).flatten())
            .or_else(|| (untapped(m) >= 3 && celebrant_out(m)).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Silverblade")).map(|o| o.index)).flatten())
            // The pairing may come as a "may" first: say yes.
            .or_else(|| d.pending.as_ref().filter(|p| p.purpose == "may").and_then(|_| d.options.iter().find(|o| o.label.starts_with("Yes") || o.label.contains("ccept")).map(|o| o.index)))
    };
    drive(&mut m, 8000, play, |m| pending(m, "pair").is_some());
    let d = m.decision(0).unwrap();
    let p = d.pending.clone().unwrap();
    assert_eq!((p.kind, p.answer, p.min, p.max), (Kind::Pair, Answer::ChoosePair, 0, 1));
    let celebrant = p.options.iter().find(|o| o.name == "Combat Celebrant").expect("the commander can be paired");
    let partner: u64 = celebrant.id.parse().unwrap();
    // Something that isn't offered is refused, and the game stays as it was.
    let before = m.revision;
    assert!(m.act(0, d.revision, &Act::ChoosePair { partner: Some(partner + 100_000) }).is_err());
    assert_eq!(m.revision, before);
    m.act(0, d.revision, &Act::ChoosePair { partner: Some(partner) }).unwrap();
    assert!(pending(&m, "pair").is_none());
}
