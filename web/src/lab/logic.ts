// Pure helpers for the lab pages: number and date wording, chart scales, the precon table's
// filters and sorts, and the "Try a change" list arithmetic. No React here, so it's tested on its own.

import { GROUP_ORDER, groupOf, identityKeys } from "@yama/core";
import type { Allowance, Confidence, ConfidenceLevel, ExperimentStatus, Pace, PreconItem, Summary } from "./api";

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

/** The server's expected lab time for a new run of `games` games behind your own unfinished ones, or null with nothing to go on. */
export function expectedSeconds(pace: Pace | null | undefined, games: number): number | null {
  return pace?.estimates.find((e) => e.games === games)?.seconds ?? null;
}

/**
 * The label every simulated number carries: engine, card data, AI level, games and date. Commas,
 * never middle dots. `games` is the games behind the numbers; with `planned` above it, the label
 * says how many were planned ("1 of 100 planned games").
 */
export function simLabel(l: {
  engine: string | null;
  difficulty: string | null;
  games: number;
  planned?: number | null;
  pod?: number | null;
  date: string | null | undefined;
  run?: string | null;
}): string {
  const parts = [`Simulated on ${l.engine ?? "an unrecorded engine"}`];
  parts.push(`${l.difficulty ?? "unrecorded"} AI`);
  const n = (x: number) => x.toLocaleString("en-GB");
  const games =
    l.planned != null && l.planned > l.games ? `${n(l.games)} of ${n(l.planned)} planned games` : `${n(l.games)} ${l.games === 1 ? "game" : "games"}`;
  parts.push(`${games}${l.pod ? ` in ${l.pod}-player pods` : ""}`);
  if (l.run) parts.push(`run ${l.run}`);
  if (l.date) parts.push(fmtDate(l.date));
  return parts.join(", ");
}

/**
 * The card data build behind simulated numbers ("Card data eb309108."), for the Details
 * disclosure under a label: hashes stay out of the visible line.
 */
export function simDetails(cardData: string | null | undefined): string | null {
  return cardData ? `Card data ${cardData.split(", ").map(shortHash).join(", ")}.` : null;
}

/**
 * The engines named in a label ("phase-rs v0.113.0", "forge 2.0.15, phase-rs v0.114.0"), as the
 * prose says them: "phase", "Forge", "phase and Forge". Null when unrecorded.
 */
export function engineFamily(engine: string | null | undefined): string | null {
  if (!engine) return null;
  const names = engine
    .split(", ")
    .map((e) => e.trim().split(/[\s-]/)[0]?.toLowerCase() ?? "")
    .filter(Boolean)
    .map((e) => (e === "forge" ? "Forge" : e));
  const unique = [...new Set(names)];
  return unique.length ? unique.join(" and ") : null;
}

/** The engine with its noun: "the phase engine", "the phase and Forge engines", or null. */
export function engineName(engine: string | null | undefined): string | null {
  const f = engineFamily(engine);
  return f ? `the ${f} ${f.includes(" and ") ? "engines" : "engine"}` : null;
}

/** The caveat beside simulated numbers, naming the run's engine when it's recorded. */
export function caveat(engine?: string | null): string {
  const name = engineName(engine);
  return `AI vs AI games${name ? ` on ${name}` : ""}: evidence about the simulation, not your table.`;
}

// ── simulation confidence ────────────────────────────────────────────────────

/** "sim unreliable" or "sim doubtful", the marker beside a deck's name; null when no problem is known. */
export function confidenceMark(c: Confidence | null | undefined): string | null {
  return c && c.level !== "ok" ? `sim ${c.level}` : null;
}

/** A deck the simulation can't judge: its simulated numbers say little about real games. */
export const cantJudge = (c: Confidence | null | undefined) => c?.level === "unreliable";

/** What a confidence sentence is about: [subject with its verb, object to read with care]. */
const ABOUT = {
  numbers: ["these numbers say", "these numbers"],
  verdict: ["this verdict says", "this verdict"],
  run: ["a run says", "a run's result"],
} as const;

/**
 * The plain sentence for a deck's level, about its numbers, a verdict, or a run still to make.
 * Null for a deck with no known problem.
 */
export function confidenceSentence(level: ConfidenceLevel, about: keyof typeof ABOUT = "numbers"): string | null {
  const [says, read] = ABOUT[about];
  if (level === "unreliable") return `The simulator can't judge this deck yet, so ${says} little about real games.`;
  if (level === "doubtful") return `The simulator may misjudge this deck, so read ${read} with care.`;
  return null;
}

