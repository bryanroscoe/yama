//! Ways to cast, permanents and counters (docs/game-interactions-review-2026-10-23.md, "Engine
//! decisions with no design"; the boards GCastWays, GPermanents and GCounters): the `Pending`
//! shapes for these decisions, read from the deciding seat's filtered view like every other
//! (act.rs), and the engine action a cast offer's answer stands for.
//!
//! - **Ways to cast:** cascade, discover and ripple (cast the card the engine found, or don't),
//!   madness and miracle (cast it for that cost, or don't), an adventure's two halves, a modal
//!   card's two spell faces, the mana cost or an alternative cost (warp, evoke, overload, bestow
//!   and the rest), several ways to cast from one zone, and mutate's over or under.
//! - **Permanents:** the legend rule, a clone's choice, equip, the Ring-bearer, empower Jace,
//!   populate, explore and a token's host: one card picked on the board.
//! - **Counters:** proliferate (any number of permanents and players), moving counters,
//!   removing counters as an effect resolves, and removing counters from among permanents as a
//!   cost: splits with a cap on each option.
//!
//! Every word here is the engine's or the card's: the costs are the engine's, the faces and
//! variants are named as the engine names them, and the cards come from this seat's view.

use engine::game::merge::MergeSide;
use engine::types::ability::{CopyTargetPurpose, CounterCostSelection, TargetRef};
use engine::types::actions::{AlternativeCastDecision, CastChoice, GameAction};
use engine::types::card_type::CoreType;
use engine::types::counter::{CounterMatch, CounterType};
use engine::types::game_state::{
    AlternativeCastKeyword, CastOfferKind, CastingVariant, CastingVariantFace, CostResume, GameState, PayCostKind, WaitingFor,
};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use phase_llm::render::action::humanize_identifier;
use phase_llm::render::text::mana_cost_text;
use serde_json::Value;

use crate::Match;
use crate::act::{Answer, Choice, Kind, Pending, a_or, capitalised, card, cards, target, unless_cost_text, word};
use crate::pay::PayMode;

/// An engine name in sentence case: "MoreThanMeetsTheEye" reads "More than meets the eye".
fn sentence(raw: &str) -> String {
    let words = humanize_identifier(raw);
    let mut out = String::with_capacity(words.len());
    for (i, w) in words.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
            out.push_str(&w.to_lowercase());
        } else {
            out.push_str(w);
        }
    }
    out
}

/// The engine's name for an enum value: the variant's name, without its fields.
fn variant_name(v: &impl std::fmt::Debug) -> String {
    let raw = format!("{v:?}");
    raw.split([' ', '{', '(']).next().unwrap_or_default().to_string()
}

/// A counter kind's key, as the engine writes it ("P1P1", "loyalty"): what answers name it by.
pub(crate) fn counter_key(t: &CounterType) -> String {
    t.as_str().into_owned()
}

/// The counter kind a key names, as the engine reads it back.
pub(crate) fn counter_of(key: &str) -> Option<CounterType> {
    serde_json::from_value(Value::String(key.to_string())).ok()
}

/// A counter kind in words, for players: "+1/+1", "loyalty", "flying".
fn counter_words(t: &CounterType) -> String {
    t.display_phrase().into_owned()
}

