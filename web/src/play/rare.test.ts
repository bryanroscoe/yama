// The rarer cards and rules (play/src/rare.rs, remember.rs; GRareCards, GRareRules): the drafts,
// buttons and answers answer.ts builds for them, and the board's own pieces in rare.ts.

import { describe, expect, it } from "vitest";
import { buttons, changed, counter, initialDraft, isPermanentPick, noneAct, onBoard, pickTag, ready, rememberLabels, stageOf, toAct, togglePick, type Draft } from "./answer";
import { lineText } from "./feed";
import { collapseNinjutsu, faceDownWords, ninjutsuPick, reachable, roomSpot, shortcutCount, specialAct, stepStop, timeAfter, timeChoices, timeCounters } from "./rare";
import { answerBy } from "./turns";
import type { CardView, DecisionOption, DungeonMap, OptionView, Pending } from "./types";

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
const card = (id: number, extra: Partial<CardView> = {}): CardView => ({
  id,
  name: `Card ${id}`,
  controller: 0,
  owner: 0,
  tapped: false,
  power: 2,
  toughness: 2,
  loyalty: null,
  damage: 0,
  counters: {},
  types: ["Creature"],
  attached_to: null,
  ...extra,
});

describe("morph and face-down cards", () => {
  const morph = pending({
    answer: "choose_alternative_cast",
    purpose: "face_down",
    prompt: "Pay the mana cost, or cast it face down?",
    source: { id: 31, name: "Exalted Angel", controller: 0 },
    options: [option("normal", { name: "Mana cost", cost: "{4}{W}{W}" }), option("alternative", { name: "Face down", cost: "{3}" })],
  });
  it("casts face down from the main button and face up from the second", () => {
    const d = initialDraft(morph);
    expect(ready(morph, d)).toBe(true);
    expect(buttons(morph, d, noCancel)).toMatchObject({ primary: "Cast face down for {3}", secondary: "Cast face up for {4}{W}{W}", secondaryDoes: "no" });
    expect(toAct(morph, d, true)).toEqual({ kind: "choose_alternative_cast", alternative: true });
    expect(toAct(morph, d, false)).toEqual({ kind: "choose_alternative_cast", alternative: false });
    expect(stageOf(morph, true, false)).toBe("dialog");
  });
  it("only casts face up when {3} can't be paid", () => {
    const up = { ...morph, options: [morph.options[0]!, { ...morph.options[1]!, eligible: false }] };
    expect(buttons(up, initialDraft(up), noCancel)).toMatchObject({ primary: "Cast face up for {4}{W}{W}", secondary: null });
    expect(toAct(up, initialDraft(up), true)).toEqual({ kind: "choose_alternative_cast", alternative: false });
  });
  it("names a face-down tile only for its controller", () => {
    expect(faceDownWords(card(31, { name: "Face-down card", face_down: true, under: "Exalted Angel" }))).toEqual({ head: "Face down", name: "Exalted Angel" });
    expect(faceDownWords(card(31, { name: "Face-down card", face_down: true }))).toEqual({ head: "Face down", name: "No name" });
  });
  it("turns it face up, foretells, takes the companion and uses Serum Powder through act", () => {
    const o = (kind: OptionView["kind"], object: number | null): OptionView => ({ index: 1, label: "x", kind, object });
    expect(specialAct(o("face_up", 31))).toEqual({ kind: "turn_face_up", object: 31 });
    expect(specialAct(o("foretell", 8))).toEqual({ kind: "foretell", object: 8 });
    expect(specialAct(o("companion", null))).toEqual({ kind: "companion_to_hand" });
    expect(specialAct(o("serum_powder", 4))).toEqual({ kind: "use_serum_powder", object: 4 });
    expect(specialAct(o("ninjutsu", 4)), "ninjutsu asks for an attacker first").toBeNull();
    expect(specialAct(o("spell", 4))).toBeNull();
  });
});

