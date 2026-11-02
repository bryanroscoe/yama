// The offline card list itself: downloading, saving, reading and searching it. Runs in the card
// list's worker (cards.worker.ts), off the page's thread; offline/cards.ts is the page's side.
//
// Kept as two IndexedDB entries (2026-11-02): a small description of the saved copy (`Meta`),
// read whenever the app wants to know what it has, and the list (about 24 MB), read only when an
// offline search, card lookup or scan needs it. The copy is checked about once a day; with the
// validator the server sent (ETag or Last-Modified) that check is a conditional request and the
// list comes down only when it changed. Without one, a copy over a week old is downloaded again.

import { searchOffline, type OfflineCard } from "@yama/core";
import type { Card } from "../api";
import { idbGet, idbPutMany } from "./idb";

/** Bundle shape this app reads (the server's OFFLINE_FORMAT). A saved copy in another format is
 *  downloaded again. */
export const FORMAT = 2;
export const META_KEY = "offline-cards-meta";
export const LIST_KEY = "offline-cards-list";
/** The whole bundle in one entry, as kept until 2026-11-02; split on first use. */
const OLD_KEY = "offline-cards";

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;

/** What the device knows about its saved copy, without reading the list. */
export interface Meta {
  format?: number;
  /** The server's card data version (changes with every card import). */
  version: string;
  /** Whether the server had loaded the Game Changer flags when the copy was made. */
  game_changers?: boolean;
  count: number;
  /** When the list was last downloaded. */
  savedAt: string;
  /** When the server was last asked whether it changed. */
  checkedAt: string;
  etag: string | null;
  lastModified: string | null;
}

interface Bundle {
  format?: number;
  version: string;
  game_changers?: boolean;
  cards: OfflineCard[];
}

/** How to reach the server from wherever this runs (the worker has no localStorage). */
export interface Access {
  apiBase: string;
  token: string | null;
  credentials: RequestCredentials;
}

let meta: Meta | null | undefined;
let list: OfflineCard[] | null = null;
/** Reads in progress, shared: requests arrive together (a search while the copy is being moved),
 *  and none may see a half-done answer or read the 24 MB twice. */
let metaLoad: Promise<Meta | null> | null = null;
let listLoad: Promise<OfflineCard[] | null> | null = null;

export function readMeta(): Promise<Meta | null> {
  if (meta !== undefined) return Promise.resolve(meta);
  metaLoad ??= loadMeta().finally(() => (metaLoad = null));
  return metaLoad;
}

async function loadMeta(): Promise<Meta | null> {
  let found = (await idbGet<Meta>(META_KEY)) ?? null;
  if (!found) {
    // A copy saved before the split: move it over once, then forget the old entry.
    const old = await idbGet<Bundle & { savedAt: string }>(OLD_KEY);
    if (old?.cards) {
      found = { format: old.format, version: old.version, game_changers: old.game_changers, count: old.cards.length, savedAt: old.savedAt, checkedAt: old.savedAt, etag: null, lastModified: null };
      await idbPutMany([[LIST_KEY, old.cards], [META_KEY, found]], [OLD_KEY]);
      list = old.cards;
    }
  }
  // Only now, with any move finished, is the answer known.
  meta = found;
  return found;
}

function readList(): Promise<OfflineCard[] | null> {
  if (list) return Promise.resolve(list);
  listLoad ??= (async () => {
    if (!(await readMeta())) return null;
    list ??= (await idbGet<OfflineCard[]>(LIST_KEY)) ?? null;
    return list;
  })().finally(() => (listLoad = null));
  return listLoad;
}

/** Whether a saved copy is due a check with the server. */
export function due(m: Meta | null, now = Date.now()): boolean {
  if (!m || m.format !== FORMAT) return true;
  if (m.etag || m.lastModified) return now - Date.parse(m.checkedAt) > DAY;
  return now - Date.parse(m.savedAt) > WEEK;
}

