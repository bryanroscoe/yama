import { useQuery } from "@tanstack/react-query";
import { identityName, MANA, type ManaKey } from "@yama/core";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { ErrorText, Pips } from "../components/ui";
import type { PreconItem, PreconList, RunLabel } from "./api";
import {
  DEFAULT_DESC,
  filterPrecons,
  fmtDate,
  linScale,
  logScale,
  pct,
  pctRange,
  rateCeiling,
  simLabel,
  sortPrecons,
  strengthDomain,
  strengthText,
  year,
  yearsOf,
  type ColorMode,
  type Scale,
  type SortKey,
} from "./logic";
import { CAVEAT, IntervalBar, SimLine } from "./parts";

export const usePrecons = () => useQuery({ queryKey: ["lab", "precons"], queryFn: () => api<PreconList>("/api/precons"), staleTime: 5 * 60_000 });

const SORTS: { key: SortKey; label: string }[] = [
  { key: "rank", label: "Simulated rank" },
  { key: "strength", label: "Strength" },
  { key: "p4", label: "Wins in 4-player pods" },
  { key: "games", label: "Games" },
  { key: "real", label: "Real-game rank" },
  { key: "name", label: "Name" },
  { key: "set", label: "Set" },
  { key: "year", label: "Year" },
];

const COLORS: ManaKey[] = ["W", "U", "B", "R", "G", "C"];

/** The run label line under the page title. */
export function RunLine({ run }: { run: RunLabel }) {
  return (
    <SimLine>
      {simLabel({ engine: run.engine, card_data: run.card_data, difficulty: run.difficulty, games: run.games, pod: run.pod, date: run.analysed_at ?? run.created_at, run: run.name })}.
    </SimLine>
  );
}

