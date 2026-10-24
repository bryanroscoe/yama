import { describe, expect, it } from "vitest";
import { adjust, buttons, changed, chooserCovers, counter, initialDraft, left, move, onBoard, ready, setNumber, toAct, togglePick, type Draft } from "./answer";
import type { DecisionOption, Pending } from "./types";

const option = (id: string, extra: Partial<DecisionOption> = {}): DecisionOption => ({ id, name: `Card ${id}`, eligible: true, ...extra });
const pending = (extra: Partial<Pending>): Pending => ({
  kind: "pick",
  prompt: "Choose",
  options: [],
  min: 0,
  max: 1,
  upTo: false,
  answer: "select_cards",
  purpose: "choose",
  ...extra,
});
const noCancel = { canCancel: false, spell: true };

describe("picking cards", () => {
  const search = pending({ purpose: "search", prompt: "Search your library for up to 2 cards", min: 0, max: 2, upTo: true, zone: "library", options: [option("11", { zone: "library" }), option("12", { zone: "library" }), option("13", { zone: "library", eligible: false })] });
  it("counts up to the most you may pick, and drops the first pick past it", () => {
    let d = initialDraft(search);
    d = togglePick(search, d, "11");
    d = togglePick(search, d, "12");
    expect(counter(search, d)).toBe("2 of up to 2 chosen");
    expect(buttons(search, d, noCancel).primary).toBe("Done (2/2)");
    d = togglePick(search, d, "11");
    expect(d).toEqual({ kind: "pick", ids: ["12"] });
    // A card that can't be chosen isn't picked.
    d = togglePick(search, togglePick(search, d, "11"), "13");
    expect(d).toEqual({ kind: "pick", ids: ["12", "11"] });
    expect(toAct(search, d)).toEqual({ kind: "select_cards", cards: [12, 11] });
  });
  it("offers Find nothing only when the search allows it", () => {
    expect(buttons(search, initialDraft(search), noCancel).secondary).toBe("Find nothing");
    const exact = pending({ ...search, min: 2, upTo: false });
    expect(buttons(exact, initialDraft(exact), noCancel).secondary).toBeNull();
    expect(ready(exact, togglePick(exact, initialDraft(exact), "11"))).toBe(false);
  });
  it("keeps scried cards on top in the order picked", () => {
    const scry = pending({ purpose: "scry", prompt: "Scry 2", min: 0, max: 2, upTo: true, ordered: true, destination: "top", zone: "library", options: [option("5"), option("6")] });
    const d = togglePick(scry, togglePick(scry, initialDraft(scry), "6"), "5");
    expect(toAct(scry, d)).toEqual({ kind: "select_cards", cards: [6, 5] });
    expect(buttons(scry, d, noCancel).primary).toBe("Done");
    expect(counter(scry, d)).toBe("2 kept on top");
    expect(ready(scry, initialDraft(scry))).toBe(true);
  });
  it("picks cards in your hand on the board, and library cards in a zone view", () => {
    expect(onBoard(pending({ purpose: "bottom", options: [option("1", { zone: "hand" })] }))).toBe(true);
    expect(onBoard(pending({ purpose: "search", options: [option("1", { zone: "library" })] }))).toBe(false);
  });
});

describe("what the chooser answers", () => {
  it("leaves targets to the board, and shows nothing without a decision of yours", () => {
    expect(chooserCovers(pending({ purpose: "target", answer: "choose_target" }))).toBe(false);
    // Another seat's board carries no pending decision at all, so nothing is shown there.
    expect(chooserCovers(undefined)).toBe(false);
    expect(chooserCovers(null)).toBe(false);
    expect(chooserCovers(pending({ purpose: "scry" }))).toBe(true);
  });
  it("sends a modes answer as indices and a replacement as its index", () => {
    const modes = pending({ answer: "select_modes", purpose: "modes", min: 1, max: 2, options: [option("0"), option("1", { eligible: false }), option("2")] });
    const d = togglePick(modes, togglePick(modes, initialDraft(modes), "2"), "0");
    expect(toAct(modes, d)).toEqual({ kind: "select_modes", indices: [2, 0] });
    const repl = pending({ answer: "choose_replacement", purpose: "replacement", min: 1, max: 1, options: [option("0"), option("1")] });
    expect(toAct(repl, togglePick(repl, initialDraft(repl), "1"))).toEqual({ kind: "choose_replacement", index: 1 });
  });
});

