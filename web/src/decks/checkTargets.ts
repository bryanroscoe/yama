// What a deck check can be checked against (DeckCheckPage): the deck's current list, its other
// configurations and saved versions, its plan's lists and bracket builds, and research builds for
// the deck. Read from what Yama already has (buildFamilies, History); nothing new is stored.

import { bagSource, sourceContext, swapSource, type PlanBundle } from "@yama/core/plan";
import type { DeckCard, DeckEntry, DeckVersionRow, DeckView } from "../api";
import type { BuildFamily, SwapPair } from "./buildCatalog";
import type { CheckTarget, TargetCard } from "./deckCheck";

/** A list to check against, before its cards are loaded. */
export interface TargetOption {
  id: string;
  label: string;
  group: string;
  /** Where the list comes from, in words. */
  source: string;
  /** A saved deck's current list, a saved version, or a list already in hand. */
  load: { savedDeck: string } | { version: string } | { list: string };
  pairs: SwapPair[];
}

export const CURRENT = "current";

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The choices for one deck, the current list first. */
export function targetOptions(deck: Pick<DeckView, "id" | "name" | "version_id">, family: BuildFamily | undefined, versions: DeckVersionRow[] = []): TargetOption[] {
  const out: TargetOption[] = [{ id: CURRENT, label: "The deck's current list", group: "This deck", source: `${deck.name}, as saved in Yama`, load: { savedDeck: deck.id }, pairs: [] }];
  const choices = family?.choices ?? [];
  for (const c of choices) {
    if (c.savedDeck) {
      if (c.savedDeck === deck.id) continue;
      out.push({ id: c.id, label: c.label === "Current (saved deck)" ? "Main deck's current list" : c.label, group: "This deck", source: c.source, load: { savedDeck: c.savedDeck }, pairs: c.pairs ?? [] });
    }
  }
  versions
    .filter((v) => v.id !== deck.version_id)
    .forEach((v) => out.push({ id: `version:${v.id}`, label: `${v.note || "Saved version"}, ${date(v.created_at)}`, group: "Earlier versions", source: `History of ${deck.name}`, load: { version: v.id }, pairs: [] }));
  for (const c of choices) {
    if (c.savedDeck || !c.list) continue;
    if (c.id.startsWith("plan:")) {
      const state = c.id.split(":").pop();
      const label = state === "after" ? "Plan: after prints" : state === "now" ? "Plan: now" : state === "stock" ? "Plan: stock list" : `Plan: Bracket ${c.bracket ?? "?"}`;
      out.push({ id: c.id, label, group: "Plan", source: c.source, load: { list: c.list }, pairs: c.pairs ?? [] });
    } else if (c.id.startsWith("research:") && c.kind !== "legacy") {
      // A research note's starting snapshot is a dated baseline, not a build to check against.
      out.push({ id: c.id, label: c.label, group: `Plan: ${c.note ?? c.source}`, source: c.source, load: { list: c.list }, pairs: c.pairs ?? [] });
    }
  }
  return out;
}

/**
 * Every swap Yama knows for the deck, for "what goes in instead": each build's own swaps, the
 * plan's planned swaps (with where the card comes from) and its bracket bags.
 */
export function swapPool(family: BuildFamily | undefined, plan: PlanBundle | undefined): SwapPair[] {
  const pool: SwapPair[] = (family?.choices ?? []).flatMap((c) => c.pairs ?? []);
  if (!plan) return pool;
  const ctx = sourceContext({ orders: plan.orders ?? [], stores: plan.stores ?? [], decks: plan.decks ?? [] });
  const keys = new Set(family?.planKeys ?? []);
  for (const s of plan.swaps ?? []) {
    if (!keys.has(s.deck) || s.retired || s.stage !== "planned" || !s.out) continue;
    pool.push({ out: s.out, in: s.in, where: swapSource(s, ctx) || null, why: s.why });
  }
  for (const d of plan.decks ?? []) {
    if (!keys.has(d.key)) continue;
    for (const bag of Object.values(d.bracket?.bags ?? {})) for (const b of bag) pool.push({ out: b.out, in: b.in, where: bagSource(b, ctx, d) || null });
  }
  return pool;
}

/** Where copies are, short enough to read: "deck: Ahoy Mateys, Blight Curse, Eternal Might and
 *  10 more". A Sol Ring in every deck would otherwise list them all, each with its "deck:". */
export function placesText(locations: Record<string, number>, max = 3): string {
  let kind = "";
  const all = Object.entries(locations).map(([k, n]) => {
    const m = /^([^:]+): (.+)$/.exec(k);
    const label = m && m[1] === kind ? m[2] : k;
    kind = m ? m[1]! : "";
    return `${label}${n > 1 ? ` ×${n}` : ""}`;
  });
  return all.length > max + 1 ? `${all.slice(0, max).join(", ")} and ${all.length - max} more` : all.join(", ");
}

/** Where your copies of a deck card are, from the deck page's ownership. */
export function entryWhere(e: Partial<DeckEntry>): string | null {
  if (e.owned == null) return null;
  if (e.owned > 0) {
    const where = placesText(e.locations ?? {});
    return where ? `Yours, in ${where}.` : "Yours.";
  }
  return e.proxies ? "A proxy stands in for it." : "Not in your collection.";
}

/** A saved list (a deck's current list or a version): commander and main deck, not the sideboard. */
export function cardsTarget(id: string, label: string, cards: (DeckCard & Partial<DeckEntry>)[], pairs: SwapPair[]): CheckTarget {
  return {
    id,
    label,
    cards: cards.filter((c) => c.board !== "side").map((c): TargetCard => ({ name: c.name, qty: c.qty, commander: c.board === "commander", where: entryWhere(c) })),
    pairs,
  };
}

/** A list in text ("Commander" and "Deck" headings, "1 Sol Ring" lines, set codes ignored). */
export function listTarget(id: string, label: string, text: string, pairs: SwapPair[]): CheckTarget {
  let section = "";
  const cards: TargetCard[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(commander|deck|mainboard|sideboard):?$/i.test(line)) {
      section = line.replace(/:$/, "").toLowerCase();
      continue;
    }
    const m = line.match(/^(\d+)x?\s+(.+)$/);
    if (!m || section === "sideboard") continue;
    cards.push({ name: m[2]!.replace(/\s+\([A-Z0-9]+\)\s+\S+(?:\s+\*[FE]\*)?$/i, ""), qty: Number(m[1]), commander: section === "commander" });
  }
  // Where a card comes from, as the list's own swaps say.
  const where = new Map(pairs.filter((p) => p.where).map((p) => [p.in, p.where!]));
  return { id, label, cards: cards.map((c) => ({ ...c, where: where.get(c.name) ?? null })), pairs };
}
