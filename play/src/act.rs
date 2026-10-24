//! Real answers to the engine's decisions (docs/game-interactions-review-2026-10-23.md, build
//! plan section 2). [`Pending`] describes a seat's current decision in the shape the design's
//! generic decision widgets read (design/README.md, "Generic decision widgets": a kind, the
//! source card, the engine's question, the options, min and max and a default answer), read
//! from that seat's filtered view, so it names only cards the seat may see. [`Act`] is the
//! answer a person sends back: a whitelist of engine actions, with no way to spell anything
//! else. [`answer`] checks an answer against the seat's [`Pending`] and applies it to a copy of
//! the game first, as `Match::declare` does for attacks and blocks, so a refused answer leaves
//! the game exactly as it was.
//!
//! Decisions with no [`Pending`] keep the index buttons (the AI's sampled option list), and so
//! do the kinds of answer `Act` doesn't cover. Nothing loses its way to be answered.
//!
//! Where the engine itself can remember an answer (a "may" trigger, the order of replacement
//! effects), `Pending::remember` is "engine" and the remembering forms of the answer are allowed.
//!
//! `Act` also spells a seat's own settings (turning off a remembered answer, trigger yields,
//! hand order: [`Act::is_preference`]), which aren't answers and may be sent at any time, and
//! Resolve all (play/src/turns.rs).

use engine::ai_support::AiDecisionContract;
use engine::game::engine::apply_interaction;
use engine::game::filter_state_for_viewer;
use engine::types::ability::{AbilityCost, FreeEntry, TargetRef};
use engine::types::actions::{GameAction, MayTriggerAutoChoiceOp, PriorityYieldOp, ReplacementAutoChoice, ResolveAllScope};
use engine::types::game_state::{
    ActionResult, AutoMayChoice, CombatDamageAssignmentMode, CombatTaxContext, DistributionUnit, GameState, MayTriggerAutoChoiceScope,
    MayTriggerAutoChoiceSelector, MulliganDecisionPhase, ReplacementAutoChoiceId, ReplacementChoiceKind, RetargetScope, WaitingFor, YieldScope,
    YieldTarget,
};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use phase_llm::render::action::humanize_identifier;
use phase_llm::render::text::{mana_cost_text, one_line};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Match, TargetView, cost_text};

/// The widget shape a decision takes (the design's `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A yes or no strip: "may" prompts and costs you may pay.
    Yesno,
    /// Pick some of the options.
    Pick,
    /// Put all the options in order.
    Order,
    /// Match options up in pairs (no decision uses it yet).
    Pair,
    /// Split a total among the options.
    Split,
    /// Choose a number.
    Number,
    /// Choose a word or a name.
    Text,
}

/// Which [`Act`] answers the decision, so the board knows what to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
    SelectCards,
    OrderTriggers,
    SelectModes,
    ChooseX,
    ChooseTarget,
    PayUnlessCost,
    DecideOptionalEffect,
    ChooseOption,
    ChooseReplacement,
    AssignCombatDamage,
    DistributeAmong,
    ChoosePair,
    /// A new target for a spell or ability on the stack (CR 115.7).
    RetargetSpell,
    /// Pay an attack or block tax, or don't (CR 508.1d, 509.1c).
    PayCombatTax,
    /// Exert an attacker as it attacks, or don't (CR 701.43).
    ChooseExert,
    /// Tap a creature for enlist, or none (CR 702.154a).
    ChooseEnlist,
    /// The creatures that crew a Vehicle (CR 702.122a).
    CrewVehicle,
    /// The creatures that saddle a Mount (CR 702.171a).
    SaddleMount,
}

/// The card asking. The server adds its art, image and artist from Yama's card data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: u64,
    pub name: String,
    pub controller: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
}

/// One option of a decision. `id` is what the answer names: an object id ("123"), a player
/// ("p2"), an index ("0") or the word itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub name: String,
    /// More words: a trigger's own text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The card's image and art crop, and who painted it (filled in by the server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// Where the card is: "hand", "library", "battlefield"…, or "player".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<u8>,
    /// False for something shown but not choosable (a dig's cards that fail its filter).
    pub eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toughness: Option<i32>,
    /// Combat damage that counts as lethal for it (1 with deathtouch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lethal: Option<u32>,
    /// What it adds toward the decision's `need` when picked: crew or saddle power, which the
    /// engine works out (it can differ from the creature's power).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power: Option<i32>,
    /// It names a card, so the server sends that card's details.
    #[serde(skip)]
    pub card: bool,
}

/// The seat's current decision (`Decision::pending`), shaped like the design's `decision`
/// object, with the same field names in camelCase on the wire. The fields after `answer` that
/// the design doesn't list are Yama's own: what the board needs to build and send the answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub kind: Kind,
    /// The card asking, if the engine names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    /// The question, from the engine's own description of the decision.
    pub prompt: String,
    /// The source's Oracle text (filled in by the server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oracle: Option<String>,
    pub options: Vec<Choice>,
    pub min: usize,
    pub max: usize,
    pub up_to: bool,
    /// The engine's own answer where it has one: ids for a pick, ids in order, `{id: amount}`
    /// for a split, a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_answer: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_label: Option<String>,
    /// "engine" when the engine can remember the answer for this card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember: Option<&'static str>,
    /// Where the options are, when they're all in one zone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// Where picked or ordered cards go: "top" or "bottom" of the library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<&'static str>,
    /// What a split divides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_option_min: Option<u32>,
    /// A text answer may be any word, not only an option.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_entry: Option<bool>,
    /// What a text answer names ("card name", "creature type").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice_type: Option<String>,
    /// Which [`Act`] answers this.
    pub answer: Answer,
    /// What the decision is for: "scry", "surveil", "search", "dig", "discard", "bottom",
    /// "choose", "target", "modes", "replacement", "triggers", "x", "may", "pay", "name",
    /// "damage" or "divide".
    pub purpose: &'static str,
    /// The order picked is the order they end up in (scry and surveil: the first is on top).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ordered: bool,
    /// A mode may be chosen more than once.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub repeat: bool,
    /// The total cost for each X.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub previews: Vec<(u32, String)>,
    /// Combat damage may all be assigned as though the attacker weren't blocked.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unblocked: bool,
    /// What a split divides: "damage", "counters" or "life" (damage gets a lethal hint).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<&'static str>,
    /// The engine can also remember a "may" answer for every copy of the card (not only this
    /// one); `admits` checks a same-card remember against it. The board remembers that way when
    /// it can, so the answer holds for the next copy too (and shows in the log when it's used).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub remember_same_card: bool,
    /// Targets chosen one at a time (CR 601.2c): this one's place, from 0, and how many there are.
    /// The engine moves on after each, so only the current one can still change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<(usize, usize)>,
    /// The targets already chosen for the earlier ones, by option id, in order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub picked: Vec<String>,
    /// What a copy or a spell on the stack targets now, by option id (CR 707.10c, 115.7). Picking
    /// it again keeps it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    /// Every remaining target of the copy may be kept at once (`Act::KeepAllCopyTargets`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub keep_rest: bool,
    /// Crew or saddle: the total power the picked creatures must reach.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need: Option<u32>,
    /// `current` isn't one of the engine's alternatives, so picking it is sent as keeping it.
    #[serde(skip)]
    keeps_current: bool,
}

impl Pending {
    fn new(kind: Kind, answer: Answer, purpose: &'static str, prompt: impl Into<String>, options: Vec<Choice>) -> Self {
        let n = options.iter().filter(|o| o.eligible).count();
        Pending {
            kind,
            source: None,
            prompt: prompt.into(),
            oracle: None,
            options,
            min: 1.min(n),
            max: 1.min(n),
            up_to: false,
            default_answer: None,
            yes_label: None,
            no_label: None,
            remember: None,
            zone: None,
            filter: None,
            destination: None,
            total: None,
            per_option_min: None,
            free_entry: None,
            choice_type: None,
            answer,
            purpose,
            ordered: false,
            repeat: false,
            previews: vec![],
            unblocked: false,
            unit: None,
            remember_same_card: false,
            slot: None,
            picked: vec![],
            current: None,
            keep_rest: false,
            need: None,
            keeps_current: false,
        }
    }

    fn from(mut self, vs: &GameState, source: Option<ObjectId>) -> Self {
        self.source = source.and_then(|id| {
            let o = vs.objects.get(&id)?;
            Some(Source { id: id.0, name: Match::name_in(vs, &id), controller: o.controller.0, art: None, image: None, artist: None })
        });
        self
    }

    /// Pick between `min` and `max` of the eligible options (capped at how many there are).
    fn range(mut self, min: usize, max: usize, up_to: bool) -> Self {
        let n = self.options.iter().filter(|o| o.eligible).count();
        self.min = min.min(n);
        self.max = max.min(n);
        self.up_to = up_to;
        self
    }

    fn yes_no(mut self, yes: impl Into<String>, no: impl Into<String>) -> Self {
        self.yes_label = Some(yes.into());
        self.no_label = Some(no.into());
        self.min = 1;
        self.max = 1;
        self
    }
}

fn zone_name(vs: &GameState, id: &ObjectId) -> Option<String> {
    vs.objects.get(id).map(|o| format!("{:?}", o.zone).to_lowercase())
}

/// A card or permanent as an option, named and placed as `vs` shows it.
fn card(vs: &GameState, id: &ObjectId, eligible: bool) -> Choice {
    let o = vs.objects.get(id);
    Choice {
        id: id.0.to_string(),
        name: Match::name_in(vs, id),
        text: None,
        img: None,
        art: None,
        artist: None,
        zone: zone_name(vs, id),
        controller: o.map(|o| o.controller.0),
        eligible,
        toughness: o.and_then(|o| o.toughness),
        lethal: None,
        power: None,
        card: true,
    }
}

fn cards(vs: &GameState, ids: &[ObjectId]) -> Vec<Choice> {
    ids.iter().map(|id| card(vs, id, true)).collect()
}

/// A word, a mode or a trigger as an option.
fn word(id: impl Into<String>, name: impl Into<String>) -> Choice {
    Choice {
        id: id.into(),
        name: name.into(),
        text: None,
        img: None,
        art: None,
        artist: None,
        zone: None,
        controller: None,
        eligible: true,
        toughness: None,
        lethal: None,
        power: None,
        card: false,
    }
}

fn player_choice(p: PlayerId, names: &[String]) -> Choice {
    let mut c = word(format!("p{}", p.0), names.get(usize::from(p.0)).cloned().unwrap_or_else(|| format!("Player {}", p.0 + 1)));
    c.zone = Some("player".into());
    c.controller = Some(p.0);
    c
}

fn target(vs: &GameState, t: &TargetRef, names: &[String]) -> Choice {
    match t {
        TargetRef::Object(id) => card(vs, id, true),
        TargetRef::Player(p) => player_choice(*p, names),
    }
}

