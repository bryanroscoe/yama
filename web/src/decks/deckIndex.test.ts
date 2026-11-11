import { describe, expect, it } from "vitest";
import { arrangeDecks, folderMoveProblem, folderOf, foldersOf, isFiltered, isFollowedFolder, NO_FOLDER, readFilter, shownText, writeFilter, type DeckFilter, type DeckGroup } from "./deckIndex";

type D = DeckGroup["main"];
const deck = (name: string, over: Partial<D> = {}): D => ({ id: name, name, folder: null, commanders: [], color_identity: "", bracket: null, updated_at: "2026-01-01T00:00:00Z", games: 0, wins: 0, configuration: null, ...over });
const group = (name: string, over: Partial<D> = {}, configurations: D[] = []): DeckGroup => ({ main: deck(name, over), configurations });
const ANY: DeckFilter = { q: "", folder: null, colors: "", bracket: "", sort: "name" };
const names = (groups: DeckGroup[], f: Partial<DeckFilter>) => arrangeDecks(groups, { ...ANY, ...f }).map((g) => g.main.name);

const DECKS = [
  group("Omo Lands", { folder: "Brews", commanders: ["Omo, Queen of Vesuva"], color_identity: "GU", bracket: 3, updated_at: "2026-03-01T00:00:00Z", games: 4, wins: 3 }),
  group("atraxa counters", { folder: " Precons ", commanders: ["Atraxa, Praetors' Voice"], color_identity: "WUBG", updated_at: "2026-02-01T00:00:00Z", games: 10, wins: 5 }),
  group("Krenko", { commanders: ["Krenko, Mob Boss"], color_identity: "R", updated_at: "2026-01-15T00:00:00Z" }, [deck("Krenko budget", { configuration: "Budget", commanders: ["Krenko, Tin Street Kingpin"], updated_at: "2026-04-01T00:00:00Z" })]),
  group("Éowyn Humans", { folder: "Precons", commanders: ["Éowyn, Shieldmaiden"], color_identity: "WUR", bracket: 2, games: 2, wins: 1 }),
];

describe("folders", () => {
  it("trims a folder and reads a blank one as none", () => {
    expect(folderOf({ folder: " Precons " })).toBe("Precons");
    expect(folderOf({ folder: "  " })).toBeNull();
    expect(folderOf({ folder: null })).toBeNull();
  });

  it("lists each folder once, A to Z", () => {
    expect(foldersOf(DECKS.map((g) => g.main))).toEqual(["Brews", "Precons"]);
  });

  it("keeps one folder's decks, or the decks in none", () => {
    expect(names(DECKS, { folder: "Precons" })).toEqual(["atraxa counters", "Éowyn Humans"]);
    expect(names(DECKS, { folder: NO_FOLDER })).toEqual(["Krenko"]);
  });
});

describe("folders an import keeps for itself", () => {
  it("knows the Mythic Tools folder, whatever its case", () => {
    expect(isFollowedFolder("Mythic Tools")).toBe(true);
    expect(isFollowedFolder(" mythic tools ")).toBe(true);
    expect(isFollowedFolder("Precons")).toBe(false);
    expect(isFollowedFolder(null)).toBe(false);
  });

  it("won't move a deck out of it, which would stop the import updating the deck", () => {
    expect(folderMoveProblem("Mythic Tools", "Brews")).toBe("This deck follows your Mythic Tools imports, which keep it in this folder.");
    expect(folderMoveProblem("Mythic Tools", "")).not.toBeNull();
    expect(folderMoveProblem("Mythic Tools", "Mythic Tools ")).toBeNull();
  });

  it("won't move a deck into it, which would let the next import replace the deck's list", () => {
    expect(folderMoveProblem("Brews", "mythic tools")).toBe("Mythic Tools is the folder for decks that follow that import. Pick another name.");
    expect(folderMoveProblem(null, "Mythic Tools")).not.toBeNull();
  });

  it("lets any other move through", () => {
    expect(folderMoveProblem("Brews", "Precons")).toBeNull();
    expect(folderMoveProblem(null, "Brews")).toBeNull();
    expect(folderMoveProblem("Brews", "")).toBeNull();
  });
});

