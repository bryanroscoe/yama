// A title crop that reads the card's legal line means the card was cut upside down (pipeline.ts,
// readTitles). The reads are Bryan's, from his Scanner diagnostics of 23 Nov 2026.
import { describe, expect, it } from "vitest";
import { legalLine, readTitles } from "./pipeline";
import type { OcrEngine, Quad } from "./types";

describe("the legal line", () => {
  it("is told from a title, however the reader garbles it", () => {
    for (const t of ["T & 2026 Wizards of the Coast 2026 C8S. LEON TUKKER", "e & 2026 Wizards of he Coas UKKER 2026 CaS", "2026 CBS. M &O2026 Wizards of theCoast >HARKALÉ Lnt", "TM&O 2026 Wizards of the Coast ÞHARKALÉ LNAT"]) expect(legalLine(t)).toBe(true);
    expect(legalLine("O2026 WIZARDS")).toBe(true);
    expect(legalLine("0 2026 WZARDS OF THE COAST")).toBe(true);
    // Real names, and Un-cards that name Wizards of the Coast (review of #205: no year in any).
    for (const t of ["Sunpetal Grove", "Forest", "Wizard's Retort", "Coastal Piracy", "Wizard Class", "Wizards of Thay", "Of the Coast", "Wizards of the _____", "The Ultimate Nightmare of Wizards of the Coast® Customer Service", ""]) expect(legalLine(t)).toBe(false);
  });

  it("makes the title be read from the card's other end", async () => {
    const frame = { width: 400, height: 560, data: new Uint8ClampedArray(400 * 560 * 4) };
    const quad: Quad = [[50, 50], [350, 50], [350, 510], [50, 510]];
    const reads = ["2026 CBs. LỆ LINAT", "TM&O 2026 Wizards of the Coast", "Sunpetal Grove", "Sunpetal Grove"];
    let i = 0;
    const ocr = { read: async () => ({ text: reads[i++] ?? "", confidence: 90 }) } as unknown as OcrEngine;
    expect(await readTitles(frame, quad, ocr)).toEqual(["Sunpetal Grove", "Sunpetal Grove"]);
    // A title read the right way up: read once.
    i = 2;
    expect(await readTitles(frame, quad, ocr)).toEqual(["Sunpetal Grove", "Sunpetal Grove"]);
    expect(i).toBe(4);
  });
});
