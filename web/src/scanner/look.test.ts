// The printing look (look.ts): its score, the card's side averaged over frames, the list's order,
// its best guess, and comparing printings a few at a time.
import { describe, expect, it } from "vitest";
import {
  cornersOf,
  leadingCard,
  LOOK_SETTLE_LEAD,
  lookBest,
  lookCandidates,
  LookFrames,
  lookLead,
  lookOrder,
  lookScore,
  lookSettles,
  lookTimingDetail,
  lookTops,
  meanEmbedding,
  packLook,
  scoreCandidates,
  ServerAnswer,
  serverId,
  serverKeys,
  serverOrOwn,
  unpackLook,
  unpackServerLook,
  withoutMisread,
  type LookEmbedding,
} from "./look";

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
  it("puts a printing said to be wrong last, whatever its score", () => {
    const list = ["a", "b", "c"].map(p);
    expect(withoutMisread(lookOrder(list, 0, { a: 0.9, b: 0.5, c: 0.1 }), "a").map((o) => o.scryfall_id)).toEqual(["b", "c", "a"]);
    expect(withoutMisread(list, undefined).map((o) => o.scryfall_id)).toEqual(["a", "b", "c"]);
  });

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
      { id: "a", url: "https://cards.scryfall.io/normal/front/a.jpg", back: false },
      { id: "b", url: "https://cards.scryfall.io/normal/front/b.jpg", back: false },
    ]);
    expect(lookCandidates(printings, true)).toEqual([{ id: "a", url: "https://cards.scryfall.io/normal/back/a.jpg", back: true }]);
    // The server knows a back face as the art gallery does.
    expect(lookCandidates(printings, true).map(serverId)).toEqual(["a-1"]);
  });
});

/** The server's form of a vector: float16 little-endian, base64 (server/src/scan_look.rs, `to_f16`). */
const f16 = (xs: number[]) => {
  const bytes: number[] = [];
  for (const x of xs) {
    // Exact for these values (halves, quarters, ±1).
    const sign = x < 0 ? 0x8000 : 0;
    const a = Math.abs(x);
    let bits = 0;
    if (a !== 0) {
      const e = Math.floor(Math.log2(a));
      bits = ((e + 15) << 10) | Math.round((a / 2 ** e - 1) * 1024);
    }
    bits |= sign;
    bytes.push(bits & 255, bits >> 8);
  }
  return btoa(String.fromCharCode(...bytes));
};

