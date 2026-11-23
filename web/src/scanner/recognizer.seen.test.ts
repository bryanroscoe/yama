import { beforeEach, describe, expect, it, vi } from "vitest";
import { drawBack, drawFront } from "./eval/syntheticCards";
import { createRecognizer, parseArts, type OrtLike } from "./recognizer";
import type { Quad, RgbaImage } from "./types";
import { GLARE_ART } from "./glare";

// The recognizer says where the card finder placed the card before the art is matched, for the
// outline (outline.ts), and whether the card in view is face down (cardBack.ts).

const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
const arts = parseArts([{ id: "a", name: "Sol Ring", set: "ecc", collector_number: "57", illustration_id: "ill-a" }]);

class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

/** A stand-in ONNX Runtime: the finder places a card (or votes for none), and every step is logged in order. */
function fakeOrt(log: string[], vote = 4) {
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model[0];
        return {
          inputNames: kind === 1 ? ["window"] : kind === 2 ? ["scene", "quad"] : ["embeddings"],
          async run(): Promise<Record<string, { data: unknown }>> {
            if (kind === 1) {
              log.push("detect");
              return { quad: { data: Float32Array.from([78, 58, 178, 58, 178, 198, 78, 198]) }, up: { data: Float32Array.from([vote, 0]) }, centre: { data: Float32Array.from([128, 128]) }, short: { data: Float32Array.from([100]) } };
            }
            if (kind === 2) {
              log.push("embed");
              return { embeddings: new Tensor("float32", new Float32Array(4), [1, 4]) };
            }
            log.push("search");
            return { indices: { data: BigInt64Array.from([0n]) }, scores: { data: Float32Array.from([0.4]) } };
          },
        };
      },
    },
  };
  return ort;
}
// The search graph here can't be read for the set lock, which the recognizer only warns about.
beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));
const graphs = { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) };

/**
 * A 640 px grey frame with `card` drawn where the stand-in finder places it: its second pass looks
 * at a 582 px window, so the quad it gives is 227 × 318 px from (206, 161).
 */
const AT = { x: 206, y: 161, w: 228, h: 319 };
function frameWith(card: RgbaImage | null): RgbaImage {
  const data = new Uint8ClampedArray(640 * 640 * 4).fill(110);
  if (card) for (let y = 0; y < card.height; y += 1) data.set(card.data.subarray(y * card.width * 4, (y + 1) * card.width * 4), ((y + AT.y) * 640 + AT.x) * 4);
  return { width: 640, height: 640, data };
}

describe("where the finder placed the card", () => {
  it("is said before the art is matched, and is the quad the result carries", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log), graphs, constants, arts);
    log.length = 0;
    let seen: Quad | null | undefined;
    const result = await r.identify(frameWith(drawFront({ frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [220, 230, 240]] }, AT.w, AT.h)), (q) => {
      log.push("seen");
      seen = q;
    });
    expect(log.indexOf("seen")).toBeGreaterThan(log.lastIndexOf("detect"));
    expect(log.indexOf("seen")).toBeLessThan(log.indexOf("embed"));
    expect(seen).toEqual(result.quad);
    expect(result.quad?.[0]?.[0]).toBeCloseTo(206.3, 1);
    expect(result.quad?.[0]?.[1]).toBeCloseTo(160.9, 1);
    expect(result.back).toBeUndefined();
    // Under the glare line on this art (glare.ts), measured here: the page can't read the frame after the call.
    expect(result.glare).toBeLessThan(GLARE_ART);
  });

  it("measures the glare on the card's art, on the frame it read", async () => {
    const r = await createRecognizer(fakeOrt([]), graphs, constants, arts);
    const result = await r.identify(frameWith(drawFront({ frame: [40, 110, 170], box: [200, 220, 235], art: [[255, 255, 255], [252, 252, 252]] }, AT.w, AT.h)));
    expect(result.glare).toBeGreaterThan(0.5);
    const none = await r.identify(frameWith(null));
    expect(none.glare).toBeUndefined();
  });

  it("is said as nothing when no card is in view", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log, 0.2), graphs, constants, arts);
    const seen: (Quad | null)[] = [];
    const result = await r.identify(frameWith(null), (q) => seen.push(q));
    expect(seen).toEqual([null]);
    expect(result.quad).toBeNull();
  });
});

describe("a card lying face down", () => {
  it("is marked as a back, and still matched", async () => {
    const r = await createRecognizer(fakeOrt([]), graphs, constants, arts);
    const result = await r.identify(frameWith(drawBack(AT.w, AT.h, { noise: 4 })));
    expect(result.back).toBe(true);
    expect(result.matches[0]?.name).toBe("Sol Ring");
  });
});

describe("the card finder alone, for the placement gate", () => {
  it("places the card, measures its sharpness and thumbnail, and matches nothing", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log), graphs, constants, arts);
    log.length = 0;
    const front = frameWith(drawFront({ frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [220, 230, 240]] }, AT.w, AT.h));
    const seen = await r.locate(front);
    expect(new Set(log)).toEqual(new Set(["detect"]));
    expect(seen.quad?.[0]?.[0]).toBeCloseTo(206.3, 1);
    expect(seen.sharpness).toBeGreaterThan(0);
    expect(seen.thumb).toHaveLength(48 * 48);
    expect(seen.back).toBeUndefined();
    // A back is said to be one, and an empty view has neither sharpness nor thumbnail.
    expect((await r.locate(frameWith(drawBack(AT.w, AT.h, { noise: 4 })))).back).toBe(true);
    const none = await createRecognizer(fakeOrt([], 0.2), graphs, constants, arts);
    expect(await none.locate(frameWith(null))).toMatchObject({ quad: null });
    expect((await none.locate(frameWith(null))).thumb).toBeUndefined();
  });

  it("then matches the art at the corners it gave, without running the finder again", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log), graphs, constants, arts);
    const front = frameWith(drawFront({ frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [220, 230, 240]] }, AT.w, AT.h));
    const seen = await r.locate(front);
    log.length = 0;
    const result = await r.identify(front, undefined, seen.quad);
    expect(log).toEqual(["embed", "search"]);
    expect(result.quad).toEqual(seen.quad);
    expect(result.matches[0]?.name).toBe("Sol Ring");
  });
});
