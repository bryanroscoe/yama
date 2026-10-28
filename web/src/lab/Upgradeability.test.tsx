import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpgradeabilitySection, UpgradeabilitySummary } from "./Upgradeability";
import { filterPrecons, sortPrecons } from "./logic";
import type { PreconItem, Upgradeability } from "./api";

const value: Upgradeability = {
  score: 5,
  label: "Exceptional",
  status: "reviewed",
  effort: "Substantial",
  path: "Replace secondary creature themes with spell-trigger payoffs.",
  limitation: "Commander removal stops the damage engine.",
  assessed_on: "2026-10-27",
  source_url: "https://mtgjson.com/api/v5/decks/Test.json",
  method: "source-backed-upgradeability-v4",
  basis: "Yama judgment; no upgrade win-rate estimate.",
  rubric: "Ordinal grades; missing evidence is ungraded.",
  levels: [
    { score: 1, label: "Minimal", meaning: "A limiting mechanism remains." },
    {
      score: 5,
      label: "Exceptional",
      meaning: "Repeatable resources and a direct finish.",
    },
  ],
  rationale: {
    support: "Spells provide interaction.",
    payoff: "Damage repeats on qualifying casts.",
    constraints: "Mana value three or more.",
  },
  examples: [
    {
      name: "Curiosity",
      role: "Damage-to-draw payoff",
      url: "https://scryfall.com/card/test",
      oracle_id: "example",
      legal_checked_on: "2026-10-27",
      basis: "Named in the linked upgrade guide",
    },
  ],
  sources: [
    {
      title: "Guide",
      author: "Named author",
      publisher: "Publisher",
      published_on: "2025-06-16",
      checked_on: "2026-10-27",
      accessed_on: "2026-10-26",
      url: "https://example.com/guide",
      summary: "Describes spell upgrades.",
      kind: "upgrade_guide",
      rating: "B",
      commander_configurations: [["Example"]],
    },
  ],
  commander_cards: [],
  commander_results: [
    {
      name: "Example",
      url: "https://playgroup.gg/commanders/1",
      api_url: "https://playgroup.gg/api/public/v1/commanders/1.json",
      games: 10,
      wins: 3,
      raw_win_rate_percent: 30,
      fetched_at: "2026-10-27T12:00:00Z",
      provider_updated_at: null,
      population: "Mixed lists",
    },
  ],
  variant_key: "catalog",
  commanders: ["Example"],
  scope: "catalog",
  continuity: null,
  retained_cards: null,
  list_checked_on: null,
  list_url: null,
  list_fingerprint: null,
  simulation_note: "No matched simulation results are attached.",
  alternatives: [],
  commander_caveat:
    "Raw rates mix stock and modified lists and pod sizes. No upgrade gain can be inferred.",
  attribution: "Playgroup.gg CC BY 4.0",
  gap: null,
};
describe("upgradeability evidence", () => {
  it("shows reasons, review grades, commander counts and the level meanings separately", () => {
    const html = renderToStaticMarkup(<UpgradeabilitySection value={value} />);
    for (const text of [
      "5/5",
      "Substantial changes",
      value.path!,
      value.assessed_on!,
      value.rationale!.constraints,
      "Curiosity",
      "Publisher’s overall review grade",
      "Named author",
      "2025-06-16",
      "2026-10-27",
      "Commander results",
      "30.0% raw wins (3 / 10 games)",
      "small sample",
      "What 1–5 means",
      "Minimal",
      "Exceptional",
      value.commander_caveat,
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Provisional");
  });
  it("keeps a missing grade distinct from zero and still shows the available sources", () => {
    expect(renderToStaticMarkup(<UpgradeabilitySummary />)).toContain(
      "Ungraded",
    );
    const html = renderToStaticMarkup(
      <UpgradeabilitySection
        value={{
          ...value,
          score: null,
          status: "insufficient_evidence",
          label: "Ungraded",
          rationale: null,
          examples: [],
          gap: "Guide changes commander.",
        }}
      />,
    );
    expect(html).toContain("Guide changes commander.");
    expect(html).toContain("Commander results");
    expect(html).toContain("Named author");
    expect(html).not.toContain("5/5");
    expect(html).not.toContain("0/5");
    expect(html).not.toContain(value.path!);
  });
  it("withdraws legacy grades even in an offline catalog cache", () => {
    const legacy = { ...value, method: "editorial-upgradeability-v1" };
    expect(
      renderToStaticMarkup(<UpgradeabilitySummary value={legacy} />),
    ).toContain("Needs refreshed evidence");
    const html = renderToStaticMarkup(<UpgradeabilitySection value={legacy} />);
    expect(html).toContain("unsupported grades have been withdrawn");
    expect(html).not.toContain("5/5");
  });
  it("does not invent audit metadata for a new catalog import", () => {
    const html = renderToStaticMarkup(
      <UpgradeabilitySection
        value={{
          ...value,
          score: null,
          status: "not_assessed",
          label: "Ungraded",
          rationale: null,
          examples: [],
          sources: [],
          commander_results: [],
          assessed_on: null,
          source_url: null,
          gap: "Not assessed yet.",
        }}
      />,
    );
    expect(html).toContain("Not assessed yet.");
    expect(html).not.toContain("Audited ");
    expect(html).not.toContain("Catalog list");
    const changed = renderToStaticMarkup(
      <UpgradeabilitySection
        value={{
          ...value,
          score: null,
          status: "stock_list_changed",
          rationale: null,
          examples: [],
          gap: "The catalog list changed.",
        }}
      />,
    );
    expect(changed).toContain("Prior audit 2026-10-27.");
    expect(changed).not.toContain("Audited 2026-10-27.");
  });
  it("does not display a zero-game observation as a zero win rate", () => {
    const html = renderToStaticMarkup(
      <UpgradeabilitySection
        value={{
          ...value,
          commander_results: [
            {
              ...value.commander_results[0]!,
              games: 0,
              wins: 0,
              raw_win_rate_percent: null,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("No recorded games");
    expect(html).not.toContain("0.0% raw");
  });
  it("does not rank a retired cached grade", () => {
    const rows = [
      {
        name: "Retired",
        upgradeability: { ...value, method: "editorial-upgradeability-v1" },
      },
      { name: "Current", upgradeability: { ...value, score: 3 } },
    ] as PreconItem[];
    expect(
      sortPrecons(rows, "upgradeability", true).map((x) => x.name),
    ).toEqual(["Current", "Retired"]);
  });
  it("keeps alternate commander grades and list identities separate", () => {
    const alternate = {
      ...value,
      variant_key: "another-commander",
      commanders: ["Another commander"],
      scope: "on_theme_swap" as const,
      score: 4,
      label: "Broad",
      continuity: {
        theme: "Spell triggers",
        retains: "Keeps the spell package.",
        changes: "Changes the commander payoff.",
      },
      retained_cards: 99,
      list_checked_on: "2026-10-27",
      list_url: "/precons/example/commanders/another-commander/decklist.txt",
      list_fingerprint: "different-list",
      alternatives: [],
    };
    const parent = {
      ...value,
      score: null,
      label: "Ungraded",
      rationale: null,
      examples: [],
      gap: "Reference commander lacks support.",
      alternatives: [alternate],
    };
    const html = renderToStaticMarkup(<UpgradeabilitySection value={parent} />);
    for (const text of [
      "Reference commander lacks support.",
      "Another commander: 4/5 Broad",
      "Keeps the spell package.",
      "Changes the commander payoff.",
      "99/100 card copies retained",
      alternate.list_url,
      alternate.simulation_note,
    ])
      expect(html).toContain(text);
    expect(
      renderToStaticMarkup(<UpgradeabilitySummary value={parent} />),
    ).toContain("Another commander: 4/5 Broad");
    expect(
      renderToStaticMarkup(
        <UpgradeabilitySection
          value={{ ...value, method: "source-backed-upgradeability-v2" }}
        />,
      ),
    ).not.toContain("unsupported grades have been withdrawn");
  });
  it("finds precons by separately assessed commander names without bypassing filters", () => {
    const list = [
      {
        id: "counter-intelligence",
        name: "Counter Intelligence",
        commanders: ["Inspirit, Flagship Vessel"],
        color_identity: "WU",
        set_code: "EOC",
        released: "2025-01-01",
        upgradeability: {
          ...value,
          alternatives: [{ ...value, commanders: ["Kilo, Apogee Mind"] }],
        },
      },
      {
        id: "quantum-quandrix",
        name: "Quantum Quandrix",
        commanders: ["Adrix and Nev, Twincasters"],
        color_identity: "GU",
        set_code: "C21",
        released: "2021-01-01",
        upgradeability: {
          ...value,
          alternatives: [
            { ...value, commanders: ["Koma, Cosmos Serpent"], score: null },
          ],
        },
      },
      {
        id: "unknown",
        name: "Unknown",
        commanders: ["Other commander"],
        color_identity: "R",
        set_code: "NEW",
        released: "2026-01-01",
      },
    ] as PreconItem[];
    const find = (q: string, colors = "", year: number | null = null) =>
      filterPrecons(list, { q, colors, year, mode: "includes" }).map(
        (p) => p.id,
      );
    expect(find("KILO, APOGEE MIND")).toEqual(["counter-intelligence"]);
    expect(find("koma")).toEqual(["quantum-quandrix"]);
    expect(find("Inspirit")).toEqual(["counter-intelligence"]);
    expect(find("kilo", "G")).toEqual([]);
    expect(find("kilo", "", 2021)).toEqual([]);
    expect(find("not present")).toEqual([]);
  });
  it("shows package coverage and ranks supported in-box options without borrowing an outside grade", () => {
    const packageInfo = {
      checked_on: "2026-10-28",
      roster_complete: true,
      configurations: 6,
      validated_configurations: 6,
      graded_configurations: 4,
      best_supported_score: 4,
      best_supported_label: "Broad",
      best_supported_commanders: [["Mister Fantastic"], ["Human Torch"]],
      featured_commanders: [
        ["Invisible Woman"],
        ["Mister Fantastic"],
        ["Human Torch"],
        ["The Thing"],
      ],
      other_legends: ["Alicia Masters"],
      note: "Unassessed options may be stronger.",
    };
    const v = { ...value, score: 3, package: packageInfo };
    const html = renderToStaticMarkup(<UpgradeabilitySection value={v} />);
    for (const phrase of [
      "The complete package",
      "Highest supported in-box upgrade grade: 4/5 Broad",
      "4/6 commander configurations graded",
      "Human Torch",
      "The Thing",
      "Other included legends",
    ])
      expect(html).toContain(phrase);
    const outsideOnly = {
      ...value,
      score: 5,
      package: {
        ...packageInfo,
        best_supported_score: null,
        best_supported_commanders: [],
        graded_configurations: 0,
      },
    };
    const rows = [
      { name: "Outside only", upgradeability: outsideOnly },
      { name: "Covered package", upgradeability: v },
    ] as PreconItem[];
    expect(
      sortPrecons(rows, "upgradeability", true).map((x) => x.name),
    ).toEqual(["Covered package", "Outside only"]);
    expect(
      renderToStaticMarkup(<UpgradeabilitySummary value={outsideOnly} />),
    ).toContain("Package ungraded");
  });
  it("sorts grades independently of strength and leaves ungraded lists last", () => {
    const rows = [
      { name: "Ungraded" },
      { name: "Broad", upgradeability: { ...value, score: 4 } },
      { name: "Exceptional", upgradeability: value },
    ] as PreconItem[];
    expect(
      sortPrecons(rows, "upgradeability", true).map((x) => x.name),
    ).toEqual(["Exceptional", "Broad", "Ungraded"]);
    expect(
      sortPrecons(rows, "upgradeability", false).map((x) => x.name),
    ).toEqual(["Broad", "Exceptional", "Ungraded"]);
  });
});
