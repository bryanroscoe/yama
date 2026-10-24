// Ways to cast, permanents and counters (play/src/ways.rs; GCastWays, GPermanents, GCounters):
// the drafts, buttons and answers answer.ts builds for them.

import { describe, expect, it } from "vitest";
import { adjust, buttons, castable, counter, initialDraft, isCastOffer, isFaceChoice, isPermanentPick, left, onBoard, pickTag, ready, room, stageOf, toAct, togglePick } from "./answer";
import type { DecisionOption, Pending } from "./types";

const option = (id: string, extra: Partial<DecisionOption> = {}): DecisionOption => ({ id, name: `Card ${id}`, eligible: true, ...extra });
const pending = (extra: Partial<Pending>): Pending => ({
  kind: "pick",
  prompt: "Choose",
  options: [],
  min: 1,
  max: 1,
  upTo: false,
  answer: "select_cards",
  purpose: "choose",
  ...extra,
});
const noCancel = { canCancel: false, spell: true };

describe("cast offers", () => {
  const cascade = pending({
    kind: "yesno",
    answer: "cast_offer",
    purpose: "cascade",
    prompt: "Cast Young Pyromancer without paying its mana cost?",
    yesLabel: "Cast it free",
    noLabel: "Don't cast",
    options: [option("4", { name: "Island", eligible: false, zone: "exile" }), option("5", { name: "Young Pyromancer", zone: "exile" })],
  });
  it("is a dialog on a laptop and the dock's sheet on a phone, with the engine's own buttons", () => {
    expect(isCastOffer(cascade)).toBe(true);
    expect(stageOf(cascade, true, false)).toBe("dialog");
    expect(stageOf(cascade, false, false)).toBe("sheet");
    const d = initialDraft(cascade);
    expect(buttons(cascade, d, noCancel)).toMatchObject({ primary: "Cast it free", secondary: "Don't cast", secondaryDoes: "no" });
    expect(toAct(cascade, d, true)).toEqual({ kind: "cast_offer", cast: true });
    expect(toAct(cascade, d, false)).toEqual({ kind: "cast_offer", cast: false });
  });
  it("offers only the no when the engine can't cast it", () => {
    const madness = pending({ ...cascade, purpose: "madness", yesLabel: "Cast for {R}", noLabel: "Put it into your graveyard", options: [option("9", { name: "Fiery Temper", eligible: false })] });
    expect(castable(madness)).toBe(false);
    const d = initialDraft(madness);
    expect(buttons(madness, d, noCancel)).toEqual({ primary: "Put it into your graveyard", secondary: null, secondaryDoes: null });
    expect(toAct(madness, d, true)).toEqual({ kind: "cast_offer", cast: false });
  });
});

