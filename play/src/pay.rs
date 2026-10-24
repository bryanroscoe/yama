//! Paying mana by hand (docs/game-interactions-review-2026-10-23.md, build plan section 9;
//! design/screens/GPay, GPayPhone and GMana).
//!
//! While the engine waits for a person to pay (`ManaPayment`, a mana ability's own
//! `ManaAbilityManaPayment`, or the sacrificial-source question `ManaSourceSelection`), their
//! decision carries a [`PaymentView`]: the cost and how much of it their pool covers, the pool,
//! and every source they can use now, with what each one makes and what it costs them beyond the
//! tap (damage, life, the source itself). The board taps them with `Act::TapMana`, untaps the
//! ones the engine can give back (`Act::UntapMana`: only sources that just make mana, CR 605.3b),
//! and pays the rest or cancels with the engine's own options.
//!
//! A mana action is named by its source and a key read from the action itself ([`mana_key`]), so
//! an answer is matched back to exactly the action the engine offered, never rebuilt.
//!
//! [`PayMode`] is the "Tap mana for me" setting: how a spell cast from the board pays.

use std::collections::HashMap;

use engine::types::actions::GameAction;
use engine::types::game_state::{CastPaymentMode, ConvokeMode, GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::mana::{ManaCost, ManaSourceOutput, ManaSourcePenalty, ManaSourceSelection, ManaType};
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use serde::{Deserialize, Serialize};

use crate::Match;

/// How a spell cast from the board pays (GPay's "Tap mana for me"), saved per account.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayMode {
    /// Automatic, but ask before sacrificing a source (a Treasure): the engine's own choice for
    /// each spell, as casting worked before this setting.
    #[default]
    Ask,
    /// Always automatic, sacrifices included.
    Auto,
    /// Open the payment and let the person tap.
    Manual,
}

impl PayMode {
    /// The engine's payment mode for a cast it offered with `offered`.
    pub fn for_cast(self, offered: CastPaymentMode) -> CastPaymentMode {
        match self {
            PayMode::Ask => offered,
            PayMode::Auto => CastPaymentMode::Auto,
            PayMode::Manual => CastPaymentMode::Manual,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PayMode::Ask => "ask",
            PayMode::Auto => "auto",
            PayMode::Manual => "manual",
        }
    }

    pub fn parse(s: &str) -> Option<PayMode> {
        match s {
            "ask" => Some(PayMode::Ask),
            "auto" => Some(PayMode::Auto),
            "manual" => Some(PayMode::Manual),
            _ => None,
        }
    }
}

/// The paying decision as the board draws it (`Decision::payment`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentView {
    /// The spell or ability being paid for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paying_for: Option<PaidFor>,
    /// Its cost as printed ("{3}{W}"); empty while a mana ability pays its own cost.
    pub cost: String,
    /// The cost one symbol at a time, coloured symbols first ("W", "1", "1", "1"), and whether the
    /// mana in the pool covers each. Matched greedily for the board: the engine settles the
    /// payment itself when it's paid.
    pub pips: Vec<Pip>,
    /// Mana in the pool now.
    pub pool: Vec<PoolMana>,
    /// Every source the person can use now, with its choices.
    pub sources: Vec<ManaSource>,
    /// Sources tapped by hand that the engine can untap (their mana goes back).
    pub untap: Vec<u64>,
    /// Taps made by hand during this payment that can't be undone: a painland's damage, a
    /// sacrificed Treasure. Cancelling leaves these as they are.
    pub kept: Vec<Kept>,
    /// Creatures or artifacts can be tapped for the cost, or cards exiled from the graveyard:
    /// "convoke", "improvise", "waterbend" or "delve".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convoke: Option<&'static str>,
    /// The engine pays the rest when asked (its pass during payment).
    pub pay_rest: bool,
    /// The spell or ability can still be cancelled.
    pub cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PaidFor {
    pub id: u64,
    pub name: String,
    /// An activated ability, not a spell.
    pub ability: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pip {
    pub symbol: String,
    pub paid: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PoolMana {
    /// "W", "U", "B", "R", "G" or "C".
    pub mana: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<u64>,
    /// The card it came from.
    pub name: String,
    /// It stands for a creature tapped for convoke or a card exiled for delve, not real mana.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub convoke: bool,
}

/// A card that can help pay now: a land or rock, a creature for convoke, a graveyard card for delve.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManaSource {
    pub id: u64,
    pub name: String,
    /// "battlefield", or "graveyard" for delve.
    pub zone: String,
    pub choices: Vec<ManaChoice>,
}

/// One way to use a source.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManaChoice {
    /// What `Act::TapMana` names it by.
    pub key: String,
    /// "tap" (a land), "ability" (a mana ability), "source" (a sacrificial source), "convoke" or
    /// "delve".
    pub kind: &'static str,
    /// What it adds: "W", "U", "B", "R", "G", "C", or "any" when a colour is chosen after.
    pub mana: Vec<&'static str>,
    /// In words: "Add {W}", the ability's own text, "Pays {1}".
    pub text: String,
    /// What it costs beyond the tap, if anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub penalty: Option<Penalty>,
}

