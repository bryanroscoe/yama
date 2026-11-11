//! What an online game adds to the shared game record (`games`, `game_seats`) besides its winner:
//! each knockout's turn, who did it and how the game was won, so playgroup stats read an online
//! game like one the table logged.
//!
//! Only facts the engine stated go in, and only ones that can't be read two ways:
//!
//! - A knockout's turn is the turn of its `Out` happening in the spectator's feed (the moment it
//!   happened), or the engine's turn after that action once the feed has let it go.
//! - Who did it is recorded for an attacker's combat damage alone: the last thing that happened
//!   to the player before they went out was combat damage, in that turn, from a creature the
//!   feed shows a player declaring as an attacker that turn, and it either took them to zero or
//!   was commander damage that reached 21. Whoever declared that attacker did it. The feed's own
//!   "by" for damage isn't used: it is whoever controls the source after the action, which for a
//!   stolen spell, or a stolen creature that died in the same combat, is its owner again. Nor is
//!   "whose turn it was" enough: a blocker's combat damage can be redirected to a player.
//! - Everything else names nobody and stays unrecorded rather than guessed: burn and other
//!   damage outside combat, a blocker's damage, a source the feed can no longer point at, a
//!   drain, poison, an empty library, a concession.
//! - How the game was won comes from the knockouts that ended it: commander damage, poison, a
//!   concession, or combat when the last hit was combat damage. An empty library isn't called
//!   mill (the engine says they drew from it, not who emptied it), and a card that says "you win"
//!   gives no cause at all; the game-over screen can say what the engine couldn't.

use yama_play::feed::{Hit, Seen, What};
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

/// Who declared `source` as an attacker in `turn`, looking back from `before`: the feed's own
/// record of the attack (`AttackersDeclared`), matched by the card's id. `None` for a source that
/// didn't attack (a blocker) or that the feed can't point at any more.
fn declared_attacker(events: &[Happening], before: usize, turn: u32, source: &Seen) -> Option<u8> {
    let id = source.id?;
    events[..before].iter().rev().take_while(|h| h.turn == turn).find_map(|h| match &h.what {
        What::Attack { seat, attacks } if attacks.iter().any(|a| a.card.id == Some(id)) => Some(*seat),
        _ => None,
    })
}

