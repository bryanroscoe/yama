import { describe, expect, it } from "vitest";
import { compileSearch, GAME_CHANGERS_NOT_LOADED, namePhrase, nameRank, searchOffline, type OfflineCard } from "./search";

const card = (o: Partial<OfflineCard> & { n: string }): OfflineCard => ({
  i: o.n, m: null, v: 0, t: "", o: "", c: "", ci: "", p: null, th: null, l: null, r: "common", k: [],
  f: { commander: "legal" }, y: "normal", img: null, e: null, ...o,
});

const cards = [
  card({ n: "Omo, Queen of Vesuva", t: "Legendary Creature — Shapeshifter", c: "UG", ci: "UG", v: 3, p: "1", th: "5" }),
  card({ n: "Lightning Bolt", t: "Instant", o: "Lightning Bolt deals 3 damage to any target.", c: "R", ci: "R", v: 1 }),
  card({ n: "Sol Ring", t: "Artifact", o: "{T}: Add {C}{C}.", v: 1, g: true }),
  card({ n: "Llanowar Elves", t: "Creature — Elf Druid", c: "G", ci: "G", v: 1, p: "1", th: "1" }),
  card({ n: "Jeweled Lotus", t: "Artifact", v: 0, f: { commander: "banned" } }),
  card({ n: "Goblin Token", t: "Token Creature — Goblin", c: "R", ci: "R", y: "token" }),
];
const names = (q: string) => searchOffline(cards, q).map((c) => c.n);

describe("offline search", () => {
  it("matches the server's grammar", () => {
    expect(names("id<=ug is:commander")).toEqual(["Omo, Queen of Vesuva"]);
    expect(names("id:ug")).toEqual(["Jeweled Lotus", "Llanowar Elves", "Omo, Queen of Vesuva", "Sol Ring"]);
    expect(names("(t:elf or t:instant) mv=1")).toEqual(["Lightning Bolt", "Llanowar Elves"]);
    expect(names('o:"~ deals"')).toEqual(["Lightning Bolt"]);
    expect(names('!"sol ring"')).toEqual(["Sol Ring"]);
    expect(names("banned:commander")).toEqual(["Jeweled Lotus"]);
    expect(names("t:artifact -f:commander")).toEqual(["Jeweled Lotus"]);
    expect(names("pow>=1 tou>1")).toEqual(["Omo, Queen of Vesuva"]);
    expect(names("is:gamechanger")).toEqual(["Sol Ring"]);
    expect(names("is:gc")).toEqual(["Sol Ring"]);
    expect(names("t:artifact -is:GameChanger")).toEqual(["Jeweled Lotus"]);
  });

  it("won't answer is:gamechanger from a card list without the flags", () => {
    // An older saved list (or one made before the server loaded the flags) has no "g" at all.
    expect(() => searchOffline(cards, "is:gc", "name", { gameChangers: false })).toThrow(GAME_CHANGERS_NOT_LOADED);
    expect(() => searchOffline(cards, "t:artifact -is:gamechanger", "name", { gameChangers: false })).toThrow();
    expect(searchOffline(cards, "t:artifact", "name", { gameChangers: false }).map((c) => c.n)).toEqual(["Jeweled Lotus", "Sol Ring"]);
  });

  it("hides tokens unless asked", () => {
    expect(names("goblin")).toEqual([]);
    expect(names("t:token")).toEqual(["Goblin Token"]);
  });

  it("reports bad queries", () => {
    expect(() => compileSearch("c:xyz")).toThrow();
    expect(() => compileSearch("(t:elf")).toThrow();
    expect(() => compileSearch("mv>=abc")).toThrow();
  });
});

describe("a typed name, in step with the server (cards/search.rs name_phrase, name_rank)", () => {
  // Every one of these has "sol" and "ring" somewhere in its name.
  const pool = ["Searing Soloist", "Insolent Ringleader", "Sol Ringbearer", "Absolver of Rings", "Sol Ring"].map((n) => card({ n, t: "Artifact", v: n === "Sol Ring" ? 1 : 3 }));
  const found = (q: string, order?: "name" | "mv") => searchOffline(pool, q, order).map((c) => c.n);

  it("puts the card of that name first, then names that start with it, then A to Z", () => {
    const byName = ["Sol Ring", "Sol Ringbearer", "Absolver of Rings", "Insolent Ringleader", "Searing Soloist"];
    expect(found("sol ring")).toEqual(byName);
    expect(found("SOL RING t:artifact", "name")).toEqual(byName);
    expect(found('"sol ring"')).toEqual(["Sol Ring", "Sol Ringbearer"]);
    expect(found("sol").slice(0, 2)).toEqual(["Sol Ring", "Sol Ringbearer"]);
  });

  it("leaves a search with no typed name, or another order, as it was", () => {
    expect(found("t:artifact").slice(0, 2)).toEqual(["Absolver of Rings", "Insolent Ringleader"]);
    expect(found("sol ring", "mv").slice(0, 2)).toEqual(["Sol Ring", "Absolver of Rings"]);
  });

  it("reads the typed name as the server does", () => {
    expect(namePhrase("sol ring")).toBe("sol ring");
    expect(namePhrase("Sol  Ring t:artifact")).toBe("sol ring");
    expect(namePhrase('"Sol Ring" mv<=1')).toBe("sol ring");
    expect(namePhrase("ring -sol")).toBe("ring");
    // A negated group excludes everything in it, however deep; the words after it count.
    expect(namePhrase("-(sol ring) lotus")).toBe("lotus");
    expect(namePhrase("-(sol (ring or petal)) black lotus")).toBe("black lotus");
    expect(namePhrase("(sol ring) -(t:artifact bloom)")).toBe("sol ring");
    expect(namePhrase("-(sol ring)")).toBeNull();
    expect(namePhrase('!"Sol Ring"')).toBeNull();
    expect(namePhrase("t:artifact id<=w")).toBeNull();
    expect(namePhrase("")).toBeNull();
    expect(namePhrase('o:"open')).toBeNull();
    expect([nameRank("Sol Ring", "sol ring"), nameRank("Sol Ringbearer", "sol ring"), nameRank("Searing Soloist", "sol ring")]).toEqual([0, 1, 2]);
  });
});
