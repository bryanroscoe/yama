import { describe, expect, it } from "vitest";
import {
  adjust,
  buttons,
  changed,
  chooserCovers,
  counter,
  initialDraft,
  keepOnTop,
  keypad,
  left,
  lethalOf,
  move,
  moveTo,
  nameMatches,
  isTapping,
  isTargeting,
  isSeatPick,
  noneAct,
  onBoard,
  powerOf,
  orderTag,
  ready,
  rememberLabels,
  yesNoPresentation,
  restHere,
  setNumber,
  splitTag,
  stageOf,
  stepNumber,
  toAct,
  togglePick,
  typeDigit,
  type Draft,
} from "./answer";
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

it("names a control recipient while preserving the engine's player-choice token", () => {
  const p = pending({ answer: "choose_option", purpose: "control_recipient", choiceType: "opponent", min: 1, source: { id: 91, name: "Wishclaw Talisman", controller: 0 }, options: [option("1", { name: "Ben", controller: 1, zone: "player" }), option("3", { name: "Di", controller: 3, zone: "player" })] });
  expect(isSeatPick(p)).toBe(true);
  expect(buttons(p, initialDraft(p), noCancel).primary).toBe("Choose an opponent");
  const d = togglePick(p, initialDraft(p), "3");
  expect(buttons(p, d, { ...noCancel, who: (seat) => seat === 3 ? "Olivia" : "Ben" }).primary).toBe("Give Wishclaw Talisman to Olivia");
  expect(toAct(p, d)).toEqual({ kind: "choose_option", choice: "3" });
  expect(buttons({ ...p, purpose: "named_player" }, d, noCancel).primary).toBe("Choose Di");
  expect(isSeatPick(pending({ kind: "number", answer: "choose_option", purpose: "name", choiceType: "number range", min: 1, max: 3 }))).toBe(false);
});

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
  it("starts a scry with every card on top, and sends the ones kept there in draw order", () => {
    const scry = pending({ purpose: "scry", prompt: "Scry 2", min: 0, max: 2, upTo: true, ordered: true, destination: "top", zone: "library", options: [option("5"), option("6")] });
    let d = initialDraft(scry);
    expect(d).toEqual({ kind: "pick", ids: ["5", "6"] });
    expect(counter(scry, d)).toBe("2 on top");
    expect(buttons(scry, d, noCancel)).toMatchObject({ primary: "Done", secondary: null });
    // The second card drawn first, then the first sent to the bottom.
    d = move(d, 1, -1);
    expect(toAct(scry, d)).toEqual({ kind: "select_cards", cards: [6, 5] });
    d = keepOnTop(scry, d, "5", false);
    expect(toAct(scry, d)).toEqual({ kind: "select_cards", cards: [6] });
    expect(buttons(scry, d, noCancel)).toMatchObject({ primary: "Done", secondary: "All on top", secondaryDoes: "all-top" });
    // Back on top it goes under the ones already kept; everything to the bottom is fine too.
    expect(keepOnTop(scry, d, "5", true)).toEqual({ kind: "pick", ids: ["6", "5"] });
    expect(ready(scry, keepOnTop(scry, d, "6", false))).toBe(true);
  });
  it("picks cards in your hand on the board, and library cards in a zone view", () => {
    expect(onBoard(pending({ purpose: "bottom", options: [option("1", { zone: "hand" })] }))).toBe(true);
    expect(onBoard(pending({ purpose: "search", options: [option("1", { zone: "library" })] }))).toBe(false);
  });
});

