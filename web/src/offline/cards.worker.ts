/// <reference lib="webworker" />
// The offline card list's worker: downloads, parses and saves the list, and searches it, so none
// of the 24 MB passes through the page's thread (offline/cardStore.ts does the work).

import { card, names, readMeta, refresh, search, type Access } from "./cardStore";

export type CardsRequest =
  | { id: number; op: "meta" }
  | { id: number; op: "refresh"; access: Access; force: boolean }
  | { id: number; op: "search"; q: string; order: string; page: number; pageSize?: number }
  | { id: number; op: "card"; oracleId: string }
  | { id: number; op: "names" };

export type CardsReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

function run(m: CardsRequest): Promise<unknown> {
  switch (m.op) {
    case "meta":
      return readMeta();
    case "refresh":
      return refresh(m.access, m.force);
    case "search":
      return search(m.q, m.order, m.page, m.pageSize);
    case "card":
      return card(m.oracleId);
    case "names":
      return names();
  }
}

self.onmessage = (e: MessageEvent<CardsRequest>) => {
  const { id } = e.data;
  run(e.data).then(
    (value) => (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, value } satisfies CardsReply),
    (err: unknown) => (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies CardsReply),
  );
};
