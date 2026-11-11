//! Per-card tests (docs/card-coverage.md): a harness that sets up a board, plays a card through
//! Yama's own answers, resolves it and checks the outcome. The cards come from
//! tests/fixtures/deck-cards.json, the slice of phase's card data with every card in Bryan's decks
//! and candidates, written by play/src/bin/coverage.rs.
//!
//! - [`Board`] sets the table: who sits where, each seat's commander, and each card in a hand, on
//!   a battlefield, in a graveyard or on top of a library. Cards are dealt into the decks and moved
//!   from there, so two-faced and adventurer cards are whole.
//! - [`Table`] plays it: cast, activate or play a land as the board does (`Match::act` and the
//!   option buttons), answer decisions, pass until the stack is empty, and read the outcome
//!   (zones, life, counters, tokens, power and toughness, the feed's happenings).
//! - [`Table::drive`] answers every decision on its own, as a person would through the board,
//!   for the smoke tests: a decision with a [`Pending`] is answered with `act`, the rest with the
//!   option buttons. It reports an engine refusal, an `act` refusal of an answer the engine
//!   offered, a decision nobody can answer, and a game that doesn't settle.
//!
//! The tests: smoke.rs (one per card in Bryan's decks, list in smoke_cards.rs), commanders.rs
//! (the eight commanders), key_cards.rs (the cards the decks are built around) and partial.rs
//! (the cards phase only partly implements, and those it parses with warnings).

mod commanders;
mod feedback;
mod key_cards;
mod partial;
pub(crate) mod plain;
mod smoke;

use std::collections::HashMap;
use std::sync::OnceLock;

use engine::ai_support::{AiDecisionContract, legal_actions_for_viewer};
use engine::game::layers::evaluate_layers;
use engine::types::ability::TargetRef;
use engine::types::actions::GameAction;
use engine::types::card_type::CoreType;
use engine::types::counter::CounterType;
use engine::types::game_state::{GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

use crate::act::Answer;
use crate::feed::What;
use crate::pay::PayMode;
use crate::{Act, ChoiceError, Decision, Engine, Match, OptionKind, Pending, SeatDeck, TargetView};

/// The card fixture, loaded once for every test in the module.
pub(crate) fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/deck-cards.json")).unwrap())
}

/// Run `f` on a thread with a large stack: the engine recurses deeply on some cards (phase runs
/// its games on 32 MiB threads too). A panic inside comes back as the test's panic.
pub(crate) fn big_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let h = std::thread::Builder::new().stack_size(32 << 20).spawn(f).unwrap();
    match h.join() {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e),
    }
}

/// Where a card starts on a [`Board`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum At {
    Hand,
    Field,
    Grave,
    /// On top of its owner's library, the first given on top.
    Top,
}

/// A table to set: the seats, their commanders, and where each card starts. Seat 0 is
/// the active player by default, at its turn 3 precombat main phase with priority.
pub(crate) struct Board {
    commanders: Vec<String>,
    cards: Vec<(String, u8, At)>,
    active: u8,
    /// The step the active seat has priority in.
    phase: Phase,
    /// The rest of every library: the deal fills each deck to 100 with these, in turn.
    filler: Vec<String>,
}

/// Every seat's commander unless a test says otherwise: a vanilla legend no test plays.
pub(crate) const DEFAULT_COMMANDER: &str = "Jedit Ojanen";

/// Seat names for option labels.
const NAMES: [&str; 4] = ["Ana", "Ben", "Cy", "Di"];

