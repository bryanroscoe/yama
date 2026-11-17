import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GameLog } from "./GameLog";
import { WhatHappened } from "./WhatHappened";
import type { Names } from "./feed";
import type { CardMeta, Happening } from "./types";

const NAMES = ["You", "Worf"];
const names: Names = { you: 0, Who: (s) => NAMES[s] ?? `Seat ${s + 1}`, turn: (t) => (t === 14 ? 4 : t) };
const meta = (name: string, artist: string): CardMeta => ({ oracle_id: name, image: `https://img/${name}.jpg`, back_image: null, art: `https://art/${name}.jpg`, artist, mana_cost: null, type_line: "", oracle_text: "" });
const cards = { Vindicate: meta("Vindicate", "Karla Ortiz"), "Kinsbaile Cavalier": meta("Kinsbaile Cavalier", "Wayne Reynolds") };
const events: Happening[] = [
  { seq: 1, turn: 14, active: 1, kind: "turn", seat: 1 },
  { seq: 2, turn: 14, active: 1, kind: "cast", seat: 1, card: { name: "Vindicate" } },
  { seq: 3, turn: 14, active: 1, kind: "moved", owner: 0, card: { name: "Kinsbaile Cavalier" }, from: "battlefield", to: "graveyard", how: "destroyed", by: { name: "Vindicate", id: 90 }, by_seat: 1, creature: true },
];

it("steps back through what happened with the cards involved and the turn as the table counts it", () => {
  const markup = renderToStaticMarkup(<WhatHappened events={events} names={names} meta={cards} at={3} onStep={() => {}} onRead={() => {}} onClose={() => {}} rewind={{ label: "Rewind", run: () => {}, disabled: false }} />);
  expect(markup).toContain("Worf&#x27;s turn 4");
  expect(markup).toContain("Worf&#x27;s Vindicate destroyed your Kinsbaile Cavalier.");
  expect(markup).toContain('aria-label="Read Vindicate"');
  expect(markup).toContain('aria-label="Read Kinsbaile Cavalier"');
  expect(markup).toContain("2 of 2");
  expect(markup).toContain(">Rewind<");
});

it("shows the card that did it in the log, readable, with its artist credited", () => {
  const markup = renderToStaticMarkup(
    <GameLog events={events} lines={[]} names={names} meta={cards} tone={() => undefined} art={() => null} turns={undefined} connected onPref={() => {}} onClose={() => {}} named={(t) => t} onRead={() => {}} onReview={() => {}} />,
  );
  expect(markup).toContain("Worf, turn 4");
  expect(markup).toContain('aria-label="Read Vindicate"');
  expect(markup).toContain("art by Karla Ortiz and Wayne Reynolds");
  expect(markup).toContain("Step through what happened");
});
