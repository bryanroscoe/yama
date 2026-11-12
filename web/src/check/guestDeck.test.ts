import { describe, expect, it } from "vitest";
import { analysis } from "../decks/analysisFixture";
import {
  asDeckView,
  commanderChoices,
  deckName,
  listProblem,
  MAX_LINES,
  newGuestDeck,
  playsLikeRange,
  readGuestDeck,
  rulesNote,
  saveRequest,
  SAVE_WINDOW_MS,
  saveWanted,
  writeGuestDeck,
  type CheckedCard,
  type ListCheck,
} from "./guestDeck";

/** A storage that holds strings, as the browser's does. */
function memory(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  };
}

const card = (name: string, board: CheckedCard["board"], can_lead = false, qty = 1): CheckedCard => ({
  oracle_id: `o-${name}`,
  name,
  qty,
  board,
  card: null,
  cheapest_usd: null,
  cheapest_printing: null,
  produced_mana: null,
  can_lead,
});

const check = (cards: CheckedCard[], over: Partial<ListCheck> = {}): ListCheck => ({
  cards,
  unknown: [],
  commander_guessed: false,
  validation: { ok: true, total: cards.filter((c) => c.board !== "side").reduce((n, c) => n + c.qty, 0), color_identity: "G", errors: [], warnings: [] },
  game_changers: [],
  game_changers_as_of: "2026-11-01",
  reserved_list: [],
  reserved_list_as_of: "2026-11-01",
  singles_value: { usd: 12.5, priced_copies: 2, unpriced_copies: 1, oldest_date: "2026-11-09", newest_date: "2026-11-10", source: "TCGplayer market via Scryfall" },
  analysis: analysis(5.4),
  ...over,
});

describe("the list kept in the browser", () => {
  it("is still there on the next visit, with its commander pick and its save id", () => {
    const storage = memory();
    const deck = { ...newGuestDeck("1 Omo\n1 Sol Ring", "  Lands  "), commanders: ["o-Omo"] };
    expect(deck.name).toBe("Lands");
    expect(deck.opId).toBeTruthy();
    expect(writeGuestDeck(deck, storage)).toBe(true);
    expect(readGuestDeck(storage)).toEqual(deck);
    // Only that one key holds it.
    expect([...storage.held.keys()]).toEqual(["yama.check.deck"]);
  });

  it("is forgotten when cleared", () => {
    const storage = memory();
    writeGuestDeck(newGuestDeck("1 Sol Ring"), storage);
    expect(writeGuestDeck(null, storage)).toBe(true);
    expect(readGuestDeck(storage)).toBeNull();
    expect(storage.held.size).toBe(0);
  });

  it("reads nothing from what isn't a list, and removes it", () => {
    for (const raw of ["null", "{}", JSON.stringify({ text: "  ", opId: "a" }), JSON.stringify({ text: "1 Sol Ring" }), JSON.stringify({ text: 5, opId: "a" })]) {
      const storage = memory({ "yama.check.deck": raw });
      expect(readGuestDeck(storage), raw).toBeNull();
      expect(storage.held.size, raw).toBe(0);
    }
    expect(readGuestDeck(memory({ "yama.check.deck": "{not json" }))).toBeNull();
  });

  it("keeps what it can of an older or edited record", () => {
    const storage = memory({ "yama.check.deck": JSON.stringify({ text: "1 Sol Ring", opId: "op", name: 7, commanders: ["a", 3, "b", "c"], saveAsked: "soon" }) });
    expect(readGuestDeck(storage)).toEqual({ name: "", text: "1 Sol Ring", commanders: ["a", "b"], opId: "op", saveAsked: undefined });
  });

  it("works without storage: nothing is read and the page is told nothing was kept", () => {
    expect(readGuestDeck(null)).toBeNull();
    expect(writeGuestDeck(newGuestDeck("1 Sol Ring"), null)).toBe(false);
    const full = { ...memory(), setItem: () => { throw new Error("quota"); } };
    expect(writeGuestDeck(newGuestDeck("1 Sol Ring"), full)).toBe(false);
  });

  it("gives every new list its own save id", () => {
    expect(newGuestDeck("1 Sol Ring").opId).not.toBe(newGuestDeck("1 Sol Ring").opId);
  });
});

