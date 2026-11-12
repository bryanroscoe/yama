//! The rarer cards and rules (docs/game-interactions-review-2026-10-23.md, "Engine decisions with
//! no design"; the boards GRareCards and GRareRules): the `Pending` shapes for them, read from the
//! deciding seat's filtered view like every other (act.rs), the engine actions their answers stand
//! for, and the special actions the engine offers at priority.
//!
//! - **Companion** (CR 702.139a): revealing one before the game, and later paying {3} to put it
//!   into your hand (a special action). The revealed companion is public for the whole game.
//! - **Meld** (CR 701.42): the pair to meld, and what the melded creature attacks when it enters
//!   attacking (CR 508.4; any permanent that enters attacking asks the same).
//! - **Cipher** (CR 702.99a): the creature to encode the spell on, or none.
//! - **Dungeons** (CR 309, 701.49): the dungeon to venture into, and the next room, with the
//!   engine's own map of every room, what it leads to and where it's drawn on the card.
//! - **Time travel** (CR 701.56a): the engine asks twice (remove, then add); Yama takes both answers
//!   at once and sends them in that order.
//! - **Loop shortcuts** (CR 732.2): proposing one with the engine's own counts, and each other
//!   player accepting or shortening it in turn; "you may repeat this process" is a yes or no.
//!   phase raises loop shortcuts only with its loop detection on (`LoopDetectionMode`), which
//!   games people play have (`crate::PLAY_LOOPS`) and the lab leaves off.
//! - **The command zone** (CR 903.9a): a commander going to a graveyard or exile, a yes or no
//!   that Yama can remember (remember.rs).
//! - **Special actions at priority** (CR 116.2): ninjutsu, turning a face-down permanent face up,
//!   foretelling, putting your companion into your hand, and Serum Powder at the mulligan. They're
//!   options in the engine's own list; [`special_action`] matches an answer to one of them.
//!
//! Morph's face-down cast is the engine's "pay the mana cost, or cast it face down" choice
//! (`AlternativeCastChoice` with the face-down keyword, ways.rs), shown with what you and the
//! others will see. A face-down permanent's identity reaches only the seats the engine's
//! projection names it for (`CardView::under`).

use std::str::FromStr;

use engine::analysis::decision_template::IterationCount;
use engine::analysis::loop_check::{ShortcutResponse, WinKind};
use engine::analysis::resource::ResourceAxis;
use engine::game::combat::AttackTarget;
use engine::game::dungeon::{DungeonId, DungeonPreview, room_nodes};
use engine::types::actions::{GameAction, MulliganChoice, PrecastCopyShortcutResponse};
use engine::types::game_state::{CompanionDeclaration, GameState, TimeTravelPhase, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::keywords::{DisguiseCost, Keyword, MorphCost};
use engine::types::player::PlayerId;
use engine::types::zones::Zone;
use phase_llm::render::action::humanize_identifier;
use phase_llm::render::text::{mana_cost_text, one_line};
use serde::Serialize;
use serde_json::json;

use crate::act::{Act, Answer, Choice, Kind, Pending, Source, capitalised, card, cards, player_choice, target, target_id, word};
use crate::together::resolving_source;
use crate::{Match, TargetView};

/// A dungeon as the board draws it (GRareRules' room map): its card from Scryfall, every room with
/// the rooms it leads to and where it's drawn on the card (thousandths of the card's width and
/// height, the engine's own geometry), and the room the venture marker is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DungeonMap {
    /// The option that chooses it ("LostMineOfPhandelver"), when the decision is which dungeon.
    pub id: String,
    pub name: String,
    /// The dungeon card's image on Scryfall. Dungeon cards credit no artist there.
    pub image: String,
    pub rooms: Vec<RoomView>,
    /// The room the marker is on now, if the dungeon is the one being explored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<u8>,
}

/// One room of a dungeon, in the card's own words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoomView {
    pub index: u8,
    pub name: String,
    pub text: String,
    pub next: Vec<u8>,
    pub x: u16,
    pub y: u16,
}

/// The image of a dungeon card on Scryfall, by its printing (the engine names it).
fn dungeon_image(scryfall_id: &str) -> String {
    let mut chars = scryfall_id.chars();
    let (a, b) = (chars.next().unwrap_or('0'), chars.next().unwrap_or('0'));
    format!("https://cards.scryfall.io/normal/front/{a}/{b}/{scryfall_id}.jpg")
}

fn dungeon_map(id: DungeonId, current: Option<u8>) -> DungeonMap {
    let card = engine::game::dungeon::card_view(id);
    DungeonMap {
        id: format!("{id:?}"),
        name: engine::game::dungeon::get_definition(id).name.to_string(),
        image: dungeon_image(&card.scryfall_id),
        rooms: room_nodes(id)
            .into_iter()
            .map(|r| RoomView { index: r.room.index, name: r.room.name, text: r.room.text, next: r.next_rooms, x: r.marker.x_permille, y: r.marker.y_permille })
            .collect(),
        current,
    }
}