/// What using a source costs beyond the tap, from the engine's own classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Penalty {
    /// "damage" (it deals damage to you), "life" (you pay life), "sacrifice", or "other" (it
    /// does something else that can't be undone).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<u16>,
}

/// A tap made by hand during this payment that can't be undone.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Kept {
    pub id: u64,
    pub name: String,
    pub penalty: Penalty,
}

pub(crate) fn mana_code(t: ManaType) -> &'static str {
    match t {
        ManaType::White => "W",
        ManaType::Blue => "U",
        ManaType::Black => "B",
        ManaType::Red => "R",
        ManaType::Green => "G",
        ManaType::Colorless => "C",
    }
}

pub(crate) fn mana_type(code: &str) -> Option<ManaType> {
    Some(match code {
        "W" => ManaType::White,
        "U" => ManaType::Blue,
        "B" => ManaType::Black,
        "R" => ManaType::Red,
        "G" => ManaType::Green,
        "C" => ManaType::Colorless,
        _ => return None,
    })
}

/// "{W}" for "W"; "{C}{C}" for two colorless.
pub(crate) fn symbols(codes: &[&str]) -> String {
    codes.iter().map(|c| format!("{{{c}}}")).collect()
}

pub(crate) fn penalty_of(p: ManaSourcePenalty) -> Option<Penalty> {
    match p {
        ManaSourcePenalty::None => None,
        ManaSourcePenalty::HasIrreversibleContinuation => Some(Penalty { kind: "other", amount: None }),
        ManaSourcePenalty::DealsDamageOnResolution { fixed_amount } => Some(Penalty { kind: "damage", amount: fixed_amount }),
        ManaSourcePenalty::PaysLifeOnActivation { fixed_amount } => Some(Penalty { kind: "life", amount: fixed_amount }),
        ManaSourcePenalty::Sacrifices => Some(Penalty { kind: "sacrifice", amount: None }),
    }
}

/// What a mana-source row makes: its combination, its concrete mana, or "any" when the colour is
/// chosen as it's used.
fn selection_mana(s: &ManaSourceSelection) -> Vec<&'static str> {
    if let Some(combo) = &s.atomic_combination {
        return combo.iter().map(|t| mana_code(*t)).collect();
    }
    match s.output {
        ManaSourceOutput::Concrete(t) => vec![mana_code(t)],
        ManaSourceOutput::DeferredColorChoice { .. } => vec!["any"],
    }
}

fn selection_key(s: &ManaSourceSelection) -> String {
    let ability = s.ability_index.map_or_else(|| "-".to_string(), |i| i.to_string());
    format!("{ability}:{}", selection_mana(s).join(""))
}

/// The source and key that name a mana action the engine offers, so a person's answer can be
/// matched back to it: a land's row ("tap:0:W"), a mana ability ("ability:1"), a sacrificial
/// source's row ("source:0:any"), or a convoke or delve payment ("convoke:R").
pub fn mana_key(action: &GameAction) -> Option<(u64, String)> {
    Some(match action {
        GameAction::TapLandForMana { selection } => (selection.source.object_id.0, format!("tap:{}", selection_key(selection))),
        GameAction::ActivateManaSource { selection } => (selection.source.object_id.0, format!("source:{}", selection_key(selection))),
        GameAction::ActivateAbility { source_id, ability_index } => (source_id.0, format!("ability:{ability_index}")),
        GameAction::TapForConvoke { object_id, mana_type } => (object_id.0, format!("convoke:{}", mana_code(*mana_type))),
        _ => return None,
    })
}

/// The engine's mana action for `source` (`key`, or its first when none is named).
pub(crate) fn find_mana_action<'a>(candidates: &'a [GameAction], source: u64, key: Option<&str>) -> Option<&'a GameAction> {
    candidates.iter().find(|a| mana_key(a).is_some_and(|(s, k)| s == source && key.is_none_or(|want| want == k)))
}

