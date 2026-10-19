// Pure helpers for the lab pages: number and date wording, chart scales, the precon table's
// filters and sorts, and the "Try a change" list arithmetic. No React here, so it's tested on its own.

import { identityKeys } from "@yama/core";
import type { Pace, PreconItem } from "./api";

// ── wording ──────────────────────────────────────────────────────────────────

const MINUS = "−";

/** 0.443 → "44%". */
export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return "no data";
  return `${(x * 100).toFixed(digits)}%`;
}

/** A difference in whole percentage points, as the server words it: "+4", "−3" or "0". */
export function points(x: number): string {
  const p = Math.round(x * 100);
  if (p === 0) return "0";
  return p > 0 ? `+${p}` : `${MINUS}${-p}`;
}

/** "+4 points", "−1 point". */
export function pointsWord(x: number): string {
  const n = Math.abs(Math.round(x * 100));
  return `${points(x)} ${n === 1 ? "point" : "points"}`;
}

/** How often the changed list won compared with the base, in words: "4 points more often". */
export function moreOften(d: number): string {
  const n = Math.abs(Math.round(d * 100));
  if (n === 0) return "about as often as";
  return `${n} ${n === 1 ? "point" : "points"} ${d > 0 ? "more" : "less"} often than`;
}

/** "now against stock" → "Now against stock". */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An interval in whole points: "+1 to +7". */
export function pointsRange(ci: [number, number]): string {
  return `${points(ci[0])} to ${points(ci[1])}`;
}

/** An interval in percent: "38 to 59%". */
export function pctRange(lo: number, hi: number): string {
  return `${Math.round(lo * 100)} to ${Math.round(hi * 100)}%`;
}

/** Strength on the model's scale (1 = an average precon). */
export function strengthText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "no data";
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-10-19T04:15:40Z" or "2026-10-19" → "19 Oct 2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
}

export function year(iso: string | null | undefined): number | null {
  const y = iso ? Number(iso.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 1990 ? y : null;
}

/** The first 8 characters of a hash or build stamp. */
export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 8) : "");

export function ordinal(n: number): string {
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** Seconds as a rough duration: "under a minute", "about 6 minutes", "about 2 hours 10 minutes". */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.ceil(seconds / 60);
  if (seconds < 60) return "under a minute";
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(minutes / 60);
  const m = Math.round((minutes - h * 60) / 5) * 5;
  const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
  return m === 0 || m === 60 ? `about ${m === 60 ? `${h + 1} hours` : hours}` : `about ${hours} ${m} minutes`;
}

/** Lab time for `games` more games behind your own unfinished ones, or null with nothing to go on. */
export function expectedSeconds(pace: Pace | null | undefined, games: number): number | null {
  if (!pace?.seconds_per_game) return null;
  return (pace.your_pending + games) * pace.seconds_per_game;
}

/**
 * The label every simulated number carries: engine, card data, AI level, games and date. Commas,
 * never middle dots.
 */
export function simLabel(l: {
  engine: string | null;
  card_data?: string | null;
  difficulty: string | null;
  games: number;
  pod?: number | null;
  date: string | null | undefined;
  run?: string | null;
}): string {
  const parts = [`Simulated on ${l.engine ?? "an unrecorded engine"}${l.card_data ? ` (card data ${l.card_data.split(", ").map(shortHash).join(", ")})` : ""}`];
  parts.push(`${l.difficulty ?? "unrecorded"} AI`);
  parts.push(`${l.games.toLocaleString("en-GB")} ${l.games === 1 ? "game" : "games"}${l.pod ? ` in ${l.pod}-player pods` : ""}`);
  if (l.run) parts.push(`run ${l.run}`);
  if (l.date) parts.push(fmtDate(l.date));
  return parts.join(", ");
}

/** A finished game for the tested list, in a few words. */
export function gameText(g: { end: string; won: boolean; place: number | null; turns: number }): string {
  switch (g.end) {
    case "win":
      if (g.won) return `Won on turn ${g.turns}`;
      return g.place != null ? placeText(g.place) : "Lost";
    case "draw":
      return "Draw";
    case "turn_cap":
      return `Turn cap, no winner${g.place != null ? ` (${placeText(g.place).toLowerCase()})` : ""}`;
    case "action_cap":
      return "Action cap, no winner";
    case "time_cap":
      return "Out of time, not scored";
    case "panic":
      return "Crashed, not scored";
    default:
      return "Error, not scored";
  }
}