impl Board {
    /// `players` seats (2 to 4), each with Jedit Ojanen (a vanilla legend) as commander and 40
    /// life.
    pub fn new(players: usize) -> Self {
        assert!((2..=4).contains(&players));
        Board {
            commanders: vec![DEFAULT_COMMANDER.into(); players],
            cards: vec![],
            active: 0,
            phase: Phase::PreCombatMain,
            filler: ["Plains", "Island", "Swamp", "Mountain", "Forest", "Grizzly Bears"].iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn commander(mut self, seat: u8, name: &str) -> Self {
        self.commanders[usize::from(seat)] = name.into();
        self
    }

    pub fn at(mut self, seat: u8, at: At, name: &str) -> Self {
        self.cards.push((name.into(), seat, at));
        self
    }

    pub fn hand(self, seat: u8, name: &str) -> Self {
        self.at(seat, At::Hand, name)
    }

    pub fn field(self, seat: u8, name: &str) -> Self {
        self.at(seat, At::Field, name)
    }

    pub fn grave(self, seat: u8, name: &str) -> Self {
        self.at(seat, At::Grave, name)
    }

    pub fn top(self, seat: u8, name: &str) -> Self {
        self.at(seat, At::Top, name)
    }

    /// `n` copies of a land (or any card) on `seat`'s battlefield.
    pub fn lands(mut self, seat: u8, name: &str, n: usize) -> Self {
        for _ in 0..n {
            self = self.field(seat, name);
        }
        self
    }

    /// `n` of each basic land on `seat`'s battlefield: mana of every colour.
    pub fn basics(mut self, seat: u8, n: usize) -> Self {
        for land in ["Plains", "Island", "Swamp", "Mountain", "Forest"] {
            self = self.lands(seat, land, n);
        }
        self
    }

    /// Whose turn it is (they get priority in their precombat main phase).
    pub fn active(mut self, seat: u8) -> Self {
        self.active = seat;
        self
    }

    /// Start in another step of the active seat's turn (the upkeep, to see "beginning of your
    /// first main phase" triggers).
    pub fn phase(mut self, phase: Phase) -> Self {
        self.phase = phase;
        self
    }

    /// Deal the decks, start the game, then put every card where it's asked for (untapped, none
    /// summoning sick, hands holding only the cards given) and give the active seat priority in
    /// its turn 3 main phase (or the step [`Board::phase`] says). Libraries hold the rest of the deal in the order it fell.
    pub fn build(self) -> Table {
        let players = self.commanders.len();
        let deck = |seat: usize| {
            let mut main: Vec<String> = self.cards.iter().filter(|(_, s, _)| usize::from(*s) == seat).map(|(n, _, _)| n.clone()).collect();
            let mut i = 0;
            while main.len() < 99 {
                main.push(self.filler[i % self.filler.len()].clone());
                i += 1;
            }
            SeatDeck { companion: vec![], commander: vec![self.commanders[seat].clone()], main }
        };
        let mut m = engine().new_match_first(7, (0..players).map(deck).collect(), &[], Some(0)).unwrap();
        m.set_names(NAMES.iter().take(players).map(|n| n.to_string()).collect());
        // Empty every opening hand back into its library: hands hold only what the test asks for.
        for p in m.state.players.iter_mut() {
            let hand: Vec<ObjectId> = p.hand.iter().copied().collect();
            p.hand.clear();
            for id in hand {
                p.library.push_back(id);
            }
        }
        for p in m.state.players.clone().iter() {
            for id in &p.library {
                m.state.objects.get_mut(id).unwrap().zone = Zone::Library;
            }
        }
        let mut ids = vec![];
        let mut tops: Vec<(usize, ObjectId)> = vec![];
        for (name, seat, at) in &self.cards {
            let seat = usize::from(*seat);
            let id = m.state.players[seat]
                .library
                .iter()
                .copied()
                .find(|id| m.state.objects[id].name == *name && !ids.contains(id))
                .unwrap_or_else(|| panic!("{name} isn't in seat {seat}'s deck (is it in the fixture?)"));
            let p = &mut m.state.players[seat];
            p.library.retain(|c| *c != id);
            let zone = match at {
                At::Field => {
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
                    tops.push((seat, id));
                    Zone::Library
                }
            };
            let o = m.state.objects.get_mut(&id).unwrap();
            o.zone = zone;
            o.summoning_sick = false;
            o.tapped = false;
            o.controller = PlayerId(seat as u8);
            // CR 306.5b: a planeswalker is on the battlefield with its printed loyalty in counters.
            if zone == Zone::Battlefield {
                if let Some(n) = o.loyalty.filter(|n| *n > 0) {
                    o.counters.insert(CounterType::Loyalty, n);
                }
            }
            ids.push(id);
        }
        for (seat, id) in tops.into_iter().rev() {
            m.state.players[seat].library.push_front(id);
        }
        evaluate_layers(&mut m.state);
        let active = PlayerId(self.active);
        m.state.lands_played_this_turn = 0;
        for p in m.state.players.iter_mut() {
            p.lands_played_this_turn = 0;
        }
        m.state.turn_number = 3;
        m.state.active_player = active;
        m.state.priority_player = active;
        m.state.phase = self.phase;
        m.state.waiting_for = WaitingFor::Priority { player: active };
        m.remark(None);
        Table { m, ids, tester: 0, mays: HashMap::new() }
    }
}

/// A game in progress on a [`Board`].
pub(crate) struct Table {
    pub m: Match,
    /// The board's cards, in the order they were given.
    pub ids: Vec<ObjectId>,
    /// The seat whose card is being tried: [`Table::drive`] answers its own "may" with yes and
    /// pays its own "unless" costs, and answers the other seats' the other way.
    pub tester: u8,
    /// How often [`Table::drive`] has said yes to each card's "may": after three, it says no, as
    /// a person would to a may that keeps coming back.
    mays: HashMap<ObjectId, u32>,
}

/// What [`Table::drive`] did: how many answers it gave, and what it couldn't do.
#[derive(Debug, Default)]
pub(crate) struct Drove {
    pub steps: usize,
    /// Answers the engine offered that `act` refused (a gap in Yama's `Pending`); the option
    /// button gave them instead.
    pub act_refused: Vec<String>,
}

impl Table {
    // ── reading the board ────────────────────────────────────────────────────────────────────

    pub fn state(&self) -> &GameState {
        &self.m.state
    }

    /// The board's first card called `name`.
    pub fn id(&self, name: &str) -> ObjectId {
        self.ids.iter().copied().find(|id| self.m.state.objects[id].name == name).unwrap_or_else(|| panic!("{name} isn't on the board"))
    }

    pub fn zone(&self, id: ObjectId) -> Zone {
        self.m.state.objects.get(&id).map(|o| o.zone).unwrap_or(Zone::Exile)
    }

    pub fn on_field(&self, id: ObjectId) -> bool {
        self.m.state.battlefield.contains(&id)
    }

    pub fn life(&self, seat: u8) -> i32 {
        self.m.state.players[usize::from(seat)].life
    }

    /// Power and toughness as the game sees them now.
    pub fn pt(&self, id: ObjectId) -> (i32, i32) {
        let o = &self.m.state.objects[&id];
        (o.power.unwrap_or(0), o.toughness.unwrap_or(0))
    }

    pub fn counters(&self, id: ObjectId, t: CounterType) -> u32 {
        self.m.state.objects[&id].counters.get(&t).copied().unwrap_or(0)
    }

    pub fn tapped(&self, id: ObjectId) -> bool {
        self.m.state.objects[&id].tapped
    }

    pub fn controller(&self, id: ObjectId) -> u8 {
        self.m.state.objects[&id].controller.0
    }

    /// Tokens `seat` controls.
    pub fn tokens(&self, seat: u8) -> Vec<ObjectId> {
        self.m.state.battlefield.iter().copied().filter(|id| self.m.state.objects[id].is_token && self.m.state.objects[id].controller.0 == seat).collect()
    }

    pub fn hand(&self, seat: u8) -> Vec<String> {
        self.m.state.players[usize::from(seat)].hand.iter().map(|id| self.m.state.objects[id].name.clone()).collect()
    }

    pub fn graveyard(&self, seat: u8) -> Vec<String> {
        self.m.state.players[usize::from(seat)].graveyard.iter().map(|id| self.m.state.objects[id].name.clone()).collect()
    }

    pub fn library_len(&self, seat: u8) -> usize {
        self.m.state.players[usize::from(seat)].library.len()
    }

    pub fn drawn(&self, seat: u8) -> u32 {
        self.m.state.players[usize::from(seat)].cards_drawn_this_turn
    }

    /// Mana in `seat`'s pool.
    pub fn pool(&self, seat: u8) -> usize {
        self.m.state.players[usize::from(seat)].mana_pool.total()
    }

    pub fn has(&self, id: ObjectId, k: Keyword) -> bool {
        self.m.state.objects[&id].keywords.contains(&k)
    }

    pub fn subtypes(&self, id: ObjectId) -> Vec<String> {
        self.m.state.objects[&id].card_types.subtypes.clone()
    }

    pub fn is_creature(&self, id: ObjectId) -> bool {
        self.m.state.objects[&id].card_types.core_types.contains(&CoreType::Creature)
    }

    /// What everyone could see happen (the feed a spectator gets), oldest first.
    pub fn happened(&self) -> Vec<What> {
        self.m.events(None).into_iter().map(|h| h.what).collect()
    }

    // ── setting the board mid-test ───────────────────────────────────────────────────────────

    /// Untap everything `seat` controls and let its creatures attack and tap: a later turn,
    /// without playing one.
    pub fn refresh(&mut self, seat: u8) {
        let ids: Vec<ObjectId> = self.m.state.battlefield.iter().copied().filter(|id| self.m.state.objects[id].controller.0 == seat).collect();
        for id in ids {
            let o = self.m.state.objects.get_mut(&id).unwrap();
            o.tapped = false;
            o.summoning_sick = false;
        }
    }

    /// Put `n` loyalty counters on a planeswalker (CR 306.5b: its loyalty is their number).
    pub fn set_loyalty(&mut self, id: ObjectId, n: u32) {
        let o = self.m.state.objects.get_mut(&id).unwrap();
        o.counters.insert(CounterType::Loyalty, n);
        o.loyalty = Some(n);
        evaluate_layers(&mut self.m.state);
    }

    // ── deciding ─────────────────────────────────────────────────────────────────────────────

    pub fn decision(&self, seat: u8) -> Decision {
        self.m.decision(seat).unwrap_or_else(|| panic!("seat {seat} doesn't decide; {:?} do ({:?})", self.m.waiting_on(), self.m.state.waiting_for))
    }

    /// Send `a` for `seat`, as the board does.
    pub fn try_act(&mut self, seat: u8, a: &Act) -> Result<(), ChoiceError> {
        let d = self.decision(seat);
        self.m.act(seat, d.revision, a)
    }

    pub fn act(&mut self, seat: u8, a: Act) {
        self.try_act(seat, &a).unwrap_or_else(|e| panic!("{a:?} refused: {e}"));
    }

    /// Press `seat`'s first option button that `pick` likes.
    pub fn choose(&mut self, seat: u8, pick: impl Fn(&crate::OptionView) -> bool) {
        let d = self.decision(seat);
        let o = d.options.iter().find(|o| pick(o)).unwrap_or_else(|| panic!("no such option for seat {seat}: {:?}", d.options.iter().map(|o| &o.label).collect::<Vec<_>>()));
        self.m.choose(seat, d.revision, o.index).unwrap_or_else(|e| panic!("{} refused: {e}", o.label));
    }

    /// Cast a card from its owner's hand (or wherever the engine offers it), paying
    /// automatically.
    pub fn cast(&mut self, id: ObjectId) {
        let seat = self.m.state.objects[&id].owner.0;
        self.act(seat, Act::CastSpell { object: id.0, payment: PayMode::Auto });
    }

    /// Activate one of a card's abilities: `ability` is its place among the card's abilities,
    /// or `None` for its first one offered.
    pub fn activate(&mut self, id: ObjectId, ability: Option<usize>) {
        let seat = self.m.state.objects[&id].controller.0;
        self.choose(seat, |o| o.kind == OptionKind::Ability && o.object == Some(id.0) && (ability.is_none() || o.ability == ability));
    }

    pub fn play_land(&mut self, id: ObjectId) {
        let seat = self.m.state.objects[&id].owner.0;
        self.choose(seat, |o| o.kind == OptionKind::Land && o.object == Some(id.0));
    }

    /// Every seat passes until `done` holds (at most 60 passes).
    pub fn pass_until(&mut self, done: impl Fn(&Table) -> bool) {
        for _ in 0..60 {
            if done(self) {
                return;
            }
            let seat = *self.m.waiting_on().first().expect("someone decides");
            self.choose(seat, |o| o.kind == OptionKind::Pass);
        }
        panic!("never got there: {:?}", self.m.state.waiting_for);
    }

    /// Activate the ability of `id` whose option label passes `label`.
    pub fn activate_labelled(&mut self, id: ObjectId, label: impl Fn(&str) -> bool) {
        let seat = self.controller(id);
        self.choose(seat, |o| o.kind == OptionKind::Ability && o.object == Some(id.0) && label(&o.label));
    }

    /// [`Table::drive`], answering the tester's target choices with the first of `wanted` each
    /// offers.
    pub fn drive_aiming(&mut self, wanted: &[ObjectId]) {
        let tester = self.tester;
        self.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != tester || p.answer != Answer::ChooseTarget {
                return None;
            }
            let id = wanted.iter().find(|id| p.options.iter().any(|o| o.id == id.0.to_string()))?;
            Some(Act::ChooseTarget { target: Some(TargetView::Object { id: id.0 }) })
        })
        .unwrap();
    }

