// Taps on the plan pages, kept on this device until the server has them (docs/planner-design.md
// 3.3, following web/src/table/store.ts). Each user has their own box in localStorage
// (`yama.plan.outbox:<user id>`), so no signal never loses an answer. Sync posts to
// POST /api/plan/inputs: right after a tap (batched for a moment), when the browser comes back
// online, and every 20 seconds while anything waits. Ops carry client-made ids, so a retry after
// a lost reply is a no-op on the server.
//
// An op the server accepted moves to `sent` and stays in the overlay until a bundle with the
// reply's revision arrives, so the page never flickers back to the old answer. An op the server
// refused moves to `rejected`, with its error, for the page to show.
//
// Clearing a box (sign-out, "Clear plan data") aborts a request still on its way and fences it
// off: each user has a generation that clear() moves on, and a reply or error from an older
// generation is dropped, so a late reply can't write the user's answers back to the device.
import type { LocalOp, PlanOp } from "@yama/core/plan";
import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api";

import { isViewing } from "../viewingFlag";

export interface OpResult {
  op_id: string | null;
  status: "applied" | "duplicate" | "rejected";
  original?: "applied" | "rejected";
  error?: string;
  seq: number | null;
}

export interface InputsReply {
  revision: number;
  results: OpResult[];
}

export interface SentOp {
  op: PlanOp;
  seq: number | null;
  /** A bundle with this revision or later has the op. */
  revision: number;
}

export interface Box {
  pending: PlanOp[];
  sent: SentOp[];
  rejected: { op: PlanOp; error: string }[];
}

export interface SyncState {
  syncing: boolean;
  /** The last attempt's error (no connection, server down); null after a good sync. */
  error: string | null;
  lastSyncedAt: string | null;
}

interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const EMPTY: Box = { pending: [], sent: [], rejected: [] };
/** Ops in one request; the server takes up to 500. */
const BATCH = 200;
/** Taps this close together go in one request. */
const DEBOUNCE_MS = 1200;

export const boxKey = (userId: string) => `yama.plan.outbox:${userId}`;

/**
 * The outcome of one reply: accepted ops move to `sent`, refused ones to `rejected`, and ops the
 * reply doesn't mention stay pending. A duplicate is an op the server already had: it counts as
 * whatever happened the first time.
 */
export function applyReply(box: Box, posted: PlanOp[], reply: InputsReply): Box {
  const byId = new Map(reply.results.filter((r) => r.op_id).map((r) => [r.op_id!, r]));
  const done = new Set<string>();
  const sent = [...box.sent];
  const rejected = [...box.rejected];
  for (const op of posted) {
    const r = byId.get(op.op_id);
    if (!r) continue;
    done.add(op.op_id);
    const status = r.status === "duplicate" ? (r.original ?? "applied") : r.status;
    if (status === "rejected") rejected.push({ op, error: r.error ?? "Yama couldn't save this." });
    else sent.push({ op, seq: r.seq, revision: reply.revision });
  }
  return { pending: box.pending.filter((op) => !done.has(op.op_id)), sent, rejected };
}

export class PlanOutbox {
  private boxes = new Map<string, Box>();
  private listeners = new Set<() => void>();
  private syncedListeners = new Set<(userId: string, revision: number) => void>();
  private inflight = new Map<string, Promise<void>>();
  /** The running sync's abort handle, per user; it also tells one run from the next. */
  private runs = new Map<string, AbortController>();
  /** Goes up each time the user's box is cleared. A sync started before a clear writes nothing. */
  private generations = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  state: SyncState = { syncing: false, error: null, lastSyncedAt: null };

  constructor(
    private kv: KV | null,
    private post: (ops: PlanOp[], signal?: AbortSignal) => Promise<InputsReply>,
    private autoSync = true,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  /** Called after each good sync, with the plan revision that includes it. */
  onSynced(l: (userId: string, revision: number) => void) {
    this.syncedListeners.add(l);
    return () => void this.syncedListeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  box(userId: string | null | undefined): Box {
    if (!userId) return EMPTY;
    let b = this.boxes.get(userId);
    if (!b) {
      try {
        const raw = this.kv?.getItem(boxKey(userId));
        b = raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Box>) } : EMPTY;
      } catch {
        b = EMPTY;
      }
      this.boxes.set(userId, b);
    }
    return b;
  }

  private write(userId: string, b: Box) {
    this.boxes.set(userId, b);
    try {
      if (!b.pending.length && !b.sent.length && !b.rejected.length) this.kv?.removeItem(boxKey(userId));
      else this.kv?.setItem(boxKey(userId), JSON.stringify(b));
    } catch {
      /* storage full or blocked: the box still lives in memory for this session */
    }
    this.emit();
  }

  /** The ops the pages lay over the bundle: sent ones first (older), then pending, in tap order. */
  localOps(userId: string | null | undefined): LocalOp[] {
    const b = this.box(userId);
    return [...b.sent.map((s) => ({ op: s.op, local: "sent" as const, seq: s.seq })), ...b.pending.map((op) => ({ op, local: "pending" as const }))];
  }

  pendingCount(userId: string | null | undefined): number {
    return this.box(userId).pending.length;
  }

  /** A request for this user is still on its way (slow, not failed). */
  sending(userId: string | null | undefined): boolean {
    return !!userId && this.runs.has(userId);
  }

