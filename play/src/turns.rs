//! Turn controls (docs/game-interactions-review-2026-10-23.md, build plan section 6, and the
//! GPriority, GButtons and GSettings boards): where Yama passes priority for a person, the ways
//! to pass, holding priority, Resolve all, and what a seat's view says about its own settings
//! (trigger yields and the answers the engine remembers).
//!
//! **One pass layer, Yama's own (decided 2026-10-23).** phase can pass for a player itself
//! (`SetAutoPass` sessions, run inside `apply`), but this module stays the only layer that
//! decides when a person is asked:
//! - Commander needs Yama's smart stops anyway: phase's own recommendation holds at nearly every
//!   window where a spell could be cast (PP-07), and its sessions stop only at phase stops,
//!   which know nothing of Yama's defaults (your main phases, an opponent's end step when you
//!   could cast something).
//! - "Pass the rest of this turn" has no engine session at all, and an engine turn session also
//!   declares no attackers for you; two layers would have to be kept in agreement.
//! - Every pass Yama makes is an ordinary `PassPriority` in the replay log, so pass modes need
//!   nothing new to replay.
//!
//! What the engine's own stack sessions read is kept in the engine, as logged preference
//! actions: full control and "Hold priority" set `SetPriorityPassingMode` (so a stack session
//! that an AI's pass started never passes a held window), and trigger yields are the engine's
//! `SetPriorityYield`, which this layer reads with `is_priority_yielded`.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};

use engine::types::actions::ReplacementAutoChoice;
use engine::types::game_state::{
    AutoMayChoice, GameState, MayTriggerAutoChoiceKey, MayTriggerAutoChoiceSelector, ReplacementAutoChoiceIdentity, StackEntryKind,
    WaitingFor, YieldTarget,
};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use serde::{Deserialize, Serialize};

use crate::act::{Act, AnswerChange, YieldChange};
use crate::{Match, Stops};

/// A way to pass more than once (GPriority's menu). Each ends by itself; Stop ends it sooner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassMode {
    /// Enter: pass until someone else's spell or ability could matter to you, or one of your
    /// stops comes, for the rest of this turn.
    Until,
    /// Shift+Enter on someone else's turn: pass the rest of this turn. Only your stops (and
    /// decisions such as blocks, which always wait) interrupt it.
    Turn,
    /// Shift+Enter on your own turn, "End turn": pass the rest of your turn, past your own
    /// stops. Someone else's spell still stops you.
    End,
    /// P: pass to your next turn. Someone else's spell still stops you.
    Mine,
}

impl PassMode {
    /// Someone else's spell or ability you could answer interrupts it.
    fn stops_for_spells(self) -> bool {
        !matches!(self, PassMode::Turn)
    }
    /// Your stops interrupt it.
    fn stops_at_steps(self) -> bool {
        matches!(self, PassMode::Until | PassMode::Turn)
    }
}

/// A pass mode in force: which, and the turn it began in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Passing {
    pub mode: PassMode,
    pub turn: u32,
}

impl Passing {
    /// The turn it was for is over (for "Pass to my turn": your next turn has begun).
    pub(crate) fn over(&self, turn: u32, your_turn: bool) -> bool {
        match self.mode {
            PassMode::Mine => your_turn && turn != self.turn,
            _ => turn != self.turn,
        }
    }
}

/// One person's turn controls in a game. Full control and stops are saved per account (the
/// server keeps them); a pass mode and holding priority last only as long as they apply.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Controls {
    /// Stop at every priority, even with nothing to do (F).
    pub full_control: bool,
    /// Their own stops by step; `None` is the usual smart stops.
    pub stops: Option<Stops>,
    pub passing: Option<Passing>,
    /// "Hold priority": stop whenever they get priority while the stack isn't empty, even for
    /// their own spell, until they pass with their own spell on top (or the stack empties).
    pub hold: bool,
    /// "Tap mana for me" (pay.rs), saved per account: the board casts with it.
    pub tap_mana: crate::PayMode,
}

impl Stops {
    /// Whether these stops hold at `phase` (phase's name), on your turn or someone else's.
    pub fn has(&self, phase: &str, your_turn: bool) -> bool {
        (if your_turn { &self.own } else { &self.others }).contains(phase)
    }
}

/// The top of the stack, as the pass rules see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Top {
    pub yours: bool,
    /// A trigger you yielded to (GSettings, trigger yields).
    pub yielded: bool,
}

