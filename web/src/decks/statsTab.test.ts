import { describe, expect, it } from "vitest";
import { bandOf, isStockConfiguration, landFaceCopies, colorShares, curveColumns, curveSpread, DIAL, dialAngle, dialArc, dialPoint, groupTotal, marginSpan, pctWidth, points, POWER_BANDS, referenceOf } from "./statsTab";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("the power dial", () => {
  it("runs from 1 on the left to 10 on the right, 5.5 at the top", () => {
    near(dialAngle(1), Math.PI);
    near(dialAngle(10), 0);
    near(dialAngle(5.5), Math.PI / 2);
    const [x1, y1] = dialPoint(1);
    near(x1, DIAL.cx - DIAL.r);
    near(y1, DIAL.cy);
    const [xt, yt] = dialPoint(5.5, 100);
    near(xt, DIAL.cx);
    near(yt, DIAL.cy - 100);
  });

  it("keeps scores off the dial on it", () => {
    expect(dialAngle(0)).toBe(dialAngle(1));
    expect(dialAngle(12)).toBe(dialAngle(10));
    expect(dialAngle(Number.NaN)).toBe(dialAngle(1));
  });

  it("draws an arc clockwise between two levels, in either order", () => {
    expect(dialArc(1, 10)).toBe("M 30.0 160.0 A 130 130 0 0 1 290.0 160.0");
    expect(dialArc(10, 1)).toBe(dialArc(1, 10));
  });

  it("bands the brackets as the server's power_bracket does, with no gaps", () => {
    expect([bandOf(1), bandOf(5), bandOf(5.1), bandOf(7), bandOf(7.1), bandOf(10)]).toEqual([2, 2, 3, 3, 4, 4]);
    expect(POWER_BANDS[0]!.from).toBe(1);
    expect(POWER_BANDS.at(-1)!.to).toBe(10);
    POWER_BANDS.slice(1).forEach((b, i) => expect(b.from).toBe(POWER_BANDS[i]!.to));
  });

  it("marks the margin, kept on the dial", () => {
    expect(marginSpan(7.5, 0.4)).toEqual([7.1, 7.9]);
    expect(marginSpan(1.2, 0.5)).toEqual([1, 1.7]);
    expect(marginSpan(9.8, 0.5)).toEqual([9.3, 10]);
    expect(marginSpan(5, -1)).toEqual([5, 5]);
  });
});

describe("the five scores", () => {
  it("has the stock, Bracket 4 and cEDH marks", () => {
    expect(referenceOf("stock")?.value).toBe(40);
    expect(referenceOf("b4")?.value).toBe(75);
    expect(referenceOf("cedh")?.value).toBe(95);
    expect(referenceOf("none")).toBeNull();
  });

  it("keeps bars between 0 and 100 percent", () => {
    expect(pctWidth(-3)).toBe("0%");
    expect(pctWidth(104)).toBe("100%");
    expect(pctWidth(62.5)).toBe("62.5%");
  });

  it("shows points without a trailing .0 and adds up every copy", () => {
    expect(points(8)).toBe("8");
    expect(points(4.5)).toBe("4.5");
    expect(points(4.04)).toBe("4");
    expect(groupTotal([{ points: 6, copies: 11 }, { points: 2.5, copies: 1 }])).toBe(68.5);
  });
});

describe("the curve and colors", () => {
  const bucket = (mv: number, creatures: number, others: number) => ({ mv, creatures, others });
  const curve = [bucket(0, 0, 0), bucket(1, 2, 6), bucket(2, 5, 9), bucket(3, 6, 6), bucket(4, 4, 3), bucket(5, 3, 1), bucket(6, 2, 0), bucket(7, 1, 1)];

  it("shows 1 to 7+, and 0 only when something costs 0", () => {
    expect(curveColumns(curve).map((c) => c.label)).toEqual(["1", "2", "3", "4", "5", "6", "7+"]);
    expect(curveColumns(curve)[0]!.n).toBe(8);
    expect(curveColumns([bucket(0, 0, 1), ...curve.slice(1)])[0]).toEqual({ mv: 0, label: "0", n: 1 });
  });

  it("counts 2 or less, 3 or 4, and 5 or more", () => {
    expect(curveSpread(curve)).toEqual({ low: 22, mid: 19, high: 8 });
  });

  it("gives shares of symbols and of lands, unknown while lands aren't counted", () => {
    const shares = colorShares([{ color: "U", pips: 30, sources: 20 }, { color: "R", pips: 10, sources: 18 }], 36);
    expect(shares).toEqual([
      { color: "U", pips: 30, pipShare: 75, sources: 20, sourceShare: 56 },
      { color: "R", pips: 10, pipShare: 25, sources: 18, sourceShare: 50 },
    ]);
    expect(colorShares([{ color: "W", pips: 4, sources: null }], 36)[0]!.sourceShare).toBeNull();
  });
});

describe("land faces and stock lists", () => {
  const card = (name: string, typeLine: string | null, qty = 1, board: "main" | "side" | "commander" = "main") =>
    ({ name, qty, board, cmc: typeLine == null ? null : 0, typeLine, manaCost: null, producedMana: "U" });

  it("counts every copy with a land on either face, as sources are counted", () => {
    expect(landFaceCopies([
      card("Island", "Basic Land — Island", 12),
      card("Sea Gate Restoration // Sea Gate, Reborn", "Sorcery // Land"),
      card("Sol Ring", "Artifact"),
      card("Spare Island", "Basic Land — Island", 2, "side"),
      card("Unknown", null),
    ])).toBe(13);
  });

  it("knows a stock list by either name, in any case", () => {
    for (const n of ["stock", "Stock", "ORIGINAL", "original"]) expect(isStockConfiguration(n)).toBe(true);
    for (const n of ["Bracket 3", "stocky", null, undefined]) expect(isStockConfiguration(n)).toBe(false);
  });
});
