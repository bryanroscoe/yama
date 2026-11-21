// The printing look (look.ts): its score, the card's side averaged over frames, the list's order,
// its best guess, and comparing printings a few at a time.
import { describe, expect, it } from "vitest";
import { cornersOf, lookBest, lookCandidates, LookFrames, lookOrder, lookScore, meanEmbedding, packLook, scoreCandidates, unpackLook, type LookEmbedding } from "./look";
import type { RgbaImage } from "./types";

const v = (...xs: number[]) => Float32Array.from(xs);
const emb = (symbol: number[], card: number[]): LookEmbedding => ({ symbol: v(...symbol), card: v(...card) });
const p = (id: string) => ({ scryfall_id: id });

describe("the look's score", () => {
  it("is 0.8 of the set symbol's cosine and 0.2 of the whole card's", () => {
    expect(lookScore(emb([1, 0], [1, 0]), emb([1, 0], [0, 1]))).toBeCloseTo(0.8);
    expect(lookScore(emb([1, 0], [1, 0]), emb([0, 1], [1, 0]))).toBeCloseTo(0.2);
    expect(lookScore(emb([0.6, 0.8], [1, 0]), emb([0.6, 0.8], [1, 0]))).toBeCloseTo(1);
  });

  it("averages the card's frames and renormalises each part", () => {
    const m = meanEmbedding([emb([1, 0], [1, 0]), emb([0, 1], [1, 0])])!;
    expect(Array.from(m.symbol).map((x) => Math.round(x * 1e4) / 1e4)).toEqual([0.7071, 0.7071]);
    expect(Array.from(m.card)).toEqual([1, 0]);
    expect(meanEmbedding([])).toBeNull();
  });

  it("runs a printing's picture with its own corners as the quad", () => {
    expect(cornersOf(488, 680)).toEqual([
      [0, 0],
      [488, 0],
      [488, 680],
      [0, 680],
    ]);
  });

  it("packs an embedding for the cache and back", () => {
    const e = emb([0.1, 0.2, 0.3], [0.4, 0.5, 0.6]);
    const back = unpackLook(packLook(e))!;
    expect(Array.from(back.symbol)).toEqual(Array.from(e.symbol));
    expect(Array.from(back.card)).toEqual(Array.from(e.card));
    expect(unpackLook(new Float32Array(3))).toBeNull();
  });
});

describe("the printing list in look order", () => {
  const options = ["new", "mid", "old", "oldest"].map(p);
  it("keeps the collector line's matches first, then the look's best first, then the unscored as they came", () => {
    expect(lookOrder(options, 0, { old: 0.9, mid: 0.4 }).map((o) => o.scryfall_id)).toEqual(["old", "mid", "new", "oldest"]);
    expect(lookOrder(options, 1, { old: 0.9, new: 0.1, oldest: 0.5 }).map((o) => o.scryfall_id)).toEqual(["new", "old", "oldest", "mid"]);
    expect(lookOrder(options, 0, undefined).map((o) => o.scryfall_id)).toEqual(["new", "mid", "old", "oldest"]);
    expect(lookOrder(options, 0, {})).not.toBe(options);
  });

  it("marks a best guess only once two printings are scored", () => {
    expect(lookBest({ a: 0.5 })).toBeNull();
    expect(lookBest(undefined)).toBeNull();
    expect(lookBest({ a: 0.5, b: 0.7, c: 0.6 })).toBe("b");
  });

  it("compares each printing by the picture of the face recognised", () => {
    const printings = [
      { scryfall_id: "a", image_normal: "https://cards.scryfall.io/normal/front/a.jpg", back_image_normal: "https://cards.scryfall.io/normal/back/a.jpg" },
      { scryfall_id: "b", image_normal: "https://cards.scryfall.io/normal/front/b.jpg", back_image_normal: null },
      { scryfall_id: "c", image_normal: null, back_image_normal: null },
    ];
    expect(lookCandidates(printings, false)).toEqual([
      { id: "a", url: "https://cards.scryfall.io/normal/front/a.jpg" },
      { id: "b", url: "https://cards.scryfall.io/normal/front/b.jpg" },
    ]);
    expect(lookCandidates(printings, true)).toEqual([{ id: "a", url: "https://cards.scryfall.io/normal/back/a.jpg" }]);
  });
});

describe("comparing printings", () => {
  const query = emb([1, 0], [1, 0]);
  const keys: Record<string, LookEmbedding> = { a: emb([1, 0], [1, 0]), b: emb([0, 1], [0, 1]), c: emb([0.6, 0.8], [1, 0]) };
  const candidates = ["a", "b", "c", "d"].map((id) => ({ id, url: `https://cards.scryfall.io/${id}.jpg` }));

  it("scores a few at a time, reports each as it comes, and skips a picture it can't have", async () => {
    let running = 0;
    let most = 0;
    const scores: Record<string, number> = {};
    const scored = await scoreCandidates(
      query,
      candidates,
      async (c) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        if (!keys[c.id]) throw new Error("404");
        return keys[c.id]!;
      },
      (id, score) => (scores[id] = score),
      { concurrency: 2 },
    );
    expect(scored).toBe(3);
    expect(most).toBe(2);
    expect(Object.keys(scores).sort()).toEqual(["a", "b", "c"]);
    expect(scores.a).toBeCloseTo(1);
    expect(scores.b).toBeCloseTo(0);
    expect(scores.c).toBeCloseTo(0.8 * 0.6 + 0.2);
  });

  it("stops starting new ones once stopped", async () => {
    const stop = new AbortController();
    const seen: string[] = [];
    await scoreCandidates(
      query,
      candidates,
      async (c) => {
        seen.push(c.id);
        if (c.id === "a") stop.abort();
        return keys.a!;
      },
      () => undefined,
      { concurrency: 1, signal: stop.signal },
    );
    expect(seen).toEqual(["a"]);
  });
});

describe("the frames kept for the card's side", () => {
  const frame = (n: number, tops: number[]) => ({ image: { width: n, height: 1, data: new Uint8ClampedArray(4 * n) } as RgbaImage, quad: cornersOf(n, 1), tops });
  it("keeps the last few, and finds those whose best match was the card found", () => {
    const kept = new LookFrames(3);
    kept.add(frame(1, [7]));
    kept.add(frame(2, [9]));
    kept.add(frame(3, [7, 12]));
    kept.add(frame(4, [12]));
    expect(kept.of(7).map((f) => f.image.width)).toEqual([3]);
    expect(kept.of(12).map((f) => f.image.width)).toEqual([3, 4]);
    expect(kept.of(9).map((f) => f.image.width)).toEqual([2]);
    kept.clear();
    expect(kept.of(12)).toEqual([]);
  });
});
