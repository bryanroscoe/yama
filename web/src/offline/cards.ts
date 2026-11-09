// Every card's rules text on the device (about 24 MB in IndexedDB, 5 MB to download), so
// card lookups work at the table without signal.
//
// The page's side (2026-11-02): the list lives in a worker (cards.worker.ts, cardStore.ts) that
// downloads, saves and searches it, and reads it from IndexedDB only when a search, lookup or
// scan needs it. The page reads only the small description of the saved copy. The worker is let
// go after a few idle minutes, so the list doesn't sit in a phone's memory.

import type { OfflineCard } from "@yama/core";
import { useSyncExternalStore } from "react";
import { API_BASE, currentToken, FETCH_CREDENTIALS, type Card } from "../api";
import type { Access, Meta } from "./cardStore";
import type { CardsReply, CardsRequest } from "./cards.worker";

type Status = { count: number; version: string | null; savedAt: string | null; downloading: boolean; error: string | null };
let status: Status = { count: 0, version: null, savedAt: null, downloading: false, error: null };
const listeners = new Set<() => void>();
const set = (s: Partial<Status>) => {
  status = { ...status, ...s };
  for (const l of listeners) l();
};
const showMeta = (m: Meta | null) => m && set({ count: m.count, version: m.version, savedAt: m.savedAt });

type Ask = CardsRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

const IDLE_MS = 3 * 60_000;
let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let next = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function startWorker(): Worker {
  const w = new Worker(new URL("./cards.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<CardsReply>) => {
    const r = e.data;
    const p = waiting.get(r.id);
    if (!p) return;
    waiting.delete(r.id);
    if (r.ok) p.resolve(r.value);
    else p.reject(new Error(r.error));
    if (!waiting.size) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (waiting.size) return;
        worker?.terminate();
        worker = null;
      }, IDLE_MS);
    }
  };
  w.onerror = (e) => {
    e.preventDefault();
    for (const p of waiting.values()) p.reject(new Error(e.message || "The card list's worker stopped"));
    waiting.clear();
    worker = null;
  };
  return w;
}

/** Ask the card list's worker; where there are no workers (tests), do the same work here. */
async function ask<T>(request: Ask): Promise<T> {
  if (typeof Worker === "undefined") {
    const store = await import("./cardStore");
    switch (request.op) {
      case "meta":
        return (await store.readMeta()) as T;
      case "refresh":
        return (await store.refresh(request.access, request.force)) as T;
      case "search":
        return (await store.search(request.q, request.order, request.page, request.pageSize)) as T;
      case "card":
        return (await store.card(request.oracleId)) as T;
      case "names":
        return (await store.names()) as T;
    }
  }
  clearTimeout(idle);
  worker ??= startWorker();
  const id = next++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...request, id });
  });
}

const access = (): Access => ({ apiBase: API_BASE, token: currentToken(), credentials: FETCH_CREDENTIALS });

/** Check the saved copy with the server now and save a changed list ("Update" in Your profile, Account settings). */
export async function downloadOfflineCards(): Promise<void> {
  if (status.downloading) return;
  set({ downloading: true, error: null });
  try {
    showMeta(await ask<Meta | null>({ op: "refresh", access: access(), force: true }));
    set({ downloading: false });
  } catch (e) {
    set({ downloading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Quietly, after the app has loaded: check the saved copy if it's due (cardStore.due). */
export async function refreshOfflineCardsIfStale() {
  if (!navigator.onLine || status.downloading) return;
  set({ downloading: true, error: null });
  try {
    showMeta(await ask<Meta | null>({ op: "refresh", access: access(), force: false }));
    set({ downloading: false });
  } catch (e) {
    set({ downloading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export function useOfflineCards() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!status.count) void ask<Meta | null>({ op: "meta" }).then(showMeta, () => undefined);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

export function offlineSearch(q: string, order: string, page: number, pageSize = 60): Promise<{ total: number; page: number; page_size: number; cards: Card[]; offline: true }> {
  return ask({ op: "search", q, order, page, pageSize });
}

export function offlineCard(oracleId: string): Promise<Card | null> {
  return ask({ op: "card", oracleId });
}

/** Every saved card's name, id and layout (the scanner's names), or null with no saved copy. */
export function offlineCardNames(): Promise<Pick<OfflineCard, "i" | "n" | "y">[] | null> {
  return ask({ op: "names" });
}