describe("what stops a list from being checked", () => {
  it("is an empty box, too many lines or too much text, as the server would refuse them", () => {
    expect(listProblem(" \n ")).toBe("Paste a deck list first.");
    expect(listProblem("1 Sol Ring\n1 Forest")).toBeNull();
    expect(listProblem(Array.from({ length: MAX_LINES }, () => "1 Forest").join("\n"))).toBeNull();
    expect(listProblem(Array.from({ length: MAX_LINES + 1 }, () => "1 Forest").join("\n"))).toContain("more than 300 lines");
    expect(listProblem("é".repeat(40_000))).toBe("That's too much text for one deck.");
  });
});

describe("saving after signing in", () => {
  it("happens by itself only soon after Sign in to save this deck was pressed", () => {
    const asked = 1_000_000;
    expect(saveWanted({ saveAsked: asked }, asked + 60_000)).toBe(true);
    expect(saveWanted({ saveAsked: asked }, asked + SAVE_WINDOW_MS)).toBe(true);
    expect(saveWanted({ saveAsked: asked }, asked + SAVE_WINDOW_MS + 1)).toBe(false);
    // Never pressed, or a clock that went backwards.
    expect(saveWanted({}, asked)).toBe(false);
    expect(saveWanted({ saveAsked: asked }, asked - 1)).toBe(false);
  });

  it("sends the cards as read, under the list's own id and name", () => {
    const deck = { ...newGuestDeck("…"), opId: "op-1" };
    const r = check([card("Omo, Queen of Vesuva", "commander", true), card("Forest", "main", false, 30), card("Lightning Bolt", "side")]);
    expect(saveRequest(deck, r)).toEqual({
      name: "Omo, Queen of Vesuva",
      cards: [
        { oracle_id: "o-Omo, Queen of Vesuva", name: "Omo, Queen of Vesuva", qty: 1, board: "commander" },
        { oracle_id: "o-Forest", name: "Forest", qty: 30, board: "main" },
        { oracle_id: "o-Lightning Bolt", name: "Lightning Bolt", qty: 1, board: "side" },
      ],
      op_id: "op-1",
    });
    expect(saveRequest({ ...deck, name: "Lands matter" }, r).name).toBe("Lands matter");
  });
});

describe("the list as the deck page's parts read it", () => {
  it("is named by the person, else after its commanders, else plainly", () => {
    const two = check([card("Tana", "commander", true), card("Tymna", "commander", true)]);
    expect(deckName({ name: "  Mine " }, two)).toBe("Mine");
    expect(deckName({ name: "" }, two)).toBe("Tana and Tymna");
    expect(deckName({ name: "" }, check([card("Sol Ring", "main")]))).toBe("Checked deck");
    expect(deckName({ name: "" }, null)).toBe("Checked deck");
  });

  it("offers each card that could lead once, never from the sideboard", () => {
    const r = check([card("Sol Ring", "main"), card("Omo", "main", true), card("Tana", "commander", true), card("Omo", "main", true), card("Kenrith", "side", true)]);
    expect(commanderChoices(r).map((c) => c.name)).toEqual(["Omo", "Tana"]);
  });

  it("carries nothing of an account: no copies owned, no id, no version, private", () => {
    const r = check([card("Omo", "commander", true), card("Forest", "main", false, 99)], { game_changers: ["Omo"] });
    const view = asDeckView("Lands", r);
    expect(view).toMatchObject({ id: "", name: "Lands", version_id: null, container_id: null, bracket: null, visibility: "private", share_token: null, configurations: [], game_changers: ["Omo"] });
    expect(view.cards.map((c) => [c.name, c.qty, c.owned, c.proxies, c.needed, c.locations, c.printing])).toEqual([
      ["Omo", 1, 0, 0, 0, {}, null],
      ["Forest", 99, 0, 0, 0, {}, null],
    ]);
    expect(view.ownership).toMatchObject({ cards: 100, owned: 0, needed: 0, price_date: "2026-11-10" });
    expect(view.singles_value).toBe(r.singles_value);
    expect(view.buylist).toBeUndefined();
  });

  it("says what the list plays like as one bracket or a range, and what the card rules allow", () => {
    expect(playsLikeRange(analysis(5.4))).toBe("2 to 3");
    expect(playsLikeRange(analysis(3))).toBe("2");
    expect(playsLikeRange({ power_bracket: 4, bracket: undefined })).toBe("4");
    expect(rulesNote(analysis(5.4))).toBe("Card rules allow 2 or higher");
    expect(rulesNote({ bracket: { plays_like: [2, 3], rules: null, flags: [] } })).toBeNull();
  });
});