/// A proposed loop shortcut as the board shows it (GRareRules): who proposed it, how many times it
/// repeats, what grows without limit and what it wins by, and where each other player is in
/// answering. The words come from the engine's own measurements of the loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutView {
    pub proposer: u8,
    /// Finite repetition count; the engine count distinguishes nonfinite endings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iteration_count: Option<IterationCount>,
    /// What grows (or shrinks) each time round, in words: "Tokens created", "Ben's life".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub grows: Vec<String>,
    /// How it ends the game, in words, when the engine says it does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wins: Option<String>,
    /// The player the engine expects to win, when it names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winner: Option<u8>,
    /// Everyone else, in the order they answer: "answered", "deciding" or "next".
    pub responders: Vec<(u8, &'static str)>,
    /// The player who last shortened it, whose stopping point it now is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortened_by: Option<u8>,
}

fn seat_name(p: PlayerId, names: &[String]) -> String {
    names.get(usize::from(p.0)).cloned().unwrap_or_else(|| format!("Player {}", p.0 + 1))
}

/// One of the engine's loop measurements in words.
fn axis_words(a: &ResourceAxis, names: &[String]) -> String {
    let whose = |p: &PlayerId| format!("{}'s", seat_name(*p, names));
    match a {
        ResourceAxis::Mana(t) => format!("{} mana", humanize_identifier(&format!("{t:?}"))),
        ResourceAxis::Life(p) => format!("{} life", whose(p)),
        ResourceAxis::DamageDealt(p) => format!("Damage to {}", seat_name(*p, names)),
        ResourceAxis::LibraryDelta(p) => format!("{} library", whose(p)),
        ResourceAxis::Poison(p) => format!("{} poison counters", whose(p)),
        ResourceAxis::Counter(c, o) => format!("{} counters on {}", humanize_identifier(&format!("{c:?}")), humanize_identifier(&format!("{o:?}")).to_lowercase()),
        ResourceAxis::Trigger(k) => format!("{} triggers", humanize_identifier(&format!("{k:?}"))),
        other => capitalised(&humanize_identifier(&format!("{other:?}")).to_lowercase()),
    }
}

fn win_words(w: WinKind) -> String {
    match w {
        WinKind::LethalDamage => "An opponent's life reaches 0".into(),
        WinKind::PoisonLoss => "An opponent gets 10 poison counters".into(),
        WinKind::Decking => "An opponent's library runs out".into(),
        WinKind::ImmediateWin => "A card wins the game".into(),
        other => capitalised(&humanize_identifier(&format!("{other:?}")).to_lowercase()),
    }
}

/// Everyone answering a shortcut after its proposer, in order, from the engine's own queue: those
/// who have answered come before the one deciding.
fn responders(vs: &GameState, proposer: PlayerId, deciding: Option<PlayerId>, remaining: &[PlayerId]) -> Vec<(u8, &'static str)> {
    let living: Vec<PlayerId> = engine::game::players::apnap_order_from(vs, Some(engine::types::ability::ControllerRef::You), proposer)
        .into_iter()
        .filter(|p| *p != proposer && vs.players.iter().any(|x| x.id == *p && !x.is_eliminated))
        .collect();
    living
        .into_iter()
        .map(|p| {
            let state = if Some(p) == deciding {
                "deciding"
            } else if remaining.contains(&p) || deciding.is_none() {
                "next"
            } else {
                "answered"
            };
            (p.0, state)
        })
        .collect()
}

/// A shortcut being answered, as every seat sees it (`TogetherView::Shortcut`): the proposal and
/// where each player is in answering it.
pub(crate) fn public_shortcut(vs: &GameState, names: &[String]) -> Option<ShortcutView> {
    match &vs.waiting_for {
        WaitingFor::RespondToShortcut { player, remaining_players, proposal } => Some(ShortcutView {
            proposer: proposal.proposer.0,
            count: match proposal.count {
                IterationCount::Fixed(n) => Some(n),
                IterationCount::UntilLethal | IterationCount::WithoutEnd => None,
            },
            iteration_count: Some(proposal.count.clone()),
            grows: proposal.unbounded.iter().map(|a| axis_words(a, names)).collect(),
            wins: proposal.win_kind.map(win_words),
            winner: proposal.predicted_winner.map(|w| w.0),
            responders: responders(vs, proposal.proposer, Some(*player), remaining_players),
            shortened_by: proposal.shortened_by.map(|p| p.0),
        }),
        WaitingFor::RespondToPrecastCopyShortcut { player, remaining_players, .. } => {
            let proposer = vs.stack.last().map(|e| e.controller)?;
            Some(ShortcutView { proposer: proposer.0, count: None, iteration_count: None, grows: vec![], wins: None, winner: None, responders: responders(vs, proposer, Some(*player), remaining_players), shortened_by: None })
        }
        _ => None,
    }
}