    /// The active seat has priority with nothing on the stack.
    pub fn settled(&self) -> bool {
        self.m.state.stack.is_empty() && matches!(self.m.state.waiting_for, WaitingFor::Priority { player } if player == self.m.state.active_player)
    }

    // ── answering on its own ─────────────────────────────────────────────────────────────────

    /// Answer every decision until the active seat has priority with an empty stack (or the
    /// game ends), the way a person would through the board: with `act` where the decision has
    /// a [`Pending`] and `act` covers the answer, and with the option buttons otherwise. The
    /// answer is the engine's own option, picked by [`pick`]. `Err` says what went wrong.
    pub fn drive(&mut self) -> Result<Drove, String> {
        self.drive_watching(|_| {})
    }

    /// [`Table::drive`], calling `watch` before the first answer and after each one (to see a
    /// permanent that enters and then leaves on its own trigger, say).
    pub fn drive_watching(&mut self, mut watch: impl FnMut(&Table)) -> Result<Drove, String> {
        let mut drove = Drove::default();
        for _ in 0..400 {
            watch(self);
            if self.m.is_over() || self.settled() {
                return Ok(drove);
            }
            self.answer_once(&mut drove)?;
        }
        Err(format!("didn't settle in 400 answers; now {:?} with {} on the stack", self.m.state.waiting_for, self.m.state.stack.len()))
    }

