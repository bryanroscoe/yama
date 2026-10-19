// Every card's rules text on the device (about 24 MB in IndexedDB, 5 MB to download), so
// card lookups work at the table without signal.

import { searchOffline, type OfflineCard } from "@yama/core";
import { useSyncExternalStore } from "react";
import { api, type Card } from "../api";
import { idbGet, idbPut } from "./idb";

interface Bundle {
  version: string;
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
    const b = await api<{ version: string; cards: OfflineCard[] }>("/api/cards/offline");
    const saved: Bundle = { ...b, savedAt: new Date().toISOString() };
    await idbPut(KEY, saved);
    bundle = saved;
    loading = Promise.resolve(saved);
    set({ count: saved.cards.length, version: saved.version, savedAt: saved.savedAt, downloading: false });
  } catch (e) {
    set({ downloading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Fetch the bundle in the background if this device has none, or it's more than a week old. */
export async function refreshOfflineCardsIfStale() {
  if (!navigator.onLine) return;
  const b = await loadOfflineCards();
  const week = 7 * 24 * 3600 * 1000;
  if (!b || Date.now() - Date.parse(b.savedAt) > week) await downloadOfflineCards();
}

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

/** Shape an offline card like the server's, for the shared card views. */
export function toCard(c: OfflineCard): Card {
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
  };
}

export async function offlineSearch(q: string, order: string, page: number, pageSize = 60) {
  const b = await loadOfflineCards();
  if (!b) throw new Error("You're offline and this device hasn't saved the card list yet.");
  const hits = searchOffline(b.cards, q, order as "name");
  return { total: hits.length, page, page_size: pageSize, cards: hits.slice((page - 1) * pageSize, page * pageSize).map(toCard), offline: true };
}

export async function offlineCard(oracleId: string): Promise<Card | null> {
  const b = await loadOfflineCards();
  const c = b?.cards.find((x) => x.i === oracleId);
  return c ? toCard(c) : null;
}
