import { describe, expect, it } from "vitest";
import { buttons, initialDraft, onBoard, phyrexianLife, phyrexianMana, ready, stageOf, toAct, togglePick } from "./answer";
import { PreviewCache, keptNote, manaText, paidInFull, paymentButtons, paymentStatus, paymentTitle, penaltyText, poolText, sourceChip, sourceClick } from "./pay";
import type { DecisionOption, ManaSourceView, PaymentView, Pending } from "./types";

const plains: ManaSourceView = { id: 1, name: "Plains", zone: "battlefield", choices: [{ key: "tap:-:W", kind: "tap", mana: ["W"], text: "Add {W}" }] };
const tower: ManaSourceView = {
  id: 2,
  name: "Command Tower",
  zone: "battlefield",
  choices: ["W", "U", "R"].map((m) => ({ key: `tap:0:${m}`, kind: "tap" as const, mana: [m], text: `Add {${m}}` })),
};
const forge: ManaSourceView = {
  id: 3,
  name: "Battlefield Forge",
  zone: "battlefield",
  choices: [
    { key: "tap:0:C", kind: "tap", mana: ["C"], text: "Add {C}" },
    { key: "tap:1:R", kind: "tap", mana: ["R"], text: "Add {R}", penalty: { kind: "damage", amount: 1 } },
  ],
};
const treasure: ManaSourceView = { id: 4, name: "Treasure", zone: "battlefield", choices: [{ key: "ability:0", kind: "ability", mana: ["any"], text: "{T}, Sacrifice this token: Add one mana of any color.", penalty: { kind: "sacrifice" } }] };

const payment = (extra: Partial<PaymentView> = {}): PaymentView => ({
  payingFor: { id: 9, name: "Akroma's Will", ability: false },
  cost: "{3}{W}",
  pips: [
    { symbol: "W", paid: false },
    { symbol: "1", paid: false },
    { symbol: "1", paid: false },
    { symbol: "1", paid: false },
  ],
  pool: [],
  sources: [plains, tower, forge, treasure],
  untap: [],
  kept: [],
  payRest: true,
  cancel: true,
  ...extra,
});

describe("paying by hand", () => {
  it("taps a source with one way to use it, and opens the menu of one with several", () => {
    const p = payment();
    expect(sourceClick(p, [1])).toEqual({ does: "tap", act: { kind: "tap_mana", source: 1, choice: "tap:-:W" } });
    expect(sourceClick(p, [2])).toEqual({ does: "menu", source: tower });
    expect(sourceClick(p, [3])?.does).toBe("menu");
    // Nothing to do with a card that isn't a source.
    expect(sourceClick(p, [42])).toBeNull();
  });

  it("untaps a source tapped by hand where the engine allows, and only there", () => {
    const p = payment({ sources: [tower], untap: [1] });
    expect(sourceClick(p, [1])).toEqual({ does: "untap", act: { kind: "untap_mana", source: 1 } });
    // A pile of Plains: the next untapped one first, then the last one tapped comes back.
    const pile = payment({ sources: [plains], untap: [5, 6] });
    expect(sourceClick(pile, [1, 5, 6])?.does).toBe("tap");
    const spent = payment({ sources: [], untap: [5, 6] });
    expect(sourceClick(spent, [1, 5, 6])).toEqual({ does: "untap", act: { kind: "untap_mana", source: 6 } });
    // A painland's tap is final: no untap, and the board says so.
    const final = payment({ sources: [], kept: [{ id: 3, name: "Battlefield Forge", penalty: { kind: "damage", amount: 1 } }] });
    expect(sourceClick(final, [3])).toBeNull();
    expect(sourceChip(final, [3])).toEqual({ text: "Tapped, final", tapped: true });
  });

  it("names what each source makes and what it costs beyond the tap", () => {
    const p = payment();
    expect(sourceChip(p, [1])).toEqual({ text: "W", tapped: false });
    expect(sourceChip(p, [2])?.text).toBe("W/U/R");
    expect(sourceChip(p, [3])?.text).toBe("C/R");
    expect(sourceChip(payment({ sources: [{ ...forge, choices: [forge.choices[1]!] }] }), [3])?.text).toBe("R, 1 damage");
    expect(sourceChip(p, [4])?.text).toBe("Any, sacrifice");
    expect(sourceChip(payment({ untap: [7] }), [7])).toEqual({ text: "Tapped", tapped: true });
    // A rock tapped by hand the engine won't untap: tapped, and a click does nothing.
    const rock = payment({ sources: [], pool: [{ mana: "C", source: 8, name: "Sol Ring" }] });
    expect(sourceChip(rock, [8])).toEqual({ text: "Tapped", tapped: true });
    expect(sourceClick(rock, [8])).toBeNull();
    expect(penaltyText({ kind: "life", amount: 2 })).toBe("Pay 2 life");
    expect(penaltyText({ kind: "other" })).toBe("Can't be undone");
    expect(manaText(["C", "C"])).toBe("{C}{C}");
    expect(manaText(["any"])).toBe("any color");
  });

  it("says what's in the pool, by mana and card", () => {
    const p = payment({
      pool: [
        { mana: "W", source: 1, name: "Plains" },
        { mana: "C", source: 8, name: "Sol Ring" },
        { mana: "C", source: 8, name: "Sol Ring" },
        { mana: "R", source: 5, name: "Raging Goblin", convoke: true },
      ],
    });
    expect(poolText(p)).toEqual(["{W} from Plains", "2 {C} from Sol Ring", "{R} for Raging Goblin"]);
  });

  it("says Pay the rest until the pool covers the cost, then Cast", () => {
    const p = payment();
    expect(paymentTitle(p)).toBe("Pay {3}{W} for Akroma's Will");
    expect(paymentButtons(p)).toEqual({ primary: "Pay the rest", secondary: "Cancel" });
    expect(paymentStatus(p, false)).toBe("Click an amber land or rock to tap it. Click a tapped one to untap it.");
    expect(paymentStatus(p, true)).toBe("Tap an amber source to use it. Tap it again to untap it.");
    const paid = payment({ pips: p.pips.map((x) => ({ ...x, paid: true })), pool: Array.from({ length: 5 }, () => ({ mana: "W", name: "Plains" })) });
    expect(paidInFull(paid)).toBe(true);
    expect(paymentButtons(paid).primary).toBe("Cast Akroma's Will");
    expect(paymentStatus(paid, false)).toBe("Paid, with 1 extra in your pool until the step ends.");
    // An ability is activated; a mana ability's own cost has no pass to pay the rest.
    expect(paymentButtons({ ...paid, payingFor: { id: 1, name: "Gilded Lotus", ability: true } }).primary).toBe("Activate Gilded Lotus");
    expect(paymentButtons(payment({ payRest: false, cancel: true })).primary).toBeNull();
  });

  it("never says cancelling undoes damage or a sacrifice", () => {
    expect(keptNote(payment())).toBeNull();
    const one = payment({ kept: [{ id: 3, name: "Battlefield Forge", penalty: { kind: "damage", amount: 1 } }] });
    expect(keptNote(one)).toBe("Battlefield Forge's 1 damage to you stays. Canceling won't undo this.");
    const two = payment({ kept: [...one.kept, { id: 4, name: "Treasure", penalty: { kind: "sacrifice" } }] });
    expect(keptNote(two)).toBe("Battlefield Forge's 1 damage to you stays. Treasure is gone. Canceling won't undo these.");
  });
});