  /**
   * Queue a tap. Answers and marks are full records, so an unsent one for the same swap is replaced
   * by the newer one (three taps on one card send one op). Ideas and plan decisions are never merged.
   */
  enqueue(userId: string, op: PlanOp) {
    const b = this.box(userId);
    // Plan decisions are never merged either: each is a step (approve, then undo).
    const same = (o: PlanOp) => op.kind !== "idea" && op.kind !== "plan" && o.kind === op.kind && "swap_key" in o && o.swap_key === op.swap_key;
    this.write(userId, { ...b, pending: [...b.pending.filter((o) => !same(o)), op] });
    if (!this.autoSync) return;
    clearTimeout(this.timers.get(userId));
    this.timers.set(userId, setTimeout(() => void this.sync(userId), DEBOUNCE_MS));
  }

  private generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  /** Send what waits, a batch at a time. Never throws; the error goes in `state`. */
  sync(userId: string): Promise<void> {
    // An admin viewing as someone sends nothing (the server would refuse it anyway).
    if (isViewing()) return Promise.resolve();
    const running = this.inflight.get(userId);
    if (running) return running;
    const gen = this.generation(userId);
    const current = () => this.generation(userId) === gen;
    const ctl = new AbortController();
    this.runs.set(userId, ctl);
    this.state = { ...this.state, syncing: true };
    this.emit();
    const run = this.send(userId, current, ctl.signal)
      .then(
        () => {
          if (current()) this.state = { syncing: false, error: null, lastSyncedAt: new Date().toISOString() };
        },
        (e: unknown) => {
          if (current()) this.state = { ...this.state, syncing: false, error: e instanceof Error ? e.message : String(e) };
        },
      )
      .finally(() => {
        // A clear() since may have let a newer run start; that one's bookkeeping stays.
        if (this.runs.get(userId) === ctl) {
          this.runs.delete(userId);
          this.inflight.delete(userId);
        }
        this.emit();
      });
    // Set after the run is under way: its finally always runs later (a microtask), even when
    // there is nothing to send, so it can't leave a finished run here.
    this.inflight.set(userId, run);
    return run;
  }

  private async send(userId: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const batch = this.box(userId).pending.slice(0, BATCH);
      if (!batch.length) return;
      let reply: InputsReply;
      try {
        reply = await this.post(batch, signal);
      } catch (e) {
        if (!current()) return;
        if (!(e instanceof ApiError && e.status === 400)) throw e;
        // The server refused the whole request; retrying it won't help.
        reply = { revision: 0, results: batch.map((op) => ({ op_id: op.op_id, status: "rejected" as const, error: e.message, seq: null })) };
      }
      // The box was cleared while the request was out (sign-out, "Clear plan data"). The server
      // may have the answers, but they must not come back onto this device.
      if (!current()) return;
      this.write(userId, applyReply(this.box(userId), batch, reply));
      if (reply.results.some((r) => r.status !== "rejected")) for (const l of this.syncedListeners) l(userId, reply.revision);
    }
  }

  /** Forget sent ops that a bundle at `revision` already includes. */
  prune(userId: string, revision: number) {
    const b = this.box(userId);
    const sent = b.sent.filter((s) => s.revision > revision);
    if (sent.length !== b.sent.length) this.write(userId, { ...b, sent });
  }

  dismiss(userId: string, opId: string) {
    const b = this.box(userId);
    this.write(userId, { ...b, rejected: b.rejected.filter((r) => r.op.op_id !== opId) });
  }

  /**
   * Delete this user's box from the device (sign-out, "Clear plan data"). A sync on its way is
   * aborted, and whatever it hears back is dropped. Never throws.
   */
  clear(userId: string | null | undefined) {
    if (!userId) return;
    clearTimeout(this.timers.get(userId));
    this.timers.delete(userId);
    this.generations.set(userId, this.generation(userId) + 1);
    const run = this.runs.get(userId);
    if (run) {
      run.abort();
      this.runs.delete(userId);
      this.inflight.delete(userId);
      this.state = { ...this.state, syncing: false };
    }
    this.boxes.delete(userId);
    try {
      this.kv?.removeItem(boxKey(userId));
    } catch {
      /* nothing to remove */
    }
    this.emit();
  }
}

const browser = typeof window !== "undefined" && typeof localStorage !== "undefined";

export const outbox = new PlanOutbox(
  browser ? localStorage : null,
  (ops, signal) => api<InputsReply>("/api/plan/inputs", { method: "POST", json: ops, signal }),
  browser,
);

/** This device's id, sent with each op so an inbox line says which device it came from. */
export function deviceId(): string {
  if (!browser) return "test";
  let id = localStorage.getItem("yama.device");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("yama.device", id);
  }
  return id;
}

export function useOutbox(userId: string | null | undefined): Box {
  return useSyncExternalStore(outbox.subscribe, () => outbox.box(userId));
}

export function useOutboxState(): SyncState {
  return useSyncExternalStore(outbox.subscribe, () => outbox.state);
}

/** Whose box to retry when the page isn't a plan page: the signed-in user auth.tsx remembers. */
function signedInUser(): string | null {
  try {
    return (JSON.parse(localStorage.getItem("yama.me") ?? "null") as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

if (browser) {
  const retry = () => {
    const u = signedInUser();
    if (u && outbox.pendingCount(u) > 0) void outbox.sync(u);
  };
  window.addEventListener("online", retry);
  setInterval(() => navigator.onLine && retry(), 20_000);
}
