//! What an online game adds to the shared game record (`games`, `game_seats`) besides its winner:
//! each knockout's turn, who did it and how the game was won, so playgroup stats read an online
//! game like one the table logged.
//!
//! Only facts the engine stated go in. A knockout's turn and cause are the feed's `Out`
//! (`yama_play::feed`); who did it is the owner of the commander that dealt 21, or whoever
//! controlled the source of the damage that took the player to zero. Everything else (a drain,
//! poison, an empty library, a concession) names nobody, and stays unrecorded rather than guessed.

use yama_play::feed::{Hit, What};
use yama_play::{Happening, Out, Why};

/// One seat's knockout as `game_seats` stores it.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Knockout {
    pub(super) seat: u8,
    /// The engine's turn number: every player's turn counts, as in `games.turns` for online games.
    pub(super) turn: u32,
    pub(super) by: Option<u8>,
}

/// The damage that took `seat` to zero life or less as it went out: who controlled its source and
/// whether it was combat damage. `None` when the last change to their life wasn't damage, when it
/// left them above zero, when it came a turn earlier (something else kept them in the game), or
/// when the feed no longer holds it.
fn lethal_damage(events: &[Happening], seat: u8) -> Option<(Option<u8>, bool)> {
    let out = events.iter().rposition(|h| matches!(h.what, What::Out { seat: s } if s == seat))?;
    let last = events[..out].iter().rev().find(|h| match &h.what {
        What::Damage { to: Hit::Player { seat: s }, .. } | What::Life { seat: s, .. } => *s == seat,
        _ => false,
    })?;
    match &last.what {
        What::Damage { by, combat, life: Some([_, after]), .. } if *after <= 0 && last.turn == events[out].turn => Some((*by, *combat)),
        _ => None,
    }
}

/// Every knockout so far, in the order they happened. `events` is the spectator's feed
/// (`Match::events(None)`); it holds the newest happenings only, so a knockout it has dropped
/// keeps its turn and loses its "by" (the caller keeps one already stored for the same knockout).
pub(super) fn knockouts(outs: &[Out], events: &[Happening]) -> Vec<Knockout> {
    outs.iter()
        .map(|o| {
            let by = match &o.why {
                Why::Commander { seat, .. } => Some(*seat),
                Why::Life { .. } => lethal_damage(events, o.seat).and_then(|(by, _)| by),
                Why::Conceded | Why::Poison { .. } | Why::Library | Why::Unknown => None,
            };
            // Your own card finishing you off is nobody's knockout.
            Knockout { seat: o.seat, turn: o.turn, by: by.filter(|b| *b != o.seat) }
        })
        .collect()
}

