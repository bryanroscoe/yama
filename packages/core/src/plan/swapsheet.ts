// The swap sheet: what to do when a print order arrives. Read from the stored lists the way
// commander-decks' print swap sheet (scripts/shopping/printswaps.py) reads library.py: each deck goes
// from its now list to its after-prints list, so the sheet can't disagree with them.
//   Sort: every print, A to Z, with one entry per copy and the deck it goes to.
//   Per deck: the card going in (a print, or a card moving from another deck), the card coming out
//   (what the now list holds in that slot: the stand-in, a basic holding it, or the plan's cut) and
//   where that card goes: the deck that takes it next, the deck's swap bag (a bracket bag card that
//   goes back in at a lower bracket) or spares.
// Decks that give a card to another deck come first, so the card is in hand when the taking deck's
// turn comes. The server's swap-in (server/src/plan/swap_in.rs) does the same thing to the deck and
// the collection.

import { backFace } from "./prints";
import { installedState } from "./marks";
import type { PlanBundle, PlanDeck, Slot, Swap } from "./types";

export interface SheetStep {
  kind: "print" | "moved" | "other";
  in: string;
  /** For a move: the deck it comes from. */
  fromDeck: PlanDeck | undefined;
  out: string;
  /** What the card coming out is: the stand-in, a basic holding the slot, or the plan's cut. */
  outKind: "standin" | "fill" | "cut";
  /** Where the card coming out goes. */
  to: "deck" | "bag" | "spares" | "basics";
  /** For `deck`: the deck that takes it, and the card it replaces there. */
  toDeck: PlanDeck | undefined;
  toReplaces: string | null;
  /** For `bag`: back in at Bracket 3 or 2. */
  bagBracket: string | null;
  swap: Swap | undefined;
  gameChanger: boolean;
  /** Double-faced: the back face, or null. */
  back: string | null;
  installed: boolean;
}

export interface SheetDeck {
  deck: PlanDeck;
  steps: SheetStep[];
  prints: number;
  moves: number;
  /** Swap-bag cards already out of the deck (in spares since an earlier swap). */
  bagAlreadyOut: string[];
  installed: number;
}

export interface SortLine {
  card: string;
  decks: PlanDeck[];
  gameChanger: boolean;
  back: string | null;
}

export interface SwapSheet {
  decks: SheetDeck[];
  sort: SortLine[];
  prints: number;
  /** Cards that change decks: card, from, to. */
  moves: { card: string; from: PlanDeck; to: PlanDeck; replaces: string | null }[];
}

export type SheetData = Pick<PlanBundle, "decks" | "swaps" | "game_changers" | "cards" | "names" | "marks">;

export interface SheetCardMatch {
  deck: PlanDeck;
  step: SheetStep;
  side: "in" | "out";
}

/** One row per physical copy, sorted by the card to remove, then the deck. */
export function takeoutLines(sheet: SwapSheet, deckKey?: string): { deck: PlanDeck; step: SheetStep }[] {
  return sheet.decks
    .filter((d) => !deckKey || d.deck.key === deckKey)
    .flatMap((d) => d.steps.filter((s) => s.out).map((step) => ({ deck: d.deck, step })))
    .sort((a, b) => cmp(a.step.out.toLowerCase(), b.step.out.toLowerCase()) || cmp(a.deck.name.toLowerCase(), b.deck.name.toLowerCase()) || cmp(a.step.in.toLowerCase(), b.step.in.toLowerCase()));
}