describe("faces, costs and ways to cast", () => {
  const adventure = pending({
    answer: "choose_adventure_face",
    purpose: "adventure",
    prompt: "Which half do you cast?",
    options: [option("creature", { name: "Bonecrusher Giant", cost: "{2}{R}" }), option("adventure", { name: "Stomp", cost: "{1}{R}" })],
  });
  it("waits for a half, then casts it", () => {
    expect(isFaceChoice(adventure)).toBe(true);
    expect(stageOf(adventure, true, false)).toBe("dialog");
    let d = initialDraft(adventure);
    expect(ready(adventure, d)).toBe(false);
    expect(buttons(adventure, d, { canCancel: true, spell: true })).toMatchObject({ primary: "Choose a half", secondary: "Cancel" });
    d = togglePick(adventure, d, "adventure");
    expect(buttons(adventure, d, noCancel).primary).toBe("Cast Stomp");
    expect(toAct(adventure, d)).toEqual({ kind: "choose_adventure_face", creature: false });
    expect(counter(adventure, d)).toBe("");
  });
  it("answers each kind of choice with its own act", () => {
    const pick = (p: Pending, id: string) => togglePick(p, initialDraft(p), id);
    const face = pending({ answer: "choose_modal_face", purpose: "face", options: [option("front", { name: "Halvar, God of Battle" }), option("back", { name: "Sword of the Realms" })] });
    expect(toAct(face, pick(face, "back"))).toEqual({ kind: "choose_modal_face", back_face: true });
    expect(buttons(face, pick(face, "back"), noCancel).primary).toBe("Cast Sword of the Realms");
    const cost = pending({ answer: "choose_alternative_cast", purpose: "alt_cost", options: [option("normal", { name: "Mana cost", cost: "{1}{U}" }), option("alternative", { name: "Overload", cost: "{6}{U}" })] });
    expect(buttons(cost, pick(cost, "alternative"), noCancel).primary).toBe("Overload for {6}{U}");
    expect(buttons(cost, pick(cost, "normal"), noCancel).primary).toBe("Cast for {1}{U}");
    expect(toAct(cost, pick(cost, "alternative"))).toEqual({ kind: "choose_alternative_cast", alternative: true });
    const way = pending({ answer: "choose_casting_variant", purpose: "variant", options: [option("0", { name: "Flashback", cost: "{2}{U}" })] });
    expect(buttons(way, pick(way, "0"), noCancel).primary).toBe("Flashback for {2}{U}");
    expect(toAct(way, pick(way, "0"))).toEqual({ kind: "choose_casting_variant", index: 0 });
    const mutate = pending({ answer: "choose_mutate_side", purpose: "mutate", options: [option("top", { name: "Vulpikeet" }), option("bottom", { name: "Emeria Angel" })] });
    expect(buttons(mutate, pick(mutate, "top"), noCancel).primary).toBe("Put Vulpikeet on top");
    expect(buttons(mutate, pick(mutate, "bottom"), noCancel).primary).toBe("Put it underneath");
    expect(toAct(mutate, pick(mutate, "bottom"))).toEqual({ kind: "choose_mutate_side", top: false });
  });
});