describe("ninjutsu", () => {
  const options: OptionView[] = [
    { index: 1, label: "Ninjutsu {1}{U}: return Savannah Lions", kind: "ninjutsu", object: 9, target: { kind: "object", id: 18 }, cost: "{1}{U}" },
    { index: 2, label: "Ninjutsu {1}{U}: return Soldier", kind: "ninjutsu", object: 9, target: { kind: "object", id: 20 }, cost: "{1}{U}" },
    { index: 3, label: "Cast Opt", kind: "spell", object: 11 },
  ];
  it("is one button per ninja", () => {
    expect(collapseNinjutsu(options).map((o) => o.label)).toEqual(["Ninjutsu {1}{U}", "Cast Opt"]);
  });
  it("picks an unblocked attacker on the board, the blocked one shown but not amber", () => {
    const field = [card(18, { name: "Savannah Lions", attacking: true }), card(20, { name: "Soldier", attacking: true }), card(13, { name: "Grizzly Bears", attacking: true, blocked: true }), card(40, { name: "Their Bears", controller: 1 })];
    const p = ninjutsuPick(9, options, field, [card(9, { name: "Ninja of the Deep Hours" })], 0)!;
    expect(p.source).toEqual({ id: 9, name: "Ninja of the Deep Hours", controller: 0 });
    expect(p.prompt).toBe("Ninjutsu {1}{U}: choose an unblocked attacker to return to your hand");
    expect(p.options.map((o) => [o.id, o.eligible])).toEqual([["18", true], ["20", true], ["13", false]]);
    expect(onBoard(p)).toBe(true);
    expect(stageOf(p, true, false)).toBe("board");
    expect(isPermanentPick(p)).toBe(true);
    let d = initialDraft(p);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Choose an attacker", secondary: "Cancel", secondaryDoes: "back" });
    expect(togglePick(p, d, "13")).toEqual(d);
    expect(pickTag(p, d, "13")).toEqual({ text: "Blocked", tone: "dim" });
    d = togglePick(p, d, "18");
    expect(pickTag(p, d, "18")).toEqual({ text: "Returns to hand", tone: "plain" });
    expect(buttons(p, d, noCancel).primary).toBe("Pay {1}{U}, return Savannah Lions");
    expect(toAct(p, d)).toEqual({ kind: "ninjutsu", card: 9, attacker: 18 });
    expect(ninjutsuPick(11, options, field, [], 0)).toBeNull();
    // A face-down attacker reads as what it is, for its controller.
    const down = ninjutsuPick(9, options, [card(18, { name: "Face-down card", face_down: true, under: "Exalted Angel", attacking: true })], [], 0)!;
    expect(down.options[0]!.name).toBe("Face-down Exalted Angel");
  });
});

describe("companion, meld and cipher", () => {
  it("reveals a companion or none", () => {
    const p = pending({ answer: "declare_companion", purpose: "companion", min: 0, upTo: true, options: [option("Jegantha, the Wellspring", { name: "Jegantha, the Wellspring" })], defaultAnswer: ["Jegantha, the Wellspring"] });
    const d = initialDraft(p);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Reveal Jegantha, the Wellspring", secondary: "No companion", secondaryDoes: "none" });
    expect(toAct(p, d)).toEqual({ kind: "declare_companion", name: "Jegantha, the Wellspring" });
    expect(noneAct(p)).toEqual({ kind: "declare_companion", name: null });
    expect(counter(p, d)).toBe("");
  });
  it("melds the pair picked into what it becomes", () => {
    const p = pending({ answer: "choose_meld_pair", purpose: "meld", options: [option("31:25", { name: "Gisela and Bruna", text: "Brisela, Voice of Nightmares" })], defaultAnswer: ["31:25"] });
    const d = initialDraft(p);
    expect(buttons(p, d, noCancel).primary).toBe("Meld into Brisela, Voice of Nightmares");
    expect(toAct(p, d)).toEqual({ kind: "choose_meld_pair", source: 31, partner: 25 });
  });
  it("encodes a cipher spell on a creature on the board, or doesn't", () => {
    const p = pending({ answer: "cipher_encode", purpose: "cipher", min: 0, upTo: true, options: [option("25", { name: "Savannah Lions", zone: "battlefield" })] });
    expect(stageOf(p, true, false)).toBe("board");
    let d = initialDraft(p);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Choose a creature", secondary: "Don't encode", secondaryDoes: "none" });
    expect(noneAct(p)).toEqual({ kind: "cipher_encode", creature: null });
    d = togglePick(p, d, "25");
    expect(buttons(p, d, noCancel).primary).toBe("Encode on Savannah Lions");
    expect(toAct(p, d)).toEqual({ kind: "cipher_encode", creature: 25 });
  });
  it("aims a permanent entering attacking at a player", () => {
    const p = pending({ answer: "choose_entry_attack_target", purpose: "entry_attack", options: [option("p1", { name: "Ben", zone: "player", controller: 1 })] });
    expect(onBoard(p)).toBe(true);
    const d = togglePick(p, initialDraft(p), "p1");
    expect(buttons(p, d, { ...noCancel, who: () => "Ben" }).primary).toBe("Attack Ben");
    expect(toAct(p, d)).toEqual({ kind: "choose_entry_attack_target", target: { kind: "player", seat: 1 } });
  });
});

