import { describe, expect, it, vi } from "vitest";
import { prepareSheetForPrint } from "./print";

class Picture extends EventTarget {
  loading = "lazy";
  complete = false;
  naturalWidth = 0;
  dataset: { printCard: string };
  decode = vi.fn(async () => {});
  requests = 0;
  private url = "https://cards.scryfall.io/card.jpg";
  get src() { return this.url; }
  set src(value: string) { this.url = value; this.requests++; this.complete = false; }
  constructor(name: string) { super(); this.dataset = { printCard: name }; }
  load() { this.complete = true; this.naturalWidth = 146; this.dispatchEvent(new Event("load")); }
  fail() { this.complete = true; this.naturalWidth = 0; this.dispatchEvent(new Event("error")); }
}

function sheet(images: Picture[], fonts = Promise.resolve()) {
  return { querySelectorAll: () => images, ownerDocument: { fonts: { ready: fonts } } } as unknown as HTMLElement;
}

describe("printing a swap sheet", () => {
  it("waits for offscreen pictures and their decoding, as well as fonts", async () => {
    const visible = new Picture("Visible card");
    visible.load();
    const offscreen = new Picture("Last-page card");
    let decoded!: () => void;
    offscreen.decode.mockImplementation(() => new Promise<void>((resolve) => { decoded = resolve; }));
    let fontsReady!: () => void;
    const fonts = new Promise<void>((resolve) => { fontsReady = resolve; });
    const prepared = vi.fn();
    const pending = prepareSheetForPrint(sheet([visible, offscreen], fonts)).then(prepared);
    expect(offscreen.loading).toBe("eager");
    await Promise.resolve();
    expect(prepared).not.toHaveBeenCalled();
    offscreen.load();
    expect(offscreen.decode).toHaveBeenCalledOnce();
    decoded();
    await Promise.resolve();
    expect(prepared).not.toHaveBeenCalled();
    fontsReady();
    await pending;
    expect(prepared).toHaveBeenCalledOnce();
  });

  it("reports failed card names, and a later print retries a failed picture", async () => {
    const picture = new Picture("Brainstorm");
    const root = sheet([picture]);
    const first = prepareSheetForPrint(root);
    picture.fail();
    await expect(first).rejects.toThrow(/Brainstorm.*try Print again/);
    const second = prepareSheetForPrint(root);
    expect(picture.requests).toBe(1);
    picture.load();
    await expect(second).resolves.toBeUndefined();
  });

  it("refuses to print a downloaded picture that cannot be decoded", async () => {
    const picture = new Picture("Damaged picture");
    picture.load();
    picture.decode.mockRejectedValue(new Error("Corrupt image"));
    await expect(prepareSheetForPrint(sheet([picture]))).rejects.toThrow("Damaged picture");
  });

  it("stops waiting when an image request never finishes", async () => {
    vi.useFakeTimers();
    try {
      const pending = prepareSheetForPrint(sheet([new Picture("Unreachable card")]), 1000);
      const check = expect(pending).rejects.toThrow("Unreachable card");
      await vi.advanceTimersByTimeAsync(1000);
      await check;
    } finally { vi.useRealTimers(); }
  });
});
