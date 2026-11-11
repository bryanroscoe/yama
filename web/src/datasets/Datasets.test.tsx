import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetsPage, MonthlySummaries, RecordCard, commanderLine } from "./Datasets";
import { count, datasetPath, percent, sourceUrl, type Dataset, type DatasetRead, type EvidenceRecord } from "./api";

const auth = vi.hoisted(() => ({ id: "bryan", is_admin: false, viewing: undefined as object | undefined }));
vi.mock("../auth", () => ({ useMe: () => ({ data: auth }) }));
vi.mock("../lab/LabLayout", () => ({ LabHead: ({ title }: { title: string }) => <h1>{title}</h1> }));
const head: Dataset = {
  id: "playgroup-history", title: "Historical Playgroup evidence", revision: 3, content_hash: "abc",
  imported_at: "2026-10-28T20:00:00Z", source_documents: 316,
  source: { name: "Playgroup.gg", url: "https://playgroup.gg/research", attribution: "Playgroup and archive sources" },
  records: { performance: 12051, weekly_activity: 29219, commander: 5242, commander_history: 179, archetype: 19, source_table: 352 },
};
const observation = (period: object, value: number | null = 0): EvidenceRecord => ({
  id: "observation", entity: "playgroup:commander:2978", kind: "performance", sources: ["source-hash"],
  data: { entity_name: "Test Commander", value, source_reported_games: 100, cohort: "https://playgroup.gg/rankings", observation_period: period },
});
function page(url: string, value: Dataset[] | DatasetRead, owner = "bryan") {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const uri = new URL(url, "https://yama.ing");
  const id = uri.pathname.split("/")[3];
  client.setQueryData(id ? ["datasets", owner, id, uri.searchParams.toString()] : ["datasets", owner], value);
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/lab/datasets" element={<DatasetsPage />} /><Route path="/lab/datasets/:id" element={<DatasetsPage />} />
  </Routes></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { auth.is_admin = false; auth.viewing = undefined; });

describe("private evidence browser", () => {
  it("offers every imported record type and pins browse links to the displayed revision", () => {
    const html = page("/lab/datasets", [head]);
    expect(html).toContain("47,062 records");
    expect(html).toContain("316 source documents");
    expect(html).toContain("revision=3&amp;kind=weekly_activity");
    expect(html).toContain("Commander histories");
    expect(html).toContain("Source tables");
    expect(html).not.toContain("Import dataset");
  });
  it("does not show another account's cached dataset; upload is hidden during View as", () => {
    expect(page("/lab/datasets", [head], "someone-else")).not.toContain(head.title);
    auth.is_admin = true;
    expect(page("/lab/datasets", [head])).toContain("Import dataset");
    auth.viewing = {};
    expect(page("/lab/datasets", [head])).not.toContain("Import dataset");
  });
  it("keeps source periods, sample counts and zero versus missing rates readable", () => {
    const render = (r: EvidenceRecord) => renderToStaticMarkup(<RecordCard record={r} explore={() => {}} />);
    const zero = render(observation({ kind: "rolling_window", lookback_days: 180, source_as_of: "2026-10-28T12:00:00Z" }));
    expect(zero).toContain("0.00%"); expect(zero).toContain("100 source-reported games");
    expect(zero).toContain("180-day window as of Oct 28, 2026"); expect(zero).not.toContain("Complete month");
    expect(render(observation({ kind: "cumulative_snapshot", source_as_of: "2026-06-26T00:00:00Z" }, null))).toContain("Unknown");
    expect(render(observation({ kind: "calendar_month", start: "2026-09-01", end: "2026-10-01" }))).toContain("Complete month Sep 1, 2026 to Oct 1, 2026");
  });
  it("shows monthly weighting limits and keeps no eligible months distinct from a zero average", () => {
    const data: DatasetRead = { dataset: head, next_offset: null, monthly_summaries: [{ cohort: "https://playgroup.gg/monthly", months: 2, excluded_months: 1, source_reported_games: 436, weighted_source_rate_percent: null, half_life_days: 180, as_of: "2026-10-28" }] };
    let html = renderToStaticMarkup(<MonthlySummaries data={data} />);
    expect(html).toContain("No eligible months"); expect(html).toContain("1 months excluded");
    expect(html).toContain("100 most-played commanders"); expect(html).toContain("does not measure the effect");
    data.monthly_summaries![0]!.weighted_source_rate_percent = 0;
    html = renderToStaticMarkup(<MonthlySummaries data={data} />);
    expect(html).toContain("0.00%"); expect(html).not.toContain("No eligible months");
  });
  it("renders entity controls, revision export and a bounded next page", () => {
    const html = page("/lab/datasets/playgroup-history?revision=3&entity=playgroup%3Acommander%3A2978&label=Test+Commander", { dataset: head, records: [observation({ kind: "unknown" })], next_offset: 25, monthly_summaries: [] });
    expect(html).toContain("Recency half-life (days)"); expect(html).toContain('value="180"');
    expect(html).toContain("Download original dataset</button>");
    expect(html).not.toContain("/export?");
    expect(html).toContain("No compatible monthly observations");
    expect(html).toContain('<button disabled="">Previous</button>'); expect(html).toContain("<button>Next</button>");
  });
  it("pages through actual provenance and treats submitted strings as text", () => {
    const html = page("/lab/datasets/playgroup-history?revision=3&section=sources", { dataset: head, sources: [{ sha256: "retained-hash", url: "javascript:alert(1)", retrieved_at: "2026-10-28T00:00:00Z", flags: ["partial_archive_capture"], transformation: "<script>unsafe()</script>" }], next_offset: null });
    expect(html).toContain("partial_archive_capture"); expect(html).toContain("retained-hash");
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain("Commander or precon name");
  });
  it("only sends supported filters and never turns labels or credentials into API parameters", () => {
    const path = datasetPath("source/id", new URLSearchParams("entity=playgroup%3Acommander%3A1&label=Someone&revision=3&half_life_days=90&section=records&offset=25&token=secret&limit=999"));
    const url = new URL(path, "https://yama.ing");
    expect(url.pathname).toBe("/api/datasets/source%2Fid");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "25", entity: "playgroup:commander:1", revision: "3", half_life_days: "90", section: "records", offset: "25" });
    expect(sourceUrl("https://user:secret@example.com")).toBeUndefined(); expect(sourceUrl("data:text/html,hi")).toBeUndefined();
    expect(count(null)).toBe("Unknown"); expect(percent(0)).toBe("0.00%");
  });
});

describe("a commander record's figures", () => {
  it("says only what the source reported", () => {
    // A catalog row has no figures: it used to read "Unknown source-reported games, Unknown pilots. Source ELO: Unknown."
    expect(commanderLine({})).toBe("");
    expect(commanderLine({ game_played_count: 1200, pilot_count: 80, global_elo: 1512 })).toBe("1,200 source-reported games, 80 pilots. Source ELO: 1,512.");
    expect(commanderLine({ game_played_count: 12 })).toBe("12 source-reported games.");
    const html = renderToStaticMarkup(<RecordCard record={{ id: "r1", entity: "Krenko", kind: "commander", sources: [], data: { name: "Krenko, Mob Boss" } }} explore={() => undefined} />);
    expect(html).not.toContain("Unknown");
  });
});