describe("permanents on the board", () => {
  const legend = pending({
    answer: "choose_legend",
    purpose: "legend",
    prompt: "Choose the Aragorn, King of Gondor to keep",
    options: [option("7", { name: "Aragorn, King of Gondor", zone: "battlefield", controller: 0 }), option("8", { name: "Aragorn, King of Gondor", zone: "battlefield", controller: 0 })],
  });
  it("keeps one legend and marks the other for the graveyard", () => {
    expect(isPermanentPick(legend)).toBe(true);
    expect(onBoard(legend)).toBe(true);
    expect(stageOf(legend, true, false)).toBe("board");
    expect(stageOf(legend, false, false)).toBe("sheet");
    let d = initialDraft(legend);
    expect(pickTag(legend, d, "8")).toBeNull();
    expect(buttons(legend, d, noCancel).primary).toBe("Choose one to keep");
    d = togglePick(legend, d, "7");
    expect(pickTag(legend, d, "7")).toEqual({ text: "Keep", tone: "plain" });
    expect(pickTag(legend, d, "8")).toEqual({ text: "To graveyard", tone: "bad" });
    expect(buttons(legend, d, noCancel).primary).toBe("Keep Aragorn, King of Gondor");
    expect(toAct(legend, d)).toEqual({ kind: "choose_legend", keep: 7 });
  });
  it("names the Ring-bearer now, and the one chosen", () => {
    const ring = pending({ answer: "choose_ring_bearer", purpose: "ring", current: "3", options: [option("3", { name: "Faramir", zone: "battlefield" }), option("4", { name: "Éowyn", zone: "battlefield" })] });
    let d = initialDraft(ring);
    expect(pickTag(ring, d, "3")).toEqual({ text: "Ring-bearer now", tone: "dim" });
    d = togglePick(ring, d, "4");
    expect(pickTag(ring, d, "4")).toEqual({ text: "Ring-bearer", tone: "plain" });
    expect(buttons(ring, d, noCancel).primary).toBe("Éowyn bears the Ring");
    expect(toAct(ring, d)).toEqual({ kind: "choose_ring_bearer", target: 4 });
  });
  it("puts empower Jace's loyalty on the Jace token chosen", () => {
    const jace = pending({
      purpose: "empower",
      prompt: "Empower Jace 2: choose a Jace token",
      total: 2,
      options: [option("21", { name: "Jace", zone: "battlefield", counters: [["loyalty", 3]] }), option("22", { name: "Jace", zone: "battlefield", counters: [["loyalty", 1]] })],
    });
    let d = initialDraft(jace);
    expect(pickTag(jace, d, "21")).toEqual({ text: "Loyalty 3", tone: "dim" });
    d = togglePick(jace, d, "22");
    expect(pickTag(jace, d, "22")).toEqual({ text: "1 → 3", tone: "plain" });
    expect(pickTag(jace, d, "22", true)).toEqual({ text: "Loyalty 1 → 3", tone: "plain" });
    expect(buttons(jace, d, noCancel).primary).toBe("Put 2 on this Jace");
    expect(toAct(jace, d)).toEqual({ kind: "select_cards", cards: [22] });
  });
  it("equips from the Equipment asking, and copies with a clone", () => {
    const equip = pending({ answer: "equip", purpose: "equip", source: { id: 9, name: "Swiftfoot Boots", controller: 0 }, options: [option("3", { zone: "battlefield", name: "Faramir" })] });
    const d = togglePick(equip, initialDraft(equip), "3");
    expect(buttons(equip, d, { canCancel: true, spell: false })).toMatchObject({ primary: "Equip Faramir", secondary: "Cancel" });
    expect(toAct(equip, d)).toEqual({ kind: "equip", equipment: 9, target: 3 });
    const clone = pending({ answer: "choose_target", purpose: "clone", options: [option("5", { zone: "battlefield", name: "Grave Titan", controller: 1 })] });
    const c = togglePick(clone, initialDraft(clone), "5");
    expect(buttons(clone, c, noCancel).primary).toBe("Copy Grave Titan");
    expect(pickTag(clone, c, "5")).toEqual({ text: "Copying", tone: "plain" });
    expect(toAct(clone, c)).toEqual({ kind: "choose_target", target: { kind: "object", id: 5 } });
  });
});

