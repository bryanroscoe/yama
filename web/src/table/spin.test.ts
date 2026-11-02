import { describe, expect, it } from "vitest";
import { spinSchedule } from "./spin";

describe("spinSchedule", () => {
  it("always stops on the drawn player", () => {
    for (let count = 2; count <= 8; count++)
      for (let from = 0; from < count; from++)
        for (let to = 0; to < count; to++) expect(spinSchedule(count, from, to).at(-1)!.index).toBe(to);
  });

  it("goes round at least once, one player at a time, slowing down", () => {
    const steps = spinSchedule(4, 2, 2);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    steps.forEach((s, i) => expect(s.index).toBe((2 + i + 1) % 4));
    const gaps = steps.map((s, i) => s.at - (i ? steps[i - 1]!.at : 0));
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]!);
  });

  it("takes about a second at any table size", () => {
    for (let count = 2; count <= 8; count++) {
      const end = spinSchedule(count, 0, count - 1).at(-1)!.at;
      expect(end).toBeGreaterThan(700);
      expect(end).toBeLessThan(1800);
    }
  });

  it("doesn't spin with one player", () => {
    expect(spinSchedule(1, 0, 0)).toEqual([{ index: 0, at: 0 }]);
  });
});
