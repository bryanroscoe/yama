import { describe, expect, it } from "vitest";
import { boxText, buttonText, groups, outcomeText, printingText, resultText, summary, type CollectLine, type CollectPreview } from "./collect";

function line(name: string, over: Partial<CollectLine> = {}): CollectLine {
  return {
    oracle_id: `o-${name}`,
    name,
    qty: 1,
    in_box: 0,
    missing: 1,
    printing: { scryfall_id: "p", set_code: "cmm", set_name: "Commander Masters", collector_number: "410", finish: "nonfoil", from: "default", image_small: null },
    proxy: false,
    elsewhere: [],
    moved: 0,
    added: 1,
    left_out: 0,
    ...over,
  };
}

function preview(over: Partial<CollectPreview> = {}): CollectPreview {
  return {
    deck_id: "d",
    deck_name: "Tricky Terrain",
    version_id: "v",
    box_id: null,
    box_name: "Tricky Terrain",
    box_kind: "deck",
    box_exists: false,
    same_printing: "move",
    cards: 100,
    in_box: 0,
    missing: 100,
    same_elsewhere: 3,
    not_in_list: 0,
    options: { move: { moved: 3, added: 97, left_out: 0 }, add: { moved: 0, added: 100, left_out: 0 }, skip: { moved: 0, added: 97, left_out: 3 } },
    moved: 3,
    added: 97,
    left_out: 0,
    proxies: 2,
    no_printing: [],
    lines: [],
    applied: false,
    ...over,
  };
}

describe("add to my collection", () => {
  it("says what each choice does", () => {
    const p = preview();
    expect(outcomeText(p.options.move)).toBe("Moves 3, adds 97 new copies.");
    expect(outcomeText(p.options.add)).toBe("Adds 100 new copies.");
    expect(outcomeText(p.options.skip)).toBe("Adds 97 new copies, leaves out 3.");
    expect(outcomeText({ moved: 0, added: 1, left_out: 0 })).toBe("Adds 1 new copy.");
    expect(outcomeText({ moved: 0, added: 0, left_out: 0 })).toBe("Nothing to do.");
  });

  it("names the box and whether it's new", () => {
    expect(boxText(preview())).toBe("Into the deck box Tricky Terrain, made now. The deck's list doesn't change.");
    expect(boxText(preview({ box_kind: "binder", box_name: "Trade", box_exists: true }))).toBe("Into the binder Trade. The deck's list doesn't change.");
  });

  it("sums up the preview in plain sentences", () => {
    expect(summary(preview())).toEqual([
      "100 cards in the deck, 0 already in its box.",
      "You own the same printing of 3 of the 100 missing in another box or binder.",
      "2 cards the deck marks as a proxy go in as proxies.",
    ]);
    expect(summary(preview({ in_box: 100, missing: 0, same_elsewhere: 0 }))).toEqual(["100 cards in the deck, 100 already in its box.", "Nothing to add: the box holds the whole list."]);
    expect(summary(preview({ same_elsewhere: 0, proxies: 0, no_printing: ["Plains"] }))[1]).toBe("Yama has no printing of Plains, so it's left out.");
    expect(summary(preview({ in_box: 74, missing: 26, same_elsewhere: 0, proxies: 0, not_in_list: 26 }))[1]).toBe("26 cards in the box aren't in the list any more. Adding leaves them there.");
    for (const s of summary(preview())) expect(s).not.toContain("·");
  });

  it("labels the button and the result", () => {
    expect(buttonText({ moved: 3, added: 97, left_out: 0 })).toBe("Add 100 cards (3 moved)");
    expect(buttonText({ moved: 0, added: 1, left_out: 0 })).toBe("Add 1 card");
    expect(buttonText({ moved: 0, added: 0, left_out: 2 })).toBe("Nothing to add");
    expect(resultText(preview({ applied: true }))).toBe("Added 97 cards and moved 3 into Tricky Terrain.");
    expect(resultText(preview({ applied: true, moved: 0, added: 4, left_out: 3 }))).toBe("Added 4 cards into Tricky Terrain. 3 left out.");
    expect(resultText(preview({ applied: false, moved: 0, added: 0, left_out: 0 }))).toBe("Nothing to add: Tricky Terrain already holds the deck's list.");
    expect(resultText(preview({ applied: false, moved: 0, added: 0, left_out: 2 }))).toBe("Nothing added. 2 cards left out.");
  });

  it("describes each card's printing", () => {
    expect(printingText(line("Sol Ring"))).toBe("CMM 410. Default printing");
    const foil = line("Arcane Signet", { proxy: true, printing: { scryfall_id: "p", set_code: "c21", set_name: "C21", collector_number: "236", finish: "foil", from: "deck", image_small: null } });
    expect(printingText(foil)).toBe("C21 236, foil, proxy. The deck's printing");
    expect(printingText(line("Unknown", { printing: null }))).toBe("No printing in Yama's card data");
  });

  it("groups the cards by what happens to them", () => {
    const g = groups({ lines: [line("A"), line("B", { added: 0, moved: 1 }), line("C", { added: 0, left_out: 1 }), line("D", { added: 1, moved: 1, qty: 2, missing: 2 })] });
    expect(g.add.map((l) => l.name)).toEqual(["A", "D"]);
    expect(g.move.map((l) => l.name)).toEqual(["B", "D"]);
    expect(g.leave.map((l) => l.name)).toEqual(["C"]);
  });
});
