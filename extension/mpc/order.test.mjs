// The print helper's order check (order.js), run the way Chrome loads it: as a plain script.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { mpcOrder } from "../../packages/core/src/plan/mpc";

const ctx = {};
vm.runInNewContext(readFileSync(new URL("./order.js", import.meta.url), "utf8"), ctx);
const { checkOrder, backImages } = ctx;

const ID = (n) => `1${n.padEnd(32, "x")}`;
const img = (id) => ({ id, name: `${id}.png`, source: "Test", dpi: 800, size: null, ext: "png" });
const picks = { "Sol Ring": img(ID("sol")), "Delver of Secrets": img(ID("delver")), "Insectile Aberration": img(ID("insect")) };
const made = mpcOrder(
  [
    { card: "Sol Ring", back: null },
    { card: "Delver of Secrets", back: "Insectile Aberration" },
    { card: "Sol Ring", back: null },
  ],
  (c) => picks[c] ?? null,
  { stock: "(S30) Standard Smooth", foil: false, cardback: img(ID("back")), name: "Yama prints 2026-11-05" },
).order;

describe("the print helper's order check", () => {
  it("takes the order Yama makes and keeps only known fields", () => {
    const o = checkOrder({ ...made, extra: "dropped", fronts: made.fronts.map((f) => ({ ...f, url: "https://evil.example" })) });
    expect(o).toEqual({ ...made, fronts: made.fronts.map(({ id, name, slots }) => ({ id, name, slots })), backs: made.backs.map(({ id, name, slots }) => ({ id, name, slots })) });
  });

  it("puts the common card back on every slot without a double-faced back", () => {
    const { same, images } = backImages(checkOrder(made));
    expect(same).toBe(false);
    expect(images).toEqual([
      { id: ID("back"), name: "Card back.png", slots: [0, 2] },
      { id: ID("insect"), name: "Insectile Aberration.png", slots: [1] },
    ]);
    expect(backImages(checkOrder({ ...made, backs: [] })).same).toBe(true);
  });

  it("refuses anything that would fetch elsewhere, leave a card blank or not fit", () => {
    const bad = [
      { ...made, v: 2 },
      { ...made, cardback: "https://evil.example/back.png" },
      { ...made, fronts: [{ ...made.fronts[0], id: "../../x" }, made.fronts[1]] },
      { ...made, fronts: [made.fronts[0]] },
      { ...made, fronts: [{ ...made.fronts[0], slots: [0, 1] }, made.fronts[1]] },
      { ...made, fronts: [{ ...made.fronts[0], slots: [0, 3] }, made.fronts[1]] },
      { ...made, bracket: 36 },
      { ...made, quantity: 700, bracket: 612 },
      { ...made, stock: "(S99) Mystery" },
      { ...made, stock: "(P10) Plastic", foil: true },
      { ...made, foil: "yes" },
    ];
    for (const o of bad) expect(() => checkOrder(o), JSON.stringify(o).slice(0, 80)).toThrow(/can't be used/);
  });
});
