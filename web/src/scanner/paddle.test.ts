import { describe, expect, it, vi } from "vitest";
import { withFallback, type OwnedOcr } from "./ocrEngine";
import { allowedClasses, boxesFromMap, boxTensor, classesFromDict, ctcDecode, detTensor, findLines, groupLines, joinLines, mergeLine, REC_HEIGHT, type TextBox } from "./paddle";
import type { Gray } from "./types";

const classes = classesFromDict("A\nB\nC\n0\n1\n•\n");

/** Per-step probabilities: each step puts `p` on one class and spreads the rest over the others. */
function steps(picks: [number, number][]): Float32Array {
  const n = classes.length;
  const out = new Float32Array(picks.length * n);
  picks.forEach(([c, p], s) => {
    for (let k = 0; k < n; k += 1) out[s * n + k] = (1 - p) / (n - 1);
    out[s * n + c] = p;
  });
  return out;
}

describe("classesFromDict", () => {
  it("puts the CTC blank first and a space last", () => {
    expect(classes).toEqual(["", "A", "B", "C", "0", "1", "•", " "]);
  });
});

describe("ctcDecode", () => {
  it("collapses repeats, drops blanks, and keeps a letter repeated across a blank", () => {
    // A A _ B _ B C
    const p = steps([
      [1, 0.9],
      [1, 0.9],
      [0, 0.9],
      [2, 0.8],
      [0, 0.9],
      [2, 0.8],
      [3, 0.6],
    ]);
    const r = ctcDecode(p, 7, classes);
    expect(r.text).toBe("ABBC");
    expect(r.confidence).toBeCloseTo((0.9 + 0.8 + 0.8 + 0.6) / 4, 5);
  });

  it("lets only whitelisted classes win a step", () => {
    // The model prefers "A" then "1", but only digits are allowed: the runner-up digit wins.
    const n = classes.length;
    const p = new Float32Array(2 * n);
    p[1] = 0.7; // A
    p[4] = 0.2; // 0
    p[n + 5] = 0.9; // 1
    const r = ctcDecode(p, 2, classes, allowedClasses(classes, "0123456789"));
    expect(r.text).toBe("01");
  });

  it("reads nothing as empty with zero confidence, and squeezes spaces", () => {
    expect(ctcDecode(steps([[0, 0.99]]), 1, classes)).toEqual({ text: "", confidence: 0 });
    const sp = classes.length - 1;
    expect(ctcDecode(steps([[1, 0.9], [sp, 0.9], [0, 0.9], [sp, 0.9], [2, 0.9]]), 5, classes).text).toBe("A B");
  });
});

describe("joinLines", () => {
  it("joins lines with newlines and weights confidence by length, on 0..100", () => {
    expect(joinLines([{ text: "C 0214", confidence: 0.9 }, { text: "", confidence: 0 }, { text: "MOM", confidence: 0.6 }])).toEqual({ text: "C 0214\nMOM", confidence: 80 });
    expect(joinLines([])).toEqual({ text: "", confidence: 0 });
  });
});

/** A white image with dark bars (rows y0..y1, columns x0..x1), like two lines of print. */
function bars(width: number, height: number, rects: [number, number, number, number][]): Gray {
  const data = new Uint8ClampedArray(width * height).fill(240);
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if ((x >> 2) % 2 === 0) data[y * width + x] = 20;
  return { width, height, data };
}

describe("findLines", () => {
  it("finds two text lines top to bottom and ignores a solid rule and specks", () => {
    const g = bars(200, 100, [
      [10, 20, 120, 34],
      [10, 50, 180, 64],
      [150, 90, 152, 92],
    ]);
    // A solid frame line across the whole width.
    for (let x = 0; x < 200; x += 1) g.data[5 * 200 + x] = 0;
    const lines = findLines(g);
    expect(lines.map((l) => [l.top, l.bottom])).toEqual([
      [20, 34],
      [50, 64],
    ]);
  });

  it("finds nothing in a blank crop", () => {
    expect(findLines(bars(50, 20, []))).toEqual([]);
  });
});