/// The option id an answer's target names.
pub(crate) fn target_id(t: &TargetView) -> String {
    match t {
        TargetView::Object { id } => id.to_string(),
        TargetView::Player { seat } => format!("p{seat}"),
    }
}

/// The zone all the options share, if they do.
fn common_zone(options: &[Choice]) -> Option<String> {
    let first = options.first()?.zone.clone()?;
    options.iter().all(|o| o.zone.as_deref() == Some(first.as_str())).then_some(first)
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

/// "draw a card" as a question: "Draw a card?". A whole trigger ("When ~ enters, you may search
/// your library…") asks what you may do ("Search your library…?"). Longer text (several
/// sentences) is left as the engine wrote it, capitalised.
fn question(text: &str) -> String {
    let text = one_line(text);
    let text = text.trim();
    let text = text.split_once(", you may ").map_or(text, |(_, rest)| rest);
    let single = !text.trim_end_matches('.').contains(". ");
    let text = if single { text.trim_end_matches(['.', '?']) } else { text };
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => format!("{}{}{}", c.to_uppercase(), chars.as_str(), if single { "?" } else { "" }),
        None => String::new(),
    }
}

/// An effect's description as the engine wrote it, with the card's name for "~" and without the
/// ability's cost ("[+1]: Exile the top card…" reads "Exile the top card…").
fn effect_text(vs: &GameState, source: &ObjectId, text: &str) -> String {
    let named = crate::ability_text(text, &Match::name_in(vs, source));
    match named.split_once(": ") {
        Some((cost, rest)) if cost.chars().all(|c| matches!(c, '+' | '−' | '-' | '0'..='9' | 'X')) => rest.to_string(),
        _ => named,
    }
}

/// The range of a named choice whose options are every whole number from one to another.
fn number_range(options: &[String]) -> Option<(usize, usize)> {
    let numbers: Vec<usize> = options.iter().map(|o| o.parse().ok()).collect::<Option<_>>()?;
    let (min, max) = (*numbers.iter().min()?, *numbers.iter().max()?);
    (numbers.len() == max - min + 1 && numbers.iter().collect::<std::collections::HashSet<_>>().len() == numbers.len()).then_some((min, max))
}

/// What a named choice names, in words: "card name", "creature type".
fn choice_type_name(value: &Value) -> Option<String> {
    let raw = value.as_str().or_else(|| value.get("type").and_then(Value::as_str))?;
    Some(humanize_identifier(raw).to_lowercase())
}

/// An unless-cost in words: its printed form, else phase's own description of it.
fn unless_cost_text(vs: &GameState, cost: &AbilityCost) -> String {
    let printed = cost_text(cost);
    if !printed.is_empty() {
        return printed;
    }
    serde_json::to_value(cost).map(|v| phase_llm::render::action::describe_tagged(vs, &v)).unwrap_or_else(|_| "the cost".into())
}