/// The counters on a permanent, in words, largest first then by name, for the lines under it.
pub(crate) fn counters_on(vs: &GameState, id: &ObjectId) -> Vec<(String, u32)> {
    let mut out: Vec<(String, u32)> = vs
        .objects
        .get(id)
        .map(|o| o.counters.iter().filter(|(_, n)| **n > 0).map(|(t, n)| (counter_words(t), *n)).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// A player's counters, in words: poison, energy and the rest the engine keeps.
fn player_counters(vs: &GameState, p: PlayerId) -> Vec<(String, u32)> {
    let Some(pl) = vs.players.iter().find(|x| x.id == p) else { return vec![] };
    let mut out = vec![];
    if pl.poison_counters > 0 {
        out.push(("poison".to_string(), pl.poison_counters));
    }
    if pl.energy > 0 {
        out.push(("energy".to_string(), pl.energy));
    }
    // Experience, rad and the like (poison has its own field, read above).
    let mut rest: Vec<(String, u32)> = pl.player_counters.iter().filter(|(_, n)| **n > 0).map(|(k, n)| (k.to_string(), *n)).collect();
    rest.sort();
    out.extend(rest);
    out
}

/// Whether the engine offers this answer now.
fn offered(candidates: &[GameAction], pick: impl Fn(&GameAction) -> bool) -> bool {
    candidates.iter().any(pick)
}

/// A card as an option whose name is one of its faces ("Stomp"), so its details are sent too.
fn face(id: &str, name: &str, cost: String, eligible: bool) -> Choice {
    let mut c = word(id, name);
    c.cost = Some(cost);
    c.eligible = eligible;
    c.card = true;
    c
}

/// The current face and the other face of a two-faced or adventurer card, by name and cost.
fn faces(vs: &GameState, id: &ObjectId) -> Option<((String, String), (String, String))> {
    let o = vs.objects.get(id)?;
    let back = o.back_face.as_ref()?;
    Some(((o.name.clone(), mana_cost_text(&o.mana_cost)), (back.name.clone(), mana_cost_text(&back.mana_cost))))
}

/// The decisions this module describes, or `None` for any other (act.rs asks first).
pub(crate) fn of(vs: &GameState, me: PlayerId, candidates: &[GameAction], names: &[String]) -> Option<Pending> {
    match &vs.waiting_for {
        WaitingFor::CastOffer { player, kind } if *player == me => cast_offer(vs, kind, candidates),
        WaitingFor::MiracleReveal { player, object_id, cost } if *player == me => {
            // CR 702.94a: revealing it puts the miracle trigger on the stack; the cast is asked
            // when that resolves (`CastOfferKind::Miracle`).
            let name = Match::name_in(vs, object_id);
            let cost = mana_cost_text(cost);
            let can = offered(candidates, |a| matches!(a, GameAction::CastSpellAsMiracle { .. }));
            Some(
                Pending::new(Kind::Yesno, Answer::CastOffer, "miracle_reveal", format!("Reveal {name} for its miracle cost {cost}?"), vec![card(vs, object_id, can)])
                    .yes_no("Reveal it", "Don't reveal")
                    .from(vs, Some(*object_id)),
            )
        }
        WaitingFor::ModalFaceChoice { player, object_id, .. } if *player == me => {
            // CR 712.11b: only a card whose two faces are both spells is chosen here; a land face
            // is chosen as you play it, and keeps the buttons.
            let o = vs.objects.get(object_id)?;
            let back = o.back_face.as_ref()?;
            if o.card_types.core_types.contains(&CoreType::Land) || back.card_types.core_types.contains(&CoreType::Land) {
                return None;
            }
            let ((front, front_cost), (back_name, back_cost)) = faces(vs, object_id)?;
            let options = vec![
                face("front", &front, front_cost, offered(candidates, |a| matches!(a, GameAction::ChooseModalFace { back_face: false }))),
                face("back", &back_name, back_cost, offered(candidates, |a| matches!(a, GameAction::ChooseModalFace { back_face: true }))),
            ];
            Some(Pending::new(Kind::Pick, Answer::ChooseModalFace, "face", "Which face do you cast?", options).range(1, 1, false).from(vs, Some(*object_id)))
        }
        WaitingFor::AlternativeCastChoice { player, object_id, keyword, normal_cost, alternative_cost, alternative_additional_cost, .. } if *player == me => {
            // CR 118.9: the printed mana cost, or the cost a keyword allows instead; the engine
            // asks only when both can be paid.
            let way = alternative_name(*keyword);
            let alt = match (alternative_cost, alternative_additional_cost) {
                (Some(m), Some(extra)) => format!("{}, {}", mana_cost_text(m), unless_cost_text(vs, extra)),
                (Some(m), None) => mana_cost_text(m),
                (None, Some(extra)) => capitalised(&unless_cost_text(vs, extra)),
                (None, None) => String::new(),
            };
            let mut normal = word("normal", "Mana cost");
            normal.cost = Some(mana_cost_text(normal_cost));
            normal.eligible = offered(candidates, |a| matches!(a, GameAction::ChooseAlternativeCast { choice: AlternativeCastDecision::Normal }));
            let mut other = word("alternative", way.clone());
            other.cost = Some(alt);
            other.eligible = offered(candidates, |a| matches!(a, GameAction::ChooseAlternativeCast { choice: AlternativeCastDecision::Alternative }));
            let prompt = match keyword {
                AlternativeCastKeyword::FaceDown => "Pay the mana cost, or cast it face down?".to_string(),
                _ => format!("Pay the mana cost, or {}?", way.to_lowercase()),
            };
            // Casting a morph face down (CR 702.37c) has its own board (GRareCards): what you see
            // of it, and what everyone else does.
            let purpose = if matches!(keyword, AlternativeCastKeyword::FaceDown) { "face_down" } else { "alt_cost" };
            Some(Pending::new(Kind::Pick, Answer::ChooseAlternativeCast, purpose, prompt, vec![normal, other]).range(1, 1, false).from(vs, Some(*object_id)))
        }
        WaitingFor::CastingVariantChoice { player, object_id, options, .. } if *player == me => {
            // CR 601.2b: several ways to cast it from the same zone, each as the engine lists it.
            let name = Match::name_in(vs, object_id);
            let back = vs.objects.get(object_id).and_then(|o| o.back_face.as_ref()).map(|b| b.name.clone());
            let choices = options
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    let mut label = match &o.variant {
                        CastingVariant::Normal => "Cast it normally".to_string(),
                        CastingVariant::GraveyardPermission { source, .. } => format!("With {}", Match::name_in(vs, source)),
                        v => sentence(&variant_name(v)),
                    };
                    if o.face == CastingVariantFace::Right
                        && let Some(b) = &back
                    {
                        label.push_str(&format!(": {b}"));
                    }
                    let mut c = word(i.to_string(), label);
                    c.cost = Some(match &o.additional_cost {
                        Some(extra) => format!("{}, {}", mana_cost_text(&o.mana_cost), unless_cost_text(vs, extra)),
                        None => mana_cost_text(&o.mana_cost),
                    });
                    c.eligible = offered(candidates, |a| matches!(a, GameAction::ChooseCastingVariant { index } if *index == i));
                    c
                })
                .collect();
            Some(Pending::new(Kind::Pick, Answer::ChooseCastingVariant, "variant", format!("Choose how to cast {name}"), choices).range(1, 1, false).from(vs, Some(*object_id)))
        }
        WaitingFor::MutateMergeChoice { player, merging_id, target_id } if *player == me => {
            // CR 702.140c: the merged creature takes its name, power and toughness from whichever
            // is on top, and has every ability of both (CR 730.2a).
            let merging = Match::name_in(vs, merging_id);
            let onto = Match::name_in(vs, target_id);
            let mut top = card(vs, merging_id, true);
            top.id = "top".into();
            top.power = vs.objects.get(merging_id).and_then(|o| o.power);
            let mut bottom = card(vs, target_id, true);
            bottom.id = "bottom".into();
            bottom.power = vs.objects.get(target_id).and_then(|o| o.power);
            Some(
                Pending::new(Kind::Pick, Answer::ChooseMutateSide, "mutate", format!("Put {merging} on top of {onto}, or underneath?"), vec![top, bottom])
                    .range(1, 1, false)
                    .from(vs, Some(*merging_id)),
            )
        }
        WaitingFor::ChooseLegend { player, legend_name, candidates: ids } if *player == me => {
            // CR 704.5j: the rest go to their owners' graveyards.
            Some(Pending::new(Kind::Pick, Answer::ChooseLegend, "legend", format!("Choose the {legend_name} to keep"), cards(vs, ids)).range(1, 1, false))
        }
        WaitingFor::CopyTargetChoice { player, source_id, valid_targets, max_mana_value, purpose } if *player == me => {
            // CR 707.9: a choice, not a target, so hexproof doesn't matter. The engine has no "none".
            if valid_targets.is_empty() {
                return None;
            }
            let name = Match::name_in(vs, source_id);
            let mut prompt = match purpose {
                CopyTargetPurpose::BecomeCopy => format!("Choose a permanent for {name} to copy"),
                CopyTargetPurpose::PersistChosenAttribute => format!("Choose a creature for {name}"),
                CopyTargetPurpose::CopyTokenSource => "Choose a permanent to copy".to_string(),
            };
            if let Some(n) = max_mana_value {
                prompt.push_str(&format!(" with mana value {n} or less"));
            }
            Some(Pending::new(Kind::Pick, Answer::ChooseTarget, "clone", prompt, cards(vs, valid_targets)).range(1, 1, false).from(vs, Some(*source_id)))
        }
        WaitingFor::EquipTarget { player, equipment_id, valid_targets } if *player == me => {
            let name = Match::name_in(vs, equipment_id);
            Some(Pending::new(Kind::Pick, Answer::Equip, "equip", format!("Equip {name}: choose a creature"), cards(vs, valid_targets)).range(1, 1, false).from(vs, Some(*equipment_id)))
        }
        WaitingFor::ChooseRingBearer { player, candidates: ids } if *player == me => {
            // CR 701.54a: the Ring tempts you; the creature chosen is your Ring-bearer.
            let mut p = Pending::new(Kind::Pick, Answer::ChooseRingBearer, "ring", "The Ring tempts you: choose your Ring-bearer", cards(vs, ids)).range(1, 1, false);
            p.current = vs.ring_bearer.get(&me).copied().flatten().filter(|id| ids.contains(id)).map(|id| id.0.to_string());
            Some(p)
        }
        WaitingFor::EmpowerJaceChoice { player, source_id, choices, count: n } if *player == me => {
            // CR 701.71a: N loyalty counters on one Jace planeswalker token you control.
            let mut options = cards(vs, choices);
            for o in &mut options {
                o.counters = counters_on(vs, &ObjectId(o.id.parse().unwrap_or(0)));
            }
            let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "empower", format!("Empower Jace {n}: choose a Jace token"), options).range(1, 1, false).from(vs, Some(*source_id));
            p.total = Some(*n);
            Some(p)
        }
        WaitingFor::ChooseTokenHost { player, source_id, legal_targets, .. } if *player == me => {
            let options = legal_targets.iter().map(|t| target(vs, t, names)).collect();
            Some(Pending::new(Kind::Pick, Answer::ChooseTarget, "host", "Choose the one it's attached to", options).range(1, 1, false).from(vs, Some(*source_id)))
        }
        WaitingFor::PopulateChoice { player, source_id, valid_tokens } if *player == me => {
            // CR 701.36a: a copy of a creature token you control.
            if valid_tokens.is_empty() {
                return None;
            }
            Some(Pending::new(Kind::Pick, Answer::ChooseTarget, "populate", "Populate: choose a creature token to copy", cards(vs, valid_tokens)).range(1, 1, false).from(vs, Some(*source_id)))
        }
        WaitingFor::ExploreChoice { player, source_id, choosable, .. } if *player == me => {
            // CR 701.44d: which of them explores next.
            if choosable.is_empty() {
                return None;
            }
            Some(Pending::new(Kind::Pick, Answer::ChooseTarget, "explore", "Choose which explores next", cards(vs, choosable)).range(1, 1, false).from(vs, Some(*source_id)))
        }
        WaitingFor::ProliferateChoice { player, eligible } if *player == me => {
            // CR 701.34a: any number of permanents and players with counters; each gets one more of
            // each kind already there.
            let options: Vec<Choice> = eligible
                .iter()
                .map(|t| {
                    let mut c = target(vs, t, names);
                    c.counters = match t {
                        TargetRef::Object(id) => counters_on(vs, id),
                        TargetRef::Player(p) => player_counters(vs, *p),
                    };
                    c
                })
                .collect();
            let n = options.len();
            // The spell or ability proliferating is named by `with_resolving_source`.
            Some(Pending::new(Kind::Pick, Answer::SelectTargets, "proliferate", "Proliferate", options).range(0, n, true))
        }
        WaitingFor::MoveCountersDistribution { player, source_id, available, destinations, pending_effect, .. } if *player == me => {
            // CR 122.5: any number of the source's counters onto the destinations; each kind of
            // counter is shared by every destination.
            let from = Match::name_in(vs, source_id);
            let kinds: Vec<&(CounterType, u32)> = available.iter().filter(|(_, n)| *n > 0).collect();
            if kinds.is_empty() || destinations.is_empty() {
                return None;
            }
            let mut options = vec![];
            for dest in destinations {
                for (t, n) in &kinds {
                    let mut c = card(vs, dest, true);
                    if kinds.len() > 1 {
                        c.id = format!("{}:{}", dest.0, counter_key(t));
                    }
                    c.text = Some(format!("{} counters", counter_words(t)));
                    c.group = Some(counter_key(t));
                    c.cap = Some(*n);
                    c.counters = counters_on(vs, dest);
                    options.push(c);
                }
            }
            let prompt = match destinations.as_slice() {
                [one] => format!("Move counters from {from} to {}", Match::name_in(vs, one)),
                _ => format!("Move counters from {from}"),
            };
            Some(counter_split(vs, Answer::MoveCounters, "move_counters", prompt, options, kinds.iter().map(|(_, n)| n).sum(), *source_id, pending_effect.source_id))
        }
        WaitingFor::RemoveCountersChoice { player, source_id, available, pending_effect, .. } if *player == me => {
            // CR 107.1c: any number of each kind, none included.
            let from = Match::name_in(vs, source_id);
            let options: Vec<Choice> = available
                .iter()
                .filter(|(_, n)| *n > 0)
                .map(|(t, n)| {
                    let mut c = word(counter_key(t), format!("{} counters", counter_words(t)));
                    c.group = Some(counter_key(t));
                    c.cap = Some(*n);
                    c
                })
                .collect();
            if options.is_empty() {
                return None;
            }
            let total = available.iter().map(|(_, n)| n).sum();
            Some(counter_split(vs, Answer::RemoveCounters, "remove_counters", format!("Remove any number of counters from {from}"), options, total, *source_id, pending_effect.source_id))
        }
        _ => None,
    }
}

