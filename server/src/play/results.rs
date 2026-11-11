//! What an online game adds to the shared game record (`games`, `game_seats`) besides its winner:
//! each knockout's turn, who did it and how the game was won, so playgroup stats read an online
//! game like one the table logged.
//!
//! Only facts the engine stated go in, and only ones that can't be read two ways:
//!
//! - A knockout's turn is the turn of its `Out` happening in the spectator's feed (the moment it
//!   happened), or the engine's turn after that action once the feed has let it go.
//! - Who did it is recorded for combat damage alone: the last thing that happened to the player
//!   before they went out was combat damage, in that turn, and it either took them to zero or
//!   was commander damage that reached 21. Attacking creatures belong to the player whose turn
//!   it is, so that player did it. The feed's own "by" for damage isn't used: it is whoever
//!   controls the source after the action, which for a stolen spell, or a stolen creature that
//!   died in the same combat, is its owner again.
//! - Everything else names nobody and stays unrecorded rather than guessed: burn and other
//!   damage outside combat, a drain, poison, an empty library, a concession.
//! - How the game was won comes from the knockouts that ended it: commander damage, poison, a
//!   concession, or combat when the last hit was combat damage. An empty library isn't called
//!   mill (the engine says they drew from it, not who emptied it), and a card that says "you win"
//!   gives no cause at all; the game-over screen can say what the engine couldn't.

use yama_play::feed::{Hit, What};
use yama_play::{Happening, Out, Why};

/// One seat's knockout as `game_seats` stores it.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Knockout {
    pub(super) seat: u8,
    /// The engine's turn number: every player's turn counts, as in `games.turns` for online games.
    pub(super) turn: u32,
    pub(super) by: Option<u8>,
    /// The feed still holds this knockout, so `turn` and `by` are read from the moment it
    /// happened. Without it they are what's left to tell: the caller keeps what it stored then.
    pub(super) seen: bool,
}

/// Where `seat` went out in the feed, if the feed still holds it.
fn out_at(events: &[Happening], seat: u8) -> Option<usize> {
    events.iter().rposition(|h| matches!(h.what, What::Out { seat: s } if s == seat))
}

/// The combat damage that put `seat` out: the last thing to change their life before the
/// knockout at `events[out]`, if it was combat damage dealt in that turn. Gives the player whose
/// turn it was (the attacker) and the life it left them on, when the engine said.
fn last_combat_hit(events: &[Happening], out: usize, seat: u8) -> Option<(u8, Option<i32>)> {
    let last = events[..out].iter().rev().find(|h| match &h.what {
        What::Damage { to: Hit::Player { seat: s }, .. } | What::Life { seat: s, .. } => *s == seat,
        _ => false,
    })?;
    match &last.what {
        What::Damage { combat: true, life, .. } if last.turn == events[out].turn => Some((last.active, life.map(|[_, after]| after))),
        _ => None,
    }
}

/// Whether combat damage put `seat` out for the cause the engine read, and who attacked.
fn combat_knockout(events: &[Happening], out: usize, o: &Out) -> Option<u8> {
    let (attacker, life_after) = last_combat_hit(events, out, o.seat)?;
    match &o.why {
        // 21 from one commander: the hit that got there is the one that put them out.
        Why::Commander { .. } => Some(attacker),
        Why::Life { .. } if life_after.is_some_and(|after| after <= 0) => Some(attacker),
        _ => None,
    }
}

/// Every knockout so far, in the order they happened. `events` is the spectator's feed
/// (`Match::events(None)`), which holds the newest happenings only.
pub(super) fn knockouts(outs: &[Out], events: &[Happening]) -> Vec<Knockout> {
    outs.iter()
        .map(|o| match out_at(events, o.seat) {
            Some(at) => Knockout {
                seat: o.seat,
                turn: events[at].turn,
                // Combat damage on your own turn can't be yours to deal to yourself; be sure anyway.
                by: combat_knockout(events, at, o).filter(|by| *by != o.seat),
                seen: true,
            },
            None => Knockout { seat: o.seat, turn: o.turn, by: None, seen: false },
        })
        .collect()
}