/// "A", "A and B", "A, B and C".
fn and_list(names: &[String]) -> String {
    match names {
        [] => "nothing".into(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Crew or saddle (CR 702.122a, 702.171a): pick creatures to tap whose power, as the engine
/// counts it for this, adds up to `need`.
fn tap_for(vs: &GameState, answer: Answer, purpose: &'static str, source: ObjectId, need: u32, eligible: &[ObjectId], contributions: &[i32]) -> Pending {
    let name = Match::name_in(vs, &source);
    let mut options = cards(vs, eligible);
    for (i, o) in options.iter_mut().enumerate() {
        // Older states carry no contributions; the creature's power is the printed default.
        o.power = contributions.get(i).copied().or_else(|| vs.objects.get(&eligible[i]).and_then(|c| c.power));
    }
    let verb = if purpose == "crew" { "Crew" } else { "Saddle" };
    let n = options.len();
    let mut p = Pending::new(Kind::Pick, answer, purpose, format!("{verb} {name}: tap creatures with total power {need} or more"), options)
        .range(usize::from(need > 0), n, true)
        .from(vs, Some(source));
    p.need = Some(need);
    p
}

/// A split from an engine answer, as the design's `defaultAnswer`: `{id: amount}`.
fn split_answer(parts: impl IntoIterator<Item = (String, u32)>) -> Value {
    Value::Object(parts.into_iter().map(|(id, n)| (id, json!(n))).collect())
}

impl Pending {
    /// `me`'s current decision, read from `vs` (the game as `me` may see it). `candidates` is the
    /// engine's own option list for it, whose first answer of a kind is the engine's default.
    /// `names` are the seats' display names, for options that are players. `None` when the
    /// decision isn't one Yama describes yet; the index buttons answer it.
    pub fn of(vs: &GameState, me: PlayerId, candidates: &[GameAction], names: &[String]) -> Option<Pending> {
        let first = |pick: fn(&GameAction) -> bool| candidates.iter().find(|a| pick(a));
        let pending = match &vs.waiting_for {
            WaitingFor::MulliganDecision { pending, .. } => {
                // Keep or mulligan is answered with the buttons (`Decision::mulligan` sizes them);
                // the cards owed to the bottom afterwards are a pick.
                let entry = pending.iter().find(|e| e.player == me)?;
                let MulliganDecisionPhase::BottomCards { count: n, .. } = entry.phase else { return None };
                let hand: Vec<ObjectId> = vs.players.iter().find(|p| p.id == me).map(|p| p.hand.iter().copied().collect()).unwrap_or_default();
                let n = usize::from(n);
                let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "bottom", format!("Put {} on the bottom of your library", count(n, "card", "cards")), cards(vs, &hand))
                    .range(n, n, false);
                p.destination = Some("bottom");
                p
            }
            WaitingFor::ScryChoice { player, cards: ids } if *player == me => {
                // The answer is the cards kept on top, in order; the rest go to the bottom.
                let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "scry", format!("Scry {}", ids.len()), cards(vs, ids)).range(0, ids.len(), true);
                p.destination = Some("top");
                p.ordered = true;
                p
            }
            WaitingFor::SurveilChoice { player, cards: ids } if *player == me => {
                // The answer is the cards kept on top, in order; the rest go to the graveyard.
                let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "surveil", format!("Surveil {}", ids.len()), cards(vs, ids)).range(0, ids.len(), true);
                p.destination = Some("top");
                p.ordered = true;
                p
            }
            WaitingFor::SearchChoice { player, cards: ids, count: n, up_to, allows_partial_find, .. } if *player == me => {
                let free = *up_to || *allows_partial_find;
                let what = if free { format!("up to {}", count(*n, "card", "cards")) } else { count(*n, "card", "cards") };
                Pending::new(Kind::Pick, Answer::SelectCards, "search", format!("Search your library for {what}"), cards(vs, ids)).range(if free { 0 } else { *n }, *n, free)
            }
            WaitingFor::DigChoice { player, cards: ids, keep_count, up_to, selectable_cards, source_id, .. } if *player == me => {
                let shown = ids.iter().map(|id| card(vs, id, selectable_cards.is_empty() || selectable_cards.contains(id))).collect();
                let what = if *up_to { format!("up to {}", keep_count) } else { keep_count.to_string() };
                Pending::new(Kind::Pick, Answer::SelectCards, "dig", format!("Choose {what} of these cards"), shown)
                    .range(if *up_to { 0 } else { *keep_count }, *keep_count, *up_to)
                    .from(vs, *source_id)
            }
            WaitingFor::DiscardToHandSize { player, count: n, cards: ids } if *player == me => {
                Pending::new(Kind::Pick, Answer::SelectCards, "discard", format!("Discard {} down to your hand size", count(*n, "card", "cards")), cards(vs, ids)).range(*n, *n, false)
            }
            WaitingFor::DiscardChoice { player, count: n, cards: ids, source_id, up_to, unless_filter: None, .. } if *player == me => {
                let what = if *up_to { format!("up to {}", count(*n, "card", "cards")) } else { count(*n, "card", "cards") };
                Pending::new(Kind::Pick, Answer::SelectCards, "discard", format!("Discard {what}"), cards(vs, ids))
                    .range(if *up_to { 0 } else { *n }, *n, *up_to)
                    .from(vs, Some(*source_id))
            }
            WaitingFor::EffectZoneChoice { player, cards: ids, count: n, min_count, up_to, source_id, .. } if *player == me => {
                let what = if *up_to { format!("up to {}", count(*n, "card", "cards")) } else { count(*n, "card", "cards") };
                Pending::new(Kind::Pick, Answer::SelectCards, "choose", format!("Choose {what}"), cards(vs, ids))
                    .range(if *up_to { *min_count } else { *n }, *n, *up_to)
                    .from(vs, Some(*source_id))
            }
            WaitingFor::ChooseFromZoneChoice { player, cards: ids, count: n, up_to, source_id, constraint: None, .. } if *player == me => {
                let what = if *up_to { format!("up to {}", count(*n, "card", "cards")) } else { count(*n, "card", "cards") };
                Pending::new(Kind::Pick, Answer::SelectCards, "choose", format!("Choose {what}"), cards(vs, ids))
                    .range(if *up_to { 0 } else { *n }, *n, *up_to)
                    .from(vs, Some(*source_id))
            }
            WaitingFor::OrderTriggers { player, triggers } if *player == me => {
                let options = triggers
                    .iter()
                    .enumerate()
                    .map(|(i, t)| {
                        let mut c = card(vs, &t.source_id, true);
                        c.id = i.to_string();
                        c.name = one_line(&t.source_name);
                        c.text = Some(effect_text(vs, &t.source_id, &t.description));
                        c
                    })
                    .collect();
                let mut p = Pending::new(Kind::Order, Answer::OrderTriggers, "triggers", "Put your triggers in order", options);
                p.min = triggers.len();
                p.max = triggers.len();
                p.default_answer = first(|a| matches!(a, GameAction::OrderTriggers { .. })).map(|a| match a {
                    GameAction::OrderTriggers { order } => json!(order.iter().map(|i| i.to_string()).collect::<Vec<_>>()),
                    _ => Value::Null,
                });
                p
            }
            WaitingFor::ModeChoice { player, modal, pending_cast, unavailable_modes } if *player == me && modal.mode_pawprints.is_empty() => {
                modes(vs, modal, unavailable_modes, Some(pending_cast.object_id))
            }
            WaitingFor::AbilityModeChoice { player, modal, unavailable_modes, source_id, .. } if *player == me && modal.mode_pawprints.is_empty() => {
                modes(vs, modal, unavailable_modes, Some(*source_id))
            }
            WaitingFor::ChooseXValue { player, min, max, pending_cast, x_cost_previews, .. } if *player == me => {
                let mut p = Pending::new(Kind::Number, Answer::ChooseX, "x", "Choose X", vec![]).from(vs, Some(pending_cast.object_id));
                p.min = *min as usize;
                p.max = *max as usize;
                p.previews = x_cost_previews.iter().map(|(x, cost)| (*x, mana_cost_text(cost))).collect();
                p
            }
            WaitingFor::TargetSelection { player, target_slots, mode_labels, selection, .. }
            | WaitingFor::TriggerTargetSelection { player, target_slots, mode_labels, selection, .. }
                if *player == me =>
            {
                let slot = selection.current_slot;
                let optional = target_slots.get(slot).is_some_and(|s| s.optional);
                let options = selection.current_legal_targets.iter().map(|t| target(vs, t, names)).collect();
                let mode = mode_labels.get(slot).cloned().flatten();
                let prompt = match (target_slots.len(), mode) {
                    (n, Some(mode)) if n > 1 => format!("Choose target {} of {n}: {}", slot + 1, one_line(&mode)),
                    (n, None) if n > 1 => format!("Choose target {} of {n}", slot + 1),
                    (_, Some(mode)) => format!("Choose a target: {}", one_line(&mode)),
                    _ => "Choose a target".to_string(),
                };
                let source = match &vs.waiting_for {
                    WaitingFor::TargetSelection { pending_cast, .. } => Some(pending_cast.object_id),
                    WaitingFor::TriggerTargetSelection { source_id, .. } => *source_id,
                    _ => None,
                };
                let mut p = Pending::new(Kind::Pick, Answer::ChooseTarget, "target", prompt, options).range(if optional { 0 } else { 1 }, 1, optional).from(vs, source);
                p.zone = common_zone(&p.options);
                p.slot = (target_slots.len() > 1).then_some((slot, target_slots.len()));
                p.picked = selection.selected_slots.iter().flatten().map(|t| target_id(&TargetView::from_ref(t))).collect();
                p
            }
            WaitingFor::MultiTargetSelection { player, legal_targets, min_targets, max_targets, pending_ability } if *player == me => {
                // "Any number of target creatures you control" (CR 601.2c, 115.1d).
                let n = legal_targets.len();
                let prompt = match (*min_targets, *max_targets) {
                    (0, m) if m >= n => "Choose any number of targets".to_string(),
                    (0, m) => format!("Choose up to {}", count(m, "target", "targets")),
                    (a, b) if a == b => format!("Choose {}", count(a, "target", "targets")),
                    (a, b) => format!("Choose {a} to {b} targets"),
                };
                Pending::new(Kind::Pick, Answer::SelectCards, "targets", prompt, cards(vs, legal_targets))
                    .range(*min_targets, *max_targets, min_targets < max_targets)
                    .from(vs, Some(pending_ability.source_id))
            }
            WaitingFor::CopyRetarget { player, copy_id, target_slots, current_slot, can_keep_rest, announcer_election: None, .. } if *player == me => {
                // A copy's targets, one at a time (CR 707.10c): any of the engine's alternatives, or
                // the one it has now, where keeping it is allowed (or none, where it may decline).
                let slot = target_slots.get(*current_slot)?;
                let mut options: Vec<Choice> = slot.legal_alternatives.iter().map(|t| target(vs, t, names)).collect();
                let current = slot.current.as_ref().map(|t| target_id(&TargetView::from_ref(t)));
                let mut keeps_current = false;
                if let (Some(cur), Some(id)) = (&slot.current, &current)
                    && !options.iter().any(|o| &o.id == id)
                {
                    let mut c = target(vs, cur, names);
                    c.eligible = slot.can_keep;
                    options.push(c);
                    keeps_current = true;
                }
                let name = Match::name_in(vs, copy_id);
                let what = if current.is_some() { "a new target" } else { "a target" };
                let mut prompt = format!("Choose {what} for the copy of {name}");
                if target_slots.len() > 1 {
                    prompt.push_str(&format!(" ({} of {})", current_slot + 1, target_slots.len()));
                }
                let optional = slot.can_decline && slot.current.is_none();
                let mut p = Pending::new(Kind::Pick, Answer::ChooseTarget, "copy", prompt, options).range(if optional { 0 } else { 1 }, 1, optional).from(vs, Some(*copy_id));
                p.zone = common_zone(&p.options);
                p.default_answer = current.clone().filter(|_| slot.can_keep).map(|c| json!([c]));
                p.current = current;
                p.keeps_current = keeps_current;
                p.keep_rest = *can_keep_rest;
                p.slot = (target_slots.len() > 1).then_some((*current_slot, target_slots.len()));
                p
            }
            WaitingFor::RetargetChoice { player, stack_entry_index, scope, current_targets, slot_pools, legal_new_targets, .. } if *player == me => {
                // One target to change (CR 115.7a). A spell with several targets to change, or one
                // the engine sends to a fixed new target, keeps the buttons.
                if current_targets.len() != 1 || matches!(scope, RetargetScope::ForcedTo(_)) {
                    return None;
                }
                let pool = if slot_pools.is_empty() { legal_new_targets.as_slice() } else { slot_pools[0].as_slice() };
                let mut options: Vec<Choice> = pool.iter().map(|t| target(vs, t, names)).collect();
                let current = target_id(&TargetView::from_ref(&current_targets[0]));
                let in_pool = options.iter().any(|o| o.id == current);
                if !in_pool {
                    let mut c = target(vs, &current_targets[0], names);
                    c.eligible = false;
                    options.push(c);
                }
                let entry = vs.stack.get(*stack_entry_index);
                let spell = entry.map(|e| Match::name_in(vs, &e.source_id)).unwrap_or_else(|| "the spell".into());
                let whose = match entry.map(|e| e.controller) {
                    Some(c) if c == me => "your".to_string(),
                    Some(c) => format!("{}'s", names.get(usize::from(c.0)).cloned().unwrap_or_else(|| format!("Player {}", c.0 + 1))),
                    None => "the".to_string(),
                };
                let mut p = Pending::new(Kind::Pick, Answer::RetargetSpell, "retarget", format!("Choose a new target for {whose} {spell}"), options)
                    .range(1, 1, false)
                    .from(vs, entry.map(|e| e.source_id));
                p.zone = common_zone(&p.options);
                p.default_answer = in_pool.then(|| json!([current.clone()]));
                p.current = Some(current);
                p
            }
            WaitingFor::CombatTaxPayment { player, context, total_cost, per_creature, .. } if *player == me => {
                // Propaganda, Ghostly Prison: the total for the creatures declared (CR 508.1d).
                let cost = mana_cost_text(total_cost);
                let who: Vec<String> = per_creature.iter().map(|(id, _)| Match::name_in(vs, id)).collect();
                let verb = match context {
                    CombatTaxContext::Attacking => "attack",
                    CombatTaxContext::Blocking => "block",
                };
                Pending::new(Kind::Yesno, Answer::PayCombatTax, "tax", format!("Pay {cost} to {verb} with {}?", and_list(&who)), vec![])
                    .yes_no(format!("Pay {cost}"), "Don't pay")
            }
            WaitingFor::ExertChoice { player, attacker, .. } if *player == me => {
                let name = Match::name_in(vs, attacker);
                Pending::new(Kind::Yesno, Answer::ChooseExert, "exert", format!("Exert {name} as it attacks?"), vec![])
                    .yes_no("Exert", "Don't exert")
                    .from(vs, Some(*attacker))
            }
            WaitingFor::EnlistChoice { player, attacker, eligible, .. } if *player == me => {
                let name = Match::name_in(vs, attacker);
                Pending::new(Kind::Pick, Answer::ChooseEnlist, "enlist", format!("Tap a creature to enlist for {name}?"), cards(vs, eligible))
                    .range(0, 1, true)
                    .from(vs, Some(*attacker))
            }
            WaitingFor::CrewVehicle { player, vehicle_id, crew_power, eligible_creatures, contributions } if *player == me => {
                tap_for(vs, Answer::CrewVehicle, "crew", *vehicle_id, *crew_power, eligible_creatures, contributions)
            }
            WaitingFor::SaddleMount { player, mount_id, saddle_power, eligible_creatures, contributions } if *player == me => {
                tap_for(vs, Answer::SaddleMount, "saddle", *mount_id, *saddle_power, eligible_creatures, contributions)
            }
            WaitingFor::UnlessPayment { player, cost, effect_description, pending_effect, .. } if *player == me => {
                let cost = unless_cost_text(vs, cost);
                let prompt = match effect_description {
                    Some(effect) => format!("Pay {cost}? If you don't: {}", one_line(effect)),
                    None => format!("Pay {cost}?"),
                };
                // The card asking (Rhystic Study, Mana Leak) is the source of the effect it holds back.
                Pending::new(Kind::Yesno, Answer::PayUnlessCost, "pay", prompt, vec![])
                    .yes_no(format!("Pay {cost}"), "Don't pay")
                    .from(vs, Some(pending_effect.source_id))
            }
            WaitingFor::OptionalEffectChoice { player, source_id, description, may_trigger_key, same_card_may_trigger_choice_available, .. }
                if *player == me =>
            {
                let prompt = description.as_deref().map(|d| question(&effect_text(vs, source_id, d))).unwrap_or_else(|| "Do it?".into());
                let mut p = Pending::new(Kind::Yesno, Answer::DecideOptionalEffect, "may", prompt, vec![])
                    .yes_no("Yes", "No")
                    .from(vs, Some(*source_id));
                // The engine can remember this answer for this card (DecideOptionalEffectAndRemember).
                p.remember = may_trigger_key.is_some().then_some("engine");
                p.remember_same_card = may_trigger_key.is_some() && *same_card_may_trigger_choice_available;
                p
            }
            WaitingFor::OpponentMayChoice { player, source_id, description, .. } if *player == me => {
                let prompt = description.as_deref().map(|d| question(&effect_text(vs, source_id, d))).unwrap_or_else(|| "Do it?".into());
                Pending::new(Kind::Yesno, Answer::DecideOptionalEffect, "may", prompt, vec![])
                    .yes_no("Yes", "No")
                    .from(vs, Some(*source_id))
            }
            WaitingFor::NamedChoice { player, choice_type, options, free_entry, source, .. } if *player == me => {
                let what = serde_json::to_value(choice_type).ok().as_ref().and_then(choice_type_name).unwrap_or_else(|| "option".into());
                // The card asking, as the engine names it ("As ~ enters, choose a card name"); it may
                // not be on the battlefield yet, so it comes from the prompt's own binding.
                let asking = source.as_ref().map(|s| Source {
                    id: s.prompt.identity.reference.object_id.0,
                    name: s.prompt.display_name.clone(),
                    controller: s.prompt.controller.0,
                    art: None,
                    image: None,
                    artist: None,
                });
                let mut p = match free_entry {
                    // A number in a range: answered with its digits.
                    Some(FreeEntry::Number { min, max }) => {
                        let mut p = Pending::new(Kind::Number, Answer::ChooseOption, "name", format!("Choose a number from {min} to {max}"), vec![]);
                        p.min = *min as usize;
                        p.max = *max as usize;
                        p.choice_type = Some(what);
                        p
                    }
                    // A list of consecutive numbers ("choose a number between 0 and 10") is a number too.
                    None if let Some((min, max)) = number_range(options) => {
                        let mut p = Pending::new(Kind::Number, Answer::ChooseOption, "name", format!("Choose a number from {min} to {max}"), vec![]);
                        p.min = min;
                        p.max = max;
                        p.choice_type = Some(what);
                        p
                    }
                    None => {
                        let mut p = Pending::new(Kind::Text, Answer::ChooseOption, "name", format!("Choose a {what}"), options.iter().map(|o| word(o.clone(), o.clone())).collect());
                        p.min = 1;
                        p.max = 1;
                        // No list (a card name): any word, checked by the engine.
                        p.free_entry = Some(options.is_empty());
                        p.choice_type = Some(what);
                        p
                    }
                };
                p.source = asking;
                p
            }
            WaitingFor::ReplacementChoice { player, candidates: items, kind, remember_identity, .. } if *player == me => {
                let options: Vec<Choice> = items
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let mut o = card(vs, &c.source_id, true);
                        o.id = i.to_string();
                        o.name = one_line(&c.source_name);
                        o.text = Some(effect_text(vs, &c.source_id, &c.description));
                        o
                    })
                    .collect();
                let mut p = if matches!(kind, ReplacementChoiceKind::OptionalBranch) {
                    // One "you may" replacement: index 0 accepts, 1 declines.
                    let text = options.first().and_then(|o| o.text.clone()).unwrap_or_default();
                    let source = items.first().map(|c| c.source_id);
                    let mut p = Pending::new(Kind::Yesno, Answer::ChooseReplacement, "replacement", question(&text), options).yes_no("Yes", "No").from(vs, source);
                    p.min = 1;
                    p.max = 1;
                    p
                } else {
                    Pending::new(Kind::Pick, Answer::ChooseReplacement, "replacement", "Choose which effect applies first", options)
                };
                // The engine offers to remember the order or the answer (ChooseReplacementAndRemember).
                p.remember = remember_identity.is_some().then_some("engine");
                p
            }
            WaitingFor::AssignCombatDamage { player, attacker_id, total_damage, blockers, trample, defending_player, assignment_modes, .. } if *player == me => {
                let mut options: Vec<Choice> = blockers
                    .iter()
                    .map(|b| {
                        let mut c = card(vs, &b.blocker_id, true);
                        c.lethal = Some(b.lethal_minimum);
                        c
                    })
                    .collect();
                if trample.is_some() {
                    options.push(player_choice(*defending_player, names));
                }
                let mut p = Pending::new(Kind::Split, Answer::AssignCombatDamage, "damage", format!("Assign {total_damage} combat damage"), options).from(vs, Some(*attacker_id));
                p.min = 0;
                p.max = *total_damage as usize;
                p.total = Some(*total_damage);
                p.per_option_min = Some(0);
                p.unblocked = assignment_modes.contains(&CombatDamageAssignmentMode::AsThoughUnblocked);
                p.unit = Some("damage");
                let defender = format!("p{}", defending_player.0);
                p.default_answer = first(|a| matches!(a, GameAction::AssignCombatDamage { mode: CombatDamageAssignmentMode::Normal, .. })).map(|a| match a {
                    GameAction::AssignCombatDamage { assignments, trample_damage, .. } => split_answer(
                        assignments.iter().map(|(id, n)| (id.0.to_string(), *n)).chain((*trample_damage > 0).then(|| (defender.clone(), *trample_damage))),
                    ),
                    _ => Value::Null,
                });
                p
            }
            WaitingFor::DistributeAmong { player, total, targets, unit } if *player == me => {
                let (unit_name, unit_kind) = match unit {
                    DistributionUnit::Damage | DistributionUnit::EvenSplitDamage => ("damage".to_string(), "damage"),
                    DistributionUnit::Counters(kind) => (format!("{} counters", one_line(kind).to_lowercase()), "counters"),
                    DistributionUnit::Life => ("life".to_string(), "life"),
                };
                let options = targets.iter().map(|t| target(vs, t, names)).collect();
                let mut p = Pending::new(Kind::Split, Answer::DistributeAmong, "divide", format!("Divide {total} {unit_name}"), options).from(vs, vs.pending_cast.as_ref().map(|c| c.object_id));
                p.min = 0;
                p.max = *total as usize;
                p.total = Some(*total);
                p.unit = Some(unit_kind);
                // CR 601.2d: each target gets at least one.
                p.per_option_min = Some(1);
                p.default_answer = first(|a| matches!(a, GameAction::DistributeAmong { .. })).map(|a| match a {
                    GameAction::DistributeAmong { distribution } => split_answer(distribution.iter().map(|(t, n)| (target_id(&TargetView::from_ref(t)), *n))),
                    _ => Value::Null,
                });
                p
            }
            WaitingFor::PairChoice { player, source_id, choices } if *player == me => {
                // Soulbond (CR 702.95a): pair the source with one of these, or with none.
                let name = Match::name_in(vs, source_id);
                Pending::new(Kind::Pair, Answer::ChoosePair, "pair", format!("Pair {name} with another creature?"), cards(vs, choices))
                    .range(0, 1, true)
                    .from(vs, Some(*source_id))
            }
            WaitingFor::RevealUntilBottomOrder { player, source_id, cards: ids, .. } | WaitingFor::RippleBottomOrder { player, source_id, cards: ids, .. }
                if *player == me =>
            {
                // The whole pile, in the order it goes to the bottom: the first is the highest of
                // them, the last the very bottom (CR 401.4).
                let mut p = Pending::new(Kind::Order, Answer::SelectCards, "order", "Put these on the bottom, in order", cards(vs, ids)).from(vs, Some(*source_id));
                p.min = ids.len();
                p.max = ids.len();
                p.destination = Some("bottom");
                p.ordered = true;
                p.default_answer = first(|a| matches!(a, GameAction::SelectCards { .. })).map(|a| match a {
                    GameAction::SelectCards { cards } => json!(cards.iter().map(|c| c.0.to_string()).collect::<Vec<_>>()),
                    _ => Value::Null,
                });
                p
            }
            _ => return None,
        };
        let mut pending = pending;
        if pending.zone.is_none() && pending.kind == Kind::Pick && pending.answer == Answer::SelectCards {
            pending.zone = common_zone(&pending.options);
        }
        Some(pending)
    }

    /// The card names this decision shows, for the deciding seat's card details.
    pub fn card_names(&self) -> Vec<String> {
        self.source.iter().map(|s| s.name.clone()).chain(self.options.iter().filter(|o| o.card).map(|o| o.name.clone())).collect()
    }

    fn eligible(&self, id: &str) -> bool {
        self.options.iter().any(|o| o.id == id && o.eligible)
    }

    /// Whether `act` answers this decision, in a plain sentence when it doesn't. The engine checks
    /// everything again when it applies the answer; this catches answers to some other decision
    /// and shapes the engine wouldn't take, with a reason a player can read.
    pub fn admits(&self, act: &Act) -> Result<(), String> {
        let between = |n: usize, what: (&str, &str)| -> Result<(), String> {
            if n >= self.min && n <= self.max {
                return Ok(());
            }
            Err(match (self.min, self.max) {
                (a, b) if a == b => format!("Choose exactly {}.", count(a, what.0, what.1)),
                (0, b) => format!("Choose up to {}.", count(b, what.0, what.1)),
                (a, b) => format!("Choose between {a} and {b} {}.", what.1),
            })
        };
        match (self.answer, act) {
            (Answer::SelectCards, Act::SelectCards { cards }) => {
                let mut seen = std::collections::HashSet::new();
                for id in cards {
                    if !seen.insert(*id) {
                        return Err("A card was chosen twice.".into());
                    }
                    if !self.eligible(&id.to_string()) {
                        return Err("That card isn't one of the choices.".into());
                    }
                }
                between(cards.len(), ("card", "cards"))
            }
            (Answer::OrderTriggers, Act::OrderTriggers { order }) => {
                let mut sorted = order.clone();
                sorted.sort_unstable();
                if sorted != (0..self.options.len()).collect::<Vec<_>>() {
                    return Err("Put every trigger in the order once.".into());
                }
                Ok(())
            }
            (Answer::SelectModes, Act::SelectModes { indices }) => {
                if indices.iter().any(|i| !self.eligible(&i.to_string())) {
                    return Err("That mode can't be chosen.".into());
                }
                let mut seen = std::collections::HashSet::new();
                if !self.repeat && !indices.iter().all(|i| seen.insert(*i)) {
                    return Err("Each mode can be chosen only once.".into());
                }
                between(indices.len(), ("mode", "modes"))
            }
            (Answer::ChooseX, Act::ChooseX { value }) => {
                let v = *value as usize;
                if v < self.min || v > self.max {
                    return Err(format!("X must be between {} and {}.", self.min, self.max));
                }
                Ok(())
            }
            (Answer::ChooseTarget, Act::ChooseTarget { target }) => match target {
                None if self.min == 0 => Ok(()),
                None => Err("This needs a target.".into()),
                Some(t) if self.eligible(&target_id(t)) => Ok(()),
                Some(_) => Err("That isn't a legal target.".into()),
            },
            (Answer::PayUnlessCost, Act::PayUnlessCost { .. }) => Ok(()),
            (Answer::DecideOptionalEffect, Act::DecideOptionalEffect { .. }) => Ok(()),
            (Answer::DecideOptionalEffect, Act::DecideOptionalEffectAndRemember { same_card, .. }) => {
                if self.remember != Some("engine") {
                    return Err("This answer can't be remembered.".into());
                }
                if *same_card && !self.remember_same_card {
                    return Err("This answer can be remembered only for this card.".into());
                }
                Ok(())
            }
            (Answer::ChooseOption, Act::ChooseOption { choice }) => {
                let ok = match self.kind {
                    Kind::Number => choice.parse::<usize>().is_ok_and(|n| n >= self.min && n <= self.max),
                    _ if self.free_entry == Some(true) => !choice.trim().is_empty(),
                    _ => self.eligible(choice),
                };
                if ok { Ok(()) } else { Err("That isn't one of the choices.".into()) }
            }
            (Answer::ChooseReplacement, Act::ChooseReplacement { index }) => {
                if *index < self.options.len() { Ok(()) } else { Err("That isn't one of the choices.".into()) }
            }
            (Answer::ChooseReplacement, Act::ChooseReplacementAndRemember { choice }) => {
                if self.remember != Some("engine") {
                    return Err("This answer can't be remembered.".into());
                }
                match (self.kind, choice) {
                    // A "you may" replacement: 0 accepts, 1 declines.
                    (Kind::Yesno, RememberedReplacement::Optional { index }) if *index < 2 => Ok(()),
                    // Effects in order: every one of them, once.
                    (Kind::Pick, RememberedReplacement::Order { order }) => {
                        let mut sorted = order.clone();
                        sorted.sort_unstable();
                        if sorted == (0..self.options.len()).collect::<Vec<_>>() { Ok(()) } else { Err("Put every effect in the order once.".into()) }
                    }
                    _ => Err("That answer doesn't fit this decision.".into()),
                }
            }
            (Answer::ChooseTarget, Act::KeepAllCopyTargets) => {
                if self.keep_rest { Ok(()) } else { Err("The copy's targets can't all be kept.".into()) }
            }
            (Answer::RetargetSpell, Act::RetargetSpell { new_targets }) => match new_targets.as_slice() {
                [Some(t)] if self.eligible(&target_id(t)) => Ok(()),
                [Some(_)] => Err("That isn't a legal target.".into()),
                _ => Err("Choose one new target.".into()),
            },
            (Answer::PayCombatTax, Act::PayCombatTax { .. }) => Ok(()),
            (Answer::ChooseExert, Act::ChooseExert { .. }) => Ok(()),
            (Answer::ChooseEnlist, Act::ChooseEnlist { target }) => match target {
                None => Ok(()),
                Some(id) if self.eligible(&id.to_string()) => Ok(()),
                Some(_) => Err("That creature can't be tapped for enlist.".into()),
            },
            (Answer::CrewVehicle, Act::CrewVehicle { vehicle: source, creatures }) | (Answer::SaddleMount, Act::SaddleMount { mount: source, creatures }) => {
                if self.source.as_ref().is_some_and(|s| s.id != *source) {
                    return Err("That's a different card.".into());
                }
                let mut seen = std::collections::HashSet::new();
                let mut total = 0i64;
                for id in creatures {
                    if !seen.insert(*id) {
                        return Err("A creature was chosen twice.".into());
                    }
                    let Some(o) = self.options.iter().find(|o| o.id == id.to_string() && o.eligible) else {
                        return Err("That creature can't be tapped for this.".into());
                    };
                    total += i64::from(o.power.unwrap_or(0));
                }
                let need = self.need.unwrap_or(0);
                if total < i64::from(need) {
                    return Err(format!("Tap creatures with total power {need} or more."));
                }
                Ok(())
            }
            (Answer::ChoosePair, Act::ChoosePair { partner }) => match partner {
                None if self.min == 0 => Ok(()),
                None => Err("Choose a creature to pair with.".into()),
                Some(id) if self.eligible(&id.to_string()) => Ok(()),
                Some(_) => Err("That creature can't be paired with it.".into()),
            },
            (Answer::AssignCombatDamage, Act::AssignCombatDamage { assignments, trample, controller, unblocked }) => {
                if *unblocked {
                    return if self.unblocked { Ok(()) } else { Err("This damage can't be assigned as though it weren't blocked.".into()) };
                }
                if assignments.iter().any(|(id, _)| !self.options.iter().any(|o| o.id == id.to_string() && o.lethal.is_some())) {
                    return Err("Damage can only go to the creatures blocking it.".into());
                }
                let sum: u32 = assignments.iter().map(|(_, n)| n).sum::<u32>() + trample + controller;
                match self.total {
                    Some(total) if sum != total => Err(format!("Assign all {total} damage.")),
                    _ => Ok(()),
                }
            }
            (Answer::DistributeAmong, Act::DistributeAmong { distribution }) => {
                if distribution.iter().any(|(t, _)| !self.eligible(&target_id(t))) {
                    return Err("That isn't one of the targets.".into());
                }
                let sum: u32 = distribution.iter().map(|(_, n)| n).sum();
                match self.total {
                    Some(total) if sum != total => Err(format!("Divide all {total}.")),
                    _ => Ok(()),
                }
            }
            _ => Err("That answer doesn't fit this decision.".into()),
        }
    }
}