/// Whether `me` is paying now: a spell's or ability's mana, a mana ability's own cost, or the
/// question about a sacrificial source.
pub fn paying(w: &WaitingFor, me: PlayerId) -> bool {
    matches!(w,
        WaitingFor::ManaPayment { player, .. }
        | WaitingFor::ManaAbilityManaPayment { player, .. }
        | WaitingFor::ManaSourceSelection { player, .. } if *player == me)
}

/// The engine's cast of `object` that the board's spell option stands for, paying as `mode` says.
pub(crate) fn cast_action(candidates: &[GameAction], object: u64, mode: PayMode) -> Option<GameAction> {
    candidates.iter().find_map(|a| match a {
        GameAction::CastSpell { object_id, card_id, targets, payment_mode } if object_id.0 == object => Some(GameAction::CastSpell {
            object_id: *object_id,
            card_id: *card_id,
            targets: targets.clone(),
            payment_mode: mode.for_cast(*payment_mode),
        }),
        _ => None,
    })
}

/// The selections behind a nonland mana ability, for what it makes and costs.
fn ability_selections<'a>(all: &'a [ManaSourceSelection], source: ObjectId, index: usize) -> impl Iterator<Item = &'a ManaSourceSelection> {
    all.iter().filter(move |s| s.source.object_id == source && s.ability_index == Some(index))
}

/// What a mana action costs beyond the tap.
pub(crate) fn action_penalty(state: &GameState, me: PlayerId, action: &GameAction) -> Option<Penalty> {
    match action {
        GameAction::TapLandForMana { selection } | GameAction::ActivateManaSource { selection } => penalty_of(selection.penalty),
        GameAction::ActivateAbility { source_id, ability_index } => {
            let all = engine::game::mana_sources::activatable_mana_source_selections(state, me);
            ability_selections(&all, *source_id, *ability_index).find_map(|s| penalty_of(s.penalty))
        }
        _ => None,
    }
}

/// One way to use a source, from the engine's action.
fn choice(vs: &GameState, all: &[ManaSourceSelection], action: &GameAction, key: String) -> Option<ManaChoice> {
    Some(match action {
        GameAction::TapLandForMana { selection } | GameAction::ActivateManaSource { selection } => {
            let mana = selection_mana(selection);
            let text = if mana == ["any"] { "Add one mana of any colour".to_string() } else { format!("Add {}", symbols(&mana)) };
            let kind = if matches!(action, GameAction::TapLandForMana { .. }) { "tap" } else { "source" };
            ManaChoice { key, kind, mana, text, penalty: penalty_of(selection.penalty) }
        }
        GameAction::ActivateAbility { source_id, ability_index } => {
            let rows: Vec<&ManaSourceSelection> = ability_selections(all, *source_id, *ability_index).collect();
            let mut mana: Vec<&'static str> = Vec::new();
            for r in &rows {
                for m in selection_mana(r) {
                    if !mana.contains(&m) {
                        mana.push(m);
                    }
                }
            }
            let text = Match::ability_label(vs, source_id, *ability_index);
            ManaChoice { key, kind: "ability", mana, text, penalty: rows.iter().find_map(|r| penalty_of(r.penalty)) }
        }
        GameAction::TapForConvoke { object_id, mana_type } => {
            let delve = vs.objects.get(object_id).is_some_and(|o| o.zone == Zone::Graveyard);
            let code = mana_code(*mana_type);
            let text = if delve {
                "Exile it to pay {1}".to_string()
            } else if code == "C" {
                "Tap it to pay {1}".to_string()
            } else {
                format!("Tap it to pay {{{code}}}")
            };
            ManaChoice { key, kind: if delve { "delve" } else { "convoke" }, mana: vec![code], text, penalty: None }
        }
        _ => return None,
    })
}

/// Which mana can pay one cost symbol ("W/U" either colour, "W/P" white or life, "2/W" white or
/// two of anything); empty for symbols paid otherwise (X).
fn payers(symbol: &str) -> (Vec<&'static str>, bool) {
    let parts: Vec<&str> = symbol.split('/').collect();
    let mut codes = Vec::new();
    let mut any = false;
    for p in parts {
        match p {
            "W" | "U" | "B" | "R" | "G" | "C" => codes.push(mana_type(p).map(mana_code).unwrap_or("C")),
            // Snow, {Z} and the like: any mana will show as paying it here.
            "S" | "Z" => any = true,
            _ => {}
        }
    }
    (codes, any)
}

