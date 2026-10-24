//! What a person's decisions say and keep, on real games over a small slice of phase's card
//! data (tests/fixtures/act-cards.json: basic lands, Opt, Preordain, Rampant Growth, Blaze,
//! Chandra, Torch of Defiance and Combat Celebrant, taken from card-data-eb309108eb0df708.json
//! with the printing lists, legalities and metadata removed).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use yama_play::{Decision, Difficulty, Engine, Match, OptionKind, SeatDeck};

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
    let full = HashSet::from([0u8]);
    assert_eq!(m.auto_pass(&[0], &full, &HashMap::new()), 0);
    assert!(m.decision(0).is_some());
    // Otherwise Yama passes for you, and the spell goes on to resolve once the others pass.
    assert!(m.auto_pass(&[0], &HashSet::new(), &HashMap::new()) >= 1);
    assert_ne!(m.waiting_on(), vec![0], "the opponent gets their chance to respond");
}
