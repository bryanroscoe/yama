import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PreconItem, PreconList, Rating } from "./api";
import { PreconsPage } from "./Precons";

vi.mock("./LabLayout", () => ({ LabHead: () => null }));

const rating = (rank: number, level: "ok" | "doubtful" | "unreliable" = "ok"): Rating => ({
  deck_ref: `d${rank}`, strength: 1, lo: 0.8, hi: 1.2, win_rate: 0.25, wr_lo: 0.2, wr_hi: 0.3, games: 40, avg_place: 2.5,
  rank, rank_lo: rank, rank_hi: rank + 2, p4_field: 0.25, p4_lo: 0.2, p4_hi: 0.3, flags: [],
  confidence: level === "ok" ? null : ({ level, reasons: [] } as unknown as Rating["confidence"]),
});

const precon = (n: number, level?: "doubtful" | "unreliable"): PreconItem => ({
  id: `p${n}`, lab_id: `l${n}`, name: `Precon ${n}`, set_code: "ABC", set_name: "A Set", released: "2024-01-01", commanders: [`Commander ${n}`],
  color_identity: "WU", same_list_as: null, card_count: 100, art: null,
  playgroup: { rank: n, of: 50, games: 30, source: "playgroup.gg", fetched: "2026-10-20", method: "Stock games only" },
  rating: rating(n, level),
});

const fixture: PreconList = {
  run: {
    id: "r", name: "precons-2", kind: "precon-ratings", global: true, engine: "phase-rs v0.113.0+aifix", card_data: "eb30910812345678", runner: null,
    difficulty: "Easy", games: 6856, ranked: 3, pod: 4, level: 0.9, model: "Plackett-Luce", created_at: "2026-10-24", analysed_at: "2026-10-24",
    imported_at: "2026-10-24", warnings: ["Three decks hit the turn limit in most games."],
    confidence: { method: "Compared with playgroup.gg; see analysis/confidence.py.", reference_run: "precons-1", counts: { ok: 1, doubtful: 1, unreliable: 1 } },
  },
  precons: [precon(1), precon(2, "doubtful"), precon(3, "unreliable")],
};

function renderPrecons(data: PreconList = fixture, address = "/lab") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["lab", "precons"], data);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}><MemoryRouter initialEntries={[address]}><PreconsPage /></MemoryRouter></QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("precon list rating notes", () => {
  it("links from the summary line to the notes, which sit after the table under headings", () => {
    const html = renderPrecons();
    expect(html).toContain('<a href="#how-ratings-work">How these ratings work, 1 analysis note</a>');
    expect(html.indexOf('id="how-ratings-work"')).toBeGreaterThan(html.indexOf("lab-table"));
    for (const h of ["Reading the table", "Sim unreliable and sim doubtful", "Real games", "Upgradeability", "This run", "From the analysis"]) {
      expect(html).toContain(`>${h}</h`);
    }
    expect(html).toContain("<dd>eb309108</dd>");
    expect(html).toContain("Three decks hit the turn limit in most games.");
    expect(html).toContain("1 precon here, listed last");
    expect(html).not.toContain("Rating details");
  });

  it("keeps the engine's version out of the summary line, under This run", () => {
    const html = renderPrecons();
    const summary = html.slice(html.indexOf('class="lab-note"'), html.indexOf("#how-ratings-work"));
    expect(summary).toContain("3 precons rated</b> from 6,856 simulated 4-player games, ");
    expect(summary).not.toContain("phase-rs");
    expect(summary).not.toContain("AI");
    expect(html).toContain("<dd>phase-rs v0.113.0+aifix</dd>");
  });

  it("tells someone starting from a precon what to do, above the search", () => {
    expect(renderPrecons()).not.toContain("Find the precon you own");
    const html = renderPrecons(fixture, "/lab?start=1");
    expect(html).toContain("Find the precon you own, open it, and choose Make this a Yama deck.");
    expect(html.indexOf("Find the precon you own")).toBeLessThan(html.indexOf('class="lab-search"'));
  });

  it("leaves the notes out when nothing has been rated", () => {
    const html = renderPrecons({ run: null, precons: [] });
    expect(html).not.toContain("how-ratings-work");
  });
});