/// One priority window, as the pass rules read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    /// phase's name for the step ("PreCombatMain").
    pub phase: String,
    pub your_turn: bool,
    pub top: Option<Top>,
    /// Passing is all you could do.
    pub only_pass: bool,
    /// Something besides passing and land abilities (fetchlands and the like don't make a stop
    /// worthwhile on their own; you still get them whenever you do stop).
    pub can_act: bool,
    /// A spell you could cast now.
    pub can_cast: bool,
}

/// What to do with a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Pass for them.
    Pass,
    /// Ask them.
    Stop,
    /// Ask them, and end their pass mode: something happened.
    Interrupt,
}

/// The pass rules (play/src/lib.rs `Match::auto_pass` applies them to each window):
/// - with nothing but passing to do, pass;
/// - holding priority, stop;
/// - in a pass mode, pass unless the mode's own interruptions apply (`PassMode`); this outranks
///   full control, since passing is what was asked for;
/// - in full control, stop;
/// - otherwise the smart stops: someone else's spell or ability on top that you could answer
///   stops you (unless you yielded to it); your own on top resolves without asking (PP-07,
///   Bryan's decision 8 of 2026-10-23); on an empty stack, your stops by step, or by default
///   your main phases and an opponent's end step when you could cast a spell.
pub fn verdict(w: &Window, c: &Controls) -> Verdict {
    if w.only_pass {
        return Verdict::Pass;
    }
    if c.hold {
        return Verdict::Stop;
    }
    let theirs = w.top.is_some_and(|t| !t.yours && !t.yielded);
    if let Some(p) = c.passing {
        if p.mode.stops_for_spells() && theirs && w.can_act {
            return Verdict::Interrupt;
        }
        if p.mode.stops_at_steps() && w.top.is_none() && step_stop(w, c) {
            return Verdict::Interrupt;
        }
        return Verdict::Pass;
    }
    if c.full_control {
        return Verdict::Stop;
    }
    if !w.can_act {
        return Verdict::Pass;
    }
    if w.top.is_some() {
        return if theirs { Verdict::Stop } else { Verdict::Pass };
    }
    if step_stop(w, c) { Verdict::Stop } else { Verdict::Pass }
}

/// An empty-stack stop at this step: their own stops, or the usual ones (your main phases; an
/// opponent's end step when you could cast a spell).
fn step_stop(w: &Window, c: &Controls) -> bool {
    match &c.stops {
        Some(stops) => stops.has(&w.phase, w.your_turn),
        None => match w.phase.as_str() {
            "PreCombatMain" | "PostCombatMain" => w.your_turn,
            "End" => !w.your_turn && w.can_cast,
            _ => false,
        },
    }
}

// ── what a seat's view says about its own settings ─────────────────────────

/// The viewer's own turn controls and remembered answers (`View::turns`).
#[derive(Debug, Clone, Serialize)]
pub struct TurnsView {
    pub full_control: bool,
    /// Their own stops; `None` for the usual ones.
    pub stops: Option<Stops>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passing: Option<PassMode>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hold: bool,
    /// Triggers Yama passes for while they're on top of the stack.
    pub yields: Vec<YieldView>,
    /// Answers the engine gives for them (GSettings, "Automatic answers").
    pub answers: Vec<AnswerView>,
    /// How their spells pay (GPay's "Tap mana for me").
    pub tap_mana: crate::PayMode,
}

/// A trigger yield (GSettings).
#[derive(Debug, Clone, Serialize)]
pub struct YieldView {
    pub id: String,
    /// The card whose trigger it is.
    pub name: String,
    /// The trigger's own words, when the yield is for one trigger of the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Whose card it is, when it's still in the game.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<u8>,
    /// The card and its copies (phase's `AllCopies`: by the physical card, so tokens and copies
    /// of it, not other cards with the same name), not only this object.
    pub every: bool,
    /// What the board sends to remove it.
    pub remove: Act,
}

/// An answer the engine gives for this seat without asking (GSettings, GLog's "Turn off").
#[derive(Debug, Clone, Serialize)]
pub struct AnswerView {
    pub id: String,
    /// "may" (a "you may" trigger) or "replacement" (which replacement effect applies first).
    pub kind: &'static str,
    /// The card asking.
    pub name: String,
    /// The answer, in the engine's words where it has them.
    pub answer: String,
    /// "card": this card; "copies": every copy of it.
    pub scope: &'static str,
    /// What the board sends to turn it off.
    pub forget: Act,
}

/// A short, stable id for something the engine stores, so a log line and the settings list can
/// point at the same answer. Ids are only compared within one game.
pub(crate) fn short_id(prefix: &str, value: &impl Serialize) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(value).unwrap_or_default().hash(&mut h);
    format!("{prefix}{:016x}", h.finish())
}

