//! Answers Yama remembers for people (Bryan's decision 4 of 2026-10-23: "Always pay for Rhystic
//! Study", "Always send my commander to the command zone"): answers the engine can't remember
//! itself, which Yama gives for a person from then on. Their decision's `Pending::remember` is
//! "yama" (the engine's own remembered "may" answers say "engine", turns.rs).
//!
//! **Which decisions (decided 2026-10-24):**
//! - **Paying an unless-cost in mana** (`UnlessPayment`: Rhystic Study, Smothering Tithe, Mystic
//!   Remora), per source card, whose card it is and the cost. A cost that isn't mana (discard,
//!   sacrifice, life) leads to more choices, so it's always asked. "Always pay" is used only when
//!   the engine can pay it from your untapped mana; otherwise you're asked, so it never silently
//!   fails to pay. A different cost ({X} that changed) is a different answer.
//! - **Your commander going to the graveyard or exile** (`CommanderZoneChoice`), per commander.
//!
//! Each is kept for the rest of the game (GSettings' "This game", GChoices' "For the rest of this
//! game"), not per account: whether to pay for an opponent's Rhystic Study depends on the table,
//! and the design keeps every remembered answer per game. They're saved with the game (the
//! server's `online_games.answers`) so a restart keeps them.
//!
//! Every automatic answer adds a log line and a feed line only that person sees, with the
//! answer's id so the log's Turn off can forget it; the settings list shows them beside the
//! engine's own (`TurnsView::answers`, kind "yama").

use engine::types::ability::AbilityCost;
use engine::types::game_state::WaitingFor;
use engine::types::player::PlayerId;
use serde::{Deserialize, Serialize};

use crate::act::{self, Act, Pending};
use crate::turns::{AnswerView, short_id};
use crate::{LogLine, Match};

/// What kind of decision an answer is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RememberKind {
    /// Pay an unless-cost in mana, or don't.
    Pay,
    /// Put your commander into the command zone, or leave it where it went.
    Commander,
}

/// One remembered answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YamaAnswer {
    pub id: String,
    pub seat: u8,
    pub kind: RememberKind,
    /// The card asking: the source of the unless-cost, or the commander.
    pub card: String,
    /// Whose card it is (an unless-cost's source), for "Jules's Rhystic Study".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<u8>,
    /// The cost, printed ("{1}").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<String>,
    /// Pay (or put it in the command zone), else don't.
    pub accept: bool,
}

/// What identifies an answer to a decision: the seat, the kind, the card, whose card, the cost.
type Key = (u8, RememberKind, String, Option<u8>, Option<String>);

impl YamaAnswer {
    fn key(&self) -> Key {
        (self.seat, self.kind, self.card.clone(), self.owner, self.cost.clone())
    }
}

/// The key a seat's decision would be remembered under, if Yama can remember it.
fn key_of(seat: u8, p: &Pending, waiting: &WaitingFor) -> Option<Key> {
    if p.remember != Some("yama") {
        return None;
    }
    let source = p.source.as_ref()?;
    match (p.purpose, waiting) {
        ("pay", WaitingFor::UnlessPayment { cost: AbilityCost::Mana { cost }, .. }) => {
            Some((seat, RememberKind::Pay, source.name.clone(), Some(source.controller), Some(phase_llm::render::text::mana_cost_text(cost))))
        }
        ("commander_zone", WaitingFor::CommanderZoneChoice { .. }) => Some((seat, RememberKind::Commander, source.name.clone(), None, None)),
        _ => None,
    }
}

/// The answer to send for a decision Yama remembers: pay or don't, command zone or not.
fn plain(kind: RememberKind, accept: bool) -> Act {
    match kind {
        RememberKind::Pay => Act::PayUnlessCost { pay: accept },
        RememberKind::Commander => Act::DecideOptionalEffect { accept },
    }
}

impl Match {
    /// The answers Yama remembers in this game, for saving with it.
    pub fn remembered(&self) -> &[YamaAnswer] {
        &self.remembered
    }

    /// Answers saved with the game, after a resume.
    pub fn set_remembered(&mut self, answers: Vec<YamaAnswer>) {
        self.remembered = answers;
    }