/// The cost to turn a face-down permanent face up, printed: its morph, megamorph or disguise cost,
/// or a manifested creature card's mana cost (CR 702.37e, 702.168d, 701.40b). Only a seat that may
/// look at the card underneath has it.
pub(crate) fn face_up_cost(vs: &GameState, id: &ObjectId) -> Option<String> {
    let back = vs.objects.get(id)?.back_face.as_ref()?;
    // The outer Option says whether the card has a turn-face-up keyword at all; the inner one
    // whether its cost has a printed form. A keyword whose cost can't be printed shows no cost,
    // never the card's mana cost, which is only a manifested creature's way up.
    let keyword = back.keywords.iter().find_map(|k| match k {
        Keyword::Morph(MorphCost::Mana(c)) | Keyword::Megamorph(c) => Some(Some(mana_cost_text(c))),
        // A non-mana morph cost ("Morph—Reveal a blue card"), where it has a printed form.
        Keyword::Morph(MorphCost::NonMana(c)) => Some(Some(crate::cost_text(c)).filter(|t| !t.is_empty())),
        Keyword::Disguise(DisguiseCost::Mana(c)) | Keyword::Disguise(DisguiseCost::Reduced { cost: c, .. }) => Some(Some(mana_cost_text(c))),
        _ => None,
    });
    match keyword {
        Some(cost) => cost,
        None => back.card_types.core_types.contains(&engine::types::card_type::CoreType::Creature).then(|| mana_cost_text(&back.mana_cost)),
    }
}

/// A ninja's cost (CR 702.49a), printed, as the engine works it out for `player`.
fn ninjutsu_cost(vs: &GameState, player: PlayerId, ninja: ObjectId) -> Option<String> {
    engine::game::keywords::ninjutsu_family_activatable_sources(vs, player).into_iter().find(|(id, ..)| *id == ninja).map(|(.., cost)| mana_cost_text(&cost))
}

/// The companion `player` revealed (CR 702.139a), by name, and whether it has been put into their
/// hand yet. Public for the whole game.
pub(crate) fn companion_of(vs: &GameState, player: PlayerId) -> Option<(String, bool)> {
    let c = vs.players.iter().find(|p| p.id == player)?.companion.as_ref()?;
    Some((c.card.card.name.clone(), c.used))
}

/// An option's words and cost for the special actions this module covers, where Yama words them
/// itself: `None` for any other action.
pub(crate) fn label(vs: &GameState, action: &GameAction, names: &[String]) -> Option<(String, Option<String>)> {
    Some(match action {
        GameAction::ActivateNinjutsu { ninjutsu_object_id, creature_to_return } => {
            let o = vs.objects.get(ninjutsu_object_id)?;
            let cost = ninjutsu_cost(vs, o.controller, *ninjutsu_object_id);
            let head = match &cost {
                Some(c) => format!("Ninjutsu {c}"),
                None => "Ninjutsu".into(),
            };
            (format!("{head}: return {}", Match::name_in(vs, creature_to_return)), cost)
        }
        GameAction::TurnFaceUp { object_id, .. } => {
            // The controller's projection names the card underneath (CR 708.5).
            let name = vs.objects.get(object_id).map(|o| o.name.clone()).filter(|n| !n.is_empty() && n != "Hidden Card");
            let cost = face_up_cost(vs, object_id);
            let what = name.unwrap_or_else(|| "it".into());
            match &cost {
                Some(c) => (format!("Turn {what} face up for {c}"), cost),
                None => (format!("Turn {what} face up"), None),
            }
        }
        // CR 702.139a: {3} as a sorcery.
        GameAction::CompanionToHand => {
            let me = vs.waiting_for.acting_player()?;
            let (name, _) = companion_of(vs, me)?;
            (format!("Pay {{3}}: put {name} into your hand"), Some("{3}".into()))
        }
        GameAction::MulliganDecision { choice: MulliganChoice::UseSerumPowder { .. } } => ("Serum Powder: exile your hand, then draw that many cards".into(), None),
        GameAction::DeclareCompanion { choice: CompanionDeclaration::Reveal(c) } => (format!("Reveal {}", c.name), None),
        GameAction::DeclareCompanion { choice: CompanionDeclaration::Decline } => ("No companion".into(), None),
        GameAction::ChooseMeldPair { source_id, partner_id } => (format!("Meld {} and {}", Match::name_in(vs, source_id), Match::name_in(vs, partner_id)), None),
        GameAction::ChooseEntryAttackTarget { target: t } => (
            match t {
                AttackTarget::Player(p) => format!("Attack {}", seat_name(*p, names)),
                AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => format!("Attack {}", Match::name_in(vs, id)),
            },
            None,
        ),
        GameAction::CipherEncode { creature: Some(id) } => (format!("Encode it on {}", Match::name_in(vs, id)), None),
        GameAction::CipherEncode { creature: None } => ("Don't encode".into(), None),
        GameAction::ChooseDungeon { dungeon } => (format!("Venture into {}", engine::game::dungeon::get_definition(*dungeon).name), None),
        GameAction::ChooseDungeonRoom { room_index } => {
            let WaitingFor::ChooseDungeonRoom { options, .. } = &vs.waiting_for else { return None };
            let room = options.iter().find(|r| r.index == *room_index)?;
            (format!("Go to {}", room.name), None)
        }
        GameAction::DeclareShortcut { count: IterationCount::Fixed(n), .. } => (format!("Propose: repeat {n} times"), None),
        GameAction::DeclareShortcut { count: IterationCount::UntilLethal, .. } => ("Propose: repeat until a player loses".into(), None),
        GameAction::DeclareShortcut { count: IterationCount::WithoutEnd, .. } => ("Propose: repeat without end (draw)".into(), None),
        GameAction::DeclineShortcut | GameAction::PrecastCopyShortcut { response: PrecastCopyShortcutResponse::Decline, .. } => ("Keep playing it out".into(), None),
        GameAction::PrecastCopyShortcut { response: PrecastCopyShortcutResponse::Propose { .. }, .. } => ("Propose the shortcut".into(), None),
        GameAction::RespondToShortcut { response: ShortcutResponse::Accept } | GameAction::PrecastCopyShortcut { response: PrecastCopyShortcutResponse::Accept, .. } => {
            ("Accept the shortcut".into(), None)
        }
        GameAction::RespondToShortcut { response: ShortcutResponse::Shorten { at_iteration } } => (format!("Shorten it to {at_iteration}"), None),
        GameAction::PrecastCopyShortcut { response: PrecastCopyShortcutResponse::Shorten { .. }, .. } => ("Stop it early".into(), None),
        _ => return None,
    })
}

