// Fast, offline tests for the scanner's pure parts. The accuracy eval on simulated photos lives
// in eval/ and only runs with SCANNER_EVAL=1.

import { describe, expect, it } from "vitest";
import { fittingDistance, NameIndex } from "./fuzzy";
import { applyH, cropToTextBand, prepareText, rectQuad, squareToQuad, warpRegion } from "./image";
import { refineQuad } from "./locate";
import { parseCollector, setVariants } from "./parse";
import { decide } from "./pipeline";
import { pickPrinting } from "./pick";
import type { CatalogPrinting, Gray, Quad, ScanCatalog } from "./types";

const SETS = new Set(["mom", "m19", "m15", "dmu", "blb", "sta", "ecc", "rtr", "mkm"]);
const hasSet = (c: string) => SETS.has(c);

describe("parseCollector", () => {
  // Strings below are what Tesseract actually returned on the eval's simulated captures.
  it("reads the 2023+ layout", () => {
    const r = parseCollector("C 0214\nMOM + EN RYAN VALLE", hasSet);
    expect(r.sets[0]).toBe("mom");
    expect(r.numbers[0]).toBe("214");
    expect(r.anchored).toBe(true);
    expect(r.strongNumbers).toContain("214");
  });
  it("reads the 2015-2022 layout with a set total", () => {
    const r = parseCollector("030/280 U\nM19 + EN  YONGIAE CHOI", hasSet);
    expect(r.sets[0]).toBe("m19");
    expect(r.numbers[0]).toBe("30");
  });
  it("ignores junk lines and the bullet read as nothing", () => {
    const r = parseCollector("RS CE\nC 0214\nMOM EN RYAN VALLE", hasSet);
    expect(r.sets).toEqual(["mom"]);
    expect(r.numbers[0]).toBe("214");
  });
  it("fixes lookalike characters in the set code", () => {
    expect(parseCollector("R 0241\nM0M + EN", hasSet).sets).toContain("mom");
    expect(setVariants("M0M")).toContain("mom");
  });
  it("does not take numbers from the artist line", () => {
    const r = parseCollector("MKM EN 5 LIE SEAA 3", hasSet);
    expect(r.strongNumbers).toEqual([]);
  });
  it("skips copyright years and keeps 2003-era numbers", () => {
    const r = parseCollector("2012 WZ CS 59/274", hasSet);
    expect(r.sets).toEqual([]);
    expect(r.numbers).toEqual(["59"]);
  });
});

describe("names", () => {
  const index = new NameIndex(["War Historian", "Novice Knight", "Sheoldred, the Apocalypse", "Sol Ring", "Opt", "Invasion of Tolvada", "Charge"]);
  it("matches OCR'd titles with junk around them", () => {
    expect(index.match("[Var Historian")[0]?.name).toBe("War Historian");
    expect(index.match("( Novice Knight")[0]?.name).toBe("Novice Knight");
    expect(index.match("Sheoldred, the Apocalypse ©")[0]?.score).toBeGreaterThan(0.9);
  });
  it("does not let a short name win inside long garbage", () => {
    const m = index.match("ATTNOTCAMECOASISRAEE Si")[0];
    expect(m?.score ?? 0).toBeLessThan(0.6);
  });
  it("fitting distance ignores text around the needle", () => {
    expect(fittingDistance("sol ring", "xx sol ring yy")).toBe(0);
  });
});

