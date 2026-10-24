// Everyone takes part, choosing a player and the library (play/src/together.rs, library.rs;
// GTogether, GRareRules, GLibrary): the drafts, buttons and answers answer.ts builds for them, and
// the public part together.ts puts in words.

import { describe, expect, it } from "vitest";
import { buttons, canMoveOrder, counter, initialDraft, isPlaces, isSeatPick, isTogether, isTopOrBottom, isWordPick, onBoard, orderTag, piles, ready, stageOf, toAct, togglePick } from "./answer";
import { pilesLine, tally, voterState } from "./together";
import type { DecisionOption, Pending, TogetherView } from "./types";

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

describe("votes", () => {
  const vote = pending({
    answer: "submit_vote_candidate",
    purpose: "vote",
    prompt: "Vote for a permanent",
    total: 1,
    options: [option("0", { name: "Éowyn", zone: "battlefield", controller: 0 }), option("1", { name: "Adeline", zone: "battlefield", controller: 0 })],
  });
  it("is a dialog, waits for a vote, and sends the option's place", () => {
    expect(isTogether(vote)).toBe(true);
    expect(stageOf(vote, true, false)).toBe("dialog");
    expect(stageOf(vote, false, false)).toBe("sheet");
    let d = initialDraft(vote);
    expect(counter(vote, d)).toBe("1 vote to cast");
    expect(buttons(vote, d, noCancel).primary).toBe("Choose what to vote for");
    expect(ready(vote, d)).toBe(false);
    d = togglePick(vote, d, "1");
    expect(buttons(vote, d, noCancel)).toEqual({ primary: "Vote for Adeline", secondary: null, secondaryDoes: null });
    expect(counter(vote, d)).toBe("Voted");
    expect(toAct(vote, d)).toEqual({ kind: "submit_vote_candidate", candidate: 1 });
  });
  it("sends a word for a vote between words", () => {
    const words = pending({ ...vote, answer: "choose_option", prompt: "Vote for carnage or homage", options: [option("carnage", { name: "carnage" }), option("homage", { name: "homage" })] });
    const d = togglePick(words, initialDraft(words), "homage");
    expect(toAct(words, d)).toEqual({ kind: "choose_option", choice: "homage" });
  });
  it("says who voted for what, and what leads", () => {
    const t: Extract<TogetherView, { kind: "vote" }> = {
      kind: "vote",
      source: { name: "Council's Judgment" },
      controller: 2,
      options: [{ id: 10, name: "Éowyn" }, { id: 11, name: "Adeline" }, { id: 12, name: "Sol Ring" }],
      ballots: [
        [2, 1],
        [3, 0],
        [0, 1],
      ],
      voters: [
        { seat: 2, state: "voted" },
        { seat: 3, state: "voted" },
        { seat: 0, state: "voted" },
        { seat: 1, state: "voting" },
      ],
    };
    expect(voterState(t, 2)).toBe("Voted: Adeline");
    expect(voterState(t, 1)).toBe("Voting now");
    expect(tally(t)).toEqual([
      { name: "Adeline", votes: 2 },
      { name: "Éowyn", votes: 1 },
    ]);
    // A secret vote names nobody's choice.
    expect(voterState({ ...t, secret: true, ballots: [] }, 2)).toBe("Voted");
  });
});