/** Match card identity, including either face and the plan's front-face aliases, never printing. */
export function sheetCardMatches(sheet: SwapSheet, data: Pick<SheetData, "names" | "cards">, name: string, deckKey?: string): SheetCardMatch[] {
  const normal = (n: string) => n.trim().normalize("NFKC").replace(/[’‘]/g, "'").toLowerCase();
  const ids = new Map(Object.entries(data.cards).map(([id, c]) => [normal(c.name), id]));
  for (const [name, id] of Object.entries(data.names)) ids.set(normal(name), id);
  // Explicit card names win over face aliases: an adventure's Brainstorm is a different
  // card from the standalone Brainstorm. Unambiguous back faces still find their full card.
  for (const [id, c] of Object.entries(data.cards)) for (const face of c.name.split(" // ")) {
    if (!ids.has(normal(face))) ids.set(normal(face), id);
  }
  const identities = (n: string) => {
    const id = ids.get(normal(n));
    if (id) return new Set([`id:${id}`]);
    return new Set([n, ...n.split(" // ")].map(normal).filter((name) => name && !ids.has(name)).map((name) => `name:${name}`));
  };
  const scanned = identities(name);
  if (!scanned.size) return [];
  const matches: SheetCardMatch[] = [];
  for (const d of sheet.decks) {
    if (deckKey && d.deck.key !== deckKey) continue;
    for (const step of d.steps) for (const side of ["in", "out"] as const) {
      if (step[side] && [...identities(step[side])].some((n) => scanned.has(n))) matches.push({ deck: d.deck, step, side });
    }
  }
  return matches;
}

const BASIC = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes", "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function counts(cards: Slot[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards ?? []) m.set(c.name.trim(), (m.get(c.name.trim()) ?? 0) + c.qty);
  return m;
}

/** a − b, by name, as a list with one entry per copy. */
function minus(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [n, q] of a) for (let i = 0; i < q - (b.get(n) ?? 0); i++) out.push(n);
  return out;
}