describe("what the chooser answers", () => {
  it("answers targets too, and shows nothing without a decision of yours", () => {
    expect(chooserCovers(pending({ purpose: "target", answer: "choose_target" }))).toBe(true);
    // Another seat's board carries no pending decision at all, so nothing is shown there.
    expect(chooserCovers(undefined)).toBe(false);
    expect(chooserCovers(null)).toBe(false);
    expect(chooserCovers(pending({ purpose: "scry" }))).toBe(true);
    expect(chooserCovers(pending({ kind: "pair", answer: "choose_pair", purpose: "pair" }))).toBe(true);
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

describe("where each decision is answered", () => {
  const hand = pending({ purpose: "discard", min: 2, max: 2, options: [option("1", { zone: "hand" }), option("2", { zone: "hand" })] });
  it("puts a may in a strip, picks of your cards on the board, and the rest in a dialog or a phone's sheet", () => {
    expect(stageOf(pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "may" }), true, false)).toBe("strip");
    expect(stageOf(pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "may" }), false, false)).toBe("strip");
    expect(stageOf(hand, true, false)).toBe("board");
    expect(stageOf(hand, false, false)).toBe("sheet");
    expect(stageOf(pending({ purpose: "search", options: [option("1", { zone: "library" })] }), true, false)).toBe("dialog");
    // A scry's cards are in the library even though it's yours: always the piles.
    expect(stageOf(pending({ purpose: "scry", options: [option("1", { zone: "hand" })] }), true, false)).toBe("dialog");
    const split = pending({ kind: "split", answer: "distribute_among", purpose: "divide", total: 2, options: [option("7"), option("8")] });
    expect(stageOf(split, true, true)).toBe("steppers");
    expect(stageOf(split, true, false)).toBe("dialog");
    expect(stageOf(pending({ kind: "pair", answer: "choose_pair", purpose: "pair", options: [option("4", { zone: "battlefield" })] }), true, false)).toBe("board");
  });
  it("only picks on the board when every card is in your hand or on the battlefield", () => {
    expect(onBoard(pending({ purpose: "choose", options: [option("1", { zone: "hand" }), option("2", { zone: "graveyard" })] }))).toBe(false);
    expect(onBoard(pending({ purpose: "modes", answer: "select_modes", options: [option("0")] }))).toBe(false);
  });
});

describe("pick N", () => {
  it("names the main button for what the pick does (GPickN, GChoices, GMulligan)", () => {
    const discard = pending({ purpose: "discard", prompt: "Discard 2 cards", min: 2, max: 2, options: [option("1"), option("2"), option("3")] });
    let d = togglePick(discard, initialDraft(discard), "1");
    expect(buttons(discard, d, noCancel)).toMatchObject({ primary: "Discard (1/2)", secondary: "Clear" });
    expect(ready(discard, d)).toBe(false);
    d = togglePick(discard, d, "3");
    expect(counter(discard, d)).toBe("2 of 2 chosen");
    const bottom = pending({ purpose: "bottom", min: 1, max: 1, options: [option("1")] });
    expect(buttons(bottom, togglePick(bottom, initialDraft(bottom), "1"), noCancel)).toMatchObject({ primary: "Done (1/1)", secondary: "Clear picks" });
  });
  it("offers none only where the engine says up to", () => {
    const upTo = pending({ purpose: "choose", prompt: "Choose up to 2 cards", min: 0, max: 2, upTo: true, options: [option("1"), option("2")] });
    expect(buttons(upTo, initialDraft(upTo), noCancel).primary).toBe("Choose none");
    expect(counter(upTo, initialDraft(upTo))).toBe("0 of up to 2 chosen");
    expect(noneAct(upTo)).toEqual({ kind: "select_cards", cards: [] });
    const exact = pending({ purpose: "choose", prompt: "Choose 2 cards", min: 2, max: 2, options: [option("1"), option("2")] });
    expect(buttons(exact, initialDraft(exact), noCancel).primary).toBe("Choose (0/2)");
    expect(noneAct(exact)).toBeNull();
  });
  it("lets a search find nothing only when it allows that, and waits for a card on Done", () => {
    const find = pending({ purpose: "search", min: 0, max: 2, upTo: true, options: [option("1"), option("2")] });
    expect(buttons(find, initialDraft(find), noCancel)).toMatchObject({ primary: "Choose a card", secondary: "Find nothing", secondaryDoes: "none" });
    expect(buttons(find, togglePick(find, initialDraft(find), "2"), noCancel).primary).toBe("Done (1/2)");
  });
});

