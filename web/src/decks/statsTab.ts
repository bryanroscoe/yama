// Pure helpers for the deck page's Stats tab (DeckStatsTab.tsx): the power dial's geometry and
// bracket bands, the reference marks on the five scores, and the curve and color summaries.

import type { ColorStat, CurveBucket, StatCard } from "@yama/core";
import type { DeckAnalysis, DeckAnalysisView, DeckSummary, VectorKey } from "../api";

/** The dial: a half circle from 1 (left) to 10 (right) around (CX, CY). */
export const DIAL = { cx: 160, cy: 160, r: 130, needle: 108 } as const;

/** Power level, kept on the dial. */
export const clampPower = (p: number) => Math.min(10, Math.max(1, Number.isFinite(p) ? p : 1));

/** The angle of a power level, in radians: π at 1, 0 at 10. */
export function dialAngle(p: number): number {
  return Math.PI * (1 - (clampPower(p) - 1) / 9);
}

/** The point at a power level, `r` from the dial's centre (SVG y grows down). */
export function dialPoint(p: number, r: number = DIAL.r): [number, number] {
  const a = dialAngle(p);
  return [DIAL.cx + r * Math.cos(a), DIAL.cy - r * Math.sin(a)];
}

const f = (n: number) => n.toFixed(1);

/** An SVG arc along the dial from power `a` to power `b` (clockwise, never more than a half turn). */
export function dialArc(a: number, b: number, r: number = DIAL.r): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const [x1, y1] = dialPoint(lo, r);
  const [x2, y2] = dialPoint(hi, r);
  return `M ${f(x1)} ${f(y1)} A ${r} ${r} 0 0 1 ${f(x2)} ${f(y2)}`;
}

/** Each bracket's usual power range, as the server's `power_bracket` reads them: 2 up to 5,
 *  3 above 5 up to 7, 4 above 7. */
export const POWER_BANDS: { bracket: number; from: number; to: number }[] = [
  { bracket: 2, from: 1, to: 5 },
  { bracket: 3, from: 5, to: 7 },
  { bracket: 4, from: 7, to: 10 },
];

/** "Plays like Bracket 2", or "Plays like Bracket 2 to 3" when the margin reaches the next
 *  band. An older server sends only the band the score falls in. */
export function playsLike(a: { power_bracket: number; bracket?: { plays_like: [number, number] } }): string {
  const [low, high] = a.bracket?.plays_like ?? [a.power_bracket, a.power_bracket];
  return low === high ? `Plays like Bracket ${low}` : `Plays like Bracket ${low} to ${high}`;
}

/** What the confidence level means: how complete the inputs were, not how right the score is. */
export function inputsNote(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "Every card read" : confidence === "medium" ? "Some inputs missing" : "Many inputs missing";
}

/** The bracket whose usual range holds a power level. */
export function bandOf(power: number): number {
  return power <= 5 ? 2 : power <= 7 ? 3 : 4;
}

/** The margin either side of the score, kept on the dial. */
export function marginSpan(power: number, margin: number): [number, number] {
  const m = Math.max(0, margin);
  return [clampPower(power - m), clampPower(power + m)];
}

export type Reference = "none" | "stock" | "b4" | "cedh";

/** The marks on every score bar, out of 100. */
export const REFERENCES: { key: Exclude<Reference, "none">; label: string; name: string; value: number }[] = [
  { key: "stock", label: "Typical precon", name: "a typical stock precon", value: 40 },
  { key: "b4", label: "Bracket 4", name: "a Bracket 4 build", value: 75 },
  { key: "cedh", label: "cEDH", name: "a cEDH deck", value: 95 },
];

export const referenceOf = (r: Reference) => REFERENCES.find((x) => x.key === r) ?? null;

/** Something the five scores can be compared with: one of this deck's own lists, or a typical deck. */
export interface Comparison {
  /** Shown after "Amber marks:". */
  name: string;
  /** Its mark on each score, out of 100. */
  value: (key: VectorKey) => number;
  /** Its power level, when it's one of this deck's own lists. */
  power: number | null;
}

/** This deck's stock list, when it has one apart from the list shown and it has been analysed. */
export function stockListOf(view: DeckAnalysisView | undefined) {
  return view?.configurations.find((c) => !c.this && isStockConfiguration(c.configuration) && c.power != null && c.scores) ?? null;
}

/** This list's saved versions before the current one, newest first. */
export const earlierVersions = (view: DeckAnalysisView | undefined) => view?.versions.filter((v) => !v.current) ?? [];