    /// [`Table::drive`], but `answer` may give the answer to any decision itself (an `act`); where
    /// it gives none, the drive's own choice is sent.
    pub fn drive_answering(&mut self, mut answer: impl FnMut(&Table, u8, &Decision) -> Option<Act>) -> Result<Drove, String> {
        let mut drove = Drove::default();
        for _ in 0..400 {
            if self.m.is_over() || self.settled() {
                return Ok(drove);
            }
            let seat = *self.m.waiting_on().first().ok_or("nobody decides")?;
            let d = self.decision(seat);
            if let Some(a) = answer(self, seat, &d) {
                self.m.act(seat, d.revision, &a).map_err(|e| format!("{a:?} refused: {e}"))?;
                drove.steps += 1;
                continue;
            }
            self.answer_once(&mut drove)?;
        }
        Err(format!("didn't settle in 400 answers; now {:?}", self.m.state.waiting_for))
    }

    /// Answer the current decision once, as [`Table::drive`] does. Attacks and blocks are
    /// declared empty.
    fn answer_once(&mut self, drove: &mut Drove) -> Result<(), String> {
        let Some(&seat) = self.m.waiting_on().first() else {
            return Err(format!("nobody decides: {:?}", self.m.state.waiting_for));
        };
        let d = self.decision(seat);
        match self.m.state.waiting_for {
            WaitingFor::DeclareAttackers { .. } => {
                return self.m.declare_attackers(seat, d.revision, &[]).map_err(|e| format!("no attack refused: {e}"));
            }
            WaitingFor::DeclareBlockers { .. } => {
                return self.m.declare_blockers(seat, d.revision, &[]).map_err(|e| format!("no blocks refused: {e}"));
            }
            _ => {}
        }
        let contract = AiDecisionContract::issue(&self.m.state, PlayerId(seat));
        let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
        if candidates.is_empty() {
            return Err(format!("stuck: seat {seat} has no option for {} ({:?})", d.prompt, self.m.state.waiting_for));
        }
        drove.steps += 1;
        let mut index = pick(&self.m.state, seat, self.tester, &candidates);
        if let (GameAction::DecideOptionalEffect { accept: true }, WaitingFor::OptionalEffectChoice { source_id, .. }) = (&candidates[index], &self.m.state.waiting_for) {
            let n = self.mays.entry(*source_id).or_default();
            *n += 1;
            if *n > 3 {
                index = candidates.iter().position(|a| matches!(a, GameAction::DecideOptionalEffect { accept: false })).unwrap_or(index);
            }
        }
        let paying = crate::pay::paying(&self.m.state.waiting_for, PlayerId(seat));
        // The board sends `act` for a decision with a Pending, and for casts and the special
        // actions; it presses the option button for the rest (soak.rs routes the same way).
        let as_act = |action: &GameAction| {
            let a = if paying { Act::from_payment_action(action) } else { Act::from_action(action) }?;
            let covered = match a {
                Act::CancelCast | Act::CastSpell { .. } | Act::Ninjutsu { .. } | Act::TurnFaceUp { .. } | Act::Foretell { .. } | Act::CompanionToHand | Act::UseSerumPowder { .. } => true,
                Act::TapMana { .. } | Act::UntapMana { .. } | Act::KeepMana => paying,
                _ => d.pending.is_some(),
            };
            covered.then_some(a)
        };
        if let Some(a) = as_act(&candidates[index]) {
            let refused = match self.m.act(seat, d.revision, &a) {
                Ok(()) => return Ok(()),
                Err(e) => format!("seat {seat} {a:?} for {}: {e}", d.prompt),
            };
            // `act` can't spell this one of the engine's answers; a person would pick another
            // the decision shows. Only a decision none of whose answers `act` takes is a gap.
            for (i, other) in candidates.iter().enumerate() {
                if i == index || matches!(other, GameAction::CancelCast) {
                    continue;
                }
                if let Some(a) = as_act(other) {
                    if self.m.act(seat, d.revision, &a).is_ok() {
                        return Ok(());
                    }
                }
            }
            drove.act_refused.push(refused);
        }
        let action = &candidates[index];
        let d = self.decision(seat);
        self.m.choose(seat, d.revision, index).map_err(|e| format!("the engine refused its own option {action:?} for {}: {e}", d.prompt))
    }