/// The attacker a ninjutsu option returns, for the board's pick of an unblocked attacker.
pub(crate) fn option_target(action: &GameAction) -> Option<TargetView> {
    match action {
        GameAction::ActivateNinjutsu { creature_to_return, .. } => Some(TargetView::Object { id: creature_to_return.0 }),
        _ => None,
    }
}

/// The card an option is about where the engine's action names none itself: the Serum Powder
/// used at the mulligan, so its option sits on the card in your hand.
pub(crate) fn option_object(action: &GameAction) -> Option<u64> {
    match action {
        GameAction::MulliganDecision { choice: MulliganChoice::UseSerumPowder { object_id } } => Some(object_id.0),
        _ => None,
    }
}

/// The engine's option a special action stands for, if it offers that one now.
pub(crate) fn special_action(candidates: &[GameAction], act: &Act) -> Option<GameAction> {
    candidates
        .iter()
        .find(|a| match (act, a) {
            (Act::Ninjutsu { card, attacker }, GameAction::ActivateNinjutsu { ninjutsu_object_id, creature_to_return }) => {
                ninjutsu_object_id.0 == *card && creature_to_return.0 == *attacker
            }
            (Act::TurnFaceUp { object }, GameAction::TurnFaceUp { object_id, .. }) => object_id.0 == *object,
            (Act::Foretell { object }, GameAction::Foretell { object_id, .. }) => object_id.0 == *object,
            (Act::CompanionToHand, GameAction::CompanionToHand) => true,
            (Act::UseSerumPowder { object }, GameAction::MulliganDecision { choice: MulliganChoice::UseSerumPowder { object_id } }) => object_id.0 == *object,
            _ => false,
        })
        .cloned()
}

/// The engine action for an answer whose shape depends on the decision: the companion offered by
/// that name, the attack target the engine lists, and a shortcut's proposal or response (a loop's
/// count, or the pre-cast shortcut's own ids).
pub(crate) fn action_for(waiting: &WaitingFor, candidates: &[GameAction], act: &Act) -> Option<GameAction> {
    match (waiting, act) {
        (WaitingFor::CompanionReveal { eligible_companions, .. }, Act::DeclareCompanion { name }) => Some(GameAction::DeclareCompanion {
            choice: match name {
                Some(n) => CompanionDeclaration::Reveal(eligible_companions.iter().find(|c| &c.name == n)?.clone()),
                None => CompanionDeclaration::Decline,
            },
        }),
        (WaitingFor::MeldAttackTargetChoice { valid_targets, .. } | WaitingFor::EntryAttackTargetChoice { valid_targets, .. }, Act::ChooseEntryAttackTarget { target: t }) => {
            let want = target_id(t);
            valid_targets.iter().find(|v| attack_target_id(v) == want).map(|v| GameAction::ChooseEntryAttackTarget { target: *v })
        }
        // A loop: the engine's own declaration for that count (it carries the engine's template).
        (WaitingFor::LoopShortcut { .. }, Act::ProposeShortcut { count }) => candidates
            .iter()
            .find(|a| match a {
                GameAction::DeclareShortcut { count: IterationCount::Fixed(n), .. } => *count == Some(*n),
                GameAction::DeclareShortcut { count: IterationCount::UntilLethal | IterationCount::WithoutEnd, .. } => count.is_none(),
                _ => false,
            })
            .cloned(),
        (WaitingFor::LoopShortcut { .. }, Act::DeclineShortcut) => Some(GameAction::DeclineShortcut),
        (WaitingFor::RespondToShortcut { .. }, Act::RespondToShortcut { stop_at }) => Some(GameAction::RespondToShortcut {
            response: match stop_at {
                None => ShortcutResponse::Accept,
                Some(n) => ShortcutResponse::Shorten { at_iteration: u32::try_from(*n).ok()? },
            },
        }),
        (WaitingFor::PrecastCopyShortcutOffer { epoch, .. }, Act::ProposeShortcut { count: None }) => {
            Some(GameAction::PrecastCopyShortcut { epoch: *epoch, response: PrecastCopyShortcutResponse::Propose { route_id: *epoch } })
        }
        (WaitingFor::PrecastCopyShortcutOffer { epoch, .. }, Act::DeclineShortcut) => {
            Some(GameAction::PrecastCopyShortcut { epoch: *epoch, response: PrecastCopyShortcutResponse::Decline })
        }
        (WaitingFor::RespondToPrecastCopyShortcut { epoch, .. }, Act::RespondToShortcut { stop_at }) => Some(GameAction::PrecastCopyShortcut {
            epoch: *epoch,
            response: match stop_at {
                None => PrecastCopyShortcutResponse::Accept,
                Some(id) => PrecastCopyShortcutResponse::Shorten { breakpoint_id: *id },
            },
        }),
        _ => None,
    }
}

