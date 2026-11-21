import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { changeDone, changeOps, conditionLabel, conditionWord, finishChoices, finishFor, finishWord, landedRow, languageChoices, languageName, markDone, markOps, markWords, opIds, ownedFinishes, printingLabel, reprintOps, sameCopy, worthLine } from "./collectionEdit";

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

describe("a copy's language, signed and altered", () => {
  const ids = () => {
    let k = 0;
    return () => `op-${++k}`;
  };

  it("marks the whole row, or one copy split off it", () => {
    expect(markOps(row, { signed: true }, "all", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", signed: true }]);
    expect(markOps(row, { altered: true }, "one", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", altered: true, split: 1 }]);
    // A row of one copy has nothing to split.
    expect(markOps({ ...row, qty: 1 }, { signed: true }, "one", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", signed: true }]);
    // Taking a mark off again.
    expect(markOps({ ...row, signed: true }, { signed: false }, "all", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", signed: false }]);
    // A language is the copy's own; the printing isn't changed.
    expect(markOps(row, { lang: "ja" }, "one", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", lang: "ja", split: 1 }]);
    expect(markOps(row, { lang: "de" }, "all", ids())).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", lang: "de" }]);
  });

  it("sends nothing when nothing changes, and mints no op id for it", () => {
    let minted = 0;
    const count = () => `op-${++minted}`;
    expect(markOps(row, { lang: "en" }, "all", count)).toEqual([]);
    expect(markOps(row, { signed: false, altered: false }, "one", count)).toEqual([]);
    expect(markOps({ ...row, altered: true }, { altered: true }, "all", count)).toEqual([]);
    expect(minted).toBe(0);
  });

  it("names languages, and keeps a code it has no name for", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("zhs")).toBe("Simplified Chinese");
    expect(languageName("xx")).toBe("xx");
    expect(languageChoices("en")[0]).toEqual(["en", "English"]);
    expect(languageChoices("en")).toHaveLength(18);
    expect(languageChoices("xx")[0]).toEqual(["xx", "xx"]);
    expect(languageChoices("xx")).toHaveLength(19);
  });

  it("says what changed, and describes the copy", () => {
    expect(markDone(row, { signed: true }, "one")).toBe("One Mount Doom is now signed.");
    expect(markDone(row, { altered: false }, "all")).toBe("Every Mount Doom in this row is no longer altered.");
    expect(markDone({ ...row, qty: 1 }, { lang: "ja" }, "one")).toBe("Mount Doom is now in Japanese.");
    expect(markDone({ ...row, qty: 1 }, { signed: true, altered: false }, "all")).toBe("Mount Doom is now signed and is no longer altered.");
    expect(markWords(row)).toEqual([]);
    expect(markWords({ lang: "ja", signed: true, altered: true })).toEqual(["Japanese", "signed", "altered"]);
  });
});

describe("changing where a row's copies are kept, their condition, finish or proxy", () => {
  it("changes the whole row, or splits one copy off it", () => {
    expect(changeOps(row, { container_id: "trade" }, "all", () => "op-1")).toEqual([{ op_id: "op-1", kind: "update", item_id: "row", container_id: "trade" }]);
    expect(changeOps(row, { condition: "NM" }, "one", () => "op-2")).toEqual([{ op_id: "op-2", kind: "update", item_id: "row", condition: "NM", split: 1 }]);
    // A row of one has nothing to split.
    expect(changeOps({ ...row, qty: 1 }, { proxy: true }, "one", () => "op-3")).toEqual([{ op_id: "op-3", kind: "update", item_id: "row", proxy: true }]);
    // Not filed anywhere is said as null, not left out.
    expect(changeOps(row, { container_id: null }, "all", () => "op-4")[0]).toMatchObject({ container_id: null });
  });

  it("says what a saved change did, and what it left alone", () => {
    expect(changeDone(row, { container_id: "trade" }, "one", "Trade binder")).toBe("One Mount Doom is now in Trade binder. The other 2 are unchanged.");
    expect(changeDone(row, { container_id: "trade" }, "all", "Trade binder")).toBe("All 3 copies of Mount Doom are now in Trade binder.");
    expect(changeDone(row, { container_id: null }, "all")).toBe("All 3 copies of Mount Doom are now not filed anywhere.");
    expect(changeDone({ ...row, qty: 2 }, { condition: "NM" }, "one")).toBe("One Mount Doom is now near mint. The other one is unchanged.");
    expect(changeDone({ ...row, qty: 1 }, { finish: "etched" }, "all")).toBe("Mount Doom is now etched foil.");
    expect(changeDone(row, { proxy: true }, "all")).toBe("All 3 copies of Mount Doom are now marked as proxies.");
    expect(changeDone(row, { proxy: false }, "one")).toBe("One Mount Doom is now marked as a real card. The other 2 are unchanged.");
  });

  it("writes a condition out", () => {
    expect(conditionWord("LP")).toBe("lightly played");
    expect(conditionLabel("NM")).toBe("Near mint (NM)");
    expect(conditionLabel("DMG")).toBe("Damaged (DMG)");
    // A code Yama has no words for is shown as it is.
    expect(conditionLabel("PO")).toBe("PO");
  });

  it("says what a row is worth, with the price's source and date", () => {
    expect(worthLine({ qty: 6, proxy: false, unit_price_usd: 0.19, price_date: "2026-11-20" })).toBe("6 copies, $0.19 each (TCGplayer market via Scryfall, Nov 20)");
    expect(worthLine({ qty: 1, proxy: false, unit_price_usd: 2, price_date: null })).toBe("1 copy, $2.00 (TCGplayer market via Scryfall, date unknown)");
    expect(worthLine({ qty: 2, proxy: false, unit_price_usd: null, price_date: null })).toBe("2 copies, no market price");
    expect(worthLine({ qty: 1, proxy: true, unit_price_usd: 1653.09, price_date: "2026-11-20" })).toBe("1 proxy. A real copy is $1,653.09 (TCGplayer market via Scryfall, Nov 20)");
    expect(worthLine({ qty: 2, proxy: true, unit_price_usd: null, price_date: null })).toBe("2 proxies");
  });

  it("works out a landed change from the row as it is now, and leaves a price it can't know blank", () => {
    // The row was read again while the save was out (it had merged: 7 copies, not the 3 the tap saw).
    const newest: CollectionItem = { ...row, id: "merged", qty: 7 };
    expect(landedRow(newest, (cur) => ({ qty: cur.qty + 1 })).row.qty).toBe(8);
    // One copy split off: the row only loses it.
    expect(landedRow(newest, null)).toEqual({ row: { ...newest, qty: 6 }, priced: true });
    // Condition, place and proxy keep the price; the newest row's other fields stay.
    const moved = landedRow(newest, { container_id: "binder", container_name: "Binder", spares_of_deck: null });
    expect(moved.priced).toBe(true);
    expect(moved.row).toMatchObject({ id: "merged", qty: 7, container_id: "binder", unit_price_usd: 5.94, price_date: "2026-10-31", spares_of_deck: null });
    // Another finish is another price, which only the server has: blank, never the old one.
    const foil = landedRow(newest, { finish: "foil" });
    expect(foil.priced).toBe(false);
    expect(foil.row).toMatchObject({ finish: "foil", unit_price_usd: null, price_date: null, qty: 7 });
    expect(worthLine(foil.row, foil.priced)).toBe("7 copies");
    expect(worthLine({ ...foil.row, proxy: true }, false)).toBe("7 proxies");
    // The same finish chosen again changes nothing about the price.
    expect(landedRow(newest, { finish: "nonfoil" }).priced).toBe(true);
    // Another printing picked from the list comes with that printing's own price and day.
    const reprint = landedRow(newest, { scryfall_id: "ltr-750", unit_price_usd: null, price_date: "2026-11-20" });
    expect(reprint.priced).toBe(true);
    expect(reprint.row).toMatchObject({ scryfall_id: "ltr-750", unit_price_usd: null, price_date: "2026-11-20" });
    expect(landedRow(newest, { scryfall_id: "ltr-750" }).priced).toBe(false);
  });

  it("finds a row again by what its copies are and where they're kept", () => {
    const other: CollectionItem = { ...row, id: "other", qty: 9 };
    expect(sameCopy(row, other)).toBe(true);
    expect(sameCopy(row, { ...row, signed: false, altered: undefined })).toBe(true);
    for (const change of [{ condition: "NM" }, { finish: "foil" }, { proxy: true }, { container_id: null }, { signed: true }, { lang: "ja" }, { scryfall_id: "x" }]) {
      expect(sameCopy(row, { ...row, ...change })).toBe(false);
    }
  });
});