/** The analysis's own warnings about a run, folded away. */
export function RunWarnings({ warnings }: { warnings: string[] }) {
  return (
    <details className="small">
      <summary>
        {warnings.length} {warnings.length === 1 ? "note" : "notes"} from the analysis
      </summary>
      <ul className="lab-note">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

export function PreconsPage() {
  const precons = usePrecons();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const colors = params.get("c") ?? "";
  const mode = (params.get("m") ?? "includes") as ColorMode;
  const yr = params.get("y") ? Number(params.get("y")) : null;
  const sort = (params.get("s") ?? "rank") as SortKey;
  const desc = params.has("d") ? params.get("d") === "1" : DEFAULT_DESC[sort];

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const sortBy = (key: SortKey) => set(key === sort ? { s: key, d: desc ? "0" : "1" } : { s: key, d: null });
  const toggleColor = (k: string) => set({ c: colors.includes(k) ? colors.replace(k, "") : colors + k });

  const all = precons.data?.precons ?? [];
  const run = precons.data?.run ?? null;
  const rows = useMemo(() => sortPrecons(filterPrecons(all, { q, colors, mode, year: yr }), sort, desc), [all, q, colors, mode, yr, sort, desc]);
  // Axes from every rated precon, so filtering never rescales the bars.
  const strengthScale = useMemo(() => {
    const [lo, hi] = strengthDomain(all.map((p) => p.rating ?? { strength: null, lo: null, hi: null }));
    return logScale(lo, hi);
  }, [all]);
  const p4Scale = useMemo(() => linScale(0, rateCeiling(all.map((p) => p.rating?.p4_hi))), [all]);
  const years = useMemo(() => yearsOf(all), [all]);
  const rated = all.filter((p) => p.rating).length;
  const real = all.find((p) => p.playgroup?.source)?.playgroup;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Commander precons</h1>
          <p className="dim" style={{ margin: 0 }}>
            {all.length} precons{run ? `, ${rated} rated by simulation` : ""}.
          </p>
        </div>
      </div>
      <ErrorText error={precons.error} />
      {run ? (
        <>
          <RunLine run={run} />
          <p className="lab-caveat">{CAVEAT} Real-game ranks from playgroup.gg sit in their own column.</p>
          {run.warnings.length > 0 && <RunWarnings warnings={run.warnings} />}
          <details className="small">
            <summary>How the ratings work</summary>
            <p className="lab-note">
              Every precon played whole games against other precons, with phase's AI in every seat, in 4-player pods. <b>Strength</b> comes from a
              model of finishing order ({run.model ?? "Plackett-Luce"}): 1 is an average precon, 2 finishes ahead about twice as often. The line on each
              bar marks average; the band is the {run.level ? `${Math.round(run.level * 100)}%` : ""} interval, so a wide band means few games.
              <b> Wins in 4-player pods</b> is the model's chance of winning a pod of three random precons; a quarter is average. Rank ranges and the
              raw wins are in each precon's page.
            </p>
            {real && (
              <p className="lab-note">
                Real-game ranks: playgroup.gg's precon tier list ({real.method}), fetched {fmtDate(real.fetched)}. They count people's games, not
                simulations, and only cover precons with enough logged games.
              </p>
            )}
          </details>
        </>
      ) : (
        precons.data && <p className="lab-caveat">No rating run is imported on this server yet, so the precons have no simulated strength.</p>
      )}

      <div className="lab-tools" style={{ marginTop: "1rem" }}>
        <div className="row">
          <input type="search" value={q} onChange={(e) => set({ q: e.target.value })} placeholder="Search by deck, commander or set" aria-label="Search precons" />
          <select value={yr ?? ""} onChange={(e) => set({ y: e.target.value })} aria-label="Year">
            <option value="">Any year</option>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => set({ s: e.target.value, d: null })} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>Sort: {s.label.toLowerCase()}</option>
            ))}
          </select>
          <button type="button" aria-pressed={desc !== DEFAULT_DESC[sort]} onClick={() => set({ d: desc ? "0" : "1" })}>
            Reverse
          </button>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <div className="lab-chips" role="group" aria-label="Colours">
            {COLORS.map((k) => (
              <button key={k} type="button" aria-pressed={colors.includes(k)} onClick={() => toggleColor(k)} title={MANA[k].name}>
                <span className="pip" style={{ background: MANA[k].fill }} /> {MANA[k].name}
              </button>
            ))}
          </div>
          {colors && (
            <select value={mode} onChange={(e) => set({ m: e.target.value === "includes" ? null : e.target.value })} aria-label="How colours match" style={{ width: "auto" }}>
              <option value="includes">Includes these colours</option>
              <option value="exactly">Exactly these colours</option>
              <option value="within">Within these colours</option>
            </select>
          )}
        </div>
      </div>
      {precons.data && (
        <p className="lab-count">
          {rows.length === all.length ? `${all.length} precons` : `${rows.length} of ${all.length} precons`}
          {colors && `, ${mode === "exactly" ? "exactly" : mode === "within" ? "within" : "including"} ${identityName(colors.replace("C", "")).toLowerCase()}`}
        </p>
      )}

      <table className="lab-table">
        <thead>
          <tr>
            <Th k="rank" label="Rank" sort={sort} desc={desc} onSort={sortBy} num />
            <Th k="name" label="Deck" sort={sort} desc={desc} onSort={sortBy} />
            <Th k="set" label="Set" sort={sort} desc={desc} onSort={sortBy} />
            <Th k="year" label="Year" sort={sort} desc={desc} onSort={sortBy} num />
            <Th k="strength" label="Strength (1 = average)" sort={sort} desc={desc} onSort={sortBy} />
            <Th k="p4" label="Wins in 4-player pods" sort={sort} desc={desc} onSort={sortBy} />
            <Th k="games" label="Games" sort={sort} desc={desc} onSort={sortBy} num />
            <Th k="real" label="Real games (playgroup.gg)" sort={sort} desc={desc} onSort={sortBy} className="real" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <TableRow key={p.id} p={p} strengthScale={strengthScale} p4Scale={p4Scale} />
          ))}
        </tbody>
      </table>
      <div className="lab-cards">
        {rows.map((p) => (
          <Link key={p.id} to={`/decks/lab/p/${p.id}`} className="lab-card">
            <span className="rank">{p.rating?.rank ?? ""}</span>
            <span>
              <span className="title">{p.name}</span> <Pips identity={p.color_identity} />
              <span className="sub">
                {p.set_name ?? p.set_code}, {year(p.released) ?? "no date"}
              </span>
              {p.playgroup?.rank != null && <span className="sub">Real games: {p.playgroup.rank} of {p.playgroup.of} on playgroup.gg</span>}
            </span>
            <span className="metric">
              {p.rating?.strength != null ? (
                <>
                  {strengthText(p.rating.strength)} <span>strength</span>
                  <IntervalBar value={p.rating.strength} lo={p.rating.lo} hi={p.rating.hi} scale={strengthScale} reference={1} label={strengthAria(p)} />
                  {p.rating.p4_field != null && <span>wins {pct(p.rating.p4_field)} of pods</span>}
                </>
              ) : (
                <span>not rated</span>
              )}
            </span>
          </Link>
        ))}
      </div>
      {precons.data && rows.length === 0 && <p className="empty">No precon matches. Clear the search or a colour.</p>}
    </>
  );
}

