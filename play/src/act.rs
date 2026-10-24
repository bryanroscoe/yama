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
//!
//! Paying (play/src/pay.rs, the review's build plan section 9) adds the cast with the seat's
//! "Tap mana for me" setting, each tap, untap and convoke while paying, the sacrificial-source
//! question, mana colours, Phyrexian mana, and the extra costs of GCosts (kicker and other optional
//! costs, a cost paid with cards, an activation's alternative costs, ward).

use engine::ai_support::AiDecisionContract;
use engine::game::engine::apply_interaction;
use engine::game::filter_state_for_viewer;
use engine::types::ability::{
    AbilityCost, AdditionalCost, AdditionalCostOrigin, CardSelectionMode, DiscardSelfScope, Effect, FreeEntry, QuantityExpr, SacrificeRequirement,
    TapCreaturesSelectionMode, TargetRef,
};
use engine::types::events::GameEvent;
use engine::types::actions::{AlternativeCastDecision, CastChoice, GameAction, MayTriggerAutoChoiceOp, PriorityYieldOp, ReplacementAutoChoice, ResolveAllScope};
use engine::types::game_state::{
    ActionResult, AutoMayChoice, CombatDamageAssignmentMode, CombatTaxContext, CostResume, CounterCostChoice, CounterMoveChoice, CounterRemoveChoice, DistributionUnit, GameState, ManaChoice,
    ManaChoiceContext, ManaChoicePrompt, MayTriggerAutoChoiceScope, MayTriggerAutoChoiceSelector, MulliganDecisionPhase, PayCostKind,
    ReplacementAutoChoiceId, ReplacementChoiceKind, RetargetScope, ShardChoice, ShardOptions, WaitingFor, YieldScope,
    YieldTarget,
};
use engine::types::mana::{ManaCost, ManaType};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use phase_llm::render::action::humanize_identifier;
use phase_llm::render::text::{mana_cost_text, one_line};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::pay::{self, PayMode, mana_code, mana_type};
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
    /// Use a mana source: here, sacrifice one for mana, or keep it (`Act::KeepMana`).
    TapMana,
    /// The colour or colours of mana a source or effect adds (CR 106.3).
    ChooseManaColor,
    /// Which mana pays a mana ability's own hybrid cost (CR 605.3a).
    PayManaAbilityMana,
    /// Phyrexian mana: each symbol with its colour of mana or 2 life (CR 107.4f).
    PayPhyrexian,
    /// Pay an optional additional cost, such as kicker, or don't (CR 601.2b).
    DecideOptionalCost,
    /// Which of an activation's alternative costs to pay (CR 118.12a).
    ChooseCostBranch,
    // Ways to cast, permanents and counters (ways.rs).
    /// Cast the card a cascade, discover, ripple, madness or miracle offers, or don't.
    CastOffer,
    /// An adventurer card's creature or its adventure (CR 715.3a).
    ChooseAdventureFace,
    /// Which face of a modal two-faced card to cast (CR 712.11b).
    ChooseModalFace,
    /// The mana cost or a keyword's alternative cost (CR 118.9).
    ChooseAlternativeCast,
    /// One of several ways to cast it from the same zone (CR 601.2b).
    ChooseCastingVariant,
    /// A mutating creature over or under the creature it merges with (CR 702.140c).
    ChooseMutateSide,
    /// The legend to keep (CR 704.5j).
    ChooseLegend,
    /// The Ring-bearer (CR 701.54a).
    ChooseRingBearer,
    /// The creature to attach an Equipment to (CR 702.6a).
    Equip,
    /// Any number of permanents and players: proliferate (CR 701.34a).
    SelectTargets,
    /// Counters moved onto other permanents (CR 122.5).
    MoveCounters,
    /// Counters removed as an effect resolves (CR 107.1c).
    RemoveCounters,
    /// Counters removed from among permanents as a cost (CR 118.3).
    RemoveCounterCost,
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
    /// What choosing it costs, printed ("{4}{R}"): a kicker row, one of several costs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<String>,
    /// The counters on it now, in words with how many ("+1/+1", 2): proliferate, empower Jace,
    /// moving or removing counters (ways.rs).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub counters: Vec<(String, u32)>,
    /// The most a split may give it (the counters of its kind it has, or that can move).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cap: Option<u32>,
    /// The counter kind it stands for, by the engine's key ("P1P1"). Options of one group share
    /// one cap: together they move no more of that kind than there are.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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
    /// "damage" or "divide"; while paying, "mana_source" (sacrifice it for mana?), "color",
    /// "combo" and "colors" (mana to add), "hybrid" (a mana ability's hybrid cost), "phyrexian",
    /// "kicker", "optional" and "either" (extra costs), "cost" (cards or permanents as a cost),
    /// "cost_branch", "cost_type", "ward" and "return". Ways to cast (ways.rs): "cascade",
    /// "discover", "ripple", "madness", "miracle", "miracle_reveal", "adventure", "face",
    /// "alt_cost", "variant" and "mutate"; permanents: "legend", "clone", "equip", "ring",
    /// "empower", "host", "populate" and "explore"; counters: "proliferate", "move_counters",
    /// "remove_counters" and "counter_cost".
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
    /// What a split divides: "damage", "counters", "life" or "mana" (damage gets a lethal hint).
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
    /// What happens if the cost isn't paid, in red (ward: "If you don't pay, your Swords to
    /// Plowshares is countered.").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warn: Option<String>,
    /// Phyrexian mana: the rest of the cost, printed, which is paid with mana either way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rest: Option<String>,
    /// Moving or removing counters: the permanent they come off, by option id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// `current` isn't one of the engine's alternatives, so picking it is sent as keeping it.
    #[serde(skip)]
    keeps_current: bool,
    /// Phyrexian mana: how each symbol may be paid, to check an answer against.
    #[serde(skip)]
    shards: Vec<ShardOptions>,
}

impl Pending {
    pub(crate) fn new(kind: Kind, answer: Answer, purpose: &'static str, prompt: impl Into<String>, options: Vec<Choice>) -> Self {
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
            warn: None,
            rest: None,
            origin: None,
            keeps_current: false,
            shards: vec![],
        }
    }

    pub(crate) fn from(mut self, vs: &GameState, source: Option<ObjectId>) -> Self {
        self.source = source.and_then(|id| {
            let o = vs.objects.get(&id)?;
            Some(Source { id: id.0, name: Match::name_in(vs, &id), controller: o.controller.0, art: None, image: None, artist: None })
        });
        self
    }

    /// Pick between `min` and `max` of the eligible options (capped at how many there are).
    pub(crate) fn range(mut self, min: usize, max: usize, up_to: bool) -> Self {
        let n = self.options.iter().filter(|o| o.eligible).count();
        self.min = min.min(n);
        self.max = max.min(n);
        self.up_to = up_to;
        self
    }

    pub(crate) fn yes_no(mut self, yes: impl Into<String>, no: impl Into<String>) -> Self {
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
pub(crate) fn card(vs: &GameState, id: &ObjectId, eligible: bool) -> Choice {
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
        cost: None,
        counters: vec![],
        cap: None,
        group: None,
        card: true,
    }
}