describe("modes", () => {
  const charm = pending({ answer: "select_modes", purpose: "modes", prompt: "Choose one", min: 1, max: 1, options: [option("0"), option("1"), option("2")] });
  it("switches a choose-one and counts a choose-one-or-both", () => {
    const d = togglePick(charm, togglePick(charm, initialDraft(charm), "0"), "2");
    expect(d).toEqual({ kind: "pick", ids: ["2"] });
    expect(buttons(charm, d, { canCancel: true, spell: true })).toMatchObject({ primary: "Next", secondary: "Cancel" });
    expect(buttons(charm, initialDraft(charm), noCancel).primary).toBe("Choose a mode");
    const both = pending({ answer: "select_modes", purpose: "modes", prompt: "Choose one or both", min: 1, max: 2, options: [option("0"), option("1")] });
    expect(counter(both, togglePick(both, initialDraft(both), "1"))).toBe("1 of 1 or 2 chosen");
  });
});

describe("yes or no, remembered", () => {
  const may = pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "may", prompt: "Search your library?", yesLabel: "Yes", noLabel: "No", remember: "engine" });
  it("asks each time unless you choose to have the engine remember", () => {
    const d = initialDraft(may);
    expect(buttons(may, d, noCancel)).toMatchObject({ primary: "Yes, search your library", secondary: "No" });
    expect(d).toEqual({ kind: "yesno", remember: "ask" });
    expect(rememberLabels(may)).toEqual({ ask: "Ask each time", always: "Always search", never: "Never search" });
    expect(toAct(may, d, true)).toEqual({ kind: "decide_optional_effect", accept: true });
    const always: Draft = { kind: "yesno", remember: "always" };
    expect(buttons(may, always, noCancel)).toEqual({ primary: "Always search", secondary: "Ask each time", secondaryDoes: "ask" });
    expect(toAct(may, always)).toEqual({ kind: "decide_optional_effect_and_remember", accept: true });
    expect(toAct(may, { kind: "yesno", remember: "never" })).toEqual({ kind: "decide_optional_effect_and_remember", accept: false });
    // For every copy of the card where the engine allows it.
    expect(toAct({ ...may, rememberSameCard: true }, always)).toEqual({ kind: "decide_optional_effect_and_remember", accept: true, same_card: true });
    expect(changed(may, always)).toBe(true);
  });
  it("names a long question's buttons by what it asks", () => {
    const solemn = { ...may, prompt: "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle?" };
    expect(buttons(solemn, initialDraft(solemn), noCancel)).toMatchObject({ primary: "Search for a basic land", secondary: "Skip search" });
    expect(rememberLabels(solemn)).toEqual({ ask: "Ask each time", always: "Always search", never: "Never search" });
    const prose = { ...may, prompt: "Exile it. You may cast it." };
    expect(buttons(prose, initialDraft(prose), noCancel)).toMatchObject({ primary: "Yes", secondary: "No" });
    expect(rememberLabels(prose).always).toBe("Always yes");
  });
  it("asks only about Path to Exile's optional search, not whether to exile", () => {
    const path = { ...may, prompt: "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle." };
    const draft = initialDraft(path);
    expect(yesNoPresentation(path)).toMatchObject({ question: "Search your library for a basic land?" });
    expect(yesNoPresentation(path)?.detail).toContain("Skipping the search does not cancel the exile.");
    expect(buttons(path, draft, noCancel)).toMatchObject({ primary: "Search for a basic land", secondary: "Skip search", secondaryDoes: "no" });
    expect(toAct(path, draft, true)).toEqual({ kind: "decide_optional_effect", accept: true });
    expect(toAct(path, draft, false)).toEqual({ kind: "decide_optional_effect", accept: false });
    expect(rememberLabels(path)).toEqual({ ask: "Ask each time", always: "Always search", never: "Never search" });
  });
  it("does not infer a search from unrelated, conditional or different instructions", () => {
    for (const prompt of ["Exile it. You may cast it.", "You may search your library for a card.", "Search your library for a basic land card, put it into your hand, then shuffle?", "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle. Draw a card."]) {
      expect(yesNoPresentation({ ...may, prompt })).toBeNull();
    }
    const prompt = "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.";
    expect(yesNoPresentation({ ...may, prompt, answer: "pay_unless_cost" })).toBeNull();
  });
  it("never remembers where the engine can't", () => {
    const theirs = { ...may, remember: undefined };
    expect(toAct(theirs, { kind: "yesno", remember: "always" }, false)).toEqual({ kind: "decide_optional_effect", accept: false });
    expect(buttons(theirs, { kind: "yesno", remember: "always" }, noCancel).primary).toBe("Yes, search your library");
  });
  it("remembers a replacement's yes or no by its branch, and an order of two in full", () => {
    const optional = pending({ kind: "yesno", answer: "choose_replacement", purpose: "replacement", prompt: "Put it into your hand instead?", remember: "engine", options: [option("0")] });
    expect(toAct(optional, { kind: "yesno", remember: "never" })).toEqual({ kind: "choose_replacement_and_remember", choice: { type: "optional", index: 1 } });
    const order = pending({ answer: "choose_replacement", purpose: "replacement", min: 1, max: 1, remember: "engine", options: [option("0", { name: "Hardened Scales" }), option("1", { name: "Doubling Season" })] });
    const d = { ...togglePick(order, initialDraft(order), "1"), remember: true } as Draft;
    expect(buttons(order, d, noCancel).primary).toBe("Doubling Season first");
    expect(toAct(order, d)).toEqual({ kind: "choose_replacement_and_remember", choice: { type: "order", order: [1, 0] } });
    // Three effects: picking the first doesn't say the rest of the order, so nothing is remembered.
    const three = { ...order, options: [...order.options, option("2")] };
    expect(toAct(three, d)).toEqual({ kind: "choose_replacement", index: 1 });
  });
});

