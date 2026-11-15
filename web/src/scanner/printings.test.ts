// The printing a scan files: settled only when the art or the collector line settles it.

import { describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import { choosePrinting } from "./printings";
import { createRecognizer, parseArts, sampleWindow, type OrtLike } from "./recognizer";

const p = (set: string, number: string, lang = "en"): Printing => ({
  scryfall_id: `${set}-${number}-${lang}`,
  oracle_id: "o",
  name: "Arcane Signet",
  set_code: set,
  set_name: set.toUpperCase(),
  collector_number: number,
  lang,
  rarity: "common",
  finishes: ["nonfoil"],
  released_at: null,
  image_normal: null,
  image_small: null,
  back_image_normal: null,
  artist: null,
  price_date: null,
  usd: null,
  usd_foil: null,
  usd_etched: null,
  eur: null,
  eur_foil: null,
});

// Commander precons reprint Arcane Signet with the same art: the art alone can't tell them apart.
const signets = [p("woc", "145"), p("c21", "234"), p("moc", "348"), p("cmr", "297"), p("cmr", "689")];

describe("choosePrinting", () => {
  it("files the only printing with the art", () => {
    const c = choosePrinting({ sameArt: true, printings: [p("ecc", "57")] });
    expect(c.chosen?.set_code).toBe("ecc");
    expect(c.how).toBe("only");
  });
  it("files a card's only printing even without art data", () => {
    const c = choosePrinting({ sameArt: false, printings: [p("fic", "9")] });
    expect(c.chosen?.set_code).toBe("fic");
    expect(c.how).toBe("only");
  });
  it("prefers English when other languages share the art", () => {
    const c = choosePrinting({ sameArt: true, printings: [p("ecc", "57", "ja"), p("ecc", "57")] });
    expect(c.chosen?.lang).toBe("en");
  });
  it("never guesses among printings that share the art", () => {
    const c = choosePrinting({ sameArt: true, printings: signets });
    expect(c.chosen).toBeNull();
    expect(c.options).toHaveLength(5);
  });
  it("lets the collector line pick, even with a misread number", () => {
    // What Tesseract read off a simulated off-centre photo of WOC 145.
    const c = choosePrinting({ sameArt: true, printings: signets }, "A ON I\nCC 0149\nWOC + EN D S");
    expect(c.chosen?.set_code).toBe("woc");
    expect(c.how).toBe("collector");
    // WOC read exactly and it has one printing of this art: proof enough.
    expect(c.certain).toBe(true);
  });
  it("treats a number alone or a repaired set code as a guess, not proof", () => {
    const byNumber = choosePrinting({ sameArt: true, printings: signets }, "234");
    expect(byNumber.chosen?.set_code).toBe("c21");
    expect(byNumber.certain).toBe(false);
    // "C2I" is repaired to c21: a guess among art siblings, nothing at all among every printing.
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0234\nC2I + EN").certain).toBe(false);
    expect(choosePrinting({ sameArt: false, printings: signets }, "C 0234\nC2I + EN").chosen).toBeNull();
  });
  it("needs the number when one set has two printings of the art", () => {
    expect(choosePrinting({ sameArt: true, printings: signets }, "CMR + EN").chosen).toBeNull();
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0689\nCMR + EN").chosen?.collector_number).toBe("689");
  });
  it("needs the number when the set has two printings of the art", () => {
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0689\nCMR + EN").certain).toBe(true);
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0688\nCMR + EN").certain).toBeFalsy();
  });
  it("puts what was read first when it can't settle it", () => {
    const c = choosePrinting({ sameArt: true, printings: signets }, "CMR + EN");
    expect(c.options.slice(0, 2).map((x) => x.set_code)).toEqual(["cmr", "cmr"]);
  });
  it("among all of a card's printings, takes only an exactly read set code", () => {
    const all = { sameArt: false, printings: signets };
    expect(choosePrinting(all, "234/2").chosen).toBeNull();
    expect(choosePrinting(all, "C 0234\nC21 + EN").chosen?.set_code).toBe("c21");
  });
});

describe("parseArts", () => {
  it("reads the server's columns and rows in gallery order", () => {
    const arts = parseArts({ columns: ["id", "name", "set", "number", "illustration_id", "layout", "printings"], rows: [["a", "Sol Ring", "ecc", "57", "i1", "normal", 3], ["b-1", "Back", "mid", "", null, "transform", 1]] });
    expect(arts[0]).toEqual({ id: "a", name: "Sol Ring", set: "ecc", number: "57", illustrationId: "i1", layout: "normal", printings: 3 });
    expect(arts[1]!.illustrationId).toBeNull();
  });
  it("reads the bundle's own arts.json", () => {
    expect(parseArts([{ id: "a", name: "X", set: "s", collector_number: "1", illustration_id: "i", layout: "normal", printing_count: 2, url: "u" }])[0]!.number).toBe("1");
  });
});

describe("sampleWindow", () => {
  it("maps the window centre to the given point and repeats edges", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) data.set([i * 10, 0, 0, 255], i * 4);
    const out = sampleWindow({ width: 4, height: 4, data }, { cx: 1, cy: 1, side: 4 }, 4);
    // Window pixel (2, 2) is frame pixel (1, 1); window (0, 0) is frame (-1, -1), clamped to (0, 0).
    expect(out[(2 * 4 + 2) * 4]).toBe(50);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(255);
  });
});

describe("createRecognizer's search graph", () => {
  // A stand-in ONNX Runtime: the detector sees nothing, and the search graph records what it's fed.
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: Uint8Array | Float32Array,
      readonly dims: readonly number[],
    ) {}
  }
  const fake = (searchInputs: string[]) => {
    const fed: Record<string, unknown>[] = [];
    const ort: OrtLike = {
      Tensor: Tensor as unknown as OrtLike["Tensor"],
      InferenceSession: {
        async create(model) {
          const kind = model[0];
          return {
            inputNames: kind === 3 ? searchInputs : ["x"],
            async run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> {
              if (kind === 1) return { quad: { data: new Float32Array(8) }, up: { data: new Float32Array(2) }, centre: { data: new Float32Array(2) }, short: { data: new Float32Array(1) } };
              if (kind === 2) return { embeddings: { data: new Float32Array(17 * 4) } };
              fed.push(feeds);
              return { indices: { data: BigInt64Array.from([1n, 0n]) }, scores: { data: Float32Array.from([0.9, -3]) } };
            },
          };
        },
      },
    };
    return { ort, fed };
  };
  const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
  const arts = parseArts([
    { id: "a", name: "Gorn Captain", set: "trc", collector_number: "172" },
    { id: "b", name: "Talarian Hook Spider", set: "trc", collector_number: "175" },
    { id: "c", name: "Island", set: "trk", collector_number: "319" },
  ]);
  const graphs = { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) };

  it("feeds a mask of ones, one per artwork, when the graph takes one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // the stand-in graph has no gallery to read
    const { ort, fed } = fake(["embeddings", "mask"]);
    await createRecognizer(ort, graphs, constants, arts);
    expect(fed.length).toBeGreaterThan(0);
    const mask = fed[0]!.mask as Tensor;
    expect(mask.type).toBe("float32");
    expect(mask.dims).toEqual([3]);
    expect(Array.from(mask.data)).toEqual([1, 1, 1]);
    vi.restoreAllMocks();
  });

  it("feeds only the embeddings to an older graph", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ort, fed } = fake(["embeddings"]);
    await createRecognizer(ort, graphs, constants, arts);
    expect(Object.keys(fed[0]!)).toEqual(["embeddings"]);
    vi.restoreAllMocks();
  });
});
