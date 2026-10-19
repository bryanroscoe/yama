// Every card's rules text on the device (about 24 MB in IndexedDB, 5 MB to download), so
// card lookups work at the table without signal.

import { searchOffline, type OfflineCard } from "@yama/core";
import { useSyncExternalStore } from "react";
import { api, type Card } from "../api";
import { idbGet, idbPut } from "./idb";

/** Bundle shape this app reads (the server's OFFLINE_FORMAT). A saved copy in another
 *  format, or none (saved before formats existed), is downloaded again. */
const FORMAT = 2;

interface Bundle {
  format?: number;
  version: string;
  /** Whether the server had loaded the Game Changer flags when the bundle was made. */
  game_changers?: boolean;
  savedAt: string;
  cards: OfflineCard[];
}

const KEY = "offline-cards";

type Status = { count: number; version: string | null; savedAt: string | null; downloading: boolean; error: string | null };
let status: Status = { count: 0, version: null, savedAt: null, downloading: false, error: null };
let bundle: Bundle | null = null;
let loading: Promise<Bundle | null> | null = null;
const listeners = new Set<() => void>();
const set = (s: Partial<Status>) => {
  status = { ...status, ...s };
  for (const l of listeners) l();
};

export function loadOfflineCards(): Promise<Bundle | null> {
  if (bundle) return Promise.resolve(bundle);
  loading ??= idbGet<Bundle>(KEY)
    .then((b) => {
      bundle = b ?? null;
      if (b) set({ count: b.cards.length, version: b.version, savedAt: b.savedAt });
      return bundle;
    })
    .catch(() => null);
  return loading;
}

export async function downloadOfflineCards(): Promise<void> {
  if (status.downloading) return;
  set({ downloading: true, error: null });
  try {
    const b = await api<Omit<Bundle, "savedAt">>("/api/cards/offline");
    const saved: Bundle = { ...b, savedAt: new Date().toISOString() };
    await idbPut(KEY, saved);
    bundle = saved;
    loading = Promise.resolve(saved);
    set({ count: saved.cards.length, version: saved.version, savedAt: saved.savedAt, downloading: false });
  } catch (e) {
    set({ downloading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Fetch the bundle in the background if this device has none, it's in an older format, or
 *  it's more than a week old. */
export async function refreshOfflineCardsIfStale() {
  if (!navigator.onLine) return;
  const b = await loadOfflineCards();
  const week = 7 * 24 * 3600 * 1000;
  if (!b || b.format !== FORMAT || Date.now() - Date.parse(b.savedAt) > week) await downloadOfflineCards();
}

/** A saved bundle's Game Changer flags mean something only if the server had loaded them. */
const hasGameChangers = (b: Bundle) => b.format === FORMAT && b.game_changers === true;

export function useOfflineCards() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadOfflineCards();
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** Shape an offline card like the server's, for the shared card views. `gameChangers` says
 *  whether the bundle carries the flags; without them a card's flag is unknown (null). */
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

export async function offlineSearch(q: string, order: string, page: number, pageSize = 60) {
  const b = await loadOfflineCards();
  if (!b) throw new Error("You're offline and this device hasn't saved the card list yet.");
  const gameChangers = hasGameChangers(b);
  const hits = searchOffline(b.cards, q, order as "name", { gameChangers });
  const cards = hits.slice((page - 1) * pageSize, page * pageSize).map((c) => toCard(c, gameChangers));
  return { total: hits.length, page, page_size: pageSize, cards, offline: true };
}

export async function offlineCard(oracleId: string): Promise<Card | null> {
  const b = await loadOfflineCards();
  const c = b?.cards.find((x) => x.i === oracleId);
  return b && c ? toCard(c, hasGameChangers(b)) : null;
}
