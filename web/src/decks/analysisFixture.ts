// A deck analysis for tests, shaped like GET /api/decks/:id/analysis.
import type { DeckAnalysis, DeckAnalysisView } from "../api";

export function analysis(power: number, over: Partial<DeckAnalysis> = {}): DeckAnalysis {
  return {
    method: "2026-11-08",
    power,
    margin: 0.4,
    confidence: "high",
    label: "Focused casual",
    description: "A steady plan with chosen cards, at a moderate speed.",
    power_bracket: power <= 5 ? 2 : power <= 7 ? 3 : 4,
    vectors: [
      { key: "speed", label: "Speed", score: 51, band: "Average", groups: [{ key: "fast_mana", label: "Fast mana", cards: [{ name: "Sol Ring", points: 9, copies: 1 }] }] },
      { key: "consistency", label: "Consistency", score: 62, band: "Average", groups: [] },
      { key: "interaction", label: "Interaction", score: 74, band: "Strong", groups: [{ key: "removal", label: "Spot removal", cards: [{ name: "Swords to Plowshares", points: 8, copies: 1 }] }] },
      { key: "mana", label: "Mana base", score: 62, band: "Average", groups: [{ key: "Basic lands", label: "Basic lands", cards: [{ name: "Plains", points: 6, copies: 11 }] }] },
      { key: "threats", label: "Threats", score: 76, band: "Strong", groups: [] },
    ],
    caps: [],
    combos: { checked: true, lines: [], score: 0, families: 0, compact: 0, unrecognized: 0 },
    themes: [{ key: "graveyard", label: "Graveyard", strength: "core", count: 27, description: "Uses the graveyard as a second hand.", cards: ["Sun Titan"] }],
    average_mana_value: 3.0,
    lands: 36,
    unscored: 5,
    nonland: 64,
    unknown_cards: [],
    ...over,
  };
}

const scores = { speed: 51, consistency: 62, interaction: 74, mana: 62, threats: 76 };

export function analysisView(power: number): DeckAnalysisView {
  return {
    method: "2026-11-08",
    current: analysis(power),
    versions: [
      { id: "v2", number: 2, note: "Bracket 3 upgrades", created_at: "2026-11-07T12:00:00Z", current: true, power, margin: 0.4, scores, checked: true },
      { id: "v1", number: 1, note: null, created_at: "2026-10-20T12:00:00Z", current: false, power: 3.6, margin: 0.4, scores, checked: true },
    ],
    configurations: [
      { id: "deck", name: "Lorehold Spirit", configuration: null, this: true, version_id: "v2", power, margin: 0.4, scores, checked: true },
      { id: "stock", name: "Lorehold Spirit (stock)", configuration: "stock", this: false, version_id: "s1", power: 3.4, margin: 0.4, scores, checked: true },
    ],
    computed_at: "2026-11-08T12:00:00Z",
  };
}
