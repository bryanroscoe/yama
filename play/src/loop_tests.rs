//! Loops in games people play (CR 732): phase's interactive loop detection, which online games
//! and games against the AI start with ([`crate::PLAY_LOOPS`]), driven the way the server's game
//! thread drives a game (pass for people where their turn controls say to, then let the AI seats
//! act). Cards come from tests/fixtures/loop-cards.json, a slice of phase's card data: Sanguine
//! Bond, Exquisite Blood, Marauding Blight-Priest, Bloodthirsty Conqueror, Chaplain's Blessing,
//! Lightning Bolt, Zaffai, Thunder Conductor, Brass's Bounty, Opt, basic lands, Combat Celebrant as
//! everyone's commander, and one card made up for the draw: "Endless Wellspring" ("Whenever you
//! gain life, you gain 1 life", Sanguine Bond's trigger with Soul Warden's effect), since no
//! printed card loops on its own without anyone losing.

use engine::game::layers::evaluate_layers;
use engine::types::game_state::{LoopDetectionMode, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

use crate::pay::PayMode;
use crate::{Act, Difficulty, Engine, Match, OptionKind, SeatDeck, Setup};

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/loop-cards.json")).unwrap()
}

/// Where a card starts, and whose it is.
#[derive(Clone, Copy)]
enum At {
    /// On this seat's battlefield.
    Field(u8),
    /// In this seat's hand.
    Hand(u8),
}

impl At {
    fn seat(self) -> u8 {
        match self {
            At::Field(s) | At::Hand(s) => s,
        }
    }
}