describe("counters", () => {
  const proliferate = pending({
    answer: "select_targets",
    purpose: "proliferate",
    prompt: "Proliferate",
    min: 0,
    max: 3,
    upTo: true,
    options: [
      option("7", { name: "Éowyn", zone: "battlefield", controller: 0, counters: [["+1/+1", 2]] }),
      option("8", { name: "Quintorius", zone: "battlefield", controller: 1, counters: [["loyalty", 5]] }),
      option("p1", { name: "Sam", zone: "player", controller: 1, counters: [["poison", 3]] }),
    ],
  });
  it("picks any number of permanents and players on the board", () => {
    expect(onBoard(proliferate)).toBe(true);
    let d = initialDraft(proliferate);
    expect(ready(proliferate, d)).toBe(true);
    expect(buttons(proliferate, d, noCancel)).toMatchObject({ primary: "Proliferate nothing", secondary: null });
    d = togglePick(proliferate, d, "7");
    d = togglePick(proliferate, d, "p1");
    expect(counter(proliferate, d)).toBe("2 chosen");
    expect(pickTag(proliferate, d, "7")).toEqual({ text: "+1/+1 ×2 → ×3", tone: "plain" });
    expect(pickTag(proliferate, d, "8")).toEqual({ text: "loyalty ×5", tone: "dim" });
    expect(buttons(proliferate, d, noCancel)).toMatchObject({ primary: "Proliferate (2)", secondary: "Clear", secondaryDoes: "clear" });
    expect(toAct(proliferate, d)).toEqual({ kind: "select_targets", targets: [{ kind: "object", id: 7 }, { kind: "player", seat: 1 }] });
  });
  it("moves counters up to what there is, each kind shared among where they go", () => {
    const move = pending({
      kind: "split",
      answer: "move_counters",
      purpose: "move_counters",
      min: 0,
      max: 3,
      total: 3,
      upTo: true,
      unit: "counters",
      origin: "6",
      options: [
        option("11", { name: "Aragorn", zone: "battlefield", group: "P1P1", cap: 3, text: "+1/+1 counters" }),
        option("12", { name: "Faramir", zone: "battlefield", group: "P1P1", cap: 3, text: "+1/+1 counters" }),
      ],
    });
    let d = initialDraft(move);
    expect(ready(move, d)).toBe(true);
    expect(buttons(move, d, noCancel)).toMatchObject({ primary: "Move none", secondary: null });
    d = adjust(move, d, "11", 2);
    expect(room(move, d, "12")).toBe(1);
    d = adjust(move, d, "12", 5);
    expect(d).toEqual({ kind: "split", amounts: { "11": 2, "12": 1 } });
    expect(left(move, d)).toBe(0);
    expect(counter(move, d)).toBe("3 of 3");
    expect(buttons(move, d, noCancel)).toMatchObject({ primary: "Move 3", secondary: "Reset", secondaryDoes: "reset" });
    expect(toAct(move, d)).toEqual({ kind: "move_counters", moves: [{ on: 11, counter: "P1P1", count: 2 }, { on: 12, counter: "P1P1", count: 1 }] });
    // Several kinds: the option names the permanent and the kind.
    const two = { ...move, options: [option("11:P1P1", { group: "P1P1", cap: 1 }), option("11:stun", { group: "stun", cap: 2 })], total: 3 };
    const t = adjust(two, adjust(two, initialDraft(two), "11:stun", 9), "11:P1P1", 1);
    expect(toAct(two, t)).toEqual({ kind: "move_counters", moves: [{ on: 11, counter: "P1P1", count: 1 }, { on: 11, counter: "stun", count: 2 }] });
  });
  it("removes any number of each kind as an ability resolves", () => {
    const remove = pending({ kind: "split", answer: "remove_counters", purpose: "remove_counters", min: 0, max: 3, total: 3, upTo: true, unit: "counters", options: [option("P1P1", { name: "+1/+1 counters", group: "P1P1", cap: 1 }), option("stun", { name: "stun counters", group: "stun", cap: 2 })] });
    let d = adjust(remove, initialDraft(remove), "P1P1", 4);
    expect(d).toEqual({ kind: "split", amounts: { P1P1: 1, stun: 0 } });
    d = adjust(remove, d, "stun", 1);
    expect(buttons(remove, d, noCancel).primary).toBe("Remove 2");
    expect(toAct(remove, d)).toEqual({ kind: "remove_counters", counters: [{ counter: "P1P1", count: 1 }, { counter: "stun", count: 1 }] });
  });
  it("removes exactly the cost from among permanents", () => {
    const cost = pending({
      kind: "split",
      answer: "remove_counter_cost",
      purpose: "counter_cost",
      min: 0,
      max: 2,
      total: 2,
      unit: "counters",
      options: [option("3", { zone: "battlefield", group: "P1P1", cap: 1 }), option("4", { zone: "battlefield", group: "P1P1", cap: 2 })],
    });
    let d = initialDraft(cost);
    d = adjust(cost, d, "3", 5);
    expect(d).toEqual({ kind: "split", amounts: { "3": 1, "4": 0 } });
    expect(ready(cost, d)).toBe(false);
    expect(counter(cost, d)).toBe("1 left to remove");
    expect(buttons(cost, d, { canCancel: true, spell: false })).toMatchObject({ primary: "1 left to remove", secondary: "Cancel" });
    d = adjust(cost, d, "4", 1);
    expect(ready(cost, d)).toBe(true);
    expect(buttons(cost, d, noCancel).primary).toBe("Remove 2");
    expect(toAct(cost, d)).toEqual({ kind: "remove_counter_cost", counters: [{ on: 3, counter: "P1P1", count: 1 }, { on: 4, counter: "P1P1", count: 1 }] });
  });
});
