//! Turn controls on real games (play/src/turns.rs): the ways to pass, holding priority, Resolve
//! all against the AI and with a person who keeps priority, conceding, trigger yields, turning
//! off a remembered answer, and hand order. Same card fixture as decisions.rs.

use std::path::Path;
use yama_play::act::{AnswerChange, YieldChange};
use yama_play::{Act, Decision, Difficulty, Engine, Match, OptionKind, PassMode, SeatDeck};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/act-cards.json")).unwrap()
}

fn deck(cards: &[(&str, usize)]) -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: cards.iter().flat_map(|(name, n)| vec![name.to_string(); *n]).collect() }
}

fn option(d: &Decision, kind: OptionKind) -> Option<usize> {
    d.options.iter().find(|o| o.kind == kind).map(|o| o.index)
}

/// Turn, active seat and step, as seat 0 sees them.
fn at(m: &Match) -> (u32, u8, String) {
    let v = m.view(Some(0));
    (v.turn, v.active, v.phase)
}

/// Play on with Yama passing for `people` by their turn controls and the AI taking its turns,
/// until `seat` is asked something. Anyone else in `people` who is asked plays a land or passes.
fn to_stop(m: &mut Match, people: &[u8], seat: u8) {
    for _ in 0..3000 {
        m.auto_pass(people);
        if m.decision(seat).is_some() || m.is_over() {
            return;
        }
        if let Some((other, d)) = people.iter().filter(|p| **p != seat).find_map(|p| m.decision(*p).map(|d| (*p, d))) {
            let i = option(&d, OptionKind::Land).or_else(|| option(&d, OptionKind::Pass)).or_else(|| option(&d, OptionKind::Keep)).unwrap_or(0);
            m.choose(other, d.revision, i).unwrap();
            continue;
        }
        assert!(m.run_ai(1).unwrap() > 0 || m.settle_ai_contest(), "nobody could act: {}", m.view(None).waiting);
    }
    panic!("seat {seat} was never asked");
}

/// Keep the opening hand.
fn keep(m: &mut Match, seat: u8) {
    let d = m.decision(seat).expect("the opening hand");
    m.choose(seat, d.revision, option(&d, OptionKind::Keep).unwrap()).unwrap();
}

/// Seat 0 (Mountains) against an AI with only Forests, at seat 0's first main phase.
fn quiet_game(seed: u64) -> Match {
    let mut m = engine().new_match_first(seed, vec![deck(&[("Mountain", 99)]), deck(&[("Forest", 99)])], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    keep(&mut m, 0);
    to_stop(&mut m, &[0], 0);
    assert_eq!(at(&m), (1, 0, "PreCombatMain".into()));
    m
}

#[test]
fn each_way_to_pass_goes_as_far_as_it_says() {
    // Passing once: your second main phase is one of the usual stops.
    let mut m = quiet_game(21);
    let d = m.decision(0).unwrap();
    m.choose(0, d.revision, option(&d, OptionKind::Pass).unwrap()).unwrap();
    to_stop(&mut m, &[0], 0);
    assert_eq!(at(&m), (1, 0, "PostCombatMain".into()));

    // Until something happens: your next stop ends it.
    let mut m = quiet_game(21);
    let d = m.decision(0).unwrap();
    m.set_passing(0, Some(PassMode::Until), d.revision).unwrap();
    assert_eq!(m.view(Some(0)).turns.unwrap().passing, Some(PassMode::Until));
    to_stop(&mut m, &[0], 0);
    assert_eq!(at(&m), (1, 0, "PostCombatMain".into()));
    assert_eq!(m.controls(0).passing, None, "the stop ended it");

    // End turn and Pass to my turn: past your second main phase and through the AI's turn.
    for mode in [PassMode::End, PassMode::Mine] {
        let mut m = quiet_game(21);
        let d = m.decision(0).unwrap();
        m.set_passing(0, Some(mode), d.revision).unwrap();
        to_stop(&mut m, &[0], 0);
        assert_eq!(at(&m), (3, 0, "PreCombatMain".into()), "{mode:?}");
        assert_eq!(m.controls(0).passing, None, "{mode:?} is over once your turn comes");
    }

    // Stopping a mode leaves the passes already made.
    let mut m = quiet_game(21);
    let d = m.decision(0).unwrap();
    m.set_passing(0, Some(PassMode::Mine), d.revision).unwrap();
    let passed_at = m.revision;
    m.set_passing(0, None, 0).unwrap();
    assert_eq!(m.controls(0).passing, None);
    assert!(m.revision >= passed_at);
    assert!(m.view(Some(0)).turns.unwrap().passing.is_none());
}

/// Seat 0 plays Islands and holds Opt; play goes on until it can cast Opt with an Island to spare.
fn opt_ready(m: &mut Match, people: &[u8]) {
    for _ in 0..200 {
        to_stop(m, people, 0);
        let d = m.decision(0).unwrap();
        let untapped = m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.name == "Island" && !c.tapped).count();
        if untapped >= 2 && d.options.iter().any(|o| o.label == "Cast Opt") && m.view(Some(0)).stack.is_empty() {
            return;
        }
        let i = option(&d, OptionKind::Land).or_else(|| option(&d, OptionKind::Pass)).or_else(|| option(&d, OptionKind::Keep)).unwrap_or(0);
        m.choose(0, d.revision, i).unwrap();
    }
    panic!("Opt never came");
}