impl Pending {
    /// The answer as the engine takes it: picking a copy's current target where it isn't one of
    /// the engine's alternatives keeps it (`None`, CR 707.10c).
    pub fn normalize(&self, act: &Act) -> Act {
        match act {
            Act::ChooseTarget { target: Some(t) } if self.keeps_current && self.current.as_deref() == Some(target_id(t).as_str()) => {
                Act::ChooseTarget { target: None }
            }
            other => other.clone(),
        }
    }
}

/// The modes question in the words cards use (CR 700.2): "Choose one", "Choose one or both",
/// "Choose one or more", "Choose up to two".
fn modes_prompt(min: usize, max: usize, count: usize) -> String {
    let word = |n: usize| match n {
        1 => "one".to_string(),
        2 => "two".into(),
        3 => "three".into(),
        4 => "four".into(),
        5 => "five".into(),
        n => n.to_string(),
    };
    match (min, max) {
        (a, b) if a == b => format!("Choose {}", word(a)),
        (1, 2) if count == 2 => "Choose one or both".into(),
        (1, b) if b >= count => "Choose one or more".into(),
        (0, b) => format!("Choose up to {}", word(b)),
        (a, b) => format!("Choose {} to {}", word(a), word(b)),
    }
}

/// Choose modes of a modal spell or ability, from the engine's own mode descriptions.
fn modes(vs: &GameState, modal: &engine::types::ability::ModalChoice, unavailable: &[usize], source: Option<ObjectId>) -> Pending {
    // The engine's mode text is the card's Oracle bullet text, with "~" for the card's name.
    let name = source.map(|id| Match::name_in(vs, &id));
    let options = (0..modal.mode_count)
        .map(|i| {
            let text = modal.mode_descriptions.get(i).map(|d| match &name {
                Some(name) => crate::ability_text(d, name),
                None => one_line(d),
            });
            let mut c = word(i.to_string(), text.unwrap_or_else(|| format!("Mode {}", i + 1)));
            c.eligible = !unavailable.contains(&i);
            c
        })
        .collect();
    let mut p = Pending::new(Kind::Pick, Answer::SelectModes, "modes", modes_prompt(modal.min_choices, modal.max_choices, modal.mode_count), options).from(vs, source);
    p.repeat = modal.allow_repeat_modes;
    // Repeatable modes may be chosen more often than there are modes, so no cap by count.
    p.min = modal.min_choices;
    p.max = modal.max_choices;
    p.up_to = modal.min_choices < modal.max_choices;
    p
}