describe("dungeons", () => {
  const map: DungeonMap = {
    id: "LostMineOfPhandelver",
    name: "Lost Mine of Phandelver",
    image: "https://cards.scryfall.io/normal/front/5/9/x.jpg",
    rooms: [
      { index: 0, name: "Cave Entrance", text: "Scry 1.", next: [1, 2], x: 500, y: 215 },
      { index: 1, name: "Goblin Lair", text: "Create a 1/1 red Goblin creature token.", next: [3], x: 310, y: 390 },
      { index: 2, name: "Mine Tunnels", text: "Create a Treasure token.", next: [3], x: 690, y: 390 },
      { index: 3, name: "Temple of Dumathoin", text: "Draw a card.", next: [], x: 500, y: 900 },
    ],
    current: 0,
  };
  it("lays the rooms out as the card draws them, and knows where the marker can go", () => {
    expect(roomSpot(map, 0, 400, 300)).toEqual({ x: 200, y: 0 });
    expect(roomSpot(map, 3, 400, 300)).toEqual({ x: 200, y: 300 });
    expect(roomSpot(map, 1, 400, 300).x).toBe(0);
    expect([...reachable(map)]).toEqual([1, 2]);
    expect([...reachable({ ...map, current: undefined })]).toEqual([]);
  });
  it("ventures into a dungeon, then goes to a room", () => {
    const pick = pending({ answer: "choose_dungeon", purpose: "dungeon", options: [option("LostMineOfPhandelver", { name: "Lost Mine of Phandelver" })], defaultAnswer: ["LostMineOfPhandelver"], dungeons: [map] });
    const d = initialDraft(pick);
    expect(buttons(pick, d, noCancel).primary).toBe("Venture into Lost Mine of Phandelver");
    expect(toAct(pick, d)).toEqual({ kind: "choose_dungeon", dungeon: "LostMineOfPhandelver" });
    const room = pending({ answer: "choose_dungeon_room", purpose: "dungeon_room", options: [option("1", { name: "Goblin Lair" }), option("2", { name: "Mine Tunnels" })], dungeons: [map] });
    let r = initialDraft(room);
    expect(buttons(room, r, noCancel).primary).toBe("Choose a room");
    expect(ready(room, r)).toBe(false);
    r = togglePick(room, r, "2");
    expect(buttons(room, r, noCancel).primary).toBe("Go to Mine Tunnels");
    expect(toAct(room, r)).toEqual({ kind: "choose_dungeon_room", room: 2 });
    expect(stageOf(room, true, false)).toBe("dialog");
  });
});