/// An attack target as an option id: "p2" for a player, the permanent's id for a planeswalker or
/// battle.
fn attack_target_id(t: &AttackTarget) -> String {
    match t {
        AttackTarget::Player(p) => format!("p{}", p.0),
        AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => id.0.to_string(),
    }
}

/// An answer's engine action for the actions that stand alone (no decision needed to read them).
pub(crate) fn to_action(act: &Act) -> Option<Option<GameAction>> {
    Some(match act {
        Act::ChooseMeldPair { source, partner } => Some(GameAction::ChooseMeldPair { source_id: ObjectId(*source), partner_id: ObjectId(*partner) }),
        Act::CipherEncode { creature } => Some(GameAction::CipherEncode { creature: creature.map(ObjectId) }),
        Act::ChooseDungeon { dungeon } => DungeonId::from_str(dungeon).ok().map(|dungeon| GameAction::ChooseDungeon { dungeon }),
        Act::ChooseDungeonRoom { room } => Some(GameAction::ChooseDungeonRoom { room_index: *room }),
        // Matched to the decision or the engine's own options when answered.
        Act::DeclareCompanion { .. }
        | Act::ChooseEntryAttackTarget { .. }
        | Act::TimeTravel { .. }
        | Act::ProposeShortcut { .. }
        | Act::DeclineShortcut
        | Act::RespondToShortcut { .. }
        | Act::Ninjutsu { .. }
        | Act::TurnFaceUp { .. }
        | Act::Foretell { .. }
        | Act::CompanionToHand
        | Act::UseSerumPowder { .. }
        | Act::RememberAnswer { .. }
        | Act::ForgetAnswer { .. } => None,
        _ => return None,
    })
}

/// The answer for an engine action this module covers, read without the decision.
pub(crate) fn from_action(action: &GameAction) -> Option<Act> {
    Some(match action {
        GameAction::DeclareCompanion { choice } => Act::DeclareCompanion {
            name: match choice {
                CompanionDeclaration::Reveal(c) => Some(c.name.clone()),
                CompanionDeclaration::Decline => None,
            },
        },
        GameAction::ChooseMeldPair { source_id, partner_id } => Act::ChooseMeldPair { source: source_id.0, partner: partner_id.0 },
        GameAction::ChooseEntryAttackTarget { target: t } => Act::ChooseEntryAttackTarget {
            target: match t {
                AttackTarget::Player(p) => TargetView::Player { seat: p.0 },
                AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => TargetView::Object { id: id.0 },
            },
        },
        GameAction::CipherEncode { creature } => Act::CipherEncode { creature: creature.map(|c| c.0) },
        GameAction::ChooseDungeon { dungeon } => Act::ChooseDungeon { dungeon: format!("{dungeon:?}") },
        GameAction::ChooseDungeonRoom { room_index } => Act::ChooseDungeonRoom { room: *room_index },
        GameAction::DeclareShortcut { count, .. } => Act::ProposeShortcut {
            count: match count {
                IterationCount::Fixed(n) => Some(*n),
                IterationCount::UntilLethal | IterationCount::WithoutEnd => None,
            },
        },
        GameAction::DeclineShortcut => Act::DeclineShortcut,
        GameAction::RespondToShortcut { response } => Act::RespondToShortcut {
            stop_at: match response {
                ShortcutResponse::Accept => None,
                ShortcutResponse::Shorten { at_iteration } => Some(u64::from(*at_iteration)),
            },
        },
        GameAction::PrecastCopyShortcut { response, .. } => match response {
            PrecastCopyShortcutResponse::Propose { .. } => Act::ProposeShortcut { count: None },
            PrecastCopyShortcutResponse::Decline => Act::DeclineShortcut,
            PrecastCopyShortcutResponse::Accept => Act::RespondToShortcut { stop_at: None },
            PrecastCopyShortcutResponse::Shorten { breakpoint_id } => Act::RespondToShortcut { stop_at: Some(*breakpoint_id) },
        },
        GameAction::ActivateNinjutsu { ninjutsu_object_id, creature_to_return } => Act::Ninjutsu { card: ninjutsu_object_id.0, attacker: creature_to_return.0 },
        GameAction::TurnFaceUp { object_id, x: 0 } => Act::TurnFaceUp { object: object_id.0 },
        GameAction::Foretell { object_id, .. } => Act::Foretell { object: object_id.0 },
        GameAction::CompanionToHand => Act::CompanionToHand,
        GameAction::MulliganDecision { choice: MulliganChoice::UseSerumPowder { object_id } } => Act::UseSerumPowder { object: object_id.0 },
        _ => return None,
    })
}