describe("the server's vectors", () => {
  it("are float16, symbol then card", () => {
    expect(unpackServerLook(f16([0.5, -0.25, 1, 0]))).toEqual(emb([0.5, -0.25], [1, 0]));
    expect(unpackServerLook("")).toBeNull();
    expect(unpackServerLook("not base64!")).toBeNull();
    // An odd number of halves isn't two parts.
    expect(unpackServerLook(btoa("\u0000\u0000\u0000\u0000\u0000\u0000"))).toBeNull();
  });

  it("are used only for the very picture this device would fetch", () => {
    const candidates = [
      { id: "a", url: "https://cards.scryfall.io/normal/front/a.jpg?1", back: false },
      { id: "b", url: "https://cards.scryfall.io/normal/back/b.jpg?1", back: true },
      { id: "c", url: "https://cards.scryfall.io/normal/front/c.jpg?2", back: false },
    ];
    const keys = serverKeys(candidates, [
      { id: "a", url: "https://cards.scryfall.io/normal/front/a.jpg?1", vector: f16([1, 0, 0, 1]) },
      { id: "b-1", url: "https://cards.scryfall.io/normal/back/b.jpg?1", vector: f16([0, 1, 1, 0]) },
      // Scryfall's picture changed since this device read the card data: not the same picture.
      { id: "c", url: "https://cards.scryfall.io/normal/front/c.jpg?1", vector: f16([1, 0, 1, 0]) },
      // Not asked about.
      { id: "d", url: "https://cards.scryfall.io/normal/front/d.jpg?1", vector: f16([1, 0, 1, 0]) },
    ]);
    expect([...keys.keys()]).toEqual(["https://cards.scryfall.io/normal/front/a.jpg?1", "https://cards.scryfall.io/normal/back/b.jpg?1"]);
    expect(keys.get(candidates[1]!.url)).toEqual(emb([0, 1], [1, 0]));
    expect(serverKeys(candidates, null).size).toBe(0);
  });

  const U = "https://cards.scryfall.io/normal/front/a.jpg?1";
  /** An answer from the server that comes after `ms` with these vectors (by URL). */
  const later = (ms: number, keys: [string, LookEmbedding][] = []) => {
    const a = new ServerAnswer();
    setTimeout(() => a.give(new Map(keys)), ms);
    return a;
  };
  const answered = (keys: [string, LookEmbedding][] = []) => {
    const a = new ServerAnswer();
    a.give(new Map(keys));
    return a;
  };

  it("in hand are used without fetching the picture at all", async () => {
    let started = 0;
    const own = () => ((started += 1), Promise.resolve(emb([0], [1])));
    expect(await serverOrOwn(own, answered([[U, emb([1], [0])]]), U)).toEqual({ key: emb([1], [0]), server: true });
    expect(started).toBe(0);
    // In hand without this picture: made here, with nothing to wait for.
    expect(await serverOrOwn(own, answered(), U)).toEqual({ key: emb([0], [1]), server: false });
    expect(started).toBe(1);
    // Only the first answer counts.
    const a = answered();
    a.give(new Map([[U, emb([1], [0])]]));
    expect(a.done?.size).toBe(0);
  });

  it("are taken when they come first, stopping the making here", async () => {
    let stopped = false;
    const own = (signal: AbortSignal) =>
      new Promise<LookEmbedding>((_, reject) => signal.addEventListener("abort", () => ((stopped = true), reject(new Error("aborted")))));
    const got = await serverOrOwn(own, later(5, [[U, emb([1], [0])]]), U);
    expect(got).toEqual({ key: emb([1], [0]), server: true });
    expect(stopped).toBe(true);
  });

  it("never hold a printing up: one made here first, or when the server has none, is used", async () => {
    const mine = emb([0], [1]);
    expect(await serverOrOwn(() => Promise.resolve(mine), later(50, [[U, emb([1], [0])]]), U)).toEqual({ key: mine, server: false });
    expect(await serverOrOwn(() => new Promise((r) => setTimeout(() => r(mine), 5)), later(1), U)).toEqual({ key: mine, server: false });
    // The server gave up (offline, a failure): an empty answer, and what's made here.
    expect(await serverOrOwn(() => new Promise((r) => setTimeout(() => r(mine), 10)), later(1), U)).toEqual({ key: mine, server: false });
  });

  it("are still taken when the making here fails, and the failure stands when the server has none", async () => {
    const theirs = emb([1], [0]);
    const fails = () => Promise.reject(new Error("Couldn't fetch (503)"));
    expect(await serverOrOwn(fails, later(5, [[U, theirs]]), U)).toEqual({ key: theirs, server: true });
    await expect(serverOrOwn(fails, later(1), U)).rejects.toThrow("503");
  });

  it("stop with the look", async () => {
    const stop = new AbortController();
    const own = (signal: AbortSignal) => new Promise<LookEmbedding>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
    const going = serverOrOwn(own, later(1), U, stop.signal);
    stop.abort();
    await expect(going).rejects.toThrow("stopped");
  });

  it("are counted in the timing record by where they came from", () => {
    const done = { model: "look-152f52c100f0", frames: 3, queryMs: 80, scored: 5, cached: 1, asked: 4, server: 3, serverMs: 120, fetchMs: 400, decodeMs: 10, embedMs: 40, ms: 612.4 };
    expect(lookTimingDetail(done)).toEqual({ look_ms: 612, look_scored: 5, look_cached: 1, look_server: 3, look_made: 1 });
    // A record from a build before the server's vectors.
    expect(lookTimingDetail({ ...done, server: undefined, asked: undefined })).toMatchObject({ look_server: 0, look_made: 4 });
  });
});

