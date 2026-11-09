import { describe, expect, it } from "vitest";
import { deckStatus, pickerGroups, recordLine } from "./DeckHeader";

const ref = (id: string, configuration: string | null) => ({ id, name: "Revival Trance", configuration, visibility: "private" as const, share_token: null });
const base = {
  id: "main",
  parent_id: null,
  configurations: [ref("main", null)],
  acquisition_status: "owned",
  validation: { ok: true, total: 100, color_identity: "WBR", errors: [], warnings: [] },
  ownership: { cards: 100, owned: 75, proxies: 25, needed: 0, needed_cost_usd: null, needed_without_price: 0, price_date: null },
} as never as Parameters<typeof deckStatus>[0];

describe("the deck's status pill", () => {
  it("says ready to play with real cards and proxies", () => {
    expect(deckStatus(base)).toEqual({ tone: "good", pill: "Ready to play", line: "Commander-legal. 75 real, 25 proxies" });
  });
  it("says how many cards are still needed", () => {
    const s = deckStatus({ ...base, ownership: { ...base.ownership, owned: 90, proxies: 0, needed: 10 } });
    expect(s).toEqual({ tone: "warn", pill: "Need 10 cards", line: "Commander-legal. 90 of 100 real" });
    const priced = deckStatus({ ...base, ownership: { ...base.ownership, owned: 90, proxies: 0, needed: 10, needed_cost_usd: 42.5, needed_without_price: 1, price_date: "2026-11-07" } });
    expect(priced.line).toMatch(/^Commander-legal\. 90 of 100 real\. \$42\.50 to finish, 1 without a price, Nov 7/);
  });
  it("puts the first legality error in the line", () => {
    const s = deckStatus({ ...base, validation: { ...base.validation, ok: false, errors: ["99 cards, needs 100", "Two commanders"] } });
    expect(s).toEqual({ tone: "bad", pill: "Not legal yet", line: "99 cards, needs 100" });
  });
  it("marks a saved list and a planned deck", () => {
    const configurations = [ref("main", null), ref("stock", "stock")];
    expect(deckStatus({ ...base, id: "stock", parent_id: "main", configurations }).pill).toBe("Saved list");
    expect(deckStatus({ ...base, acquisition_status: "planned" }).pill).toBe("Planned deck");
  });
});

describe("the record tile", () => {
  it("counts wins in games, and says so before the first game", () => {
    expect(recordLine({ games: 7, wins: 3 })).toEqual({ big: "3", line: "wins in 7 games" });
    expect(recordLine({ games: 1, wins: 1 })).toEqual({ big: "1", line: "win in 1 game" });
    expect(recordLine({ games: 0 })).toEqual({ big: "0", line: "No games yet" });
  });
});

describe("the List picker", () => {
  it("groups the list in the box, saved lists and older snapshots", () => {
    const configurations = [ref("main", null), ref("stock", "stock"), ref("b3", "Bracket 3"), ref("now", "now"), ref("ap", "after prints")];
    const g = pickerGroups({ id: "b3", parent_id: "main", configurations });
    expect(g.box.id).toBe("main");
    expect(g.saved.map((c) => c.id)).toEqual(["stock", "b3"]);
    expect(g.older.map((c) => c.id)).toEqual(["now", "ap"]);
  });
  it("has only the box for a deck with one list", () => {
    const g = pickerGroups({ id: "main", parent_id: null, configurations: [ref("main", null)] });
    expect(g.box.id).toBe("main");
    expect(g.saved).toEqual([]);
  });
});
