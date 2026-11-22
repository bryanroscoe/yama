import { afterEach, describe, expect, it, vi } from "vitest";
import type { Quad } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Save scan photos", () => {
  it("is on unless the device turned it off", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const { savingPhotos, SAVE_PHOTOS_KEY } = await import("./samples");
    expect(savingPhotos()).toBe(true);
    store.set(SAVE_PHOTOS_KEY, "0");
    expect(savingPhotos()).toBe(false);
  });

  it("stays off once turned off, even when storage can't be written", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { savingPhotos, setSavingPhotos } = await import("./samples");
    expect(savingPhotos()).toBe(true);
    setSavingPhotos(false);
    expect(savingPhotos()).toBe(false);
  });
});

describe("cardOutline", () => {
  it("grows the quad away from its centre", async () => {
    const { cardOutline } = await import("./samples");
    const got = cardOutline([[0, 0], [100, 0], [100, 200], [0, 200]], 0.1).flat();
    [-5, -10, 105, -10, 105, 210, -5, 210].forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
  });
});

describe("ScanPhoto: one photo per card, relabelled by a later answer", () => {
  const quad: Quad = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const shot = { image: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, quad };

  async function setup(saving = true) {
    const calls: { path: string; method?: string; json?: Record<string, unknown> }[] = [];
    vi.doMock("../api", () => ({
      accountSignal: () => new AbortController().signal,
      api: async (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
        calls.push({ path, method: init?.method, json: init?.json });
        return { id: "s1" };
      },
    }));
    vi.doMock("./photoCut", async (original) => ({ ...(await original<typeof import("./photoCut")>()), cutPhoto: async () => ({ image: "AAAA", quad: shot.quad, crops: [] }) }));
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const samples = await import("./samples");
    samples.setSavingPhotos(saving);
    return { calls, samples };
  }

  afterEach(() => {
    vi.doUnmock("../api");
    vi.doUnmock("./photoCut");
  });

  it("keeps a card let go as unconfirmed, once, with what the scanner knew", async () => {
    const { calls, samples } = await setup();
    const p = new samples.ScanPhoto(shot, { source: "native", mode: "printing", rule: "leads", lead: 0.12, scores: [{ name: "Sol Ring", score: 0.8 }] });
    p.letGo({ guess_name: "Sol Ring", method: "art", score: 0.8 });
    p.letGo({ guess_name: "Sol Ring", method: "art", score: 0.8 });
    expect(await p.settled()).toBe("s1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/scan/samples", method: "POST", json: { kind: "unconfirmed", guess_name: "Sol Ring", source: "native", rule: "leads", lead: 0.12, shared: true, image: "AAAA" } });
  });

  it("relabels the photo kept for a later answer, never back to unconfirmed, and not twice the same", async () => {
    const { calls, samples } = await setup();
    const p = new samples.ScanPhoto(shot, {});
    p.label({ kind: "added", label_name: "Sol Ring", label_scryfall_id: "a" });
    p.label({ kind: "added", label_name: "Sol Ring", label_scryfall_id: "a" });
    p.label({ kind: "corrected", label_name: "Sol Ring", label_scryfall_id: "b" });
    p.letGo({ guess_name: "Sol Ring" });
    p.label({ kind: "unconfirmed" });
    await p.settled();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/scan/samples", "PATCH /api/scan/samples/s1"]);
    expect(calls[1]!.json).toEqual({ kind: "corrected", label_name: "Sol Ring", label_scryfall_id: "b" });
  });

  it("a card called wrong and then filed is a correction of the scanner's first guess", async () => {
    const { calls, samples } = await setup();
    const p = new samples.ScanPhoto(shot, {});
    p.label({ kind: "wrong", guess_name: "Wei Night Raiders" });
    p.label({ kind: "added", label_name: "Westvale Abbey", label_scryfall_id: "w" });
    await p.settled();
    expect(calls[0]!.json).toMatchObject({ kind: "wrong", guess_name: "Wei Night Raiders" });
    expect(calls[1]!.json).toEqual({ kind: "corrected", label_name: "Westvale Abbey", label_scryfall_id: "w" });
  });

  it("sends nothing while the switch is off, nor a relabel after it's turned off", async () => {
    const { calls, samples } = await setup(false);
    const off = new samples.ScanPhoto(shot, {});
    off.letGo({ guess_name: "Sol Ring" });
    off.label({ kind: "added", label_name: "Sol Ring" });
    expect(await off.settled()).toBeNull();
    expect(calls).toEqual([]);
    samples.setSavingPhotos(true);
    const on = new samples.ScanPhoto(shot, {});
    on.label({ kind: "added", label_name: "Sol Ring" });
    await on.settled();
    samples.setSavingPhotos(false);
    on.label({ kind: "corrected", label_name: "Mind Stone" });
    await on.settled();
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("photosLine", () => {
  it("says how many, how much and of what kind", async () => {
    const { photosLine } = await import("./samples");
    expect(
      photosLine({
        count: 1234,
        bytes: 0,
        keep: 20000,
        total_bytes: 312 * 1024 * 1024,
        kinds: [
          { name: "unconfirmed", photos: 800, bytes: 1 },
          { name: "added", photos: 400, bytes: 1 },
          { name: "corrected", photos: 30, bytes: 1 },
          { name: "wrong", photos: 4, bytes: 1 },
        ],
      }),
    ).toBe("1,234 saved, 312 MB: 800 skipped, 400 added, 30 corrected, 4 marked wrong.");
    expect(photosLine({ count: 2, bytes: 90_000, crop_bytes: 10_000, keep: 2000 })).toBe("2 saved, 98 kB.");
  });
});
