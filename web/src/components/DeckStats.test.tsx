import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { DeckStatsPanel } from "./DeckStats";

it("shows counts and limitations without deriving a shortage from total pips", () => {
  const cards = [
    { name: "White spells", qty: 30, board: "main", produced_mana: "", card: { type_line: "Creature", cmc: 3, mana_cost: "{W}{W}{W}" } },
    { name: "Plains", qty: 20, board: "main", produced_mana: "W", card: { type_line: "Basic Land — Plains", cmc: 0, mana_cost: "" } },
  ] as DeckEntry[];
  const html = renderToStaticMarkup(<DeckStatsPanel cards={cards} />);
  expect(html).toContain("Land access");
  expect(html).toContain('class="mana-count">90');
  expect(html).toContain('class="mana-count">20');
  expect(html).toContain('class="mana-track sources" aria-hidden="true"><span style="width:100%"');
  expect(html).not.toMatch(/short-flag|>Short<|per 3 pips/);
  expect(html).toContain("Total pip ratios alone can&#x27;t establish a shortage");
  expect(html).toContain("Mana rocks, creatures and spell abilities aren&#x27;t included");
});