describe("piles", () => {
  const split = pending({
    answer: "submit_pile_partition",
    purpose: "piles_split",
    prompt: "Separate these cards into two piles",
    min: 0,
    max: 5,
    upTo: true,
    options: ["1", "2", "3", "4", "5"].map((id) => option(id)),
    defaultAnswer: [],
  });
  it("starts with every card in pile B, moves cards with a click, and sends pile A", () => {
    let d = initialDraft(split);
    expect(piles(split, d).a).toHaveLength(0);
    expect(buttons(split, d, noCancel)).toEqual({ primary: "Done: 0 and 5", secondary: null, secondaryDoes: null });
    d = togglePick(split, d, "2");
    d = togglePick(split, d, "4");
    expect(piles(split, d).a.map((o) => o.id)).toEqual(["2", "4"]);
    expect(counter(split, d)).toBe("2 and 3");
    expect(buttons(split, d, noCancel)).toEqual({ primary: "Done: 2 and 3", secondary: "Reset", secondaryDoes: "reset" });
    expect(ready(split, d)).toBe(true);
    expect(toAct(split, d)).toEqual({ kind: "submit_pile_partition", pile_a: [2, 4] });
  });
  it("chooses one of the piles someone else made", () => {
    const choose = pending({
      answer: "choose_pile",
      purpose: "piles_choose",
      prompt: "Choose a pile",
      options: [option("a", { name: "Pile A", text: "1 card" }), option("b", { name: "Pile B", text: "4 cards" })],
      shown: [option("7", { group: "a" }), ...["8", "9", "10", "11"].map((id) => option(id, { group: "b" }))],
    });
    let d = initialDraft(choose);
    expect(buttons(choose, d, noCancel).primary).toBe("Choose a pile");
    d = togglePick(choose, d, "b");
    expect(piles(choose, d).b).toHaveLength(4);
    expect(buttons(choose, d, noCancel).primary).toBe("Take pile B (4)");
    expect(toAct(choose, d)).toEqual({ kind: "choose_pile", pile: "b" });
  });
  it("says who splits and who chooses", () => {
    const Who = (n: number) => ["Ana", "Ben", "Cy"][n]!;
    const t = { kind: "piles" as const, source: { name: "Fact or Fiction" }, chooser: 0, splitter: 1, step: "split" as const, cards: [] };
    expect(pilesLine(t, Who, 0)).toBe("Ben is separating the cards into two piles. Then you choose one.");
    expect(pilesLine(t, Who, 1)).toBe("You are separating the cards into two piles. Then Ana chooses one.");
    expect(pilesLine({ ...t, step: "opponent" }, Who, 0)).toBe("You choose the opponent who separates the cards into two piles.");
    expect(pilesLine({ ...t, step: "choose" }, Who, 2)).toBe("Ana is choosing a pile.");
  });
});

describe("a villainous choice, coins and dice", () => {
  it("picks a branch in the engine's words", () => {
    const branch = pending({ answer: "choose_branch", purpose: "branch", prompt: "Choose one", options: [option("0", { name: "They exile cards…" }), option("1", { name: "That player exiles…" })] });
    expect(isWordPick(branch)).toBe(true);
    let d = initialDraft(branch);
    expect(buttons(branch, d, noCancel).primary).toBe("Choose one");
    d = togglePick(branch, d, "1");
    expect(buttons(branch, d, noCancel).primary).toBe("Choose this one");
    expect(toAct(branch, d)).toEqual({ kind: "choose_branch", index: 1 });
  });
  it("keeps a coin", () => {
    const coin = pending({ answer: "select_coin_flips", purpose: "coin", prompt: "Keep one coin", options: [option("0", { name: "Heads" }), option("1", { name: "Tails" })] });
    let d = initialDraft(coin);
    expect(buttons(coin, d, noCancel).primary).toBe("Choose a coin");
    d = togglePick(coin, d, "0");
    expect(buttons(coin, d, noCancel).primary).toBe("Keep heads");
    expect(toAct(coin, d)).toEqual({ kind: "select_coin_flips", keep: [0] });
  });
  it("ignores only a roll the engine allows", () => {
    const die = pending({ answer: "select_die_rolls", purpose: "die", prompt: "Ignore one roll", options: [option("0", { name: "4" }), option("1", { name: "17", eligible: false }), option("2", { name: "4" })] });
    let d = togglePick(die, initialDraft(die), "1");
    expect(d.kind === "pick" && d.ids).toEqual([]);
    d = togglePick(die, d, "2");
    expect(buttons(die, d, noCancel).primary).toBe("Ignore the 4");
    expect(toAct(die, d)).toEqual({ kind: "select_die_rolls", ignore: [2] });
  });
});

describe("choosing a player", () => {
  const gift = pending({
    answer: "choose_player",
    purpose: "gift",
    prompt: "Choose who gets the gift",
    options: [option("p1", { name: "Ben", zone: "player", controller: 1 }), option("p2", { name: "Cy", zone: "player", controller: 2 })],
  });
  it("is a dialog of seats, never a pick on the board", () => {
    expect(isSeatPick(gift)).toBe(true);
    expect(onBoard(gift)).toBe(false);
    expect(stageOf(gift, true, false)).toBe("dialog");
  });
  it("says what the player is chosen for, and sends the seat", () => {
    let d = initialDraft(gift);
    expect(buttons(gift, d, { canCancel: true, spell: true })).toEqual({ primary: "Choose a player", secondary: "Cancel", secondaryDoes: "cancel" });
    d = togglePick(gift, d, "p2");
    expect(buttons(gift, d, noCancel).primary).toBe("Give the gift to Cy");
    expect(toAct(gift, d)).toEqual({ kind: "choose_player", seat: 2 });
    for (const [purpose, label] of [
      ["clash_opponent", "Clash with Cy"],
      ["pile_opponent", "Cy separates them"],
      ["entry_controller", "It enters under Cy"],
      ["zone_chooser", "Cy chooses"],
      ["announcer", "Cy chooses the target"],
    ] as const) {
      expect(buttons({ ...gift, purpose }, d, noCancel).primary).toBe(label);
    }
    // The board's own name for a seat: a computer's short commander name.
    const ai = pending({ ...gift, options: [option("p1", { name: "Isamaru, Hound of Konda", zone: "player", controller: 1 })] });
    expect(buttons(ai, togglePick(ai, initialDraft(ai), "p1"), { ...noCancel, who: () => "Isamaru" }).primary).toBe("Give the gift to Isamaru");
  });
});