describe("filters", () => {
  it("searches names and commanders, every word, ignoring case and accents", () => {
    expect(names(DECKS, { q: "omo" })).toEqual(["Omo Lands"]);
    expect(names(DECKS, { q: "praetors atraxa" })).toEqual(["atraxa counters"]);
    expect(names(DECKS, { q: "eowyn" })).toEqual(["Éowyn Humans"]);
    expect(names(DECKS, { q: "nothing here" })).toEqual([]);
  });

  it("finds a deck by one of its other lists", () => {
    expect(names(DECKS, { q: "tin street" })).toEqual(["Krenko"]);
    expect(names(DECKS, { q: "budget" })).toEqual(["Krenko"]);
  });

  it("keeps decks whose colors include every color picked", () => {
    expect(names(DECKS, { colors: "U" })).toEqual(["atraxa counters", "Éowyn Humans", "Omo Lands"]);
    expect(names(DECKS, { colors: "UG" })).toEqual(["atraxa counters", "Omo Lands"]);
    expect(names(DECKS, { colors: "R" })).toEqual(["Éowyn Humans", "Krenko"]);
  });

  it("filters on the bracket the owner declared, never a suggestion", () => {
    // Atraxa has no declared bracket (whatever Yama suggests for it), so it is under none.
    expect(names(DECKS, { bracket: "2" })).toEqual(["Éowyn Humans"]);
    expect(names(DECKS, { bracket: "3" })).toEqual(["Omo Lands"]);
    expect(names(DECKS, { bracket: "none" })).toEqual(["atraxa counters", "Krenko"]);
  });

  it("combines filters", () => {
    expect(names(DECKS, { folder: "Precons", colors: "R" })).toEqual(["Éowyn Humans"]);
  });
});

describe("sorting", () => {
  it("sorts by name, ignoring case and accents", () => {
    expect(names(DECKS, {})).toEqual(["atraxa counters", "Éowyn Humans", "Krenko", "Omo Lands"]);
  });

  it("puts the most recently changed first, counting a deck's other lists", () => {
    expect(names(DECKS, { sort: "recent" })).toEqual(["Krenko", "Omo Lands", "atraxa counters", "Éowyn Humans"]);
  });

  it("sorts by win rate, more games first between equals, unplayed last", () => {
    expect(names(DECKS, { sort: "record" })).toEqual(["Omo Lands", "atraxa counters", "Éowyn Humans", "Krenko"]);
  });

  it("doesn't reorder the list it was given", () => {
    const before = DECKS.map((g) => g.main.name);
    arrangeDecks(DECKS, { ...ANY, sort: "record" });
    expect(DECKS.map((g) => g.main.name)).toEqual(before);
  });
});

describe("the address", () => {
  it("reads a filter and ignores what it doesn't understand", () => {
    expect(readFilter(new URLSearchParams("q=omo&folder=Precons&colors=gu&bracket=3&sort=recent"))).toEqual({ q: "omo", folder: "Precons", colors: "UG", bracket: "3", sort: "recent" });
    expect(readFilter(new URLSearchParams("colors=xyz&bracket=9&sort=price"))).toEqual(ANY);
    expect(readFilter(new URLSearchParams("folder="))).toEqual({ ...ANY, folder: NO_FOLDER });
  });

  it("writes only what isn't the default, and keeps other parameters", () => {
    expect(writeFilter(new URLSearchParams("x=1"), ANY).toString()).toBe("x=1");
    const f: DeckFilter = { q: "omo", folder: NO_FOLDER, colors: "UG", bracket: "none", sort: "record" };
    const written = writeFilter(new URLSearchParams("sort=recent"), f);
    expect(readFilter(written)).toEqual(f);
    expect(writeFilter(written, ANY).toString()).toBe("");
  });

  it("knows when the list is narrowed", () => {
    expect(isFiltered(ANY)).toBe(false);
    expect(isFiltered({ ...ANY, sort: "recent" })).toBe(false);
    expect(isFiltered({ ...ANY, q: " " })).toBe(false);
    expect(isFiltered({ ...ANY, colors: "U" })).toBe(true);
    expect(shownText(3, 12)).toBe("3 of 12 decks");
    expect(shownText(0, 1)).toBe("0 of 1 deck");
  });
});
