// The printing a scan files: settled only when the art or the collector line settles it.

import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { choosePrinting } from "./printings";
import { parseArts, sampleWindow } from "./recognizer";

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
  });
  it("needs the number when one set has two printings of the art", () => {
    expect(choosePrinting({ sameArt: true, printings: signets }, "CMR + EN").chosen).toBeNull();
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0689\nCMR + EN").chosen?.collector_number).toBe("689");
  });
  it("marks a read of both set code and number as strong (the close-up takes it at once)", () => {
    expect(choosePrinting({ sameArt: true, printings: signets }, "C 0145\nWOC + EN").strong).toBe(true);
    expect(choosePrinting({ sameArt: true, printings: signets }, "CC 0149\nWOC + EN").strong).toBe(false);
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