    /// `seat`'s current decision, as its board sees it.
    fn pending_of(&self, seat: u8) -> Option<Pending> {
        let me = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&me) {
            return None;
        }
        let candidates: Vec<_> = engine::ai_support::AiDecisionContract::issue(&self.state, me).candidates.iter().map(|c| c.action.clone()).collect();
        let vs = engine::game::filter_state_for_viewer(&self.state, me);
        Pending::of(&vs, me, &candidates, &self.names)
    }

    /// Answer `seat`'s decision with `accept` and remember it (`Act::RememberAnswer`): the decision
    /// must be one Yama can remember. The answer is given like any other; only then is it kept.
    pub(crate) fn remember_answer(&mut self, seat: u8, accept: bool) -> Result<act::Answered, act::Refusal> {
        let p = self.pending_of(seat).ok_or(act::Refusal::NotYours)?;
        let Some(key) = key_of(seat, &p, &self.state.waiting_for) else {
            return Err(act::Refusal::DoesntFit("This answer can't be remembered.".into()));
        };
        let done = act::answer(&mut self.state, PlayerId(seat), &plain(key.1, accept))?;
        let (seat, kind, card, owner, cost) = key;
        self.remembered.retain(|a| a.key() != (seat, kind, card.clone(), owner, cost.clone()));
        let id = short_id("y", &(seat, kind, &card, owner, &cost));
        self.remembered.push(YamaAnswer { id, seat, kind, card, owner, cost, accept });
        Ok(done)
    }

    /// Forget one of `seat`'s remembered answers (GSettings' and GLog's Turn off).
    pub(crate) fn forget_answer(&mut self, seat: u8, id: &str) -> Result<(), String> {
        let before = self.remembered.len();
        self.remembered.retain(|a| !(a.seat == seat && a.id == id));
        if self.remembered.len() == before { Err("That answer is already off.".into()) } else { Ok(()) }
    }

    /// Give one remembered answer for a person whose decision Yama remembers, if any is due: the
    /// answer goes through the engine like theirs would, with a log line only they see. "Always
    /// pay" waits for them instead when the engine couldn't pay from their untapped mana. Returns
    /// whether one was given.
    pub(crate) fn answer_remembered(&mut self, humans: &[u8]) -> bool {
        if self.remembered.is_empty() || !matches!(self.state.waiting_for, WaitingFor::UnlessPayment { .. } | WaitingFor::CommanderZoneChoice { .. }) {
            return false;
        }
        for seat in self.waiting_on().into_iter().filter(|s| humans.contains(s)) {
            if self.remembered_tried == Some((seat, self.revision)) {
                continue;
            }
            let Some(p) = self.pending_of(seat) else { continue };
            let Some(key) = key_of(seat, &p, &self.state.waiting_for) else { continue };
            let Some(a) = self.remembered.iter().find(|a| a.key() == key).cloned() else { continue };
            if a.kind == RememberKind::Pay && a.accept && !self.can_pay_unless(seat) {
                self.remembered_tried = Some((seat, self.revision));
                continue;
            }
            let zone = match &self.state.waiting_for {
                WaitingFor::CommanderZoneChoice { current_zone, .. } => Some(*current_zone),
                _ => None,
            };
            match act::answer(&mut self.state, PlayerId(seat), &plain(a.kind, a.accept)) {
                Ok(done) => {
                    for action in done.actions {
                        self.log.push_action(done.actor, action);
                    }
                    let did = self.did_words(&a, zone);
                    self.accepted(&done.result, Some(seat));
                    self.feed.automatic_by_yama(seat, &a.card, a.accept, &a.id, &did, &self.state);
                    self.lines.push(LogLine { turn: self.state.turn_number, text: format!("Yama {did}, as you asked."), seat: Some(seat), auto: Some(a.id.clone()) });
                    return true;
                }
                // The engine refused it: ask the person instead.
                Err(_) => self.remembered_tried = Some((seat, self.revision)),
            }
        }
        false
    }

    /// Whether the engine could pay the unless-cost `seat` is asked for now from their mana
    /// (tapping what it would tap, CR 118.12).
    fn can_pay_unless(&self, seat: u8) -> bool {
        let WaitingFor::UnlessPayment { cost: AbilityCost::Mana { cost }, pending_effect, .. } = &self.state.waiting_for else { return false };
        engine::game::casting::can_pay_cost_after_auto_tap(&self.state, PlayerId(seat), pending_effect.source_id, cost)
    }

    /// What Yama did, in words for the log: "paid {1} for Jules's Rhystic Study", "put Éowyn into
    /// the command zone".
    fn did_words(&self, a: &YamaAnswer, zone: Option<engine::types::zones::Zone>) -> String {
        match a.kind {
            RememberKind::Pay => {
                let whose = self.whose(a.seat, a.owner);
                let cost = a.cost.clone().unwrap_or_default();
                if a.accept { format!("paid {cost} for {whose} {}", a.card) } else { format!("didn't pay {cost} for {whose} {}", a.card) }
            }
            RememberKind::Commander if a.accept => format!("put {} into the command zone", a.card),
            RememberKind::Commander => {
                let zone = match zone {
                    Some(engine::types::zones::Zone::Exile) => "in exile",
                    Some(engine::types::zones::Zone::Hand) => "in your hand",
                    Some(engine::types::zones::Zone::Library) => "in your library",
                    _ => "in your graveyard",
                };
                format!("left {} {zone}", a.card)
            }
        }
    }

    /// "your" or "Jules's", for a card's owner as `seat` reads it.
    fn whose(&self, seat: u8, owner: Option<u8>) -> String {
        match owner {
            Some(o) if o == seat => "your".into(),
            Some(o) => format!("{}'s", self.seat_name(PlayerId(o))),
            None => "the".into(),
        }
    }

    /// `seat`'s remembered answers, for its settings list beside the engine's own.
    pub(crate) fn remembered_views(&self, seat: u8) -> Vec<AnswerView> {
        self.remembered
            .iter()
            .filter(|a| a.seat == seat)
            .map(|a| {
                let cost = a.cost.clone().unwrap_or_default();
                let answer = match (a.kind, a.accept) {
                    (RememberKind::Pay, true) => format!("Always pay {cost}"),
                    (RememberKind::Pay, false) => format!("Never pay {cost}"),
                    (RememberKind::Commander, true) => "Always to the command zone".into(),
                    (RememberKind::Commander, false) => "Never to the command zone".into(),
                };
                AnswerView {
                    id: a.id.clone(),
                    kind: "yama",
                    name: a.card.clone(),
                    owner: a.owner.filter(|o| *o != seat),
                    answer,
                    scope: "card",
                    forget: Act::ForgetAnswer { id: a.id.clone() },
                }
            })
            .collect()
    }
}