describe("settling by look (the option that settles when sure)", () => {
  const options = ["a", "b", "c"].map(p);
  const nothingRead = () => false;
  it("settles at a lead of 0.10 over the next printing, the lab's rule", () => {
    expect(LOOK_SETTLE_LEAD).toBe(0.1);
    expect(lookSettles(options, { a: 0.62, b: 0.91, c: 0.4 }, nothingRead)).toEqual({ settled: true, id: "b", lead: expect.closeTo(0.29, 9) });
    expect(lookSettles(options, { a: 0.8, b: 0.69, c: 0.1 }, nothingRead)).toMatchObject({ settled: true, id: "a" });
    // 0.08 settled one wrong of 54 in the lab: not enough.
    expect(lookSettles(options, { a: 0.8, b: 0.72, c: 0.1 }, nothingRead)).toEqual({ settled: false, why: "lead", lead: expect.closeTo(0.08, 9) });
  });
  it("leaves strict visual twins to the collector line: a tiny lead never settles", () => {
    expect(lookSettles(options, { a: 0.931, b: 0.927, c: 0.2 }, nothingRead)).toMatchObject({ settled: false, why: "lead" });
  });
  it("settles only once every printing in the list is scored: one whose picture couldn't be had means no settle", () => {
    expect(lookSettles(options, { a: 0.95, b: 0.2 }, nothingRead)).toEqual({ settled: false, why: "unscored", lead: null });
    expect(lookSettles(options, { a: 0.95, b: 0.2, c: Number.NaN }, nothingRead)).toMatchObject({ settled: false, why: "unscored" });
    expect(lookSettles(options, undefined, nothingRead)).toMatchObject({ settled: false, why: "unscored" });
    expect(lookSettles([p("a")], { a: 0.95 }, nothingRead)).toMatchObject({ settled: false, why: "unscored" });
    expect(lookLead(options, { a: 0.95, b: 0.2, c: 0.1 })).toEqual({ id: "a", lead: expect.closeTo(0.75, 9) });
  });
  it("never settles against a collector-line read pointing to another printing, and asks only about its own pick", () => {
    const asked: string[] = [];
    const readOther = (id: string) => (asked.push(id), id !== "c");
    expect(lookSettles(options, { a: 0.95, b: 0.3, c: 0.1 }, readOther)).toEqual({ settled: false, why: "read-other", lead: expect.closeTo(0.65, 9) });
    expect(lookSettles(options, { a: 0.1, b: 0.3, c: 0.95 }, readOther)).toMatchObject({ settled: true, id: "c" });
    expect(asked).toEqual(["a", "c"]);
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
  const add = (kept: LookFrames, n: number, tops: number[]) => kept.add(n, 1, new Uint8ClampedArray(4 * n).fill(n), cornersOf(n, 1), tops);
  it("keeps the last few, and finds those that matched the card found", () => {
    const kept = new LookFrames(3);
    add(kept, 1, [7]);
    add(kept, 2, [9]);
    add(kept, 3, [7, 12]);
    add(kept, 4, [12]);
    expect(kept.of(7).map((f) => f.image.width)).toEqual([3]);
    expect(kept.of(12).map((f) => f.image.width)).toEqual([3, 4]);
    expect(kept.of(9).map((f) => f.image.width)).toEqual([2]);
    // Copies, not the caller's buffer.
    expect(Array.from(kept.of(9)[0]!.image.data)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    kept.clear();
    expect(kept.of(12)).toEqual([]);
  });

  it("reuses its buffers once full, and forgets a card that left before the next copy comes", () => {
    const kept = new LookFrames(2);
    add(kept, 2, [5]);
    add(kept, 2, [5]);
    const first = kept.of(5)[0]!.image.data;
    add(kept, 2, [5]);
    expect(kept.of(5).map((f) => f.image.data)).toContain(first);
    // The card left the view (a frame with no card): the next copy of the same art starts afresh.
    kept.clear();
    add(kept, 2, [5]);
    expect(kept.of(5)).toHaveLength(1);
  });

  it("is kept under the artworks a frame matched well and near its best, each once, whatever the bundle's printing count", () => {
    // A title read can settle on 11 (0.66, near the best); 8 (0.4) and 20 (0.6, far behind) are only on the list.
    expect(lookTops([{ index: 3, score: 0.8 }, { index: 8, score: 0.4 }, { index: 3, score: 0.79 }, { index: 11, score: 0.66 }, { index: 20, score: 0.6 }])).toEqual([3, 11]);
    expect(lookTops([{ index: 5, score: 0.45 }])).toEqual([]);
  });

  it("knows which card leads a frame, so the ring starts afresh for another", () => {
    expect(leadingCard([{ name: "Forest", score: 0.7 }, { name: "Sol Ring", score: 0.9 }])).toBe("Sol Ring");
    expect(leadingCard([])).toBeNull();
  });
});
