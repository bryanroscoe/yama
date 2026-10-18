import { describe, expect, it } from "vitest";
import { compileSearch, searchOffline, type OfflineCard } from "./search";

const card = (o: Partial<OfflineCard> & { n: string }): OfflineCard => ({
  i: o.n, m: null, v: 0, t: "", o: "", c: "", ci: "", p: null, th: null, l: null, r: "common", k: [],
  f: { commander: "legal" }, y: "normal", img: null, e: null, ...o,
});

const cards = [
  card({ n: "Omo, Queen of Vesuva", t: "Legendary Creature — Shapeshifter", c: "UG", ci: "UG", v: 3, p: "1", th: "5" }),
  card({ n: "Lightning Bolt", t: "Instant", o: "Lightning Bolt deals 3 damage to any target.", c: "R", ci: "R", v: 1 }),
  card({ n: "Sol Ring", t: "Artifact", o: "{T}: Add {C}{C}.", v: 1 }),
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