/**
 * Bring the saved copy up to date: if it's due (or `force`), ask the server, conditionally when
 * the copy has a validator, and save the list only when it came down changed. Returns what's
 * saved afterwards.
 */
export async function refresh(access: Access, force = false, now = () => new Date()): Promise<Meta | null> {
  const m = await readMeta();
  if (!force && !due(m, now().getTime())) return m;
  const headers = new Headers();
  if (access.token) headers.set("Authorization", `Bearer ${access.token}`);
  const current = m?.format === FORMAT ? m : null;
  if (current?.etag) headers.set("If-None-Match", current.etag);
  else if (current?.lastModified) headers.set("If-Modified-Since", current.lastModified);
  // no-store: the browser's own cache would turn a 304 into the full 24 MB again.
  const res = await fetch(`${access.apiBase}/api/cards/offline`, { headers, credentials: access.credentials, cache: "no-store" });
  const at = now().toISOString();
  if (res.status === 304 && current) {
    meta = { ...current, checkedAt: at };
    await idbPutMany([[META_KEY, meta]]);
    return meta;
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  const b = (await res.json()) as Bundle;
  const next: Meta = {
    format: b.format,
    version: b.version,
    game_changers: b.game_changers,
    count: b.cards.length,
    savedAt: at,
    checkedAt: at,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
  const same = current && current.version === next.version && current.game_changers === next.game_changers && current.count === next.count;
  // The same cards as already saved (a server without validators): only the dates change.
  await idbPutMany(same ? [[META_KEY, next]] : [[LIST_KEY, b.cards], [META_KEY, next]]);
  meta = next;
  if (!same) list = b.cards;
  return next;
}

/** A saved copy's Game Changer flags mean something only if the server had loaded them. */
const hasGameChangers = (m: Meta | null) => m?.format === FORMAT && m.game_changers === true;

/** Shape an offline card like the server's, for the shared card views. `gameChangers` says
 *  whether the copy carries the flags; without them a card's flag is unknown (null). */
export function toCard(c: OfflineCard, gameChangers: boolean): Card {
  return {
    oracle_id: c.i,
    name: c.n,
    mana_cost: c.m,
    cmc: c.v,
    type_line: c.t,
    oracle_text: c.o,
    colors: c.c,
    color_identity: c.ci,
    power: c.p,
    toughness: c.th,
    loyalty: c.l,
    rarity: c.r,
    layout: c.y,
    legalities: c.f,
    image_small: null,
    image_normal: c.img,
    image_art_crop: null,
    back_image_normal: null,
    artist: null,
    default_printing: null,
    edhrec_rank: c.e,
    game_changer: gameChangers ? c.g === true : null,
  };
}

export const NO_LIST = "You're offline and this device hasn't saved the card list yet.";

export async function search(q: string, order: string, page: number, pageSize = 60) {
  const cards = await readList();
  if (!cards) throw new Error(NO_LIST);
  const gameChangers = hasGameChangers(meta ?? null);
  const hits = searchOffline(cards, q, order as "name", { gameChangers });
  return { total: hits.length, page, page_size: pageSize, cards: hits.slice((page - 1) * pageSize, page * pageSize).map((c) => toCard(c, gameChangers)), offline: true as const };
}

export async function card(oracleId: string): Promise<Card | null> {
  const cards = await readList();
  const c = cards?.find((x) => x.i === oracleId);
  return c ? toCard(c, hasGameChangers(meta ?? null)) : null;
}

/** Every card's name, id and layout, for the scanner's name matching. */
export async function names(): Promise<Pick<OfflineCard, "i" | "n" | "y">[] | null> {
  const cards = await readList();
  return cards ? cards.map(({ i, n, y }) => ({ i, n, y })) : null;
}

/** Forget what's held in memory (tests). */
export function forget() {
  meta = undefined;
  list = null;
  metaLoad = null;
  listLoad = null;
}