/// How the winner won (`crate::stats::WIN_CONDITIONS`), from the knockouts that ended the game:
/// the players who went out last, together. `None` for a draw, and whenever those knockouts don't
/// all say the same thing or the engine gave no cause that reads one way.
pub(super) fn win_condition(outs: &[Out], events: &[Happening], winner: Option<u8>) -> Option<&'static str> {
    let winner = winner?;
    let last = outs.last()?.batch;
    let mut how = outs.iter().filter(|o| o.batch == last && o.seat != winner).map(|o| match &o.why {
        Why::Conceded => Some("concession"),
        Why::Commander { .. } => Some("commander_damage"),
        Why::Poison { .. } => Some("poison"),
        Why::Life { .. } => out_at(events, o.seat).and_then(|at| combat_knockout(events, at, o)).map(|_| "combat"),
        Why::Library | Why::Unknown => None,
    });
    let first = how.next()??;
    how.all(|h| h == Some(first)).then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yama_play::feed::Seen;

    fn happening(seq: u64, turn: u32, active: u8, what: What) -> Happening {
        Happening { seq, turn, active, what }
    }

    /// Damage to `to` on `active`'s turn. `by` is the feed's own reading of who controls the
    /// source, which the record must not depend on.
    fn damage(seq: u64, turn: u32, active: u8, by: Option<u8>, to: u8, combat: bool, life: Option<[i32; 2]>) -> Happening {
        happening(seq, turn, active, What::Damage { source: Seen::default(), by, to: Hit::Player { seat: to }, amount: 3, combat, life })
    }

    fn out(seat: u8, turn: u32, why: Why, batch: u64) -> Out {
        let inferred = !matches!(why, Why::Conceded | Why::Unknown);
        Out { seat, turn, life: 0, why, inferred, batch }
    }

    fn gone(seq: u64, turn: u32, active: u8, seat: u8) -> Happening {
        happening(seq, turn, active, What::Out { seat })
    }

    fn knockout(seat: u8, turn: u32, by: Option<u8>) -> Knockout {
        Knockout { seat, turn, by, seen: true }
    }

    #[test]
    fn lethal_combat_damage_names_the_attacking_player() {
        let outs = [out(2, 7, Why::Life { life: -1 }, 40)];
        let events = [damage(1, 6, 1, Some(1), 2, true, Some([9, 2])), damage(2, 7, 0, Some(0), 2, true, Some([2, -1])), gone(3, 7, 0, 2)];
        assert_eq!(knockouts(&outs, &events), vec![knockout(2, 7, Some(0))]);
        assert_eq!(win_condition(&outs, &events, Some(0)), Some("combat"));
    }

    #[test]
    fn a_stolen_attacker_that_died_in_the_same_combat_still_credits_whoever_attacked() {
        // Seat 0 attacks with seat 1's creature (Act of Treason). It trades with a blocker while
        // its trample damage finishes seat 2, and is seat 1's again by the time the feed asks who
        // controls it: the feed says seat 1, the turn says seat 0.
        let outs = [out(2, 7, Why::Life { life: -2 }, 40)];
        let events = [damage(1, 7, 0, Some(1), 2, true, Some([3, -2])), gone(2, 7, 0, 2)];
        assert_eq!(knockouts(&outs, &events), vec![knockout(2, 7, Some(0))]);
    }

    #[test]
    fn damage_outside_combat_names_nobody() {
        // A stolen Lightning Bolt goes to its owner's graveyard as it resolves, so the feed's
        // "by" is its owner whoever cast it. Nothing outside combat is certain: unrecorded.
        let outs = [out(2, 7, Why::Life { life: 0 }, 40)];
        for by in [Some(0), Some(1), None] {
            let burn = [damage(1, 7, 1, by, 2, false, Some([3, 0])), gone(2, 7, 1, 2)];
            assert_eq!(knockouts(&outs, &burn), vec![knockout(2, 7, None)]);
            assert_eq!(win_condition(&outs, &burn, Some(0)), None);
        }
    }

    #[test]
    fn a_knockout_combat_damage_didnt_finish_stays_unrecorded() {
        let outs = [out(1, 5, Why::Life { life: 0 }, 9)];
        // Life lost to something other than damage after the last hit.
        let drained = [damage(1, 5, 0, Some(0), 1, true, Some([5, 2])), happening(2, 5, 0, What::Life { seat: 1, delta: -2, total: Some(0) }), gone(3, 5, 0, 1)];
        assert_eq!(knockouts(&outs, &drained)[0].by, None);
        assert_eq!(win_condition(&outs, &drained, Some(0)), None);
        // The hit left them above zero, or the engine gave no totals with it.
        for life in [Some([5, 2]), None] {
            assert_eq!(knockouts(&outs, &[damage(1, 5, 0, Some(0), 1, true, life), gone(2, 5, 0, 1)])[0].by, None);
        }
        // A hit from an earlier turn (something kept them in the game since).
        assert_eq!(knockouts(&outs, &[damage(1, 4, 0, Some(0), 1, true, Some([1, -2])), gone(2, 5, 2, 1)])[0].by, None);
        // Someone else's knockout in the feed says nothing about this one.
        assert_eq!(knockouts(&outs, &[damage(1, 5, 0, Some(0), 2, true, Some([1, -2])), gone(2, 5, 0, 2)])[0], Knockout { seat: 1, turn: 5, by: None, seen: false });
    }

    #[test]
    fn a_knockout_takes_its_turn_from_the_moment_it_happened() {
        // The action that put seat 1 out went on into the next turn: the engine's list says 6,
        // the feed says it happened on turn 5.
        let outs = [out(1, 6, Why::Conceded, 3)];
        assert_eq!(knockouts(&outs, &[gone(1, 5, 0, 1)]), vec![knockout(1, 5, None)]);
        // Once the feed has let it go, the engine's turn is all that's left to tell.
        assert_eq!(knockouts(&outs, &[]), vec![Knockout { seat: 1, turn: 6, by: None, seen: false }]);
    }

    #[test]
    fn commander_damage_credits_whoever_attacked_with_the_commander() {
        // Seat 3's commander, attacking for seat 0 who took control of it.
        let why = Why::Commander { name: "Éowyn".into(), seat: 3, damage: 21 };
        let outs = [out(4, 9, why.clone(), 5)];
        let events = [damage(1, 9, 0, Some(3), 4, true, Some([30, 26])), gone(2, 9, 0, 4)];
        assert_eq!(knockouts(&outs, &events), vec![knockout(4, 9, Some(0))]);
        assert_eq!(win_condition(&outs, &events, Some(0)), Some("commander_damage"));
        // With the hit gone from the feed nobody is named, but the cause still stands.
        assert_eq!(knockouts(&outs, &[gone(2, 9, 0, 4)]), vec![knockout(4, 9, None)]);
        assert_eq!(win_condition(&outs, &[], Some(0)), Some("commander_damage"));
    }

    #[test]
    fn poison_decking_and_concessions_name_nobody() {
        let outs = [out(0, 4, Why::Conceded, 1), out(1, 6, Why::Poison { count: 10 }, 2), out(2, 8, Why::Library, 3), out(3, 9, Why::Unknown, 4)];
        // Each went out right after combat damage that didn't cause it.
        let events: Vec<Happening> = outs.iter().flat_map(|o| [damage(u64::from(o.seat) * 2, o.turn, 5, Some(5), o.seat, true, Some([9, 6])), gone(u64::from(o.seat) * 2 + 1, o.turn, 5, o.seat)]).collect();
        assert_eq!(knockouts(&outs, &events), vec![knockout(0, 4, None), knockout(1, 6, None), knockout(2, 8, None), knockout(3, 9, None)]);
        assert_eq!(win_condition(&outs[..2], &events, Some(5)), Some("poison"));
        assert_eq!(win_condition(&outs[..1], &events, Some(5)), Some("concession"));
        // The engine says they drew from an empty library, not who emptied it; and "you win the
        // game" gives no cause.
        assert_eq!(win_condition(&outs[..3], &events, Some(5)), None);
        assert_eq!(win_condition(&outs, &events, Some(5)), None);
        // A draw has no win condition, and neither does a game nobody went out of.
        assert_eq!(win_condition(&outs[..1], &events, None), None);
        assert_eq!(win_condition(&[], &[], Some(0)), None);
    }

    #[test]
    fn players_who_went_out_together_must_agree_on_how() {
        let commander = Why::Commander { name: "Éowyn".into(), seat: 0, damage: 21 };
        let together = [out(1, 9, commander.clone(), 7), out(2, 9, commander, 7)];
        assert_eq!(win_condition(&together, &[], Some(0)), Some("commander_damage"));
        let mixed = [out(1, 9, Why::Poison { count: 10 }, 7), out(2, 9, Why::Unknown, 7)];
        assert_eq!(win_condition(&mixed, &[], Some(0)), None);
        // An earlier knockout doesn't decide how the game ended.
        let earlier = [out(1, 4, Why::Poison { count: 10 }, 2), out(2, 9, Why::Conceded, 7)];
        assert_eq!(win_condition(&earlier, &[], Some(0)), Some("concession"));
    }
}
