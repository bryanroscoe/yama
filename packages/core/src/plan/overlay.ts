// Taps on the plan pages as ops (docs/planner-design.md 5.4), and the bundle with the taps this
// device hasn't seen come back yet laid over it. Every op carries the full record (the whole
// answer, not one field), so last-writer-wins needs no per-field clocks. The order is the server's:
// the later `at` wins, then an answer made in Yama over one from an import, then the larger op id.

import type { Decision, Mark, Review } from "./types";

export interface ReviewRecord {
  decision: Decision | null;
  note: string | null;
  cut: string | null;
}

interface OpBase {
  op_id: string;
  device_id?: string;
  /** UTC, whole seconds. */
  at: string;
}

export interface ReviewOp extends OpBase, ReviewRecord {
  kind: "review";
  swap_key: string;
  deck_key: string | null;
}

export interface InstalledOp extends OpBase {
  kind: "installed";
  swap_key: string;
  deck_key: string | null;
  value: boolean;
}

export interface BoughtOp extends OpBase {
  kind: "bought";
  swap_key: string;
  deck_key: string | null;
  value: boolean;
  store_key: string | null;
  store_label: string | null;
  /** What was paid for one copy; null when not known (never 0 for unknown). */
  price_paid: number | null;
  qty: number;
  /** YYYY-MM-DD */
  on: string | null;
}

export interface IdeaOp extends OpBase {
  kind: "idea";
  deck_key: string;
  in: string;
  out: string | null;
  why: string | null;
}

export type PlanOp = ReviewOp | InstalledOp | BoughtOp | IdeaOp;

/** An op on this device: still in the outbox, or accepted by the server but not in the bundle yet. */
export interface LocalOp {
  op: PlanOp;
  local: "pending" | "sent";
  seq?: number | null;
}

/** A time as the server keeps it: UTC with whole seconds ("2026-10-19T01:00:00Z"). */
export function opTime(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface Stamped {
  at: string;
  origin?: string;
  op_id?: string | null;
}

/** Whether `a` replaces `b` under last-writer-wins, as the server decides it. */
export function wins(a: Stamped, b: Stamped | undefined): boolean {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  const rank = (x: Stamped) => (x.origin === "import" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) > rank(b);
  return (a.op_id ?? "") > (b.op_id ?? "");
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s : null);

/** The full record to send: the answer on screen with one change made. Blank text is no text. */
export function reviewRecord(current: Pick<Review, "decision" | "note" | "cut"> | undefined, change: Partial<ReviewRecord>): ReviewRecord {
  const merged = { decision: current?.decision ?? null, note: current?.note ?? null, cut: current?.cut ?? null, ...change };
  return { decision: merged.decision ?? null, note: blank(merged.note), cut: blank(merged.cut) };
}

/** Tapping the decision that's already chosen clears it. */
export function toggleDecision(current: Decision | null | undefined, tapped: Decision): Decision | null {
  return current === tapped ? null : tapped;
}

/** A record with nothing in it clears the answer (the server keeps it as a tombstone). */
export function isClear(r: ReviewRecord): boolean {
  return !r.decision && !r.note && !r.cut;
}

/** The answers with this device's ops laid over them, in order, each winning only if it's newer. */
export function overlayReviews(reviews: Record<string, Review>, ops: LocalOp[]): Record<string, Review> {
  const out: Record<string, Review> = { ...reviews };
  for (const { op, local, seq } of ops) {
    if (op.kind !== "review") continue;
    const next: Review = {
      decision: op.decision,
      note: op.note,
      cut: op.cut,
      deck: out[op.swap_key]?.deck ?? null,
      card: out[op.swap_key]?.card ?? null,
      at: op.at,
      origin: "yama",
      op_id: op.op_id,
      seq: seq ?? null,
      local,
    };
    if (wins(next, out[op.swap_key])) out[op.swap_key] = next;
  }
  return out;
}

/** Installed ticks and bought marks with this device's ops laid over them. */
export function overlayMarks(marks: Record<string, { installed?: Mark; bought?: Mark }>, ops: LocalOp[]): Record<string, { installed?: Mark; bought?: Mark }> {
  const out: Record<string, { installed?: Mark; bought?: Mark }> = {};
  for (const [k, v] of Object.entries(marks)) out[k] = { ...v };
  for (const { op, local, seq } of ops) {
    if (op.kind !== "installed" && op.kind !== "bought") continue;
    const { op_id, at, value } = op;
    const payload: Record<string, unknown> =
      op.kind === "bought" ? { store_key: op.store_key, store_label: op.store_label, price_paid: op.price_paid, qty: op.qty, on: op.on } : {};
    const next: Mark = { value, at, payload, op_id, seq: seq ?? null, local };
    const entry = (out[op.swap_key] ??= {});
    if (wins({ ...next, origin: "yama" }, entry[op.kind] && { ...entry[op.kind]!, origin: "yama" })) entry[op.kind] = next;
  }
  return out;
}
