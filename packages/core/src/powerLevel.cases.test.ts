// The power estimate runs twice: here, on the deck page, and in server/src/power_level.rs, on
// shared deck pages and in the MCP deck analysis. Both read powerLevel.cases.json, so they give
// the same answers. After changing the rules here, regenerate the expectations with
//   UPDATE_POWER_CASES=1 npx vitest run packages/core/src/powerLevel.cases.test.ts
// review the diff, and make the Rust port agree (cargo test power_level).

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StatCard } from "./deckStats";
import { isCheapDraw, isCheapInteraction, isCheapMana, isTutor, powerEstimate, type PowerEstimate, type PowerSignals } from "./powerLevel";

interface Classified { card: StatCard; mana?: boolean; draw?: boolean; interaction?: boolean; tutor?: boolean }
interface EstimateCase { name: string; cards: StatCard[]; signals: PowerSignals; expected?: PowerEstimate | null }
interface Cases { _about: string; classify: Classified[]; estimates: EstimateCase[] }

const path = new URL("./powerLevel.cases.json", import.meta.url);
const cases = JSON.parse(readFileSync(path, "utf8")) as Cases;

const classify = (card: StatCard) => ({ mana: isCheapMana(card), draw: isCheapDraw(card), interaction: isCheapInteraction(card), tutor: isTutor(card) });

if (process.env.UPDATE_POWER_CASES) {
  for (const c of cases.classify) Object.assign(c, classify(c.card));
  for (const c of cases.estimates) c.expected = powerEstimate(c.cards, c.signals);
  // One line per case keeps the diff readable.
  const lines = (xs: unknown[]) => xs.map((x) => `  ${JSON.stringify(x)}`).join(",\n");
  writeFileSync(path, `{\n "_about": ${JSON.stringify(cases._about)},\n "classify": [\n${lines(cases.classify)}\n ],\n "estimates": [\n${lines(cases.estimates)}\n ]\n}\n`);
}

describe("shared power-estimate cases", () => {
  it("classifies each card as recorded", () => {
    for (const c of cases.classify) {
      expect({ name: c.card.name, ...classify(c.card) }).toEqual({ name: c.card.name, mana: c.mana, draw: c.draw, interaction: c.interaction, tutor: c.tutor });
    }
  });

  it("gives each recorded estimate", () => {
    for (const c of cases.estimates) expect(powerEstimate(c.cards, c.signals), c.name).toEqual(c.expected);
  });
});
