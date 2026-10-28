import { describe, expect, it } from "vitest";
import { addOp, changedElsewhere, findRow, identity, noteWrite, planFix, settled, touched, type Added, type Fix } from "./session";

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

describe("scan session writes", () => {
  it("applies a confirmed fix to the entry and drops the pending write", () => {
    const pending = { ops: [], fix: fix({ scryfall_id: "m3c-230", set: "m3c", number: "230", copies: 3 }) };
    expect(settled({ ...entry, pending })).toEqual({ ...entry, scryfall_id: "m3c-230", set: "m3c", number: "230", copies: 3 });
    expect(settled({ ...entry, pending: { ops: [], fix: null } })).toEqual(entry);
  });
});

describe("rows changed elsewhere", () => {
  const add = (over: Partial<Added> = {}): Added => ({ ...entry, copies: 2, pending: { ops: [addOp("ecc-57", 2, "nonfoil", "box", "o")], fix: null }, ...over });

  it("learns a row's count after an add, and grows it on later adds", () => {
    const seen = new Map<string, number>();
    expect(noteWrite(seen, add())).toHaveLength(1); // unknown: look it up
    seen.set(identity(entry), 4); // looked up: 2 owned before + 2 scanned
    expect(noteWrite(seen, add({ copies: 1 }))).toEqual([]);
    expect(seen.get(identity(entry))).toBe(5);
  });

  it("refuses a fix when the row lost copies elsewhere (Codex: 2 owned + 2 scanned, lowered to 1)", () => {
    const seen = new Map([[identity(entry), 4]]);
    expect(changedElsewhere(seen, entry, 1)).toBe(true);
    expect(changedElsewhere(seen, entry, 4)).toBe(false);
    expect(changedElsewhere(seen, entry, 6)).toBe(false); // more added elsewhere: taking ours back is still safe
    expect(changedElsewhere(new Map(), entry, 1)).toBe(false); // not known yet
  });

  it("tracks the session's own fixes, on the old row and the new one", () => {
    const seen = new Map([[identity(entry), 4]]);
    const move = planFix(entry, fix({ scryfall_id: "c21-263" }), row({ qty: 4 }), ids());
    const unknown = noteWrite(seen, { ...entry, pending: { ops: move, fix: fix({ scryfall_id: "c21-263" }), base: 4 } });
    expect(seen.get(identity(entry))).toBe(2);
    expect(unknown).toEqual([{ name: "Sol Ring", scryfall_id: "c21-263", finish: "nonfoil", container: "box" }]);
    const fewer = planFix(entry, fix({ copies: 1 }), row({ qty: 4 }), ids());
    const again = new Map([[identity(entry), 4]]);
    noteWrite(again, { ...entry, pending: { ops: fewer, fix: fix({ copies: 1 }), base: 4 } });
    expect(again.get(identity(entry))).toBe(3);
  });
});

describe("rows a write touches", () => {
  it("names the entry's row, and the row a fix moves its copies to", () => {
    expect(touched({ ...entry, pending: { ops: [], fix: null } })).toEqual([identity(entry)]);
    expect(touched({ ...entry, pending: { ops: [], fix: fix({ copies: 3 }) } })).toEqual([identity(entry)]);
    expect(touched({ ...entry, pending: { ops: [], fix: fix({ finish: "foil" }) } })).toEqual([identity(entry), identity({ ...entry, finish: "foil" })]);
    expect(touched({ ...entry, pending: { ops: [], fix: fix({ scryfall_id: "x", copies: 0 }) } })).toEqual([identity(entry)]);
  });
});
