import { describe, expect, it } from "vitest";
import type { DeckCard } from "../api";
import { baseOf, versionPairs } from "./versionPairs";

const c = (name: string, qty = 1, board: DeckCard["board"] = "main"): DeckCard => ({ oracle_id: `o-${name}`, name, qty, board });
const names = (pairs: ReturnType<typeof versionPairs>) => pairs.map((p) => [p.in?.name ?? null, p.out?.name ?? null, p.qty]);

describe("a saved version's changes", () => {
  it("reads a board's lone swap as a pair, and several changes as cards in and cards out", () => {
    const before = [c("Terra", 1, "commander"), c("Sol Ring"), c("Kefka"), c("Night's Whisper"), c("Plains", 10)];
    const after = [c("Celes", 1, "commander"), c("Sol Ring"), c("Yawgmoth"), c("The One Ring"), c("Plains", 10)];
    expect(names(versionPairs(before, after))).toEqual([
      // One commander for another is a swap.
      ["Celes", "Terra", 1],
      // Two in and two out: nothing says which replaced which, so no pair is claimed.
      ["The One Ring", null, 1],
      ["Yawgmoth", null, 1],
      [null, "Kefka", 1],
      [null, "Night's Whisper", 1],
    ]);
    expect(names(versionPairs([c("Sol Ring"), c("Kefka")], [c("Sol Ring"), c("Yawgmoth")]))).toEqual([["Yawgmoth", "Kefka", 1]]);
  });

  it("counts copies, and leaves a lone swap's extra copies on their own", () => {
    const before = [c("Plains", 10), c("Island", 12), c("Cut")];
    const after = [c("Plains", 12), c("Island", 10), c("Added"), c("Also added")];
    expect(names(versionPairs(before, after))).toEqual([
      ["Added", null, 1],
      ["Also added", null, 1],
      ["Plains", null, 2],
      [null, "Cut", 1],
      [null, "Island", 2],
    ]);
    expect(names(versionPairs([c("Plains", 10), c("Island", 10)], [c("Plains", 13), c("Island", 8)]))).toEqual([
      ["Plains", "Island", 2],
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