describe("the library", () => {
  it("puts a card on the top or the bottom", () => {
    const tob = pending({ answer: "choose_top_or_bottom", purpose: "top_or_bottom", prompt: "Put Grizzly Bears on the top or bottom of Ben's library?", options: [option("top", { name: "Top" }), option("bottom", { name: "Bottom" })], shown: [option("40", { name: "Grizzly Bears", controller: 1 })] });
    expect(isTopOrBottom(tob)).toBe(true);
    let d = initialDraft(tob);
    expect(buttons(tob, d, noCancel).primary).toBe("Choose top or bottom");
    d = togglePick(tob, d, "bottom");
    expect(buttons(tob, d, noCancel).primary).toBe("Put it on the bottom");
    expect(toAct(tob, d)).toEqual({ kind: "choose_top_or_bottom", top: false });
  });
  it("splits Cultivate's lands, with Swap them", () => {
    const part = pending({ purpose: "partition", prompt: "Which card goes onto the battlefield tapped?", options: [option("5", { name: "Forest" }), option("6", { name: "Mountain" })], places: ["Onto the battlefield tapped", "Into your hand"], defaultAnswer: ["5"] });
    expect(isPlaces(part)).toBe(true);
    const d = initialDraft(part);
    expect(counter(part, d)).toBe("Both placed");
    expect(buttons(part, d, noCancel)).toEqual({ primary: "Done", secondary: "Swap them", secondaryDoes: "swap" });
    expect(toAct(part, d)).toEqual({ kind: "select_cards", cards: [5] });
    // Picking the other one swaps them.
    expect(toAct(part, togglePick(part, d, "6"))).toEqual({ kind: "select_cards", cards: [6] });
  });
  it("keeps a dig's rest in its piles when the split was someone else's", () => {
    const split = pending({ kind: "order", purpose: "dig_split", prompt: "Put a card on top and a card on the bottom", options: [option("1"), option("2"), option("3")], min: 3, max: 3, topCount: 1 });
    expect(orderTag(split, 0, 3)).toBe("On top: drawn next");
    expect(orderTag(split, 1, 3)).toBe("Bottom: highest");
    expect(orderTag(split, 2, 3)).toBe("Very bottom");
    expect(canMoveOrder(split, 0, 1)).toBe(true);
    expect(canMoveOrder({ ...split, fixedSplit: true }, 0, 1)).toBe(false);
    expect(canMoveOrder({ ...split, fixedSplit: true }, 1, 2)).toBe(true);
    expect(toAct(split, initialDraft(split))).toEqual({ kind: "select_cards", cards: [1, 2, 3] });
  });
  it("learns by discarding a card from the hand, or doesn't", () => {
    const learn = pending({ answer: "learn", purpose: "learn", prompt: "Learn: discard a card to draw a card?", min: 0, max: 1, upTo: true, options: [option("9", { name: "Grizzly Bears", zone: "hand" })] });
    expect(onBoard(learn)).toBe(true);
    let d = initialDraft(learn);
    expect(buttons(learn, d, noCancel).primary).toBe("Don't discard");
    expect(toAct(learn, d)).toEqual({ kind: "learn", discard: null });
    d = togglePick(learn, d, "9");
    expect(buttons(learn, d, noCancel).primary).toBe("Discard Grizzly Bears, then draw");
    expect(toAct(learn, d)).toEqual({ kind: "learn", discard: 9 });
  });
  it("shows a reveal-until's find whole, and keeps the engine's words", () => {
    const kept = pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "kept", prompt: "Put Honden of Seeing Winds onto the battlefield?", yesLabel: "Onto the battlefield", noLabel: "Into your library", options: [option("1", { eligible: false }), option("2")] });
    expect(stageOf(kept, true, false)).toBe("dialog");
    expect(buttons(kept, initialDraft(kept), noCancel)).toMatchObject({ primary: "Onto the battlefield", secondary: "Into your library" });
    expect(toAct(kept, initialDraft(kept), false)).toEqual({ kind: "decide_optional_effect", accept: false });
  });
});