/// Time travel (CR 701.56a) as one answer: the engine's remove step, then its add step over what's
/// still eligible, on a copy of the game. Returns the actions taken and the last result; a refusal
/// is the engine's reason.
pub(crate) fn time_travel(state: &mut GameState, actor: PlayerId, owner: PlayerId, remove: &[TargetView], add: &[TargetView]) -> Result<(Vec<GameAction>, engine::types::game_state::ActionResult), String> {
    let refs = |ts: &[TargetView]| ts.iter().map(TargetView::to_ref).collect::<Vec<_>>();
    let mut next = state.clone();
    let mut actions = vec![];
    let mut result: Option<engine::types::game_state::ActionResult> = None;
    let mut apply = |next: &mut GameState, action: GameAction, actions: &mut Vec<GameAction>| -> Result<(), String> {
        let r = engine::game::engine::apply_interaction(next, actor, owner, action.clone()).map_err(|e| e.to_string())?;
        actions.push(action);
        result = Some(match result.take() {
            None => r,
            Some(mut before) => {
                before.events.extend(r.events);
                before.log_entries.extend(r.log_entries);
                engine::types::game_state::ActionResult { events: before.events, log_entries: before.log_entries, ..r }
            }
        });
        Ok(())
    };
    let removing = matches!(next.waiting_for, WaitingFor::TimeTravelChoice { phase: TimeTravelPhase::Remove, .. });
    if removing {
        apply(&mut next, GameAction::SelectTargets { targets: refs(remove) }, &mut actions)?;
    } else if !remove.is_empty() {
        return Err("Time counters can only be added now.".into());
    }
    // The engine asks about adding only when something is still eligible.
    if matches!(&next.waiting_for, WaitingFor::TimeTravelChoice { player, phase: TimeTravelPhase::Add, .. } if *player == owner) {
        apply(&mut next, GameAction::SelectTargets { targets: refs(add) }, &mut actions)?;
    } else if !add.is_empty() {
        return Err("Nothing is left to add a time counter to.".into());
    }
    *state = next;
    Ok((actions, result.expect("time travel takes at least one step")))
}