/** 2 → "2nd", 2.5 → "Shared 2.5th place" (tied players share the mean of their places). */
export function placeText(place: number): string {
  if (Number.isInteger(place)) return ordinal(place);
  return `Shared place ${place.toFixed(1)}`;
}

// ── scales ───────────────────────────────────────────────────────────────────

export type Scale = (v: number) => number;

/** Maps [lo, hi] to [0, 1] on a log axis, clamped. */
export function logScale(lo: number, hi: number): Scale {
  const a = Math.log(lo);
  const b = Math.log(hi);
  return (v) => (v <= 0 ? 0 : clamp01((Math.log(v) - a) / (b - a || 1)));
}

export function linScale(lo: number, hi: number): Scale {
  return (v) => clamp01((v - lo) / (hi - lo || 1));
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The strength axis for a set of ratings: their whole intervals, with 1 (average) inside. */
export function strengthDomain(ratings: { strength: number | null; lo: number | null; hi: number | null }[]): [number, number] {
  let lo = 1;
  let hi = 1;
  for (const r of ratings) {
    for (const v of [r.lo, r.strength, r.hi]) {
      if (v != null && v > 0 && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  return [lo / 1.1, hi * 1.1];
}

/** A win-rate axis from 0 to a round ceiling at or above every value (at least `min`). */
export function rateCeiling(values: (number | null | undefined)[], min = 0.5): number {
  const top = Math.max(min, ...values.filter((v): v is number => v != null && Number.isFinite(v)));
  return Math.min(1, Math.ceil(top * 10) / 10);
}

/** A symmetric axis for differences, in tenths: at least ±0.2. */
export function deltaBound(values: (number | null | undefined)[]): number {
  const top = Math.max(0.2, ...values.filter((v): v is number => v != null && Number.isFinite(v)).map(Math.abs));
  return Math.min(1, Math.ceil(top * 10) / 10);
}

// ── the precon table ─────────────────────────────────────────────────────────

export type ColorMode = "includes" | "exactly" | "within";

export interface PreconFilter {
  q: string;
  colors: string;
  mode: ColorMode;
  year: number | null;
}

/** Whether a colour identity fits the chosen colours ("C" = colourless). */
export function identityMatches(identity: string, colors: string, mode: ColorMode): boolean {
  const chosen = [...new Set(colors.toUpperCase())].filter((c) => "WUBRGC".includes(c));
  if (chosen.length === 0) return true;
  const have = identityKeys(identity) as string[]; // "" → ["C"]
  const want = chosen.includes("C") ? (chosen.length === 1 ? ["C"] : chosen.filter((c) => c !== "C")) : chosen;
  switch (mode) {
    case "exactly":
      return have.length === want.length && want.every((c) => have.includes(c));
    case "within":
      return have.every((c) => c === "C" || want.includes(c));
    default:
      return want.every((c) => have.includes(c));
  }
}

export function filterPrecons(list: PreconItem[], f: PreconFilter): PreconItem[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((p) => {
    if (f.year != null && year(p.released) !== f.year) return false;
    if (!identityMatches(p.color_identity, f.colors, f.mode)) return false;
    if (!q) return true;
    return [p.name, p.set_name ?? "", p.set_code, ...p.commanders].some((s) => s.toLowerCase().includes(q));
  });
}

export type SortKey = "rank" | "name" | "set" | "year" | "strength" | "p4" | "games" | "real";

/** Sorted copy. Missing values go last whichever way the sort runs. */
export function sortPrecons(list: PreconItem[], key: SortKey, desc: boolean): PreconItem[] {
  const value = (p: PreconItem): number | string | null => {
    switch (key) {
      case "rank":
        return p.rating?.rank ?? null;
      case "name":
        return p.name.toLowerCase();
      case "set":
        return (p.set_name ?? p.set_code).toLowerCase();
      case "year":
        return p.released ?? null;
      case "strength":
        return p.rating?.strength ?? null;
      case "p4":
        return p.rating?.p4_field ?? null;
      case "games":
        return p.rating?.games ?? null;
      case "real":
        return p.playgroup?.rank ?? null;
    }
  };
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va == null && vb == null) return a.name.localeCompare(b.name);
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return (desc ? -c : c) || a.name.localeCompare(b.name);
  });
}

/** The sort each column starts with: best first for numbers where higher is better. */
export const DEFAULT_DESC: Record<SortKey, boolean> = {
  rank: false,
  name: false,
  set: false,
  year: true,
  strength: true,
  p4: true,
  games: true,
  real: false,
};

export function yearsOf(list: PreconItem[]): number[] {
  return [...new Set(list.map((p) => year(p.released)).filter((y): y is number => y != null))].sort((a, b) => b - a);
}

// ── deck lists ───────────────────────────────────────────────────────────────

const GROUPS: [string, (t: string) => boolean][] = [
  ["Creatures", (t) => t.includes("Creature")],
  ["Planeswalkers", (t) => t.includes("Planeswalker")],
  ["Instants", (t) => t.includes("Instant")],
  ["Sorceries", (t) => t.includes("Sorcery")],
  ["Artifacts", (t) => t.includes("Artifact")],
  ["Enchantments", (t) => t.includes("Enchantment")],
  ["Battles", (t) => t.includes("Battle")],
  ["Lands", (t) => t.includes("Land")],
];

export const GROUP_ORDER = ["Commander", ...GROUPS.map(([g]) => g), "Other", "Sideboard"];

/** The Decks page's grouping: lands first among types, the front face decides. */
export function groupOf(board: string, typeLine: string | null | undefined): string {
  if (board === "commander") return "Commander";
  if (board === "side") return "Sideboard";
  const t = (typeLine ?? "").split(" // ")[0]!;
  if (!t) return "Other";
  if (t.includes("Land")) return "Lands";
  return GROUPS.find(([, test]) => test(t))?.[0] ?? "Other";
}

/** Items grouped in GROUP_ORDER, each group sorted by mana value then name. */
export function grouped<T extends { name: string; board: string; type_line?: string | null; cmc?: number | null }>(items: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const g = groupOf(it.board, it.type_line);
    map.set(g, [...(map.get(g) ?? []), it]);
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [
    g,
    map.get(g)!.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name)),
  ]);
}

