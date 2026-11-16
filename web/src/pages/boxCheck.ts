// Scanning a box or section (BoxCheckPage, /collection/check/:id): the cards physically in it are
// scanned, and each one is compared with what Yama has filed there. Identity first, like Check
// this deck: a scan names the card, not its printing, so cards are matched by name, and a move
// takes Yama's own recorded copy (its printing as recorded), never one the scan didn't settle.
// The check in progress is kept on this device only.

import type { CollectionItem, Container } from "../api";
import { addCard, fixCard, removeCard, type ScannedCard } from "../decks/deckScan";
import { cardKey } from "../decks/deckCheck";
import { placeLabel, subtreeIds } from "./containerTree";

export { addCard, fixCard, removeCard, cardKey };

/** What the check needs of a collection row. */
export type Row = Pick<CollectionItem, "id" | "qty" | "name" | "proxy" | "container_id" | "container_kind" | "scryfall_id" | "set_code" | "collector_number" | "finish">;

/** A check in progress for one container. `sections`: its sections count as inside it. */
export interface BoxCheckDraft {
  v: 1;
  /** The container's id; also `deckId`, so the deck scan's add, fix and remove work on it. */
  deckId: string;
  cards: ScannedCard[];
  commanders: string[];
  sections: boolean;
}

export const newBoxCheck = (boxId: string): BoxCheckDraft => ({ v: 1, deckId: boxId, cards: [], commanders: [], sections: true });

/** Where a copy that's elsewhere would come from, and how many it gives. */
export interface Source {
  row: Row;
  take: number;
  /** "Loose", or the container's path. */
  from: string;
}

/** One card, as the check sees it. */
export interface BoxLine {
  key: string;
  name: string;
  /** Copies scanned. */
  scanned: number;
  /** Copies Yama has here (in the container, and its sections when they count). */
  here: number;
  /** Scanned and here: min(scanned, here). */
  ok: number;
  /** Scanned beyond what's here, that Yama has elsewhere: the copies a move would bring. */
  elsewhere: Source[];
  /** Scanned beyond what Yama has anywhere: copies to add. */
  unknown: number;
  /** Here but not scanned. */
  missing: number;
  /** The rows here a "Mark missing" would move, and how many from each. */
  missingRows: { row: Row; take: number }[];
  /** Newest scan of the card, for newest-first lists. */
  last: number;
}

export interface BoxResult {
  lines: BoxLine[];
  /** The containers that count as here. */
  here: Set<string>;
  tally: { scanned: number; ok: number; elsewhere: number; unknown: number; missing: number; filed: number };
}

/** Where copies come from first: real copies before proxies; loose, then boxes and binders, deck
 *  boxes last (a deck's copy is more likely where Yama says); then the row with the most. */
function sourceOrder(a: Row, b: Row): number {
  const tier = (r: Row) => (r.container_id == null ? 0 : r.container_kind === "deck" ? 2 : 1);
  return Number(a.proxy) - Number(b.proxy) || tier(a) - tier(b) || b.qty - a.qty || a.id.localeCompare(b.id);
}