describe("decide", () => {
  const printings: CatalogPrinting[] = [
    { name: "War Historian", set: "mom", number: "214", lang: "en" },
    { name: "Novice Knight", set: "m19", number: "30", lang: "en" },
    { name: "Avacyn, Guardian Angel", set: "m15", number: "30", lang: "en" },
    { name: "Cremate", set: "rtr", number: "59", lang: "en" },
    { name: "Cremate", set: "dst", number: "21", lang: "en" },
  ];
  const catalog: ScanCatalog = {
    hasSet,
    lookup: async (set, number) => printings.find((p) => p.set === set && p.number === number) ?? null,
    names: () => [...new Set(printings.map((p) => p.name))],
    printingsOf: async (name) => printings.filter((p) => p.name === name),
  };
  const names = new NameIndex(catalog.names());

  it("is sure when number and title agree", async () => {
    const [c] = await decide("C 0214\nMOM + EN", "War Historian", { catalog, names });
    expect(c).toMatchObject({ name: "War Historian", set: "mom", number: "214", method: "collector+name" });
    expect(c!.confidence).toBeGreaterThan(0.9);
  });
  it("uses the title and number when the set code was misread", async () => {
    // "MIS" is read as M15, which has a #30 but it's a different card.
    const [c] = await decide("030/280 U\nMIS EN YONGE CHOON", "(Novice Knight ~~", { catalog, names });
    expect(c).toMatchObject({ name: "Novice Knight", set: "m19", number: "30" });
  });
  it("finds a 2003-era printing from the title and number", async () => {
    const [c] = await decide("2012 WZ CS 59/274", "Cremate", { catalog, names });
    expect(c).toMatchObject({ name: "Cremate", set: "rtr" });
  });
  it("is not sure about a lone collector read with a weak number", async () => {
    const [c] = await decide("MOM EN 214 RYAN", "", { catalog, names });
    expect(c?.confidence ?? 0).toBeLessThan(0.8);
  });
});

describe("pickPrinting", () => {
  const forest = ["blb", "fdn", "znr"].map((set) => ({ name: "Forest", set, number: "280", lang: "en" }));
  it("refuses to guess between sets sharing a number", () => {
    expect(pickPrinting(forest, [], ["280"], [])).toBeNull();
  });
  it("accepts a set code one character off", () => {
    expect(pickPrinting(forest, [], ["280"], ["ble"])?.printing.set).toBe("blb");
  });
});

describe("geometry", () => {
  it("maps the unit square onto a quad", () => {
    const q: Quad = [
      [10, 20],
      [110, 25],
      [120, 160],
      [5, 150],
    ];
    const h = squareToQuad(q);
    for (const [i, [u, v]] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].entries()) {
      const [x, y] = applyH(h, u!, v!);
      expect(x).toBeCloseTo(q[i]![0], 6);
      expect(y).toBeCloseTo(q[i]![1], 6);
    }
  });

  // A light card with a dark border, rotated a little, on a mid-grey table.
  function scene(angle: number): { g: Gray; truth: Quad; guide: Quad } {
    const W = 400;
    const H = 520;
    const data = new Uint8ClampedArray(W * H).fill(120);
    const cw = 252;
    const ch = 352;
    const cx = W / 2 + 6;
    const cy = H / 2 - 5;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = dx * cos + dy * sin;
        const v = -dx * sin + dy * cos;
        if (Math.abs(u) <= cw / 2 && Math.abs(v) <= ch / 2) {
          const border = Math.abs(u) > cw / 2 - 10 || Math.abs(v) > ch / 2 - 10;
          data[y * W + x] = border ? 20 : 220;
        }
      }
    }
    const corner = (u: number, v: number): [number, number] => [cx + u * cos - v * sin, cy + u * sin + v * cos];
    const truth: Quad = [corner(-cw / 2, -ch / 2), corner(cw / 2, -ch / 2), corner(cw / 2, ch / 2), corner(-cw / 2, ch / 2)];
    const guide = rectQuad(W / 2 - 126, H / 2 - 176, 252, 352);
    return { g: { width: W, height: H, data }, truth, guide };
  }

  it("snaps the guide to a slightly rotated card", () => {
    const { g, truth, guide } = scene((3 * Math.PI) / 180);
    const q = refineQuad(g, guide);
    expect(q).not.toBeNull();
    for (let i = 0; i < 4; i += 1) {
      expect(Math.hypot(q![i]![0] - truth[i]![0], q![i]![1] - truth[i]![1])).toBeLessThan(3);
    }
  });

  it("finds the text band in a title crop", () => {
    const { g, truth } = scene(0);
    const crop = prepareText(warpRegion(g, truth, { x0: 0, y0: 0, x1: 1, y1: 0.2 }, 200, 70), 0);
    expect(cropToTextBand(crop).height).toBeLessThanOrEqual(crop.height);
  });
});