describe("putting cards in order", () => {
  const bottom = pending({ kind: "order", answer: "select_cards", purpose: "order", destination: "bottom", min: 3, max: 3, options: [option("11"), option("12"), option("13")] });
  it("sends left to right as the order, and drags an entry to any place", () => {
    const d = initialDraft(bottom);
    expect(toAct(bottom, d)).toEqual({ kind: "select_cards", cards: [11, 12, 13] });
    const dragged = moveTo(d, 2, 0);
    expect(dragged).toEqual({ kind: "order", ids: ["13", "11", "12"] });
    expect(buttons(bottom, dragged, noCancel)).toMatchObject({ primary: "Done", secondary: "Reset order" });
    expect(moveTo(d, 0, 5)).toEqual(d);
  });
  it("labels where each ends up", () => {
    expect([0, 1, 2].map((i) => orderTag(bottom, i, 3))).toEqual(["Highest of these", "Then", "Very bottom"]);
    const top = { ...bottom, destination: "top" as const };
    expect([0, 1].map((i) => orderTag(top, i, 2))).toEqual(["On top: drawn next", "Under it"]);
    const triggers = pending({ kind: "order", answer: "order_triggers", purpose: "triggers" });
    expect([0, 1, 2].map((i) => orderTag(triggers, i, 3))).toEqual(["Resolves first", "Then", "Resolves last"]);
  });
});

describe("splits on their targets", () => {
  const divide = pending({ kind: "split", answer: "distribute_among", purpose: "divide", unit: "damage", total: 3, perOptionMin: 1, options: [option("7", { toughness: 2, zone: "battlefield" }), option("p2", { zone: "player", controller: 2 })], defaultAnswer: { "7": 2, p2: 1 } });
  it("hints lethal damage from toughness, less damage already on it", () => {
    expect(lethalOf(divide.options[0]!)).toBe(2);
    expect(lethalOf(divide.options[0]!, 1)).toBe(1);
    expect(splitTag(divide, divide.options[0]!, 2)).toEqual({ text: "Dies", dies: true });
    expect(splitTag(divide, divide.options[0]!, 1)).toEqual({ text: "1 damage", dies: false });
    expect(splitTag(divide, divide.options[0]!, 1, 1)).toEqual({ text: "Dies", dies: true });
    expect(lethalOf(divide.options[1]!)).toBeUndefined();
    // Counters and life have no lethal hint.
    expect(splitTag({ ...divide, unit: "counters" }, divide.options[0]!, 2)).toBeNull();
  });
  it("never steps a target below its minimum, and puts the rest on one with Rest here", () => {
    const d = initialDraft(divide);
    expect(adjust(divide, d, "p2", -1)).toEqual(d);
    const freed = adjust(divide, d, "7", -1);
    expect(buttons(divide, freed, noCancel).primary).toBe("1 left to assign");
    expect(restHere(divide, freed, "p2")).toEqual({ kind: "split", amounts: { "7": 1, p2: 2 } });
  });
});

