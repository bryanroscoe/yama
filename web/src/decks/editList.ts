// Edit the list (/decks/:id/edit): which lists to start from, and the changes as pairs of cards.
import { GROUP_ORDER, groupOf } from "@yama/core";
import type { DeckVersionRow } from "../api";
import { configurationLabel, pairChanges, type BuildChoice, type BuildFamily, type CardCopy, type SwapPair } from "./buildCatalog";

/** A list to start from: one of the deck's build choices, or one of its saved versions. */
export interface StartList {
  id: string;
  label: string;
  /** Where it comes from, for the Another list sheet. */
  detail?: string;
  choice?: BuildChoice;
  /** A saved version of this deck (`/api/decks/:id/versions/:version`). */
  version?: string;
}

interface DeckRef {
  id: string;
  name: string;
  parent_id: string | null;
  configuration: string | null;
}

/** Plan swap bags first, then a saved list of that bracket, then a build you can make now, then any other. */
function bracketRank(c: BuildChoice): number {
  if (c.id.startsWith("plan:")) return 0;
  if (c.savedDeck) return 1;
  if (c.track === "owned_now") return 2;
  return 3;
}

/**
 * The start buttons (SPEC section 3): this list (the list in the box for a main deck), the list in
 * the box when this is another list of it, Stock, Bracket 3 and Bracket 2, only those that exist.
 */
