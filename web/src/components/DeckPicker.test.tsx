import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DeckSummary } from "../api";
import { SavedDeckPicker, DeckChoice, deckPicks } from "./DeckPicker";

vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "me" } }) }));
const main = { id: "rohan", name: "Riders of Rohan", commanders: ["Éowyn, Shieldmaiden"], color_identity: "WUR", commander_image: null, commander_artist: null } as unknown as DeckSummary;
const stock = { ...main, id: "rohan-stock", parent_id: main.id, configuration: "stock" } as DeckSummary;
const after = { ...main, id: "rohan-after", parent_id: main.id, configuration: "after prints" } as DeckSummary;

function picker(decks: DeckSummary[], value: string) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><SavedDeckPicker decks={decks} value={value} onChange={() => {}} /></QueryClientProvider>);
}

describe("shared saved-deck selection", () => {
  it("keeps an exact configuration selected while browsing its parent deck", () => {
    const html = picker([main, stock, after], after.id);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="Riders of Rohan"');
    expect(html).toContain('value="rohan-after" selected=""');
    expect(html).toContain('value="rohan-stock"');
    expect(html).toContain('Which list');
  });
  it("does not add a list selector when there is only one playable list", () => {
    expect(picker([main], main.id)).not.toContain("Which list");
  });
  it("does not offer public, historical or precon decks in the saved-deck source", () => {
    const picks = deckPicks("", { mine: [main, stock], yours: true, scope: "yours", precons: [{ id: "catalog", lab_id: "catalog", name: "Another deck", commanders: [], set_code: "TST", set_name: null, released: null, color_identity: "", same_list_as: null, card_count: 100, art: null, playgroup: null, rating: null }], played: [{ key: "historical", name: "Historical deck", named: true, commanders: [], player: "Someone", games: 1, last: "2026-11-09" }] });
    expect(picks).toEqual([{ kind: "mine", deck: main }]);
  });
  it("uses Table's compact list buttons for short names", () => {
    const html = renderToStaticMarkup(<DeckChoice label="Which list" options={[{ key: main.id, label: "Main list" }, { key: stock.id, label: "Stock" }]} value={stock.id} onChange={() => {}} />);
    expect(html).toContain('aria-pressed="true">Stock');
    expect(html).not.toContain('<select');
  });
});