/// The cost's symbols, coloured first, each marked paid where the pool covers it. Each colour or
/// hybrid symbol takes a matching unit, then generic ones take what's left.
fn pips(cost: &ManaCost, pool: &[&'static str]) -> Vec<Pip> {
    let ManaCost::Cost { shards, generic } = cost else { return vec![] };
    let mut left: Vec<&'static str> = pool.to_vec();
    let take = |left: &mut Vec<&'static str>, ok: &dyn Fn(&str) -> bool| -> bool {
        match left.iter().position(|m| ok(m)) {
            Some(i) => {
                left.remove(i);
                true
            }
            None => false,
        }
    };
    let symbols: Vec<String> = shards.iter().map(|s| s.symbol().to_string()).collect();
    let mut paid = vec![false; symbols.len()];
    // Single colours first, then hybrids, then Phyrexian and the rest: the narrowest symbols take
    // their mana before the wider ones do.
    let order = |sym: &str| -> u8 {
        let n = sym.split('/').count();
        if sym.contains('P') {
            2
        } else if n == 1 {
            0
        } else {
            1
        }
    };
    let mut idx: Vec<usize> = (0..symbols.len()).collect();
    idx.sort_by_key(|i| order(&symbols[*i]));
    for i in idx {
        let (codes, any) = payers(&symbols[i]);
        paid[i] = take(&mut left, &|m| any || codes.contains(&m));
    }
    let mut out: Vec<Pip> = symbols.iter().zip(&paid).map(|(s, p)| Pip { symbol: s.clone(), paid: *p }).collect();
    // A {2/W} not paid with white takes two of anything.
    for (i, s) in symbols.iter().enumerate() {
        if !paid[i] && s.starts_with("2/") && left.len() >= 2 {
            left.drain(..2);
            out[i].paid = true;
        }
    }
    for _ in 0..*generic {
        let ok = !left.is_empty();
        if ok {
            left.remove(0);
        }
        out.push(Pip { symbol: "1".into(), paid: ok });
    }
    out
}

