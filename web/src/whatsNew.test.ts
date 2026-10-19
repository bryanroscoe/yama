import { describe, expect, it } from "vitest";
import { NEWS, unseen, type NewsEntry } from "./whatsNew";

const entry = (id: string): NewsEntry => ({ id, date: "2026-10-19", title: id, items: [`${id} shipped.`] });

describe("what's new", () => {
  const list = [entry("c"), entry("b"), entry("a")];

  it("shows what came after the newest entry this device saw", () => {
    expect(unseen(list, null).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(unseen(list, "b").map((e) => e.id)).toEqual(["c"]);
    expect(unseen(list, "c")).toEqual([]);
    expect(unseen(list, "gone").map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps the list tidy: unique ids, newest first, plain sentences", () => {
    expect(new Set(NEWS.map((e) => e.id)).size).toBe(NEWS.length);
    const dates = NEWS.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const e of NEWS) {
      expect(e.title).toBe(e.title.charAt(0).toUpperCase() + e.title.slice(1));
      expect(e.title).not.toMatch(/^[A-Z ]+$/); // no all-caps
      for (const item of e.items) {
        expect(item).toMatch(/[.!?”]$/);
        expect(item).not.toContain("·"); // no middle-dot meta strings
      }
    }
  });
});
