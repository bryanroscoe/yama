import { describe, expect, it } from "vitest";
import { addOp, findRow, planFix, type Added, type Fix } from "./session";

const entry: Added = { key: "k", name: "Sol Ring", scryfall_id: "ecc-57", set: "ecc", number: "57", image: null, finish: "nonfoil", container: "box", copies: 2, auto: true };
const row = (over: Partial<Parameters<typeof findRow>[0][number]> = {}) => ({ id: "r1", scryfall_id: "ecc-57", qty: 5, condition: "NM", finish: "nonfoil", lang: "en", proxy: false, container_id: "box", ...over });
const ids = () => {
  let n = 0;
  return () => `op${++n}`;
};
const fix = (over: Partial<Fix> = {}): Fix => ({ scryfall_id: "ecc-57", set: "ecc", number: "57", name: "Sol Ring", image: null, finish: "nonfoil", copies: 2, ...over });

describe("scan session fixes", () => {
  it("adds proxies as nonfoil proxy copies", () => {
    expect(addOp("x", 1, "proxy", null, "o")).toEqual({ op_id: "o", kind: "add", scryfall_id: "x", qty: 1, finish: "nonfoil", proxy: true, container_id: null });
  });

  it("finds the row the scanner's add merged into, not another copy kind", () => {
    const rows = [row({ id: "lp", condition: "LP" }), row({ id: "other-box", container_id: null }), row({ id: "foil", finish: "foil" }), row({ id: "signed", signed: true }), row({ id: "mine" })];
    expect(findRow(rows, entry)?.id).toBe("mine");
    expect(findRow([row({ proxy: true })], entry)).toBeUndefined();
    expect(findRow([row({ proxy: true })], { ...entry, finish: "proxy" })?.proxy).toBe(true);
  });

  it("changes the copy count with one adjust", () => {
    expect(planFix(entry, fix({ copies: 3 }), row(), ids())).toEqual([{ op_id: "op1", kind: "adjust", item_id: "r1", delta: 1 }]);
    expect(planFix(entry, fix(), row(), ids())).toEqual([]);
  });

  it("removes only this session's copies, never ones owned before", () => {
    expect(planFix(entry, fix({ copies: 0 }), row({ qty: 5 }), ids())).toEqual([{ op_id: "op1", kind: "adjust", item_id: "r1", delta: -2 }]);
    // Someone already took one out elsewhere: take back what's left of ours.
    expect(planFix(entry, fix({ copies: 0 }), row({ qty: 1 }), ids())).toEqual([{ op_id: "op1", kind: "adjust", item_id: "r1", delta: -1 }]);
  });

  it("moves the copies to another printing or finish", () => {
    expect(planFix(entry, fix({ scryfall_id: "c21-263" }), row(), ids())).toEqual([
      { op_id: "op1", kind: "adjust", item_id: "r1", delta: -2 },
      { op_id: "op2", kind: "add", scryfall_id: "c21-263", qty: 2, finish: "nonfoil", proxy: false, container_id: "box" },
    ]);
    expect(planFix(entry, fix({ finish: "foil", copies: 1 }), row(), ids())).toEqual([
      { op_id: "op1", kind: "adjust", item_id: "r1", delta: -2 },
      { op_id: "op2", kind: "add", scryfall_id: "ecc-57", qty: 1, finish: "foil", proxy: false, container_id: "box" },
    ]);
  });
});