pub(crate) fn cards(vs: &GameState, ids: &[ObjectId]) -> Vec<Choice> {
    ids.iter().map(|id| card(vs, id, true)).collect()
}

/// A word, a mode or a trigger as an option.
pub(crate) fn word(id: impl Into<String>, name: impl Into<String>) -> Choice {
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
        cost: None,
        counters: vec![],
        cap: None,
        group: None,
        card: false,
    }
}

pub(crate) fn player_choice(p: PlayerId, names: &[String]) -> Choice {
    let mut c = word(format!("p{}", p.0), names.get(usize::from(p.0)).cloned().unwrap_or_else(|| format!("Player {}", p.0 + 1)));
    c.zone = Some("player".into());
    c.controller = Some(p.0);
    c
}

pub(crate) fn target(vs: &GameState, t: &TargetRef, names: &[String]) -> Choice {
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
    // "You may have Clone enter as a copy…" asks "Have Clone enter as a copy…?".
    let text = text.strip_prefix("You may ").unwrap_or(text);
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

/// A cost in words, for a question or a button: printed for mana ("{2}"), the common shapes in
/// plain words ("discard a card", "pay 3 life", "sacrifice a permanent"), anything else in
/// phase's own description of it.
pub(crate) fn unless_cost_text(vs: &GameState, cost: &AbilityCost) -> String {
    let printed = cost_text(cost);
    if !printed.is_empty() {
        return printed;
    }
    let fixed = |q: &QuantityExpr| match q {
        QuantityExpr::Fixed { value } => Some((*value).max(0) as usize),
        _ => None,
    };
    match cost {
        AbilityCost::Discard { self_scope: DiscardSelfScope::SourceCard, .. } => "discard this card".into(),
        AbilityCost::Discard { count, selection, .. } => {
            let what = format!("discard {}", a_or(fixed(count).unwrap_or(1), "card", "cards"));
            if *selection == CardSelectionMode::Random { format!("{what} at random") } else { what }
        }
        AbilityCost::PayLife { amount } => fixed(amount).map_or_else(|| "pay life".into(), |n| format!("pay {n} life")),
        AbilityCost::PayEnergy { amount } => fixed(amount).map_or_else(|| "pay energy".into(), |n| format!("pay {n} energy")),
        AbilityCost::Sacrifice(s) => match &s.requirement {
            SacrificeRequirement::Count { count } => format!("sacrifice {}", a_or(*count as usize, "permanent", "permanents")),
            SacrificeRequirement::Aggregate { .. } => "sacrifice permanents".into(),
        },
        AbilityCost::Exile { count, .. } => format!("exile {}", a_or(*count as usize, "card", "cards")),
        _ => serde_json::to_value(cost).map(|v| phase_llm::render::action::describe_tagged(vs, &v)).unwrap_or_else(|_| "the cost".into()),
    }
}

/// "A", "A and B", "A, B and C".
fn and_list(names: &[String]) -> String {
    match names {
        [] => "nothing".into(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// "a card", "2 cards".
pub(crate) fn a_or(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("a {one}") } else { format!("{n} {many}") }
}

/// The first letter in capitals: "discard a card" reads "Discard a card".
pub(crate) fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// A colour of mana as an option: its letter ("W") and its name.
fn mana_option(t: ManaType) -> Choice {
    let name = match t {
        ManaType::White => "White",
        ManaType::Blue => "Blue",
        ManaType::Black => "Black",
        ManaType::Red => "Red",
        ManaType::Green => "Green",
        ManaType::Colorless => "Colourless",
    };
    word(mana_code(t), name)
}

/// Several mana at once as an option: "WU", named "{W}{U}".
fn combo(v: &[ManaType]) -> Choice {
    let codes: Vec<&str> = v.iter().map(|t| mana_code(*t)).collect();
    word(codes.concat(), pay::symbols(&codes))
}

/// The keyword an optional additional cost comes from, for its question (CR 601.2b).
fn origin_name(origin: AdditionalCostOrigin) -> &'static str {
    match origin {
        AdditionalCostOrigin::Kicker => "Kicker",
        AdditionalCostOrigin::Casualty => "Casualty",
        AdditionalCostOrigin::Offspring => "Offspring",
        AdditionalCostOrigin::Squad => "Squad",
        AdditionalCostOrigin::Replicate => "Replicate",
        AdditionalCostOrigin::Bargain => "Bargain",
        AdditionalCostOrigin::Teamwork => "Teamwork",
        AdditionalCostOrigin::Gift => "Gift",
        AdditionalCostOrigin::Other => "Extra cost",
    }
}

/// What a counter effect held back by an unpaid cost would counter: "your Swords to Plowshares"
/// (ward, CR 702.21a: the spell or ability that targeted, from the trigger's event). `None` for
/// any other effect.
fn countered(vs: &GameState, me: PlayerId, effect: &engine::types::ability::ResolvedAbility, event: Option<&GameEvent>) -> Option<String> {
    if !matches!(effect.effect, Effect::Counter { .. }) {
        return None;
    }
    let target = effect
        .targets
        .iter()
        .find_map(|t| match t {
            TargetRef::Object(id) => Some(*id),
            TargetRef::Player(_) => None,
        })
        .or(match event {
            Some(GameEvent::BecomesTarget { source_id, .. }) => Some(*source_id),
            _ => None,
        })?;
    let entry = vs.stack.iter().find(|e| e.id == target || e.source_id == target);
    let spell = entry.is_none_or(|e| matches!(e.kind, engine::types::game_state::StackEntryKind::Spell { .. }));
    let (source, controller) = match (entry, vs.objects.get(&target)) {
        (Some(e), _) => (e.source_id, e.controller),
        (None, Some(o)) => (target, o.controller),
        (None, None) => return None,
    };
    let name = Match::name_in(vs, &source);
    let what = if spell { name } else { format!("{name}'s ability") };
    Some(if controller == me { format!("your {what}") } else { what })
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
            WaitingFor::UnlessPayment { player, cost, effect_description, pending_effect, trigger_event, .. } if *player == me => {
                let printed = !cost_text(cost).is_empty();
                let words = unless_cost_text(vs, cost);
                // A mana cost is paid ("Pay {2}"); any other cost is done ("Discard a card").
                let (ask, yes, no) = if printed {
                    (format!("Pay {words}?"), format!("Pay {words}"), "Don't pay".to_string())
                } else {
                    let verb = words.split_whitespace().next().unwrap_or("pay").to_lowercase();
                    (question(&words), capitalised(&words), format!("Don't {verb}"))
                };
                let prompt = match effect_description {
                    Some(effect) => format!("{ask} If you don't: {}", one_line(effect)),
                    None => ask,
                };
                // The card asking (Rhystic Study, Mana Leak, a ward creature) is the source of the
                // effect it holds back.
                let mut p = Pending::new(Kind::Yesno, Answer::PayUnlessCost, "pay", prompt, vec![]).yes_no(yes, no).from(vs, Some(pending_effect.source_id));
                // Ward and the like: not paying counters something of yours (CR 702.21a).
                p.warn = countered(vs, me, pending_effect, trigger_event.as_ref()).map(|what| {
                    let verb = if printed { "pay".to_string() } else { words.split_whitespace().next().unwrap_or("pay").to_lowercase() };
                    format!("If you don't {verb}, {what} is countered.")
                });
                p
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
                    // A clone entering as a copy (CR 707.9) says so on its buttons.
                    let (yes, no) = if text.contains("enter as a copy of") { ("Copy", "Don't copy") } else { ("Yes", "No") };
                    let mut p = Pending::new(Kind::Yesno, Answer::ChooseReplacement, "replacement", question(&text), options).yes_no(yes, no).from(vs, source);
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
            WaitingFor::ManaSourceSelection { player, options, .. } if *player == me => {
                // Paying automatically reached a source that sacrifices itself, such as a Treasure
                // (CR 601.2g-h): sacrifice it for mana, or keep it and pay by hand (`Act::KeepMana`).
                let mut ids: Vec<ObjectId> = Vec::new();
                for o in options {
                    if !ids.contains(&o.source.object_id) {
                        ids.push(o.source.object_id);
                    }
                }
                let prompt = match ids.as_slice() {
                    [one] => format!("Sacrifice {} for mana?", Match::name_in(vs, one)),
                    _ => "Choose what to sacrifice for mana".to_string(),
                };
                let mut p = Pending::new(Kind::Pick, Answer::TapMana, "mana_source", prompt, cards(vs, &ids))
                    .range(1, 1, false)
                    .from(vs, vs.pending_cast.as_ref().map(|c| c.object_id));
                p.default_answer = (ids.len() == 1).then(|| json!([ids[0].0.to_string()]));
                p
            }
            WaitingFor::ChooseManaColor { player, choice, context } if *player == me => {
                let source = match context {
                    ManaChoiceContext::ManaAbility(m) => m.source_id,
                    ManaChoiceContext::ResolvingEffect(r) => r.source_id,
                };
                match choice {
                    ManaChoicePrompt::SingleColor { options } => {
                        Pending::new(Kind::Pick, Answer::ChooseManaColor, "color", "Choose a colour of mana", options.iter().map(|t| mana_option(*t)).collect())
                            .range(1, 1, false)
                            .from(vs, Some(source))
                    }
                    // A filter land: one whole combination ("{W}{U}").
                    ManaChoicePrompt::Combination { options } => {
                        let combos = options.iter().map(|v| combo(v)).collect();
                        Pending::new(Kind::Pick, Answer::ChooseManaColor, "combo", "Choose the mana to add", combos).range(1, 1, false).from(vs, Some(source))
                    }
                    // Several mana, each of any of these colours: a split of the total.
                    ManaChoicePrompt::AnyCombination { count: n, options } => {
                        let mut p = Pending::new(Kind::Split, Answer::ChooseManaColor, "colors", format!("Choose the colours of {}", count(*n, "mana", "mana")), options.iter().map(|t| mana_option(*t)).collect())
                            .from(vs, Some(source));
                        p.min = 0;
                        p.max = *n;
                        p.total = Some(*n as u32);
                        p.per_option_min = Some(0);
                        p.unit = Some("mana");
                        p
                    }
                }
            }
            WaitingFor::PayManaAbilityMana { player, options, pending_mana_ability } if *player == me => {
                // A mana ability's own hybrid cost, where the pool could pay it more than one way.
                let ways = options
                    .iter()
                    .map(|v| {
                        let mut c = combo(v);
                        c.name = format!("Pay {}", c.name);
                        c
                    })
                    .collect();
                Pending::new(Kind::Pick, Answer::PayManaAbilityMana, "hybrid", "Choose how to pay its cost", ways).range(1, 1, false).from(vs, Some(pending_mana_ability.source_id))
            }
            WaitingFor::PhyrexianPayment { player, spell_object, shards } if *player == me => {
                // CR 107.4f: each Phyrexian symbol is paid with its colour or 2 life. The pick is
                // the symbols paid with life; a symbol only one way can pay is fixed.
                let cost = vs.pending_cast.as_ref().map(|c| c.cost.clone());
                let printed: Vec<&'static str> = match &cost {
                    Some(ManaCost::Cost { shards, .. }) => shards.iter().map(|s| s.symbol()).collect(),
                    _ => vec![],
                };
                let options: Vec<Choice> = shards
                    .iter()
                    .enumerate()
                    .map(|(i, sh)| {
                        let symbol = printed.get(sh.shard_index).copied().unwrap_or("P");
                        let mut c = word(i.to_string(), format!("{{{symbol}}}"));
                        c.eligible = sh.options == ShardOptions::ManaOrLife;
                        // The mana that pays it instead of life: "{W}", or "{W/U}" for a hybrid.
                        c.cost = Some(format!("{{{}}}", symbol.trim_end_matches("/P")));
                        c.text = Some(
                            match sh.options {
                                ShardOptions::ManaOrLife => "Mana or 2 life",
                                ShardOptions::ManaOnly => "Only mana",
                                ShardOptions::LifeOnly => "Only 2 life",
                            }
                            .to_string(),
                        );
                        c
                    })
                    .collect();
                let mut p = Pending::new(Kind::Pick, Answer::PayPhyrexian, "phyrexian", "Pay the Phyrexian mana", options).from(vs, Some(*spell_object));
                p.min = 0;
                p.max = shards.len();
                p.up_to = true;
                p.shards = shards.iter().map(|s| s.options).collect();
                // Of the routes the engine lists, the one that can be paid for the least life is
                // the default.
                let fewest = candidates
                    .iter()
                    .filter_map(|a| match a {
                        GameAction::SubmitPhyrexianChoices { choices } => Some(choices),
                        _ => None,
                    })
                    .filter(|c| engine::game::casting::pending_phyrexian_route_is_payable(vs, me, *spell_object, c))
                    .min_by_key(|c| c.iter().filter(|x| **x == ShardChoice::PayLife).count());
                p.default_answer = Some(match fewest {
                    Some(route) => json!(route.iter().enumerate().filter(|(_, x)| **x == ShardChoice::PayLife).map(|(i, _)| i.to_string()).collect::<Vec<_>>()),
                    None => json!(shards.iter().enumerate().filter(|(_, s)| s.options == ShardOptions::LifeOnly).map(|(i, _)| i.to_string()).collect::<Vec<_>>()),
                });
                // What's paid with mana either way.
                p.rest = cost.map(|c| match c {
                    ManaCost::Cost { shards, generic } => {
                        phase_llm::render::text::mana_cost_text(&ManaCost::Cost { shards: shards.into_iter().filter(|s| !s.symbol().ends_with("/P")).collect(), generic })
                    }
                    other => mana_cost_text(&other),
                });
                p
            }
            WaitingFor::OptionalCostChoice { player, cost, times_kicked, origin, pending_cast, .. } if *player == me => {
                // CR 601.2b: an additional cost the caster may pay. Kicker shows what the spell costs
                // either way; a multikicker asks again after each kick (CR 702.33c).
                let base = mana_cost_text(&pending_cast.cost);
                let mana_of = |c: &AbilityCost| match c {
                    AbilityCost::Mana { cost } => Some(cost.clone()),
                    _ => None,
                };
                let (prompt, purpose, pay, skip) = match cost {
                    AdditionalCost::Kicker { costs, .. } => {
                        let kick = costs.iter().map(|c| unless_cost_text(vs, c)).collect::<Vec<_>>().join(" and ");
                        let total = costs.iter().try_fold(pending_cast.cost.clone(), |t, c| mana_of(c).map(|m| t.plus(&m))).map(|t| mana_cost_text(&t));
                        if *times_kicked == 0 {
                            (format!("Pay the kicker, {kick}?"), "kicker", ("Kicked".to_string(), total), ("Not kicked".to_string(), Some(base.clone())))
                        } else {
                            let so_far = if *times_kicked == 1 { "once".to_string() } else { format!("{times_kicked} times") };
                            (format!("Kicked {so_far}. Kick it again for {kick}?"), "kicker", ("Kick again".to_string(), Some(kick.clone())), ("Stop kicking".to_string(), None))
                        }
                    }
                    AdditionalCost::Optional { cost, .. } => {
                        let what = unless_cost_text(vs, cost);
                        let ask = if cost_text(cost).is_empty() { question(&what) } else { format!("Pay {what}?") };
                        (format!("{}: {ask}", origin_name(*origin)), "optional", ("Pay it".to_string(), Some(what)), ("Don't pay it".to_string(), None))
                    }
                    AdditionalCost::Choice(a, b) => {
                        let (a, b) = (unless_cost_text(vs, a), unless_cost_text(vs, b));
                        ("Pay one of these costs".to_string(), "either", (capitalised(&a), None), (capitalised(&b), None))
                    }
                    AdditionalCost::Required(_) => return None,
                };
                let mut yes = word("pay", pay.0);
                yes.cost = pay.1;
                let mut no = word("skip", skip.0);
                no.cost = skip.1;
                let mut p = Pending::new(Kind::Pick, Answer::DecideOptionalCost, purpose, prompt, vec![yes, no]).range(1, 1, false).from(vs, Some(pending_cast.object_id));
                p.default_answer = first(|a| matches!(a, GameAction::DecideOptionalCost { .. })).map(|a| match a {
                    GameAction::DecideOptionalCost { pay: true } => json!(["pay"]),
                    _ => json!(["skip"]),
                });
                p
            }
            WaitingFor::ActivationCostOneOfChoice { player, costs, pending_cast } if *player == me => {
                // CR 118.12a: one of the ability's costs, among those that can be paid now.
                let options = costs
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let mut o = word(i.to_string(), capitalised(&unless_cost_text(vs, c)));
                        o.eligible = candidates.iter().any(|a| matches!(a, GameAction::ChooseActivationCostBranch { index } if *index == i));
                        o
                    })
                    .collect();
                Pending::new(Kind::Pick, Answer::ChooseCostBranch, "cost_branch", "Choose which cost to pay", options).range(1, 1, false).from(vs, Some(pending_cast.object_id))
            }
            WaitingFor::CostTypeChoice { player, choice_type, options, pending_cast } if *player == me => {
                // A creature type to behold (Celestial Reunion), from the engine's list.
                let what = serde_json::to_value(choice_type).ok().as_ref().and_then(choice_type_name).unwrap_or_else(|| "type".into());
                let mut p = Pending::new(Kind::Text, Answer::ChooseOption, "cost_type", format!("Choose a {what}"), options.iter().map(|o| word(o.clone(), o.clone())).collect())
                    .from(vs, Some(pending_cast.object_id));
                p.min = 1;
                p.max = 1;
                p.free_entry = Some(false);
                p.choice_type = Some(what);
                p
            }
            WaitingFor::PayCost { player, kind, choices, count: n, min_count, resume } if *player == me => {
                // CR 601.2h: cards or permanents chosen to pay a cost ("As an additional cost to
                // cast this spell, discard a card"). Costs measured another way keep the buttons.
                let (verb, one, many) = match kind {
                    PayCostKind::Discard => ("Discard", "card", "cards"),
                    PayCostKind::Reveal => ("Reveal", "card", "cards"),
                    PayCostKind::Sacrifice => ("Sacrifice", "permanent", "permanents"),
                    PayCostKind::ReturnToHand => ("Return", "permanent", "permanents"),
                    PayCostKind::ExileFromZone { .. } | PayCostKind::ExileFromManaZone { .. } => ("Exile", "card", "cards"),
                    PayCostKind::ExilePermanent { .. } => ("Exile", "permanent", "permanents"),
                    PayCostKind::TapCreatures { mode: TapCreaturesSelectionMode::Fixed | TapCreaturesSelectionMode::VariableX } => ("Tap", "creature", "creatures"),
                    // Counters as a cost: from one permanent, or from among several (ways.rs).
                    PayCostKind::RemoveCounter { .. } => return crate::ways::counter_cost(vs, kind, choices, *n, resume),
                    _ => return None,
                };
                let source = match resume {
                    CostResume::Spell { spell } | CostResume::SpellCost { spell, .. } => Some((spell.object_id, spell.activation_ability_index.is_some())),
                    CostResume::ManaAbility { mana_ability } => Some((mana_ability.source_id, true)),
                    CostResume::Resolution => None,
                };
                // An exact count, or at least `min_count` (CR 118.3).
                let (lo, up) = if *min_count > 0 && *min_count < *n { (*min_count, true) } else { (*n, false) };
                let what = if up { format!("up to {}", count(*n, one, many)) } else { a_or(*n, one, many) };
                let why = match source {
                    Some((id, false)) => format!(" to cast {}", Match::name_in(vs, &id)),
                    Some((id, true)) => format!(" to activate {}", Match::name_in(vs, &id)),
                    None => String::new(),
                };
                Pending::new(Kind::Pick, Answer::SelectCards, "cost", format!("{verb} {what}{why}"), cards(vs, choices)).range(lo, *n, up).from(vs, source.map(|s| s.0))
            }
            WaitingFor::WardDiscardChoice { player, cards: ids, pending_effect, remaining, .. } if *player == me => {
                // Ward is being paid (the yes came first): the card to discard, one at a time.
                let more = if *remaining > 1 { format!(", {remaining} to go") } else { String::new() };
                Pending::new(Kind::Pick, Answer::SelectCards, "ward", format!("Ward: discard a card{more}"), cards(vs, ids)).range(1, 1, false).from(vs, Some(pending_effect.source_id))
            }
            WaitingFor::WardSacrificeChoice { player, permanents, pending_effect, remaining, min_total_power } if *player == me => {
                let mut options = cards(vs, permanents);
                match min_total_power {
                    // Permanents whose total power reaches the threshold (CR 118.12a).
                    Some(need) => {
                        for o in &mut options {
                            o.power = vs.objects.get(&ObjectId(o.id.parse().unwrap_or(0))).and_then(|c| c.power);
                        }
                        let n = options.len();
                        let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "ward", format!("Ward: sacrifice permanents with total power {need} or more"), options)
                            .range(usize::from(*need > 0), n, true)
                            .from(vs, Some(pending_effect.source_id));
                        p.need = Some((*need).max(0) as u32);
                        p
                    }
                    None => {
                        let more = if *remaining > 1 { format!(", {remaining} to go") } else { String::new() };
                        Pending::new(Kind::Pick, Answer::SelectCards, "ward", format!("Ward: sacrifice a permanent{more}"), options).range(1, 1, false).from(vs, Some(pending_effect.source_id))
                    }
                }
            }
            WaitingFor::UnlessBounceChoice { player, permanents, pending_effect, remaining } if *player == me => {
                let more = if *remaining > 1 { format!(", {remaining} to go") } else { String::new() };
                Pending::new(Kind::Pick, Answer::SelectCards, "return", format!("Return a permanent to its owner's hand{more}"), cards(vs, permanents))
                    .range(1, 1, false)
                    .from(vs, Some(pending_effect.source_id))
            }
            // Ways to cast, permanents and counters.
            _ => crate::ways::of(vs, me, candidates, names)?,
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

    /// One option by its id, in a sentence when it can't be chosen.
    fn one_of(&self, id: &str) -> Result<(), String> {
        if self.eligible(id) { Ok(()) } else { Err("That isn't one of the choices.".into()) }
    }

    /// The option a counter answer names: the permanent (where it names one) and the kind.
    fn counter_option(&self, on: Option<u64>, kind: &str) -> Option<&Choice> {
        self.options
            .iter()
            .find(|o| o.eligible && o.group.as_deref() == Some(kind) && on.is_none_or(|id| crate::ways::split_id(&o.id).0 == id))
    }

    /// Counters moved or removed (ways.rs): each one an option at most once, within its cap;
    /// moving counters shares each kind's cap among the permanents they go on (CR 122.5); the
    /// total is at most the decision's (exactly it for a cost, CR 118.3).
    fn counters_fit<'a>(&self, entries: impl Iterator<Item = (Option<u64>, &'a str, u32)>) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        let mut by_kind: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
        let mut sum = 0u32;
        for (on, kind, n) in entries {
            let Some(o) = self.counter_option(on, kind) else { return Err("Those counters aren't one of the choices.".into()) };
            if n == 0 {
                return Err("Choose at least one counter for each.".into());
            }
            if !seen.insert((on, kind)) {
                return Err("Something was chosen twice.".into());
            }
            if n > o.cap.unwrap_or(u32::MAX) {
                return Err(format!("{} has only {} of those.", o.name, o.cap.unwrap_or(0)));
            }
            let k = by_kind.entry(kind).or_default();
            *k += n;
            if self.answer == Answer::MoveCounters && *k > o.cap.unwrap_or(u32::MAX) {
                return Err(format!("There are only {} of those to move.", o.cap.unwrap_or(0)));
            }
            sum += n;
        }
        match self.total {
            Some(total) if self.answer == Answer::RemoveCounterCost && sum != total => Err(format!("Remove exactly {total}.")),
            Some(total) if sum > total => Err(format!("Choose {total} at most.")),
            _ => Ok(()),
        }
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
            (Answer::TapMana, Act::TapMana { source, .. }) => {
                if self.eligible(&source.to_string()) { Ok(()) } else { Err("That can't be sacrificed for this.".into()) }
            }
            (Answer::TapMana, Act::KeepMana) => Ok(()),
            (Answer::ChooseManaColor, Act::ChooseManaColor { mana, combination }) => {
                let ok = match self.purpose {
                    "color" => !combination && mana.len() == 1 && self.eligible(&mana[0]),
                    "combo" => *combination && self.eligible(&mana.concat()),
                    _ => *combination && Some(mana.len() as u32) == self.total && mana.iter().all(|m| self.eligible(m)),
                };
                if ok { Ok(()) } else { Err("Choose from the colours offered.".into()) }
            }
            (Answer::PayManaAbilityMana, Act::PayManaAbilityMana { mana }) => {
                if self.eligible(&mana.concat()) { Ok(()) } else { Err("That isn't one of the ways to pay it.".into()) }
            }
            (Answer::PayPhyrexian, Act::PayPhyrexian { life }) => {
                if life.len() != self.shards.len() {
                    return Err("Choose mana or life for each Phyrexian symbol.".into());
                }
                for (paid_life, how) in life.iter().zip(&self.shards) {
                    match (how, paid_life) {
                        (ShardOptions::ManaOnly, true) => return Err("That symbol can only be paid with mana.".into()),
                        (ShardOptions::LifeOnly, false) => return Err("That symbol can only be paid with 2 life.".into()),
                        _ => {}
                    }
                }
                Ok(())
            }
            (Answer::DecideOptionalCost, Act::DecideOptionalCost { .. }) => Ok(()),
            (Answer::ChooseCostBranch, Act::ChooseCostBranch { index }) => {
                if self.eligible(&index.to_string()) { Ok(()) } else { Err("That cost can't be paid now.".into()) }
            }
            // Ways to cast (ways.rs).
            (Answer::CastOffer, Act::CastOffer { cast, .. }) => {
                if *cast && !self.options.iter().any(|o| o.eligible) { Err("It can't be cast now.".into()) } else { Ok(()) }
            }
            // Madness and miracle are declined with the engine's "no".
            (Answer::CastOffer, Act::DecideOptionalEffect { accept: false }) if matches!(self.purpose, "madness" | "miracle" | "miracle_reveal") => Ok(()),
            (Answer::ChooseAdventureFace, Act::ChooseAdventureFace { creature }) => self.one_of(if *creature { "creature" } else { "adventure" }),
            (Answer::ChooseModalFace, Act::ChooseModalFace { back_face }) => self.one_of(if *back_face { "back" } else { "front" }),
            (Answer::ChooseAlternativeCast, Act::ChooseAlternativeCast { alternative }) => self.one_of(if *alternative { "alternative" } else { "normal" }),
            (Answer::ChooseCastingVariant, Act::ChooseCastingVariant { index }) => self.one_of(&index.to_string()),
            (Answer::ChooseMutateSide, Act::ChooseMutateSide { top }) => self.one_of(if *top { "top" } else { "bottom" }),
            // Permanents.
            (Answer::ChooseLegend, Act::ChooseLegend { keep: id }) | (Answer::ChooseRingBearer, Act::ChooseRingBearer { target: id }) => self.one_of(&id.to_string()),
            (Answer::Equip, Act::Equip { equipment, target }) => {
                if self.source.as_ref().is_some_and(|s| s.id != *equipment) {
                    return Err("That's a different card.".into());
                }
                self.one_of(&target.to_string())
            }
            // Counters.
            (Answer::SelectTargets, Act::SelectTargets { targets }) => {
                let mut seen = std::collections::HashSet::new();
                for t in targets {
                    let id = target_id(t);
                    if !seen.insert(id.clone()) {
                        return Err("Something was chosen twice.".into());
                    }
                    if !self.eligible(&id) {
                        return Err("That isn't one of the choices.".into());
                    }
                }
                between(targets.len(), ("choice", "choices"))
            }
            (Answer::MoveCounters, Act::MoveCounters { moves }) => self.counters_fit(moves.iter().map(|m| (Some(m.on), m.counter.as_str(), m.count))),
            (Answer::RemoveCounters, Act::RemoveCounters { counters }) => self.counters_fit(counters.iter().map(|c| (None, c.counter.as_str(), c.count))),
            (Answer::RemoveCounterCost, Act::RemoveCounterCost { counters }) => self.counters_fit(counters.iter().map(|c| (Some(c.on), c.counter.as_str(), c.count))),
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
    // Paying (play/src/pay.rs, GPay, GMana, GCosts).
    /// Cast a spell the engine offers, paying as the seat's "Tap mana for me" setting says.
    CastSpell {
        object: u64,
        #[serde(default)]
        payment: PayMode,
    },
    /// Use a mana source while paying: tap a land, activate a mana ability, sacrifice a source,
    /// tap a creature for convoke or exile a card for delve. `choice` is a key from
    /// `PaymentView::sources` (`pay::mana_key`); without one, the source's first.
    TapMana {
        source: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<String>,
    },
    /// Untap a source tapped by hand whose mana is still in the pool (CR 605.3b): only sources
    /// that just make mana.
    UntapMana {
        source: u64,
    },
    /// Don't sacrifice a source for mana; pay by hand instead (the Treasure prompt's "Keep it").
    KeepMana,
    /// The mana a source or effect adds: one colour, or (`combination`) one letter per mana.
    ChooseManaColor {
        mana: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        combination: bool,
    },
    /// The mana that pays a mana ability's own hybrid cost, one letter per hybrid symbol.
    PayManaAbilityMana {
        mana: Vec<String>,
    },
    /// Phyrexian mana: for each Phyrexian symbol in order, whether it's paid with 2 life.
    PayPhyrexian {
        life: Vec<bool>,
    },
    /// Pay an optional additional cost such as kicker (or the first of two costs), or don't.
    DecideOptionalCost {
        pay: bool,
    },
    /// Which of an activation's alternative costs to pay.
    ChooseCostBranch {
        index: usize,
    },
    // Ways to cast, permanents and counters (ways.rs; GCastWays, GPermanents, GCounters).
    /// Cast the card a cascade, discover, ripple, madness or miracle offers, or don't. Madness and
    /// miracle pay as the seat's "Tap mana for me" setting says.
    CastOffer {
        cast: bool,
        #[serde(default)]
        payment: PayMode,
    },
    /// An adventurer card's creature (or else its adventure).
    ChooseAdventureFace {
        creature: bool,
    },
    /// A modal two-faced card's back face (or else its front).
    ChooseModalFace {
        back_face: bool,
    },
    /// The keyword's alternative cost (or else the mana cost).
    ChooseAlternativeCast {
        alternative: bool,
    },
    /// One of the ways to cast it, by its place in the engine's list.
    ChooseCastingVariant {
        index: usize,
    },
    /// The mutating creature on top (or else underneath).
    ChooseMutateSide {
        top: bool,
    },
    /// The legend to keep.
    ChooseLegend {
        keep: u64,
    },
    /// The Ring-bearer.
    ChooseRingBearer {
        target: u64,
    },
    /// Attach `equipment` to `target`.
    Equip {
        equipment: u64,
        target: u64,
    },
    /// Any number of permanents and players (proliferate).
    SelectTargets {
        targets: Vec<TargetView>,
    },
    /// Counters to move: onto which permanent, which kind and how many.
    MoveCounters {
        moves: Vec<CounterMove>,
    },
    /// Counters to remove as an effect resolves: which kind and how many.
    RemoveCounters {
        counters: Vec<CounterCount>,
    },
    /// Counters to remove from among permanents as a cost: off which permanent, which kind and how
    /// many.
    RemoveCounterCost {
        counters: Vec<CounterMove>,
    },
}

