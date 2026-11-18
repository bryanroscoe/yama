import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { addsByIdentity, addsItself, lookalikes } from "./ScannerView";

const p = { scryfall_id: "x" } as Printing;

describe("Keep adding", () => {
  it("adds a camera-found card whose printing the scanner proved", () => {
    expect(addsItself({ sure: true, chosen: p, method: "art", confidence: 0.9 })).toBe(true);
    expect(addsItself({ sure: true, chosen: p, method: "name", confidence: 0.9 })).toBe(true); // name read up close
  });
  it("waits for a tap on anything less", () => {
    expect(addsItself({ sure: false, chosen: p, method: "art", confidence: 0.9 })).toBe(false); // picked or guessed
    expect(addsItself({ sure: true, chosen: null, method: "art", confidence: 0.9 })).toBe(false);
    expect(addsItself({ sure: true, chosen: p, method: "name", confidence: 1 })).toBe(false); // typed
  });
});

describe("Keep adding when only the card matters (scanning a deck)", () => {
  it("adds a card the camera found, with no printing needed", () => {
    expect(addsByIdentity({ method: "art", confidence: 0.7, others: [] })).toBe(true);
    expect(addsByIdentity({ method: "name", confidence: 0.9, others: [] })).toBe(true); // name read up close
  });
  it("waits for a tap on a typed name, an unsure text read, or art that looks like another card", () => {
    expect(addsByIdentity({ method: "name", confidence: 1, others: [] })).toBe(false);
    expect(addsByIdentity({ method: "name", confidence: 0.65, others: [] })).toBe(false); // read the same way twice, not sure
    expect(addsByIdentity({ method: "collector", confidence: 0.7, others: [] })).toBe(false);
    expect(addsByIdentity({ method: "art", confidence: 0.7, others: [{ name: "Other" } as never] })).toBe(false);
  });
  it("adds art that looks like another card once a clear title read named it", () => {
    expect(addsByIdentity({ method: "art", confidence: 0.66, others: [{ name: "Other" } as never], titled: true })).toBe(true);
  });
  it("adds art that leads every other card by 0.10, though another scores within 0.2", () => {
    expect(addsByIdentity({ method: "art", confidence: 0.72, others: [{ name: "Other" } as never], leads: true })).toBe(true);
  });
});

describe("lookalikes", () => {
  it("lists other cards within 0.2 of the top match, once per name", () => {
    const top = { index: 1, name: "Sol Ring", score: 0.68 };
    const matches = [top, { index: 2, name: "Sol Ring", score: 0.6 }, { index: 3, name: "Mind Stone", score: 0.5 }, { index: 4, name: "Mind Stone", score: 0.49 }, { index: 5, name: "Arcane Signet", score: 0.47 }];
    expect(lookalikes(matches, top).map((m) => m.index)).toEqual([3]);
  });
});
