import type { TableDeck, TableGame, TableView } from "./api";
import { placeText } from "./logic";

/** The seats in turn order: the first player, then the seats after it. */
export function turnOrder(g: TableGame): number[] {
  const n = g.seats.length;
  const first = g.first_seat ?? 0;
  return Array.from({ length: n }, (_, i) => (first + i) % n);
}

/** Where `deck` sat in a game, or -1. */
export function seatOf(g: TableGame, deck: string): number {
  return g.seats.indexOf(deck);
}

/** How a game ended, as a sentence about the table. */
export function endText(g: TableGame, label: (id: string) => string): string {
  if (!g.played) return "Not played yet";
  const winner = g.winner != null ? g.seats[g.winner] : undefined;
  switch (g.end) {
    case "win":
      return winner ? `${label(winner)} won on turn ${g.turns}` : `Won on turn ${g.turns}`;
    case "draw":
      return `Drawn on turn ${g.turns}: the last players went out together`;
    case "turn_cap":
      return `Nobody won: the game reached the turn cap (${g.turns} turns)`;
    case "action_cap":
      return "Nobody won: the game reached the action cap";
    case "time_cap":
      return "Not scored: the game ran out of CPU time";
    case "panic":
      return "Not scored: the engine crashed";
    default:
      return "Not scored: the game failed";
  }
}

/** One seat's game in a few words: "Won", "Out on turn 31", "Still in, 12 life". */
export function seatText(g: TableGame, seat: number): string {
  if (!g.played) return "";
  if (g.winner === seat && g.end === "win") return "Won";
  const out = g.out_turn[seat];
  if (out != null) return `Out on turn ${out}`;
  const life = g.final_life[seat];
  if (!g.scored) return life != null ? `${life} life when it stopped` : "";
  return life != null ? `Still in, ${life} life` : "Still in";
}

/** A place as a short badge: "1st", "2nd", "Tied 3rd" (tied players share the mean). */
export function placeBadge(place: number | null | undefined): string {
  if (place == null) return "";
  if (Number.isInteger(place)) return placeText(place);
  return `Tied ${placeText(Math.floor(place))}`;
}

export interface DeckRecord {
  /** Games played at these tables, scored or not. */
  played: number;
  scored: number;
  wins: number;
  /** Scored games by place: [1st, 2nd, 3rd, 4th]; a shared place counts for the better one. */
  places: number[];
  avgPlace: number | null;
}

/** A deck's record over the given tables. */
export function deckRecord(tables: TableView[], deck: string, pod = 4): DeckRecord {
  const r: DeckRecord = { played: 0, scored: 0, wins: 0, places: Array(pod).fill(0), avgPlace: null };
  let sum = 0;
  for (const t of tables) {
    for (const g of t.games) {
      const s = seatOf(g, deck);
      if (s < 0 || !g.played) continue;
      r.played += 1;
      const p = g.places[s];
      if (!g.scored || p == null) continue;
      r.scored += 1;
      sum += p;
      if (g.winner === s && g.end === "win") r.wins += 1;
      const at = Math.min(pod, Math.max(1, Math.floor(p))) - 1;
      r.places[at] = (r.places[at] ?? 0) + 1;
    }
  }
  r.avgPlace = r.scored ? sum / r.scored : null;
  return r;
}

export interface Rival {
  id: string;
  /** Scored games the two shared. */
  games: number;
  /** Games `deck` placed above them, and below; ties are the rest. */
  ahead: number;
  behind: number;
  tables: number;
}

/** Everyone `deck` sat with, most games first, then by name. */
export function rivals(tables: TableView[], deck: string, label: (id: string) => string): Rival[] {
  const by = new Map<string, Rival>();
  for (const t of tables) {
    if (!t.decks.includes(deck)) continue;
    for (const other of t.decks) {
      if (other === deck) continue;
      const r = by.get(other) ?? { id: other, games: 0, ahead: 0, behind: 0, tables: 0 };
      r.tables += 1;
      for (const g of t.games) {
        const a = g.places[seatOf(g, deck)];
        const b = g.places[seatOf(g, other)];
        if (!g.scored || a == null || b == null) continue;
        r.games += 1;
        if (a < b) r.ahead += 1;
        else if (b < a) r.behind += 1;
      }
      by.set(other, r);
    }
  }
  return [...by.values()].sort((x, y) => y.games - x.games || label(x.id).localeCompare(label(y.id)));
}

/** "Placed above Lorehold Spirit in 3 of 4 games" (and "level in 1" when some tied). */
export function rivalText(r: Rival, them: string): string {
  if (!r.games) return `No scored games with ${them} yet`;
  const level = r.games - r.ahead - r.behind;
  return `Placed above ${them} in ${r.ahead} of ${r.games} ${r.games === 1 ? "game" : "games"}${level ? `, level in ${level}` : ""}`;
}

/** Fewer untied games than this between two decks and their head to head can't say much. */
export const FEW_GAMES = 12;

export type TableFilter = "all" | "won" | "lost";

/** Tables where `deck` won at least one game ("won") or none of its scored games ("lost"). */
export function filterTables(tables: TableView[], deck: string, f: TableFilter, rival?: string | null): TableView[] {
  return tables.filter((t) => {
    if (rival && !t.decks.includes(rival)) return false;
    if (f === "all") return true;
    const won = t.games.some((g) => g.played && g.end === "win" && g.winner != null && g.seats[g.winner] === deck);
    if (f === "won") return won;
    return !won && t.games.some((g) => g.played && g.scored);
  });
}

/** The labels of a run's decks, with the raw id for one it doesn't name. */
export function labeller(decks: TableDeck[]): (id: string) => string {
  const m = new Map(decks.map((d) => [d.id, d.label]));
  return (id) => m.get(id) ?? id;
}

/** The Wilson score interval for `k` of `n` at 90% (as the server's summaries use). */
export function wilson90(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.6448536269514722;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