/// An answer a person may send (the client's `act` message). Only these engine actions can be
/// spelled; everything else goes through the index buttons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Act {
    SelectCards {
        cards: Vec<u64>,
    },
    OrderTriggers {
        order: Vec<usize>,
    },
    SelectModes {
        indices: Vec<usize>,
    },
    ChooseX {
        value: u32,
    },
    ChooseTarget {
        target: Option<TargetView>,
    },
    CancelCast,
    PayUnlessCost {
        pay: bool,
    },
    DecideOptionalEffect {
        accept: bool,
    },
    ChooseOption {
        choice: String,
    },
    ChooseReplacement {
        index: usize,
    },
    AssignCombatDamage {
        assignments: Vec<(u64, u32)>,
        #[serde(default)]
        trample: u32,
        /// Damage to a planeswalker's controller (trample over planeswalkers).
        #[serde(default)]
        controller: u32,
        /// Assign it all as though it weren't blocked, where the engine allows that.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        unblocked: bool,
    },
    DistributeAmong {
        distribution: Vec<(TargetView, u32)>,
    },
    /// Answer a "may" and have the engine give the same answer from now on, for this card
    /// (or, with `same_card`, every copy of it) for the rest of the game.
    DecideOptionalEffectAndRemember {
        accept: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        same_card: bool,
    },
    /// Choose among replacement effects and have the engine use the same choice whenever the
    /// same effects apply to the same kind of event.
    ChooseReplacementAndRemember {
        choice: RememberedReplacement,
    },
    /// Soulbond: the creature to pair with, or none.
    ChoosePair {
        partner: Option<u64>,
    },
    /// New targets for a spell or ability on the stack, one for each it has.
    RetargetSpell {
        new_targets: Vec<Option<TargetView>>,
    },
    /// Keep every remaining target of a copy (CR 707.10c).
    KeepAllCopyTargets,
    /// Pay an attack or block tax, or don't (the taxed creatures stay out).
    PayCombatTax {
        accept: bool,
    },
    /// Exert the attacker, or don't.
    ChooseExert {
        exert: bool,
    },
    /// The creature to tap for enlist, or none.
    ChooseEnlist {
        target: Option<u64>,
    },
    /// The creatures that crew `vehicle`.
    CrewVehicle {
        vehicle: u64,
        creatures: Vec<u64>,
    },
    /// The creatures that saddle `mount`.
    SaddleMount {
        mount: u64,
        creatures: Vec<u64>,
    },
    // The rest are a seat's own settings and table actions (GSettings, GPriority), not answers to
    // a decision: the preference ones may be sent at any time, as the engine allows.
    /// Turn off a remembered "may" answer (GSettings and GLog, "Turn off"), or all of them.
    SetMayTriggerAutoChoice {
        change: AnswerChange,
    },
    /// Forget a remembered replacement-effect choice, by the engine's id; `None` forgets all.
    SetReplacementAutoChoice {
        id: Option<String>,
    },
    /// Pass for you while a trigger is on top of the stack (CR 117.3d), or stop doing so.
    SetPriorityYield {
        change: YieldChange,
    },
    /// Put your hand in this order (CR 402.3): every card in it, once.
    ReorderHand {
        order: Vec<u64>,
    },
    /// Ask everyone to let the whole stack resolve (GTogether's consent tab). Each other player
    /// agrees or keeps priority; AI seats agree at once.
    ResolveAll,
}

/// How a trigger yield changes (`Act::SetPriorityYield`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum YieldChange {
    /// The trigger from `source` on the stack now: this one only, or `every` copy of that card
    /// (phase's `AllCopies`: the physical card and its copies, not others with the same name).
    Add { source: u64, every: bool },
    /// A yield the seat's view lists (`TurnsView::yields`), as it lists it.
    Remove { target: YieldTarget },
    ClearAll,
}

/// How remembered "may" answers change (`Act::SetMayTriggerAutoChoice`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AnswerChange {
    /// An answer the seat's view lists (`TurnsView::answers`), as it lists it.
    Remove { selector: MayTriggerAutoChoiceSelector },
    ClearAll,
}

/// A replacement choice to remember: the whole order of the effects (by index), or the branch
/// of a single "you may" replacement (0 accepts, 1 declines).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RememberedReplacement {
    Order { order: Vec<usize> },
    Optional { index: usize },
}