    /// Play on to the next time `phase` begins (passing an empty stack moves the game on),
    /// answering everything as [`Table::drive`] does, with no attacks and no blocks. Stops with
    /// the triggers of that step on the stack, before anyone has passed.
    pub fn advance_to(&mut self, phase: Phase) {
        self.advance_answering(phase, |_, _, _| None);
    }

    /// [`Table::advance_to`], with `answer` giving any answer it likes (as in
    /// [`Table::drive_answering`]).
    pub fn advance_answering(&mut self, phase: Phase, mut answer: impl FnMut(&Table, u8, &Decision) -> Option<Act>) {
        let mut drove = Drove::default();
        let mut left = self.m.state.phase != phase;
        for _ in 0..400 {
            if self.m.state.phase != phase {
                left = true;
            } else if left {
                return;
            }
            if let WaitingFor::Priority { player } = self.m.state.waiting_for {
                if self.m.state.stack.is_empty() {
                    self.choose(player.0, |o| o.kind == OptionKind::Pass);
                    continue;
                }
            }
            let seat = *self.m.waiting_on().first().expect("someone decides");
            let d = self.decision(seat);
            if let Some(a) = answer(self, seat, &d) {
                self.m.act(seat, d.revision, &a).unwrap_or_else(|e| panic!("{a:?} refused: {e}"));
                continue;
            }
            self.answer_once(&mut drove).unwrap_or_else(|e| panic!("advancing to {phase:?}: {e}"));
        }
        panic!("didn't reach {phase:?}");
    }

