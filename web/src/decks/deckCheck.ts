// Checking a physical deck against a list (DeckCheckPage, /decks/:id/check): each card scanned
// gets a verdict at once, on the device, from a target list already loaded. Nothing is saved
// anywhere but this device, where the check in progress is kept like a scan draft.

import { isBasic, type ScanDraft, type ScannedCard } from "./deckScan";
import type { SwapPair } from "./buildCatalog";

export type { SwapPair };

/** One card of the list the box should match. */
export interface TargetCard {
  name: string;
  qty: number;
  commander: boolean;
  /** Where your copies are, when Yama knows ("Yours, in Spares."). */
  where?: string | null;
}

/** The list the box should match, and the swaps Yama knows for this deck. */
export interface CheckTarget {
  id: string;
  label: string;
  cards: TargetCard[];
  /** Known swaps, the target's own first. Either direction can apply (a swap back). */
  pairs: SwapPair[];
}

/**
 * - belongs: in the target, and not more copies than it has.
 * - out: not in the target.
 * - extra: a basic land beyond the target's count.
 * - duplicate: a second copy of a card that isn't a basic (Commander is singleton).
 */
export type VerdictKind = "belongs" | "out" | "extra" | "duplicate";

export interface Verdict {
  key: string;
  name: string;
  at: number;
  typed?: boolean;
  kind: VerdictKind;
  /** This copy's number among the scanned copies of the card (1 for the first). */
  copy: number;
  /** Copies the target has (0 when it isn't in it). */
  wanted: number;
  /** For a card to take out: what goes in instead, where known. */
  instead: SwapPair[];
}

/** One card name as a list key: the front face, in any case ("A" matches "A // B"). */
export const cardKey = (name: string) => name.split(" // ")[0]!.trim().toLowerCase();

const counts = (cards: TargetCard[]) => {
  const m = new Map<string, number>();
  for (const c of cards) m.set(cardKey(c.name), (m.get(cardKey(c.name)) ?? 0) + c.qty);
  return m;
};

/**
 * What goes in for a card that has to come out: known swaps whose other card is in the target,
 * either way round (a plan swap Ancient Tomb to Reliquary Tower also says Reliquary Tower comes
 * out for Ancient Tomb when the target has the Tomb). The target's own swaps come first.
 */
export function insteadOf(name: string, target: CheckTarget): SwapPair[] {
  const want = counts(target.cards);
  const k = cardKey(name);
  const seen = new Set<string>();
  const out: SwapPair[] = [];
  for (const p of target.pairs) {
    const pair = cardKey(p.out) === k ? p : cardKey(p.in) === k ? { out: p.in, in: p.out, where: null, why: null } : null;
    if (!pair || !want.get(cardKey(pair.in)) || seen.has(cardKey(pair.in))) continue;
    seen.add(cardKey(pair.in));
    // Named as the target names it (its full double-faced name).
    const card = target.cards.find((c) => cardKey(c.name) === cardKey(pair.in));
    out.push({ ...pair, in: card?.name ?? pair.in, where: pair.where ?? card?.where ?? null });
  }
  return out;
}

/** Every scanned card's verdict, in scan order. Basics count against the target's quantity. */
export function classify(target: CheckTarget, cards: ScannedCard[]): Verdict[] {
  const want = counts(target.cards);
  const seen = new Map<string, number>();
  return cards.map((c) => {
    const k = cardKey(c.name);
    const copy = (seen.get(k) ?? 0) + 1;
    seen.set(k, copy);
    const wanted = want.get(k) ?? 0;
    const kind: VerdictKind = wanted === 0 ? "out" : copy <= wanted ? "belongs" : isBasic(c.name) ? "extra" : "duplicate";
    return { key: c.key, name: c.name, at: c.at, ...(c.typed ? { typed: true } : {}), kind, copy, wanted, instead: kind === "out" ? insteadOf(c.name, target) : [] };
  });
}

export interface Tally {
  checked: number;
  belongs: number;
  /** Cards to take out: not in the target, extra basics and second copies. */
  out: number;
  duplicates: number;
  /** Target cards not seen yet. */
  missing: number;
  /** Copies in the target. */
  total: number;
}

export function tally(target: CheckTarget, verdicts: Verdict[]): Tally {
  const total = target.cards.reduce((n, c) => n + c.qty, 0);
  const belongs = verdicts.filter((v) => v.kind === "belongs").length;
  return {
    checked: verdicts.length,
    belongs,
    out: verdicts.filter((v) => v.kind !== "belongs").length,
    duplicates: verdicts.filter((v) => v.kind === "duplicate").length,
    missing: total - belongs,
    total,
  };
}

