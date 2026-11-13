import { describe, expect, it } from "vitest";
import { combineLines, greyToBase64 } from "./mlkit";
import { parseCollector } from "./parse";

describe("combineLines", () => {
  it("puts lines in reading order and joins a block with newlines", () => {
    const r = combineLines(
      [
        { text: "MOM • EN", confidence: 0.8, left: 0, top: 30, right: 80, bottom: 50 },
        { text: "R 0214", confidence: 0.9, left: 0, top: 0, right: 60, bottom: 20 },
      ],
      { mode: "block" },
    );
    expect(r.text).toBe("R 0214\nMOM • EN");
    expect(r.confidence).toBeGreaterThan(80);
    expect(r.confidence).toBeLessThan(90);
  });

  it("orders pieces of one row left to right and joins a line with spaces", () => {
    const r = combineLines(
      [
        { text: "Signet", confidence: 1, left: 60, top: 2, right: 120, bottom: 22 },
        { text: "Arcane", confidence: 1, left: 0, top: 0, right: 55, bottom: 20 },
      ],
      { mode: "line" },
    );
    expect(r).toEqual({ text: "Arcane Signet", confidence: 100 });
  });

  it("drops characters outside the whitelist, as Tesseract's would", () => {
    const r = combineLines([{ text: "R  0214*", confidence: 0.5 }], { mode: "line", whitelist: "0123456789R" });
    expect(r.text).toBe("R 0214");
  });

  it("raises lower case for a capitals-only whitelist, and the collector line still parses", () => {
    const r = combineLines(
      [
        { text: "c 0145", confidence: 0.7, left: 0, top: 0, right: 60, bottom: 20 },
        { text: "WOC•EN DAN ScoTT", confidence: 0.7, left: 0, top: 40, right: 160, bottom: 60 },
      ],
      { mode: "block", whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•*-+ " },
    );
    expect(r.text).toBe("C 0145\nWOC•EN DAN SCOTT");
    expect(parseCollector(r.text, (code) => code === "woc")).toMatchObject({ sets: ["woc"], numbers: expect.arrayContaining(["145"]) });
  });

  it("keeps pieces of one printed row on one line, so the set keeps its language", () => {
    const r = combineLines(
      [
        { text: "DE", confidence: 0.9, left: 50, top: 31, right: 70, bottom: 50 },
        { text: "R 0214", confidence: 0.9, left: 0, top: 0, right: 60, bottom: 20 },
        { text: "MOM •", confidence: 0.9, left: 0, top: 30, right: 45, bottom: 50 },
      ],
      { mode: "block", whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•*-+ " },
    );
    expect(r.text).toBe("R 0214\nMOM • DE");
    expect(parseCollector(r.text, (code) => code === "mom")).toMatchObject({ sets: ["mom"], lang: "de", anchored: true });
  });

  it("reads nothing as empty with no confidence", () => {
    expect(combineLines([], { mode: "line" })).toEqual({ text: "", confidence: 0 });
  });
});

describe("greyToBase64", () => {
  it("encodes the bytes as they are, including large images", () => {
    const data = new Uint8ClampedArray(100_000).map((_, i) => i % 256);
    const decoded = atob(greyToBase64({ width: 1000, height: 100, data }));
    expect(decoded.length).toBe(data.length);
    expect(decoded.charCodeAt(99_999)).toBe(99_999 % 256);
  });
});