/** A base list line for "Try a change". */
export interface BaseLine {
  name: string;
  qty: number;
  board: "commander" | "main" | "side";
  type_line?: string | null;
  cmc?: number | null;
  image_small?: string | null;
  oracle_id?: string | null;
}

/** Cards a game counts: commanders and main deck, never the sideboard. */
export function playedCount(lines: BaseLine[]): number {
  return lines.filter((l) => l.board !== "side").reduce((n, l) => n + l.qty, 0);
}

/** name → copies, from a list of names with repeats. */
export function tally(names: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return m;
}

/** The changed list's size: the base, less the cuts, plus the adds. */
export function changedCount(base: BaseLine[], add: string[], cut: string[]): number {
  return playedCount(base) - cut.length + add.length;
}

/** Copies of `name` in the base's main deck that can still be cut. */
export function cuttable(base: BaseLine[], cut: string[], name: string): number {
  const have = base.filter((l) => l.board === "main" && l.name === name).reduce((n, l) => n + l.qty, 0);
  return have - (tally(cut).get(name) ?? 0);
}

/** The change in words for a name: "−Darkness, +Toxic Deluge", repeats as "2 Forest". */
export function changeText(add: string[], cut: string[]): string {
  const line = (sign: string, [name, n]: [string, number]) => `${sign}${n > 1 ? `${n} ` : ""}${name}`;
  return [...[...tally(cut)].map((e) => line(MINUS, e)), ...[...tally(add)].map((e) => line("+", e))].join(", ");
}

/** Scryfall's identity filter for the card search: "id<=wug" (colourless commanders: "id:c"). */
export function identityQuery(identity: string | null | undefined): string {
  if (identity == null) return "";
  const keys = identityKeys(identity);
  return keys[0] === "C" ? "id:c" : `id<=${keys.join("").toLowerCase()}`;
}