/// The decisions this module describes, or `None` for any other (act.rs asks first).
pub(crate) fn of(vs: &GameState, me: PlayerId, candidates: &[GameAction], names: &[String]) -> Option<Pending> {
    let p = match &vs.waiting_for {
        // ── companion (CR 702.139a) ──────────────────────────────────────
        WaitingFor::CompanionReveal { player, eligible_companions } if *player == me => {
            let options: Vec<Choice> = eligible_companions
                .iter()
                .map(|c| {
                    let mut o = word(c.name.clone(), c.name.clone());
                    o.card = true;
                    o
                })
                .collect();
            let one = options.len() == 1;
            let mut p = Pending::new(Kind::Pick, Answer::DeclareCompanion, "companion", "Reveal a companion?", options).range(0, 1, true);
            p.default_answer = one.then(|| json!([eligible_companions[0].name.clone()]));
            // The card asking is the companion itself.
            p.source = eligible_companions.first().filter(|_| one).map(|c| Source { id: 0, name: c.name.clone(), controller: me.0, art: None, image: None, artist: None });
            p
        }
        // ── meld (CR 701.42) ──────────────────────────────────────────────
        WaitingFor::MeldPairChoice { player, choices } if *player == me => {
            let mut options = vec![];
            let mut shown = vec![];
            for c in choices {
                let id = format!("{}:{}", c.source_id.0, c.partner_id.0);
                let mut o = word(id.clone(), format!("{} and {}", Match::name_in(vs, &c.source_id), Match::name_in(vs, &c.partner_id)));
                o.text = Some(c.result.clone());
                options.push(o);
                for part in [c.source_id, c.partner_id] {
                    let mut s = card(vs, &part, false);
                    s.group = Some(id.clone());
                    shown.push(s);
                }
                // The melded card it becomes, named so the server sends its image.
                let mut r = word(format!("{id}:result"), c.result.clone());
                r.card = true;
                r.eligible = false;
                r.group = Some(id.clone());
                shown.push(r);
            }
            let one = options.len() == 1;
            let source = choices.first().map(|c| c.source_id);
            let mut p = Pending::new(Kind::Pick, Answer::ChooseMeldPair, "meld", "Meld", options).range(1, 1, false).from(vs, source);
            p.default_answer = one.then(|| json!([format!("{}:{}", choices[0].source_id.0, choices[0].partner_id.0)]));
            p.shown = shown;
            p
        }
        WaitingFor::MeldAttackTargetChoice { player, context, valid_targets } if *player == me => {
            attack_target(vs, valid_targets, names, format!("Choose what {} attacks", context.result), None)
        }
        WaitingFor::EntryAttackTargetChoice { player, object_id, valid_targets } if *player == me => {
            attack_target(vs, valid_targets, names, format!("Choose what {} attacks", Match::name_in(vs, object_id)), Some(*object_id))
        }
        // ── cipher (CR 702.99a) ──────────────────────────────────────────
        WaitingFor::CipherEncodeChoice { player, card_id, creatures } if *player == me => {
            let name = Match::name_in(vs, card_id);
            Pending::new(Kind::Pick, Answer::CipherEncode, "cipher", format!("Encode {name} on a creature you control?"), cards(vs, creatures)).range(0, 1, true).from(vs, Some(*card_id))
        }
        // ── dungeons (CR 309, 701.49) ─────────────────────────────────────
        WaitingFor::ChooseDungeon { player, options } if *player == me => {
            let choices = options.iter().map(dungeon_option).collect();
            let mut p = Pending::new(Kind::Pick, Answer::ChooseDungeon, "dungeon", "Venture into the dungeon: choose a dungeon", choices).range(1, 1, false).from(vs, resolving_source(vs));
            p.dungeons = options.iter().map(|d| dungeon_map(d.dungeon, None)).collect();
            p.default_answer = Some(json!([options.first().map(|d| format!("{:?}", d.dungeon)).unwrap_or_default()]));
            p
        }
        WaitingFor::ChooseDungeonRoom { player, dungeon, dungeon_name, options } if *player == me => {
            let rooms = options
                .iter()
                .map(|r| {
                    let mut o = word(r.index.to_string(), r.name.clone());
                    o.text = Some(r.text.clone());
                    o
                })
                .collect();
            let current = vs.dungeon_progress.get(&me).filter(|d| d.current_dungeon == Some(*dungeon)).map(|d| d.current_room);
            let mut p = Pending::new(Kind::Pick, Answer::ChooseDungeonRoom, "dungeon_room", format!("{dungeon_name}: choose the next room"), rooms).range(1, 1, false).from(vs, resolving_source(vs));
            p.dungeons = vec![dungeon_map(*dungeon, current)];
            p
        }
        // ── time travel (CR 701.56a) ─────────────────────────────────────
        WaitingFor::TimeTravelChoice { player, eligible, phase } if *player == me => {
            let options: Vec<Choice> = eligible
                .iter()
                .map(|t| {
                    let mut c = target(vs, t, names);
                    if let engine::types::ability::TargetRef::Object(id) = t {
                        c.counters = crate::ways::counters_on(vs, id);
                    }
                    c
                })
                .collect();
            let n = options.len();
            let mut p = Pending::new(Kind::Pick, Answer::TimeTravel, "time_travel", "Time travel", options).range(0, n, true).from(vs, resolving_source(vs));
            p.step = Some(match phase {
                TimeTravelPhase::Remove => "remove",
                TimeTravelPhase::Add => "add",
            });
            p
        }
        // ── loop shortcuts (CR 732.2) ────────────────────────────────────
        WaitingFor::LoopShortcut { proposer, predicted_winner, certificate, .. } if *proposer == me => {
            // The engine's own counts: until a player loses where the loop is unbounded, else
            // the count its own declaration drives.
            let options: Vec<Choice> = candidates
                .iter()
                .filter_map(|a| match a {
                    GameAction::DeclareShortcut { count: IterationCount::UntilLethal, .. } => Some(word("lethal", "Until a player loses")),
                    GameAction::DeclareShortcut { count: IterationCount::Fixed(n), .. } => Some(word(n.to_string(), format!("{n} times"))),
                    GameAction::DeclareShortcut { count: IterationCount::WithoutEnd, .. } => Some(word("without_end", "Without end (draw)")),
                    _ => None,
                })
                .collect();
            let first = options.first().map(|o| o.id.clone());
            let mut p = Pending::new(Kind::Pick, Answer::ProposeShortcut, "shortcut", "Propose a shortcut", options).range(1, 1, false).from(vs, vs.stack.last().map(|e| e.source_id));
            p.default_answer = first.map(|f| json!([f]));
            p.shortcut = Some(ShortcutView {
                proposer: me.0,
                count: None,
                iteration_count: candidates.iter().find_map(|a| if let GameAction::DeclareShortcut { count, .. } = a { Some(count.clone()) } else { None }),
                grows: certificate.unbounded.iter().map(|a| axis_words(a, names)).collect(),
                wins: certificate.win_kind.map(win_words),
                winner: predicted_winner.map(|w| w.0),
                responders: responders(vs, me, None, &[]),
                shortened_by: None,
            });
            p
        }
        WaitingFor::RespondToShortcut { player, remaining_players, proposal } if *player == me => {
            // Accept (the whole count) or name an earlier place to stop (CR 732.2b): a number below
            // the count, or any number for a loop that runs until a player loses.
            let places = proposal.shortening_places();
            let count = match proposal.count {
                IterationCount::Fixed(n) => Some(n),
                IterationCount::UntilLethal | IterationCount::WithoutEnd => None,
            };
            let who = seat_name(proposal.proposer, names);
            let prompt = match count {
                Some(n) => format!("{who} proposes a shortcut: repeat {n} times"),
                None if proposal.count == IterationCount::WithoutEnd => format!("{who} proposes a shortcut: repeat without end (draw)"),
                None => format!("{who} proposes a shortcut: repeat until a player loses"),
            };
            let mut p = Pending::new(Kind::Number, Answer::RespondToShortcut, "shortcut_response", prompt, vec![]).from(vs, vs.stack.last().map(|e| e.source_id));
            p.min = *places.start() as usize;
            p.max = (*places.end()).min(9_999) as usize;
            p.total = count;
            p.shortcut = Some(ShortcutView {
                proposer: proposal.proposer.0,
                count,
                iteration_count: Some(proposal.count.clone()),
                grows: proposal.unbounded.iter().map(|a| axis_words(a, names)).collect(),
                wins: proposal.win_kind.map(win_words),
                winner: proposal.predicted_winner.map(|w| w.0),
                responders: responders(vs, proposal.proposer, Some(me), remaining_players),
                shortened_by: proposal.shortened_by.map(|p| p.0),
            });
            p
        }
        WaitingFor::PrecastCopyShortcutOffer { proposer, .. } if *proposer == me => {
            // The engine proved a finite route for this cast: propose it, or play it out.
            let mut p = Pending::new(Kind::Yesno, Answer::ProposeShortcut, "precast_shortcut", "The engine can take this to its end in one step. Propose the shortcut?", vec![])
                .yes_no("Propose the shortcut", "Keep playing it out")
                .from(vs, vs.stack.last().map(|e| e.source_id));
            p.shortcut = Some(ShortcutView { proposer: me.0, count: None, iteration_count: None, grows: vec![], wins: None, winner: None, responders: responders(vs, me, None, &[]), shortened_by: None });
            p
        }
        WaitingFor::RespondToPrecastCopyShortcut { player, breakpoint_ids, remaining_players, .. } if *player == me => {
            // Accept, or stop it at one of the places the engine marks where you'd get priority.
            let mut options = vec![word("accept", "Accept")];
            options.extend(breakpoint_ids.iter().enumerate().map(|(i, id)| word(id.to_string(), format!("Stop it at your chance {} to act", i + 1))));
            let proposer = vs.stack.last().map(|e| e.controller).unwrap_or(me);
            let mut p = Pending::new(Kind::Pick, Answer::RespondToShortcut, "precast_response", format!("{} proposes a shortcut", seat_name(proposer, names)), options)
                .range(1, 1, false)
                .from(vs, vs.stack.last().map(|e| e.source_id));
            p.default_answer = Some(json!(["accept"]));
            p.shortcut = Some(ShortcutView { proposer: proposer.0, count: None, iteration_count: None, grows: vec![], wins: None, winner: None, responders: responders(vs, proposer, Some(me), remaining_players), shortened_by: None });
            p
        }
        // CR 608.2c: "You may repeat this process any number of times."
        WaitingFor::RepeatDecision { player, ability } if *player == me => {
            let what = ability.description.as_deref().map(|d| crate::ability_text(d, &Match::name_in(vs, &ability.source_id))).filter(|d| !d.is_empty());
            let prompt = match what {
                Some(d) => format!("Repeat this process? {d}"),
                None => "Repeat this process?".to_string(),
            };
            Pending::new(Kind::Yesno, Answer::DecideOptionalEffect, "repeat", prompt, vec![]).yes_no("Repeat it", "Stop").from(vs, Some(ability.source_id))
        }
        // ── the command zone (CR 903.9a) ─────────────────────────────────
        WaitingFor::CommanderZoneChoice { player, commander_id, current_zone } if *player == me => {
            let name = Match::name_in(vs, commander_id);
            let zone = match current_zone {
                Zone::Graveyard => "Graveyard",
                Zone::Exile => "Exile",
                Zone::Hand => "Hand",
                Zone::Library => "Library",
                _ => "Leave it",
            };
            let mut p = Pending::new(Kind::Yesno, Answer::DecideOptionalEffect, "commander_zone", format!("Put {name} into the command zone?"), vec![])
                .yes_no("Command zone", zone)
                .from(vs, Some(*commander_id));
            // Yama can answer this for you from now on (remember.rs).
            p.remember = Some("yama");
            p
        }
        _ => return None,
    };
    Some(p)
}

/// A dungeon as an option: its name, and its first room in the card's words (where the marker
/// lands at once, CR 309.4a).
fn dungeon_option(d: &DungeonPreview) -> Choice {
    let mut o = word(format!("{:?}", d.dungeon), d.name.clone());
    o.text = Some(format!("{}: {}", d.entry_room.name, d.entry_room.text));
    o.img = Some(dungeon_image(&d.card.scryfall_id));
    o
}

/// What a permanent entering attacking attacks (CR 508.4): players by seat, planeswalkers and
/// battles by id.
fn attack_target(vs: &GameState, valid: &[AttackTarget], names: &[String], prompt: String, source: Option<ObjectId>) -> Pending {
    let options = valid
        .iter()
        .map(|t| match t {
            AttackTarget::Player(p) => player_choice(*p, names),
            AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => card(vs, id, true),
        })
        .collect();
    Pending::new(Kind::Pick, Answer::ChooseEntryAttackTarget, "entry_attack", one_line(&prompt), options).range(1, 1, false).from(vs, source)
}