fn cast_opt(m: &mut Match) {
    let d = m.decision(0).unwrap();
    let i = d.options.iter().find(|o| o.label == "Cast Opt").unwrap().index;
    m.choose(0, d.revision, i).unwrap();
}

#[test]
fn holding_priority_stops_you_for_your_own_spell_until_you_pass() {
    let e = engine();
    let mut m = e.new_match_first(4, vec![deck(&[("Island", 50), ("Opt", 49)]), deck(&[("Forest", 99)])], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    keep(&mut m, 0);
    opt_ready(&mut m, &[0]);
    m.set_hold(0, true);
    cast_opt(&mut m);
    m.auto_pass(&[0]);
    // Your own spell would resolve without asking; holding, you're asked.
    let v = m.view(Some(0));
    assert!(v.stack.iter().any(|s| s.name == "Opt" && s.controller == 0));
    assert!(m.decision(0).is_some_and(|d| option(&d, OptionKind::Pass).is_some()));
    assert!(v.turns.as_ref().unwrap().hold);
    // Passing ends it.
    let d = m.decision(0).unwrap();
    m.choose(0, d.revision, option(&d, OptionKind::Pass).unwrap()).unwrap();
    assert!(!m.controls(0).hold);
    // The engine held it too, and the change replays.
    let again = e.resume(&m.replay_json(), &[(1, Difficulty::Easy)]).unwrap();
    assert_eq!(again.revision, m.revision);
}

#[test]
fn resolve_all_asks_the_table_and_the_ai_agrees_at_once() {
    let e = engine();
    let ai = [(1, Difficulty::Easy), (2, Difficulty::Easy)];
    let decks = vec![deck(&[("Island", 50), ("Opt", 49)]), deck(&[("Forest", 99)]), deck(&[("Forest", 99)])];
    let mut m = e.new_match_first(9, decks, &ai, Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Computer".into(), "Computer 2".into()]);
    keep(&mut m, 0);
    opt_ready(&mut m, &[0]);
    m.set_hold(0, true);
    cast_opt(&mut m);
    m.auto_pass(&[0]);
    let d = m.decision(0).unwrap();
    // Not while someone else is deciding, and nothing to resolve is refused too.
    assert!(m.act(1, d.revision, &Act::ResolveAll).is_err());
    m.act(0, d.revision, &Act::ResolveAll).unwrap();
    // Everyone sees who asked and who has agreed; asking lets go of holding priority.
    let ledger = m.view(None).resolve_all.expect("the table is asked");
    assert_eq!(ledger.asked_by, 0);
    assert_eq!(ledger.seats.iter().map(|s| (s.seat, s.agreed, s.deciding)).collect::<Vec<_>>(), vec![(0, true, false), (1, false, true), (2, false, false)]);
    assert!(!m.controls(0).hold);
    // The AI agrees at once and the stack resolves: Opt's scry comes next.
    to_stop(&mut m, &[0], 0);
    let p = m.decision(0).and_then(|d| d.pending).expect("Opt resolved");
    assert_eq!(p.purpose, "scry");
    assert!(m.view(None).resolve_all.is_none());
    let replay = m.replay_json();
    assert!(replay.contains("BeginResolveAll"));
    assert_eq!(replay.matches("RespondResolveAllConsent").count(), 2, "both AI seats agreed");
    let again = e.resume(&replay, &ai).unwrap();
    assert_eq!(again.view(Some(0)).hand.len(), m.view(Some(0)).hand.len());
}

#[test]
fn a_person_asked_to_resolve_all_can_keep_priority() {
    let e = engine();
    let decks = vec![deck(&[("Island", 50), ("Opt", 49)]), deck(&[("Forest", 99)]), deck(&[("Forest", 99)])];
    let mut m = e.new_match_first(9, decks, &[(2, Difficulty::Easy)], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into(), "Computer".into()]);
    keep(&mut m, 0);
    keep(&mut m, 1);
    opt_ready(&mut m, &[0, 1]);
    m.set_hold(0, true);
    cast_opt(&mut m);
    m.auto_pass(&[0, 1]);
    let d = m.decision(0).unwrap();
    m.act(0, d.revision, &Act::ResolveAll).unwrap();
    // Ben is asked, with the engine's own two answers.
    let ask = m.decision(1).expect("Ben is asked");
    assert!(option(&ask, OptionKind::Agree).is_some());
    let keep_priority = ask.options.iter().find(|o| o.kind == OptionKind::Refuse).unwrap();
    assert_eq!(keep_priority.label, "Keep priority");
    assert_eq!(m.view(Some(1)).resolve_all.unwrap().seats.iter().find(|s| s.deciding).map(|s| s.seat), Some(1));
    // Keeping priority: nothing resolves and Ana is back where she was.
    m.choose(1, ask.revision, keep_priority.index).unwrap();
    assert!(m.view(None).resolve_all.is_none());
    assert!(m.view(Some(0)).stack.iter().any(|s| s.name == "Opt"));
    assert!(m.decision(0).is_some(), "the priority Ana had comes back to her");
}

#[test]
fn a_concession_shows_on_every_seat_and_survives_a_restart() {
    let e = engine();
    let ai = [(2, Difficulty::Easy)];
    let decks = vec![deck(&[("Mountain", 99)]), deck(&[("Forest", 99)]), deck(&[("Plains", 99)])];
    let mut m = e.new_match_first(12, decks, &ai, Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into(), "Computer".into()]);
    keep(&mut m, 0);
    // Ben concedes while Ana is still deciding: allowed at any time.
    m.concede(1).unwrap();
    for viewer in [Some(0), Some(1), None] {
        let v = m.view(viewer);
        let ben = v.players.iter().find(|p| p.seat == 1).unwrap();
        assert!(ben.eliminated && ben.conceded, "{viewer:?}");
        assert!(v.log.iter().any(|l| l.text == "Ben conceded."), "{viewer:?}");
        assert!(!v.players.iter().find(|p| p.seat == 0).unwrap().conceded);
    }
    assert!(!m.is_over(), "the others play on");
    let again = e.resume(&m.replay_json(), &ai).unwrap();
    assert!(again.view(None).players.iter().find(|p| p.seat == 1).unwrap().conceded);
}

