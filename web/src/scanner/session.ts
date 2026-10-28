// The cards added in one scanning session, so a mistake can be fixed on the spot. An add merges
// into a row the person may already have (same printing, finish, condition, box), so a fix takes
// back exactly the copies this session added and adds them again the new way: copies owned
// before the session are never touched.
//
// Every write is kept on its entry until the server confirms it. A failed or unanswered write is
// only ever sent again as it was (same op ids, so the server applies it once), and the entry
// takes no other change meanwhile.

import type { CollectionItem } from "../api";

export type Finish = "nonfoil" | "foil" | "proxy";

export interface Added {
  /** This entry's own id (one per Add). */
  key: string;
  name: string;
  scryfall_id: string;
  set: string;
  number: string;
  image: string | null;
  finish: Finish;
  /** The box it went in; null for "not filed anywhere". */
  container: string | null;
  copies: number;
  /** Added by Keep adding, without a tap. */
  auto: boolean;
  /** A write not yet confirmed: the add itself (`fix` null) or a fix. */
  pending?: Pending;
  /** A fix is finding the entry's row (a token for that lookup); the entry is locked meanwhile. */
  checking?: string;
}

export interface Pending {
  ops: CollectionOp[];
  /** What the entry becomes once these ops are applied; null for the entry's own add. */
  fix: Fix | null;
  /** Set when the last send failed: the ops may or may not have been applied. */
  error?: string;
}

/** The entry once its pending write is confirmed. */
export function settled(a: Added): Added {
  const fix = a.pending?.fix;
  const { pending: _, ...rest } = a;
  return fix ? { ...rest, ...fix } : rest;
}

/** The new state of an entry after a fix. 0 copies takes it back out. */
export interface Fix {
  scryfall_id: string;
  set: string;
  number: string;
  name: string;
  image: string | null;
  finish: Finish;
  copies: number;
}

export type CollectionOp =
  | { op_id: string; kind: "add"; scryfall_id: string; qty: number; finish: "nonfoil" | "foil"; proxy: boolean; container_id: string | null }
  | { op_id: string; kind: "adjust"; item_id: string; delta: number };

type Row = Pick<CollectionItem, "id" | "scryfall_id" | "qty" | "condition" | "finish" | "lang" | "proxy" | "container_id"> & {
  altered?: boolean;
  signed?: boolean;
  misprint?: boolean;
};

/** The op that adds `copies` of a printing the way the scanner does (Near Mint, English). */
export function addOp(scryfall_id: string, copies: number, finish: Finish, container: string | null, opId: string): CollectionOp {
  return { op_id: opId, kind: "add", scryfall_id, qty: copies, finish: finish === "proxy" ? "nonfoil" : finish, proxy: finish === "proxy", container_id: container };
}

/** The collection row an entry's copies went into (the server's defaults: Near Mint, English, plain). */
export function findRow<R extends Row>(rows: R[], a: Pick<Added, "scryfall_id" | "finish" | "container">): R | undefined {
  const finish = a.finish === "proxy" ? "nonfoil" : a.finish;
  return rows.find(
    (r) =>
      r.scryfall_id === a.scryfall_id &&
      r.finish === finish &&
      r.proxy === (a.finish === "proxy") &&
      (r.container_id ?? null) === a.container &&
      r.condition === "NM" &&
      r.lang === "en" &&
      !r.altered &&
      !r.signed &&
      !r.misprint,
  );
}

/**
 * The ops that turn what an entry added into `fix`. Only the copy count changed: one adjust.
 * Anything else: take this session's copies back out of their row, and add them the new way.
 * `row` is the entry's row (findRow); `newId` makes op ids.
 */
export function planFix(a: Added, fix: Fix, row: Row, newId: () => string): CollectionOp[] {
  // Never take back more than the row still holds (some may have been removed elsewhere).
  const mine = Math.min(a.copies, row.qty);
  const same = fix.scryfall_id === a.scryfall_id && fix.finish === a.finish;
  if (same) {
    const delta = Math.max(fix.copies, 0) - a.copies;
    if (delta === 0) return [];
    return [{ op_id: newId(), kind: "adjust", item_id: row.id, delta: Math.max(delta, -mine) }];
  }
  const ops: CollectionOp[] = [];
  if (mine > 0) ops.push({ op_id: newId(), kind: "adjust", item_id: row.id, delta: -mine });
  if (fix.copies > 0) ops.push(addOp(fix.scryfall_id, fix.copies, fix.finish, a.container, newId()));
  return ops;
}