    /// From the beginning of combat (or before), declare `attacks` for the active seat:
    /// (attacker, the seat it attacks).
    pub fn attack(&mut self, attacks: &[(ObjectId, u8)]) {
        for _ in 0..200 {
            if let WaitingFor::DeclareAttackers { player, .. } = self.m.state.waiting_for {
                let d = self.decision(player.0);
                let list: Vec<(u64, crate::AttackAt)> = attacks.iter().map(|(id, seat)| (id.0, crate::AttackAt::Player { seat: *seat })).collect();
                self.m.declare_attackers(player.0, d.revision, &list).unwrap_or_else(|e| panic!("attack refused: {e}"));
                return;
            }
            let seat = *self.m.waiting_on().first().expect("someone decides");
            if matches!(self.m.state.waiting_for, WaitingFor::Priority { .. }) && self.m.state.stack.is_empty() {
                self.choose(seat, |o| o.kind == OptionKind::Pass);
                continue;
            }
            let mut drove = Drove::default();
            self.answer_once(&mut drove).unwrap_or_else(|e| panic!("on the way to attack: {e}"));
        }
        panic!("never got to declare attackers");
    }

    // ── mana abilities ───────────────────────────────────────────────────────────────────────

    /// The mana abilities the engine offers for `id` to its controller right now (they aren't
    /// option buttons: the board taps them while paying).
    pub fn mana_actions(&self, id: ObjectId) -> Vec<GameAction> {
        let seat = self.m.state.objects[&id].controller;
        // The per-object list has every action for the card; the flat list leaves out mana
        // abilities (a land's tap, or an ActivateAbility for anything else).
        let (all, _, by_object) = legal_actions_for_viewer(&self.m.state, seat);
        by_object.get(&id).map(|v| v.iter().filter(|a| !all.contains(a)).cloned().collect()).unwrap_or_default()
    }