/// Proliferate's spell or ability is resolving off the stack, where a seat's filtered view no
/// longer holds the frame that names it; it was cast or activated in the open, so it's named from
/// the game itself (as that seat sees the card).
pub(crate) fn with_resolving_source(mut p: Pending, full: &GameState, vs: &GameState) -> Pending {
    if p.purpose == "proliferate" && p.source.is_none() {
        p = p.from(vs, full.active_proliferate_frame().map(|f| f.source_id));
    }
    p
}

/// A split of counters: up to `total`, each option capped, starting at none (the engine's own
/// first answer).
#[allow(clippy::too_many_arguments)]
fn counter_split(vs: &GameState, answer: Answer, purpose: &'static str, prompt: String, options: Vec<Choice>, total: u32, from: ObjectId, asking: ObjectId) -> Pending {
    let mut p = Pending::new(Kind::Split, answer, purpose, prompt, options).from(vs, Some(asking));
    p.min = 0;
    p.max = total as usize;
    p.total = Some(total);
    p.up_to = true;
    p.per_option_min = Some(0);
    p.unit = Some("counters");
    p.origin = Some(from.0.to_string());
    p
}

/// The keyword whose cost may be paid instead of the mana cost, in words.
fn alternative_name(k: AlternativeCastKeyword) -> String {
    match k {
        AlternativeCastKeyword::FaceDown => "Face down".to_string(),
        AlternativeCastKeyword::MoreThanMeetsTheEye => "More Than Meets the Eye".to_string(),
        other => sentence(&variant_name(&other)),
    }
}

