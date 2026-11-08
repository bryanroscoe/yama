import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceSection, trendText } from "./Evidence";
import type { PreconEvidence } from "./api";

const evidence: PreconEvidence = {
  real: {
    source: { name: "Playgroup.gg", attribution: "Playgroup.gg / Arcane Digital B.V.", license: "CC BY 4.0", datasets: [{ id: "playgroup-history", revision: 2, imported_at: "2026-10-29T00:11:11Z" }] },
    entity: "playgroup:precon:riders-of-rohan", entity_name: "Riders of Rohan", url: "https://playgroup.gg/sets/x/precons/riders-of-rohan",
    matched_by: "url", cohort: "https://playgroup.gg/commander/precons",
    latest: { as_of: "2026-10-28T16:00:00Z", games: 477, rate: 19.81 },
    snapshots: [{ as_of: "2026-08-06T16:00:00Z", games: 263, rate: 23.81 }, { as_of: "2026-10-28T16:00:00Z", games: 477, rate: 19.81 }],
    intervals: [{ from: "2026-08-06T16:00:00Z", to: "2026-10-28T16:00:00Z", games: 214, rate: 14.9 }],
    recent: { rate: 14.9, games: 214, effective_games: 190, from: "2026-08-06T16:00:00Z", to: "2026-10-28T16:00:00Z", half_life_days: 180 },
    trend_points_per_30_days: null, notes: [], as_of: "2026-10-29T00:00:00Z", method: "Implied rate between snapshots.",
  },
  commander: null,
};

describe("EvidenceSection", () => {
  it("shows the all-time and recent rates with the source", () => {
    const html = renderToStaticMarkup(<EvidenceSection evidence={evidence} />);
    expect(html).toContain("All time: 19.8% wins in 4-player pods over 477 games");
    expect(html).toContain("about 14.9% over 214 newer games");
    expect(html).toContain('href="https://playgroup.gg/sets/x/precons/riders-of-rohan"');
    expect(html).toContain("playgroup-history revision 2");
  });
  it("shows every enabled source's history", () => {
    const other = { ...evidence.real!, source: { ...evidence.real!.source, name: "Other tracker" }, latest: { ...evidence.real!.latest, games: 120 } };
    const html = renderToStaticMarkup(<EvidenceSection evidence={{ ...evidence, also: [other] }} />);
    expect(html).toContain("From Other tracker");
    expect(html).toContain("over 120 games");
  });
  it("shows a commander's figure apart, and nothing when there's no evidence", () => {
    const html = renderToStaticMarkup(<EvidenceSection evidence={{ real: null, commander: { source: { name: "Playgroup.gg", attribution: "Playgroup.gg / Arcane Digital B.V.", license: "CC BY 4.0", datasets: [] }, entity: "playgroup:commander:1", name: "Test Commander", url: null, window_days: 180, rate: 27.5, games: 300, as_of: "2026-10-28T17:00:00Z", note: "Every list recorded under this commander." } }} />);
    expect(html).toContain("Commander, all lists: Test Commander won 27.5% of 300 games");
    expect(html).toContain("CC BY 4.0");
    expect(renderToStaticMarkup(<EvidenceSection evidence={null} />)).toBe("");
  });

  it("shows a commander-only source's figure for every list", () => {
    const source = { name: "Mythic Tools", attribution: "Derived from Mythic Tools.", license: "Derived rates only", datasets: [] };
    const html = renderToStaticMarkup(<EvidenceSection evidence={{ real: null, commander: null, all_lists: [{ source, name: "Ghalta, Primal Hunger", rate: 44.35, games: 7984, decks: 3077, note: "Every list." }] }} />);
    expect(html).toContain("Commander, any list: Ghalta, Primal Hunger won 44.4% of 7,984 games from 3,077 decks on Mythic Tools.");
  });
  it("words trends", () => {
    expect(trendText(-1.24)).toBe("Falling about 1.2 points a month.");
    expect(trendText(0.2)).toBe("Steady over the snapshots.");
    expect(trendText(null)).toBeNull();
  });
});
