import { describe, expect, it } from "vitest";
import { changeText, keptText, missingLabel, missingText, previewLines, resultLines, type MythicChange, type MythicReport } from "./mythicImport";

function report(over: Partial<MythicReport> = {}): MythicReport {
  return {
    dry_run: true,
    remove_missing: false,
    already_imported: null,
    rows: 214,
    copies: 300,
    containers: ["bulk (box)", "Bulk Basic (box)"],
    new_containers: [],
    retyped_containers: [],
    added: 12,
    added_cards: [],
    already_in_yama: 288,
    kept_where_moved: 0,
    kept_cards: [],
    missing: 0,
    missing_cards: [],
    removed: 0,
    unknown_printings: [],
    errors: [],
    deck_containers: [],
    decks_created: [],
    decks_updated: [],
    decks_kept: [],
    ...over,
  };
}

const sol: MythicChange = { name: "Sol Ring", set_code: "cmm", collector_number: "410", finish: "foil", lang: "en", proxy: false, place: "box: bulk", qty: 2 };

describe("Mythic Tools import", () => {
  it("previews a newer export without doubling", () => {
    expect(previewLines(report())).toEqual(["300 cards in the file.", "12 cards to add.", "288 cards are in Yama already."]);
    expect(
      previewLines(report({ added: 0, already_in_yama: 1, kept_where_moved: 1, new_containers: ["Trade (binder)"], retyped_containers: ["bulk (list to box)"], deck_containers: ["Omo"] })),
    ).toEqual([
      "300 cards in the file.",
      "Nothing new to add.",
      "1 card is in Yama already.",
      "1 of those is somewhere else in Yama than the file says (moved there, say) and stays put.",
      "New: Trade (binder).",
      "Changed type, as in the file: bulk (list to box).",
      "This deck becomes a Yama deck too, private until you share it: Omo.",
    ]);
  });

  it("says when the same file comes back", () => {
    const lines = previewLines(report({ already_imported: "2026-10-18T20:32:00Z", added: 0 }), (d) => `day ${d}`);
    expect(lines[1]).toBe("You imported this exact file on day 2026-10-18, so nothing is added from it again.");
  });

  it("names cards and where they are", () => {
    expect(changeText(sol)).toBe("2 Sol Ring, CMM 410, foil, in box: bulk");
    expect(changeText({ ...sol, qty: 1, finish: "nonfoil", lang: "ja", proxy: true })).toBe("Sol Ring, CMM 410, ja, proxy, in box: bulk");
    expect(keptText({ ...sol, qty: 1, finish: "nonfoil", now_in: ["deck: Omo"] })).toBe("Sol Ring, CMM 410: the file has it in box: bulk, Yama in deck: Omo");
    expect(missingText({ missing: 3, missing_cards: [sol, { ...sol, qty: 1, place: "box: Bulk Basic" }] })).toBe(
      "3 cards in box: bulk and box: Bulk Basic aren't in this export. Yama keeps them unless you say so; boxes and binders the file doesn't name are never touched.",
    );
    expect(missingLabel({ missing: 1 })).toBe("Remove this copy from Yama");
    expect(missingLabel({ missing: 3 })).toBe("Remove these 3 copies from Yama");
  });

  it("reports what the import did", () => {
    expect(resultLines(report({ dry_run: false }))).toEqual(["Added 12 cards."]);
    expect(resultLines(report({ dry_run: false, added: 0, missing: 3, removed: 0 }))).toEqual(["Nothing changed: Yama has everything in the file.", "3 cards the file no longer lists stay in Yama."]);
    expect(resultLines(report({ dry_run: false, added: 0, missing: 3, removed: 3 }))).toEqual(["Removed 3 cards the file no longer lists."]);
    expect(resultLines(report({ dry_run: false, added: 0, already_imported: "2026-10-18" }))[0]).toBe("Nothing changed: you'd imported this file already.");
    expect(resultLines(report({ dry_run: false, decks_kept: ["Tricky Terrain"] }))[1]).toBe("Decks you made in Yama keep their own lists: Tricky Terrain.");
    for (const s of resultLines(report({ dry_run: false, decks_created: ["Omo"] }))) expect(s).not.toContain("·");
    // A deck made from a collection box is private whatever the account's setting, and both lines say so.
    expect(previewLines(report({ deck_containers: ["Omo"] })).at(-1)).toBe("This deck becomes a Yama deck too, private until you share it: Omo.");
    expect(previewLines(report({ deck_containers: ["Omo", "Rohan"] })).at(-1)).toBe("These decks become Yama decks too, private until you share them: Omo, Rohan.");
    expect(resultLines(report({ dry_run: false, decks_created: ["Omo"] }))).toContain("New decks, private until you share them: Omo. Check each one's commander on the Decks tab.");
  });
});