/** What the compare control points at: a typical deck, this deck's stock list, or a saved version. */
export function comparisonOf(r: Reference | "own-stock" | `version:${string}`, view: DeckAnalysisView | undefined): Comparison | null {
  if (r === "own-stock") {
    const c = stockListOf(view);
    return c?.scores && c.power != null ? { name: "this deck's stock list", value: (k) => c.scores![k], power: c.power } : null;
  }
  if (r.startsWith("version:")) {
    const v = view?.versions.find((x) => x.id === r.slice(8));
    return v ? { name: `version ${v.number}`, value: (k) => v.scores[k], power: v.power } : null;
  }
  const t = referenceOf(r as Reference);
  return t ? { name: t.name, value: () => t.value, power: null } : null;
}

/** Another of your decks, from its own analysis: its mark on each score and its power level. */
export function comparisonOfDeck(name: string, other: DeckAnalysis | null | undefined): Comparison | null {
  if (!other) return null;
  const score = new Map(other.vectors.map((v) => [v.key, v.score]));
  return { name, value: (k) => score.get(k) ?? 0, power: other.power };
}

/** The decks you can compare with: your others that have a saved list, by name. */
export function otherDecks(decks: DeckSummary[] | undefined, thisId: string): DeckSummary[] {
  return (decks ?? []).filter((d) => d.id !== thisId && d.current_version_id != null).sort((a, b) => a.name.localeCompare(b.name));
}

/** "+0.4", "-1.2", "the same": how far the power level moved from what it's compared with. */
export function powerChange(now: number, then: number): string {
  // Round each first, so the change matches the two numbers as shown.
  const d = Math.round(now * 10) / 10 - Math.round(then * 10) / 10;
  return Math.abs(d) < 0.05 ? "the same" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`;
}

/** A bar's width: 0 to 100 percent. */
export const pctWidth = (n: number) => `${Math.max(0, Math.min(100, n))}%`;

/** "8", "4.5": a card's points without a trailing ".0". */
export function points(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** What a group's cards add up to, every copy counted. */
export function groupTotal(cards: { points: number; copies: number }[]): number {
  return cards.reduce((n, c) => n + c.points * Math.max(1, c.copies), 0);
}

/** The curve's columns: mana value 0 only when a nonland card costs 0, then 1 to 7+. */
export function curveColumns(curve: CurveBucket[]): { mv: number; label: string; n: number }[] {
  return curve
    .filter((b) => b.mv > 0 || b.creatures + b.others > 0)
    .map((b) => ({ mv: b.mv, label: b.mv === 7 ? "7+" : String(b.mv), n: b.creatures + b.others }));
}

/** Nonland counts at 2 or less, 3 or 4, and 5 or more. */
export function curveSpread(curve: CurveBucket[]): { low: number; mid: number; high: number } {
  const n = (b: CurveBucket) => b.creatures + b.others;
  return {
    low: curve.filter((b) => b.mv <= 2).reduce((s, b) => s + n(b), 0),
    mid: curve.filter((b) => b.mv === 3 || b.mv === 4).reduce((s, b) => s + n(b), 0),
    high: curve.filter((b) => b.mv >= 5).reduce((s, b) => s + n(b), 0),
  };
}

/** Each color's share of the colored symbols, and the share of lands that can make it (a land
 *  making two colors counts in both). Sources stay null while any land's mana is unknown. */
export function colorShares(colors: ColorStat[], lands: number): { color: ColorStat["color"]; pips: number; pipShare: number; sources: number | null; sourceShare: number | null }[] {
  const total = colors.reduce((n, c) => n + c.pips, 0);
  return colors.map((c) => ({
    color: c.color,
    pips: c.pips,
    pipShare: total ? Math.round((c.pips / total) * 100) : 0,
    sources: c.sources,
    sourceShare: c.sources == null || !lands ? null : Math.round((c.sources / lands) * 100),
  }));
}

/** Copies that can count as a land source: the commander and main deck's known cards with a land
 *  on either face, as packages/core's deckStats counts sources (a spell with a land back face
 *  included), so shares of lands never pass 100%. */
export function landFaceCopies(cards: StatCard[]): number {
  return cards
    .filter((c) => c.board !== "side" && c.qty > 0 && c.typeLine != null && c.cmc != null)
    .filter((c) => c.typeLine!.split(" // ").some((t) => t.includes("Land")))
    .reduce((n, c) => n + c.qty, 0);
}

/** A list of the deck that holds its stock cards: "stock" or "original", in any case. */
export const isStockConfiguration = (name: string | null | undefined) => /^(stock|original)$/i.test(name ?? "");
