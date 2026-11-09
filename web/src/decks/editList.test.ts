import { describe, expect, it } from "vitest";
import type { BuildChoice, BuildFamily } from "./buildCatalog";
import { newListName, otherLists, pairEdits, startButtons, type CardFacts } from "./editList";

const choice = (c: Partial<BuildChoice> & Pick<BuildChoice, "id" | "kind">): BuildChoice => ({ label: c.id, source: `from ${c.id}`, href: "", warnings: [], ...c });
const family = (choices: BuildChoice[]): BuildFamily => ({ key: "saved:m", name: "Revival Trance", choices });
const main = { id: "m", name: "Revival Trance", parent_id: null, configuration: null };

describe("start buttons", () => {
  const f = family([
    choice({ id: "saved:m", kind: "current", savedDeck: "m" }),
    choice({ id: "plan:rt:stock", kind: "original", list: "stock list" }),
    choice({ id: "saved:s", kind: "original", savedDeck: "s" }),
    choice({ id: "research:n:rt:b3", kind: "bracket", bracket: 3, track: "aspirational" }),
    choice({ id: "plan:rt:b3", kind: "bracket", bracket: 3, track: "unverified", pairs: [{ out: "Demonic Tutor", in: "Stitch Together" }] }),
    choice({ id: "plan:rt:now", kind: "legacy" }),
  ]);

  it("offers the list in the box, Stock and the brackets that exist, preferring saved lists and the plan's swap bag", () => {
    const b = startButtons(f, main);
    expect(b.map((x) => x.label)).toEqual(["The list in the box", "Stock", "Bracket 3"]);
    expect(b[1]!.id).toBe("saved:s");
    expect(b[2]!.id).toBe("plan:rt:b3");
    expect(b[2]!.choice?.pairs).toHaveLength(1);
  });

  it("starts a list of another deck from its own list, then the box", () => {
    const b = startButtons(f, { id: "s", name: "Revival Trance (stock)", parent_id: "m", configuration: "stock" });
    expect(b.map((x) => x.label)).toEqual(["Stock", "The list in the box", "Bracket 3"]);
    expect(b[0]!.id).toBe("saved:s");
  });

  it("still offers the deck's own list with no build catalog yet", () => {
    const b = startButtons(undefined, main);
    expect(b).toHaveLength(1);
    expect(b[0]!.choice?.savedDeck).toBe("m");
  });

  it("puts everything else, then saved versions newest first, under Another list", () => {
    const b = startButtons(f, main);
    const o = otherLists(f, b, [
      { id: "v1", note: null, created_at: "2026-10-01T10:00:00Z" },
      { id: "v2", note: "Swapped in the prints", created_at: "2026-10-24T10:00:00Z" },
    ]);
    expect(o.map((x) => x.id)).toEqual(["plan:rt:stock", "research:n:rt:b3", "plan:rt:now", "version:v2", "version:v1"]);
    expect(o[3]!.label).toBe("Swapped in the prints");
    expect(o[4]!.label).toMatch(/^Version of /);
    expect(o[4]!.version).toBe("v1");
  });
});

describe("pairing a list's changes", () => {
  const facts: Record<string, CardFacts> = {
    "Demonic Tutor": { type_line: "Sorcery", cmc: 2 },
    "Vampiric Tutor": { type_line: "Instant", cmc: 1 },
    "Stitch Together": { type_line: "Sorcery", cmc: 2 },
    "Laughing Mad": { type_line: "Instant", cmc: 3 },
    "Sun Titan": { type_line: "Creature — Giant", cmc: 6 },
    "Karmic Guide": { type_line: "Creature — Angel Spirit", cmc: 5 },
    Plains: { type_line: "Basic Land — Plains", cmc: 0 },
    "Arid Mesa": { type_line: "Land", cmc: 0 },
  };
  const f = (n: string) => facts[n];
  const line = (name: string, qty = 1) => ({ name, qty, board: "main" });

  it("pairs the starting list's own swaps first", () => {
    const rows = pairEdits([line("Laughing Mad"), line("Stitch Together")], [line("Demonic Tutor"), line("Vampiric Tutor")], f, [
      { out: "Vampiric Tutor", in: "Laughing Mad" },
      { out: "Demonic Tutor", in: "Stitch Together" },
    ]);
    expect(rows).toContainEqual({ in: "Laughing Mad", out: "Vampiric Tutor" });
    expect(rows).toContainEqual({ in: "Stitch Together", out: "Demonic Tutor" });
  });

  it("pairs the rest by group, then the nearest mana value", () => {
    const rows = pairEdits([line("Karmic Guide"), line("Stitch Together"), line("Plains")], [line("Arid Mesa"), line("Demonic Tutor"), line("Sun Titan")], f);
    expect(rows).toEqual([
      { in: "Karmic Guide", out: "Sun Titan" },
      { in: "Stitch Together", out: "Demonic Tutor" },
      { in: "Plains", out: "Arid Mesa" },
    ]);
  });

  it("keeps every copy once and leaves extra cards on their own", () => {
    const rows = pairEdits([line("Plains", 2)], [line("Arid Mesa")], f);
    expect(rows).toEqual([{ in: "Plains", out: "Arid Mesa" }, { in: "Plains", out: null }]);
    expect(pairEdits([], [line("Sun Titan")], f)).toEqual([{ in: null, out: "Sun Titan" }]);
  });

  it("pairs across groups only when nothing in the same group is left", () => {
    expect(pairEdits([line("Karmic Guide")], [line("Demonic Tutor")], f)).toEqual([{ in: "Karmic Guide", out: "Demonic Tutor" }]);
  });
});

describe("a new list's name", () => {
  it("follows the list it started from", () => {
    expect(newListName({ id: "a", label: "Bracket 3" })).toBe("Bracket 3");
    expect(newListName({ id: "a", label: "Stock" })).toBe("Stock copy");
    expect(newListName({ id: "a", label: "The list in the box" })).toBe("");
  });
});