impl TargetView {
    pub(crate) fn from_ref(t: &TargetRef) -> Self {
        match t {
            TargetRef::Object(id) => TargetView::Object { id: id.0 },
            TargetRef::Player(p) => TargetView::Player { seat: p.0 },
        }
    }
    fn to_ref(&self) -> TargetRef {
        match self {
            TargetView::Object { id } => TargetRef::Object(ObjectId(*id)),
            TargetView::Player { seat } => TargetRef::Player(PlayerId(*seat)),
        }
    }
}

impl Act {
    /// The engine action this answer stands for.
    pub fn to_action(&self) -> GameAction {
        match self {
            Act::SelectCards { cards } => GameAction::SelectCards { cards: cards.iter().map(|c| ObjectId(*c)).collect() },
            Act::OrderTriggers { order } => GameAction::OrderTriggers { order: order.clone() },
            Act::SelectModes { indices } => GameAction::SelectModes { indices: indices.clone() },
            Act::ChooseX { value } => GameAction::ChooseX { value: *value },
            Act::ChooseTarget { target } => GameAction::ChooseTarget { target: target.as_ref().map(TargetView::to_ref) },
            Act::CancelCast => GameAction::CancelCast,
            Act::PayUnlessCost { pay } => GameAction::PayUnlessCost { pay: *pay },
            Act::DecideOptionalEffect { accept } => GameAction::DecideOptionalEffect { accept: *accept },
            Act::ChooseOption { choice } => GameAction::ChooseOption { choice: choice.clone() },
            Act::ChooseReplacement { index } => GameAction::ChooseReplacement { index: *index },
            Act::AssignCombatDamage { assignments, trample, controller, unblocked } => GameAction::AssignCombatDamage {
                mode: if *unblocked { CombatDamageAssignmentMode::AsThoughUnblocked } else { CombatDamageAssignmentMode::Normal },
                assignments: assignments.iter().map(|(id, n)| (ObjectId(*id), *n)).collect(),
                trample_damage: *trample,
                controller_damage: *controller,
            },
            Act::DistributeAmong { distribution } => {
                GameAction::DistributeAmong { distribution: distribution.iter().map(|(t, n)| (t.to_ref(), *n)).collect() }
            }
            Act::DecideOptionalEffectAndRemember { accept, same_card } => GameAction::DecideOptionalEffectAndRemember {
                choice: if *accept { AutoMayChoice::Accept } else { AutoMayChoice::Decline },
                scope: if *same_card { MayTriggerAutoChoiceScope::SameCard } else { MayTriggerAutoChoiceScope::ExactInstance },
            },
            Act::ChooseReplacementAndRemember { choice } => GameAction::ChooseReplacementAndRemember {
                choice: match choice {
                    RememberedReplacement::Order { order } => ReplacementAutoChoice::Order { order: order.clone() },
                    RememberedReplacement::Optional { index } => ReplacementAutoChoice::Optional { index: *index },
                },
            },
            Act::ChoosePair { partner } => GameAction::ChoosePair { partner: partner.map(ObjectId) },
            Act::RetargetSpell { new_targets } => GameAction::RetargetSpell { new_targets: new_targets.iter().map(|t| t.as_ref().map(TargetView::to_ref)).collect() },
            Act::KeepAllCopyTargets => GameAction::KeepAllCopyTargets,
            Act::PayCombatTax { accept } => GameAction::PayCombatTax { accept: *accept },
            Act::ChooseExert { exert } => GameAction::ChooseExert { exert: *exert },
            Act::ChooseEnlist { target } => GameAction::ChooseEnlist { target: target.map(ObjectId) },
            Act::CrewVehicle { vehicle, creatures } => GameAction::CrewVehicle { vehicle_id: ObjectId(*vehicle), creature_ids: creatures.iter().map(|c| ObjectId(*c)).collect() },
            Act::SaddleMount { mount, creatures } => GameAction::SaddleMount { mount_id: ObjectId(*mount), creature_ids: creatures.iter().map(|c| ObjectId(*c)).collect() },
            Act::SetMayTriggerAutoChoice { change } => GameAction::SetMayTriggerAutoChoice {
                op: match change {
                    AnswerChange::Remove { selector } => MayTriggerAutoChoiceOp::Remove { selector: selector.clone() },
                    AnswerChange::ClearAll => MayTriggerAutoChoiceOp::ClearAll,
                },
            },
            Act::SetReplacementAutoChoice { id } => GameAction::SetReplacementAutoChoice { selector: id.clone().map(ReplacementAutoChoiceId) },
            Act::SetPriorityYield { change } => GameAction::SetPriorityYield {
                op: match change {
                    YieldChange::Add { source, every } => PriorityYieldOp::Add {
                        source_id: ObjectId(*source),
                        scope: if *every { YieldScope::AllCopies } else { YieldScope::ThisObject },
                    },
                    YieldChange::Remove { target } => PriorityYieldOp::Remove { target: target.clone() },
                    YieldChange::ClearAll => PriorityYieldOp::ClearAll,
                },
            },
            Act::ReorderHand { order } => GameAction::ReorderHand { order: order.iter().map(|c| ObjectId(*c)).collect() },
            // No cap on how much resolves (phase's 0); the table-wide form, which asks everyone.
            Act::ResolveAll => GameAction::BeginResolveAll { max_resolutions: 0, scope: ResolveAllScope::Shared },
        }
    }

    /// A seat's own setting, which the engine takes in any state from that seat (it changes
    /// nothing of anyone else's): not an answer to the seat's decision.
    pub fn is_preference(&self) -> bool {
        matches!(
            self,
            Act::SetMayTriggerAutoChoice { .. } | Act::SetReplacementAutoChoice { .. } | Act::SetPriorityYield { .. } | Act::ReorderHand { .. }
        )
    }

    /// The answer for an engine action, when it's one `Act` covers.
    pub fn from_action(action: &GameAction) -> Option<Act> {
        Some(match action {
            GameAction::SelectCards { cards } => Act::SelectCards { cards: cards.iter().map(|c| c.0).collect() },
            GameAction::OrderTriggers { order } => Act::OrderTriggers { order: order.clone() },
            GameAction::SelectModes { indices } => Act::SelectModes { indices: indices.clone() },
            GameAction::ChooseX { value } => Act::ChooseX { value: *value },
            GameAction::ChooseTarget { target } => Act::ChooseTarget { target: target.as_ref().map(TargetView::from_ref) },
            GameAction::CancelCast => Act::CancelCast,
            GameAction::PayUnlessCost { pay } => Act::PayUnlessCost { pay: *pay },
            GameAction::DecideOptionalEffect { accept } => Act::DecideOptionalEffect { accept: *accept },
            GameAction::ChooseOption { choice } => Act::ChooseOption { choice: choice.clone() },
            GameAction::ChooseReplacement { index } => Act::ChooseReplacement { index: *index },
            GameAction::AssignCombatDamage { mode, assignments, trample_damage, controller_damage } => Act::AssignCombatDamage {
                assignments: assignments.iter().map(|(id, n)| (id.0, *n)).collect(),
                trample: *trample_damage,
                controller: *controller_damage,
                unblocked: *mode == CombatDamageAssignmentMode::AsThoughUnblocked,
            },
            GameAction::DistributeAmong { distribution } => {
                Act::DistributeAmong { distribution: distribution.iter().map(|(t, n)| (TargetView::from_ref(t), *n)).collect() }
            }
            GameAction::DecideOptionalEffectAndRemember { choice, scope } => Act::DecideOptionalEffectAndRemember {
                accept: *choice == AutoMayChoice::Accept,
                same_card: *scope == MayTriggerAutoChoiceScope::SameCard,
            },
            GameAction::ChooseReplacementAndRemember { choice } => Act::ChooseReplacementAndRemember {
                choice: match choice {
                    ReplacementAutoChoice::Order { order } => RememberedReplacement::Order { order: order.clone() },
                    ReplacementAutoChoice::Optional { index } => RememberedReplacement::Optional { index: *index },
                },
            },
            GameAction::ChoosePair { partner } => Act::ChoosePair { partner: partner.map(|p| p.0) },
            GameAction::RetargetSpell { new_targets } => Act::RetargetSpell { new_targets: new_targets.iter().map(|t| t.as_ref().map(TargetView::from_ref)).collect() },
            GameAction::KeepAllCopyTargets => Act::KeepAllCopyTargets,
            GameAction::PayCombatTax { accept } => Act::PayCombatTax { accept: *accept },
            GameAction::ChooseExert { exert } => Act::ChooseExert { exert: *exert },
            GameAction::ChooseEnlist { target } => Act::ChooseEnlist { target: target.map(|t| t.0) },
            GameAction::CrewVehicle { vehicle_id, creature_ids } => Act::CrewVehicle { vehicle: vehicle_id.0, creatures: creature_ids.iter().map(|c| c.0).collect() },
            GameAction::SaddleMount { mount_id, creature_ids } => Act::SaddleMount { mount: mount_id.0, creatures: creature_ids.iter().map(|c| c.0).collect() },
            GameAction::SetMayTriggerAutoChoice { op } => Act::SetMayTriggerAutoChoice {
                change: match op {
                    MayTriggerAutoChoiceOp::Remove { selector } => AnswerChange::Remove { selector: selector.clone() },
                    MayTriggerAutoChoiceOp::ClearAll => AnswerChange::ClearAll,
                },
            },
            GameAction::SetReplacementAutoChoice { selector } => Act::SetReplacementAutoChoice { id: selector.as_ref().map(|s| s.0.clone()) },
            GameAction::SetPriorityYield { op } => Act::SetPriorityYield {
                change: match op {
                    PriorityYieldOp::Add { source_id, scope } => YieldChange::Add { source: source_id.0, every: *scope == YieldScope::AllCopies },
                    PriorityYieldOp::Remove { target } => YieldChange::Remove { target: target.clone() },
                    PriorityYieldOp::ClearAll => YieldChange::ClearAll,
                },
            },
            GameAction::ReorderHand { order } => Act::ReorderHand { order: order.iter().map(|c| c.0).collect() },
            GameAction::BeginResolveAll { max_resolutions: 0, scope: ResolveAllScope::Shared } => Act::ResolveAll,
            _ => return None,
        })
    }