describe("numbers", () => {
  const talion = pending({ kind: "number", answer: "choose_option", purpose: "name", min: 1, max: 10 });
  it("starts a chosen number unchosen, with a key for each when there are few", () => {
    const d = initialDraft(talion);
    expect(d).toEqual({ kind: "number", value: null });
    expect(ready(talion, d)).toBe(false);
    expect(buttons(talion, d, noCancel).primary).toBe("Choose a number");
    expect(keypad(talion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stepNumber(talion, d, 1)).toEqual({ kind: "number", value: 1 });
    expect(keypad(pending({ kind: "number", answer: "choose_option", min: 0, max: 40 }))).toBeNull();
  });
  it("types digits: 1 then 0 is 10, and a digit past the range starts over", () => {
    let d = typeDigit(talion, initialDraft(talion), 1);
    d = typeDigit(talion, d, 0);
    expect(d).toEqual({ kind: "number", value: 10 });
    expect(typeDigit(talion, d, 3)).toEqual({ kind: "number", value: 3 });
    expect(typeDigit(talion, { kind: "number", value: null }, 0)).toEqual({ kind: "number", value: null });
  });
  it("starts X at its least, with the X on the button", () => {
    const x = pending({ kind: "number", answer: "choose_x", purpose: "x", min: 0, max: 9 });
    expect(initialDraft(x)).toEqual({ kind: "number", value: 0 });
    expect(keypad(x)).toBeNull();
    expect(buttons(x, setNumber(x, 7), { canCancel: false, spell: true }).primary).toBe("Cast for X = 7");
  });
});

describe("names", () => {
  it("puts cards in play first, then names starting with what's typed", () => {
    const found = ["Quintorius Kand", "Quintorius, Field Historian", "Aquin, the Typist"];
    expect(nameMatches("quin", null, ["Quintorius, History Chaser", "Sol Ring"], found).map((m) => m.name)).toEqual([
      "Quintorius, History Chaser",
      "Quintorius Kand",
      "Quintorius, Field Historian",
      "Aquin, the Typist",
    ]);
  });
  it("filters a fixed list, keeping the engine's order otherwise", () => {
    const types = ["Ajani", "Chandra", "Jace", "Quintorius"];
    expect(nameMatches("", types, ["Quintorius"], []).map((m) => m.name)).toEqual(["Quintorius", "Ajani", "Chandra", "Jace"]);
    expect(nameMatches("a", types, [], []).map((m) => m.name)).toEqual(["Ajani", "Chandra", "Jace"]);
  });
  it("names a card on the main button", () => {
    const needle = pending({ kind: "text", answer: "choose_option", purpose: "name", choiceType: "card name", freeEntry: true });
    expect(buttons(needle, initialDraft(needle), noCancel).primary).toBe("Choose a card name");
    expect(buttons(needle, { kind: "text", value: "Sol Ring" }, noCancel).primary).toBe("Name Sol Ring");
  });
});

describe("pairing", () => {
  const pair = pending({ kind: "pair", answer: "choose_pair", purpose: "pair", min: 0, max: 1, upTo: true, options: [option("4", { name: "Adeline" }), option("5", { name: "Aragorn" })] });
  it("pairs with one creature or none", () => {
    let d = togglePick(pair, initialDraft(pair), "4");
    d = togglePick(pair, d, "5");
    expect(d).toEqual({ kind: "pick", ids: ["5"] });
    expect(buttons(pair, d, noCancel)).toMatchObject({ primary: "Pair with Aragorn", secondary: "Don't pair", secondaryDoes: "none" });
    expect(toAct(pair, d)).toEqual({ kind: "choose_pair", partner: 5 });
    expect(noneAct(pair)).toEqual({ kind: "choose_pair", partner: null });
  });
});

describe("choosing targets on the board (GTarget, GTargetsMore)", () => {
  const players = [option("p1", { zone: "player", controller: 1, name: "Sam" }), option("p0", { zone: "player", controller: 0, name: "You" })];
  const bolt = pending({
    purpose: "target",
    answer: "choose_target",
    prompt: "Choose a target",
    min: 1,
    max: 1,
    options: [option("40", { zone: "battlefield", controller: 1, name: "Grizzly Bears" }), ...players],
  });
  it("picks targets on the board, players and spells included, and waits for the main button", () => {
    expect(isTargeting(bolt)).toBe(true);
    expect(onBoard(bolt)).toBe(true);
    expect(stageOf(bolt, true, false)).toBe("board");
    // On a phone too (GTargetPhone), unlike other picks.
    expect(stageOf(bolt, false, false)).toBe("board");
    expect(stageOf(pending({ purpose: "discard", options: [option("1", { zone: "hand" })] }), false, false)).toBe("sheet");
    // A counterspell's target is a spell on the stack; a graveyard card needs the dialog.
    expect(onBoard(pending({ ...bolt, options: [option("9", { zone: "stack" })] }))).toBe(true);
    expect(onBoard(pending({ ...bolt, options: [option("9", { zone: "graveyard" })] }))).toBe(false);
    let d = initialDraft(bolt);
    expect(counter(bolt, d)).toBe("0 of 1");
    expect(ready(bolt, d)).toBe(false);
    expect(buttons(bolt, d, { canCancel: true, spell: true })).toMatchObject({ primary: "Done (0/1)", secondary: "Cancel", secondaryDoes: "cancel" });
    d = togglePick(bolt, d, "p1");
    // A second click on another target switches to it.
    d = togglePick(bolt, d, "40");
    expect(d).toEqual({ kind: "pick", ids: ["40"] });
    expect(counter(bolt, d)).toBe("1 of 1");
    expect(buttons(bolt, d, { canCancel: true, spell: true }).primary).toBe("Cast it");
    expect(buttons(bolt, d, { canCancel: false, spell: false }).primary).toBe("Done");
    expect(toAct(bolt, d)).toEqual({ kind: "choose_target", target: { kind: "object", id: 40 } });
    expect(toAct(bolt, togglePick(bolt, initialDraft(bolt), "p1"))).toEqual({ kind: "choose_target", target: { kind: "player", seat: 1 } });
  });
  it("confirms one slot at a time, counting the ones already chosen", () => {
    const second = pending({ ...bolt, slot: [1, 2], picked: ["40"], min: 0 });
    const d = initialDraft(second);
    expect(counter(second, d)).toBe("1 of 2");
    // The second target is optional: the main button sends no target.
    expect(buttons(second, d, { canCancel: true, spell: true }).primary).toBe("No target");
    expect(noneAct(second)).toEqual({ kind: "choose_target", target: null });
    const first = pending({ ...bolt, slot: [0, 2] });
    expect(buttons(first, togglePick(first, initialDraft(first), "p1"), { canCancel: true, spell: true }).primary).toBe("Next target");
  });
  it("picks any number of targets, or all of them", () => {
    const many = pending({ purpose: "targets", answer: "select_cards", min: 0, max: 3, upTo: true, options: [option("1", { zone: "battlefield" }), option("2", { zone: "battlefield" }), option("3", { zone: "battlefield" })] });
    let d = initialDraft(many);
    expect(counter(many, d)).toBe("0 chosen, any number");
    expect(buttons(many, d, noCancel)).toMatchObject({ primary: "No targets", secondary: "Choose all", secondaryDoes: "all" });
    d = togglePick(many, togglePick(many, d, "1"), "3");
    expect(buttons(many, d, noCancel).primary).toBe("Done, 2 targets");
    expect(toAct(many, d)).toEqual({ kind: "select_cards", cards: [1, 3] });
  });
  it("keeps or changes a copy's target, and changes a spell's", () => {
    const options = [option("40", { zone: "battlefield", name: "Éowyn" }), option("41", { zone: "battlefield", name: "Adeline" })];
    const copy = pending({ purpose: "copy", answer: "choose_target", min: 1, max: 1, options, current: "40", defaultAnswer: ["40"], keepRest: true });
    let d = initialDraft(copy);
    expect(d).toEqual({ kind: "pick", ids: ["40"] });
    expect(buttons(copy, d, noCancel)).toMatchObject({ primary: "Keep Éowyn", secondary: null });
    expect(toAct(copy, d)).toEqual({ kind: "choose_target", target: { kind: "object", id: 40 } });
    d = togglePick(copy, d, "41");
    expect(buttons(copy, d, noCancel)).toMatchObject({ primary: "Copy targets Adeline", secondary: "Back to Éowyn", secondaryDoes: "reset" });
    // Several targets on the copy: the rest can be kept at once.
    const two = pending({ ...copy, slot: [0, 2] });
    expect(buttons(two, initialDraft(two), noCancel)).toMatchObject({ secondary: "Keep all targets", secondaryDoes: "keep-rest" });
    expect(counter(two, initialDraft(two))).toBe("Target 1 of 2");
    const retarget = pending({ ...copy, purpose: "retarget", answer: "retarget_spell", keepRest: false });
    expect(buttons(retarget, initialDraft(retarget), noCancel).primary).toBe("Leave it on Éowyn");
    const moved = togglePick(retarget, initialDraft(retarget), "41");
    expect(buttons(retarget, moved, noCancel).primary).toBe("Change to Adeline");
    expect(toAct(retarget, moved)).toEqual({ kind: "retarget_spell", new_targets: [{ kind: "object", id: 41 }] });
  });
});

describe("tapping creatures for crew and enlist (GCombatMore)", () => {
  const crew = pending({
    purpose: "crew",
    answer: "crew_vehicle",
    min: 1,
    max: 3,
    upTo: true,
    need: 3,
    source: { id: 70, name: "Skysovereign", controller: 0 },
    options: [option("1", { zone: "battlefield", power: 2 }), option("2", { zone: "battlefield", power: 1 }), option("3", { zone: "battlefield", power: 5 })],
  });
  it("adds up the engine's crew power and crews once it reaches the need", () => {
    expect(isTapping(crew)).toBe(true);
    expect(stageOf(crew, false, false)).toBe("board");
    let d = togglePick(crew, initialDraft(crew), "1");
    expect(powerOf(crew, d)).toBe(2);
    expect(counter(crew, d)).toBe("2 of 3 power");
    expect(ready(crew, d)).toBe(false);
    expect(buttons(crew, d, { canCancel: true, spell: false })).toMatchObject({ primary: "2 of 3 power", secondary: "Cancel" });
    d = togglePick(crew, d, "2");
    expect(ready(crew, d)).toBe(true);
    expect(buttons(crew, d, { canCancel: true, spell: false }).primary).toBe("Crew (2 tapped)");
    expect(toAct(crew, d)).toEqual({ kind: "crew_vehicle", vehicle: 70, creatures: [1, 2] });
  });
  it("enlists one creature or none", () => {
    const enlist = pending({ purpose: "enlist", answer: "choose_enlist", min: 0, max: 1, upTo: true, options: [option("5", { zone: "battlefield", name: "Faramir" })] });
    expect(buttons(enlist, initialDraft(enlist), noCancel)).toMatchObject({ primary: "Choose a creature", secondary: "Don't enlist", secondaryDoes: "none" });
    expect(noneAct(enlist)).toEqual({ kind: "choose_enlist", target: null });
    const d = togglePick(enlist, initialDraft(enlist), "5");
    expect(buttons(enlist, d, noCancel).primary).toBe("Enlist Faramir");
    expect(toAct(enlist, d)).toEqual({ kind: "choose_enlist", target: 5 });
  });
  it("pays an attack tax and exerts with the engine's yes and no", () => {
    const tax = pending({ kind: "yesno", purpose: "tax", answer: "pay_combat_tax", prompt: "Pay {4} to attack with Éowyn and Adeline?", yesLabel: "Pay {4}", noLabel: "Don't pay", min: 1, max: 1 });
    expect(buttons(tax, initialDraft(tax), noCancel)).toMatchObject({ primary: "Pay {4}", secondary: "Don't pay" });
    expect(toAct(tax, initialDraft(tax), true)).toEqual({ kind: "pay_combat_tax", accept: true });
    expect(toAct(tax, initialDraft(tax), false)).toEqual({ kind: "pay_combat_tax", accept: false });
    const exert = pending({ kind: "yesno", purpose: "exert", answer: "choose_exert", prompt: "Exert Glorybringer as it attacks?", yesLabel: "Exert", noLabel: "Don't exert", min: 1, max: 1 });
    expect(buttons(exert, initialDraft(exert), noCancel)).toMatchObject({ primary: "Exert", secondary: "Don't exert" });
    expect(toAct(exert, initialDraft(exert), false)).toEqual({ kind: "choose_exert", exert: false });
  });
});
