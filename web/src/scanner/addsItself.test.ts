import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { addsItself } from "./ScannerView";

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
