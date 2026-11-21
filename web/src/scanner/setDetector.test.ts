import { describe, expect, it } from "vitest";
import { createRecognizer, parseArts, type OrtLike } from "./recognizer";
import type { RgbaImage } from "./types";

// Another card finder (models.ts, the detector slot) swapped into a running recognizer.

class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array,
    readonly dims: readonly number[],
  ) {}
}

/** Detector graphs by their first byte: 1 finds a card on the left, 4 on the right, 5 answers NaN. */
function fakeOrt() {
  const ran: number[] = [];
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model[0]!;
        return {
          inputNames: kind === 3 ? ["embeddings"] : ["x"],
          async run(): Promise<Record<string, { data: unknown }>> {
            if (kind === 1 || kind === 4 || kind === 5) {
              ran.push(kind);
              const x = kind === 4 ? 60 : 0;
              return {
                quad: { data: Float32Array.from([68 + x, 44, 188 + x, 44, 188 + x, 212, 68 + x, 212].map((v) => (kind === 5 ? NaN : v))) },
                up: { data: Float32Array.from([4, 0]) },
                centre: { data: Float32Array.from([128 + x, 128]) },
                short: { data: Float32Array.from([120]) },
              };
            }
            if (kind === 2) return { embeddings: { data: new Float32Array(17 * 4) } };
            return { indices: { data: BigInt64Array.from([0n]) }, scores: { data: Float32Array.from([0.9]) } };
          },
        };
      },
    },
  };
  return { ort, ran };
}

function frame(): RgbaImage {
  const data = new Uint8ClampedArray(640 * 640 * 4);
  for (let y = 0; y < 640; y += 1)
    for (let x = 0; x < 640; x += 1) {
      const v = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 230 : 20;
      data.set([v, v, v, 255], (y * 640 + x) * 4);
    }
  return { width: 640, height: 640, data };
}

const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
const arts = parseArts([{ id: "a", name: "Sol Ring", set: "ecc", collector_number: "57", illustration_id: "ill-a" }]);
const graphs = { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) };

describe("setDetector", () => {
  it("finds cards with the new card finder from the next frame", async () => {
    const { ort, ran } = fakeOrt();
    const r = await createRecognizer(ort, graphs, constants, arts);
    const before = (await r.identify(frame())).quad!;
    await r.setDetector(Uint8Array.of(4));
    ran.length = 0;
    const after = (await r.identify(frame())).quad!;
    expect(ran.every((k) => k === 4)).toBe(true);
    expect(after[0]![0]).toBeGreaterThan(before[0]![0]);
  });

  it("refuses one whose outputs aren't the bundle detector's, and keeps the one before", async () => {
    const { ort, ran } = fakeOrt();
    const r = await createRecognizer(ort, graphs, constants, arts);
    await expect(r.setDetector(Uint8Array.of(5))).rejects.toThrow(/outputs/);
    ran.length = 0;
    expect((await r.identify(frame())).quad).not.toBeNull();
    expect(ran.every((k) => k === 1)).toBe(true);
  });
});