export function swapSheet(b: SheetData): SwapSheet {
  const active = b.decks.filter((d) => d.status === "active" && d.states.now && d.states.after);
  const byKey = new Map(b.decks.map((d) => [d.key, d]));
  const swaps = new Map(b.swaps.filter((s) => !s.retired).map((s) => [s.key, s]));
  const gc = new Set(b.game_changers?.names ?? []);
  const card = (name: string) => {
    const id = b.names[name.trim()];
    return id ? b.cards[id] : undefined;
  };
  const isInstalled = (key: string | null | undefined) => {
    const s = key ? swaps.get(key) : undefined;
    return !!s && installedState(s, b.marks[s.key]?.installed).on;
  };

  // Cards each deck gives away: giver key → card → (taker, card it replaces there).
  const taken = new Map<string, Map<string, { to: PlanDeck; replaces: string | null }>>();
  const moves: SwapSheet["moves"] = [];
  for (const d of active) {
    const nowN = counts(d.states.now!.cards);
    for (const s of d.states.after!.cards) {
      if (s.kind !== "moved" || !s.from_deck || (nowN.get(s.name.trim()) ?? 0) > 0) continue;
      const giver = byKey.get(s.from_deck);
      if (!giver) continue;
      if (!taken.has(giver.key)) taken.set(giver.key, new Map());
      taken.get(giver.key)!.set(s.name.trim(), { to: d, replaces: s.replaces ?? null });
      moves.push({ card: s.name.trim(), from: giver, to: d, replaces: s.replaces ?? null });
    }
  }

  const sheets: SheetDeck[] = [];
  const sortMap = new Map<string, PlanDeck[]>();
  for (const d of active) {
    const now = d.states.now!.cards;
    const after = d.states.after!.cards;
    const ins = minus(counts(after), counts(now));
    const outs = minus(counts(now), counts(after));
    const bag = new Map<string, string>();
    for (const [level, list] of Object.entries(d.bracket?.bags ?? {})) for (const x of list) if (!BASIC.has(x.in)) bag.set(x.in, bag.get(x.in) ?? `Bracket ${level}`);
    const gives = taken.get(d.key);
    // Pair each card going in with the slot it fills: the after slot names the plan's cut it
    // replaces, and the now list holds that slot with the cut itself, or with a stand-in or basic
    // that names the same cut.
    const holders = new Map<string, Slot>();
    for (const s of now) if (s.replaces && (s.kind === "standin" || s.kind === "fill")) holders.set(s.replaces.trim(), s);
    const left = [...outs];
    const take = (name: string) => {
      const i = left.indexOf(name);
      if (i < 0) return false;
      left.splice(i, 1);
      return true;
    };
    const steps: SheetStep[] = [];
    for (const name of ins) {
      const slot = after.find((s) => s.name.trim() === name);
      const kind = slot?.kind === "print" ? "print" : slot?.kind === "moved" ? "moved" : "other";
      const holder = slot?.replaces ? holders.get(slot.replaces.trim()) : undefined;
      let out = "";
      let outKind: SheetStep["outKind"] = "cut";
      if (holder && take(holder.name.trim())) {
        out = holder.name.trim();
        outKind = holder.kind === "fill" ? "fill" : "standin";
      } else if (slot?.replaces && take(slot.replaces.trim())) {
        out = slot.replaces.trim();
      }
      steps.push({
        kind,
        in: name,
        fromDeck: slot?.from_deck ? byKey.get(slot.from_deck) : undefined,
        out,
        outKind,
        to: "spares",
        toDeck: undefined,
        toReplaces: null,
        bagBracket: null,
        swap: slot?.swap ? swaps.get(slot.swap) : undefined,
        gameChanger: gc.has(name),
        back: backFace(card(name)),
        installed: isInstalled(slot?.swap),
      });
      if (kind === "print") sortMap.set(name, [...(sortMap.get(name) ?? []), d]);
    }
    // Anything the pairing missed still goes out, on a line of its own.
    let unpaired = steps.filter((s) => !s.out);
    for (const name of left) {
      const st = unpaired.shift();
      if (st) st.out = name;
      else steps.push({ kind: "other", in: "", fromDeck: undefined, out: name, outKind: "cut", to: "spares", toDeck: undefined, toReplaces: null, bagBracket: null, swap: undefined, gameChanger: false, back: null, installed: false });
    }
    for (const st of steps) {
      const t = gives?.get(st.out);
      if (t) Object.assign(st, { to: "deck", toDeck: t.to, toReplaces: t.replaces });
      else if (st.outKind === "fill" || BASIC.has(st.out)) st.to = "basics";
      else if (bag.has(st.out)) Object.assign(st, { to: "bag", bagBracket: bag.get(st.out)! });
    }
    steps.sort((x, y) => Number(x.kind !== "print") - Number(y.kind !== "print") || cmp(x.in.toLowerCase(), y.in.toLowerCase()));
    const outNow = new Set(outs);
    const inNow = counts(now);
    sheets.push({
      deck: d,
      steps,
      prints: steps.filter((s) => s.kind === "print").length,
      moves: steps.filter((s) => s.kind === "moved").length,
      bagAlreadyOut: [...bag.keys()].filter((c) => !outNow.has(c) && !inNow.get(c)).sort((x, y) => cmp(x.toLowerCase(), y.toLowerCase())),
      installed: steps.filter((s) => s.installed).length,
    });
  }

  // Givers first, then the plan's own order.
  const givers = new Set(moves.map((m) => m.from.key));
  sheets.sort((x, y) => Number(!givers.has(x.deck.key)) - Number(!givers.has(y.deck.key)) || x.deck.sort - y.deck.sort);
  const pos = new Map(sheets.map((s, i) => [s.deck.key, i]));
  const sort: SortLine[] = [...sortMap]
    .map(([c, decks]) => ({ card: c, decks: decks.sort((x, y) => (pos.get(x.key) ?? 0) - (pos.get(y.key) ?? 0)), gameChanger: gc.has(c), back: backFace(card(c)) }))
    .sort((x, y) => cmp(x.card.toLowerCase(), y.card.toLowerCase()));
  return { decks: sheets.filter((s) => s.steps.length > 0), sort, prints: sort.reduce((n, l) => n + l.decks.length, 0), moves };
}
