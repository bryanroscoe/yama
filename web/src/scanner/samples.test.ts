import { afterEach, describe, expect, it, vi } from "vitest";

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
