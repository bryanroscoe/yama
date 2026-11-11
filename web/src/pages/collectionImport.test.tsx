import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImportCollectionSheet, ImportReportView } from "./ImportCollectionSheet";
import {
  chosenPlace,
  lineText,
  NEW_BOX,
  placeText,
  previewImport,
  previewLines,
  resultLines,
  runImport,
  unmatchedList,
  unmatchedText,
  type ImportLine,
  type ImportReport,
} from "./collectionImport";
import type { Container } from "../api";

function line(over: Partial<ImportLine> = {}): ImportLine {
  return { name: "Sol Ring", written_as: null, set_code: "cmm", set_name: "Commander Masters", collector_number: "410", finish: "nonfoil", condition: "NM", lang: "en", proxy: false, qty: 1, printing: "exact", ...over };
}

function report(over: Partial<ImportReport> = {}): ImportReport {
  return {
    dry_run: true,
    top_up: false,
    source: "a ManaBox export",
    already_imported: null,
    place: "unfiled",
    lines: 3,
    copies: 5,
    added: 5,
    added_cards: [line({ qty: 2 }), line({ name: "Lightning Bolt", set_code: "lea", collector_number: "161", qty: 3 })],
    already_owned: 0,
    unmatched: [],
    unmatched_copies: 0,
    skipped: [],
    notes: [],
    ...over,
  };
}

const lotus = { text: "3 Blak Lotus", row: null, qty: 3, reason: "No card has this name.", suggestions: ["Black Lotus"] };

describe("importing a collection: the sentences", () => {
  it("says what the list is, how much it adds and where", () => {
    expect(previewLines(report())).toEqual(["This looks like a ManaBox export with 5 cards.", "5 cards to add to your loose cards."]);
    expect(previewLines(report({ place: "box: Bulk", added: 1, copies: 1 }))[1]).toBe("1 card to add to the box Bulk.");
    expect(placeText("deck: Atraxa")).toBe("the deck box Atraxa");
    expect(previewLines(report({ lines: 0, copies: 0, added: 0, added_cards: [] }))).toEqual(["Yama found no cards in that."]);
  });

  it("never drops a line that matched nothing: it is counted and listed", () => {
    const r = report({ unmatched: [lotus, { text: "1 Storm Crow (XYZ) 1", row: 7, qty: 1, reason: "No card has this name.", suggestions: [] }], unmatched_copies: 4 });
    expect(previewLines(r)).toEqual([
      "This looks like a ManaBox export with 9 cards.",
      "5 cards to add to your loose cards.",
      "2 lines matched no card and won't be added. They're listed below to fix by hand.",
    ]);
    expect(unmatchedText(r.unmatched[0]!)).toBe("3 Blak Lotus. No card has this name. Did you mean Black Lotus?");
    expect(unmatchedText(r.unmatched[1]!)).toBe("Row 7: 1 Storm Crow (XYZ) 1. No card has this name.");
    expect(unmatchedList(r)).toBe("3 Blak Lotus\n1 Storm Crow (XYZ) 1");
    expect(resultLines({ ...r, dry_run: false })).toEqual(["Added 5 cards to your loose cards.", "2 lines matched no card and weren't added. They're listed below to fix by hand."]);
    expect(resultLines(report({ dry_run: false, added: 0, added_cards: [], unmatched: [lotus], unmatched_copies: 3 }))).toEqual([
      "Nothing was added.",
      "1 line matched no card and wasn't added. It's listed below to fix by hand.",
    ]);
  });

  it("says when the same list was imported before, and what topping up leaves out", () => {
    const again = report({ already_imported: "2026-11-10T18:00:00Z", added: 0, added_cards: [] });
    expect(previewLines(again, () => "Nov 10")[1]).toBe("You imported this exact list on Nov 10, so nothing is added from it again.");
    expect(resultLines(again)).toEqual(["Nothing changed: you'd imported this list already."]);
    const topped = report({ top_up: true, added: 2, already_owned: 3 });
    expect(previewLines(topped)).toContain("3 cards are in your collection already and aren't added again.");
    expect(resultLines(topped)).toEqual(["Added 2 cards to your loose cards.", "3 cards you had already weren't added again."]);
    expect(resultLines(report({ top_up: true, added: 0, added_cards: [], already_owned: 5 }))).toEqual(["Nothing changed: your collection has everything in the list."]);
    // What the import decided for the person is said after the counts.
    expect(previewLines(report({ notes: ["1 line named no printing, so it's filed under a regular printing of the card."] })).at(-1)).toContain("named no printing");
  });

  it("writes each card with its printing, finish, condition and language", () => {
    expect(lineText(line())).toBe("Sol Ring, CMM 410");
    expect(lineText(line({ qty: 2, finish: "foil", condition: "LP", lang: "ja", proxy: true }))).toBe("2 Sol Ring, CMM 410, foil, lightly played, ja, proxy");
    expect(lineText(line({ written_as: "Sol Rnig", printing: "number" }))).toBe("Sol Ring, CMM 410 (written as “Sol Rnig”)");
    expect(lineText(line({ printing: "default" }))).toBe("Sol Ring, CMM 410 (a regular printing)");
  });
});

