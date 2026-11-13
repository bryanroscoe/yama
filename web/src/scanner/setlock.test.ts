import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { digitalRegion, readCaps, zoomLevels, zoomSteps } from "./camera";
import { halfToFloat, readGallery } from "./gallery";
import { poolIndices, type Art, type ArtMatch } from "./recognizer";
import { priceRange } from "./ScannerView";
import { artInSets, inLockedSets, judgeLocked, lockedNames, poolKeys, suggestLock, type LockedSet, type SetPrinting } from "./setlock";

const art = (index: number, score: number, illustrationId: string | null, id = `id${index}`, name = `Card ${index}`): ArtMatch => ({ index, score, illustrationId, id, name, set: "x", number: "1", layout: "normal", printings: 1 });

const printing = (p: Partial<SetPrinting>): SetPrinting => ({
  scryfall_id: "s",
  oracle_id: "o",
  name: "Sol Ring",
  set_code: "ecc",
  set_name: "Edge of Eternities Commander",
  collector_number: "57",
  lang: "en",
  rarity: "uncommon",
  finishes: ["nonfoil"],
  released_at: "2025-08-01",
  image_normal: null,
  image_small: null,
  back_image_normal: null,
  artist: null,
  price_date: "2026-11-05",
  usd: 1,
  usd_foil: null,
  usd_etched: null,
  eur: null,
  eur_foil: null,
  illustration_id: null,
  back_illustration_id: null,
  ...p,
});

describe("set lock", () => {
  const sets: LockedSet[] = [
    {
      code: "ecc",
      name: "Edge of Eternities Commander",
      printings: [
        printing({ scryfall_id: "a", illustration_id: "ill-a" }),
        printing({ scryfall_id: "b", name: "Fire // Ice", illustration_id: "ill-b", back_illustration_id: "ill-b2" }),
        printing({ scryfall_id: "c", name: "New Card", illustration_id: null }),
      ],
    },
  ];

  it("matches the sets' artworks, back faces and printings without art data", () => {
    const keys = poolKeys(sets);
    expect(keys.illustrations.sort()).toEqual(["ill-a", "ill-b", "ill-b2"]);
    expect(keys.ids).toEqual(["c"]);
    const inSets = artInSets(keys);
    expect(inSets(art(1, 0.9, "ill-a"))).toBe(true);
    expect(inSets(art(2, 0.9, null, "c-1"))).toBe(true);
    expect(inSets(art(3, 0.9, "other"))).toBe(false);
    const gallery: Art[] = [art(0, 0, "other"), art(1, 0, "ill-b2"), art(2, 0, null, "c-1"), art(3, 0, "ill-a")];
    expect(poolIndices(gallery, keys)).toEqual([1, 2, 3]);
  });

  it("reads names against each face", () => {
    expect(lockedNames(sets).sort()).toEqual(["Fire", "Ice", "New Card", "Sol Ring"]);
  });

  it("goes on the in-set match while it's about as good as the best anywhere", () => {
    const inSets = artInSets(poolKeys(sets));
    // The right card is in the set: the pool's best is the best anywhere.
    const right = art(1, 0.93, "ill-a");
    expect(judgeLocked([right, art(9, 0.6, "zz")], [right], inSets, 0.5)).toEqual({ kind: "in-set", match: right });
    // A reprint elsewhere scores a little higher than the set's own art: still the set's.
    const near = art(4, 0.88, "ill-b");
    expect(judgeLocked([art(9, 0.91, "zz"), near], [near], inSets, 0.5)).toEqual({ kind: "in-set", match: near });
    // A card clearly not in the set: shown as outside, not as the set's lookalike.
    const outside = art(9, 0.95, "zz");
    expect(judgeLocked([outside], [art(1, 0.55, "ill-a")], inSets, 0.5)).toEqual({ kind: "outside", match: outside });
    // An in-set match too weak to go on.
    expect(judgeLocked([], [art(1, 0.3, "ill-a")], inSets, 0.5)).toEqual({ kind: "none" });
    // Without a pool search, the top matches that are in the set stand in.
    expect(judgeLocked([art(9, 0.9, "zz"), near], undefined, inSets, 0.5)).toEqual({ kind: "in-set", match: near });
  });

  it("chooses among the locked sets' printings", () => {
    const all = [printing({ set_code: "c21" }), printing({ set_code: "ecc" })];
    expect(inLockedSets(all, new Set(["ecc"])).map((p) => p.set_code)).toEqual(["ecc"]);
    expect(inLockedSets(all, new Set())).toEqual([]);
  });

  it("suggests a lock after a run of cards from one set", () => {
    expect(suggestLock(["ecc", "ecc", "ecc", "c21"], new Set())).toBe("ecc");
    expect(suggestLock(["ecc", "c21", "ecc"], new Set())).toBeNull();
    expect(suggestLock(["ecc", "ecc"], new Set())).toBeNull();
    expect(suggestLock(["ecc", "ecc", "ecc"], new Set(["ecc"]))).toBeNull();
  });
});

describe("price range of unsettled printings", () => {
  it("spans English printings with a price, never counting a missing price as 0", () => {
    const r = priceRange(
      [printing({ usd: 0.5, price_date: "2026-11-04" }), printing({ usd: null }), printing({ usd: 3, price_date: "2026-11-05" }), printing({ usd: 99, lang: "ja" })],
      "nonfoil",
    );
    expect(r).toEqual({ low: 0.5, high: 3, date: "2026-11-05" });
    expect(priceRange([printing({ usd: null })], "nonfoil")).toBeNull();
    expect(priceRange([printing({ usd: 1, usd_foil: 4 })], "foil")).toEqual({ low: 4, high: 4, date: "2026-11-05" });
  });
});

