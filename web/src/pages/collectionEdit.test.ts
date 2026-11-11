import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { finishChoices, finishFor, finishWord, opIds, ownedFinishes, printingLabel, reprintOps } from "./collectionEdit";

const row: CollectionItem = {
  id: "row",
  scryfall_id: "ltr-258",
  qty: 3,
  condition: "LP",
  finish: "nonfoil",
  lang: "en",
  proxy: false,
  container_id: "bulk",
  container_name: "bulk",
  container_kind: "box",
  purchase_price: null,
  oracle_id: "doom",
  name: "Mount Doom",
  set_code: "ltr",
  set_name: "The Lord of the Rings: Tales of Middle-earth",
  collector_number: "258",
  rarity: "mythic",
  image_small: null,
  image_normal: null,
  type_line: "Legendary Land",
  color_identity: "BR",
  unit_price_usd: 5.94,
  price_date: "2026-10-31",
};
let n = 0;
const id = () => `op${++n}`;

describe("reprintOps", () => {
  it("updates the whole row in place", () => {
    n = 0;
    expect(reprintOps(row, { scryfall_id: "ltr-x", lang: "en", finishes: ["nonfoil", "foil"] }, "all", id)).toEqual([
      { op_id: "op1", kind: "update", item_id: "row", scryfall_id: "ltr-x", lang: "en", finish: "nonfoil" },
    ]);
  });

  it("splits one copy off on the server", () => {
    n = 0;
    expect(reprintOps(row, { scryfall_id: "ltr-x", lang: "en", finishes: ["nonfoil"] }, "one", id)).toEqual([
      { op_id: "op1", kind: "update", item_id: "row", scryfall_id: "ltr-x", lang: "en", finish: "nonfoil", split: 1 },
    ]);
  });

  it("a single copy is just updated, and the same printing changes nothing", () => {
    n = 0;
    expect(reprintOps({ ...row, qty: 1 }, { scryfall_id: "x", lang: "en", finishes: [] }, "one", id)[0]!.kind).toBe("update");
    expect(reprintOps(row, { scryfall_id: "ltr-258", lang: "en", finishes: [] }, "all", id)).toEqual([]);
  });
});

describe("finishFor", () => {
  it("keeps the finish when the printing has it, else takes the printing's own", () => {
    expect(finishFor({ finish: "foil" }, { finishes: ["nonfoil", "foil"] })).toBe("foil");
    expect(finishFor({ finish: "nonfoil" }, { finishes: ["foil"] })).toBe("foil");
    expect(finishFor({ finish: "etched" }, { finishes: [] })).toBe("etched");
  });
});

it("labels a printing by set, code and number", () => {
  expect(printingLabel({ set_name: "Set", set_code: "ltr", collector_number: "258", lang: "en" })).toBe("Set (LTR) #258");
  expect(printingLabel({ set_name: "Set", set_code: "ltr", collector_number: "258", lang: "ja" })).toBe("Set (LTR) #258, ja");
});

describe("finish words", () => {
  it("names a finish the way the card page and sheet show it", () => {
    expect(finishWord("nonfoil")).toBe("regular");
    expect(finishWord("foil")).toBe("foil");
    expect(finishWord("etched")).toBe("etched foil");
  });
  it("says which finishes you own, regular first", () => {
    expect(ownedFinishes(["nonfoil"])).toBe("regular");
    expect(ownedFinishes(["foil", "nonfoil", "foil"])).toBe("regular and foil");
    expect(ownedFinishes(["etched", "foil", "nonfoil"])).toBe("regular, foil and etched foil");
  });
});

describe("finishChoices", () => {
  it("offers the printing's finishes, keeping the row's own", () => {
    expect(finishChoices("foil", ["nonfoil", "foil"])).toEqual(["nonfoil", "foil"]);
    expect(finishChoices("foil", ["nonfoil"])).toEqual(["foil", "nonfoil"]);
  });
  it("offers every finish until the printing is known", () => {
    expect(finishChoices("nonfoil", undefined)).toEqual(["nonfoil", "foil", "etched"]);
  });
});

describe("op ids for a screen's taps", () => {
  const counter = () => {
    let n = 0;
    return () => `op-${++n}`;
  };

  it("sends the same op again when a save failed, so a lost answer never adds a second copy", () => {
    const ids = opIds(counter());
    const first = ids.idFor("adjust:1");
    // The save failed (or only its answer was lost): the same tap is the same op.
    expect(ids.idFor("adjust:1")).toBe(first);
    expect(ids.idFor("adjust:1")).toBe(first);
  });

  it("makes a new op once the server confirmed the last one", () => {
    const ids = opIds(counter());
    const first = ids.idFor("ltr-258:nonfoil:real");
    ids.saved("ltr-258:nonfoil:real");
    expect(ids.idFor("ltr-258:nonfoil:real")).not.toBe(first);
  });

  it("keeps different changes apart", () => {
    const ids = opIds(counter());
    const add = ids.idFor("adjust:1");
    const remove = ids.idFor("adjust:-1");
    expect(remove).not.toBe(add);
    // One confirmed save doesn't make another change's failed op new.
    ids.saved("adjust:-1");
    expect(ids.idFor("adjust:1")).toBe(add);
    // A sheet's save confirms everything it sent.
    ids.saved();
    expect(ids.idFor("adjust:1")).not.toBe(add);
  });
});