describe("importing a collection: the requests", () => {
  const containers = [{ id: "c1", kind: "box", name: "Bulk" }];
  const source = { text: "1 Sol Ring", fileName: null };

  it("previews without writing, whatever place is chosen", async () => {
    const call = vi.fn().mockResolvedValue(report());
    await previewImport(call, source, true);
    expect(call).toHaveBeenCalledExactlyOnceWith("/api/collection/import", { method: "POST", json: { text: "1 Sol Ring", file_name: null, top_up: true, dry_run: true } });
    expect(chosenPlace("c1", "", containers)).toBe("box: Bulk");
    expect(chosenPlace("", "", containers)).toBe("unfiled");
    expect(chosenPlace(NEW_BOX, " Trades ", containers)).toBe("box: Trades");
  });

  it("imports into the chosen container, or unfiled", async () => {
    const call = vi.fn().mockResolvedValue(report({ dry_run: false }));
    await runImport(call, { text: "a,b", fileName: "cards.csv" }, { place: "c1", newName: "", topUp: false });
    expect(call).toHaveBeenCalledExactlyOnceWith("/api/collection/import", { method: "POST", json: { text: "a,b", file_name: "cards.csv", container_id: "c1", top_up: false, dry_run: false } });
    call.mockClear();
    await runImport(call, source, { place: "", newName: "ignored", topUp: true });
    expect(call).toHaveBeenCalledExactlyOnceWith("/api/collection/import", { method: "POST", json: { text: "1 Sol Ring", file_name: null, container_id: null, top_up: true, dry_run: false } });
  });

  it("makes a new box first and imports into it", async () => {
    const call = vi.fn().mockResolvedValueOnce({ id: "new-box" }).mockResolvedValueOnce(report({ dry_run: false }));
    await runImport(call, source, { place: NEW_BOX, newName: " Trades ", topUp: false });
    expect(call.mock.calls).toEqual([
      ["/api/containers", { method: "POST", json: { kind: "box", name: "Trades" } }],
      ["/api/collection/import", { method: "POST", json: { text: "1 Sol Ring", file_name: null, container_id: "new-box", top_up: false, dry_run: false } }],
    ]);
  });
});

describe("importing a collection: the sheet", () => {
  it("names the apps it reads, takes a list or a file, and still leads to the Mythic Tools import", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ImportCollectionSheet containers={[{ id: "c1", kind: "deck", name: "Atraxa" } as Container]} onClose={() => undefined} onMythic={() => undefined} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Import cards");
    for (const app of ["ManaBox", "Moxfield", "Archidekt", "Deckbox", "Dragon Shield", "TCGplayer"]) expect(html).toContain(app);
    expect(html).toContain("<textarea");
    expect(html).toContain('type="file"');
    expect(html).toContain("Not filed anywhere");
    expect(html).toContain("Atraxa (deck box)");
    expect(html).toContain("A new box");
    expect(html).toContain("Only add copies I don&#x27;t have yet.");
    expect(html).toMatch(/<button[^>]*>Import from Mythic Tools<\/button>/);
    // Nothing is asked of the server until a list is checked.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check the list<\/button>/);
    client.clear();
  });

  it("lists what matched nothing in the open, before and after", () => {
    const r = report({ unmatched: [lotus], unmatched_copies: 3, skipped: ["Sideboard stuff"] });
    for (const done of [false, true]) {
      const html = renderToStaticMarkup(<ImportReportView report={{ ...r, dry_run: !done }} done={done} />);
      expect(html).toContain("Not matched");
      // In the open, not inside a closed disclosure.
      expect(html.indexOf("3 Blak Lotus")).toBeLessThan(html.indexOf("<details"));
      expect(html).toContain("Did you mean Black Lotus?");
      expect(html).toMatch(/<button[^>]*>Copy this line<\/button>/);
      expect(html).toContain(done ? "Cards added" : "Cards to add");
      expect(html).toContain("Lines Yama couldn&#x27;t read");
    }
  });

  it("draws a long list in part and says how much is left", () => {
    const many = Array.from({ length: 320 }, (_, i) => line({ name: `Card ${i}` }));
    const html = renderToStaticMarkup(<ImportReportView report={report({ added_cards: many, added: 320, copies: 320 })} done={false} />);
    expect(html).toContain("Card 299");
    expect(html).not.toContain("Card 300");
    expect(html).toContain("and 20 more lines");
  });
});
