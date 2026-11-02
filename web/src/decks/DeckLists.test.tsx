import { describe, expect, it } from "vitest";
import { deckLists, listLabel } from "./DeckLists";

const ref = (id: string, configuration: string | null) => ({ id, name: configuration ? `Riders of Rohan (${configuration})` : "Riders of Rohan", configuration, visibility: "private" as const, share_token: null });
const group = [ref("main", null), ref("after", "after prints"), ref("stock", "stock")];

describe("which list is in the deck", () => {
  it("names the main deck as the list in the deck, from the main deck or a configuration", () => {
    const fromMain = deckLists({ id: "main", parent_id: null, configurations: group })!;
    expect(fromMain.main.id).toBe("main");
    expect(fromMain.here).toBe("main");
    expect(fromMain.others.map((c) => c.id)).toEqual(["after", "stock"]);
    const fromStock = deckLists({ id: "stock", parent_id: "main", configurations: group })!;
    expect(fromStock.main.id).toBe("main");
    expect(fromStock.here).toBe("other");
    expect(listLabel(group[0]!, true)).toBe("Main");
    expect(listLabel(group[2]!, false)).toBe("stock");
  });

  it("shows nothing for a deck without configurations", () => {
    expect(deckLists({ id: "main", parent_id: null, configurations: [group[0]!] })).toBeNull();
  });
});
