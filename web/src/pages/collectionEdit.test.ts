import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { finishFor, printingLabel, reprintOps } from "./collectionEdit";

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

  it("splits one copy off into the new printing, same place and condition", () => {
    n = 0;
    expect(reprintOps(row, { scryfall_id: "ltr-x", lang: "en", finishes: ["nonfoil"] }, "one", id)).toEqual([
      { op_id: "op1", kind: "adjust", item_id: "row", delta: -1 },
      {
        op_id: "op2",
        kind: "add",
        scryfall_id: "ltr-x",
        qty: 1,
        condition: "LP",
        finish: "nonfoil",
        lang: "en",
        altered: false,
        signed: false,
        misprint: false,
        proxy: false,
        container_id: "bulk",
      },
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