const RANK: Record<ConfidenceLevel, number> = { ok: 0, doubtful: 1, unreliable: 2 };

/**
 * The worst of several confidences (a deck's versions), with the reasons of every one at that
 * level, each once. Null when none says anything.
 */
export function worstConfidence(list: (Confidence | null | undefined)[]): Confidence | null {
  const known = list.filter((c): c is Confidence => c != null);
  if (!known.length) return null;
  const level = known.reduce<ConfidenceLevel>((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), "ok");
  return { level, reasons: [...new Set(known.filter((c) => c.level === level).flatMap((c) => c.reasons))] };
}

/** Sorts that order decks by the simulation's own judgement of them. */
export const SIM_SORTS: readonly SortKey[] = ["rank", "p4", "strength"];

/**
 * Rows split into the decks the simulation can judge (in their order) and those it can't. A sort
 * by a simulated number lists the second group last, under its own heading, so the top of the
 * table is never a deck the simulator is known to misjudge.
 */
export function splitUnjudged<T>(rows: T[], confidence: (row: T) => Confidence | null | undefined): [T[], T[]] {
  const judged: T[] = [];
  const not: T[] = [];
  for (const r of rows) (cantJudge(confidence(r)) ? not : judged).push(r);
  return [judged, not];
}

/**
 * The confidence that goes with a base list in "Try a change": a precon's own, or for a deck or a
 * pasted list, that of the rated precon led by the same commanders. The analysis judges a list
 * built on a precon by that precon (and a known AI gap often comes with the commander), so a deck
 * on Omo carries Tricky Terrain's warning. `own` is true when it is the base's own rating.
 */
export function baseConfidence(
  precons: PreconItem[],
  base: { precon?: string | null; commanders: string[] },
): { precon: PreconItem; confidence: Confidence; own: boolean } | null {
  if (base.precon) {
    const p = precons.find((x) => x.id === base.precon);
    return p?.rating?.confidence ? { precon: p, confidence: p.rating.confidence, own: true } : null;
  }
  if (!base.commanders.length) return null;
  const key = (names: string[]) => [...names].sort().join("|");
  const mine = key(base.commanders);
  const same = precons.filter((p) => p.rating?.confidence && key(p.commanders) === mine);
  // Of several precons on the same commanders, the most cautious one speaks.
  const p = same.sort((a, b) => RANK[b.rating!.confidence!.level] - RANK[a.rating!.confidence!.level])[0];
  return p ? { precon: p, confidence: p.rating!.confidence!, own: false } : null;
}

/**
 * The sentence for a "Try a change" base and its confidence (see baseConfidence): about the deck
 * itself when it is that precon, else naming the precon on the same commanders.
 */
export function baseConfidenceSentence(found: { precon: PreconItem; confidence: Confidence; own: boolean }, about: "verdict" | "run"): string | null {
  const level = found.confidence.level;
  if (found.own) return confidenceSentence(level, about);
  const [says, read] = ABOUT[about];
  const which = `${found.precon.name}, the precon on the same ${found.precon.commanders.length > 1 ? "commanders" : "commander"}`;
  if (level === "unreliable") return `The simulator can't judge ${which}, so ${says} little about real games.`;
  if (level === "doubtful") return `The simulator may misjudge ${which}, so read ${read} with care.`;
  return null;
}

// ── experiment results ───────────────────────────────────────────────────────

/** Whether a summary has any scored game to show. A run stopped before one finished has none. */
export function hasResults(s: Summary | null | undefined): boolean {
  if (s == null) return false;
  if (s.versus) return s.versus.games > 0;
  return s.base.games + s.variant.games > 0;
}

/** The verdict as the page says it: a cancelled run that can't tell won't play more games. */
export function verdictText(status: ExperimentStatus, s: Summary): string {
  if (status === "cancelled" && s.verdict.kind === "unclear") return "Can't tell from the games played before it was cancelled";
  return s.verdict.text;
}

/**
 * A deck's name as the pages show it. Lists named "quantum-quandrix / Esix, Fractal Bloom" (a
 * precon's id and the commander it was played under) read as "Quantum Quandrix (Esix)" when the
 * id is a known precon. Any other name is shown as typed.
 */
export function deckName(label: string, precons: { id: string; name: string }[]): string {
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*) \/ (.+)$/.exec(label);
  const precon = m && precons.find((p) => p.id === m[1]);
  return precon ? `${precon.name} (${m[2]!.split(",")[0]!.trim()})` : label;
}