    /// Use a mana ability straight through the engine (CR 605.3a: any time its controller has
    /// priority). Returns how much the pool grew.
    pub fn tap_for_mana(&mut self, action: GameAction) -> Result<usize, String> {
        let seat = self.m.state.waiting_for.acting_players().first().copied().unwrap_or(PlayerId(0));
        let before = self.m.state.players[usize::from(seat.0)].mana_pool.total();
        engine::game::engine::apply(&mut self.m.state, seat, action).map_err(|e| e.to_string())?;
        // A colour choice or a cost of its own: answer it the plain way.
        for _ in 0..10 {
            if matches!(self.m.state.waiting_for, WaitingFor::Priority { .. }) {
                break;
            }
            let contract = AiDecisionContract::issue(&self.m.state, seat);
            let Some(c) = contract.candidates.iter().find(|c| !matches!(c.action, GameAction::CancelCast)) else { break };
            engine::game::engine::apply(&mut self.m.state, seat, c.action.clone()).map_err(|e| e.to_string())?;
        }
        Ok(self.m.state.players[usize::from(seat.0)].mana_pool.total().saturating_sub(before))
    }
}

/// The option [`Table::drive`] answers with: the engine's own candidate a person would most
/// plainly pick. Never cancel; pass priority (the drive stops before an empty stack would pass
/// the turn on); the `tester` says yes to its own "may" effects and pays its own "unless" costs,
/// and everyone else says no to both; no optional extra costs; aim at another seat's things
/// before your own; a card's main face; the smallest X above zero; otherwise the engine's first.
pub(crate) fn pick(state: &GameState, seat: u8, tester: u8, candidates: &[GameAction]) -> usize {
    let me = PlayerId(seat);
    let testing = seat == tester;
    let theirs = |t: &TargetRef| match t {
        TargetRef::Player(p) => *p != me,
        TargetRef::Object(id) => state.objects.get(id).is_some_and(|o| o.controller != me),
    };
    let score = |a: &GameAction| -> i32 {
        match a {
            GameAction::CancelCast => -100,
            GameAction::PassPriority => 50,
            GameAction::DecideOptionalEffect { accept } => i32::from(*accept == testing) * 10,
            GameAction::PayUnlessCost { pay } => i32::from(*pay == testing) * 10,
            GameAction::DecideOptionalCost { pay } => i32::from(!*pay) * 10,
            GameAction::ChooseTarget { target: Some(t) } => i32::from(theirs(t)) * 10,
            GameAction::SelectTargets { targets } if !targets.is_empty() => i32::from(targets.iter().all(theirs)) * 10,
            // A card's main face: the creature, not its adventure; the front of a modal card.
            GameAction::ChooseAdventureFace { creature } => i32::from(*creature) * 10,
            GameAction::ChooseModalFace { back_face } => i32::from(!*back_face) * 10,
            GameAction::ChooseX { value } => {
                if *value == 0 {
                    0
                } else {
                    10 - (*value as i32).min(9)
                }
            }
            _ => 0,
        }
    };
    let mut best = 0;
    for (i, a) in candidates.iter().enumerate() {
        if score(a) > score(&candidates[best]) {
            best = i;
        }
    }
    best
}

