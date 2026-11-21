import { describe, expect, it } from "vitest";
import { NameIndex } from "./fuzzy";
import { decide } from "./pipeline";
import { Evidence, expectedOf, hasTwin, looksLikeNumber, progressLine, proofOf, SETTLE, tokenMatch, tokens, withoutTotals } from "./evidence";

const p = (id: string, set: string, number: string, over: { rarity?: string; lang?: string; released_at?: string } = {}) => ({
  scryfall_id: id,
  set_code: set,
  collector_number: number,
  rarity: over.rarity ?? "common",
  lang: over.lang ?? "en",
  released_at: over.released_at ?? "2023-06-01",
});
// Arcane Signet, as the hold-and-read loop sees it: one printing per Commander set, several sets.
const signets = [p("woc", "woc", "145"), p("cmm", "cmm", "390"), p("c21", "c21", "236"), p("ltc", "ltc", "277"), p("moc", "moc", "322")];
const verdict = (printings: ReturnType<typeof p>[], frames: string[][]) => {
  const e = new Evidence(printings);
  for (const f of frames) e.add(f);
  return e.verdict();
};

describe("collector-line evidence", () => {
  it("scores lookalikes as near misses, not misses", () => {
    expect(tokenMatch("WOC", "WOC")).toBe(1);
    expect(tokenMatch("W0C", "WOC")).toBe(0.7);
    expect(tokenMatch("0145", "145", true)).toBe(1);
    expect(tokenMatch("O14S", "145", true)).toBe(0.7);
    expect(tokenMatch("I48", "145", true)).toBe(0.3);
    expect(tokenMatch("390", "145", true)).toBe(0);
  });

  it("settles on one clean read of set code and number, as a proving read did", () => {
    expect(verdict(signets, [["C 0145", "WOC • EN DAN SCOTT"]])).toMatchObject({ kind: "settled", id: "woc" });
  });

  it("settles through lookalikes once they add up", () => {
    expect(verdict(signets, [["C O145\nW0C * EN"]]).kind).toBe("unsure");
    expect(verdict(signets, [["C O145\nW0C * EN"], ["C 0I45\nWOC • EN"]])).toMatchObject({ kind: "settled", id: "woc" });
  });

  it("isn't reset by a stray frame naming another printing", () => {
    const frames = [["0145 C", "WOC • EN"], ["0390 C", "CMM • EN"], ["0145 C", "WOC • EN"]];
    expect(verdict(signets, frames)).toMatchObject({ kind: "settled", id: "woc" });
  });

  it("adds a set code from one frame to a number from another", () => {
    const e = new Evidence(signets);
    e.add(["0145 C", ""]);
    const numberOnly = e.verdict();
    expect(numberOnly).toMatchObject({ kind: "unsure", leader: "woc", numberRead: "145", setRead: null });
    expect(progressLine(numberOnly, signets.length)).toBe("Read the number (145), not the set code yet");
    e.add(["", "WOC • EN"]);
    expect(e.verdict()).toMatchObject({ kind: "settled", id: "woc" });
  });

  it("never settles on one field alone, however often it's read", () => {
    // Three printings in one set: the set code is read every time, the number never.
    const sameSet = [p("a", "sld", "100"), p("b", "sld", "200"), p("c", "sld", "300")];
    const v = verdict(sameSet, Array(10).fill(["SLD • EN"]));
    expect(v).toMatchObject({ kind: "unsure", setRead: "SLD", numberRead: null });
    // And a number read again and again, with no set code, when another printing's number reads like it.
    const near = [p("a", "woc", "145"), p("b", "cmm", "146"), p("c", "c21", "45")];
    expect(verdict(near, Array(10).fill(["0145"])).kind).toBe("unsure");
  });

  // Bryan, 21 Nov 2026: "even though it sees the number, like the 286, if that's enough to know
  // for a particular card, we're good."
  it("settles on the number alone when no other printing's number reads like it, on two exact frames", () => {
    expect(verdict(signets, [["0145"]]).kind).toBe("unsure");
    expect(verdict(signets, [["0145"], ["0145 C"]])).toMatchObject({ kind: "settled", id: "woc", alone: true });
    // With the set code read too it's an ordinary settle.
    expect(verdict(signets, [["0145 C", "WOC • EN"]])).not.toHaveProperty("alone");
    // Lookalike-only reads of it don't count as exact.
    expect(verdict(signets, Array(4).fill(["O14S"])).kind).toBe("unsure");
    // A frame reading another printing's set code exactly leaves it to the set code.
    expect(verdict(signets, [["0145"], ["0145"], ["CMM • EN"]]).kind).toBe("unsure");
    // The List prints the same number, so it's never enough alone. (The original leads on its
    // rarity, so this isn't a tie holding it back.) With the set code read too, the twin guard holds.
    const withList = [p("orig", "mom", "286", { rarity: "mythic" }), p("list", "plst", "MOM-286", { rarity: "rare" }), p("other", "one", "12")];
    expect(verdict(withList, Array(8).fill(["0286 M"]))).toMatchObject({ kind: "unsure", leader: "orig" });
    expect(verdict(withList, Array(8).fill(["0286 M", "MOM • EN"]))).toMatchObject({ kind: "unsure", leader: "orig", twin: true });
    // Nor does a Mystery Booster card settle on a number its own line doesn't print.
    expect(verdict([p("mb1", "mb1", "1234"), p("dom", "dom", "45")], Array(4).fill(["1234 C"])).kind).toBe("unsure");
  });

  // Review of #180: what must never settle on the number alone.
  it("never takes power and toughness, a lookalike set code or a set read against it for the number alone", () => {
    const cards = [p("abc", "abc", "22"), p("xyz", "xyz", "301"), p("def", "def", "157")];
    // "2/2" read without its slash, on the right-hand cut.
    expect(tokens("2 2")).not.toContain("22");
    expect(verdict(cards, Array(4).fill(["XY2 • EN", "2 2"])).kind).toBe("unsure");
    // A bare "22" (glued P/T) isn't the printed form of number 22 ("0022").
    expect(verdict(cards, Array(4).fill(["22"])).kind).toBe("unsure");
    expect(verdict(cards, Array(2).fill(["0022"]))).toMatchObject({ kind: "settled", id: "abc", alone: true });
    // Another candidate's set code read through lookalikes.
    expect(verdict(cards, [["0022", "XY2 • EN"], ["0022"]]).kind).toBe("unsure");
    // A set code read where it's printed that's none of the candidates' (a set the lock left out).
    expect(verdict([p("abc", "abc", "145"), p("def", "def", "390")], Array(2).fill(["0145 C\nQRS • EN"])).kind).toBe("unsure");
    // An artist's name later on the line isn't a glued set code and language.
    expect(tokens("DMU • EN DOMENICO CAVA")).not.toContain("DOM");
  });

  it("reads through stray spaces, a glued rarity letter and the brush mark", () => {
    const cards = [p("mom", "mom", "286", { rarity: "mythic" }), p("one", "one", "12", { rarity: "mythic" }), p("woe", "woe", "331", { rarity: "mythic" })];
    expect(tokens("02 86 M")).toContain("0286");
    expect(tokens("M 19 • EN")).toContain("M19");
    expect(tokens("MOMEENJRYAN VALLE")).toEqual(expect.arrayContaining(["MOM", "EN"]));
    expect(verdict(cards, [["0286M", "MOM•ENJRYAN VALLE"]])).toMatchObject({ kind: "settled", id: "mom" });
    expect(verdict(cards, [["02 86 M\nMOMEEN/RYAN VALLE"]])).toMatchObject({ kind: "settled", id: "mom" });
    // A glued letter that isn't the printing's rarity stays part of the number.
    expect(verdict([p("plain", "10e", "139"), p("star", "10e", "139s")], Array(2).fill(["139S", "10E • EN"]))).toMatchObject({ kind: "settled", id: "star" });
  });

  it("needs only the number on frames before 2014, which print no set code (over two frames: a number alone is less evidence)", () => {
    const old = [p("m10", "m10", "172", { released_at: "2009-07-17" }), p("m11", "m11", "180", { released_at: "2010-07-16" }), p("10e", "10e", "218", { released_at: "2007-07-13" })];
    expect(verdict(old, [["™ & © 2009 Wizards of the Coast 172/249"]]).kind).toBe("unsure");
    expect(verdict(old, Array(2).fill(["™ & © 2009 Wizards of the Coast 172/249"]))).toMatchObject({ kind: "settled", id: "m10" });
  });

  it("holds back on a close race: the margin", () => {
    // Two printings read about equally (each frame names one): no winner.
    const v = verdict(signets, [["0145 C", "WOC • EN"], ["0390 C", "CMM • EN"]]);
    expect(v.kind).toBe("unsure");
    // Well ahead, it settles.
    expect(verdict(signets, [["0145 C", "WOC • EN"], ["0390 C", "CMM • EN"], ["0145 C", "WOC • EN"], ["0145 C", "WOC • EN"]]).kind).toBe("settled");
    expect(SETTLE.margin).toBeGreaterThan(0);
  });

  it("never takes set and number as proof against The List, which prints the original's", () => {
    const withList = [p("orig", "mom", "214"), p("list", "plst", "MOM-214"), p("other", "mom", "215")];
    expect(expectedOf(withList[1]!)).toMatchObject({ set: "MOM", number: "214", list: true });
    const v = verdict(withList, Array(5).fill(["0214 U", "MOM • EN"]));
    expect(v).toMatchObject({ kind: "unsure", twin: true });
    expect(progressLine(v, 3)).toContain("another printing shows the same");
  });

  it("doesn't let a dropped promo suffix prove the plain printing, but a read suffix proves the promo", () => {
    const promo = [p("plain", "10e", "139"), p("star", "10e", "139s"), p("other", "10e", "140")];
    expect(expectedOf(promo[1]!)).toMatchObject({ number: "139S", base: "139", suffix: true });
    // "139" read cleanly over and over: still the plain one or the promo with its S dropped.
    expect(verdict(promo, Array(6).fill(["139/383", "10E • EN"]))).toMatchObject({ kind: "unsure", twin: true });
    // The suffix itself read: the promo.
    expect(verdict(promo, [["139S", "10E • EN"], ["139S", "10E • EN"]])).toMatchObject({ kind: "settled", id: "star" });
  });

  it("counts number/total only with a plausible total, and never power and toughness", () => {
    expect(withoutTotals("281/297 R")).toBe("281 R");
    expect(withoutTotals("030/280 U")).toBe("030 U");
    expect(tokens("9/7")).toEqual([]);
    expect(tokens("13/13")).toEqual([]);
    expect(tokens("™ & © 2016 9/7")).toEqual(["2016"]);
  });

  // Bryan's foil Westvale Abbey // Ormendahl (SOI 281), 15 Nov 2026: "281/297 R" and "SOI • EN"
  // at the bottom left, the back face's "9/7" at the bottom right.
  const westvale = [
    p("soi", "soi", "281", { rarity: "rare", released_at: "2016-04-08" }),
    p("psoi", "psoi", "281s", { rarity: "rare", released_at: "2016-04-02" }),
    p("inr", "inr", "282", { rarity: "rare", released_at: "2025-01-24" }),
    p("sld9", "sld", "9", { rarity: "rare", released_at: "2022-01-01" }),
  ];
  const strip = ["281/297 R", "SOI • EN", "281/297 R\nSOI • EN", "9/7"];

  it("reads a set's prerelease promo as printing the set's own code, so it's a twin of the set's card", () => {
    expect(expectedOf(westvale[1]!)).toMatchObject({ set: "SOI", number: "281S", base: "281", suffix: true });
    // SOI 281 read cleanly, again and again: still the card or its promo with the s dropped.
    expect(verdict(westvale, Array(4).fill(strip))).toMatchObject({ kind: "unsure", leader: "soi", twin: true });
  });

  it("doesn't take a back face's 9/7 for collector number 9", () => {
    const e = new Evidence(westvale);
    e.add(["9/7"]);
    expect(e.verdict()).toMatchObject({ kind: "unsure", leader: null });
  });

  it("settles a two-faced card read from the bottom right as well as the left", () => {
    const noPromo = westvale.filter((x) => x.scryfall_id !== "psoi");
    expect(verdict(noPromo, [strip])).toMatchObject({ kind: "settled", id: "soi" });
    // Only the right-hand cut caught the line (a frame that puts it there).
    expect(verdict(noPromo, [["", "", "", "281/297 R SOI • EN"]])).toMatchObject({ kind: "settled", id: "soi" });
  });

  // Review of #138 (15 Nov 2026): three ways a wrong printing could have been filed by itself.
  it("never lets one token prove both fields (SLD read as SLD #510's number through lookalikes)", () => {
    expect(looksLikeNumber("SLD")).toBe(false);
    expect(looksLikeNumber("O14S")).toBe(true);
    expect(looksLikeNumber("281S")).toBe(true);
    const sld = [p("510", "sld", "510"), p("1212", "sld", "1212"), p("woe", "woe", "82")];
    const v = verdict(sld, Array(8).fill(["SLD • EN"]));
    expect(v).toMatchObject({ kind: "unsure", numberRead: null });
  });

  it("never settles on lookalike-only reads, however many", () => {
    const v = verdict(signets, Array(6).fill(["O14S", "W0C • EN"]));
    expect(v.kind).toBe("unsure");
    // It still leads and shows progress (the picker puts it first).
    expect(v).toMatchObject({ leader: "woc", setRead: "WOC", numberRead: "145" });
    // One field read exactly, the other through lookalikes: settles.
    expect(verdict(signets, [["O14S", "WOC • EN"], ["O14S", "WOC • EN"]])).toMatchObject({ kind: "settled", id: "woc" });
  });

  it("treats a set's promo set (pwoe 82p) as the twin of the set's card, so a dropped suffix proves nothing", () => {
    const woe = [p("woe82", "woe", "82"), p("pwoe82p", "pwoe", "82p"), p("woe83", "woe", "83")];
    expect(hasTwin(woe, "woe82")).toBe(true);
    expect(verdict(woe, Array(5).fill(["0082 U", "WOE • EN"]))).toMatchObject({ kind: "unsure", leader: "woe82", twin: true });
    expect(verdict(woe, Array(2).fill(["0082P U", "WOE • EN"]))).toMatchObject({ kind: "settled", id: "pwoe82p" });
    // A promo set the API names a parent for counts the same way.
    expect(expectedOf({ ...p("x", "pxyz", "5s"), parent_set_code: "abc" })).toMatchObject({ set: "ABC", base: "5" });
  });

  it("never settles while a Mystery Booster printing (which prints the original's line) is among the candidates", () => {
    const mb = [p("m19", "m19", "30"), p("mb1", "mb1", "1123"), p("dom", "dom", "10")];
    expect(expectedOf(mb[1]!).unknownLine).toBe(true);
    expect(verdict(mb, Array(4).fill(["030/280 U", "M19 • EN"]))).toMatchObject({ kind: "unsure", twin: true });
    // Its own code read exactly: it's the Mystery Booster card.
    expect(verdict(mb, Array(3).fill(["1123 C", "MB1 • EN"]))).toMatchObject({ kind: "settled", id: "mb1" });
  });

  // Re-review of #138: a card found by its text was "proven" from the reader's confidence alone.
  it("doesn't take a confident text read as proof of the printing unless its line would settle as evidence", async () => {
    const catalog = {
      hasSet: (c: string) => ["woc", "cmm", "c21", "ltc", "moc"].includes(c),
      lookup: async (set: string, number: string) => (set === "woc" && number === "145" ? { scryfall_id: "woc", name: "Arcane Signet", set: "woc", number: "145", lang: "en" } : null),
      names: () => ["Arcane Signet"],
    };
    const names = new NameIndex(["Arcane Signet"]);
    // The reproduction: a lookalike-only collector line under a clear title.
    const [best] = await decide("O14S\nW0C • EN", "Arcane Signet", { catalog, names });
    expect(best).toMatchObject({ set: "woc", number: "145" });
    expect(best!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(proofOf(signets, "O14S\nW0C • EN").proven).toBeNull();
    // Read exactly: proof.
    expect(proofOf(signets, "0145 C\nWOC • EN").proven).toBe("woc");
    // And the twin guards hold here too.
    const withList = [p("orig", "mom", "214"), p("list", "plst", "MOM-214"), p("other", "mom", "215")];
    expect(proofOf(withList, "0214 U\nMOM • EN").proven).toBeNull();
    // What it read carries on as the first frame of hold and read.
    const { ev } = proofOf(signets, "O14S\nW0C • EN");
    ev.add(["0145 C", "WOC • EN"]);
    expect(ev.verdict()).toMatchObject({ kind: "settled", id: "woc" });
  });

  // Settling by look (look.ts, `lookSettles`) never goes against what the collector line read.
  describe("what points to another printing than the look's", () => {
    const pointsAway = (printings: ReturnType<typeof p>[], frames: string[][], id: string) => {
      const e = new Evidence(printings);
      for (const f of frames) e.add(f);
      return e.pointsAway(id);
    };
    it("nothing read points nowhere, and neither do lookalike-only reads", () => {
      expect(pointsAway(signets, [], "woc")).toBe(false);
      expect(pointsAway(signets, [[""]], "woc")).toBe(false);
      // CMM and 390 only through lookalikes ("C4M", "39O"): no exact read of another printing.
      expect(pointsAway(signets, [["39O C", "C4M • EN"]], "woc")).toBe(false);
    });
    it("another printing's set code or number read exactly points away", () => {
      expect(pointsAway(signets, [["CMM • EN"]], "woc")).toBe(true);
      expect(pointsAway(signets, [["0390 C"]], "woc")).toBe(true);
      // Even after a frame that read the look's own.
      expect(pointsAway(signets, [["0145 C", "WOC • EN"], ["CMM • EN"]], "woc")).toBe(true);
    });
    it("a read that agrees with the look's printing, or its own line's twin, doesn't", () => {
      expect(pointsAway(signets, [["0145 C", "WOC • EN"]], "woc")).toBe(false);
      expect(pointsAway(signets, [["WOC • EN"]], "woc")).toBe(false);
      // The List prints the original's line: reading MOM 214 points at neither against the other.
      const withList = [p("orig", "mom", "214"), p("list", "plst", "MOM-214"), p("other", "mom", "215")];
      expect(pointsAway(withList, [["0214 U", "MOM • EN"]], "list")).toBe(false);
      expect(pointsAway(withList, [["0214 U", "MOM • EN"]], "orig")).toBe(false);
      expect(pointsAway(withList, [["0214 U", "MOM • EN"]], "other")).toBe(true);
    });
    it("a number read without the look's printing's suffix points to the plain one", () => {
      const promo = [p("plain", "10e", "139"), p("star", "10e", "139s"), p("other", "10e", "140")];
      expect(pointsAway(promo, [["139/383", "10E • EN"]], "star")).toBe(true);
      expect(pointsAway(promo, [["139S", "10E • EN"]], "star")).toBe(false);
    });
    it("evidence settled on another printing points away, and evidence for other printings can't vouch for it", () => {
      expect(pointsAway(signets, [["C 0145", "WOC • EN DAN SCOTT"]], "cmm")).toBe(true);
      expect(pointsAway(signets, [["0145 C"]], "elsewhere")).toBe(true);
    });
  });
});
