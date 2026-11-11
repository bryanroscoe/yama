import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CostText } from "./CostText";
import { FieldTile } from "./Tiles";
import { actionCues } from "./ActionCues";
import { PLAY_SPEEDS, stackChange } from "./motion";
import { stackRowOf, visibleAnchor } from "./DragLayer";
import type { CardView, Happening } from "./types";

const vampire: CardView = { id: 1, name: "Cordial Vampire", owner: 1, controller: 1, types: ["Creature"], tapped: false, power: 3, toughness: 3, loyalty: null, damage: 0, counters: { plus1plus1: 2 }, attached_to: null };
const handlers = { onPick() {}, onRead() {}, onHover() {} };
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
