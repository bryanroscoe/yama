// What the Group page reads from the playgroup's games itself (the server's stats cover the rest):
// each player's most-played commander, who played each commander, and your record against each
// other player in the games you both sat in.

import type { GameRow, GameSeat, Member, PlayerStat } from "../api";

export interface Rival {
  key: string;
  name: string;
  shared: number;
  mine: number;
  theirs: number;
}

/**
 * One key per person across a playgroup's games, in step with the server's stats
 * (server/src/stats.rs): the member row, else the account, else the typed name. A seat saved
 * with an account but no member row (an online game from before Yama recorded it, or "me" at the
 * table) still counts for the member with that account.
 */
export function playerKeys(members: Member[]) {
  const memberOf = (userId: string | null | undefined) => (userId ? members.find((m) => m.user_id === userId)?.id : undefined);
  return {
    seat: (s: GameSeat) => s.member_id ?? memberOf(s.user_id) ?? (s.user_id ? `u:${s.user_id}` : `g:${s.guest_name ?? s.display_name ?? "?"}`),
    player: (p: PlayerStat) => p.member_id ?? (p.key.startsWith("u:") ? memberOf(p.key.slice(2)) : undefined) ?? p.key,
    account: (userId: string | undefined) => (userId ? (memberOf(userId) ?? `u:${userId}`) : undefined),
  };
}

export function readGames(games: GameRow[], me: string | undefined, seatKey: (s: GameSeat) => string) {
  const played = new Map<string, Map<string, number>>();
  const byCommander = new Map<string, Map<string, string>>();
  const rivals = new Map<string, Rival>();
  for (const g of games) {
    if (g.status !== "finished") continue;
    const winner = g.seats.find((s) => s.seat === g.winner_seat);
    for (const s of g.seats) {
      const k = seatKey(s);
      if (s.commander_name) {
        const m = played.get(k) ?? new Map<string, number>();
        m.set(s.commander_name, (m.get(s.commander_name) ?? 0) + 1);
        played.set(k, m);
        const who = byCommander.get(s.commander_name) ?? new Map<string, string>();
        who.set(k, s.display_name ?? s.guest_name ?? "?");
        byCommander.set(s.commander_name, who);
      }
    }
    if (!me || !g.seats.some((s) => seatKey(s) === me)) continue;
    for (const s of g.seats) {
      const k = seatKey(s);
      if (k === me) continue;
      const r = rivals.get(k) ?? { key: k, name: s.display_name ?? s.guest_name ?? "?", shared: 0, mine: 0, theirs: 0 };
      r.shared += 1;
      if (winner && seatKey(winner) === me) r.mine += 1;
      if (winner && seatKey(winner) === k) r.theirs += 1;
      rivals.set(k, r);
    }
  }
  const favourite = (k: string) => [...(played.get(k) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const list = [...rivals.values()];
  const beatsMe = list.filter((r) => r.theirs > r.mine).sort((a, b) => b.theirs - b.mine - (a.theirs - a.mine) || b.theirs - a.theirs)[0];
  const iBeat = list.filter((r) => r.mine > r.theirs).sort((a, b) => b.mine - b.theirs - (a.mine - a.theirs) || b.mine - a.mine)[0];
  return { favourite, players: (c: string) => [...(byCommander.get(c)?.values() ?? [])], beatsMe, iBeat };
}