describe("time travel", () => {
  const p = pending({
    answer: "time_travel",
    purpose: "time_travel",
    step: "remove",
    min: 0,
    max: 2,
    upTo: true,
    options: [option("85", { name: "Rotating Fireplace", counters: [["time", 2]] }), option("12", { name: "Ancestral Vision", zone: "exile", counters: [["time", 3]] })],
  });
  it("starts with everything left, and sends removals and additions together", () => {
    const d = initialDraft(p);
    expect(d).toEqual({ kind: "time", moves: { "85": "leave", "12": "leave" } });
    expect(ready(p, d)).toBe(true);
    expect(counter(p, d)).toBe("0 of 2 changed");
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Done", secondary: null });
    const moved: Draft = { kind: "time", moves: { "85": "remove", "12": "add" } };
    expect(changed(p, moved)).toBe(true);
    expect(counter(p, moved)).toBe("2 of 2 changed");
    expect(buttons(p, moved, noCancel)).toMatchObject({ primary: "Done", secondary: "Leave all", secondaryDoes: "reset" });
    expect(toAct(p, moved)).toEqual({ kind: "time_travel", remove: [{ kind: "object", id: 85 }], add: [{ kind: "object", id: 12 }] });
    expect(toAct(p, d)).toEqual({ kind: "time_travel", remove: [], add: [] });
    expect(stageOf(p, true, false)).toBe("dialog");
  });
  it("shows the counters after, and only adding in the engine's add step", () => {
    expect(timeCounters([["time", 2]])).toBe(2);
    expect(timeCounters(undefined)).toBe(0);
    expect([timeAfter(2, "remove"), timeAfter(2, "leave"), timeAfter(2, "add"), timeAfter(0, "remove")]).toEqual([1, 2, 3, 0]);
    expect(timeChoices("remove")).toEqual(["remove", "leave", "add"]);
    expect(timeChoices("add")).toEqual(["leave", "add"]);
  });
});

describe("loop shortcuts", () => {
  it("proposes one of the engine's counts, or plays it out", () => {
    const p = pending({ answer: "propose_shortcut", purpose: "shortcut", options: [option("20", { name: "20 times" })], defaultAnswer: ["20"] });
    const d = initialDraft(p);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Propose: repeat 20 times", secondary: "Keep playing it out", secondaryDoes: "decline" });
    expect(toAct(p, d)).toEqual({ kind: "propose_shortcut", count: 20 });
    const lethal = { ...p, options: [option("lethal", { name: "Until a player loses" })], defaultAnswer: ["lethal"] };
    expect(buttons(lethal, initialDraft(lethal), noCancel).primary).toBe("Propose: repeat until a player loses");
    expect(toAct(lethal, initialDraft(lethal))).toEqual({ kind: "propose_shortcut", count: null });
    const endless = { ...p, options: [option("without_end", { name: "Without end (draw)" })], defaultAnswer: ["without_end"] };
    expect(buttons(endless, initialDraft(endless), noCancel).primary).toBe("Propose: repeat without end (draw)");
    expect(toAct(endless, initialDraft(endless))).toEqual({ kind: "propose_shortcut", count: null });
    expect(shortcutCount(undefined, "WithoutEnd")).toBe("without end (draw)");
    expect(shortcutCount(undefined, { Fixed: 7 })).toBe("7 times");
  });
  it("accepts a proposal whole, or shortens it to a place before its end", () => {
    const p = pending({ kind: "number", answer: "respond_to_shortcut", purpose: "shortcut_response", min: 0, max: 19, total: 20, shortcut: { proposer: 0, count: 20, responders: [[1, "deciding"]] } });
    let d = initialDraft(p);
    expect(d).toEqual({ kind: "number", value: null });
    expect(ready(p, d)).toBe(true);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Accept 20", secondary: null });
    expect(toAct(p, d)).toEqual({ kind: "respond_to_shortcut", stop_at: null });
    d = { kind: "number", value: stepStop(null, -1, 0, 19) };
    expect(d.value).toBe(19);
    expect(buttons(p, d, noCancel)).toMatchObject({ primary: "Shorten to 19", secondary: "Accept 20 instead", secondaryDoes: "accept" });
    expect(toAct(p, d)).toEqual({ kind: "respond_to_shortcut", stop_at: 19 });
    expect(stepStop(19, 1, 0, 19), "past the last place is accepting").toBeNull();
    expect(stepStop(0, -1, 0, 19)).toBe(0);
    expect(shortcutCount(20)).toBe("20 times");
    expect(shortcutCount(undefined)).toBe("until a player loses");
  });
  it("the pre-cast shortcut is a yes or no, and its response a choice of the engine's places", () => {
    const offer = pending({ kind: "yesno", answer: "propose_shortcut", purpose: "precast_shortcut", yesLabel: "Propose the shortcut", noLabel: "Keep playing it out" });
    const d = initialDraft(offer);
    expect(buttons(offer, d, noCancel)).toMatchObject({ primary: "Propose the shortcut", secondary: "Keep playing it out", secondaryDoes: "no" });
    expect(toAct(offer, d, true)).toEqual({ kind: "propose_shortcut", count: null });
    expect(toAct(offer, d, false)).toEqual({ kind: "decline_shortcut" });
    const respond = pending({ answer: "respond_to_shortcut", purpose: "precast_response", options: [option("accept", { name: "Accept" }), option("41", { name: "Stop it at your chance 1 to act" })], defaultAnswer: ["accept"] });
    expect(buttons(respond, initialDraft(respond), noCancel).primary).toBe("Accept the shortcut");
    expect(toAct(respond, initialDraft(respond))).toEqual({ kind: "respond_to_shortcut", stop_at: null });
    const stop = togglePick(respond, initialDraft(respond), "41");
    expect(buttons(respond, stop, noCancel).primary).toBe("Stop it there");
    expect(toAct(respond, stop)).toEqual({ kind: "respond_to_shortcut", stop_at: 41 });
  });
});