describe("the auto-tap preview", () => {
  it("asks once per card and board, again only after a second without an answer", () => {
    const c = new PreviewCache();
    expect(c.shouldAsk(3, 10, 0)).toBe(true);
    expect(c.shouldAsk(3, 10, 500)).toBe(false);
    expect(c.shouldAsk(3, 10, 1500)).toBe(true);
    c.put(3, 10, [1, 2]);
    expect(c.get(3, 10)).toEqual([1, 2]);
    expect(c.shouldAsk(3, 10, 9000)).toBe(false);
    // A new board starts over.
    expect(c.get(4, 10)).toBeUndefined();
    expect(c.shouldAsk(4, 10, 9000)).toBe(true);
  });
});

const option = (id: string, extra: Partial<DecisionOption> = {}): DecisionOption => ({ id, name: id, eligible: true, ...extra });
const pending = (extra: Partial<Pending>): Pending => ({ kind: "pick", prompt: "Choose", options: [], min: 1, max: 1, upTo: false, answer: "select_cards", purpose: "choose", ...extra });
const opts = { canCancel: true, spell: true };

describe("questions while paying", () => {
  it("asks before sacrificing a Treasure: Sacrifice it, or Keep it to pay by hand", () => {
    const p = pending({ answer: "tap_mana", purpose: "mana_source", prompt: "Sacrifice Treasure for mana?", options: [option("40", { name: "Treasure", zone: "battlefield" })], defaultAnswer: ["40"] });
    const d = initialDraft(p);
    expect(buttons(p, d, { canCancel: false, spell: true })).toEqual({ primary: "Sacrifice it", secondary: "Keep it", secondaryDoes: "keep-mana" });
    expect(toAct(p, d)).toEqual({ kind: "tap_mana", source: 40 });
    // It's picked on the board, on a phone too.
    expect(onBoard(p)).toBe(true);
    expect(stageOf(p, false, false)).toBe("board");
  });

  it("adds a colour of mana, or a whole combination", () => {
    const colour = pending({ answer: "choose_mana_color", purpose: "color", options: ["W", "U", "R"].map((c) => option(c)) });
    let d = togglePick(colour, initialDraft(colour), "R");
    expect(buttons(colour, d, opts).primary).toBe("Add {R}");
    expect(toAct(colour, d)).toEqual({ kind: "choose_mana_color", mana: ["R"] });
    expect(stageOf(colour, true, false)).toBe("dialog");
    const combo = pending({ answer: "choose_mana_color", purpose: "combo", options: [option("WU", { name: "{W}{U}" }), option("UU", { name: "{U}{U}" })] });
    d = togglePick(combo, initialDraft(combo), "WU");
    expect(buttons(combo, d, opts).primary).toBe("Add {W}{U}");
    expect(toAct(combo, d)).toEqual({ kind: "choose_mana_color", mana: ["W", "U"], combination: true });
    // Several mana of any colours: a split of the total.
    const split = pending({ kind: "split", answer: "choose_mana_color", purpose: "colors", options: ["W", "G"].map((c) => option(c)), total: 3, perOptionMin: 0, unit: "mana", min: 0, max: 3 });
    const s = { kind: "split" as const, amounts: { W: 1, G: 2 } };
    expect(toAct(split, s)).toEqual({ kind: "choose_mana_color", mana: ["W", "G", "G"], combination: true });
    expect(buttons(split, s, opts).primary).toBe("Add {W}{G}{G}");
    expect(buttons(split, { kind: "split", amounts: { W: 1, G: 0 } }, opts).primary).toBe("2 left to choose");
  });

  it("pays Phyrexian mana with mana or 2 life per symbol", () => {
    const p = pending({
      answer: "pay_phyrexian",
      purpose: "phyrexian",
      min: 0,
      max: 2,
      upTo: true,
      rest: "{1}",
      options: [option("0", { name: "{B/P}", cost: "{B}", text: "Mana or 2 life" }), option("1", { name: "{B/P}", cost: "{B}", text: "Only 2 life", eligible: false })],
      defaultAnswer: ["1"],
    });
    let d = initialDraft(p);
    expect(phyrexianLife(p, d)).toBe(2);
    expect(phyrexianMana(p, d)).toBe("{1}{B}");
    expect(buttons(p, d, opts).primary).toBe("Pay 2 life, then {1}{B}");
    // The fixed one stays: only the free one switches.
    d = togglePick(p, d, "1");
    expect(phyrexianLife(p, d)).toBe(2);
    d = togglePick(p, d, "0");
    expect(buttons(p, d, opts).primary).toBe("Pay 4 life, then {1}");
    expect(ready(p, d)).toBe(true);
    expect(toAct(p, d)).toEqual({ kind: "pay_phyrexian", life: [true, true] });
    // Nothing but life to pay.
    const free = pending({ answer: "pay_phyrexian", purpose: "phyrexian", min: 0, max: 1, rest: "{0}", options: [option("0", { name: "{R/P}", cost: "{R}" })] });
    expect(buttons(free, { kind: "pick", ids: ["0"] }, opts).primary).toBe("Pay 2 life");
    expect(buttons(free, { kind: "pick", ids: [] }, opts).primary).toBe("Pay {R}");
  });

  it("kicks or doesn't, with Cancel beside it", () => {
    const p = pending({
      answer: "decide_optional_cost",
      purpose: "kicker",
      prompt: "Pay the kicker, {4}?",
      options: [option("pay", { name: "Kicked", cost: "{4}{R}" }), option("skip", { name: "Not kicked", cost: "{R}" })],
      defaultAnswer: ["pay"],
    });
    let d = initialDraft(p);
    expect(buttons(p, d, opts)).toEqual({ primary: "Kick it", secondary: "Cancel", secondaryDoes: "cancel" });
    expect(toAct(p, d)).toEqual({ kind: "decide_optional_cost", pay: true });
    d = togglePick(p, d, "skip");
    expect(buttons(p, d, opts).primary).toBe("Don't kick");
    expect(toAct(p, d)).toEqual({ kind: "decide_optional_cost", pay: false });
    // A multikicker asking again names its own rows.
    const again = { ...p, options: [option("pay", { name: "Kick again" }), option("skip", { name: "Stop kicking" })] };
    expect(buttons(again, { kind: "pick", ids: ["skip"] }, opts).primary).toBe("Stop kicking");
    const branch = pending({ answer: "choose_cost_branch", purpose: "cost_branch", options: [option("0", { name: "Pay 2 life" }), option("1", { name: "Sacrifice a permanent", eligible: false })] });
    const b = togglePick(branch, initialDraft(branch), "0");
    expect(buttons(branch, b, opts).primary).toBe("Pay: Pay 2 life");
    expect(toAct(branch, b)).toEqual({ kind: "choose_cost_branch", index: 0 });
  });

  it("names the card a cost or ward discards", () => {
    const hand = [option("31", { name: "Glacial Fortress", zone: "hand" }), option("32", { name: "Boros Charm", zone: "hand" })];
    const cost = pending({ purpose: "cost", prompt: "Discard a card to cast Thrill of Possibility", options: hand });
    expect(buttons(cost, { kind: "pick", ids: [] }, opts)).toEqual({ primary: "Choose what to discard", secondary: "Cancel", secondaryDoes: "cancel" });
    expect(buttons(cost, { kind: "pick", ids: ["31"] }, opts).primary).toBe("Discard Glacial Fortress");
    const ward = pending({ purpose: "ward", prompt: "Ward: discard a card", options: hand });
    expect(buttons(ward, { kind: "pick", ids: ["32"] }, { canCancel: false, spell: true }).primary).toBe("Discard Boros Charm");
    expect(onBoard(ward)).toBe(true);
  });
});