/// A two-player game (Ana, seat 0, and Ben) at Ana's turn 3 main phase with priority, each card
/// where it's asked for. `ai` seats play phase's Easy AI. Returns the card ids in the order given.
fn table(loops: LoopDetectionMode, ai: &[u8], cards: &[(&str, At)]) -> (Match, Vec<ObjectId>) {
    let e = engine();
    let deck = |seat: u8| {
        let mut main: Vec<String> = cards.iter().filter(|(_, at)| at.seat() == seat).map(|(n, _)| n.to_string()).collect();
        main.resize(99, "Plains".into());
        SeatDeck { commander: vec!["Combat Celebrant".into()], main, ..Default::default() }
    };
    let ai: Vec<(u8, Difficulty)> = ai.iter().map(|s| (*s, Difficulty::Easy)).collect();
    let mut m = e.new_match_with(5, vec![deck(0), deck(1)], &ai, Setup { first: Some(0), loops }).unwrap();
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    let mut ids = vec![];
    for (name, at) in cards {
        let seat = usize::from(at.seat());
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
            At::Field(_) => {
                m.state.battlefield.push_back(id);
                Zone::Battlefield
            }
            At::Hand(_) => {
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
    // Hands hold only what's asked for, so nobody has a spell to answer with by accident.
    for seat in 0..2 {
        let keep: Vec<ObjectId> = ids.iter().copied().filter(|id| m.state.players[seat].hand.contains(id)).collect();
        let extra: Vec<ObjectId> = m.state.players[seat].hand.iter().copied().filter(|id| !keep.contains(id)).collect();
        for id in extra {
            m.state.players[seat].hand.retain(|c| *c != id);
            m.state.players[seat].library.push_back(id);
            m.state.objects.get_mut(&id).unwrap().zone = Zone::Library;
        }
    }
    evaluate_layers(&mut m.state);
    m.state.turn_number = 3;
    m.state.active_player = PlayerId(0);
    m.state.priority_player = PlayerId(0);
    m.state.phase = Phase::PreCombatMain;
    m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
    (m, ids)
}

/// What the server's game thread does after each move (`ai_turns` in server/src/play.rs): pass
/// for people where their turn controls say to, let the AI seats act, and again, until a person
/// has a decision or the game is over. Returns how many actions that took; fails past `cap`, which
/// only a loop nobody stops reaches.
fn drive(m: &mut Match, humans: &[u8], cap: usize) -> usize {
    let mut n = 0;
    loop {
        let passed = m.auto_pass(humans);
        let acted = m.run_ai(40).unwrap_or_else(|e| panic!("the AI failed: {e:#}"));
        n += passed + acted;
        if passed + acted == 0 || m.is_over() {
            return n;
        }
        assert!(n < cap, "still going after {n} actions: {:?}", m.state.waiting_for);
    }
}

fn act_as(m: &mut Match, seat: u8, a: Act) {
    let d = m.decision(seat).unwrap_or_else(|| panic!("seat {seat} doesn't decide; {:?} does", m.waiting_on()));
    m.act(seat, d.revision, &a).unwrap_or_else(|e| panic!("{a:?} refused: {e}"));
}

fn cast(m: &mut Match, id: ObjectId) {
    act_as(m, 0, Act::CastSpell { object: id.0, payment: PayMode::Auto });
}

fn life(m: &Match, seat: usize) -> i32 {
    m.state.players[seat].life
}

/// Ana's drain: Sanguine Bond and Exquisite Blood, then 5 life from Chaplain's Blessing. Each
/// life gain makes Ben lose that much, which gains Ana as much, for ever: mandatory triggers, and
/// Ben has nothing to answer with.
fn bond_and_blood(loops: LoopDetectionMode, ai: &[u8]) -> (Match, ObjectId) {
    let (m, ids) = table(
        loops,
        ai,
        &[("Sanguine Bond", At::Field(0)), ("Exquisite Blood", At::Field(0)), ("Plains", At::Field(0)), ("Chaplain's Blessing", At::Hand(0))],
    );
    (m, ids[3])
}

#[test]
fn a_mandatory_lethal_loop_ends_the_game_at_once() {
    let (mut m, blessing) = bond_and_blood(LoopDetectionMode::Interactive, &[1]);
    assert_eq!(m.loops(), LoopDetectionMode::Interactive);
    cast(&mut m, blessing);
    let shortcut = drive(&mut m, &[0], 400);
    assert!(m.is_over(), "the loop wins: {:?}", m.state.waiting_for);
    assert_eq!(m.winner(), Some(0));
    // Taken to its end as soon as it's found (CR 732.2a), not played out to 0 life.
    assert!(life(&m, 1) > 0, "Ben still had {} life when the loop was taken to its end", life(&m, 1));
    assert_eq!(m.view(Some(0)).winner, Some(0));

    // With loop detection off the drain plays out, trigger by trigger, until Ben has no life.
    let (mut m, blessing) = bond_and_blood(LoopDetectionMode::Off, &[1]);
    cast(&mut m, blessing);
    let played_out = drive(&mut m, &[0], 2_000);
    assert_eq!((m.is_over(), m.winner()), (true, Some(0)));
    assert!(life(&m, 1) <= 0);
    assert!(shortcut < played_out, "the shortcut took {shortcut} actions, playing it out {played_out}");
}

/// Ana's drain with creatures (Marauding Blight-Priest, Bloodthirsty Conqueror), and Ben holding
/// Lightning Bolt with a Mountain: he could kill the Priest and break the loop, so it's optional.
fn optional_drain(ai: &[u8]) -> (Match, Vec<ObjectId>) {
    table(
        LoopDetectionMode::Interactive,
        ai,
        &[
            ("Marauding Blight-Priest", At::Field(0)),
            ("Bloodthirsty Conqueror", At::Field(0)),
            ("Plains", At::Field(0)),
            ("Chaplain's Blessing", At::Hand(0)),
            ("Mountain", At::Field(1)),
            ("Lightning Bolt", At::Hand(1)),
        ],
    )
}

/// Ana proposes the shortcut she's offered once the loop is found during her priority, with the
/// first count the engine offers ("until a player loses", or a number of times).
fn propose(m: &mut Match) {
    assert!(matches!(m.state.waiting_for, WaitingFor::LoopShortcut { proposer: PlayerId(0), .. }), "Ana is offered the shortcut: {:?}", m.state.waiting_for);
    let p = m.decision(0).unwrap().pending.expect("the offer is a pending decision");
    assert_eq!(p.purpose, "shortcut");
    let first = p.options.first().expect("a count to propose");
    let count = if first.id == "lethal" { None } else { Some(first.id.parse().expect("a number of times")) };
    act_as(m, 0, Act::ProposeShortcut { count });
}

#[test]
fn an_optional_loop_is_offered_and_the_other_player_accepts() {
    let (mut m, ids) = optional_drain(&[]);
    cast(&mut m, ids[3]);
    // Ben could answer each trigger with his Bolt, so the smart stops ask him: he lets them go.
    for _ in 0..200 {
        drive(&mut m, &[0, 1], 400);
        if !matches!(m.state.waiting_for, WaitingFor::Priority { player: PlayerId(1) }) {
            break;
        }
        let d = m.decision(1).unwrap();
        let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
        m.choose(1, d.revision, pass.index).unwrap();
    }
    propose(&mut m);
    // Ben is asked to accept or shorten it, and everyone sees the proposal being answered.
    let p = m.decision(1).unwrap().pending.expect("Ben answers the proposal");
    assert_eq!(p.purpose, "shortcut_response");
    assert!(matches!(m.view(Some(0)).together, Some(crate::TogetherView::Shortcut { .. })));
    act_as(&mut m, 1, Act::RespondToShortcut { stop_at: None });
    assert!(m.is_over(), "accepted, the shortcut runs to its end: {:?}", m.state.waiting_for);
    assert_eq!(m.winner(), Some(0));
}

#[test]
fn an_ai_answers_a_shortcut_someone_proposes() {
    // Ben is the AI, holding a Bolt that could kill the Priest and break the loop. Left to itself
    // the AI does that before the loop is found, so until Ana proposes, Ben's windows are passed
    // here as a person would pass them; then his AI answers the proposal.
    let (mut m, ids) = optional_drain(&[1]);
    cast(&mut m, ids[3]);
    for _ in 0..200 {
        m.auto_pass(&[0]);
        match m.state.waiting_for {
            WaitingFor::Priority { player: PlayerId(1) } => {
                let d = m.decision(1).unwrap();
                let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
                m.choose(1, d.revision, pass.index).unwrap();
            }
            _ => break,
        }
    }
    propose(&mut m);
    assert!(matches!(m.state.waiting_for, WaitingFor::RespondToShortcut { player: PlayerId(1), .. }));
    assert_eq!(m.run_ai(1).unwrap(), 1, "Ben's AI answers the proposal");
    assert!(!matches!(m.state.waiting_for, WaitingFor::RespondToShortcut { .. }));
    // It shortens (its Bolt could break the loop) or accepts; either way play goes on from there
    // with nothing refused or stuck, and the game reaches an end or Ana's next decision.
    drive(&mut m, &[0], 2_000);
    assert!(m.is_over() || m.waiting_on() == [0], "{:?}", m.state.waiting_for);
}

#[test]
fn an_ai_with_a_loop_proposes_or_declines_it_and_a_person_answers() {
    // Ana is the AI this time, with the loop in her hand; Ben is a person holding a Bolt.
    let (mut m, _) = optional_drain(&[0]);
    let (mut offered, mut answered) = (0, 0);
    for _ in 0..3_000 {
        if m.is_over() || m.turn() > 3 {
            break;
        }
        match m.state.waiting_for.clone() {
            // Ben lets her triggers resolve, and accepts any shortcut she proposes.
            WaitingFor::RespondToShortcut { player: PlayerId(1), .. } => {
                act_as(&mut m, 1, Act::RespondToShortcut { stop_at: None });
                answered += 1;
            }
            WaitingFor::Priority { player: PlayerId(1) } => {
                let d = m.decision(1).unwrap();
                let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
                m.choose(1, d.revision, pass.index).unwrap();
            }
            w if m.waiting_on().contains(&1) => panic!("Ben is asked something unexpected: {w:?}"),
            w => {
                if matches!(w, WaitingFor::LoopShortcut { proposer: PlayerId(0), .. }) {
                    offered += 1;
                }
                assert_eq!(m.run_ai(1).unwrap(), 1, "the AI answers {w:?}");
            }
        }
    }
    // The AI cast its Blessing, the loop was offered to it, and it either proposed (Ben accepted
    // and the game is over) or declined and played on, never stuck on the decision.
    assert!(offered > 0, "the loop was offered to the AI");
    if answered > 0 {
        assert_eq!((m.is_over(), m.winner()), (true, Some(0)));
    }
    assert!(m.is_over() || m.turn() > 3, "{:?}", m.state.waiting_for);
}

#[test]
fn a_mandatory_loop_nobody_wins_is_a_draw() {
    let (mut m, ids) = table(
        LoopDetectionMode::Interactive,
        &[1],
        &[("Endless Wellspring", At::Field(0)), ("Plains", At::Field(0)), ("Chaplain's Blessing", At::Hand(0))],
    );
    cast(&mut m, ids[2]);
    drive(&mut m, &[0], 400);
    assert!(m.is_over(), "{:?}", m.state.waiting_for);
    assert_eq!(m.winner(), None, "a loop of mandatory actions only, in which nobody can win, is a draw (CR 732.4)");
    let v = m.view(Some(1));
    assert!(v.over && v.winner.is_none());
}

#[test]
fn an_ai_answers_a_repeat_decision() {
    let (mut m, ids) = table(LoopDetectionMode::Interactive, &[1], &[("Opt", At::Field(1))]);
    let ability: engine::types::ability::ResolvedAbility = serde_json::from_value(serde_json::json!({
        "effect": { "type": "Draw", "count": { "type": "Fixed", "value": 1 }, "target": { "type": "Controller" } },
        "targets": [], "source_id": ids[0].0, "controller": 1, "kind": "Spell", "description": "Draw a card."
    }))
    .unwrap();
    m.state.waiting_for = WaitingFor::RepeatDecision { player: PlayerId(1), ability: Box::new(ability) };
    assert_eq!(m.run_ai(1).unwrap(), 1, "the AI answers whether to repeat");
    assert!(!matches!(m.state.waiting_for, WaitingFor::RepeatDecision { .. }));
}

#[test]
fn the_loop_setting_is_saved_with_the_game_and_old_games_keep_it_off() {
    let e = engine();
    let deck = || SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Plains".into(); 99], ..Default::default() };
    let on = e.new_match_with(9, vec![deck(), deck()], &[], Setup { first: Some(0), loops: LoopDetectionMode::Interactive }).unwrap();
    let saved = on.replay_json();
    assert!(saved.contains("\"loop_detection\""), "the replay header carries the setting");
    assert_eq!(e.resume(&saved, &[]).unwrap().loops(), LoopDetectionMode::Interactive, "a resumed game keeps its mode");
    // A game made without the setting writes exactly what it did before: no key, and Off on resume.
    let off = e.new_match_first(9, vec![deck(), deck()], &[], Some(0)).unwrap();
    let saved = off.replay_json();
    assert!(!saved.contains("loop_detection"));
    assert_eq!(e.resume(&saved, &[]).unwrap().loops(), LoopDetectionMode::Off);
}

/// Prismari Performance's commander in an online game: Ana's AI casts Brass's Bounty (mana value
/// 7) with Zaffai, Thunder Conductor out. phase v0.113.0 resolves the magecraft trigger's scry,
/// then puts the rest of the ability (the Elemental, the 10 damage to a random opponent) back on
/// the stack as a new object asking for a target; that object, resolving, puts itself back again,
/// for ever, with nothing else happening (no Elemental either). Nothing repeats as a position the
/// engine's loop detection compares (every pass asks for a new target first), so it isn't found
/// as a loop. Yama stops the AI once STALL_ACTION_LIMIT actions in a row have changed nothing on
/// the board, and says so in the log, instead of the game thread running for ever. Once phase is fixed, the game simply
/// goes on, which this test also accepts.
#[test]
fn zaffais_endless_trigger_stops_the_ai_instead_of_running_for_ever() {
    let mut cards: Vec<(&str, At)> = vec![("Zaffai, Thunder Conductor", At::Field(0)), ("Brass's Bounty", At::Hand(0))];
    cards.extend(std::iter::repeat_n(("Mountain", At::Field(0)), 10));
    let (mut m, _) = table(LoopDetectionMode::Interactive, &[0], &cards);
    // The limit is 3,000 actions without the board changing in live games; 300 here, so the test
    // is quick.
    m.set_stall_limit(300);
    // The server's game thread (`ai_turns`): pass for Ben, let the AI act, until a person
    // decides, the game ends or the AI stops.
    let mut stopped = None;
    let mut actions = 0;
    for _ in 0..2_000 {
        let passed = m.auto_pass(&[1]);
        match m.run_ai(40) {
            Ok(n) => {
                actions += passed + n;
                if passed + n == 0 || m.is_over() || m.turn() > 8 {
                    break;
                }
            }
            Err(e) => {
                stopped = Some(format!("{e:#}"));
                break;
            }
        }
    }
    assert!(actions < 600, "{actions} actions: the game thread kept going");
    if let Some(why) = stopped {
        assert!(why.contains("Zaffai, Thunder Conductor"), "{why}");
        let log = m.view(Some(1)).log;
        let note = log.last().expect("a log line says why");
        assert!(note.text.starts_with("The game can't go on") && note.text.contains("Zaffai, Thunder Conductor's ability"), "{}", note.text);
        // Asked again (the next person's move), the AI stops at once rather than spinning.
        assert!(m.run_ai(40).is_err());
        assert_eq!(m.view(Some(1)).log.iter().filter(|l| l.text.starts_with("The game can't go on")).count(), 1, "said once");
    }
}

/// Ana's optional drain as a combo her AI is told about ([`crate::SeatCombo`]).
fn drain_combo() -> crate::SeatCombo {
    crate::SeatCombo { id: "drain".into(), cards: vec!["Marauding Blight-Priest".into(), "Bloodthirsty Conqueror".into(), "Chaplain's Blessing".into()] }
}

#[test]
fn an_ai_told_about_its_combo_plays_the_line_that_wins() {
    // Ana is the AI with the drain on her side and its Blessing in hand; Ben is a person holding a
    // Bolt. Told about the combo, she finds the line on copies of the game (cast the Blessing,
    // then the loop it starts) and plays it: Ben lets it resolve and accepts what she proposes,
    // and she wins on her own turn 3. Left to itself the AI may decline the loop (the test above).
    // On a game thread's stack, as live games run: the search plays the line out in depth.
    crate::card_tests::big_stack(|| {
        let (mut m, _) = optional_drain(&[0]);
        m.set_seat_combos([(0, vec![drain_combo()])].into());
        assert_eq!(m.seat_combos(0), [drain_combo()]);
        let mut answered = 0;
        for _ in 0..3_000 {
            if m.is_over() || m.turn() > 3 {
                break;
            }
            match m.state.waiting_for.clone() {
                WaitingFor::RespondToShortcut { player: PlayerId(1), .. } => {
                    act_as(&mut m, 1, Act::RespondToShortcut { stop_at: None });
                    answered += 1;
                }
                WaitingFor::Priority { player: PlayerId(1) } => {
                    let d = m.decision(1).unwrap();
                    let pass = d.options.iter().find(|o| o.kind == OptionKind::Pass).unwrap();
                    m.choose(1, d.revision, pass.index).unwrap();
                }
                w if m.waiting_on().contains(&1) => panic!("Ben is asked something unexpected: {w:?}"),
                w => assert_eq!(m.run_ai(1).unwrap(), 1, "the AI answers {w:?}"),
            }
        }
        let log = || m.view(Some(0)).log.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join(" | ");
        assert_eq!((m.is_over(), m.winner(), m.turn()), (true, Some(0), 3), "{:?}; {}", m.state.waiting_for, log());
        // She wins by the loop: proposed once and accepted, or run to its end without an offer.
        assert!(answered <= 1, "{answered} proposals; {}", log());
    });
}

#[test]
fn a_combo_line_opens_on_the_game_itself_and_other_decisions_on_the_copy() {
    use std::borrow::Cow;
    let on_the_game = |m: &Match, seat: u8| matches!(crate::ai_search_state(&m.state, &m.session, PlayerId(seat)), Cow::Borrowed(_));
    let (mut m, _) = optional_drain(&[0]);
    assert!(!on_the_game(&m, 0), "with no combo the AI searches a copy with loop detection off");
    // Every card of the combo is hers to use, in her main phase with an empty stack.
    m.set_seat_combos([(0, vec![drain_combo()])].into());
    assert!(on_the_game(&m, 0));
    assert!(!on_the_game(&m, 1), "Ben's seat was given none");
    // A combo with a card she doesn't have (the Bolt is Ben's) opens nothing.
    let hers_and_his = crate::SeatCombo { id: "bolt".into(), cards: vec!["Marauding Blight-Priest".into(), "Lightning Bolt".into()] };
    m.set_seat_combos([(0, vec![hers_and_his])].into());
    assert!(!on_the_game(&m, 0));
    // Nor does her own combo outside her main phase.
    m.set_seat_combos([(0, vec![drain_combo()])].into());
    m.state.phase = Phase::End;
    assert!(!on_the_game(&m, 0));
}

#[test]
fn seat_combos_are_saved_with_the_game_and_a_game_without_any_writes_none() {
    let e = engine();
    let deck = || SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Plains".into(); 99], ..Default::default() };
    let setup = Setup { first: Some(0), loops: LoopDetectionMode::Interactive };
    let mut with = e.new_match_with(9, vec![deck(), deck()], &[(1, Difficulty::Easy)], setup).unwrap();
    // A seat the game doesn't have and a seat given nothing are dropped.
    with.set_seat_combos([(1, vec![drain_combo()]), (0, vec![]), (7, vec![drain_combo()])].into());
    let saved = with.replay_json();
    let resumed = e.resume(&saved, &[(1, Difficulty::Easy)]).unwrap();
    assert_eq!(resumed.seat_combos(1), [drain_combo()]);
    assert!(resumed.seat_combos(0).is_empty() && resumed.seat_combos(7).is_empty());
    assert_eq!(resumed.session.combos[&PlayerId(1)].len(), 1, "the resumed game's AI has them again");
    assert!(resumed.replay_json().contains("\"yama_combos\":{\"1\":"), "and saves them again");
    // Without any, the saved game is what it always was.
    let without = e.new_match_with(9, vec![deck(), deck()], &[(1, Difficulty::Easy)], setup).unwrap();
    assert!(!without.replay_json().contains("yama_combos"));
    // A saved game naming a seat it doesn't have is refused, not guessed at.
    let bad = saved.replace("\"yama_combos\":{\"1\":", "\"yama_combos\":{\"5\":");
    assert_ne!(bad, saved);
    assert!(e.resume(&bad, &[(1, Difficulty::Easy)]).is_err());
}

#[test]
fn a_decks_combos_are_named_as_the_engine_names_its_cards() {
    use crate::{DeckLine, ListedCombo};
    let e = engine();
    let line = |name: &'static str, qty: u32| DeckLine { oracle_id: "", name, qty, commander: false };
    let lines = [line("sanguine bond", 1), line("Exquisite Blood", 1), line("Plains", 30), line("Opt", 0), line("No Such Card", 1)];
    let cards = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<String>>();
    let (both, missing, unknown, none, cut) =
        (cards(&["Sanguine Bond", "EXQUISITE BLOOD"]), cards(&["Sanguine Bond", "Lightning Bolt"]), cards(&["No Such Card"]), cards(&[]), cards(&["Opt"]));
    let listed = [
        ListedCombo { id: "a", cards: &both },
        // Not on the list, not known to the engine, no cards, a card listed zero times, a repeat.
        ListedCombo { id: "b", cards: &missing },
        ListedCombo { id: "c", cards: &unknown },
        ListedCombo { id: "d", cards: &none },
        ListedCombo { id: "e", cards: &cut },
        ListedCombo { id: "a", cards: &both },
    ];
    let found = e.resolve_combos(&lines, &listed);
    assert_eq!(found, [crate::SeatCombo { id: "a".into(), cards: cards(&["Sanguine Bond", "Exquisite Blood"]) }]);
    // No more than the cap, the first listed kept.
    let ids: Vec<String> = (0..crate::MAX_SEAT_COMBOS + 5).map(|i| i.to_string()).collect();
    let many: Vec<ListedCombo> = ids.iter().map(|id| ListedCombo { id, cards: &both }).collect();
    let kept = e.resolve_combos(&lines, &many);
    assert_eq!((kept.len(), kept[0].id.as_str()), (crate::MAX_SEAT_COMBOS, "0"));
}