/// A cast offer: cascade, discover and ripple find a card to cast free; madness and miracle cast
/// it for that cost; an adventure's card is cast as either half.
fn cast_offer(vs: &GameState, kind: &CastOfferKind, candidates: &[GameAction]) -> Option<Pending> {
    match kind {
        CastOfferKind::Cascade { hit_card, exiled_misses, source_id, .. } => Some(free_cast(vs, "cascade", *hit_card, exiled_misses, *source_id, candidates)),
        CastOfferKind::Discover { hit_card, exiled_misses, source_id, .. } => Some(free_cast(vs, "discover", *hit_card, exiled_misses, *source_id, candidates)),
        CastOfferKind::Ripple { hit_card, revealed_misses, source_id, .. } => Some(free_cast(vs, "ripple", *hit_card, revealed_misses, *source_id, candidates)),
        CastOfferKind::Madness { object_id, cost } => {
            let name = Match::name_in(vs, object_id);
            let cost = mana_cost_text(cost);
            let can = offered(candidates, |a| matches!(a, GameAction::CastSpellAsMadness { .. }));
            Some(
                Pending::new(Kind::Yesno, Answer::CastOffer, "madness", format!("Cast {name} for its madness cost {cost}?"), vec![card(vs, object_id, can)])
                    .yes_no(format!("Cast for {cost}"), "Put it into your graveyard")
                    .from(vs, Some(*object_id)),
            )
        }
        CastOfferKind::Miracle { object_id, cost } => {
            let name = Match::name_in(vs, object_id);
            let cost = mana_cost_text(cost);
            let can = offered(candidates, |a| matches!(a, GameAction::CastSpellAsMiracle { .. }));
            Some(
                Pending::new(Kind::Yesno, Answer::CastOffer, "miracle", format!("Cast {name} for its miracle cost {cost}?"), vec![card(vs, object_id, can)])
                    .yes_no(format!("Cast for {cost}"), "Don't cast")
                    .from(vs, Some(*object_id)),
            )
        }
        CastOfferKind::Adventure { object_id, .. } => {
            // CR 715.3a: the creature or its adventure, each with its own cost.
            let ((creature, creature_cost), (adventure, adventure_cost)) = faces(vs, object_id)?;
            let options = vec![
                face("creature", &creature, creature_cost, offered(candidates, |a| matches!(a, GameAction::ChooseAdventureFace { creature: true }))),
                face("adventure", &adventure, adventure_cost, offered(candidates, |a| matches!(a, GameAction::ChooseAdventureFace { creature: false }))),
            ];
            Some(Pending::new(Kind::Pick, Answer::ChooseAdventureFace, "adventure", "Which half do you cast?", options).range(1, 1, false).from(vs, Some(*object_id)))
        }
        // Paradigm, a free-cast window and a paid cast from a graveyard keep the buttons.
        _ => None,
    }
}