/// The answer to `p` that picks its option named with `needle` (a mode, a branch, a word, a card
/// or a target), in the shape the decision takes. `None` if no option's name has it.
pub(crate) fn choose_named(p: &Pending, needle: &str) -> Option<Act> {
    let (i, o) = p.options.iter().enumerate().find(|(_, o)| o.name.to_lowercase().contains(&needle.to_lowercase()))?;
    let object = || o.id.parse::<u64>().ok();
    Some(match p.answer {
        Answer::SelectModes => Act::SelectModes { indices: vec![o.id.parse().unwrap_or(i)] },
        Answer::ChooseBranch => Act::ChooseBranch { index: o.id.parse().unwrap_or(i) },
        Answer::ChooseReplacement => Act::ChooseReplacement { index: o.id.parse().unwrap_or(i) },
        Answer::ChooseOption => Act::ChooseOption { choice: o.id.clone() },
        Answer::SelectCards => Act::SelectCards { cards: vec![object()?] },
        Answer::ChooseTarget => Act::ChooseTarget {
            target: Some(match o.id.strip_prefix('p') {
                Some(seat) => TargetView::Player { seat: seat.parse().ok()? },
                None => TargetView::Object { id: object()? },
            }),
        },
        _ => return None,
    })
}

/// Ids of the options for `seat` that `keep` likes, by (object, ability).
pub(crate) fn ability_options(d: &Decision, id: ObjectId) -> Vec<usize> {
    let mut seen: HashMap<Option<usize>, ()> = HashMap::new();
    let mut out = vec![];
    for o in &d.options {
        if o.kind == OptionKind::Ability && o.object == Some(id.0) && seen.insert(o.ability, ()).is_none() {
            out.push(o.ability.unwrap_or(usize::MAX));
        }
    }
    out
}