describe("camera controls", () => {
  const track = (caps: object) => ({ getCapabilities: () => caps }) as unknown as MediaStreamTrack;
  it("uses the camera's own zoom and torch where offered", () => {
    const caps = readCaps(track({ torch: true, zoom: { min: 1, max: 2.5 } }));
    expect(caps).toEqual({ torch: true, zoom: { min: 1, max: 2.5 } });
    expect(zoomLevels(caps)).toEqual([1, 1.5, 2]);
  });
  it("falls back to a digital zoom", () => {
    const caps = readCaps(track({}));
    expect(caps).toEqual({ torch: false, zoom: null });
    expect(zoomLevels(caps)).toEqual([1, 1.5, 2, 3]);
    expect(digitalRegion(1000, 600, 2)).toEqual({ x: 250, y: 150, w: 500, h: 300 });
    expect(digitalRegion(1000, 600, 1)).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    // A portrait screen shows the middle 300 of a 1000 × 600 frame (cover); 2× is half of that.
    expect(digitalRegion(1000, 600, 2, { width: 300, height: 600 })).toEqual({ x: 425, y: 150, w: 150, h: 300 });
  });
});

// A tiny search graph in the bundle's form: gallery (f16, N×D), frames (int64, N×1), penalties (f32, N).
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const field = (f: number, bytes: number[]) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
const num = (f: number, v: number) => [...varint(f * 8), ...varint(v)];
function tensor(name: string, dims: number[], dataType: number, raw: Uint8Array): number[] {
  return [...dims.flatMap((d) => num(1, d)), ...num(2, dataType), ...field(8, [...new TextEncoder().encode(name)]), ...field(9, [...raw])];
}
function floatToHalf(v: number): number {
  const f = new Float32Array([v]);
  const i = new Uint32Array(f.buffer)[0]!;
  const s = (i >>> 16) & 0x8000;
  const e = ((i >>> 23) & 0xff) - 127 + 15;
  const m = (i >>> 13) & 0x3ff;
  if (e <= 0) return s;
  return s | (e << 10) | m;
}

describe("gallery search", () => {
  it("scores a subset as the search graph does", () => {
    const D = 4;
    const rows = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0.5, 0.5, 0, 0],
    ];
    const gallery = new Uint16Array(rows.flat().map(floatToHalf));
    const frames = new BigInt64Array([0n, 1n, 0n]);
    const penalties = new Float32Array([0, 0.1, 0.05]);
    const graph = [
      ...field(7, [
        ...field(5, tensor("gallery", [3, D], 10, new Uint8Array(gallery.buffer))),
        ...field(5, tensor("frames", [3, 1], 7, new Uint8Array(frames.buffer))),
        ...field(5, tensor("penalties", [3], 1, new Uint8Array(penalties.buffer))),
      ]),
    ];
    const g = readGallery(new Uint8Array(graph));
    expect(g.count).toBe(3);
    expect(g.dim).toBe(D);
    // Two frame types: frame 0's vector, then frame 1's.
    const emb = new Float32Array([0.8, 0.6, 0, 0, 0, 1, 0, 0]);
    const all = g.search(emb, [0, 1, 2], 5);
    expect(all.map((m) => m.index)).toEqual([1, 0, 2]);
    expect(all[0]!.score).toBeCloseTo(0.9, 3);
    expect(all[1]!.score).toBeCloseTo(0.8, 3);
    expect(all[2]!.score).toBeCloseTo(0.65, 3);
    expect(g.search(emb, [0, 2], 1).map((m) => m.index)).toEqual([0]);
    expect(halfToFloat(floatToHalf(0.5))).toBe(0.5);
  });

  it("reads packed dims too", () => {
    const gallery = new Uint16Array([floatToHalf(1), floatToHalf(0)]);
    const packed = (name: string, dims: number[], dataType: number, raw: Uint8Array) => [...field(1, dims.flatMap(varint)), ...num(2, dataType), ...field(8, [...new TextEncoder().encode(name)]), ...field(9, [...raw])];
    const graph = field(7, [
      ...field(5, packed("gallery", [1, 2], 10, new Uint8Array(gallery.buffer))),
      ...field(5, packed("frames", [1, 1], 7, new Uint8Array(new BigInt64Array([0n]).buffer))),
      ...field(5, packed("penalties", [1], 1, new Uint8Array(new Float32Array([0]).buffer))),
    ]);
    const g = readGallery(new Uint8Array(graph));
    expect([g.count, g.dim]).toEqual([1, 2]);
    expect(g.search(new Float32Array([0.5, 0]), [0], 1)[0]!.score).toBeCloseTo(0.5, 5);
  });

  it("refuses a graph without the gallery", () => {
    expect(() => readGallery(new Uint8Array(field(7, [])))).toThrow();
  });
});

describe("zoomSteps", () => {
  it("steps from a pinched zoom between levels, up to the camera's top end", () => {
    const cam = { torch: false, zoom: { min: 1, max: 8 } };
    expect(zoomSteps(cam, 5)).toEqual({ above: 8, below: 4 });
    expect(zoomSteps(cam, 8)).toEqual({ above: undefined, below: 4 });
    expect(zoomSteps(cam, 1)).toEqual({ above: 1.5, below: undefined });
  });

  it("goes to the digital limit from just under it", () => {
    const digital = { torch: false, zoom: null };
    expect(zoomSteps(digital, 2.8)).toEqual({ above: 3, below: 2 });
    expect(zoomSteps(digital, 3).above).toBeUndefined();
  });
});