    /// Short name for counts and messages ("select_cards").
    pub fn kind(&self) -> &'static str {
        match self {
            Act::SelectCards { .. } => "select_cards",
            Act::OrderTriggers { .. } => "order_triggers",
            Act::SelectModes { .. } => "select_modes",
            Act::ChooseX { .. } => "choose_x",
            Act::ChooseTarget { .. } => "choose_target",
            Act::CancelCast => "cancel_cast",
            Act::PayUnlessCost { .. } => "pay_unless_cost",
            Act::DecideOptionalEffect { .. } => "decide_optional_effect",
            Act::ChooseOption { .. } => "choose_option",
            Act::ChooseReplacement { .. } => "choose_replacement",
            Act::AssignCombatDamage { .. } => "assign_combat_damage",
            Act::DistributeAmong { .. } => "distribute_among",
            Act::DecideOptionalEffectAndRemember { .. } => "decide_optional_effect_and_remember",
            Act::ChooseReplacementAndRemember { .. } => "choose_replacement_and_remember",
            Act::ChoosePair { .. } => "choose_pair",
            Act::RetargetSpell { .. } => "retarget_spell",
            Act::KeepAllCopyTargets => "keep_all_copy_targets",
            Act::PayCombatTax { .. } => "pay_combat_tax",
            Act::ChooseExert { .. } => "choose_exert",
            Act::ChooseEnlist { .. } => "choose_enlist",
            Act::CrewVehicle { .. } => "crew_vehicle",
            Act::SaddleMount { .. } => "saddle_mount",
            Act::SetMayTriggerAutoChoice { .. } => "set_may_trigger_auto_choice",
            Act::SetReplacementAutoChoice { .. } => "set_replacement_auto_choice",
            Act::SetPriorityYield { .. } => "set_priority_yield",
            Act::ReorderHand { .. } => "reorder_hand",
            Act::ResolveAll => "resolve_all",
        }
    }
}

/// Why an answer wasn't applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Not this seat's decision.
    NotYours,
    /// It doesn't answer the seat's current decision; a plain sentence.
    DoesntFit(String),
    /// The engine refused it; its own words (ids not yet turned into names).
    Engine(String),
}

/// An answer the engine took.
pub struct Answered {
    /// Who submitted it (differs from the deciding seat when someone controls that player).
    pub actor: PlayerId,
    pub action: GameAction,
    pub result: ActionResult,
}

/// Whether a seat's own setting can be changed as asked, in a sentence when it can't. The engine
/// would mostly take the others silently and change nothing.
fn check_preference(state: &GameState, owner: PlayerId, act: &Act) -> Result<(), String> {
    match act {
        Act::SetPriorityYield { change: YieldChange::Add { source, every } } => {
            let scope = if *every { YieldScope::AllCopies } else { YieldScope::ThisObject };
            if state.resolve_yield_target_from_stack(ObjectId(*source), scope).is_some() {
                Ok(())
            } else if *every && state.resolve_yield_target_from_stack(ObjectId(*source), YieldScope::ThisObject).is_some() {
                Err("Only this copy of that trigger can be passed for.".into())
            } else {
                Err("That isn't a trigger on the stack.".into())
            }
        }
        Act::SetPriorityYield { change: YieldChange::Remove { target } } => {
            if state.priority_yields.iter().any(|y| y.player == owner && y.target == *target) { Ok(()) } else { Err("That yield is already off.".into()) }
        }
        Act::SetMayTriggerAutoChoice { change: AnswerChange::Remove { selector } } => {
            if selector.player() == owner && state.may_trigger_auto_choices.iter().any(|r| r.selector == *selector) {
                Ok(())
            } else {
                Err("That answer is already off.".into())
            }
        }
        Act::SetReplacementAutoChoice { id: Some(id) } => {
            if state.replacement_auto_choices.iter().any(|r| r.key.player == owner && r.id.0 == *id) { Ok(()) } else { Err("That answer is already off.".into()) }
        }
        Act::ReorderHand { order } => {
            let mut hand: Vec<u64> = state.players.iter().find(|p| p.id == owner).map(|p| p.hand.iter().map(|c| c.0).collect()).unwrap_or_default();
            let mut asked = order.clone();
            hand.sort_unstable();
            asked.sort_unstable();
            if hand == asked { Ok(()) } else { Err("Put every card in your hand in the order once.".into()) }
        }
        _ => Ok(()),
    }
}

