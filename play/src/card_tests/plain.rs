//! What a card most plainly says it does, where a generic check can see it: the smoke tests
//! (smoke.rs) check these after playing the card, and the coverage report (play/src/bin/coverage.rs,
//! which includes this file) lists them per card. A card with none is only checked to play
//! without an error or a stuck decision.
//!
//! Only the plainest readings count: the card's type (a permanent enters, a creature has its
//! printed power and toughness, an instant or sorcery resolves, a land is played), a mana ability
//! with only {T} as its cost, and an unconditional "draw", "gain life" or "create tokens" at the
//! top of a spell or of the card's own enters trigger. Anything modal, optional, conditional or
//! counted by a variable is left to the specific tests.

use engine::game::mana_abilities::is_mana_ability;
use engine::types::ability::{AbilityCost, AbilityDefinition, AbilityKind, Effect, PtValue, QuantityExpr, TargetFilter};
use engine::types::card::CardFace;
use engine::types::card_type::CoreType;
use engine::types::triggers::TriggerMode;
use engine::types::zones::Zone;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plain {
    /// A permanent spell is on the battlefield once it resolves.
    Enters,
    /// A creature has its printed base power and toughness on the battlefield.
    PrintedPt(i32, i32),
    /// A planeswalker enters with its printed loyalty.
    Loyalty(u32),
    /// An instant or sorcery leaves the stack for a graveyard or exile when it resolves.
    Resolves,
    /// A land can be played.
    PlaysAsLand,
    /// "{T}: Add ...": the ability at this index of the card's abilities adds mana.
    AddsMana { ability: usize },
    /// Its controller draws this many cards.
    Draws(u32),
    /// Its controller gains this much life.
    GainsLife(u32),
    /// Its controller gets this many more tokens.
    MakesTokens(u32),
}

impl Plain {
    pub fn label(&self) -> String {
        match self {
            Plain::Enters => "enters".into(),
            Plain::PrintedPt(p, t) => format!("printed {p}/{t}"),
            Plain::Loyalty(n) => format!("loyalty {n}"),
            Plain::Resolves => "resolves".into(),
            Plain::PlaysAsLand => "plays as a land".into(),
            Plain::AddsMana { .. } => "adds mana".into(),
            Plain::Draws(n) => format!("draws {n}"),
            Plain::GainsLife(n) => format!("gains {n} life"),
            Plain::MakesTokens(n) => format!("makes {n} token{}", if *n == 1 { "" } else { "s" }),
        }
    }
}

fn fixed(q: &QuantityExpr) -> Option<u32> {
    match q {
        QuantityExpr::Fixed { value } if *value > 0 => Some(*value as u32),
        _ => None,
    }
}

fn is(face: &CardFace, t: CoreType) -> bool {
    face.card_type.core_types.contains(&t)
}

/// The effects of an ability and its plain sub-abilities, in order, up to the first link that
/// depends on anything (a condition, an optional choice, a choice of mode).
fn plain_chain(def: &AbilityDefinition) -> Vec<&Effect> {
    let mut out = vec![];
    let mut link = Some(def);
    while let Some(d) = link {
        if d.condition.is_some() || d.optional || d.optional_targeting || d.modal.is_some() || d.repeat_for.is_some() || d.unless_pay.is_some() {
            break;
        }
        out.push(d.effect.as_ref());
        link = d.sub_ability.as_deref();
    }
    out
}

/// What the effects in `chain` plainly do for their controller.
fn from_effects(chain: &[&Effect], out: &mut Vec<Plain>) {
    for e in chain {
        match e {
            Effect::Draw { count, target: TargetFilter::Controller, .. } => {
                if let Some(n) = fixed(count) {
                    out.push(Plain::Draws(n));
                }
            }
            Effect::GainLife { amount, player: TargetFilter::Controller, .. } => {
                if let Some(n) = fixed(amount) {
                    out.push(Plain::GainsLife(n));
                }
            }
            Effect::Token { count, owner: TargetFilter::Controller, attach_to: None, .. } => {
                if let Some(n) = fixed(count) {
                    out.push(Plain::MakesTokens(n));
                }
            }
            _ => {}
        }
    }
}

/// The plain expectations for a card, read from the face its name loads.
pub fn expectations(face: &CardFace) -> Vec<Plain> {
    let mut out = vec![];
    let spell = is(face, CoreType::Instant) || is(face, CoreType::Sorcery);
    if is(face, CoreType::Land) {
        out.push(Plain::PlaysAsLand);
    } else if spell {
        out.push(Plain::Resolves);
    } else {
        out.push(Plain::Enters);
    }
    if is(face, CoreType::Creature) {
        if let (Some(PtValue::Fixed(p)), Some(PtValue::Fixed(t))) = (&face.power, &face.toughness) {
            out.push(Plain::PrintedPt(*p, *t));
        }
    }
    if is(face, CoreType::Planeswalker) {
        if let Some(n) = face.loyalty.as_deref().and_then(|l| l.parse().ok()) {
            out.push(Plain::Loyalty(n));
        }
    }
    for (i, a) in face.abilities.iter().enumerate() {
        if a.kind == AbilityKind::Activated && matches!(a.cost, Some(AbilityCost::Tap)) && a.condition.is_none() && is_mana_ability(a) {
            out.push(Plain::AddsMana { ability: i });
        }
    }
    if face.modal.is_some() {
        return out;
    }
    if spell {
        // A spell's text is its Spell abilities; only a lone one reads plainly.
        let spells: Vec<&AbilityDefinition> = face.abilities.iter().filter(|a| a.kind == AbilityKind::Spell).collect();
        if let [only] = spells.as_slice() {
            from_effects(&plain_chain(only), &mut out);
        }
    } else if !is(face, CoreType::Land) {
        // "When this enters, ...": its own enters trigger, with nothing in the way.
        for t in &face.triggers {
            let own_entry = t.mode == TriggerMode::ChangesZone
                && t.destination == Some(Zone::Battlefield)
                && matches!(t.valid_card, Some(TargetFilter::SelfRef))
                && t.origin.is_none()
                && !t.optional
                && t.condition.is_none()
                && t.constraint.is_none();
            if let (true, Some(execute)) = (own_entry, &t.execute) {
                from_effects(&plain_chain(execute), &mut out);
            }
        }
    }
    out
}
