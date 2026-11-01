import { describe, expect, it } from "vitest";
import { applyLabel, deckApplyLabel, deckStatusText, initialMatches, parseExport, resultText, sendCards, statusText, type MythicDeckRow, type MythicGameRow } from "./mythic";
import { MYTHIC_SNIPPET, mythicSendSnippet } from "./snippet";

function game(over: Partial<MythicGameRow> = {}): MythicGameRow {
  return { mythic_id: "1", started_at: "2026-10-04T01:35:04Z", status: "new", action: "create", yama_id: null, matches: [], seats: [], reason: null, ...over };
}

describe("Mythic Tools import", () => {
  it("reads the snippet's file and refuses anything else", () => {
    expect(parseExport('{"me":{"id":1},"games":[]}').games).toEqual([]);
    expect(() => parseExport("not json")).toThrow(/isn't JSON/);
    expect(() => parseExport('{"decks":[]}')).toThrow(/no games/);
  });

  it("says what Apply does with each game", () => {
    expect(statusText(game())).toBe("New");
    expect(statusText(game({ status: "match", action: "skip" }))).toBe("Looks like a game already in Yama");
    expect(statusText(game({ status: "match", action: "link" }))).toBe("Matched to a game in Yama");
    expect(statusText(game({ status: "conflict", action: "skip" }))).toBe("Changed in Mythic and in Yama, choose which to keep");
    expect(statusText(game({ status: "conflict", action: "keep" }))).toBe("Changed in Mythic and in Yama, Yama's version stays");
    expect(statusText(game({ status: "invalid", action: "skip", reason: "it isn't finished in Mythic" }))).toBe("Can't import: it isn't finished in Mythic");
    expect(statusText(game({ status: "duplicate", action: "skip" }))).toBe("Same as another game in the file, Mythic saved it twice");
    expect(applyLabel([game(), game({ action: "skip" }), game({ action: "link" })])).toBe("Import 2 games");
    expect(applyLabel([game({ action: "skip" })])).toBe("Nothing to import");
  });

  it("starts players on their earlier match, else the suggested member", () => {
    expect(
      initialMatches([
        { mythic_id: "2", name: "Chris", games: 3, member_id: "m1", suggested: "m9" },
        { mythic_id: "3", name: "Dana", games: 1, member_id: null, suggested: "m2" },
        { mythic_id: "4", name: "Eli", games: 1, member_id: null, suggested: null },
      ]),
    ).toEqual({ 2: "m1", 3: "m2", 4: null });
    // Two players suggested the same member: only the first gets it.
    expect(
      initialMatches([
        { mythic_id: "2", name: "Chris", games: 3, member_id: "m1", suggested: null },
        { mythic_id: "5", name: "Chris B", games: 1, member_id: null, suggested: "m1" },
      ]),
    ).toEqual({ 2: "m1", 5: null });
  });

  it("sums up an import", () => {
    expect(resultText({ created: 3, updated: 0, linked: 1, notes: 1, kept: 0, skipped: 2, errors: [] })).toBe("3 imported, 1 matched to games already in Yama, 1 with Mythic notes updated, 2 skipped.");
    expect(resultText({ created: 0, updated: 0, linked: 0, notes: 0, kept: 0, skipped: 0, errors: [] })).toBe("Nothing changed.");
  });

  it("ships a snippet that parses and only reads from Mythic", () => {
    // Parsing it as a function body checks the syntax without running it.
    expect(() => new Function(MYTHIC_SNIPPET)).not.toThrow();
    // It calls Mythic's page, Firebase's token refresh and Mythic's API, nothing else.
    const targets = [...MYTHIC_SNIPPET.matchAll(/fetch\(([^,)]+)/g)].map((m) => (m[1] ?? "").trim());
    expect(targets).toEqual(['"/login"', '"https://securetoken.googleapis.com/v1/token?key=" + cfg.FIREBASE_API_KEY', "API + path"]);
    for (const write of ['"PUT"', '"DELETE"', '"PATCH"']) expect(MYTHIC_SNIPPET).not.toContain(write);
    // The POSTs are the token refresh and Mythic's own sign-in, which its web app also sends.
    expect(MYTHIC_SNIPPET.match(/"POST"/g)).toHaveLength(2);
    expect(MYTHIC_SNIPPET).toContain('call("POST", "/auth/signin"');
  });

  it("says what Apply does with each deck", () => {
    const deck = (over: Partial<MythicDeckRow> = {}): MythicDeckRow => ({ mythic_id: "9", name: "Ramp", status: "new", action: "import", yama_id: null, yama_name: null, matches: [], cards: 100, commanders: [], unknown: [], reason: null, ...over });
    expect(deckStatusText(deck())).toBe("New, imported into the Mythic Tools folder");
    expect(deckStatusText(deck({ status: "match", action: "link", yama_name: "Éowyn" }))).toBe('Same commander as "Éowyn", linked to it');
    expect(deckStatusText(deck({ status: "yama_changed", action: "skip", yama_name: "Éowyn" }))).toBe('"Éowyn" changed since; send it to Mythic from its page');
    expect(deckApplyLabel([deck(), deck({ action: "skip" })])).toBe("Import 1 deck");
  });

  it("sends the commander and main deck, and names cards with no printing", () => {
    const card = (name: string, board: "commander" | "main" | "side", printing: boolean) => ({
      oracle_id: name, name, qty: 1, board, card: null, owned: 0, in_deck_container: 0, proxies: 0, locations: {}, needed: 1, cheapest_usd: null, produced_mana: null,
      printing: printing ? { set_code: "ltc", collector_number: "1", finish: "foil", from: "owned" as const } : null,
    });
    const { cards, missing } = sendCards({ cards: [card("Éowyn", "commander", true), card("Sol Ring", "main", false), card("Spare", "side", true)] });
    expect(cards.map((c) => c.name)).toEqual(["Éowyn", "Sol Ring"]);
    expect(cards[0]?.printing).toEqual({ set_code: "ltc", collector_number: "1", finish: "foil" });
    expect(missing).toEqual(["Sol Ring"]);
  });

  it("ships a send snippet that parses and carries the deck as data", () => {
    const s = mythicSendSnippet({ code: "c0de", mythic_id: null, name: 'Deck "quoted" \u2028', privacy: "private", cards: [], back: "https://yama.ing/mythic/sent" });
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain('"code":"c0de"');
    // Mythic's own deck requests, and Yama only as the page it opens at the end.
    for (const call of ['call("POST", "/deck"', '"/user/lists/" + deck.deck.listid + "/cards"', "window.open(back"]) expect(s).toContain(call);
  });
});