impl PaymentView {
    /// `me`'s payment, from the full game (`state`: the engine's mana rows) and the seat's own view
    /// (`vs`: names). `candidates` is the engine's option list for the decision; `kept` what was
    /// tapped by hand that can't be undone. `None` unless `me` is paying.
    pub fn of(state: &GameState, vs: &GameState, me: PlayerId, candidates: &[GameAction], kept: &[Kept]) -> Option<PaymentView> {
        if !paying(&vs.waiting_for, me) {
            return None;
        }
        let convoke = match &vs.waiting_for {
            WaitingFor::ManaPayment { convoke_mode, .. } | WaitingFor::ManaSourceSelection { convoke_mode, .. } => convoke_mode.map(|m| match m {
                ConvokeMode::Convoke => "convoke",
                ConvokeMode::Waterbend => "waterbend",
                ConvokeMode::Improvise => "improvise",
                ConvokeMode::Delve => "delve",
            }),
            _ => None,
        };
        let pending = state.pending_cast.as_ref().filter(|_| !matches!(vs.waiting_for, WaitingFor::ManaAbilityManaPayment { .. }));
        let paying_for = pending.map(|p| PaidFor {
            id: p.object_id.0,
            name: Match::name_in(vs, &p.object_id),
            ability: p.activation_ability_index.is_some(),
        });
        let player = vs.players.iter().find(|p| p.id == me)?;
        let units: Vec<_> = player.mana_pool.units().collect();
        let pool: Vec<PoolMana> = units
            .iter()
            .map(|u| PoolMana {
                mana: mana_code(u.color),
                source: vs.objects.contains_key(&u.source_id).then_some(u.source_id.0),
                name: Match::name_in(vs, &u.source_id),
                convoke: u.is_convoke_payment(),
            })
            .collect();
        let codes: Vec<&'static str> = pool.iter().map(|m| m.mana).collect();
        let (cost, pips) = match pending {
            Some(p) => (phase_llm::render::text::mana_cost_text(&p.cost), pips(&p.cost, &codes)),
            None => (String::new(), vec![]),
        };
        // The sources, in the order the engine lists their actions, each with its choices once.
        let all = engine::game::mana_sources::activatable_mana_source_selections(state, me);
        let mut sources: Vec<ManaSource> = Vec::new();
        let mut at: HashMap<u64, usize> = HashMap::new();
        // The sacrificial-source question names its sources as a pick (`Pending`), not here.
        let listed = !matches!(vs.waiting_for, WaitingFor::ManaSourceSelection { .. });
        for a in candidates.iter().filter(|_| listed) {
            let Some((source, key)) = mana_key(a) else { continue };
            let Some(c) = choice(vs, &all, a, key) else { continue };
            let i = *at.entry(source).or_insert_with(|| {
                let id = ObjectId(source);
                sources.push(ManaSource {
                    id: source,
                    name: Match::name_in(vs, &id),
                    zone: vs.objects.get(&id).map(|o| format!("{:?}", o.zone).to_lowercase()).unwrap_or_else(|| "battlefield".into()),
                    choices: vec![],
                });
                sources.len() - 1
            });
            if !sources[i].choices.iter().any(|x| x.key == c.key) {
                sources[i].choices.push(c);
            }
        }
        // The engine gives back a manual tap only while the payment is open (CR 605.3b).
        let untap = if matches!(vs.waiting_for, WaitingFor::ManaPayment { .. }) {
            let mut ids: Vec<u64> = state.lands_tapped_for_mana.get(&me).map(|v| v.iter().map(|o| o.0).collect()).unwrap_or_default();
            ids.dedup();
            ids.retain(|id| vs.objects.get(&ObjectId(*id)).is_some_and(|o| o.zone == Zone::Battlefield));
            ids
        } else {
            vec![]
        };
        Some(PaymentView {
            paying_for,
            cost,
            pips,
            pool,
            sources,
            untap,
            kept: kept.to_vec(),
            convoke,
            pay_rest: candidates.iter().any(|a| matches!(a, GameAction::PassPriority)),
            cancel: candidates.iter().any(|a| matches!(a, GameAction::CancelCast)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::types::mana::ManaCostShard;

    #[test]
    fn pips_fill_colours_first_then_generic() {
        let cost = ManaCost::Cost { shards: vec![ManaCostShard::White], generic: 3 };
        let p = pips(&cost, &["C", "W", "C"]);
        assert_eq!(p.iter().map(|p| (p.symbol.as_str(), p.paid)).collect::<Vec<_>>(), [("W", true), ("1", true), ("1", true), ("1", false)]);
        // Red mana doesn't pay the white symbol, only generic.
        let p = pips(&cost, &["R"]);
        assert_eq!(p.iter().map(|p| p.paid).collect::<Vec<_>>(), [false, true, false, false]);
        // A hybrid takes either colour; a Phyrexian symbol its colour (or life later).
        let cost = ManaCost::Cost { shards: vec![ManaCostShard::WhiteBlue, ManaCostShard::PhyrexianRed], generic: 0 };
        assert_eq!(pips(&cost, &["U"]).iter().map(|p| p.paid).collect::<Vec<_>>(), [true, false]);
        assert_eq!(pips(&cost, &["U", "R"]).iter().map(|p| p.paid).collect::<Vec<_>>(), [true, true]);
        // {2/W} with no white takes two of anything.
        let cost = ManaCost::Cost { shards: vec![ManaCostShard::TwoWhite], generic: 0 };
        assert!(pips(&cost, &["G", "G"])[0].paid);
        assert!(!pips(&cost, &["G"])[0].paid);
    }

    #[test]
    fn the_setting_keeps_the_engines_choice_unless_told_otherwise() {
        assert_eq!(PayMode::Ask.for_cast(CastPaymentMode::AutoExceptSacrificialMana), CastPaymentMode::AutoExceptSacrificialMana);
        assert_eq!(PayMode::Ask.for_cast(CastPaymentMode::Auto), CastPaymentMode::Auto);
        assert_eq!(PayMode::Auto.for_cast(CastPaymentMode::AutoExceptSacrificialMana), CastPaymentMode::Auto);
        assert_eq!(PayMode::Manual.for_cast(CastPaymentMode::Auto), CastPaymentMode::Manual);
        assert_eq!(serde_json::to_value(PayMode::Manual).unwrap(), "manual");
        for m in [PayMode::Ask, PayMode::Auto, PayMode::Manual] {
            assert_eq!(PayMode::parse(m.as_str()), Some(m));
        }
    }

    #[test]
    fn convoke_and_ability_keys_read_from_the_action() {
        let a = GameAction::TapForConvoke { object_id: ObjectId(7), mana_type: ManaType::Red };
        assert_eq!(mana_key(&a), Some((7, "convoke:R".into())));
        let b = GameAction::ActivateAbility { source_id: ObjectId(9), ability_index: 1 };
        assert_eq!(mana_key(&b), Some((9, "ability:1".into())));
        assert_eq!(mana_key(&GameAction::PassPriority), None);
        let list = vec![GameAction::PassPriority, a.clone(), b.clone()];
        assert_eq!(find_mana_action(&list, 9, None), Some(&b));
        assert_eq!(find_mana_action(&list, 7, Some("convoke:C")), None);
        assert_eq!(find_mana_action(&list, 7, Some("convoke:R")), Some(&a));
    }
}