/// Cascade, discover or ripple: the cards the engine went through (shown, not choosable), then the
/// one it found. Exiled cards are face up, so everyone sees them; a ripple's are revealed.
fn free_cast(vs: &GameState, purpose: &'static str, hit: ObjectId, misses: &[ObjectId], source: ObjectId, candidates: &[GameAction]) -> Pending {
    let name = Match::name_in(vs, &hit);
    let can = offered(candidates, |a| {
        matches!(
            a,
            GameAction::CascadeChoice { choice: CastChoice::Cast } | GameAction::DiscoverChoice { choice: CastChoice::Cast } | GameAction::RippleChoice { choice: CastChoice::Cast }
        )
    });
    let mut options: Vec<Choice> = misses.iter().map(|id| card(vs, id, false)).collect();
    options.push(card(vs, &hit, can));
    let (prompt, no) = match purpose {
        // CR 701.57a: the card is cast or goes to your hand.
        "discover" => (format!("Cast {name} without paying its mana cost, or put it into your hand?"), "Put it into your hand"),
        _ => (format!("Cast {name} without paying its mana cost?"), "Don't cast"),
    };
    Pending::new(Kind::Yesno, Answer::CastOffer, purpose, prompt, options).yes_no("Cast it free", no).from(vs, Some(source))
}

