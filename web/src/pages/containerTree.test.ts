import { describe, expect, it } from "vitest";
import type { Container } from "../api";
import { ancestorsOf, childrenOf, moveTargets, optionLabel, pathLabel, placeLabel, subtreeIds, treeOrder } from "./containerTree";

const c = (id: string, name: string, parent: string | null, kind = "box", path?: string[]): Container => ({ id, name, kind, copies: 0, parent_id: parent, ...(path ? { path } : {}) });

// Out of order on purpose, and without the server's paths: the helpers work them out.
const all: Container[] = [
  c("pl", "Plains", "bb"),
  c("big", "Big box", null),
  c("other", "Trade", null, "binder"),
  c("bb", "Bulk Basic", "big"),
  c("is", "Island", "bb"),
  c("red", "Bulk Red", "big"),
];

describe("container paths", () => {
  it("names a section by its path", () => {
    expect(pathLabel(all[0]!, all)).toBe("Big box › Bulk Basic › Plains");
    expect(pathLabel(c("x", "X", null, "box", ["A", "B", "X"]))).toBe("A › B › X");
    expect(placeLabel("is", all)).toBe("Big box › Bulk Basic › Island");
    expect(placeLabel(null, all)).toBeNull();
    expect(optionLabel(all[0]!, all)).toBe("Big box › Bulk Basic › Plains (box)");
    expect(optionLabel(c("d", "Rohan", null, "deck"), [])).toBe("Rohan (deck box)");
  });

  it("walks down, up and in tree order", () => {
    expect([...subtreeIds("big", all)].sort()).toEqual(["bb", "big", "is", "pl", "red"]);
    expect([...subtreeIds("pl", all)]).toEqual(["pl"]);
    expect(childrenOf("bb", all).map((x) => x.id)).toEqual(["pl", "is"]);
    expect(childrenOf(null, all).map((x) => x.id)).toEqual(["big", "other"]);
    expect(ancestorsOf("pl", all).map((x) => x.id)).toEqual(["big", "bb"]);
    expect(treeOrder(all).map((x) => x.id)).toEqual(["big", "bb", "pl", "is", "red", "other"]);
  });

  it("never offers a container itself or its own sections to move into", () => {
    expect(moveTargets("bb", all).map((x) => x.id)).toEqual(["big", "red", "other"]);
    expect(moveTargets("other", all).map((x) => x.id)).toEqual(["big", "bb", "pl", "is", "red"]);
  });

  it("survives a loop in stale data", () => {
    const loop = [c("a", "A", "b"), c("b", "B", "a")];
    expect(pathLabel(loop[0]!, loop)).toBe("B › A");
    expect(treeOrder(loop)).toHaveLength(2);
  });
});
