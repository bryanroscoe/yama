import { describe, expect, it } from "vitest";
import { leftOut, overLimit, sellable, sellText, type SellCard } from "./sellList";

const card = (over: Partial<SellCard> = {}): SellCard => ({
  id: "i1",
  scryfall_id: "3c8f6e62-0000-4000-8000-000000000001",
  name: "Sol Ring",
  set_code: "c21",
  set_name: "Commander 2021",
  collector_number: "263",
  qty: 2,
  condition: "NM",
  finish: "nonfoil",
  lang: "en",
  proxy: false,
  ...over,
});

describe("sell lists", () => {
  it("writes SortSwift's CSV with the Scryfall ID and the copy's condition, printing and language", () => {
    const t = sellText("sortswift", [
      card(),
      card({ id: "i2", name: "Fire // Ice", set_code: "mh2", collector_number: "290", qty: 1, condition: "DMG", finish: "etched", lang: "ja", signed: true }),
    ]);
    expect(t.text).toBe(
      [
        "Scryfall ID,Card Name,Set,Card Number,Quantity,Condition,Printing,Language,Notes",
        "3c8f6e62-0000-4000-8000-000000000001,Sol Ring,C21,263,2,NM,Normal,EN,",
        "3c8f6e62-0000-4000-8000-000000000001,Fire // Ice,MH2,290,1,DM,Etched,JP,Signed",
        "",
      ].join("\n"),
    );
    expect(t).toMatchObject({ lines: 2, copies: 3 });
  });

  it("quotes CSV cells that need it", () => {
    const t = sellText("sortswift", [card({ name: 'Borrowing 100,000 Arrows', signed: true, altered: true })]);
    expect(t.text.split("\n")[1]).toBe('3c8f6e62-0000-4000-8000-000000000001,"Borrowing 100,000 Arrows",C21,263,2,NM,Normal,EN,"Signed, Altered"');
  });

  it("writes a Storepass paste list by name, merging printings, quantity first", () => {
    const t = sellText("storepass", [card(), card({ id: "i2", set_code: "cmm", qty: 1, finish: "foil" }), card({ id: "i3", name: "Arcane Signet", qty: 1 })]);
    expect(t.text).toBe("3 Sol Ring\n1 Arcane Signet\n");
    expect(t).toMatchObject({ lines: 2, copies: 4 });
  });

  it("writes Card Kingdom's headerless CSV by set name and foil", () => {
    const t = sellText("cardkingdom", [card(), card({ id: "i2", qty: 1, condition: "LP" }), card({ id: "i3", qty: 1, finish: "foil" }), card({ id: "i4", qty: 1, finish: "etched", set_name: "Commander Masters" })]);
    expect(t.text).toBe('"Sol Ring",Commander 2021,0,3\n"Sol Ring",Commander 2021,1,1\n"Sol Ring",Commander Masters,1,1\n');
  });

  it("sells only the copies asked for", () => {
    const t = sellText("storepass", [card(), card({ id: "i2", name: "Arcane Signet" })], (c) => (c.id === "i1" ? 1 : 0));
    expect(t.text).toBe("1 Sol Ring\n");
    expect(t.copies).toBe(1);
  });

  it("leaves out proxies, unknown printings and, for Card Kingdom, cards that aren't English", () => {
    const cards = [card(), card({ id: "p", proxy: true }), card({ id: "u", name: null }), card({ id: "j", lang: "ja" })];
    expect(leftOut("sortswift", cards).map((x) => [x.card.id, x.why])).toEqual([
      ["p", "a proxy"],
      ["u", "not in Yama's card data yet"],
    ]);
    expect(sellable("sortswift", cards).map((c) => c.id)).toEqual(["i1", "j"]);
    expect(sellable("cardkingdom", cards).map((c) => c.id)).toEqual(["i1"]);
  });

  it("says when a list is over Card Kingdom's limits", () => {
    const many = Array.from({ length: 501 }, (_, n) => card({ id: `c${n}`, name: `Card ${n}`, qty: 1 }));
    expect(overLimit("cardkingdom", sellText("cardkingdom", many))).toMatch(/at most 500 lines; this list has 501/);
    expect(overLimit("cardkingdom", sellText("cardkingdom", [card({ qty: 5001 })]))).toMatch(/at most 5,000 cards; this list has 5,001/);
    expect(overLimit("sortswift", sellText("sortswift", many))).toBeNull();
  });
});
