import { describe, expect, it } from "vitest";
import { judgeText, textTestSummary } from "./textTest";

const p = (id: string, set: string, number: string) => ({ scryfall_id: id, set_code: set, collector_number: number, rarity: "rare", lang: "en", released_at: "2026-10-02" });

describe("test scan's text reading test", () => {
  it("says whether the title names the card, and which printing the line proves", () => {
    const t = judgeText("Fatehold Charm", ["", "Fatehold Charm"], ["R 0432", "FRA • EN SOMEONE"], [p("a", "fra", "432"), p("b", "fra", "12")], 812.4);
    expect(t).toMatchObject({ title: "Fatehold Charm", titleOk: true, read: "FRA 432", settled: true, twin: false, ms: 812 });
  });

  it("says a line that reads a twin's set code and number is a twin, not settled", () => {
    const t = judgeText("Ajani Unrelenting", ["Ajani Unrelentlng"], ["M 0242", "FRA • EN TYLER JACOBSON"], [p("a", "fra", "242"), p("b", "pfra", "242p")], 500);
    expect(t).toMatchObject({ titleOk: true, read: "FRA 242", settled: false, twin: true });
  });

  it("says nothing was read when nothing was", () => {
    const t = judgeText("Teyo, Lightshield Expert", ["", ""], ["", ""], [p("a", "fra", "295")], 400);
    expect(t).toMatchObject({ title: "", titleOk: false, line: "", read: null, settled: false });
    // The title read the copyright line, not the name.
    expect(judgeText("Teyo, Lightshield Expert", ["TM & 2026 Wizards of the Coast"], [], [p("a", "fra", "295")], 1).titleOk).toBe(false);
  });

  it("sums them up in a line", () => {
    const ok = judgeText("Fatehold Charm", ["Fatehold Charm"], ["R 0432", "FRA • EN"], [p("a", "fra", "432")], 1);
    const twin = judgeText("Ajani Unrelenting", [""], ["M 0242", "FRA • EN"], [p("a", "fra", "242"), p("b", "pfra", "242p")], 1);
    const none = judgeText("Teyo", [""], [""], [p("a", "fra", "295")], 1);
    expect(textTestSummary([])).toBe("No cards read yet.");
    expect(textTestSummary([ok, twin, none])).toBe("Name read on 1 of 3 cards; set and number on 2 (1 with a twin printing).");
  });
});
