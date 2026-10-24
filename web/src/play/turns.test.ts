import { describe, expect, it } from "vitest";
import { DEFAULT_STOPS, stopsMessage } from "./model";
import { answerBy, answerOf, modeChip, moved, passChoices, passKey, priorityPartner, settingsButtons, shift, stopMapOf, waitingPartner } from "./turns";
import type { AnswerView, StackItem, TurnsView } from "./types";

const key = (k: string, shift = false) => ({ key: k, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false });
const turns = (extra: Partial<TurnsView> = {}): TurnsView => ({ full_control: false, stops: null, yields: [], answers: [], ...extra });
const item = (controller: number): StackItem => ({ name: "Opt", controller });

describe("the ways to pass (GPriority)", () => {
  it("offers Pass once only on your priority, and Resolve all only with something on the stack", () => {
    const waiting = passChoices({ yourTurn: false, yourPriority: false, stack: 1, fullControl: false });
    expect(waiting.find((c) => c.id === "once")?.disabled).toBe(true);
    expect(waiting.some((c) => c.id === "resolve_all")).toBe(false);
    const responding = passChoices({ yourTurn: false, yourPriority: true, stack: 2, fullControl: true });
    expect(responding.map((c) => c.id)).toEqual(["once", "until", "turn", "mine", "resolve_all", "full"]);
    expect(responding.find((c) => c.id === "full")?.on).toBe(true);
    expect(passChoices({ yourTurn: false, yourPriority: true, stack: 0, fullControl: false }).some((c) => c.id === "resolve_all")).toBe(false);
  });

  it("calls Shift+Enter End turn on your own turn", () => {
    const mine = passChoices({ yourTurn: true, yourPriority: true, stack: 0, fullControl: false });
    expect(mine.find((c) => c.key === "Shift Enter")).toMatchObject({ id: "end", label: "End turn" });
    const theirs = passChoices({ yourTurn: false, yourPriority: true, stack: 0, fullControl: false });
    expect(theirs.find((c) => c.key === "Shift Enter")).toMatchObject({ id: "turn", label: "Pass the rest of this turn" });
  });

  it("reads Enter, Shift+Enter, P and F, and nothing with Ctrl or Cmd", () => {
    expect(passKey(key("Enter"), false)).toBe("until");
    expect(passKey(key("Enter", true), false)).toBe("turn");
    expect(passKey(key("Enter", true), true)).toBe("end");
    expect(passKey(key("p"), false)).toBe("mine");
    expect(passKey(key("F"), true)).toBe("full");
    expect(passKey({ ...key("f"), ctrlKey: true }, true)).toBeNull();
    expect(passKey({ ...key("Enter"), metaKey: true }, true)).toBeNull();
    expect(passKey(key("P", true), true)).toBeNull();
    expect(passKey(key("x"), true)).toBeNull();
  });

  it("names each mode on its chip", () => {
    expect(modeChip("mine")).toBe("Passing to your turn");
    expect(modeChip("until")).toBe("Passing until something happens");
    expect(modeChip("turn")).toBe("Passing the rest of this turn");
    expect(modeChip("end")).toBe("Ending your turn");
  });
});

describe("the main button's partner (GButtons)", () => {
  it("while you hold priority", () => {
    expect(priorityPartner({ stack: [item(1)], active: 0, phase: "PreCombatMain" }, 0)).toMatchObject({ label: "More ways to pass", does: "menu" });
    expect(priorityPartner({ stack: [], active: 0, phase: "PreCombatMain" }, 0)).toMatchObject({ label: "End turn", does: "end" });
    expect(priorityPartner({ stack: [], active: 0, phase: "PostCombatMain" }, 0)).toBeNull();
    expect(priorityPartner({ stack: [], active: 2, phase: "End" }, 0)).toMatchObject({ label: "Pass to my turn", does: "mine" });
    expect(priorityPartner({ stack: [], active: 0, phase: "Upkeep" }, 0)).toMatchObject({ does: "menu" });
  });

  it("while you wait: hold priority for your own spell, or pass to your turn", () => {
    const view = { stack: [item(0)], active: 0, over: false };
    expect(waitingPartner(view, 0, turns())).toMatchObject({ label: "Hold priority", does: "hold", pressed: false });
    expect(waitingPartner(view, 0, turns({ hold: true }))).toMatchObject({ label: "Holding priority", does: "unhold", pressed: true });
    expect(waitingPartner({ stack: [], active: 1, over: false }, 0, turns())).toMatchObject({ does: "mine" });
    expect(waitingPartner({ stack: [], active: 1, over: false }, 0, turns({ passing: "mine" }))).toBeNull();
    expect(waitingPartner({ stack: [item(1)], active: 1, over: false }, 0, turns())).toBeNull();
    expect(waitingPartner({ stack: [], active: 1, over: true }, 0, turns())).toBeNull();
    expect(waitingPartner({ stack: [], active: 1, over: false }, null, turns())).toBeNull();
  });
});

describe("saved stops", () => {
  it("come back from the server's shape as the ladder shows them", () => {
    expect(stopMapOf(null)).toBeNull();
    const map = stopMapOf({ own: ["Upkeep", "PreCombatMain"], others: ["End", "DeclareBlockers"] })!;
    expect(map["Upkeep"]).toEqual({ mine: true, opp: false });
    expect(map["Blockers"]).toEqual({ mine: false, opp: true });
    expect(map["End"]).toEqual({ mine: false, opp: true });
    expect(map["Draw"]).toEqual({ mine: false, opp: false });
    // And round-trip through the message the board sends.
    expect(stopMapOf(stopsMessage(map))).toEqual(map);
    expect(stopsMessage(stopMapOf(stopsMessage(DEFAULT_STOPS)))).toBeNull();
  });
});

describe("game settings (GSettings) and the log's automatic answers (GLog)", () => {
  const answer: AnswerView = { id: "m1", kind: "may", name: "Solemn Simulacrum", answer: "Always yes", scope: "copies", forget: { kind: "set_may_trigger_auto_choice", change: { op: "clear_all" } } };

  it("finds the answer a log line names, while it's still on", () => {
    expect(answerOf({ turn: 3, text: "Yama answered yes", seat: 0, auto: "m1" }, turns({ answers: [answer] }))).toBe(answer);
    expect(answerOf({ turn: 3, text: "Yama answered yes", seat: 0, auto: "m1" }, turns())).toBeNull();
    expect(answerOf({ turn: 3, text: "Ben drew a card." }, turns({ answers: [answer] }))).toBeNull();
    expect(answerBy(answer)).toBe("Remembered by the engine for every copy of this card");
    expect(answerBy({ ...answer, scope: "card" })).toBe("Remembered by the engine for this card");
  });

  it("moves cards in your hand", () => {
    expect(shift([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(shift([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(shift([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
    expect(moved([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moved([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moved([1, 2, 3], 1, 5)).toEqual([1, 2, 3]);
  });

  it("confirms only from the main button, and conceding asks with Cancel beside it", () => {
    expect(settingsButtons("yields")).toMatchObject({ primary: "Close", secondary: null });
    expect(settingsButtons("hand")).toMatchObject({ primary: "Done", secondary: null });
    expect(settingsButtons("concede")).toEqual({ title: "Concede?", body: "You leave the game. This can't be undone.", primary: "Concede", secondary: "Cancel" });
  });
});