/**
 * A run of three or more decks, as its card says it: whether one deck clearly wins most often,
 * how many others are within the margin of the leader, and the top few by win rate. Null when
 * it isn't such a run or it has too few games to judge yet.
 */
export function fieldResult(
  s: Summary | null | undefined,
  finished: boolean,
  name: (label: string) => string = (l) => l,
): { clear: boolean; text: string; leaders: { label: string; win_rate: number }[] } | null {
  const v = s?.versus;
  if (!s || !v || v.entrants.length < 3) return null;
  // Ties go to the later entrant, as the server's `max_by` picks them, so both name the same leader.
  const scored = v.entrants
    .map((e, i) => ({ e, i }))
    .filter((x): x is { e: typeof x.e & { win_rate: number; wilson: [number, number] }; i: number } => x.e.win_rate != null && x.e.wilson != null)
    .sort((a, b) => b.e.win_rate - a.e.win_rate || b.i - a.i)
    .map((x) => x.e);
  const best = scored[0];
  if (!best) return null;
  const leaders = scored.slice(0, 3).map((e) => ({ label: name(e.label), win_rate: e.win_rate }));
  // Too few games to judge (server `stats::MIN_PODS`): left to the ordinary verdict wording,
  // which also says when a cancelled run won't play more.
  if (scored.length < v.entrants.length || v.games < 10) return null;
  // The server's test, in whole points: another deck is close when its upper bound reaches the leader's lower.
  const round = (x: number) => Math.round(x * 100);
  const lo = round(best.wilson[0]);
  const close = scored.slice(1).filter((e) => round(e.wilson[1]) >= lo).length;
  const level = `${Math.round(s.level * 100)}%`;
  const detail = `wins ${pct(best.win_rate)}, ${level} interval ${lo} to ${round(best.wilson[1])}%`;
  if (s.verdict.kind === "better" || close === 0) {
    return { clear: true, text: `${name(best.label)} wins most often, clear of the other ${scored.length - 1} (${detail})`, leaders };
  }
  const others = close === 1 ? "1 other deck is" : `${close} other decks are`;
  return { clear: false, text: `No clear winner${finished ? "" : " yet"}: ${name(best.label)} wins most often (${detail}), but ${others} within the margin`, leaders };
}

/** Which engine played a run's games (a "both" run's halves each say theirs). */
export type HalfEngine = "phase" | "forge";

/** Forge's own wall-clock limit on a game (server `forge::FORGE_MAX_SECONDS`). */
export const FORGE_MAX_SECONDS = 900;

