import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CostText } from "./CostText";
import { DecisionStage, YesNoStrip, type WidgetContext } from "./Decide";
import { initialDraft } from "./answer";
import { FieldTile } from "./Tiles";
import { actionCues } from "./ActionCues";
import { PLAY_SPEEDS, stackChange } from "./motion";
import { stackRowOf, visibleAnchor } from "./DragLayer";
import type { CardView, Happening, Pending } from "./types";

const vampire: CardView = { id: 1, name: "Cordial Vampire", owner: 1, controller: 1, types: ["Creature"], tapped: false, power: 3, toughness: 3, loyalty: null, damage: 0, counters: { plus1plus1: 2 }, attached_to: null };
const handlers = { onPick() {}, onRead() {}, onHover() {} };
it.each([false, true])("renders named opponents instead of a number input (compact %s)", (compact) => {
  const p: Pending = { kind: "pick", answer: "choose_option", purpose: "control_recipient", choiceType: "opponent", prompt: "Choose an opponent to gain control of Wishclaw Talisman", source: { id: 91, name: "Wishclaw Talisman", controller: 0 }, min: 1, max: 1, upTo: false, options: [1, 3].map((seat) => ({ id: String(seat), name: `Player ${seat}`, controller: seat, zone: "player", eligible: true })) };
  const ctx: WidgetContext = { meta: {}, whose: () => "Your", who: (seat) => seat === 1 ? "Syr Gwyn" : "Olivia", tone: () => undefined, onRead() {}, zone: { label: "", total: null, others: [] }, damageOf: () => 0, inPlay: [], seat: () => ({ art: null, artist: null, life: 37 }) };
  const markup = renderToStaticMarkup(<DecisionStage p={p} draft={initialDraft(p)} onDraft={() => {}} ctx={ctx} compact={compact} disabled={false} />);
  expect(markup).toContain("Choose an opponent to gain control of Wishclaw Talisman");
  expect(markup).toContain('aria-label="Syr Gwyn, 37 life"');
  expect(markup).toContain('aria-label="Olivia, 37 life"');
  expect(markup).not.toContain('type="number"');
});
it.each([false, true])("separates an optional search question from the full card text (compact %s)", (compact) => {
  const oracle = "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.";
  const p: Pending = { kind: "yesno", answer: "decide_optional_effect", purpose: "may", prompt: oracle, oracle, min: 0, max: 1, upTo: false, options: [] };
  const ctx: WidgetContext = { meta: {}, whose: () => "Your", who: () => "you", tone: () => undefined, onRead() {}, zone: { label: "", total: null, others: [] }, damageOf: () => 0, inPlay: [] };
  const markup = renderToStaticMarkup(<YesNoStrip p={p} draft={initialDraft(p)} onDraft={() => {}} ctx={ctx} compact={compact} disabled={false} />);
  expect(markup).toContain('aria-label="Search your library for a basic land?"');
  expect(markup).toContain('class="dw-question">Search your library for a basic land?</b>');
  expect(markup).toContain("Only the basic land search is optional.");
  expect(markup).toContain(`class="dw-oracle">${oracle}</span>`);
});
it("distinguishes counters from the quantity of creatures", () => {
  const one = renderToStaticMarkup(<FieldTile pile={{ key: "v", ids: [1], card: vampire }} h={handlers} look={{}} />);
  expect(one).toContain("2 +1/+1 counters");
  expect(one).not.toContain("2 creatures");
  const two = renderToStaticMarkup(<FieldTile pile={{ key: "vs", ids: [1, 2], card: vampire }} h={handlers} look={{}} />);
  expect(two).toContain("2 creatures");
  expect(two).toContain("2 +1/+1 counters");
});
it("does not conflate identical named stack copies", () => {
  const first = { id: 1, name: "Opt", controller: 1 };
  const second = { id: 2, name: "Opt", controller: 1 };
  expect(stackChange([first], [second])).toEqual({ left: 1, added: [second] });
});
it("ignores a hidden stack row instead of drawing from its zero rectangle", () => {
  const hidden = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const root = { querySelectorAll: () => [hidden] } as unknown as ParentNode;
  expect(stackRowOf(root, 4)).toBeNull();
});
describe("batched action cues", () => {
  const cast: Happening = { kind: "cast", seq: 1, turn: 2, active: 1, seat: 1, card: { name: "Opt", id: 4 } };
  const resolved: Happening = { kind: "moved", seq: 2, turn: 2, active: 1, card: { name: "Opt", id: 4 }, owner: 1, from: "stack", to: "graveyard", how: "moved" };
  it("keeps cast and stack departure even if both happened in one board update", () => { expect(actionCues([cast, resolved], 0)).toEqual([cast, resolved]); });
  it("does not replay acknowledged history", () => { expect(actionCues([cast, resolved], 2)).toEqual([]); });
});

it("offers a slower default pace and an instant option", () => {
  expect(PLAY_SPEEDS.find(s => s.value === "slow")!.scale).toBeGreaterThan(PLAY_SPEEDS.find(s => s.value === "normal")!.scale);
  expect(PLAY_SPEEDS.find(s => s.value === "instant")!.scale).toBe(0);
});

it("rejects a card clipped by its scrolling battlefield even inside the window", () => {
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  const pane = { parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 200, right: 400, bottom: 400 }) };
  const card = { parentElement: pane, getBoundingClientRect: () => ({ width: 100, height: 100, left: 10, top: 120, right: 110, bottom: 220 }) };
  vi.stubGlobal("getComputedStyle", (el: unknown) => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: el === pane ? "auto" : "visible" }));
  try { expect(visibleAnchor(card as unknown as HTMLElement)).toBe(false); }
  finally { vi.unstubAllGlobals(); }
});

it("renders mana in a payment action without exposing raw engine notation", () => {
  const markup = renderToStaticMarkup(<CostText text="Pay {2}{R}" />);
  expect(markup).toContain("Pay ");
  expect(markup).toContain('class="mana-cost"');
  expect(markup).not.toContain('>{2}');
  expect(markup).not.toContain('>{R}');
});

import { targetChangeWarning } from "./response";
it("explains a legal but ineffective redirect without inventing targets", () => {
  const oracle = "You may choose new targets for target spell or ability.";
  const tutor = { id: 91, source: 90, name: "Demonic Tutor", controller: 1, targets: [] };
  expect(targetChangeWarning(oracle, ["91"], [tutor])).toContain("Demonic Tutor has no targets to change");
  expect(targetChangeWarning(oracle, ["90"], [tutor])).toContain("Demonic Tutor has no targets to change");
  expect(targetChangeWarning(oracle, ["91"], [{ ...tutor, targets: undefined }])).toBeNull();
  expect(targetChangeWarning("Counter target spell.", ["91"], [tutor])).toBeNull();
});

it("keeps public counters visible on a face-down permanent", () => {
  const down = { ...vampire, face_down: true, name: "Face-down card" };
  const markup = renderToStaticMarkup(<FieldTile pile={{ key: "down", ids: [1], card: down }} h={handlers} look={{}} />);
  expect(markup).toContain('class="ft-counters">2 +1/+1 counters</span>');
  expect(markup).not.toContain("Cordial Vampire");
});