/// The name of the card a yield or answer is about, as `vs` (the seat's view) shows it.
fn object_name(vs: &GameState, id: &ObjectId) -> Option<String> {
    vs.objects.get(id).map(|_| Match::name_in(vs, id))
}

impl Match {
    /// The viewer's own settings: `full` is the whole game (for the engine's records, which are
    /// the viewer's own only), `vs` the viewer's filtered view (for names).
    pub(crate) fn turns_view(&self, vs: &GameState, seat: u8) -> TurnsView {
        let me = PlayerId(seat);
        let c = self.controls.get(&seat).cloned().unwrap_or_default();
        let full = &self.state;
        let yields = full
            .priority_yields
            .iter()
            .filter(|y| y.player == me)
            .map(|y| {
                let (name, controller, text, every) = match &y.target {
                    YieldTarget::ThisObject { source_id, trigger_description, .. } => (
                        object_name(vs, source_id),
                        vs.objects.get(source_id).map(|o| o.controller.0),
                        trigger_description.clone(),
                        false,
                    ),
                    YieldTarget::AllCopies { card_id, trigger_description } => {
                        let o = vs.objects.values().find(|o| o.card_id == *card_id && !o.face_down);
                        (o.map(|o| o.name.clone()), o.map(|o| o.controller.0), trigger_description.clone(), true)
                    }
                };
                let name = name.unwrap_or_else(|| "A trigger".into());
                YieldView {
                    id: short_id("y", &y.target),
                    text: text.map(|t| crate::ability_text(&t, &name)),
                    name,
                    controller,
                    every,
                    remove: Act::SetPriorityYield { change: YieldChange::Remove { target: y.target.clone() } },
                }
            })
            .collect();
        let mut answers: Vec<AnswerView> = full
            .may_trigger_auto_choices
            .iter()
            .filter(|r| r.selector.player() == me)
            .map(|r| {
                let (name, scope) = match &r.selector {
                    MayTriggerAutoChoiceSelector::ExactInstance { source_id, .. } => (object_name(vs, source_id), "card"),
                    MayTriggerAutoChoiceSelector::SameCard { printed_ref, .. } => (Some(printed_ref.face_name.clone()), "copies"),
                };
                AnswerView {
                    id: short_id("m", &r.selector),
                    kind: "may",
                    name: name.unwrap_or_else(|| "A card".into()),
                    answer: if r.choice == AutoMayChoice::Accept { "Always yes".into() } else { "Always no".into() },
                    scope,
                    forget: Act::SetMayTriggerAutoChoice { change: AnswerChange::Remove { selector: r.selector.clone() } },
                }
            })
            .collect();
        answers.extend(full.replacement_auto_choices.iter().filter(|r| r.key.player == me).map(|r| {
            let source = r.key.candidates.first().map(|c| match c {
                ReplacementAutoChoiceIdentity::Definition { source, .. } | ReplacementAutoChoiceIdentity::Mana { source, .. } => source.object_id,
            });
            let words: Vec<String> = r.descriptions.iter().map(|d| phase_llm::render::text::one_line(d)).filter(|d| !d.is_empty()).collect();
            let answer = match &r.choice {
                ReplacementAutoChoice::Optional { index } => {
                    let yes = *index == 0;
                    match words.first() {
                        Some(w) => format!("{}: {w}", if yes { "Always yes" } else { "Always no" }),
                        None => if yes { "Always yes".into() } else { "Always no".into() },
                    }
                }
                ReplacementAutoChoice::Order { .. } if words.is_empty() => "Always the same order".into(),
                ReplacementAutoChoice::Order { .. } => format!("Always in this order: {}", words.join(", then ")),
            };
            AnswerView {
                id: format!("r{}", r.id.0),
                kind: "replacement",
                name: source.and_then(|s| object_name(vs, &s)).unwrap_or_else(|| "Replacement effects".into()),
                answer,
                scope: "card",
                forget: Act::SetReplacementAutoChoice { id: Some(r.id.0.clone()) },
            }
        }));
        TurnsView {
            full_control: c.full_control,
            stops: c.stops.clone(),
            passing: c.passing.map(|p| p.mode),
            hold: c.hold,
            yields,
            answers,
            tap_mana: c.tap_mana,
        }
    }