/** "10 minutes", "15 minutes", "90 seconds". */
function limitText(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const m = seconds / 60;
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** "1 game", "3 games". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * How a paired run's games count, in plain sentences: how many pods each list played, how many
 * are left out because a game didn't finish (and why), and how many of the rest decide the
 * difference. `a` and `b` name the base and the changed list (or the two decks).
 */
export function podCountText(s: Summary, o: { a: string; b: string; finished: boolean; noun?: "lists" | "decks" }): string[] {
  const noun = o.noun ?? "lists";
  const p = s.paired;
  const out: string[] = [];
  const games = s.pods * 2;
  out.push(`Both ${noun} played the same ${count(s.pods, "pod")} (${games} games), with the same opponents, seats and shuffles.`);
  const pending = s.base.pending + s.variant.pending;
  const left = s.pods - p.pods - p.split_builds;
  const u = s.unscored;
  if (u.total > 0) {
    const why = [
      u.time_cap ? `${u.time_cap} ran out of time` : "",
      u.error ? `${u.error} stopped with an error` : "",
      u.panic ? `${u.panic} crashed` : "",
    ].filter(Boolean);
    const lead = `${count(u.total, "game")} didn't finish (${why.join(", ")})`;
    out.push(
      o.finished || pending === 0
        ? `${lead}, so ${left === 1 ? "its pod is" : `${left} pods are`} left out: a pod counts only when both ${noun}' games finished.`
        : `${lead}; a pod counts only when both ${noun}' games finished.`,
    );
  }
  if (p.split_builds > 0) out.push(`${count(p.split_builds, "pod")} played on two different builds ${p.split_builds === 1 ? "is" : "are"} left out too.`);
  if (p.pods > 0) {
    const same = p.both_won + p.neither;
    const differ = p.variant_only + p.base_only;
    out.push(
      `Of the ${count(p.pods, "pod")} that count, both did the same in ${same} (both won ${p.both_won}, neither won ${p.neither}). ` +
        (differ === 0
          ? "No pod went differently, so there is nothing to tell them apart yet."
          : `The answer rests on the other ${differ}: ${o.b} won ${p.variant_only} that ${o.a} lost, and ${o.a} won ${p.base_only} that ${o.b} lost.`),
    );
  }
  return out;
}

/** What "ran out of time" and "error" mean for a game, for the engine that played it. */
export function unscoredText(engine: HalfEngine, maxSeconds: number): string {
  const limit =
    engine === "forge"
      ? `Out of time: Forge stops a game after ${limitText(FORGE_MAX_SECONDS)}.`
      : `Out of time: the server stops a game once it has used ${limitText(maxSeconds)} of computer time, so one very long or stuck game can't hold up the run.`;
  return (
    `${limit} Error: the game stopped making moves for 5 minutes (stuck inside one AI decision) or couldn't go on. ` +
    "These games aren't counted, because whether a game gets stopped depends on how busy the server is, not on the decks."
  );
}

/**
 * Games to add (per engine) so that the counted pods reach `settle_pods`, allowing for the share
 * of pods lost so far, and the smallest of `choices` that covers it (else the largest). Null when
 * the run doesn't say how many it needs.
 */
export function gamesToSettle(s: Summary, choices: number[]): { pods: number; games: number; pick: number } | null {
  const target = s.paired.settle_pods;
  if (!target || s.pods === 0 || s.paired.pods === 0 || target <= s.paired.pods) return null;
  const kept = s.paired.pods / s.pods;
  const pods = Math.ceil((target - s.paired.pods) / kept);
  const games = pods * 2;
  const sorted = [...choices].sort((x, y) => x - y);
  const pick = sorted.find((c) => c >= games) ?? sorted[sorted.length - 1] ?? games;
  return { pods, games, pick };
}

/** The sentence beside "Add games" while a paired verdict can't tell. */
export function settleText(s: Summary): string | null {
  const d = s.paired.delta_win_rate;
  const target = s.paired.settle_pods;
  if (s.verdict.kind !== "unclear" || d == null) return null;
  if (!target) {
    return s.paired.pods >= 10 && Math.abs(d) < 0.02
      ? "The lists are within a couple of points of each other here; telling them apart would take thousands of games, if there is a difference at all."
      : null;
  }
  return (
    `If the difference stays near ${pointsWord(d)}, about ${target} counted pods would settle it (${s.paired.pods} so far). ` +
    "A smaller real difference needs more; a bigger one, fewer."
  );
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
    const alternatives = p.upgradeability?.alternatives ?? [];
    return [p.name, p.set_name ?? "", p.set_code, ...p.commanders, ...alternatives.flatMap((a) => a.commanders)].some((s) => s.toLowerCase().includes(q));
  });
}

export type SortKey = "upgradeability" | "rank" | "name" | "set" | "year" | "strength" | "p4" | "games" | "real";

/** Sorted copy. Missing values go last whichever way the sort runs. */
export function sortPrecons(list: PreconItem[], key: SortKey, desc: boolean): PreconItem[] {
  const value = (p: PreconItem): number | string | null => {
    switch (key) {
      case "upgradeability":
        return p.upgradeability?.method === "source-backed-upgradeability-v4" ? (p.upgradeability.package ? p.upgradeability.package.best_supported_score : p.upgradeability.score) : null;
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
  upgradeability: true,
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

/** Items grouped as the Decks page groups them (@yama/core's groupOf, in GROUP_ORDER), each group
 *  sorted by mana value then name. */
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

/** Game counts "Try a change" offers: what the server allows this account, else the usual three. */
export function gameChoices(pace: Pace | null | undefined): number[] {
  const choices = pace?.game_choices?.filter((g) => g > 0) ?? [];
  return choices.length ? choices : [100, 200, 400];
}

/** The smaller allowance of an account that joined without an invite, in one plain line. */
export function allowanceText(a: Allowance): string {
  const left = Math.max(0, a.games_per_day - a.used_today);
  const atOnce = a.at_a_time === 1 ? "one at a time" : `${a.at_a_time} at a time`;
  return (
    `Accounts that joined without an invite run ${a.games}-game experiments, ${atOnce}, up to ${a.games_per_day} games a day ` +
    `(${left} left today). An invite from the host lifts this.`
  );
}