describe("answers Yama remembers", () => {
  const rhystic = pending({ kind: "yesno", answer: "pay_unless_cost", purpose: "pay", prompt: "Pay {1}? If you don't: draw a card.", yesLabel: "Pay {1}", noLabel: "Don't pay", remember: "yama", source: { id: 7, name: "Rhystic Study", controller: 1 } });
  it("pays or doesn't, and from now on with Always pay or Never pay", () => {
    const d = initialDraft(rhystic);
    expect(rememberLabels(rhystic)).toEqual({ ask: "Ask each time", always: "Always pay", never: "Never pay" });
    expect(buttons(rhystic, d, noCancel)).toMatchObject({ primary: "Pay {1}", secondary: "Don't pay" });
    expect(toAct(rhystic, d, true)).toEqual({ kind: "pay_unless_cost", pay: true });
    const always: Draft = { kind: "yesno", remember: "always" };
    expect(buttons(rhystic, always, noCancel)).toMatchObject({ primary: "Always pay", secondary: "Ask each time", secondaryDoes: "ask" });
    expect(toAct(rhystic, always)).toEqual({ kind: "remember_answer", accept: true });
    expect(toAct(rhystic, { kind: "yesno", remember: "never" })).toEqual({ kind: "remember_answer", accept: false });
  });
  it("sends a commander to the command zone, always if asked", () => {
    const zone = pending({ kind: "yesno", answer: "decide_optional_effect", purpose: "commander_zone", prompt: "Put Éowyn into the command zone?", yesLabel: "Command zone", noLabel: "Graveyard", remember: "yama" });
    expect(rememberLabels(zone)).toEqual({ ask: "Ask each time", always: "Always command zone", never: "Never command zone" });
    expect(buttons(zone, initialDraft(zone), noCancel)).toMatchObject({ primary: "Command zone", secondary: "Graveyard" });
    expect(toAct(zone, { kind: "yesno", remember: "always" })).toEqual({ kind: "remember_answer", accept: true });
  });
  it("says what Yama did in the log, and lists them as Yama's", () => {
    const names = { you: 0, Who: (n: number) => (n === 0 ? "You" : "Ben") };
    const h = { seq: 1, turn: 4, active: 0, kind: "automatic" as const, seat: 0, name: "Rhystic Study", accept: true, answer: "y1", did: "paid {1} for Ben's Rhystic Study" };
    expect(lineText(h, names)).toBe("Yama paid {1} for Ben's Rhystic Study, as you asked.");
    expect(lineText({ ...h, did: undefined }, names)).toBe("Yama answered yes for Rhystic Study, as you asked.");
    expect(answerBy({ id: "y1", kind: "yama", name: "Rhystic Study", owner: 1, answer: "Always pay {1}", scope: "card", forget: { kind: "forget_answer", id: "y1" } })).toBe("Yama answers for you");
  });
});
