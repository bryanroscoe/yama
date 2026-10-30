import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { addsByIdentity, addsItself } from "./ScannerView";

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
  it("waits for a tap on a typed name or art that looks like another card", () => {
    expect(addsByIdentity({ method: "name", confidence: 1, others: [] })).toBe(false);
    expect(addsByIdentity({ method: "art", confidence: 0.7, others: [{ name: "Other" } as never] })).toBe(false);
  });
});
