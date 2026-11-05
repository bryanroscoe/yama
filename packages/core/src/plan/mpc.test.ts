import { describe, expect, it } from "vitest";
import { isDriveId, mpcBracket, mpcOrder, mpcXml, type MpcImage, type MpcSlotImage } from "./mpc";

const img = (id: string, ext = "png"): MpcImage => ({ id, name: `${id}.${ext}`, source: "Test", dpi: 800, size: null, ext });
const ID = (n: string) => `1${n.padEnd(32, "x")}`;
const picks: Record<string, MpcImage> = {
  "Sol Ring": img(ID("sol")),
  "Delver of Secrets": img(ID("delver"), "jpg"),
  "Insectile Aberration": img(ID("insect")),
};
const back = img(ID("back"));
const opts = { stock: "(S30) Standard Smooth" as const, foil: false, cardback: back, name: "Yama prints" };

describe("MakePlayingCards order", () => {
  it("picks the smallest project size that holds the cards", () => {
    expect(mpcBracket(1)).toBe(18);
    expect(mpcBracket(18)).toBe(18);
    expect(mpcBracket(19)).toBe(36);
    expect(mpcBracket(181)).toBe(198);
    expect(mpcBracket(235)).toBe(396);
    expect(mpcBracket(613)).toBeNull();
  });

  it("gives each copy a slot, shares an image across copies, and puts double-faced backs on their slot", () => {
    const { order, problem } = mpcOrder(
      [
        { card: "Sol Ring", back: null },
        { card: "Delver of Secrets", back: "Insectile Aberration" },
        { card: "Sol Ring", back: null },
      ],
      (c) => picks[c] ?? null,
      opts,
    );
    expect(problem).toBeNull();
    expect(order).toMatchObject({ quantity: 3, bracket: 18, cardback: back.id });
    expect(order!.fronts).toEqual([
      { id: ID("sol"), name: "Sol Ring.png", query: "sol ring", slots: [0, 2] },
      { id: ID("delver"), name: "Delver of Secrets.jpg", query: "delver of secrets", slots: [1] },
    ]);
    expect(order!.backs).toEqual([{ id: ID("insect"), name: "Insectile Aberration.png", query: "insectile aberration", slots: [1] }]);
  });

  it("makes no order while a card, a back face or the card back has no image", () => {
    const none = mpcOrder([{ card: "Delver of Secrets", back: "Insectile Aberration" }], (c) => (c === "Delver of Secrets" ? picks[c]! : null), opts);
    expect(none.order).toBeNull();
    expect(none.missing).toEqual(["Insectile Aberration"]);
    expect(none.problem).toMatch(/Insectile Aberration/);
    const noBack = mpcOrder([{ card: "Sol Ring", back: null }], (c) => picks[c] ?? null, { ...opts, cardback: null });
    expect(noBack.order).toBeNull();
    expect(noBack.problem).toBe("No card back chosen.");
  });

  it("refuses ids that aren't Drive file ids, too many cards and foil plastic", () => {
    expect(isDriveId(ID("ok"))).toBe(true);
    expect(isDriveId("https://evil.example/x.png")).toBe(false);
    expect(isDriveId("../../etc")).toBe(false);
    const bad = mpcOrder([{ card: "Sol Ring", back: null }], () => img("not a drive id"), opts);
    expect(bad.order).toBeNull();
    expect(bad.missing).toEqual(["Sol Ring"]);
    const many = mpcOrder(Array.from({ length: 613 }, () => ({ card: "Sol Ring", back: null })), (c) => picks[c] ?? null, opts);
    expect(many.problem).toMatch(/612/);
    const foil = mpcOrder([{ card: "Sol Ring", back: null }], (c) => picks[c] ?? null, { ...opts, stock: "(P10) Plastic", foil: true });
    expect(foil.problem).toMatch(/foil on plastic/);
  });

  it("writes MPC Autofill's order file, escaping names", () => {
    const { order } = mpcOrder([{ card: "Sol Ring", back: null }, { card: "Delver of Secrets", back: "Insectile Aberration" }], (c) => picks[c] ?? null, opts);
    const [sol, delver] = order!.fronts as [MpcSlotImage, MpcSlotImage];
    const xml = mpcXml({ ...order!, fronts: [{ ...sol, name: "R&D's <Card>.png" }, delver] });
    expect(xml).toContain("<quantity>2</quantity>");
    expect(xml).toContain("<bracket>18</bracket>");
    expect(xml).toContain("<stock>(S30) Standard Smooth</stock>");
    expect(xml).toContain("<foil>false</foil>");
    expect(xml).toContain(`<id>${ID("sol")}</id>`);
    expect(xml).toContain("<name>R&amp;D's &lt;Card&gt;.png</name>");
    expect(xml).toContain("<backs>");
    expect(xml).toContain(`<cardback>${back.id}</cardback>`);
    const plain = mpcXml(mpcOrder([{ card: "Sol Ring", back: null }], (c) => picks[c] ?? null, opts).order!);
    expect(plain).not.toContain("<backs>");
  });

  it("asks for a back face's image apart from its front, for a reversible card whose faces share a name", () => {
    const asked: string[] = [];
    const { order } = mpcOrder([{ card: "Sol Ring", back: "Sol Ring" }], (c, face) => (asked.push(`${face}:${c}`), face === "back" ? picks["Delver of Secrets"]! : picks[c]!), opts);
    expect(asked).toEqual(["front:Sol Ring", "back:Sol Ring"]);
    expect(order!.fronts[0]!.id).toBe(ID("sol"));
    expect(order!.backs[0]!.id).toBe(ID("delver"));
  });
});