export function startButtons(family: BuildFamily | undefined, deck: DeckRef): StartList[] {
  const choices = family?.choices ?? [];
  const own = choices.find((c) => c.savedDeck === deck.id);
  const out: StartList[] = [{
    id: own?.id ?? `saved:${deck.id}`,
    label: deck.parent_id ? configurationLabel(deck.configuration, deck.name) : "The list in the box",
    choice: own ?? { id: `saved:${deck.id}`, label: deck.name, kind: "current", savedDeck: deck.id, source: "", href: `/decks/${deck.id}`, warnings: [] },
  }];
  const add = (c: BuildChoice | undefined, label: string) => {
    if (c && !out.some((s) => s.id === c.id || s.label === label)) out.push({ id: c.id, label, choice: c });
  };
  if (deck.parent_id) add(choices.find((c) => c.kind === "current"), "The list in the box");
  add(choices.find((c) => c.kind === "original" && c.savedDeck) ?? choices.find((c) => c.kind === "original"), "Stock");
  for (const b of [3, 2]) {
    const best = choices.filter((c) => c.kind === "bracket" && c.bracket === b).sort((x, y) => bracketRank(x) - bracketRank(y))[0];
    add(best, `Bracket ${b}`);
  }
  return out;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Every other list, for the Another list sheet: the remaining build choices, then saved versions, newest first. */
export function otherLists(family: BuildFamily | undefined, buttons: StartList[], versions: DeckVersionRow[]): StartList[] {
  const taken = new Set(buttons.map((b) => b.id));
  const builds = (family?.choices ?? []).filter((c) => !taken.has(c.id)).map((c) => ({ id: c.id, label: c.label, detail: c.source, choice: c }));
  const saved = [...versions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((v) => ({ id: `version:${v.id}`, label: v.note?.trim() ? v.note.trim() : `Version of ${day(v.created_at)}`, detail: `Saved ${day(v.created_at)}`, version: v.id }));
  return [...builds, ...saved];
}

/** What a changed card is, to pair it: its board, type line and mana value. */
export interface CardFacts {
  type_line: string | null;
  cmc: number | null;
}
export interface ChangeLine {
  name: string;
  qty: number;
  board: string;
}
/** One change: the card going in and the one it replaces; either side may be missing. */
export interface EditPair {
  in: string | null;
  out: string | null;
}

const key = (name: string) => name.split(" // ")[0]!.trim().toLowerCase();

/**
 * The changes between the current list and the edited one as pairs. Swaps the starting list names
 * (a plan's swap bag) pair first, through `pairChanges`; the rest pair by group (Creatures with
 * Creatures, Lands with Lands), then the nearest mana value. Unequal counts leave cards in or out
 * alone. Ordered by group, then by the card going in.
 */
export function pairEdits(added: ChangeLine[], removed: ChangeLine[], facts: (name: string) => CardFacts | undefined, hints: SwapPair[] = []): EditPair[] {
  const copies = (lines: ChangeLine[]) => lines.flatMap((l) => Array.from({ length: Math.max(1, l.qty) }, () => l));
  const group = (l: ChangeLine) => groupOf(l.board, facts(l.name)?.type_line);
  const cmc = (l: ChangeLine) => facts(l.name)?.cmc ?? 0;
  const order = (a: ChangeLine, b: ChangeLine) => GROUP_ORDER.indexOf(group(a)) - GROUP_ORDER.indexOf(group(b)) || cmc(a) - cmc(b) || a.name.localeCompare(b.name);
  const ins = copies(added).sort(order);
  const outs = copies(removed).sort(order);

  // The starting list's own swaps, where both cards are among the changes.
  const rows: EditPair[] = [];
  const n = Math.min(ins.length, outs.length);
  if (hints.length && n) {
    const asCopy = (l: ChangeLine): CardCopy => ({ name: l.name, board: l.board === "commander" ? "commander" : "main" });
    const hinted = new Set(hints.map((h) => `${key(h.out)}\0${key(h.in)}`));
    const paired = pairChanges(outs.slice(0, n).map((o, i) => ({ out: asCopy(o), in: asCopy(ins[i]!) })), [], hints);
    for (const p of paired) {
      if (!hinted.has(`${key(p.out.name)}\0${key(p.in.name)}`)) continue;
      const o = outs.findIndex((x) => key(x.name) === key(p.out.name));
      const i = ins.findIndex((x) => key(x.name) === key(p.in.name));
      if (o < 0 || i < 0) continue;
      rows.push({ in: ins[i]!.name, out: outs[o]!.name });
      outs.splice(o, 1);
      ins.splice(i, 1);
    }
  }

  // The rest: the same group and the nearest mana value, then whatever is left, in order.
  const restIn = [...ins];
  const taken = new Set<number>();
  const pick = (o: ChangeLine, sameGroup: boolean) => {
    let best = -1;
    restIn.forEach((c, i) => {
      if (taken.has(i) || (sameGroup && group(c) !== group(o))) return;
      if (best < 0 || Math.abs(cmc(c) - cmc(o)) < Math.abs(cmc(restIn[best]!) - cmc(o))) best = i;
    });
    return best;
  };
  const later: ChangeLine[] = [];
  const matched: { o: ChangeLine; i: number }[] = [];
  for (const o of outs) {
    const i = pick(o, true);
    if (i < 0) later.push(o);
    else { taken.add(i); matched.push({ o, i }); }
  }
  for (const o of later) {
    const i = pick(o, false);
    if (i < 0) matched.push({ o, i: -1 });
    else { taken.add(i); matched.push({ o, i }); }
  }
  for (const { o, i } of matched) rows.push({ in: i < 0 ? null : restIn[i]!.name, out: o.name });
  restIn.forEach((c, i) => { if (!taken.has(i)) rows.push({ in: c.name, out: null }); });

  const rank = (r: EditPair) => {
    const name = r.in ?? r.out!;
    const line = added.find((l) => l.name === r.in) ?? removed.find((l) => l.name === r.out) ?? { name, qty: 1, board: "main" };
    return GROUP_ORDER.indexOf(group(line));
  };
  return rows.sort((a, b) => rank(a) - rank(b) || (a.in ?? a.out!).localeCompare(b.in ?? b.out!));
}

/** The name a new list starts with, from the list it started from. */
export function newListName(start: StartList | undefined): string {
  if (!start) return "";
  if (/^Bracket [2-5]$/.test(start.label)) return start.label;
  if (start.label === "Stock") return "Stock copy";
  return "";
}