/// Check `act` against `owner`'s current decision, then apply it to a copy of `state`. Only an
/// answer the engine takes replaces `state`; any refusal leaves it exactly as it was.
///
/// A seat's own settings ([`Act::is_preference`]) aren't answers: they're checked against the
/// seat's own records and applied whoever is deciding, as the engine allows.
pub fn answer(state: &mut GameState, owner: PlayerId, act: &Act) -> Result<Answered, Refusal> {
    if act.is_preference() {
        check_preference(state, owner, act).map_err(Refusal::DoesntFit)?;
        let action = act.to_action();
        let mut next = state.clone();
        return match engine::game::engine::apply(&mut next, owner, action.clone()) {
            Ok(result) => {
                *state = next;
                Ok(Answered { actor: owner, action, result })
            }
            Err(e) => Err(Refusal::Engine(e.to_string())),
        };
    }
    if !state.waiting_for.acting_players().contains(&owner) {
        return Err(Refusal::NotYours);
    }
    let contract = AiDecisionContract::issue(state, owner);
    let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
    if matches!(act, Act::ResolveAll) {
        // Only from the seat holding priority, with something to resolve (CR 117.3d).
        if !matches!(state.waiting_for, WaitingFor::Priority { player } if player == owner) {
            return Err(Refusal::DoesntFit("You can ask to resolve everything only when it's your priority.".into()));
        }
        if state.stack.is_empty() {
            return Err(Refusal::DoesntFit("There's nothing on the stack to resolve.".into()));
        }
    } else if matches!(act, Act::CancelCast) {
        // Cancelling is allowed exactly where the engine offers it.
        if !candidates.iter().any(|a| matches!(a, GameAction::CancelCast)) {
            return Err(Refusal::DoesntFit("There's nothing to cancel now.".into()));
        }
    }
    let mut act = act.clone();
    if !matches!(act, Act::ResolveAll | Act::CancelCast) {
        let vs = filter_state_for_viewer(state, owner);
        let Some(pending) = Pending::of(&vs, owner, &candidates, &[]) else {
            return Err(Refusal::DoesntFit("Answer this one with the buttons.".into()));
        };
        pending.admits(&act).map_err(Refusal::DoesntFit)?;
        act = pending.normalize(&act);
    }
    let actor = contract.authorized_actor;
    let action = act.to_action();
    let mut next = state.clone();
    match apply_interaction(&mut next, actor, owner, action.clone()) {
        Ok(result) => {
            *state = next;
            Ok(Answered { actor, action, result })
        }
        Err(e) => Err(Refusal::Engine(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, SeatDeck};
    use engine::game::combat::{AttackTarget, TrampleKind};
    use engine::types::game_state::{
        DamageSlot, MayTriggerAutoChoiceKey, MayTriggerOrigin, PendingTriggerSummary, ReplacementAutoChoiceKey, ReplacementCandidateSummary,
    };
    use engine::types::ability::ChoiceType;
    use engine::types::game_state::{NamedChoiceSource, NamedChoiceSourceBinding, PromptSourceBinding};
    use engine::types::identifiers::{ObjectIdentityBinding, ObjectIncarnationRef};
    use engine::types::replacements::ReplacementEvent;
    use engine::types::zones::Zone;

    fn game() -> Match {
        let e = Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/act-cards.json")).unwrap();
        let deck = SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Island".into(); 99] };
        e.new_match_first(1, vec![deck.clone(), deck], &[], Some(0)).unwrap()
    }

    #[test]
    fn a_scry_names_its_cards_only_from_the_deciding_seats_view() {
        let mut m = game();
        let top: Vec<ObjectId> = m.state.players[0].library.iter().take(2).copied().collect();
        m.state.waiting_for = WaitingFor::ScryChoice { player: PlayerId(0), cards: top.clone() };
        let mine = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!(mine.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Island", "Island"]);
        assert_eq!(mine.card_names(), ["Island", "Island"]);
        // Built from another seat's view, the same decision names nothing and gives away no ids.
        let theirs = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(1)), PlayerId(0), &[], &[]).unwrap();
        assert!(theirs.options.iter().all(|o| o.name == "a card"), "{:?}", theirs.options);
        assert!(theirs.options.iter().all(|o| !top.iter().any(|id| id.0.to_string() == o.id)));
    }

    #[test]
    fn may_prompts_ask_in_the_engines_words() {
        assert_eq!(question("draw a card"), "Draw a card?");
        assert_eq!(
            question("When Solemn Simulacrum enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle."),
            "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle?"
        );
        assert_eq!(question("Exile it. You may cast it."), "Exile it. You may cast it.");
        let mut m = game();
        let src = m.state.command_zone[0];
        let vs = filter_state_for_viewer(&m.state, PlayerId(0));
        assert_eq!(
            effect_text(&vs, &src, "[+1]: Exile the top card. If you don't, ~ deals 2 damage."),
            "Exile the top card. If you don't, Combat Celebrant deals 2 damage."
        );
        m.state.waiting_for = WaitingFor::OptionalEffectChoice {
            player: PlayerId(0),
            decision_subject_id: None,
            source_id: src,
            description: Some("draw a card".into()),
            may_trigger_key: None,
            same_card_may_trigger_choice_available: false,
        };
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.prompt.as_str(), p.yes_label.as_deref(), p.remember), (Kind::Yesno, "Draw a card?", Some("Yes"), None));
        assert!(p.admits(&Act::DecideOptionalEffect { accept: false }).is_ok());
        assert!(p.admits(&Act::PayUnlessCost { pay: true }).is_err());
    }

    #[test]
    fn triggers_are_put_in_order_as_a_whole() {
        let mut m = game();
        let src = m.state.command_zone[0];
        let trigger = |text: &str| PendingTriggerSummary { source_id: src, source_name: "Soul Warden".into(), description: text.into() };
        m.state.waiting_for = WaitingFor::OrderTriggers { player: PlayerId(0), triggers: vec![trigger("You gain 1 life."), trigger("Draw a card.")] };
        let vs = filter_state_for_viewer(&m.state, PlayerId(0));
        let p = Pending::of(&vs, PlayerId(0), &[GameAction::OrderTriggers { order: vec![1, 0] }], &[]).unwrap();
        assert_eq!((p.kind, p.answer, p.min, p.max), (Kind::Order, Answer::OrderTriggers, 2, 2));
        assert_eq!(p.options[1].text.as_deref(), Some("Draw a card."));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["defaultAnswer"], json!(["1", "0"]));
        assert_eq!(json["kind"], "order");
        assert!(p.admits(&Act::OrderTriggers { order: vec![1, 0] }).is_ok());
        assert!(p.admits(&Act::OrderTriggers { order: vec![0, 0] }).is_err());
        assert!(p.admits(&Act::OrderTriggers { order: vec![0] }).is_err());
        assert!(p.admits(&Act::SelectCards { cards: vec![] }).is_err());
    }

    #[test]
    fn combat_damage_is_a_split_with_the_engines_default() {
        let mut m = game();
        let attacker = m.state.command_zone[0];
        let blocker = m.state.command_zone[1];
        m.state.waiting_for = WaitingFor::AssignCombatDamage {
            player: PlayerId(0),
            attacker_id: attacker,
            total_damage: 5,
            blockers: vec![DamageSlot { blocker_id: blocker, lethal_minimum: 2 }],
            assignment_modes: vec![],
            trample: Some(TrampleKind::Standard),
            defending_player: PlayerId(1),
            attack_target: AttackTarget::Player(PlayerId(1)),
            pw_loyalty: None,
            pw_controller: None,
        };
        let vs = filter_state_for_viewer(&m.state, PlayerId(0));
        let engine_split = GameAction::AssignCombatDamage {
            mode: CombatDamageAssignmentMode::Normal,
            assignments: vec![(blocker, 2)],
            trample_damage: 3,
            controller_damage: 0,
        };
        let p = Pending::of(&vs, PlayerId(0), &[engine_split], &["Ana".into(), "Ben".into()]).unwrap();
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!((json["kind"].as_str(), json["total"].as_u64(), json["perOptionMin"].as_u64()), (Some("split"), Some(5), Some(0)));
        assert_eq!(json["defaultAnswer"], json!({ blocker.0.to_string(): 2, "p1": 3 }));
        assert_eq!(p.options[1].name, "Ben");
        assert_eq!(p.options[0].lethal, Some(2));
        let assign = |n: u32, trample: u32| Act::AssignCombatDamage { assignments: vec![(blocker.0, n)], trample, controller: 0, unblocked: false };
        assert!(p.admits(&assign(2, 3)).is_ok());
        assert_eq!(p.admits(&assign(2, 2)), Err("Assign all 5 damage.".into()));
        let elsewhere = Act::AssignCombatDamage { assignments: vec![(attacker.0, 5)], trample: 0, controller: 0, unblocked: false };
        assert!(p.admits(&elsewhere).is_err());
        assert_eq!(p.unit, Some("damage"));
    }

    fn may(m: &mut Match, key: bool, same_card: bool) -> Pending {
        let src = m.state.command_zone[0];
        m.state.waiting_for = WaitingFor::OptionalEffectChoice {
            player: PlayerId(0),
            decision_subject_id: None,
            source_id: src,
            description: Some("draw a card".into()),
            may_trigger_key: key.then(|| MayTriggerAutoChoiceKey { player: PlayerId(0), source_id: src, origin: MayTriggerOrigin::Printed { trigger_index: 0 } }),
            same_card_may_trigger_choice_available: same_card,
        };
        Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap()
    }

    #[test]
    fn a_may_answer_is_remembered_only_where_the_engine_can() {
        let mut m = game();
        let remember = |same_card| Act::DecideOptionalEffectAndRemember { accept: true, same_card };
        let p = may(&mut m, true, false);
        assert_eq!(p.remember, Some("engine"));
        assert!(p.admits(&remember(false)).is_ok());
        assert_eq!(p.admits(&remember(true)), Err("This answer can be remembered only for this card.".into()));
        assert!(may(&mut m, true, true).admits(&remember(true)).is_ok());
        // No key: the engine can't remember it, so neither form is allowed and none is offered.
        let p = may(&mut m, false, false);
        assert_eq!(p.remember, None);
        assert_eq!(p.admits(&remember(false)), Err("This answer can't be remembered.".into()));
        assert!(p.admits(&Act::DecideOptionalEffect { accept: true }).is_ok());
        // The wire form, and the engine action it stands for.
        let json = serde_json::to_value(remember(false)).unwrap();
        assert_eq!(json, json!({ "kind": "decide_optional_effect_and_remember", "accept": true }));
        assert_eq!(
            remember(true).to_action(),
            GameAction::DecideOptionalEffectAndRemember { choice: AutoMayChoice::Accept, scope: MayTriggerAutoChoiceScope::SameCard }
        );
    }

    #[test]
    fn replacement_effects_can_be_put_in_order_and_remembered() {
        let mut m = game();
        let (a, b) = (m.state.command_zone[0], m.state.command_zone[1]);
        let summary = |id, name: &str| ReplacementCandidateSummary { source_id: id, source_name: name.into(), description: "It happens twice instead.".into() };
        let key = |kind| ReplacementAutoChoiceKey { player: PlayerId(0), event: ReplacementEvent::Draw, kind, candidates: vec![] };
        let choice = |kind, n: usize, remember: bool| WaitingFor::ReplacementChoice {
            player: PlayerId(0),
            candidate_count: n,
            candidates: [summary(a, "Hardened Scales"), summary(b, "Doubling Season")].into_iter().take(n).collect(),
            kind,
            last_applied_decides: false,
            remember_identity: remember.then(|| key(kind)),
        };
        m.state.waiting_for = choice(ReplacementChoiceKind::Order, 2, true);
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.remember, p.options[1].name.as_str()), (Kind::Pick, Some("engine"), "Doubling Season"));
        let order = |order: Vec<usize>| Act::ChooseReplacementAndRemember { choice: RememberedReplacement::Order { order } };
        assert!(p.admits(&order(vec![1, 0])).is_ok());
        assert_eq!(p.admits(&order(vec![1, 1])), Err("Put every effect in the order once.".into()));
        let optional = Act::ChooseReplacementAndRemember { choice: RememberedReplacement::Optional { index: 0 } };
        assert!(p.admits(&optional).is_err());
        // A single "you may" replacement is a yes or no; its remembered form names the branch.
        m.state.waiting_for = choice(ReplacementChoiceKind::OptionalBranch, 1, true);
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.remember), (Kind::Yesno, Some("engine")));
        assert!(p.admits(&optional).is_ok());
        assert!(p.admits(&order(vec![0])).is_err());
        // Without the engine's identity, nothing is remembered.
        m.state.waiting_for = choice(ReplacementChoiceKind::Order, 2, false);
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!(p.remember, None);
        assert_eq!(p.admits(&order(vec![0, 1])), Err("This answer can't be remembered.".into()));
        assert_eq!(serde_json::to_value(order(vec![1, 0])).unwrap(), json!({ "kind": "choose_replacement_and_remember", "choice": { "type": "order", "order": [1, 0] } }));
    }

    #[test]
    fn cards_put_on_the_bottom_in_any_order_are_an_order() {
        let mut m = game();
        let pile: Vec<ObjectId> = m.state.players[0].library.iter().take(3).copied().collect();
        let src = m.state.command_zone[0];
        m.state.waiting_for = WaitingFor::RevealUntilBottomOrder {
            player: PlayerId(0),
            source_id: src,
            cards: pile.clone(),
            clear_markers: vec![],
            emit_reveal_until_resolved: None,
            reveal_until_hit_snapshot: None,
        };
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.answer, p.min, p.max, p.destination), (Kind::Order, Answer::SelectCards, 3, 3, Some("bottom")));
        let ids: Vec<u64> = pile.iter().map(|c| c.0).collect();
        assert!(p.admits(&Act::SelectCards { cards: vec![ids[2], ids[0], ids[1]] }).is_ok());
        assert!(p.admits(&Act::SelectCards { cards: vec![ids[2], ids[0]] }).is_err());
        assert!(p.admits(&Act::SelectCards { cards: vec![ids[2], ids[2], ids[1]] }).is_err());
    }

    #[test]
    fn soulbond_pairs_with_one_creature_or_none() {
        let mut m = game();
        let (src, other) = (m.state.command_zone[0], m.state.command_zone[1]);
        m.state.waiting_for = WaitingFor::PairChoice { player: PlayerId(0), source_id: src, choices: vec![other] };
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.answer, p.min, p.max, p.up_to), (Kind::Pair, Answer::ChoosePair, 0, 1, true));
        assert_eq!(p.prompt, "Pair Combat Celebrant with another creature?");
        assert!(p.admits(&Act::ChoosePair { partner: Some(other.0) }).is_ok());
        assert!(p.admits(&Act::ChoosePair { partner: None }).is_ok());
        assert!(p.admits(&Act::ChoosePair { partner: Some(src.0) }).is_err());
        assert_eq!(Act::ChoosePair { partner: Some(other.0) }.to_action(), GameAction::ChoosePair { partner: Some(other) });
    }

    #[test]
    fn a_named_choice_shows_the_card_asking() {
        let mut m = game();
        let src = m.state.command_zone[0];
        let named = |source| WaitingFor::NamedChoice {
            player: PlayerId(0),
            choice_type: ChoiceType::CardName,
            options: vec![],
            source,
            persist_player: None,
            free_entry: None,
        };
        let binding = NamedChoiceSource {
            prompt: PromptSourceBinding {
                identity: ObjectIdentityBinding::new(ObjectIncarnationRef { object_id: src, incarnation: 0 }, Zone::Battlefield),
                controller: PlayerId(0),
                display_name: "Pithing Needle".into(),
            },
            binding: NamedChoiceSourceBinding::PendingEntry,
            context: None,
        };
        m.state.waiting_for = named(Some(binding));
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.free_entry, p.choice_type.as_deref()), (Kind::Text, Some(true), Some("card name")));
        assert_eq!(p.source.as_ref().map(|s| (s.id, s.name.as_str())), Some((src.0, "Pithing Needle")));
        assert!(p.card_names().contains(&"Pithing Needle".to_string()), "its details are sent too");
        // A choice with no source names none.
        m.state.waiting_for = named(None);
        assert!(Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap().source.is_none());
    }

    #[test]
    fn a_list_of_numbers_is_a_number() {
        assert_eq!(number_range(&(0..=10).map(|n| n.to_string()).collect::<Vec<_>>()), Some((0, 10)));
        assert_eq!(number_range(&["1".into(), "3".into()]), None);
        assert_eq!(number_range(&["1".into(), "Goblin".into()]), None);
        assert_eq!(number_range(&[]), None);
        let mut m = game();
        m.state.waiting_for = WaitingFor::NamedChoice {
            player: PlayerId(0),
            choice_type: ChoiceType::CardName,
            options: (0..=10).map(|n| n.to_string()).collect(),
            source: None,
            persist_player: None,
            free_entry: None,
        };
        let p = Pending::of(&filter_state_for_viewer(&m.state, PlayerId(0)), PlayerId(0), &[], &[]).unwrap();
        assert_eq!((p.kind, p.min, p.max, p.prompt.as_str()), (Kind::Number, 0, 10, "Choose a number from 0 to 10"));
        assert!(p.admits(&Act::ChooseOption { choice: "7".into() }).is_ok());
        assert!(p.admits(&Act::ChooseOption { choice: "11".into() }).is_err());
    }

    #[test]
    fn modes_are_asked_in_the_words_cards_use() {
        assert_eq!(modes_prompt(1, 1, 3), "Choose one");
        assert_eq!(modes_prompt(2, 2, 4), "Choose two");
        assert_eq!(modes_prompt(1, 2, 2), "Choose one or both");
        assert_eq!(modes_prompt(1, 3, 3), "Choose one or more");
        assert_eq!(modes_prompt(0, 2, 3), "Choose up to two");
        assert_eq!(modes_prompt(2, 3, 5), "Choose two to three");
    }
}