function Th({ k, label, sort, desc, onSort, num, className }: { k: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; num?: boolean; className?: string }) {
  const active = sort === k;
  return (
    <th className={[num ? "num" : "", className ?? ""].join(" ").trim() || undefined} aria-sort={active ? (desc ? "descending" : "ascending") : undefined} scope="col">
      <button type="button" onClick={() => onSort(k)}>
        {label}
        {active && <span aria-hidden="true">{desc ? "↓" : "↑"}</span>}
      </button>
    </th>
  );
}

const strengthAria = (p: PreconItem) => {
  const r = p.rating;
  if (r?.strength == null) return `${p.name}: not rated`;
  return `${p.name}: strength ${strengthText(r.strength)}${r.lo != null && r.hi != null ? `, interval ${strengthText(r.lo)} to ${strengthText(r.hi)}` : ""}; 1 is average`;
};

function TableRow({ p, strengthScale, p4Scale }: { p: PreconItem; strengthScale: Scale; p4Scale: Scale }) {
  const r = p.rating;
  const pg = p.playgroup;
  return (
    <tr>
      <td className="num" title={r?.rank_lo != null ? `Could be anywhere from ${r.rank_lo} to ${r.rank_hi}` : undefined}>
        {r?.rank ?? ""}
      </td>
      <td className="deck">
        <Link to={`/decks/lab/p/${p.id}`}>{p.name}</Link> <Pips identity={p.color_identity} />
        <span className="sub">{p.commanders.join(" and ")}</span>
      </td>
      <td className="set">
        {p.set_name ?? p.set_code}
        {p.set_name && <span className="sub">{p.set_code}</span>}
      </td>
      <td className="num">{year(p.released) ?? ""}</td>
      <td className="bar">
        {r?.strength != null ? (
          <>
            <IntervalBar value={r.strength} lo={r.lo} hi={r.hi} scale={strengthScale} reference={1} label={strengthAria(p)} />
            <span className="lab-bar-val">
              {strengthText(r.strength)} {r.lo != null && r.hi != null && <span>({strengthText(r.lo)} to {strengthText(r.hi)})</span>}
            </span>
          </>
        ) : (
          <span className="dim small">not rated</span>
        )}
      </td>
      <td className="bar">
        {r?.p4_field != null ? (
          <>
            <IntervalBar
              value={r.p4_field}
              lo={r.p4_lo}
              hi={r.p4_hi}
              scale={p4Scale}
              reference={0.25}
              label={`${p.name}: wins ${pct(r.p4_field)} of 4-player pods${r.p4_lo != null && r.p4_hi != null ? `, interval ${pctRange(r.p4_lo, r.p4_hi)}` : ""}; a quarter is average`}
            />
            <span className="lab-bar-val">
              {pct(r.p4_field)} {r.p4_lo != null && r.p4_hi != null && <span>({pctRange(r.p4_lo, r.p4_hi)})</span>}
            </span>
          </>
        ) : (
          <span className="dim small">{r ? "no data" : "not rated"}</span>
        )}
      </td>
      <td className="num">{r?.games ?? ""}</td>
      <td className="real">
        {pg?.rank != null ? (
          <>
            {pg.rank} of {pg.of}
            <span className="sub">
              {pg.tier ? `Tier ${pg.tier}, ` : ""}
              {pg.win_rate_4p != null ? `${pg.win_rate_4p.toFixed(1)}% wins, ` : ""}
              {pg.games} games
            </span>
          </>
        ) : (
          <span className="dim small">no data</span>
        )}
      </td>
    </tr>
  );
}
