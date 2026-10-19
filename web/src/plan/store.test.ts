// Sign-out while the plan bundle is still on its way must not put it back on the device.
import type { PlanBundle } from "@yama/core/plan";
import { describe, expect, it, vi } from "vitest";
import type { BundleReply } from "./api";
import { type BundleIo, clearPlanData, refreshBundle } from "./store";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const bundle = (rev: string) => ({ rev }) as unknown as PlanBundle;

/** A server whose answer arrives when the test says so, and a device store that records writes. */
function fakeIo(put: BundleIo["put"] = async () => undefined) {
  const reply = deferred<BundleReply>();
  const io = { fetch: vi.fn(() => reply.promise), put: vi.fn(put), del: vi.fn(async () => undefined) };
  return { io, reply };
}

describe("refreshBundle", () => {
  it("saves the bundle when nothing happens on the way", async () => {
    const { io, reply } = fakeIo();
    const p = refreshBundle("u1", undefined, new AbortController().signal, io);
    reply.resolve(bundle("r1"));
    await expect(p).resolves.toEqual(bundle("r1"));
    expect(io.put).toHaveBeenCalledWith("plan:u1", bundle("r1"));
  });

  it("doesn't save a bundle that arrives after a sign-out", async () => {
    const { io, reply } = fakeIo();
    const p = refreshBundle("u1", undefined, new AbortController().signal, io);
    await clearPlanData("u1");
    reply.resolve(bundle("r1"));
    await expect(p).rejects.toThrow(/Signed out/);
    expect(io.put).not.toHaveBeenCalled();
  });

  it("doesn't save a bundle whose query was cancelled", async () => {
    const { io, reply } = fakeIo();
    const abort = new AbortController();
    const p = refreshBundle("u1", undefined, abort.signal, io);
    expect(io.fetch).toHaveBeenCalledWith(undefined, abort.signal);
    abort.abort();
    reply.resolve(bundle("r1"));
    await expect(p).rejects.toThrow();
    expect(io.put).not.toHaveBeenCalled();
  });

  it("takes the bundle back off when a sign-out lands during the save", async () => {
    const saving = deferred<void>();
    const { io, reply } = fakeIo(() => saving.promise);
    const p = refreshBundle("u1", undefined, new AbortController().signal, io);
    reply.resolve(bundle("r1"));
    await vi.waitFor(() => expect(io.put).toHaveBeenCalled());
    await clearPlanData("u1");
    saving.resolve();
    await p;
    expect(io.del).toHaveBeenCalledWith("plan:u1");
  });

  it("keeps the copy it has when the server says nothing changed, without writing", async () => {
    const { io, reply } = fakeIo();
    const prev = bundle("r1");
    const p = refreshBundle("u1", prev, new AbortController().signal, io);
    expect(io.fetch).toHaveBeenCalledWith("r1", expect.anything());
    reply.resolve({ unchanged: true, rev: "r1" });
    await expect(p).resolves.toBe(prev);
    expect(io.put).not.toHaveBeenCalled();
  });
});
