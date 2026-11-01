import { describe, expect, it } from "vitest";
import { applyLabel, initialMatches, parseExport, resultText, statusText, type MythicGameRow } from "./mythic";
import { MYTHIC_SNIPPET } from "./snippet";

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
    expect(statusText(game({ status: "invalid", action: "skip", reason: "it isn't finished in Mythic" }))).toBe("Can't import: it isn't finished in Mythic");
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
  });

  it("sums up an import", () => {
    expect(resultText({ created: 3, updated: 0, linked: 1, skipped: 2, errors: [] })).toBe("3 imported, 1 matched to games already in Yama, 2 skipped.");
    expect(resultText({ created: 0, updated: 0, linked: 0, skipped: 0, errors: [] })).toBe("Nothing changed.");
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
});
