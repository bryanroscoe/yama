//! Looking at the library, the decisions GLibrary designs that weren't live yet
//! (docs/game-interactions-review-2026-10-23.md, "Looking at the library"): top or bottom, the
//! Cultivate split, putting a dig's rest on top and bottom, revealing a card, keeping what a
//! reveal-until found, manifest dread and learn. Surveil, dig, scry, search and the bottom order
//! of a reveal-until are in act.rs. Each is read from the deciding seat's filtered view, so a
//! library card is named only for the seat allowed to see it.
//!
//! A reveal-until whose rest goes to the bottom "in a random order" (Jace, Multiverse
//! Architect's −3) asks nothing: the board shows the reveal from the event feed until its player
//! presses "Done looking".

use engine::types::actions::{GameAction, LearnOption};
use engine::types::ability::LibraryPosition;
use engine::types::game_state::{GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use engine::types::zones::{EtbTapState, Zone};
use serde_json::json;

use crate::Match;
use crate::act::{Answer, Kind, Pending, a_or, capitalised, card, cards, word};
use crate::together::resolving_source;

/// Where a card goes, in the words a button uses: "onto the battlefield tapped", "into your hand".
fn place(zone: Zone, tapped: bool) -> String {
    match zone {
        Zone::Battlefield if tapped => "onto the battlefield tapped".into(),
        Zone::Battlefield => "onto the battlefield".into(),
        Zone::Hand => "into your hand".into(),
        Zone::Graveyard => "into your graveyard".into(),
        Zone::Library => "into your library".into(),
        Zone::Exile => "into exile".into(),
        Zone::Stack => "onto the stack".into(),
        Zone::Command => "into the command zone".into(),
    }
}

/// The engine's first answer of a `SelectCards` kind, as the design's `defaultAnswer` (ids).
fn first_pick(candidates: &[GameAction]) -> Option<serde_json::Value> {
    candidates.iter().find_map(|a| match a {
        GameAction::SelectCards { cards } => Some(json!(cards.iter().map(|c| c.0.to_string()).collect::<Vec<_>>())),
        _ => None,
    })
}

/// The decisions this module describes, or `None` for any other.
pub(crate) fn of(vs: &GameState, me: PlayerId, candidates: &[GameAction], names: &[String]) -> Option<Pending> {
    let p = match &vs.waiting_for {
        WaitingFor::TopOrBottomChoice { player, object_id, top_position } if *player == me => {
            // CR 401.4: the top or the bottom of its owner's library.
            let name = Match::name_in(vs, object_id);
            let owner = vs.objects.get(object_id).map(|o| o.owner);
            let whose = match owner {
                Some(o) if o == me => "your".to_string(),
                Some(o) => format!("{}'s", names.get(usize::from(o.0)).cloned().unwrap_or_else(|| format!("Player {}", o.0 + 1))),
                None => "its owner's".to_string(),
            };
            let (places, upper) = match top_position {
                LibraryPosition::Top => ("on the top or bottom".to_string(), "Top".to_string()),
                LibraryPosition::NthFromTop { n } => {
                    let ordinal = match n {
                        1 => "first".to_string(),
                        2 => "second".to_string(),
                        3 => "third".to_string(),
                        _ => {
                            let suffix = match n % 100 {
                                11..=13 => "th",
                                _ => match n % 10 { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" },
                            };
                            format!("{n}{suffix}")
                        }
                    };
                    (format!("{ordinal} from the top or on the bottom"), format!("{} from top", capitalised(&ordinal)))
                }
                _ => return None,
            };
            let mut p = Pending::new(Kind::Pick, Answer::ChooseTopOrBottom, "top_or_bottom", format!("Put {name} {places} of {whose} library?"), vec![word("top", upper), word("bottom", "Bottom")])
                .range(1, 1, false)
                .from(vs, resolving_source(vs));
            p.shown = vec![card(vs, object_id, false)];
            p
        }
        WaitingFor::SearchPartitionChoice { player, cards: ids, primary_destination, primary_count, primary_enter_tapped, rest_destination, source_id } if *player == me => {
            // CR 701.23a: the cards found are split between two places (Cultivate: one onto the
            // battlefield tapped, the other into your hand). The picked ones go to the first.
            let n = *primary_count as usize;
            let to = place(*primary_destination, *primary_enter_tapped == EtbTapState::Tapped);
            let rest = place(*rest_destination, false);
            let which = if n == 1 { "Which card goes" } else { "Which cards go" };
            let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "partition", format!("{which} {to}?"), cards(vs, ids))
                .range(n, n, false)
                .from(vs, Some(*source_id));
            p.places = vec![capitalised(&to), capitalised(&rest)];
            p.default_answer = first_pick(candidates);
            p
        }
        WaitingFor::DigRestSplitChoice { player, cards: ids, top_count, bottom_count, scope, source_id, .. } if *player == me => {
            // CR 401.4, 608.2d: every card, in order: the first `top_count` go on top (the first
            // drawn next), the rest to the bottom (the last at the very bottom). When the split
            // was someone else's to make, only the order within each pile is left.
            let prompt = match (*top_count, *bottom_count) {
                (0, _) => "Put these on the bottom, in order".to_string(),
                (_, 0) => "Put these on top, in order".to_string(),
                (t, b) => format!("Put {} on top and {} on the bottom", a_or(t, "card", "cards"), a_or(b, "card", "cards")),
            };
            let mut p = Pending::new(Kind::Order, Answer::SelectCards, "dig_split", prompt, cards(vs, ids)).from(vs, *source_id);
            p.min = ids.len();
            p.max = ids.len();
            p.ordered = true;
            p.top_count = Some(*top_count);
            p.fixed_split = !scope.partition_is_open();
            p.default_answer = first_pick(candidates);
            p
        }
        WaitingFor::RevealChoice { player, cards: ids, optional, .. } if *player == me => {
            // CR 701.20a: a card to reveal (a reveal land); "you may" allows none.
            let n = usize::from(!*optional);
            Pending::new(Kind::Pick, Answer::SelectCards, "reveal", "Reveal a card", cards(vs, ids)).range(n, 1, *optional).from(vs, resolving_source(vs))
        }
        WaitingFor::RevealUntilKeptChoice { player, hit_card, source_id, accept_zone, decline_zone, enter_tapped, revealed_misses, .. } if *player == me => {
            // CR 701.20a: the card a reveal-until found, which you may put somewhere; the cards it
            // went past were revealed to everyone.
            let name = Match::name_in(vs, hit_card);
            let yes = place(*accept_zone, *enter_tapped == EtbTapState::Tapped);
            let no = place(*decline_zone, false);
            let mut options: Vec<_> = revealed_misses.iter().map(|id| card(vs, id, false)).collect();
            options.push(card(vs, hit_card, true));
            Pending::new(Kind::Yesno, Answer::DecideOptionalEffect, "kept", format!("Put {name} {yes}?"), options)
                .yes_no(capitalised(&yes), capitalised(&no))
                .from(vs, Some(*source_id))
        }
        WaitingFor::ManifestDreadChoice { player, cards: ids, source_id } if *player == me && !ids.is_empty() => {
            // CR 701.62a: one onto the battlefield face down, the other into your graveyard. Only
            // you see them (the engine's filtered view names them only for you).
            let mut p = Pending::new(Kind::Pick, Answer::SelectCards, "manifest", "Manifest dread: choose the card to put onto the battlefield face down", cards(vs, ids))
                .range(1, 1, false)
                .from(vs, Some(*source_id));
            p.places = vec!["Onto the battlefield face down".into(), "Into your graveyard".into()];
            p
        }
        WaitingFor::LearnChoice { player, hand_cards } if *player == me => {
            // CR 701.48a: the engine offers the rummage (discard a card, then draw) or nothing.
            Pending::new(Kind::Pick, Answer::Learn, "learn", "Learn: discard a card to draw a card?", cards(vs, hand_cards)).range(0, 1, true).from(vs, resolving_source(vs))
        }
        _ => return None,
    };
    Some(p)
}

/// The engine's learn answer: rummage `discard`, or skip.
pub(crate) fn learn_action(discard: Option<u64>) -> GameAction {
    GameAction::LearnDecision {
        choice: match discard {
            Some(id) => LearnOption::Rummage { card_id: ObjectId(id) },
            None => LearnOption::Skip,
        },
    }
}