/// How the winner won (`crate::stats::WIN_CONDITIONS`), from the knockouts that ended the game:
/// the players who went out last, together. `None` for a draw, and whenever those knockouts don't
/// all say the same thing or the engine gave no cause (a card that says "you win the game", life
/// lost to something other than combat damage).
pub(super) fn win_condition(outs: &[Out], events: &[Happening], winner: Option<u8>) -> Option<&'static str> {
    let winner = winner?;
    let last = outs.last()?.batch;
    let mut how = outs.iter().filter(|o| o.batch == last && o.seat != winner).map(|o| match &o.why {
        Why::Conceded => Some("concession"),
        Why::Commander { .. } => Some("commander_damage"),
        Why::Poison { .. } => Some("poison"),
        Why::Library => Some("mill"),
        Why::Life { .. } => lethal_damage(events, o.seat).filter(|(_, combat)| *combat).map(|_| "combat"),
        Why::Unknown => None,
    });
    let first = how.next()??;
    how.all(|h| h == Some(first)).then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yama_play::feed::Seen;

    fn happening(seq: u64, turn: u32, what: What) -> Happening {
        Happening { seq, turn, active: 0, what }
    }

    fn damage(seq: u64, turn: u32, by: Option<u8>, to: u8, combat: bool, life: Option<[i32; 2]>) -> Happening {
        happening(seq, turn, What::Damage { source: Seen::default(), by, to: Hit::Player { seat: to }, amount: 3, combat, life })
    }

    fn out(seat: u8, turn: u32, why: Why, batch: u64) -> Out {
        let inferred = !matches!(why, Why::Conceded | Why::Unknown);
        Out { seat, turn, life: 0, why, inferred, batch }
    }

    fn gone(seq: u64, turn: u32, seat: u8) -> Happening {
        happening(seq, turn, What::Out { seat })
    }

    #[test]
    fn a_knockout_names_whoever_dealt_the_lethal_damage() {
        let outs = [out(2, 7, Why::Life { life: -1 }, 40)];
        let events = [damage(1, 6, Some(1), 2, true, Some([9, 2])), damage(2, 7, Some(0), 2, true, Some([2, -1])), gone(3, 7, 2)];
        assert_eq!(knockouts(&outs, &events), vec![Knockout { seat: 2, turn: 7, by: Some(0) }]);
        assert_eq!(win_condition(&outs, &events, Some(0)), Some("combat"));
        // Burn that finishes someone is their knockout, but not a combat win.
        let burn = [damage(2, 7, Some(0), 2, false, Some([2, -1])), gone(3, 7, 2)];
        assert_eq!(knockouts(&outs, &burn)[0].by, Some(0));
        assert_eq!(win_condition(&outs, &burn, Some(0)), None);
    }

    #[test]
    fn a_knockout_nobody_dealt_stays_unrecorded() {
        let outs = [out(1, 5, Why::Life { life: 0 }, 9)];
        // Life lost to something other than damage after the last hit: nobody's knockout.
        let drained = [damage(1, 5, Some(0), 1, true, Some([5, 2])), happening(2, 5, What::Life { seat: 1, delta: -2, total: Some(0) }), gone(3, 5, 1)];
        assert_eq!(knockouts(&outs, &drained)[0].by, None);
        assert_eq!(win_condition(&outs, &drained, Some(0)), None);
        // The damage left them above zero, or the engine gave no totals with it.
        for life in [Some([5, 2]), None] {
            assert_eq!(knockouts(&outs, &[damage(1, 5, Some(0), 1, true, life), gone(2, 5, 1)])[0].by, None);
        }
        // Their own source, a hit from an earlier turn, and a feed that has dropped the knockout.
        assert_eq!(knockouts(&outs, &[damage(1, 5, Some(1), 1, false, Some([1, 0])), gone(2, 5, 1)])[0].by, None);
        assert_eq!(knockouts(&outs, &[damage(1, 4, Some(0), 1, true, Some([1, -2])), gone(2, 5, 1)])[0].by, None);
        assert_eq!(knockouts(&outs, &[])[0], Knockout { seat: 1, turn: 5, by: None });
        // Someone else's knockout in the feed says nothing about this one.
        assert_eq!(knockouts(&outs, &[damage(1, 5, Some(0), 2, true, Some([1, -2])), gone(2, 5, 2)])[0].by, None);
    }

    #[test]
    fn commander_damage_poison_decking_and_concessions_read_from_the_cause() {
        let commander = Why::Commander { name: "Éowyn".into(), seat: 3, damage: 21 };
        let outs = [
            out(0, 4, Why::Conceded, 1),
            out(1, 6, Why::Poison { count: 10 }, 2),
            out(2, 8, Why::Library, 3),
            out(3, 9, Why::Commander { name: "Stolen".into(), seat: 3, damage: 22 }, 4),
            out(4, 9, commander.clone(), 5),
        ];
        let found = knockouts(&outs, &[]);
        assert_eq!(found.iter().map(|k| (k.seat, k.turn, k.by)).collect::<Vec<_>>(), vec![(0, 4, None), (1, 6, None), (2, 8, None), (3, 9, None), (4, 9, Some(3))]);
        assert_eq!(win_condition(&outs, &[], Some(5)), Some("commander_damage"));
        assert_eq!(win_condition(&outs[..3], &[], Some(5)), Some("mill"));
        assert_eq!(win_condition(&outs[..2], &[], Some(5)), Some("poison"));
        assert_eq!(win_condition(&outs[..1], &[], Some(5)), Some("concession"));
        // A draw has no win condition, and neither does a game nobody went out of.
        assert_eq!(win_condition(&outs, &[], None), None);
        assert_eq!(win_condition(&[], &[], Some(0)), None);
    }

    #[test]
    fn players_who_went_out_together_must_agree_on_how() {
        let commander = Why::Commander { name: "Éowyn".into(), seat: 0, damage: 21 };
        let together = [out(1, 9, commander.clone(), 7), out(2, 9, commander, 7)];
        assert_eq!(win_condition(&together, &[], Some(0)), Some("commander_damage"));
        let mixed = [out(1, 9, Why::Poison { count: 10 }, 7), out(2, 9, Why::Unknown, 7)];
        assert_eq!(win_condition(&mixed, &[], Some(0)), None);
        let unknown = [out(1, 9, Why::Unknown, 7)];
        assert_eq!(win_condition(&unknown, &[], Some(0)), None);
    }
}