describe("detector boxes", () => {
  /** A probability map with a slightly turned bar of text. */
  function tiltedBar(w: number, h: number, cx: number, cy: number, len: number, thick: number, angle: number, p = 0.9) {
    const map = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = dx * Math.cos(angle) + dy * Math.sin(angle);
        const v = -dx * Math.sin(angle) + dy * Math.cos(angle);
        if (Math.abs(u) <= len / 2 && Math.abs(v) <= thick / 2) map[y * w + x] = p;
      }
    return map;
  }

  it("follows a turned line and grows it by the unclip distance", () => {
    const angle = (3 * Math.PI) / 180;
    const [box] = boxesFromMap(tiltedBar(320, 96, 160, 48, 200, 12, angle), 320, 96, 1, 1);
    expect(box).toBeDefined();
    expect(box!.angle).toBeCloseTo(angle, 1);
    expect(box!.cx).toBeCloseTo(160, 0);
    expect(box!.cy).toBeCloseTo(48, 0);
    // Half height about 6, plus unclip 200*12*1.5/(2*212) ≈ 8.5.
    expect(box!.halfH).toBeGreaterThan(12);
    expect(box!.halfH).toBeLessThan(17);
    expect(box!.halfW).toBeGreaterThan(105);
  });

  it("drops faint regions and scales back to the crop", () => {
    expect(boxesFromMap(tiltedBar(64, 32, 32, 16, 40, 8, 0, 0.5), 64, 32, 1, 1)).toEqual([]);
    const [box] = boxesFromMap(tiltedBar(64, 32, 32, 16, 40, 8, 0), 64, 32, 2, 3);
    expect(box!.cx).toBeCloseTo(64, 0);
    expect(box!.cy).toBeCloseTo(48, 0);
  });

  it("merges a line's boxes into one box along the line", () => {
    const angle = 0.05;
    const at = (u: number): TextBox => ({ cx: 100 + u * Math.cos(angle), cy: 50 + u * Math.sin(angle), angle, halfW: 20, halfH: 8, score: 0.8 });
    const m = mergeLine([at(0), at(100)]);
    expect(m.angle).toBeCloseTo(angle, 5);
    expect(m.halfW).toBeCloseTo(70, 5);
    expect(m.halfH).toBeCloseTo(8, 5);
    expect(m.cx).toBeCloseTo(100 + 50 * Math.cos(angle), 5);
    expect(m.cy).toBeCloseTo(50 + 50 * Math.sin(angle), 5);
    expect(mergeLine([at(0)])).toEqual(at(0));
  });

  it("groups boxes into lines, each left to right", () => {
    const b = (cx: number, cy: number): TextBox => ({ cx, cy, angle: 0, halfW: 20, halfH: 8, score: 0.9 });
    const lines = groupLines([b(150, 41), b(30, 10), b(40, 40), b(100, 12)]);
    expect(lines.map((l) => l.map((x) => x.cx))).toEqual([
      [30, 100],
      [40, 150],
    ]);
  });
});

describe("tensors", () => {
  it("makes a recogniser input 48 high, as wide as the box's shape, in [-1, 1]", () => {
    const g = bars(200, 60, [[20, 20, 180, 40]]);
    const t = boxTensor(g, { cx: 100, cy: 30, angle: 0, halfW: 90, halfH: 15, score: 1 });
    expect(t.width).toBe(288);
    expect(t.data.length).toBe(3 * REC_HEIGHT * 288);
    expect(Math.min(...t.data)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...t.data)).toBeLessThanOrEqual(1);
  });

  it("sizes the detector input to multiples of 32", () => {
    const t = detTensor(bars(831, 216, []));
    expect([t.width, t.height]).toEqual([832, 224]);
    expect(t.data.length).toBe(3 * 832 * 224);
  });
});

describe("withFallback", () => {
  const engine = (read: OwnedOcr["read"]): OwnedOcr => ({ read, terminate: vi.fn(async () => undefined) });
  const img: Gray = { width: 1, height: 1, data: new Uint8ClampedArray(1) };

  it("switches to the fallback for good after a failed read", async () => {
    const primary = engine(vi.fn().mockResolvedValueOnce({ text: "a", confidence: 90 }).mockRejectedValue(new Error("worker died")));
    const backup = engine(vi.fn(async () => ({ text: "b", confidence: 50 })));
    const make = vi.fn(async () => backup);
    const ocr = withFallback(primary, make);
    expect((await ocr.read(img, { mode: "line" })).text).toBe("a");
    expect((await ocr.read(img, { mode: "line" })).text).toBe("b");
    expect((await ocr.read(img, { mode: "line" })).text).toBe("b");
    expect(make).toHaveBeenCalledTimes(1);
    expect(primary.read).toHaveBeenCalledTimes(2);
    await ocr.terminate();
    expect(primary.terminate).toHaveBeenCalled();
    expect(backup.terminate).toHaveBeenCalled();
  });
});