/// The attacker's combat damage that put `seat` out: the last thing to change their life before
/// the knockout at `events[out]`, if it was combat damage dealt in that turn by a creature
/// declared as an attacker. Gives the player who attacked with it and the life it left them on,
/// when the engine said.
fn last_combat_hit(events: &[Happening], out: usize, seat: u8) -> Option<(u8, Option<i32>)> {
    let hit = events[..out].iter().rposition(|h| match &h.what {
        What::Damage { to: Hit::Player { seat: s }, .. } | What::Life { seat: s, .. } => *s == seat,
        _ => false,
    })?;
    let turn = events[out].turn;
    match &events[hit].what {
        What::Damage { combat: true, source, life, .. } if events[hit].turn == turn => {
            Some((declared_attacker(events, hit, turn, source)?, life.map(|[_, after]| after)))
        }
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
                // Your own attacker's damage coming back at you is nobody's knockout.
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
    use yama_play::feed::Attacked;

    fn happening(seq: u64, turn: u32, active: u8, what: What) -> Happening {
        Happening { seq, turn, active, what }
    }

    fn card(id: u64) -> Seen {
        Seen { id: Some(id), name: Some(format!("Card {id}")), face_down: false }
    }

    /// `seat` declares the creatures `ids` as attackers.
    fn attack(seq: u64, turn: u32, seat: u8, ids: &[u64]) -> Happening {
        let attacks = ids.iter().map(|id| Attacked { card: card(*id), at: Hit::Player { seat: 9 } }).collect();
        happening(seq, turn, seat, What::Attack { seat, attacks })
    }

    /// Damage to `to` from the card `source`. `by` is the feed's own reading of who controls the
    /// source after the action, which the record must not depend on.
    fn damage(seq: u64, turn: u32, source: u64, by: Option<u8>, to: u8, combat: bool, life: Option<[i32; 2]>) -> Happening {
        happening(seq, turn, 0, What::Damage { source: card(source), by, to: Hit::Player { seat: to }, amount: 3, combat, life })
    }

    fn out(seat: u8, turn: u32, why: Why, batch: u64) -> Out {
        let inferred = !matches!(why, Why::Conceded | Why::Unknown);
        Out { seat, turn, life: 0, why, inferred, batch }
    }

    fn gone(seq: u64, turn: u32, seat: u8) -> Happening {
        happening(seq, turn, 0, What::Out { seat })
    }

    fn knockout(seat: u8, turn: u32, by: Option<u8>) -> Knockout {
        Knockout { seat, turn, by, seen: true }
    }

    #[test]
    fn an_attackers_lethal_combat_damage_names_whoever_attacked_with_it() {
        let outs = [out(2, 7, Why::Life { life: -1 }, 40)];
        let events = [
            attack(1, 6, 1, &[50]),
            damage(2, 6, 50, Some(1), 2, true, Some([9, 2])),
            attack(3, 7, 0, &[60, 61]),
            damage(4, 7, 61, Some(0), 2, true, Some([2, -1])),
            gone(5, 7, 2),
        ];
        assert_eq!(knockouts(&outs, &events), vec![knockout(2, 7, Some(0))]);
        assert_eq!(win_condition(&outs, &events, Some(0)), Some("combat"));
    }

    #[test]
    fn a_stolen_attacker_that_died_in_the_same_combat_still_credits_whoever_attacked() {
        // Seat 0 attacks with seat 1's creature (Act of Treason). It trades with a blocker while
        // its trample damage finishes seat 2, and is seat 1's again by the time the feed asks who
        // controls it: the feed says seat 1, the attack says seat 0.
        let outs = [out(2, 7, Why::Life { life: -2 }, 40)];
        let events = [attack(1, 7, 0, &[60]), damage(2, 7, 60, Some(1), 2, true, Some([3, -2])), gone(3, 7, 2)];
        assert_eq!(knockouts(&outs, &events), vec![knockout(2, 7, Some(0))]);
    }

    #[test]
    fn a_blockers_redirected_combat_damage_names_nobody() {
        // On seat 0's turn, seat 1's blocker (70) deals combat damage to the attacker (60), and
        // part of it is redirected to seat 2 (Harm's Way). It is combat damage on seat 0's turn,
        // and seat 0 didn't deal it.
        let events = [attack(1, 7, 0, &[60]), damage(2, 7, 70, Some(1), 2, true, Some([2, 0])), gone(3, 7, 2)];
        let life = [out(2, 7, Why::Life { life: 0 }, 40)];
        assert_eq!(knockouts(&life, &events), vec![knockout(2, 7, None)]);
        assert_eq!(win_condition(&life, &events, Some(0)), None);
        // The same from a blocking commander that reaches 21: the cause stands, nobody is named.
        let commander = [out(2, 7, Why::Commander { name: "Éowyn".into(), seat: 1, damage: 21 }, 40)];
        assert_eq!(knockouts(&commander, &events), vec![knockout(2, 7, None)]);
        assert_eq!(win_condition(&commander, &events, Some(0)), Some("commander_damage"));
        // An attack on an earlier turn by the same card doesn't count for this one.
        let earlier = [attack(1, 6, 1, &[70]), attack(2, 7, 0, &[60]), damage(3, 7, 70, Some(1), 2, true, Some([2, 0])), gone(4, 7, 2)];
        assert_eq!(knockouts(&life, &earlier), vec![knockout(2, 7, None)]);
        // A source the feed can't point at any more (it went somewhere hidden) names nobody.
        let mut hidden = [attack(1, 7, 0, &[60]), damage(2, 7, 60, Some(0), 2, true, Some([2, 0])), gone(3, 7, 2)];
        if let What::Damage { source, .. } = &mut hidden[1].what {
            source.id = None;
        }
        assert_eq!(knockouts(&life, &hidden), vec![knockout(2, 7, None)]);
    }

    #[test]
    fn damage_outside_combat_names_nobody() {
        // A stolen Lightning Bolt goes to its owner's graveyard as it resolves, so the feed's
        // "by" is its owner whoever cast it. Nothing outside combat is certain: unrecorded.
        let outs = [out(2, 7, Why::Life { life: 0 }, 40)];
        for by in [Some(0), Some(1), None] {
            let burn = [attack(1, 7, 0, &[60]), damage(2, 7, 60, by, 2, false, Some([3, 0])), gone(3, 7, 2)];
            assert_eq!(knockouts(&outs, &burn), vec![knockout(2, 7, None)]);
            assert_eq!(win_condition(&outs, &burn, Some(0)), None);
        }
    }

    #[test]
    fn a_knockout_combat_damage_didnt_finish_stays_unrecorded() {
        let outs = [out(1, 5, Why::Life { life: 0 }, 9)];
        let hit = |life| [attack(1, 5, 0, &[60]), damage(2, 5, 60, Some(0), 1, true, life), gone(3, 5, 1)];
        assert_eq!(knockouts(&outs, &hit(Some([2, 0])))[0].by, Some(0), "the hit that does finish them");
        // Life lost to something other than damage after the last hit.
        let drained = [attack(1, 5, 0, &[60]), damage(2, 5, 60, Some(0), 1, true, Some([5, 2])), happening(3, 5, 0, What::Life { seat: 1, delta: -2, total: Some(0) }), gone(4, 5, 1)];
        assert_eq!(knockouts(&outs, &drained)[0].by, None);
        assert_eq!(win_condition(&outs, &drained, Some(0)), None);
        // The hit left them above zero, or the engine gave no totals with it.
        for life in [Some([5, 2]), None] {
            assert_eq!(knockouts(&outs, &hit(life))[0].by, None);
        }
        // A hit from an earlier turn (something kept them in the game since).
        assert_eq!(knockouts(&outs, &[attack(1, 4, 0, &[60]), damage(2, 4, 60, Some(0), 1, true, Some([1, -2])), gone(3, 5, 1)])[0].by, None);
        // Their own attacker's damage coming back at them.
        assert_eq!(knockouts(&outs, &[attack(1, 5, 1, &[60]), damage(2, 5, 60, Some(1), 1, true, Some([1, -2])), gone(3, 5, 1)])[0].by, None);
        // Someone else's knockout in the feed says nothing about this one.
        let other = [attack(1, 5, 0, &[60]), damage(2, 5, 60, Some(0), 2, true, Some([1, -2])), gone(3, 5, 2)];
        assert_eq!(knockouts(&outs, &other)[0], Knockout { seat: 1, turn: 5, by: None, seen: false });
    }

    #[test]
    fn a_knockout_takes_its_turn_from_the_moment_it_happened() {
        // The action that put seat 1 out went on into the next turn: the engine's list says 6,
        // the feed says it happened on turn 5.
        let outs = [out(1, 6, Why::Conceded, 3)];
        assert_eq!(knockouts(&outs, &[gone(1, 5, 1)]), vec![knockout(1, 5, None)]);
        // Once the feed has let it go, the engine's turn is all that's left to tell.
        assert_eq!(knockouts(&outs, &[]), vec![Knockout { seat: 1, turn: 6, by: None, seen: false }]);
    }

    #[test]
    fn commander_damage_credits_whoever_attacked_with_the_commander() {
        // Seat 3's commander (80), attacking for seat 0 who took control of it.
        let why = Why::Commander { name: "Éowyn".into(), seat: 3, damage: 21 };
        let outs = [out(4, 9, why, 5)];
        let events = [attack(1, 9, 0, &[80]), damage(2, 9, 80, Some(3), 4, true, Some([30, 26])), gone(3, 9, 4)];
        assert_eq!(knockouts(&outs, &events), vec![knockout(4, 9, Some(0))]);
        assert_eq!(win_condition(&outs, &events, Some(0)), Some("commander_damage"));
        // With the hit gone from the feed nobody is named, but the cause still stands.
        assert_eq!(knockouts(&outs, &[gone(3, 9, 4)]), vec![knockout(4, 9, None)]);
        assert_eq!(win_condition(&outs, &[], Some(0)), Some("commander_damage"));
    }

    #[test]
    fn poison_decking_and_concessions_name_nobody() {
        let outs = [out(0, 4, Why::Conceded, 1), out(1, 6, Why::Poison { count: 10 }, 2), out(2, 8, Why::Library, 3), out(3, 9, Why::Unknown, 4)];
        // Each went out right after an attacker's combat damage that didn't cause it.
        let events: Vec<Happening> = outs
            .iter()
            .flat_map(|o| {
                let seq = u64::from(o.seat) * 3;
                [attack(seq, o.turn, 5, &[60]), damage(seq + 1, o.turn, 60, Some(5), o.seat, true, Some([9, 6])), gone(seq + 2, o.turn, o.seat)]
            })
            .collect();
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