/** Compare the scanned cards with the rows Yama has, for container `boxId`. */
export function checkBox(boxId: string, sections: boolean, cards: ScannedCard[], rows: Row[], containers: Container[]): BoxResult {
  const here = sections ? subtreeIds(boxId, containers) : new Set([boxId]);
  const isHere = (r: Row) => r.container_id != null && here.has(r.container_id);
  const scanned = new Map<string, { name: string; n: number; last: number }>();
  for (const c of cards) {
    const k = cardKey(c.name);
    const s = scanned.get(k) ?? { name: c.name, n: 0, last: 0 };
    s.n += 1;
    s.last = Math.max(s.last, c.at);
    scanned.set(k, s);
  }
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.name || r.qty <= 0) continue;
    const k = cardKey(r.name);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const keys = new Set([...scanned.keys(), ...[...byKey.entries()].filter(([, rs]) => rs.some(isHere)).map(([k]) => k)]);
  const lines: BoxLine[] = [];
  for (const k of keys) {
    const s = scanned.get(k);
    const all = byKey.get(k) ?? [];
    const mine = all.filter(isHere);
    const hereQty = mine.reduce((n, r) => n + r.qty, 0);
    const n = s?.n ?? 0;
    const ok = Math.min(n, hereQty);
    let extra = n - ok;
    const elsewhere: Source[] = [];
    for (const r of all.filter((r) => !isHere(r)).sort(sourceOrder)) {
      if (extra <= 0) break;
      const take = Math.min(extra, r.qty);
      extra -= take;
      elsewhere.push({ row: r, take, from: placeLabel(r.container_id, containers) ?? "Loose (not filed)" });
    }
    let short = hereQty - ok;
    const missingRows: { row: Row; take: number }[] = [];
    // The scan can't say which copy isn't there; the largest rows go first, so fewer rows split.
    for (const r of [...mine].sort((a, b) => b.qty - a.qty || a.id.localeCompare(b.id))) {
      if (short <= 0) break;
      const take = Math.min(short, r.qty);
      short -= take;
      missingRows.push({ row: r, take });
    }
    lines.push({
      key: k,
      name: s?.name ?? mine[0]?.name ?? k,
      scanned: n,
      here: hereQty,
      ok,
      elsewhere,
      unknown: extra,
      missing: hereQty - ok,
      missingRows,
      last: s?.last ?? 0,
    });
  }
  lines.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
  const sum = (f: (l: BoxLine) => number) => lines.reduce((n, l) => n + f(l), 0);
  return {
    lines,
    here,
    tally: {
      scanned: cards.length,
      ok: sum((l) => l.ok),
      elsewhere: sum((l) => l.elsewhere.reduce((m, s) => m + s.take, 0)),
      unknown: sum((l) => l.unknown),
      missing: sum((l) => l.missing),
      filed: sum((l) => l.here),
    },
  };
}

/** A collection op, as POST /api/collection/ops takes it. */
export type Op = Record<string, unknown> & { op_id: string; kind: string };

/** Move `take` copies of each source row into `to`. */
export function moveOps(sources: { row: Row; take: number }[], to: string, idFor: (action: string) => string): Op[] {
  return sources.map(({ row, take }) => ({ op_id: idFor(`move:${row.id}:${take}:${to}`), kind: "update", item_id: row.id, container_id: to, split: take }));
}

/** The verdict for one card just scanned, given the cards already scanned. */
export function verdictFor(line: BoxLine | undefined): { kind: "ok" | "elsewhere" | "unknown"; title: string; detail: string } {
  if (!line || line.scanned === 0) return { kind: "unknown", title: "Not in your collection", detail: "Yama has no copy of it." };
  if (line.unknown > 0) {
    return line.here + line.elsewhere.length === 0
      ? { kind: "unknown", title: "Not in your collection", detail: "Yama has no copy of it. Add it here below." }
      : { kind: "unknown", title: "More than Yama has", detail: `You scanned ${line.scanned}; Yama knows of ${line.scanned - line.unknown}.` };
  }
  if (line.elsewhere.length > 0) {
    const from = [...new Set(line.elsewhere.map((s) => s.from))].join(", ");
    return { kind: "elsewhere", title: "Filed elsewhere", detail: `Yama has it in ${from}. Move it here below.` };
  }
  return { kind: "ok", title: "Here", detail: line.here > 1 ? `${line.ok} of ${line.here} seen.` : "Yama has it here." };
}

const KEY = (boxId: string) => `yama.boxCheck.${boxId}`;
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

export function loadBoxCheck(boxId: string, storage: Pick<Storage, "getItem"> | null = local()): BoxCheckDraft | null {
  try {
    const raw = storage?.getItem(KEY(boxId));
    if (!raw) return null;
    const d = JSON.parse(raw) as BoxCheckDraft;
    if (d?.v !== 1 || d.deckId !== boxId || !Array.isArray(d.cards)) return null;
    return { ...d, commanders: [], sections: d.sections !== false };
  } catch {
    return null;
  }
}

/** Kept while it has cards or sections turned off; dropped otherwise. */
export function storeBoxCheck(d: BoxCheckDraft, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (d.cards.length === 0 && d.sections) storage?.removeItem(KEY(d.deckId));
    else storage?.setItem(KEY(d.deckId), JSON.stringify(d));
  } catch {
    // Not kept (private browsing, a full disk): the check still works until a reload.
  }
}