/// Some counters on one permanent: the ones that move onto it, or come off it as a cost.
/// `counter` is the engine's key for the kind ("P1P1", "loyalty").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterMove {
    pub on: u64,
    pub counter: String,
    pub count: u32,
}

/// Some counters of one kind, by the engine's key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterCount {
    pub counter: String,
    pub count: u32,
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
    /// The engine action this answer stands for. `None` for a cast and a mana tap, which are
    /// matched to the engine's own options when they're answered (`answer`).
    pub fn to_action(&self) -> Option<GameAction> {
        Some(match self {
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
            Act::CastSpell { .. } | Act::TapMana { .. } => return None,
            Act::UntapMana { source } => GameAction::UntapLandForMana { object_id: ObjectId(*source) },
            Act::KeepMana => GameAction::BackToManaPayment,
            Act::ChooseManaColor { mana, combination } => {
                let types = mana.iter().map(|m| mana_type(m)).collect::<Option<Vec<_>>>()?;
                GameAction::ChooseManaColor {
                    choice: if *combination { ManaChoice::Combination(types) } else { ManaChoice::SingleColor(*types.first()?) },
                    count: 1,
                }
            }
            Act::PayManaAbilityMana { mana } => GameAction::PayManaAbilityMana { payment: mana.iter().map(|m| mana_type(m)).collect::<Option<Vec<_>>>()? },
            Act::PayPhyrexian { life } => GameAction::SubmitPhyrexianChoices {
                choices: life.iter().map(|l| if *l { ShardChoice::PayLife } else { ShardChoice::PayMana }).collect(),
            },
            Act::DecideOptionalCost { pay } => GameAction::DecideOptionalCost { pay: *pay },
            Act::ChooseCostBranch { index } => GameAction::ChooseActivationCostBranch { index: *index },
            // A cast offer is matched to the engine's own options when it's answered (`answer`).
            Act::CastOffer { .. } => return None,
            Act::ChooseAdventureFace { creature } => GameAction::ChooseAdventureFace { creature: *creature },
            Act::ChooseModalFace { back_face } => GameAction::ChooseModalFace { back_face: *back_face },
            Act::ChooseAlternativeCast { alternative } => GameAction::ChooseAlternativeCast {
                choice: if *alternative { AlternativeCastDecision::Alternative } else { AlternativeCastDecision::Normal },
            },
            Act::ChooseCastingVariant { index } => GameAction::ChooseCastingVariant { index: *index },
            Act::ChooseMutateSide { top } => GameAction::ChooseMutateMergeSide { side: crate::ways::merge_side(*top) },
            Act::ChooseLegend { keep } => GameAction::ChooseLegend { keep: ObjectId(*keep) },
            Act::ChooseRingBearer { target } => GameAction::ChooseRingBearer { target: ObjectId(*target) },
            Act::Equip { equipment, target } => GameAction::Equip { equipment_id: ObjectId(*equipment), target_id: ObjectId(*target) },
            Act::SelectTargets { targets } => GameAction::SelectTargets { targets: targets.iter().map(TargetView::to_ref).collect() },
            Act::MoveCounters { moves } => GameAction::ChooseCounterMoveDistribution {
                selections: moves
                    .iter()
                    .map(|m| Some(CounterMoveChoice { destination_id: ObjectId(m.on), counter_type: crate::ways::counter_of(&m.counter)?, count: m.count }))
                    .collect::<Option<Vec<_>>>()?,
            },
            Act::RemoveCounters { counters } => GameAction::ChooseCountersToRemove {
                selections: counters
                    .iter()
                    .map(|c| Some(CounterRemoveChoice { counter_type: crate::ways::counter_of(&c.counter)?, count: c.count }))
                    .collect::<Option<Vec<_>>>()?,
            },
            Act::RemoveCounterCost { counters } => GameAction::ChooseRemoveCounterCostDistribution {
                distribution: counters
                    .iter()
                    .map(|c| Some(CounterCostChoice { object_id: ObjectId(c.on), counter_type: crate::ways::counter_of(&c.counter)?, count: c.count }))
                    .collect::<Option<Vec<_>>>()?,
            },
        })
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
            // The seat's own setting is the engine's choice ("ask") when it's what the engine offered.
            GameAction::CastSpell { object_id, .. } => Act::CastSpell { object: object_id.0, payment: PayMode::Ask },
            GameAction::TapLandForMana { .. } | GameAction::ActivateManaSource { .. } | GameAction::TapForConvoke { .. } => {
                let (source, key) = pay::mana_key(action)?;
                Act::TapMana { source, choice: Some(key) }
            }
            GameAction::UntapLandForMana { object_id } => Act::UntapMana { source: object_id.0 },
            GameAction::BackToManaPayment => Act::KeepMana,
            // Several sources at once (`count` > 1) keep the buttons.
            GameAction::ChooseManaColor { choice, count: 1 } => match choice {
                ManaChoice::SingleColor(t) => Act::ChooseManaColor { mana: vec![mana_code(*t).into()], combination: false },
                ManaChoice::Combination(v) => Act::ChooseManaColor { mana: v.iter().map(|t| mana_code(*t).into()).collect(), combination: true },
            },
            GameAction::PayManaAbilityMana { payment } => Act::PayManaAbilityMana { mana: payment.iter().map(|t| mana_code(*t).into()).collect() },
            GameAction::SubmitPhyrexianChoices { choices } => Act::PayPhyrexian { life: choices.iter().map(|c| *c == ShardChoice::PayLife).collect() },
            GameAction::DecideOptionalCost { pay } => Act::DecideOptionalCost { pay: *pay },
            GameAction::ChooseActivationCostBranch { index } => Act::ChooseCostBranch { index: *index },
            GameAction::CascadeChoice { choice } | GameAction::DiscoverChoice { choice } | GameAction::RippleChoice { choice } => {
                Act::CastOffer { cast: *choice == CastChoice::Cast, payment: PayMode::Ask }
            }
            GameAction::CastSpellAsMadness { .. } | GameAction::CastSpellAsMiracle { .. } => Act::CastOffer { cast: true, payment: PayMode::Ask },
            GameAction::ChooseAdventureFace { creature } => Act::ChooseAdventureFace { creature: *creature },
            GameAction::ChooseModalFace { back_face } => Act::ChooseModalFace { back_face: *back_face },
            GameAction::ChooseAlternativeCast { choice } => Act::ChooseAlternativeCast { alternative: *choice == AlternativeCastDecision::Alternative },
            GameAction::ChooseCastingVariant { index } => Act::ChooseCastingVariant { index: *index },
            GameAction::ChooseMutateMergeSide { side } => Act::ChooseMutateSide { top: *side == crate::ways::merge_side(true) },
            GameAction::ChooseLegend { keep } => Act::ChooseLegend { keep: keep.0 },
            GameAction::ChooseRingBearer { target } => Act::ChooseRingBearer { target: target.0 },
            GameAction::Equip { equipment_id, target_id } => Act::Equip { equipment: equipment_id.0, target: target_id.0 },
            GameAction::SelectTargets { targets } => Act::SelectTargets { targets: targets.iter().map(TargetView::from_ref).collect() },
            GameAction::ChooseCounterMoveDistribution { selections } => Act::MoveCounters {
                moves: selections.iter().map(|s| CounterMove { on: s.destination_id.0, counter: crate::ways::counter_key(&s.counter_type), count: s.count }).collect(),
            },
            GameAction::ChooseCountersToRemove { selections } => Act::RemoveCounters {
                counters: selections.iter().map(|s| CounterCount { counter: crate::ways::counter_key(&s.counter_type), count: s.count }).collect(),
            },
            GameAction::ChooseRemoveCounterCostDistribution { distribution } => Act::RemoveCounterCost {
                counters: distribution.iter().map(|s| CounterMove { on: s.object_id.0, counter: crate::ways::counter_key(&s.counter_type), count: s.count }).collect(),
            },
            _ => return None,
        })
    }

    /// A mana ability used while paying is answered as a tap (`TapMana`); anywhere else it's an
    /// ordinary option.
    pub fn from_payment_action(action: &GameAction) -> Option<Act> {
        match action {
            GameAction::ActivateAbility { .. } => pay::mana_key(action).map(|(source, key)| Act::TapMana { source, choice: Some(key) }),
            other => Act::from_action(other),
        }
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
            Act::CastSpell { .. } => "cast_spell",
            Act::TapMana { .. } => "tap_mana",
            Act::UntapMana { .. } => "untap_mana",
            Act::KeepMana => "keep_mana",
            Act::ChooseManaColor { .. } => "choose_mana_color",
            Act::PayManaAbilityMana { .. } => "pay_mana_ability_mana",
            Act::PayPhyrexian { .. } => "pay_phyrexian",
            Act::DecideOptionalCost { .. } => "decide_optional_cost",
            Act::ChooseCostBranch { .. } => "choose_cost_branch",
            Act::CastOffer { .. } => "cast_offer",
            Act::ChooseAdventureFace { .. } => "choose_adventure_face",
            Act::ChooseModalFace { .. } => "choose_modal_face",
            Act::ChooseAlternativeCast { .. } => "choose_alternative_cast",
            Act::ChooseCastingVariant { .. } => "choose_casting_variant",
            Act::ChooseMutateSide { .. } => "choose_mutate_side",
            Act::ChooseLegend { .. } => "choose_legend",
            Act::ChooseRingBearer { .. } => "choose_ring_bearer",
            Act::Equip { .. } => "equip",
            Act::SelectTargets { .. } => "select_targets",
            Act::MoveCounters { .. } => "move_counters",
            Act::RemoveCounters { .. } => "remove_counters",
            Act::RemoveCounterCost { .. } => "remove_counter_cost",
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
    /// The engine actions it took, in order (cancelling a payment untaps what it can first).
    pub actions: Vec<GameAction>,
    /// The last action's result, with the earlier ones' events and log lines before its own.
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
    let doesnt_fit = |why: &str| Refusal::DoesntFit(why.to_string());
    if act.is_preference() {
        check_preference(state, owner, act).map_err(Refusal::DoesntFit)?;
        let action = act.to_action().ok_or_else(|| doesnt_fit("That setting can't be changed."))?;
        let mut next = state.clone();
        return match engine::game::engine::apply(&mut next, owner, action.clone()) {
            Ok(result) => {
                *state = next;
                Ok(Answered { actor: owner, actions: vec![action], result })
            }
            Err(e) => Err(Refusal::Engine(e.to_string())),
        };
    }
    if !state.waiting_for.acting_players().contains(&owner) {
        return Err(Refusal::NotYours);
    }
    let contract = AiDecisionContract::issue(state, owner);
    let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
    let actions: Vec<GameAction> = match act {
        Act::ResolveAll => {
            // Only from the seat holding priority, with something to resolve (CR 117.3d).
            if !matches!(state.waiting_for, WaitingFor::Priority { player } if player == owner) {
                return Err(doesnt_fit("You can ask to resolve everything only when it's your priority."));
            }
            if state.stack.is_empty() {
                return Err(doesnt_fit("There's nothing on the stack to resolve."));
            }
            vec![GameAction::BeginResolveAll { max_resolutions: 0, scope: ResolveAllScope::Shared }]
        }
        Act::CancelCast => {
            // Cancelling is allowed exactly where the engine offers it.
            if !candidates.iter().any(|a| matches!(a, GameAction::CancelCast)) {
                return Err(doesnt_fit("There's nothing to cancel now."));
            }
            // Backing out of a cast while paying by hand untaps first what the engine can give
            // back, so their mana leaves the pool (CR 601.2, 605.3b); a painland's damage or a
            // sacrificed Treasure stays (`PaymentView::kept`).
            let mut out = Vec::new();
            if matches!(state.waiting_for, WaitingFor::ManaPayment { player, .. } if player == owner) {
                let mut ids = state.lands_tapped_for_mana.get(&owner).cloned().unwrap_or_default();
                ids.dedup();
                out.extend(ids.into_iter().map(|object_id| GameAction::UntapLandForMana { object_id }));
            }
            out.push(GameAction::CancelCast);
            out
        }
        Act::CastSpell { object, payment } => {
            if !matches!(state.waiting_for, WaitingFor::Priority { player } if player == owner) {
                return Err(doesnt_fit("You can cast a spell when it's your priority."));
            }
            vec![pay::cast_action(&candidates, *object, *payment).ok_or_else(|| doesnt_fit("That card can't be cast now."))?]
        }
        Act::TapMana { source, choice } => {
            if !pay::paying(&state.waiting_for, owner) {
                return Err(doesnt_fit("There's nothing to pay for now."));
            }
            vec![pay::find_mana_action(&candidates, *source, choice.as_deref()).cloned().ok_or_else(|| doesnt_fit("That can't be used for mana now."))?]
        }
        Act::CastOffer { cast, payment } => {
            // Checked like any answer, then matched to the engine's own cast or decline.
            let vs = filter_state_for_viewer(state, owner);
            let Some(pending) = Pending::of(&vs, owner, &candidates, &[]) else {
                return Err(doesnt_fit("Answer this one with the buttons."));
            };
            pending.admits(act).map_err(Refusal::DoesntFit)?;
            vec![crate::ways::offer_action(&candidates, *cast, *payment).ok_or_else(|| doesnt_fit("That can't be cast now."))?]
        }
        Act::UntapMana { source } => {
            let tapped = state.lands_tapped_for_mana.get(&owner).is_some_and(|ids| ids.contains(&ObjectId(*source)));
            if !matches!(state.waiting_for, WaitingFor::ManaPayment { player, .. } if player == owner) || !tapped {
                return Err(doesnt_fit("Only a source that just makes mana, tapped while you pay, can be untapped."));
            }
            vec![GameAction::UntapLandForMana { object_id: ObjectId(*source) }]
        }
        _ => {
            let vs = filter_state_for_viewer(state, owner);
            let Some(pending) = Pending::of(&vs, owner, &candidates, &[]) else {
                return Err(doesnt_fit("Answer this one with the buttons."));
            };
            pending.admits(act).map_err(Refusal::DoesntFit)?;
            let action = pending.normalize(act).to_action().ok_or_else(|| doesnt_fit("That answer doesn't fit this decision."))?;
            // Phyrexian mana: only a way the mana on hand can pay.
            if let (GameAction::SubmitPhyrexianChoices { choices }, WaitingFor::PhyrexianPayment { spell_object, .. }) = (&action, &state.waiting_for)
                && !engine::game::casting::pending_phyrexian_route_is_payable(state, owner, *spell_object, choices)
            {
                return Err(doesnt_fit("There isn't the mana to pay that way."));
            }
            vec![action]
        }
    };
    let actor = contract.authorized_actor;
    let mut next = state.clone();
    let mut result: Option<ActionResult> = None;
    for action in &actions {
        match apply_interaction(&mut next, actor, owner, action.clone()) {
            Ok(r) => {
                result = Some(match result {
                    None => r,
                    Some(mut before) => {
                        before.events.extend(r.events);
                        before.log_entries.extend(r.log_entries);
                        ActionResult { events: before.events, log_entries: before.log_entries, ..r }
                    }
                });
            }
            Err(e) => return Err(Refusal::Engine(e.to_string())),
        }
    }
    *state = next;
    Ok(Answered { actor, actions, result: result.expect("an answer is at least one action") })
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
        assert_eq!(question("You may have Clone enter as a copy of any creature on the battlefield."), "Have Clone enter as a copy of any creature on the battlefield?");
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
            Some(GameAction::DecideOptionalEffectAndRemember { choice: AutoMayChoice::Accept, scope: MayTriggerAutoChoiceScope::SameCard })
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
        assert_eq!(Act::ChoosePair { partner: Some(other.0) }.to_action(), Some(GameAction::ChoosePair { partner: Some(other) }));
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
