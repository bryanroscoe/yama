import { describe, expect, it } from "vitest";
import type { DeckCard } from "../api";
import { baseOf, versionPairs } from "./versionPairs";

const c = (name: string, qty = 1, board: DeckCard["board"] = "main"): DeckCard => ({ oracle_id: `o-${name}`, name, qty, board });
const names = (pairs: ReturnType<typeof versionPairs>) => pairs.map((p) => [p.in?.name ?? null, p.out?.name ?? null, p.qty]);

describe("a saved list's changes as pairs", () => {
  it("pairs cards in with cards out in name order, within each board", () => {
    const before = [c("Terra", 1, "commander"), c("Sol Ring"), c("Kefka"), c("Night's Whisper"), c("Plains", 10)];
    const after = [c("Celes", 1, "commander"), c("Sol Ring"), c("Yawgmoth"), c("The One Ring"), c("Plains", 10)];
    expect(names(versionPairs(before, after))).toEqual([
      ["Celes", "Terra", 1],
      ["The One Ring", "Kefka", 1],
      ["Yawgmoth", "Night's Whisper", 1],
    ]);
  });

  it("pairs copies by count and leaves what's unmatched on its own", () => {
    const before = [c("Plains", 10), c("Island", 12), c("Cut")];
    const after = [c("Plains", 12), c("Island", 10), c("Added"), c("Also added")];
    expect(names(versionPairs(before, after))).toEqual([
      ["Added", "Cut", 1],
      ["Also added", "Island", 1],
      ["Plains", "Island", 1],
      ["Plains", null, 1],
    ]);
    expect(names(versionPairs([c("Gone", 2)], []))).toEqual([[null, "Gone", 2]]);
    expect(versionPairs([c("Same")], [c("Same")])).toEqual([]);
  });

  it("compares a list with the last one that was the deck's list, skipping scans kept for History", () => {
    const vs = [{ id: "v4" }, { id: "scan", history_only: true }, { id: "v2" }, { id: "v1" }];
    expect(baseOf(vs, "v4")?.id).toBe("v2");
    expect(baseOf(vs, "scan")?.id).toBe("v2");
    expect(baseOf(vs, "v1")).toBeNull();
    expect(baseOf(vs, "missing")).toBeNull();
  });
});