/** A card seen that has to come out, with all its scanned copies. */
export interface OutGroup {
  name: string;
  kind: Exclude<VerdictKind, "belongs">;
  keys: string[];
  count: number;
  instead: SwapPair[];
  last: number;
}

/** The cards to take out, by card, the most recently scanned first. */
export function takeOut(verdicts: Verdict[]): OutGroup[] {
  const by = new Map<string, OutGroup>();
  for (const v of verdicts) {
    if (v.kind === "belongs") continue;
    const id = `${v.kind}\0${cardKey(v.name)}`;
    const g = by.get(id) ?? { name: v.name, kind: v.kind, keys: [], count: 0, instead: v.instead, last: 0 };
    g.keys.push(v.key);
    g.count += 1;
    g.last = Math.max(g.last, v.at);
    by.set(id, g);
  }
  return [...by.values()].sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

/** A target card not seen yet: how many copies are missing, and what it replaces if known. */
export interface Missing {
  name: string;
  missing: number;
  commander: boolean;
  where: string | null;
  /** Cards it goes in for, among the ones seen that have to come out. */
  replaces: string[];
}

/** The target's cards not seen yet, commander first, then A to Z. */
export function stillMissing(target: CheckTarget, verdicts: Verdict[]): Missing[] {
  const got = new Map<string, number>();
  for (const v of verdicts) if (v.kind === "belongs") got.set(cardKey(v.name), (got.get(cardKey(v.name)) ?? 0) + 1);
  const outs = takeOut(verdicts);
  const merged = new Map<string, TargetCard>();
  for (const c of target.cards) {
    const k = cardKey(c.name);
    const m = merged.get(k);
    merged.set(k, m ? { ...m, qty: m.qty + c.qty, commander: m.commander || c.commander } : { ...c });
  }
  return [...merged.entries()]
    .map(([k, c]) => ({
      name: c.name,
      missing: c.qty - (got.get(k) ?? 0),
      commander: c.commander,
      where: c.where ?? null,
      replaces: outs.filter((o) => o.instead.some((p) => cardKey(p.in) === k)).map((o) => o.name),
    }))
    .filter((m) => m.missing > 0)
    .sort((a, b) => Number(b.commander) - Number(a.commander) || a.name.localeCompare(b.name));
}

/** "Take out", "Belongs" and the rest, as the verdict says them. */
export function verdictText(v: Pick<Verdict, "kind" | "wanted" | "copy">): { title: string; detail: string } {
  switch (v.kind) {
    case "belongs":
      return { title: "Belongs", detail: v.wanted > 1 ? `Copy ${v.copy} of ${v.wanted}.` : "In the list." };
    case "out":
      return { title: "Take out", detail: "Not in the list." };
    case "extra":
      return { title: "Take out", detail: `One too many: the list has ${v.wanted}.` };
    case "duplicate":
      return { title: "Already seen", detail: "A second copy. Commander allows one." };
  }
}

// ── kept on the device ─────────────────────────────────────────────────────

/** A check in progress: a scan draft (so the scan page's add, fix and remove work on it) plus
 *  the target chosen. Never sent to the server. */
export interface CheckDraft extends ScanDraft {
  /** The chosen target's id; null for the deck's current list. */
  target: string | null;
}

export const newCheck = (deckId: string, commanders: string[]): CheckDraft => ({ v: 1, deckId, cards: [], commanders, target: null });

const KEY = (deckId: string) => `yama.deckCheck.${deckId}`;
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

export function loadCheck(deckId: string, storage: Pick<Storage, "getItem"> | null = local()): CheckDraft | null {
  try {
    const raw = storage?.getItem(KEY(deckId));
    if (!raw) return null;
    const d = JSON.parse(raw) as CheckDraft;
    if (d?.v !== 1 || d.deckId !== deckId || !Array.isArray(d.cards) || !Array.isArray(d.commanders)) return null;
    return { ...d, target: typeof d.target === "string" ? d.target : null };
  } catch {
    return null;
  }
}

/** Kept while it has cards or a target other than the default; dropped otherwise. */
export function storeCheck(d: CheckDraft, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (d.cards.length === 0 && !d.target) storage?.removeItem(KEY(d.deckId));
    else storage?.setItem(KEY(d.deckId), JSON.stringify(d));
  } catch {
    // Not kept (private browsing, a full disk): the check still works until a reload.
  }
}

/** The check's cards as a deck scan of the same deck, to save as a version on the scan page. */
export const toScanDraft = (d: CheckDraft): ScanDraft => ({ v: 1, deckId: d.deckId, cards: d.cards, commanders: d.commanders });
