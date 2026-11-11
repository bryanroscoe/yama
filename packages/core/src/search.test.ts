import { describe, expect, it } from "vitest";
import { compileSearch, GAME_CHANGERS_NOT_LOADED, namePhrase, nameRank, needsConnection, orderUsed, searchOffline, type OfflineCard } from "./search";

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

  it("reads the is: values the card list can answer, as the server does", () => {
    const more = [
      card({ n: "Tymna the Weaver", t: "Legendary Creature — Human Cleric", k: ["lifelink", "partner"], o: "Lifelink\nPartner" }),
      card({ n: "Wilson, Refined Grizzly", t: "Legendary Creature — Bear Warrior", k: ["choose a background", "reach"], o: "Reach, trample, ward {2}\nChoose a Background" }),
      card({ n: "Lurrus of the Dream-Den", t: "Legendary Creature — Cat Nightmare", m: "{1}{W/B}{W/B}", k: ["companion", "lifelink"], o: "Companion\nLifelink" }),
      card({ n: "Gitaxian Probe", t: "Sorcery", m: "{U/P}", o: "Look at target player's hand." }),
      card({ n: "Grizzly Bears", t: "Creature — Bear", m: "{1}{G}" }),
      card({ n: "Valakut Awakening // Valakut Stoneforge", t: "Instant // Land", y: "modal_dfc", m: "{2}{R}" }),
      card({ n: "Delver of Secrets // Insectile Aberration", t: "Creature — Human Wizard // Creature — Human Insect", y: "transform", o: "At the beginning of your upkeep, look at the top card of your library." }),
      card({ n: "Fire // Ice", t: "Instant // Instant", y: "split" }),
      card({ n: "The Eldest Reborn", t: "Enchantment — Saga", y: "saga" }),
      card({ n: "Forest", t: "Basic Land — Forest", m: null, y: null }),
      card({ n: "Spellskite", t: "Artifact Creature — Phyrexian Horror", m: "{2}", o: "{U/P}: Change a target of target spell or ability to Spellskite." }),
      card({ n: "Diviner's Wand", t: "Kindred Artifact — Wizard Equipment", m: "{3}", o: "Equipped creature has a draw ability." }),
      card({ n: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", t: "Enchantment — Saga // Enchantment Creature — Goblin Shaman", y: "transform", o: "Read ahead." }),
      card({ n: "Bonecrusher Giant // Stomp", t: "Creature — Giant // Instant — Adventure", y: "adventure", o: "Stomp deals 2 damage." }),
      card({ n: "Marang River Regent // Coil and Catch", t: "Creature — Dragon // Instant — Omen", y: "adventure", o: "Draw three cards." }),
    ];
    const is = (q: string) => searchOffline(more, q).map((c) => c.n);
    expect(is("is:partner")).toEqual(["Tymna the Weaver", "Wilson, Refined Grizzly"]);
    expect(is("is:companion")).toEqual(["Lurrus of the Dream-Den"]);
    expect(is("is:hybrid")).toEqual(["Lurrus of the Dream-Den"]);
    // Phyrexian mana in the cost or in the text.
    expect(is("is:phyrexian")).toEqual(["Gitaxian Probe", "Spellskite"]);
    expect(is("is:vanilla")).toEqual(["Grizzly Bears"]);
    expect(is("is:mdfc")).toEqual(["Valakut Awakening // Valakut Stoneforge"]);
    expect(is("is:transform")).toEqual(["Delver of Secrets // Insectile Aberration", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
    expect(is("is:dfc")).toEqual(["Delver of Secrets // Insectile Aberration", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "Valakut Awakening // Valakut Stoneforge"]);
    expect(is("is:Split")).toEqual(["Fire // Ice"]);
    // A Saga by its type line, whatever its layout; an Omen isn't an Adventure.
    expect(is("is:saga")).toEqual(["Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "The Eldest Reborn"]);
    expect(is("is:adventure")).toEqual(["Bonecrusher Giant // Stomp"]);
    expect(is("is:historic")).toEqual([
      "Diviner's Wand", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "Lurrus of the Dream-Den", "Spellskite", "The Eldest Reborn", "Tymna the Weaver", "Wilson, Refined Grizzly",
    ]);
    // A party is creatures: the Wizard's wand isn't in it.
    expect(is("is:party")).toEqual(["Delver of Secrets // Insectile Aberration", "Tymna the Weaver", "Wilson, Refined Grizzly"]);
    expect(is("is:outlaw")).toEqual([]);
    // A card with no mana cost or layout isn't hybrid or a split card, and is found by the negation.
    expect(is("-is:hybrid -is:split t:basic")).toEqual(["Forest"]);
    expect(() => is("is:nonsense")).toThrow("unsupported is:nonsense");
    // A word every object has isn't an is: value (the server refuses these too).
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(() => is(`is:${word}`), word).toThrow(`unsupported is:${word}`);
  });

  it("refuses what needs printings or prices with a reason, after reading it as the server does", () => {
    for (const [q, what] of [["set:cmm", "set"], ["s:cmm", "set"], ["e:cmm", "set"], ["edition:cmm", "set"], ['a:"rebecca guay"', "artist"], ["artist:guay", "artist"], ["year>=2020", "year"], ["usd<5", "price"], ["usd>=$2.50", "price"], ["is:reserved", "the Reserve List"]] as const) {
      expect(() => searchOffline(cards, q), q).toThrow(needsConnection(what));
    }
    // Inside a longer search too: part of the answer would be a wrong answer.
    expect(() => searchOffline(cards, "t:artifact (usd<5 or mv<1)")).toThrow(needsConnection("price"));
    // A value the server refuses is refused the same way here.
    expect(() => searchOffline(cards, "year:soon")).toThrow("soon isn't a year");
    expect(() => searchOffline(cards, "year:94")).toThrow("94 isn't a year");
    expect(() => searchOffline(cards, "year>2020.5")).toThrow("2020.5 isn't a year");
    expect(() => searchOffline(cards, "usd<cheap")).toThrow("cheap isn't a price");
    // Only what the server's parser reads as a number: no hex, no spaces.
    expect(() => searchOffline(cards, "year:0x7e4")).toThrow("0x7e4 isn't a year");
    expect(() => searchOffline(cards, 'year:" 2020 "')).toThrow("isn't a year");
    expect(() => searchOffline(cards, "usd:0x10")).toThrow("0x10 isn't a price");
    // A set or an artist is or isn't: another comparison is refused, as on the server.
    for (const q of ["set!=cmm", "set>cmm", "e<lea"]) expect(() => searchOffline(cards, q), q).toThrow("takes : or =");
    expect(() => searchOffline(cards, "a!=guay")).toThrow("a takes : or =, not !=");
    // The Reserve List isn't a printing or a price: its reason says what is missing.
    expect(needsConnection("the Reserve List")).toBe("Searching by the Reserve List needs a connection: the copy on this device doesn't say which cards are on it.");
    // The device has no prices or dates to sort by: those orders are the order by name.
    for (const order of ["usd", "usd_asc", "released", "released_asc"] as const) {
      expect(searchOffline(cards, "t:artifact", order).map((c) => c.n)).toEqual(["Jeweled Lotus", "Sol Ring"]);
      expect(orderUsed(order)).toBe("name");
    }
    expect(["name", "edhrec", "mv", "color", "anything"].map(orderUsed)).toEqual(["name", "edhrec", "mv", "color", "name"]);
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
