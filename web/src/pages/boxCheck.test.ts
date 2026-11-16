import { describe, expect, it } from "vitest";
import type { Container } from "../api";
import { addCard, checkBox, loadBoxCheck, moveOps, newBoxCheck, storeBoxCheck, verdictFor, type BoxCheckDraft, type Row } from "./boxCheck";

const box = (id: string, name: string, parent: string | null, kind = "box"): Container => ({ id, name, kind, copies: 0, parent_id: parent });
const containers = [box("big", "Big box", null), box("bb", "Bulk Basic", "big"), box("red", "Bulk Red", null), box("deck", "Rohan", null, "deck")];

let n = 0;
const row = (name: string, qty: number, container_id: string | null, extra: Partial<Row> = {}): Row => ({
  id: `r${++n}`,
  name,
  qty,
  container_id,
  container_kind: containers.find((c) => c.id === container_id)?.kind ?? null,
  proxy: false,
  scryfall_id: `s-${name}`,
  set_code: "tst",
  collector_number: "1",
  finish: "nonfoil",
  ...extra,
});

const scan = (...names: string[]) => names.reduce((d, name, i) => addCard(d, name, { at: i + 1, key: `k${i}` }), newBoxCheck("big")).cards;

describe("scanning a box", () => {
  const rows = [
    row("Sol Ring", 1, "big"),
    row("Plains", 3, "bb"),
    row("Lightning Bolt", 2, "red"),
    row("Lightning Bolt", 1, "deck"),
    row("Lightning Bolt", 1, null),
    row("Counterspell", 1, "big"),
  ];

  it("sorts each card into here, elsewhere, not owned and not seen", () => {
    const r = checkBox("big", true, scan("Sol Ring", "Plains", "Plains", "Lightning Bolt", "Lightning Bolt", "Black Lotus"), rows, containers);
    const line = (name: string) => r.lines.find((l) => l.name === name)!;
    expect(line("Sol Ring")).toMatchObject({ ok: 1, missing: 0, unknown: 0, elsewhere: [] });
    expect(line("Plains")).toMatchObject({ ok: 2, here: 3, missing: 1 });
    expect(line("Plains").missingRows.map((m) => m.take)).toEqual([1]);
    expect(line("Counterspell")).toMatchObject({ scanned: 0, missing: 1 });
    expect(line("Black Lotus")).toMatchObject({ unknown: 1, here: 0 });
    // Two Bolts: the loose copy first, then a box's; the deck box's copy stays put.
    expect(line("Lightning Bolt").elsewhere.map((s) => [s.from, s.take])).toEqual([["Loose (not filed)", 1], ["Bulk Red", 1]]);
    expect(r.tally).toEqual({ scanned: 6, ok: 3, elsewhere: 2, unknown: 1, missing: 2, filed: 5 });
  });

  it("counts sections as inside only when asked", () => {
    const off = checkBox("big", false, scan("Plains"), rows, containers);
    const plains = off.lines.find((l) => l.name === "Plains")!;
    expect(plains).toMatchObject({ ok: 0, here: 0 });
    expect(plains.elsewhere[0]!.from).toBe("Big box › Bulk Basic");
  });

  it("takes real copies before proxies, and a deck box's last", () => {
    const r = checkBox("big", true, scan("Arcane Signet", "Arcane Signet", "Arcane Signet"), [
      row("Arcane Signet", 1, null, { proxy: true }),
      row("Arcane Signet", 1, "deck"),
      row("Arcane Signet", 1, "red"),
    ], containers);
    expect(r.lines[0]!.elsewhere.map((s) => s.from)).toEqual(["Bulk Red", "Rohan", "Loose (not filed)"]);
  });

  it("says more than Yama has when the scan finds extra copies", () => {
    const r = checkBox("big", true, scan("Sol Ring", "Sol Ring"), [row("Sol Ring", 1, "big")], containers);
    expect(r.lines[0]).toMatchObject({ ok: 1, unknown: 1 });
    expect(verdictFor(r.lines[0]).title).toBe("More than Yama has");
    expect(verdictFor(checkBox("big", true, scan("Sol Ring"), [row("Sol Ring", 1, "red")], containers).lines[0]).kind).toBe("elsewhere");
    expect(verdictFor(checkBox("big", true, scan("Sol Ring"), [], containers).lines[0]).title).toBe("Not in your collection");
  });

  it("matches a double-faced card by its front face", () => {
    const r = checkBox("big", true, scan("Brazen Borrower"), [row("Brazen Borrower // Petty Theft", 1, "big")], containers);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ ok: 1, missing: 0 });
  });

  it("moves split off only the copies needed", () => {
    const r = row("Lightning Bolt", 4, "red");
    const ops = moveOps([{ row: r, take: 2 }], "big", (a) => `id:${a}`);
    expect(ops).toEqual([{ op_id: `id:move:${r.id}:2:big`, kind: "update", item_id: r.id, container_id: "big", split: 2 }]);
  });
});

describe("the check kept on this device", () => {
  it("round-trips and drops an empty one", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const d: BoxCheckDraft = { ...newBoxCheck("big"), sections: false };
    storeBoxCheck(d, storage);
    expect(loadBoxCheck("big", storage)).toMatchObject({ deckId: "big", sections: false });
    expect(loadBoxCheck("other", storage)).toBeNull();
    storeBoxCheck(newBoxCheck("big"), storage);
    expect(loadBoxCheck("big", storage)).toBeNull();
  });
});
