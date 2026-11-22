// Card first, printing after (later.ts; docs/plans/scanner-match-cardvision.md, item 22): a
// provisional row is settled once, by the scanner or a pick, or taken back out, and everyone
// watching it hears each change.
import { describe, expect, it } from "vitest";
import type { Printing } from "../api";
import { laterLabel, Provisional } from "./later";

const p = (id: string) => ({ scryfall_id: id, name: "Arcane Signet", set_code: "woc", collector_number: "1" }) as Printing;
const row = () => new Provisional({ name: "Arcane Signet", confidence: 0.9, method: "art" }, 1, true, (x, how) => ({ name: x.name, scryfall_id: x.scryfall_id, confidence: 0.9, method: "art", ...(how === "price" ? { byPrice: true } : {}) }));

describe("a provisional row", () => {
  it("starts finding, takes its printings, and settles once: the first settle wins", () => {
    const r = row();
    const seen: string[] = [];
    r.watch((s) => seen.push(s.phase));
    expect(r.state.phase).toBe("finding");
    r.offer([p("a"), p("b")]);
    expect(r.settle(p("a"), "collector")).toBe(true);
    expect(r.settle(p("b"), "look")).toBe(false);
    expect(r.state).toMatchObject({ phase: "settled", how: "collector", chosen: { scryfall_id: "a" }, filed: { scryfall_id: "a" } });
    expect(seen).toEqual(["finding", "settled"]);
  });

  it("waits for a pick once the scanner gives up, and the pick settles it", () => {
    const r = row();
    r.giveUp("not in WOC");
    expect(laterLabel(r.state)).toBe("Pick the printing: not in WOC");
    expect(r.finding).toBe(false);
    expect(r.open).toBe(true);
    expect(r.pick(p("b"))).toBe(true);
    expect(r.state.how).toBe("picked");
  });

  it("marks a tie by price on the card it files", () => {
    const r = row();
    r.settle(p("a"), "price");
    expect(r.state.filed?.byPrice).toBe(true);
  });

  it("taken back out, it can't be settled after", () => {
    const r = row();
    r.drop();
    expect(r.state.phase).toBe("dropped");
    expect(r.pick(p("a"))).toBe(false);
    expect(r.open).toBe(false);
  });
});