describe("putting triggers in order", () => {
  const triggers = pending({ kind: "order", answer: "order_triggers", purpose: "triggers", min: 2, max: 2, options: [option("0"), option("1"), option("2")], defaultAnswer: ["0", "1", "2"] });
  it("lists them by when they resolve, the reverse of the order they go on the stack", () => {
    const d = initialDraft(triggers);
    expect(d).toEqual({ kind: "order", ids: ["2", "1", "0"] });
    expect(toAct(triggers, d)).toEqual({ kind: "order_triggers", order: [0, 1, 2] });
    const moved = move(d, 2, -1);
    expect(moved).toEqual({ kind: "order", ids: ["2", "0", "1"] });
    expect(toAct(triggers, moved)).toEqual({ kind: "order_triggers", order: [1, 0, 2] });
    expect(changed(triggers, moved)).toBe(true);
    expect(buttons(triggers, moved, noCancel)).toMatchObject({ primary: "Done", secondary: "Default order" });
    expect(move(d, 0, -1)).toEqual(d);
  });
});

describe("splitting damage", () => {
  const damage = pending({
    kind: "split",
    answer: "assign_combat_damage",
    purpose: "damage",
    total: 5,
    perOptionMin: 0,
    min: 0,
    max: 5,
    options: [option("40", { lethal: 2, zone: "battlefield" }), option("p1", { zone: "player", controller: 1 })],
    defaultAnswer: { "40": 2, p1: 3 },
  });
  it("starts from the engine's split and sends what goes past the blockers as trample", () => {
    const d = initialDraft(damage);
    expect(left(damage, d)).toBe(0);
    expect(ready(damage, d)).toBe(true);
    expect(toAct(damage, d)).toEqual({ kind: "assign_combat_damage", assignments: [[40, 2]], trample: 3, controller: 0 });
  });
  it("never gives out more than the total, and isn't ready until it's all given out", () => {
    let d: Draft = adjust(damage, initialDraft(damage), "40", 1);
    expect((d as { amounts: Record<string, number> }).amounts["40"]).toBe(2);
    d = adjust(damage, d, "p1", -2);
    expect(counter(damage, d)).toBe("2 left");
    expect(ready(damage, d)).toBe(false);
    d = adjust(damage, d, "40", 9);
    expect(toAct(damage, d)).toEqual({ kind: "assign_combat_damage", assignments: [[40, 4]], trample: 1, controller: 0 });
  });
  it("gives each target of a divided spell at least one", () => {
    const divide = pending({ kind: "split", answer: "distribute_among", purpose: "divide", total: 3, perOptionMin: 1, options: [option("7"), option("p2", { zone: "player" })] });
    let d = adjust(divide, initialDraft(divide), "7", 3);
    expect(ready(divide, d)).toBe(false);
    d = adjust(divide, adjust(divide, d, "7", -1), "p2", 1);
    expect(toAct(divide, d)).toEqual({ kind: "distribute_among", distribution: [[{ kind: "object", id: 7 }, 2], [{ kind: "player", seat: 2 }, 1]] });
  });
});

describe("numbers, words and yes or no", () => {
  it("keeps X between the engine's limits", () => {
    const x = pending({ kind: "number", answer: "choose_x", purpose: "x", min: 0, max: 6, previews: [[3, "{3}{R}"]] });
    expect(setNumber(x, 9)).toEqual({ kind: "number", value: 6 });
    expect(toAct(x, setNumber(x, 3))).toEqual({ kind: "choose_x", value: 3 });
    expect(buttons(x, setNumber(x, 3), { canCancel: true, spell: true })).toMatchObject({ primary: "Cast for X = 3", secondary: "Cancel" });
  });
  it("answers a named number with its digits, and a word only from the list unless any word goes", () => {
    const n = pending({ kind: "number", answer: "choose_option", purpose: "name", min: 1, max: 10 });
    expect(toAct(n, setNumber(n, 4))).toEqual({ kind: "choose_option", choice: "4" });
    const type = pending({ kind: "text", answer: "choose_option", purpose: "name", options: [option("Goblin"), option("Elf")], freeEntry: false });
    expect(ready(type, { kind: "text", value: "Dragon" })).toBe(false);
    expect(ready(type, { kind: "text", value: "Elf" })).toBe(true);
    const name = pending({ kind: "text", answer: "choose_option", purpose: "name", options: [], freeEntry: true });
    expect(toAct(name, { kind: "text", value: " Sol Ring " })).toEqual({ kind: "choose_option", choice: "Sol Ring" });
  });
  it("words the buttons from the engine's question", () => {
    const may = pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "may", prompt: "Draw a card?", yesLabel: "Yes", noLabel: "No" });
    expect(buttons(may, initialDraft(may), noCancel)).toMatchObject({ primary: "Yes, draw a card", secondary: "No" });
    expect(toAct(may, initialDraft(may), false)).toEqual({ kind: "decide_optional_effect", accept: false });
    const pay = pending({ kind: "yesno", answer: "pay_unless_cost", purpose: "pay", prompt: "Pay {2}?", yesLabel: "Pay {2}", noLabel: "Don't pay" });
    expect(buttons(pay, initialDraft(pay), noCancel).primary).toBe("Pay {2}");
    expect(toAct(pay, initialDraft(pay), true)).toEqual({ kind: "pay_unless_cost", pay: true });
  });
});
