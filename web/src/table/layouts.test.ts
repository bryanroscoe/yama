import { describe, expect, it } from "vitest";
import { roll } from "./DiceSheet";
import { layoutOptions, quarterTurn, tableLayout, uprightLayout, type Layout } from "./layouts";

/** Every grid square a layout covers, with the seat on it. */
function squares(l: Layout): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of l.cells) {
    const [r1, c1, r2, c2] = c.area.split("/").map((x) => Number(x.trim()));
    for (let r = r1!; r < (r2 ?? r1! + 1); r++) {
      for (let k = c1!; k < (c2 ?? c1! + 1); k++) {
        expect(out.has(`${r},${k}`), `seat ${c.seat} overlaps at ${r},${k}`).toBe(false);
        out.set(`${r},${k}`, c.seat);
      }
    }
  }
  return out;
}

describe("table layouts", () => {
  it("every arrangement seats everyone once and fills its grid with no gaps", () => {
    for (let n = 1; n <= 6; n++) {
      for (const o of layoutOptions(n)) {
        for (const landscape of [false, true]) {
          const l = tableLayout(n, o.key, landscape);
          expect(l.cells.map((c) => c.seat).sort()).toEqual(Array.from({ length: n }, (_, i) => i));
          expect(squares(l).size, `${n} ${o.key} ${landscape}`).toBe(l.cols * l.rows);
        }
      }
    }
  });

  it("keeps the old layouts as each count's first choice", () => {
    expect(tableLayout(2, layoutOptions(2)[0]!.key).cells).toEqual([
      { seat: 0, rot: 0, area: "2 / 1" },
      { seat: 1, rot: 180, area: "1 / 1" },
    ]);
    expect(tableLayout(4, layoutOptions(4)[0]!.key).cells.map((c) => c.rot)).toEqual([90, 90, 270, 270]);
  });

  it("one each side faces four players four ways", () => {
    expect(tableLayout(4, "ends").cells.map((c) => c.rot)).toEqual([0, 90, 180, 270]);
  });

  it("a quarter turn moves the top to the right and turns each panel with it", () => {
    const turned = quarterTurn(tableLayout(2, "ends"));
    expect(turned).toEqual({
      cols: 2,
      rows: 1,
      cells: [
        { seat: 0, rot: 90, area: "1 / 1 / 2 / 2" },
        { seat: 1, rot: 270, area: "1 / 2 / 2 / 3" },
      ],
    });
  });

  it("a landscape screen puts two or three upright panels in one row", () => {
    expect(uprightLayout(2, true)).toMatchObject({ cols: 2, rows: 1 });
    expect(uprightLayout(3, true)).toMatchObject({ cols: 3, rows: 1 });
    expect(uprightLayout(2)).toMatchObject({ cols: 2, rows: 1 });
  });
});

describe("dice", () => {
  it("rolls 1 to n", () => {
    expect(roll(6, () => 0)).toBe(1);
    expect(roll(6, () => 5)).toBe(6);
    for (let i = 0; i < 200; i++) {
      const r = roll(20);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(20);
    }
  });
});