/// The engine action a cast offer's answer stands for: the engine's own cast (with the seat's
/// way of paying for madness and miracle), or its way of declining.
pub(crate) fn offer_action(candidates: &[GameAction], cast: bool, payment: PayMode) -> Option<GameAction> {
    candidates.iter().find_map(|a| match (a, cast) {
        (GameAction::CascadeChoice { choice: CastChoice::Cast }, true)
        | (GameAction::DiscoverChoice { choice: CastChoice::Cast }, true)
        | (GameAction::RippleChoice { choice: CastChoice::Cast }, true)
        | (GameAction::CascadeChoice { choice: CastChoice::Decline }, false)
        | (GameAction::DiscoverChoice { choice: CastChoice::Decline }, false)
        | (GameAction::RippleChoice { choice: CastChoice::Decline }, false)
        | (GameAction::DecideOptionalEffect { accept: false }, false) => Some(a.clone()),
        (GameAction::CastSpellAsMadness { object_id, card_id, payment_mode }, true) => {
            Some(GameAction::CastSpellAsMadness { object_id: *object_id, card_id: *card_id, payment_mode: payment.for_cast(*payment_mode) })
        }
        (GameAction::CastSpellAsMiracle { object_id, card_id, payment_mode }, true) => {
            Some(GameAction::CastSpellAsMiracle { object_id: *object_id, card_id: *card_id, payment_mode: payment.for_cast(*payment_mode) })
        }
        _ => None,
    })
}