    /// Who asked to resolve the whole stack and who has agreed, while the engine is asking
    /// (`View::resolve_all`; GTogether's consent tab). Read from the whole game: the agreement
    /// ledger is public, though phase leaves it out of a seat's filtered view.
    pub(crate) fn resolve_all_view(&self) -> Option<ResolveAllView> {
        let WaitingFor::ResolveAllConsent { representative, .. } = &self.state.waiting_for else { return None };
        let run = self.state.resolve_all_consent_run.as_ref()?;
        // The requester comes first and agreed by asking (phase rotates the list that way).
        let asked_by = run.participants.first()?.representative.0;
        Some(ResolveAllView {
            asked_by,
            seats: run
                .participants
                .iter()
                .map(|p| ConsentView { seat: p.representative.0, agreed: p.granted, deciding: p.representative == *representative })
                .collect(),
        })
    }

    /// Remembered "may" answers the engine is about to give for people: each trigger of theirs
    /// on the stack whose answer is stored. When one resolves, its log line says Yama answered
    /// (GLog). A remembered "no" usually stops the trigger before it reaches the stack, and the
    /// engine reports nothing then, so only answers given at resolution are logged.
    pub(crate) fn watch_automatic_answers(&self) -> Vec<AutoWatch> {
        let humans: HashSet<u8> = (0..self.state.players.len() as u8).filter(|s| !self.is_ai(*s)).collect();
        self.state
            .stack
            .iter()
            .filter_map(|entry| {
                let StackEntryKind::TriggeredAbility { ability, .. } = &entry.kind else { return None };
                let origin = ability.may_trigger_origin.clone()?;
                let seat = ability.controller.0;
                if !humans.contains(&seat) {
                    return None;
                }
                let key = MayTriggerAutoChoiceKey { player: ability.controller, source_id: ability.source_id, origin };
                let choice = self.state.may_trigger_auto_choice_for_live_prompt(&key)?;
                // The record behind it: this exact trigger's, else the one for every copy.
                let exact = MayTriggerAutoChoiceSelector::exact(key.clone());
                let selector = if self.state.may_trigger_auto_choices.iter().any(|r| r.selector == exact) {
                    exact
                } else {
                    self.state.same_card_may_trigger_auto_choice_selector(&key)?
                };
                Some(AutoWatch {
                    entry: entry.id.0,
                    seat,
                    name: Match::name_in(&self.state, &ability.source_id),
                    accept: choice == AutoMayChoice::Accept,
                    id: short_id("m", &selector),
                })
            })
            .collect()
    }
}

/// A remembered answer about to be given (`Match::watch_automatic_answers`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutoWatch {
    pub entry: u64,
    pub seat: u8,
    pub name: String,
    pub accept: bool,
    /// The answer's id in the seat's `TurnsView::answers`.
    pub id: String,
}

