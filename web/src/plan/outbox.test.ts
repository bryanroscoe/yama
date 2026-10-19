// The plan outbox: taps survive no signal and reach the server once; sign-out takes everything off
// the device first, even offline and with Cloudflare Access.
import type { PlanOp, ReviewOp } from "@yama/core/plan";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { applyReply, boxKey, type InputsReply, PlanOutbox } from "./outbox";
import { discardQuestion, signOut, type SignOutSteps, within } from "./signout";

class MemoryKV {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const review = (op_id: string, decision: ReviewOp["decision"] = "want"): ReviewOp => ({
  op_id, kind: "review", at: "2026-10-19T01:00:00Z", swap_key: "p1", deck_key: "alpha", decision, note: null, cut: null,
});

/** A server that applies each op once, like POST /api/plan/inputs. */
function fakeServer() {
  const seen = new Map<string, number>();
  let seq = 0;
  let revision = 1;
  const post = vi.fn(async (ops: PlanOp[]): Promise<InputsReply> => {
    let applied = false;
    const results = ops.map((op) => {
      const old = seen.get(op.op_id);
      if (old) return { op_id: op.op_id, status: "duplicate" as const, original: "applied" as const, seq: old };
      seen.set(op.op_id, ++seq);
      applied = true;
      return { op_id: op.op_id, status: "applied" as const, seq };
    });
    if (applied) revision += 1;
    return { revision, results };
  });
  return { post, seen };
}

const offline = () => vi.fn(async (): Promise<InputsReply> => {
  throw new TypeError("Failed to fetch");
});

describe("applyReply", () => {
  it("moves accepted ops to sent, refused ones to rejected, and keeps the rest pending", () => {
    const box = { pending: [review("a"), review("b"), review("c"), review("d")], sent: [], rejected: [] };
    const reply: InputsReply = {
      revision: 7,
      results: [
        { op_id: "a", status: "applied", seq: 1 },
        { op_id: "b", status: "rejected", error: "decision: bad", seq: 2 },
        { op_id: "c", status: "duplicate", original: "rejected", error: "kind: bad", seq: 3 },
      ],
    };
    const next = applyReply(box, box.pending.slice(0, 3), reply);
    expect(next.pending.map((o) => o.op_id)).toEqual(["d"]);
    expect(next.sent).toEqual([{ op: review("a"), seq: 1, revision: 7 }]);
    expect(next.rejected.map((r) => [r.op.op_id, r.error])).toEqual([["b", "decision: bad"], ["c", "kind: bad"]]);
  });
});

describe("PlanOutbox", () => {
  it("keeps answers through airplane mode and a reload, then sends them once", async () => {
    const kv = new MemoryKV();
    const phone = new PlanOutbox(kv, offline(), false);
    phone.enqueue("u1", review("a"));
    phone.enqueue("u1", { ...review("b", "no"), swap_key: "p2" });
    await phone.sync("u1");
    expect(phone.state.error).toMatch(/fetch/);
    expect(phone.pendingCount("u1")).toBe(2);
    expect(phone.localOps("u1").map((o) => [o.op.op_id, o.local])).toEqual([["a", "pending"], ["b", "pending"]]);

    // The phone restarts: a new outbox reads the same storage, now with a connection.
    const server = fakeServer();
    const later = new PlanOutbox(kv, server.post, false);
    expect(later.pendingCount("u1")).toBe(2);
    const synced = vi.fn();
    later.onSynced(synced);
    await later.sync("u1");
    expect(later.state.error).toBeNull();
    expect(later.pendingCount("u1")).toBe(0);
    expect(server.seen.size).toBe(2);
    expect(synced).toHaveBeenCalledWith("u1", 2);
    // Still shown until a bundle with that revision arrives, then forgotten.
    expect(later.localOps("u1").map((o) => [o.op.op_id, o.local, o.seq])).toEqual([["a", "sent", 1], ["b", "sent", 2]]);
    later.prune("u1", 1);
    expect(later.box("u1").sent).toHaveLength(2);
    later.prune("u1", 2);
    expect(later.box("u1").sent).toHaveLength(0);
    expect(kv.getItem(boxKey("u1"))).toBeNull();

    // Syncing again sends nothing more.
    await later.sync("u1");
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it("a reply lost on the way back is a duplicate the next time, applied once", async () => {
    const kv = new MemoryKV();
    const server = fakeServer();
    let drop = true;
    const flaky = vi.fn(async (ops: PlanOp[]) => {
      const reply = await server.post(ops);
      if (drop) {
        drop = false;
        throw new TypeError("The network connection was lost.");
      }
      return reply;
    });
    const box = new PlanOutbox(kv, flaky, false);
    box.enqueue("u1", review("a"));
    await box.sync("u1");
    expect(box.pendingCount("u1")).toBe(1);
    await box.sync("u1");
    expect(box.pendingCount("u1")).toBe(0);
    expect(box.box("u1").sent).toEqual([{ op: review("a"), seq: 1, revision: 2 }]);
    expect(server.seen.size).toBe(1);
  });

  it("sets aside a whole request the server refuses, so later taps still go", async () => {
    const box = new PlanOutbox(new MemoryKV(), async () => {
      throw new ApiError(400, "body: expected a JSON array of ops");
    }, false);
    box.enqueue("u1", review("a"));
    await box.sync("u1");
    expect(box.pendingCount("u1")).toBe(0);
    expect(box.box("u1").rejected[0]!.error).toMatch(/JSON array/);
    box.dismiss("u1", "a");
    expect(box.box("u1").rejected).toEqual([]);
  });

  it("sends only the newest unsent answer for a card, and never merges ideas", async () => {
    const server = fakeServer();
    const box = new PlanOutbox(new MemoryKV(), server.post, false);
    box.enqueue("u1", review("a", "unsure"));
    box.enqueue("u1", review("b", null));
    box.enqueue("u1", { ...review("c", "want"), swap_key: "p2" });
    box.enqueue("u1", review("d", "want"));
    const idea = { kind: "idea" as const, op_id: "i1", at: "2026-10-19T01:00:00Z", deck_key: "alpha", in: "Sol Ring", out: null, why: null };
    box.enqueue("u1", idea);
    box.enqueue("u1", { ...idea, op_id: "i2" });
    expect(box.box("u1").pending.map((o) => o.op_id)).toEqual(["c", "d", "i1", "i2"]);
    // A tap on the same card while "d" is on its way isn't lost: "d" lands as sent, then "e" goes too.
    const sending = box.sync("u1");
    box.enqueue("u1", review("e", "no"));
    await sending;
    expect(box.box("u1").pending).toEqual([]);
    expect(box.box("u1").sent.map((s) => s.op.op_id)).toEqual(["c", "d", "i1", "i2", "e"]);
    expect([...server.seen.keys()]).toEqual(["c", "d", "i1", "i2", "e"]);
  });

  it("a sync with nothing to send doesn't block the next one", async () => {
    const server = fakeServer();
    const box = new PlanOutbox(new MemoryKV(), server.post, false);
    await box.sync("u1");
    box.enqueue("u1", review("a"));
    await box.sync("u1");
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(box.pendingCount("u1")).toBe(0);
  });

  it("a reply that lands after the box was cleared writes nothing back", async () => {
    const kv = new MemoryKV();
    let resolve!: (r: InputsReply) => void;
    let signal: AbortSignal | undefined;
    const post = vi.fn((_ops: PlanOp[], s?: AbortSignal) => {
      signal = s;
      return new Promise<InputsReply>((r) => (resolve = r));
    });
    const phone = new PlanOutbox(kv, post, false);
    const synced = vi.fn();
    phone.onSynced(synced);
    phone.enqueue("u1", { ...review("a"), note: "paid $4 at Pat's" });
    const run = phone.sync("u1");
    expect(phone.sending("u1")).toBe(true);
    phone.clear("u1");
    expect(signal?.aborted).toBe(true);
    expect(phone.sending("u1")).toBe(false);
    expect(phone.state.syncing).toBe(false);
    // The server still had the session and answers anyway.
    resolve({ revision: 2, results: [{ op_id: "a", status: "applied", seq: 1 }] });
    await run;
    expect(kv.getItem(boxKey("u1"))).toBeNull();
    expect(phone.box("u1")).toEqual({ pending: [], sent: [], rejected: [] });
    expect(synced).not.toHaveBeenCalled();
    expect(phone.state.error).toBeNull();
  });

  it("an aborted request after a clear isn't shown as an error, and doesn't end a newer sync", async () => {
    const kv = new MemoryKV();
    const calls: { ops: PlanOp[]; resolve: (r: InputsReply) => void; reject: (e: unknown) => void }[] = [];
    const post = vi.fn((ops: PlanOp[]) => new Promise<InputsReply>((resolve, reject) => calls.push({ ops, resolve, reject })));
    const phone = new PlanOutbox(kv, post, false);
    phone.enqueue("u1", review("a"));
    const old = phone.sync("u1");
    phone.clear("u1");
    // The same person signs in again and taps before the old request has failed.
    phone.enqueue("u1", { ...review("b"), swap_key: "p2" });
    const fresh = phone.sync("u1");
    expect(fresh).not.toBe(old);
    expect(calls.map((c) => c.ops.map((o) => o.op_id))).toEqual([["a"], ["b"]]);
    calls[0]!.reject(new DOMException("The operation was aborted.", "AbortError"));
    await old;
    expect(phone.state.error).toBeNull();
    expect(phone.sending("u1")).toBe(true);
    expect(phone.state.syncing).toBe(true);
    calls[1]!.resolve({ revision: 3, results: [{ op_id: "b", status: "applied", seq: 2 }] });
    await fresh;
    expect(phone.sending("u1")).toBe(false);
    expect(phone.box("u1").pending).toEqual([]);
    expect(phone.box("u1").sent.map((s) => s.op.op_id)).toEqual(["b"]);
  });

  it("keeps each user's taps apart and clears one user's box", async () => {
    const kv = new MemoryKV();
    const box = new PlanOutbox(kv, offline(), false);
    box.enqueue("u1", review("a"));
    box.enqueue("u2", review("b"));
    box.clear("u1");
    expect(box.pendingCount("u1")).toBe(0);
    expect(kv.getItem(boxKey("u1"))).toBeNull();
    expect(box.pendingCount("u2")).toBe(1);
    expect(new PlanOutbox(kv, offline(), false).pendingCount("u1")).toBe(0);
  });
});

describe("signOut", () => {
  function steps(over: Partial<SignOutSteps> = {}) {
    const calls: string[] = [];
    const s: SignOutSteps = {
      userId: "u1",
      pending: () => 0,
      flush: async () => void calls.push("flush"),
      confirmDiscard: () => {
        calls.push("confirm");
        return true;
      },
      clearPlan: async () => void calls.push("clear"),
      dropQueries: () => void calls.push("drop"),
      logoutRequest: async () => void calls.push("logout"),
      authConfig: async () => ({ cf_access: false }),
      cloudflareLogout: () => void calls.push("cloudflare"),
      finish: () => void calls.push("finish"),
      ...over,
    };
    return { s, calls };
  }

  it("clears plan data before the logout request", async () => {
    const { s, calls } = steps();
    await expect(signOut(s)).resolves.toBe("signed-out");
    expect(calls).toEqual(["clear", "drop", "logout", "clear", "finish"]);
  });

  it("offline: the request fails, but the plan data is already gone", async () => {
    const { s, calls } = steps({
      logoutRequest: async () => {
        calls.push("logout");
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(signOut(s)).rejects.toThrow("Failed to fetch");
    expect(calls).toEqual(["clear", "drop", "logout", "clear"]);
  });

  it("with Cloudflare Access: cleared before the redirect", async () => {
    const { s, calls } = steps({ authConfig: async () => ({ cf_access: true }) });
    await expect(signOut(s)).resolves.toBe("cloudflare");
    expect(calls).toEqual(["clear", "drop", "logout", "clear", "cloudflare"]);
  });

  it("tries to send waiting answers first, and asks before deleting any it couldn't", async () => {
    let left = 2;
    const sent = steps({ pending: () => left, flush: async () => void (left = 0) });
    await signOut(sent.s);
    expect(sent.calls).not.toContain("confirm");

    const stuck = steps({ pending: () => 2, confirmDiscard: () => false });
    await expect(signOut(stuck.s)).resolves.toBe("cancelled");
    expect(stuck.calls).toEqual(["flush"]);

    const anyway = steps({ pending: () => 2 });
    await signOut(anyway.s);
    expect(anyway.calls).toEqual(["flush", "confirm", "clear", "drop", "logout", "clear", "finish"]);
  });

  it("a flush that runs out of time: the question says it's slow, and the late reply leaves nothing", async () => {
    const kv = new MemoryKV();
    let resolve!: (r: InputsReply) => void;
    const phone = new PlanOutbox(kv, () => new Promise<InputsReply>((r) => (resolve = r)), false);
    phone.enqueue("u1", { ...review("a"), note: "paid $4 at Pat's" });
    const asked: string[] = [];
    const { s } = steps({
      pending: () => phone.pendingCount("u1"),
      flush: () => within(phone.sync("u1"), 10),
      confirmDiscard: (n) => {
        asked.push(discardQuestion(n, phone.sending("u1")));
        return true;
      },
      clearPlan: async (u) => phone.clear(u),
      logoutRequest: async () => undefined,
    });
    await expect(signOut(s)).resolves.toBe("signed-out");
    expect(asked).toEqual([
      "1 answer on this device is still on its way to Yama (slow connection). Signing out stops it and deletes it from this device, though Yama may already have it. Sign out anyway?",
    ]);
    // The logout reply came first; the inputs reply comes after both clears.
    resolve({ revision: 2, results: [{ op_id: "a", status: "applied", seq: 1 }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.getItem(boxKey("u1"))).toBeNull();
  });

  it("says no connection only when sending failed", () => {
    expect(discardQuestion(2, false)).toBe("2 answers on this device haven't reached Yama yet (Yama couldn't be reached). Signing out deletes them. Sign out anyway?");
    expect(discardQuestion(2, true)).toMatch(/^2 answers on this device are still on their way to Yama \(slow connection\)\. .*Yama may already have some\./);
  });

  it("the real clearPlanData removes the outbox too", async () => {
    const store = await import("./store");
    const { outbox } = await import("./outbox");
    outbox.enqueue("u9", review("z"));
    expect(outbox.pendingCount("u9")).toBe(1);
    await store.clearPlanData("u9");
    expect(outbox.pendingCount("u9")).toBe(0);
  });
});