/// Removing counters as a cost (CR 118.3, 122.1): from one permanent (a pick), or from among
/// several (a split that must add up to the cost). `None` for anything else.
pub(crate) fn counter_cost(vs: &GameState, kind: &PayCostKind, choices: &[ObjectId], n: usize, resume: &CostResume) -> Option<Pending> {
    let PayCostKind::RemoveCounter { counter_type, count, selection } = kind else { return None };
    let source = match resume {
        CostResume::Spell { spell } | CostResume::SpellCost { spell, .. } => Some((spell.object_id, spell.activation_ability_index.is_some())),
        CostResume::ManaAbility { mana_ability } => Some((mana_ability.source_id, true)),
        CostResume::Resolution => None,
    };
    let why = match source {
        Some((id, false)) => format!(" to cast {}", Match::name_in(vs, &id)),
        Some((id, true)) => format!(" to activate {}", Match::name_in(vs, &id)),
        None => String::new(),
    };
    let what = match counter_type {
        CounterMatch::Any => a_or(*count as usize, "counter", "counters"),
        CounterMatch::OfType(t) => a_or(*count as usize, &format!("{} counter", counter_words(t)), &format!("{} counters", counter_words(t))),
    };
    match selection {
        CounterCostSelection::SingleObject => {
            let mut options = cards(vs, choices);
            for o in &mut options {
                o.counters = counters_on(vs, &ObjectId(o.id.parse().unwrap_or(0)));
            }
            Some(Pending::new(Kind::Pick, Answer::SelectCards, "cost", format!("Remove {what} from a permanent{why}"), options).range(n, n, false).from(vs, source.map(|s| s.0)))
        }
        CounterCostSelection::AmongObjects => {
            // Each permanent's counters of the kind asked for (or of every kind), capped by how
            // many it has; together they must make the cost exactly.
            let mut options = vec![];
            for id in choices {
                let Some(o) = vs.objects.get(id) else { continue };
                let mut kinds: Vec<(&CounterType, u32)> = o
                    .counters
                    .iter()
                    .filter(|(t, k)| {
                        **k > 0
                            && match counter_type {
                                CounterMatch::Any => true,
                                CounterMatch::OfType(x) => x == *t,
                            }
                    })
                    .map(|(t, k)| (t, *k))
                    .collect();
                kinds.sort_by(|a, b| counter_key(a.0).cmp(&counter_key(b.0)));
                let several = matches!(counter_type, CounterMatch::Any) && kinds.len() > 1;
                for (t, k) in kinds {
                    let mut c = card(vs, id, true);
                    if several {
                        c.id = format!("{}:{}", id.0, counter_key(t));
                    }
                    c.text = Some(format!("{} counters", counter_words(t)));
                    c.group = Some(counter_key(t));
                    c.cap = Some(k);
                    c.counters = counters_on(vs, id);
                    options.push(c);
                }
            }
            let mut p = Pending::new(Kind::Split, Answer::RemoveCounterCost, "counter_cost", format!("Remove {what} from among your permanents{why}"), options).from(vs, source.map(|s| s.0));
            p.min = 0;
            p.max = *count as usize;
            p.total = Some(*count);
            p.per_option_min = Some(0);
            p.unit = Some("counters");
            Some(p)
        }
    }
}

/// Where a counter answer's id points: the object, and the kind when the id names one
/// ("123:P1P1"); otherwise the kind is the option's group.
pub(crate) fn split_id(id: &str) -> (u64, Option<&str>) {
    match id.split_once(':') {
        Some((obj, kind)) => (obj.parse().unwrap_or(0), Some(kind)),
        None => (id.parse().unwrap_or(0), None),
    }
}

/// The merge side an answer names.
pub(crate) fn merge_side(top: bool) -> MergeSide {
    if top { MergeSide::Top } else { MergeSide::Bottom }
}