#[test]
fn a_trigger_yield_passes_for_you_and_can_be_removed() {
    // Two people: Ana (Islands and Opt) watches Ben (Mountains and Solemn Simulacrum).
    let e = engine();
    let mut m = e.new_match_first(31, vec![deck(&[("Island", 60), ("Opt", 39)]), deck(&[("Mountain", 50), ("Solemn Simulacrum", 49)])], &[], Some(0)).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    keep(&mut m, 0);
    keep(&mut m, 1);
    let ben_trigger_on_top = |m: &Match| {
        let v = m.view(Some(0));
        v.stack.last().is_some_and(|s| s.controller == 1 && s.trigger) && m.decision(0).is_some()
    };
    for _ in 0..6000 {
        if ben_trigger_on_top(&m) {
            break;
        }
        assert!(!m.is_over());
        let seat = m.waiting_on()[0];
        let d = m.decision(seat).unwrap();
        let lands = m.view(Some(1)).battlefield.iter().filter(|c| c.controller == 1 && c.name == "Mountain" && !c.tapped).count();
        let i = option(&d, OptionKind::Land)
            .or_else(|| (seat == 1 && lands >= 4).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Solemn")).map(|o| o.index)).flatten())
            .or_else(|| option(&d, OptionKind::Pass))
            .or_else(|| option(&d, OptionKind::Keep))
            .unwrap_or(0);
        m.choose(seat, d.revision, i).unwrap();
    }
    assert!(ben_trigger_on_top(&m), "Solemn's trigger never reached the stack");
    let top = m.view(Some(0)).stack.last().cloned().unwrap();
    // A card that isn't a trigger on the stack can't be yielded to.
    let refused = m.act(0, 0, &Act::SetPriorityYield { change: YieldChange::Add { source: top.source + 9_999, every: false } });
    assert_eq!(refused.unwrap_err().to_string(), "That isn't a trigger on the stack.");
    // Yield to it: any revision does, it's Ana's own setting.
    m.act(0, 0, &Act::SetPriorityYield { change: YieldChange::Add { source: top.source, every: false } }).unwrap();
    let v = m.view(Some(0));
    assert!(v.stack.last().unwrap().yielded);
    let yields = v.turns.unwrap().yields;
    assert_eq!(yields.len(), 1);
    assert_eq!((yields[0].name.as_str(), yields[0].controller, yields[0].every), ("Solemn Simulacrum", Some(1), false));
    // Ben doesn't see Ana's yields.
    assert!(m.view(Some(1)).turns.unwrap().yields.is_empty());
    // Yama passes for her while it's on top.
    assert!(m.auto_pass(&[0]) >= 1);
    // Removing it with what the view lists.
    m.act(0, 0, &yields[0].remove).unwrap();
    assert!(m.view(Some(0)).turns.unwrap().yields.is_empty());
    assert!(m.act(0, 0, &yields[0].remove).is_err(), "already off");
    let again = e.resume(&m.replay_json(), &[]).unwrap();
    assert_eq!(again.revision, m.revision);
}

#[test]
fn a_remembered_answer_shows_in_the_log_and_turns_off() {
    let e = engine();
    let me = deck(&[("Mountain", 40), ("Solemn Simulacrum", 59)]);
    let mut m = e.new_match_first(6, vec![me, deck(&[("Forest", 99)])], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    keep(&mut m, 0);
    let mut remembered = false;
    let mut logged = None;
    for _ in 0..400 {
        to_stop(&mut m, &[0], 0);
        if let Some(line) = m.view(Some(0)).log.iter().find(|l| l.auto.is_some()) {
            logged = Some(line.clone());
            break;
        }
        let d = m.decision(0).unwrap();
        if let Some(p) = d.pending.as_ref() {
            if p.purpose == "may" && !remembered {
                // Remember "yes" for every copy where the engine can, else for this one.
                m.act(0, d.revision, &Act::DecideOptionalEffectAndRemember { accept: true, same_card: p.remember_same_card }).unwrap();
                remembered = true;
                continue;
            }
            // A search or anything else: the engine's own sample answers it.
        }
        let lands = m.view(Some(0)).battlefield.iter().filter(|c| c.controller == 0 && c.types.iter().any(|t| t == "Land") && !c.tapped).count();
        let i = option(&d, OptionKind::Land)
            .or_else(|| (lands >= 4).then(|| d.options.iter().find(|o| o.label.starts_with("Cast Solemn")).map(|o| o.index)).flatten())
            .or_else(|| option(&d, OptionKind::Pass))
            .unwrap_or(0);
        m.choose(0, d.revision, i).unwrap();
    }
    assert!(remembered, "Solemn's trigger never asked");
    let answers = m.view(Some(0)).turns.unwrap().answers;
    assert_eq!(answers.len(), 1);
    assert_eq!((answers[0].kind, answers[0].name.as_str(), answers[0].answer.as_str()), ("may", "Solemn Simulacrum", "Always yes"));
    // Remembered for every copy, so the next Solemn's trigger was answered from memory, and the
    // log says so to this seat only.
    assert_eq!(answers[0].scope, "copies");
    let line = logged.expect("the next Solemn's answer was logged");
    assert_eq!(line.text, "Yama answered yes for Solemn Simulacrum, as you asked.");
    assert_eq!(line.auto.as_deref(), Some(answers[0].id.as_str()));
    assert!(!m.view(None).log.iter().any(|l| l.auto.is_some()), "spectators don't see it");
    assert!(!m.view(Some(1)).log.iter().any(|l| l.auto.is_some()));
    // Turning it off with what the list carries.
    m.act(0, 0, &answers[0].forget).unwrap();
    assert!(m.view(Some(0)).turns.unwrap().answers.is_empty());
    assert!(matches!(&answers[0].forget, Act::SetMayTriggerAutoChoice { change: AnswerChange::Remove { .. } }));
    assert!(m.act(0, 0, &answers[0].forget).is_err(), "already off");
}

#[test]
fn your_hand_can_be_put_in_any_order_at_any_time() {
    let mut m = quiet_game(21);
    let hand: Vec<u64> = m.view(Some(0)).hand.iter().map(|c| c.id).collect();
    let mut reversed = hand.clone();
    reversed.reverse();
    m.act(0, 0, &Act::ReorderHand { order: reversed.clone() }).unwrap();
    assert_eq!(m.view(Some(0)).hand.iter().map(|c| c.id).collect::<Vec<_>>(), reversed);
    let short = &reversed[1..];
    assert_eq!(m.act(0, 0, &Act::ReorderHand { order: short.to_vec() }).unwrap_err().to_string(), "Put every card in your hand in the order once.");
    // Even while someone else decides.
    assert!(m.decision(1).is_none());
    m.act(0, 0, &Act::ReorderHand { order: hand.clone() }).unwrap();
    assert_eq!(m.view(Some(0)).hand.iter().map(|c| c.id).collect::<Vec<_>>(), hand);
}

#[test]
fn holding_priority_outlasts_passing_on_a_response() {
    // Two people with Islands and Opt: Ana holds priority for her Opt and Ben answers with his.
    let e = engine();
    let blue = || deck(&[("Island", 50), ("Opt", 49)]);
    let mut m = e.new_match_first(4, vec![blue(), blue()], &[], Some(0)).unwrap();
    keep(&mut m, 0);
    keep(&mut m, 1);
    opt_ready(&mut m, &[0, 1]);
    m.set_hold(0, true);
    cast_opt(&mut m);
    m.auto_pass(&[0, 1]);
    // Ana is held with her own Opt on top; she passes, and Ben responds with his.
    let d = m.decision(0).expect("held");
    m.choose(0, d.revision, option(&d, OptionKind::Pass).unwrap()).unwrap();
    assert!(!m.controls(0).hold, "passing over her own spell ends it");
    m.set_hold(0, true);
    let theirs = m.decision(1).expect("Ben may respond");
    let Some(ben_opt) = theirs.options.iter().find(|o| o.label == "Cast Opt") else {
        panic!("Ben can't cast Opt: {:?}", theirs.options.iter().map(|o| &o.label).collect::<Vec<_>>());
    };
    m.choose(1, theirs.revision, ben_opt.index).unwrap();
    m.auto_pass(&[0, 1]);
    // Ana passes over Ben's Opt: she still holds, so she's asked again before hers resolves.
    let d = m.decision(0).expect("asked about Ben's Opt");
    m.choose(0, d.revision, option(&d, OptionKind::Pass).unwrap()).unwrap();
    assert!(m.controls(0).hold);
    for _ in 0..20 {
        m.auto_pass(&[0, 1]);
        if m.decision(0).is_some() {
            break;
        }
        // Ben's scry, and his passes.
        let d = m.decision(1).expect("someone is asked");
        let act = d.pending.as_ref().filter(|p| p.purpose == "scry").map(|_| Act::SelectCards { cards: vec![] });
        match act {
            Some(a) => m.act(1, d.revision, &a).unwrap(),
            None => m.choose(1, d.revision, option(&d, OptionKind::Pass).unwrap_or(0)).unwrap(),
        }
    }
    let v = m.view(Some(0));
    assert_eq!(v.stack.last().map(|s| (s.name.as_str(), s.controller)), Some(("Opt", 0)), "her own Opt is on top again");
    assert!(m.decision(0).is_some_and(|d| option(&d, OptionKind::Pass).is_some()), "and she's asked");
}