/// Resolve all, while the engine asks everyone (GTogether's consent tab).
#[derive(Debug, Clone, Serialize)]
pub struct ResolveAllView {
    /// Who asked.
    pub asked_by: u8,
    /// Everyone the engine asks, in the order it asks them.
    pub seats: Vec<ConsentView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConsentView {
    pub seat: u8,
    pub agreed: bool,
    /// Being asked now.
    pub deciding: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(phase: &str, your_turn: bool, top: Option<Top>) -> Window {
        Window { phase: phase.into(), your_turn, top, only_pass: false, can_act: true, can_cast: true }
    }
    fn passing(mode: PassMode) -> Controls {
        Controls { passing: Some(Passing { mode, turn: 3 }), ..Controls::default() }
    }
    const THEIRS: Option<Top> = Some(Top { yours: false, yielded: false });
    const YOURS: Option<Top> = Some(Top { yours: true, yielded: false });
    const YIELDED: Option<Top> = Some(Top { yours: false, yielded: true });

    #[test]
    fn the_usual_stops_ask_where_you_could_act() {
        let usual = Controls::default();
        assert_eq!(verdict(&window("PreCombatMain", true, None), &usual), Verdict::Stop);
        assert_eq!(verdict(&window("PreCombatMain", false, None), &usual), Verdict::Pass);
        assert_eq!(verdict(&window("Upkeep", true, None), &usual), Verdict::Pass);
        // An opponent's end step, only with a spell to cast.
        assert_eq!(verdict(&window("End", false, None), &usual), Verdict::Stop);
        assert_eq!(verdict(&Window { can_cast: false, ..window("End", false, None) }, &usual), Verdict::Pass);
        // Someone else's spell stops you; your own resolves; a trigger you yielded to passes.
        assert_eq!(verdict(&window("Upkeep", false, THEIRS), &usual), Verdict::Stop);
        assert_eq!(verdict(&window("PreCombatMain", true, YOURS), &usual), Verdict::Pass);
        assert_eq!(verdict(&window("Upkeep", false, YIELDED), &usual), Verdict::Pass);
        // Nothing to answer with: pass, even for their spell.
        assert_eq!(verdict(&Window { can_act: false, ..window("Upkeep", false, THEIRS) }, &usual), Verdict::Pass);
    }

    #[test]
    fn your_own_stops_replace_the_usual_ones() {
        let own = Controls { stops: Some(Stops { own: ["Upkeep".to_string()].into(), others: HashSet::new() }), ..Controls::default() };
        assert_eq!(verdict(&window("Upkeep", true, None), &own), Verdict::Stop);
        assert_eq!(verdict(&window("PreCombatMain", true, None), &own), Verdict::Pass);
        assert_eq!(verdict(&window("End", false, None), &own), Verdict::Pass);
    }

    #[test]
    fn full_control_and_holding_priority_stop_everywhere_but_nothing_to_do() {
        let full = Controls { full_control: true, ..Controls::default() };
        assert_eq!(verdict(&window("Upkeep", false, None), &full), Verdict::Stop);
        assert_eq!(verdict(&window("Upkeep", true, YOURS), &full), Verdict::Stop);
        let hold = Controls { hold: true, ..Controls::default() };
        assert_eq!(verdict(&window("Upkeep", true, YOURS), &hold), Verdict::Stop);
        // Holding beats a pass mode too.
        assert_eq!(verdict(&window("Upkeep", true, YOURS), &Controls { hold: true, ..passing(PassMode::Mine) }), Verdict::Stop);
        // With nothing else legal, every setting passes.
        let only = Window { only_pass: true, ..window("Upkeep", false, THEIRS) };
        assert_eq!(verdict(&only, &full), Verdict::Pass);
        assert_eq!(verdict(&only, &hold), Verdict::Pass);
    }

    #[test]
    fn each_pass_mode_stops_only_for_what_it_says() {
        // Pass until something happens: someone else's spell, or your stops.
        let until = passing(PassMode::Until);
        assert_eq!(verdict(&window("Upkeep", false, THEIRS), &until), Verdict::Interrupt);
        assert_eq!(verdict(&window("PostCombatMain", true, None), &until), Verdict::Interrupt);
        assert_eq!(verdict(&window("Upkeep", false, None), &until), Verdict::Pass);
        assert_eq!(verdict(&window("Upkeep", false, YIELDED), &until), Verdict::Pass);
        // Pass the rest of this turn: your stops only, never spells.
        let turn = passing(PassMode::Turn);
        assert_eq!(verdict(&window("Upkeep", false, THEIRS), &turn), Verdict::Pass);
        assert_eq!(verdict(&window("End", false, None), &turn), Verdict::Interrupt);
        // End turn: past your own stops; spells still stop you.
        let end = passing(PassMode::End);
        assert_eq!(verdict(&window("PostCombatMain", true, None), &end), Verdict::Pass);
        assert_eq!(verdict(&window("End", true, THEIRS), &end), Verdict::Interrupt);
        // Pass to my turn: spells stop you, steps don't.
        let mine = passing(PassMode::Mine);
        assert_eq!(verdict(&window("End", false, None), &mine), Verdict::Pass);
        assert_eq!(verdict(&window("PreCombatMain", false, THEIRS), &mine), Verdict::Interrupt);
        // A pass mode outranks full control: passing is what was asked for.
        assert_eq!(verdict(&window("Upkeep", false, None), &Controls { full_control: true, ..mine }), Verdict::Pass);
    }

    #[test]
    fn a_pass_mode_lasts_its_turn_or_until_your_next_turn() {
        let turn = Passing { mode: PassMode::Until, turn: 5 };
        assert!(!turn.over(5, false));
        assert!(turn.over(6, false));
        let mine = Passing { mode: PassMode::Mine, turn: 5 };
        assert!(!mine.over(6, false), "someone else's turn");
        assert!(!mine.over(5, true), "still the turn it began in");
        assert!(mine.over(8, true));
    }

    #[test]
    fn modes_read_as_the_board_sends_them() {
        assert_eq!(serde_json::from_str::<PassMode>(r#""mine""#).unwrap(), PassMode::Mine);
        assert_eq!(serde_json::to_string(&PassMode::Until).unwrap(), r#""until""#);
        assert!(serde_json::from_str::<PassMode>(r#""forever""#).is_err());
    }
}
