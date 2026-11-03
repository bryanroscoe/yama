import { UpgradeabilitySummary } from "./Upgradeability";
import { SinglesPrice } from "../components/DeckPrices";
import { useQuery } from "@tanstack/react-query";
import { identityName, MANA, type ManaKey } from "@yama/core";
import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, usd, shortDate } from "../api";
import { useMe } from "../auth";
import { WinBar, winCeiling } from "../components/Crop";
import { Details, ErrorText, Pips } from "../components/ui";
import { usePlan } from "../plan/store";
import type { PreconItem, PreconList, Rating, RunLabel, RunListItem } from "./api";
import { LabHead } from "./LabLayout";
import { ConfidenceMark } from "./confidence";
import {
  cantJudge,
  caveat,
  confidenceMark,
  DEFAULT_DESC,
  engineName,
  filterPrecons,
  fmtDate,
  identityMatches,
  pct,
  pctRange,
  shortHash,
  simDetails,
  SIM_SORTS,
  simLabel,
  sortPrecons,
  splitUnjudged,
  strengthText,
  year,
  yearsOf,
  type ColorMode,
  type SortKey,
} from "./logic";
import { stateLabel, useRuns, variantState } from "./paired";
import { SimLine } from "./parts";

export const usePrecons = () => useQuery({ queryKey: ["lab", "precons"], queryFn: ({ signal }) => api<PreconList>("/api/precons", { signal }), staleTime: 5 * 60_000 });

const SORTS: { key: SortKey; label: string }[] = [
  { key: "upgradeability", label: "Upgradeability" },
  { key: "rank", label: "Simulated rank" },
  { key: "p4", label: "Model win rate" },
  { key: "strength", label: "Strength" },
  { key: "games", label: "Games" },
  { key: "real", label: "Real-game rank" },
  { key: "name", label: "Name" },
  { key: "set", label: "Set" },
  { key: "year", label: "Year" },
];

const COLORS: ManaKey[] = ["W", "U", "B", "R", "G", "C"];

/** Under this many games a precon's rating is too uncertain to trust: faded, with "few games" in amber. */
const FEW = 10;

/** The run label line under the page title. */
export function RunLine({ run }: { run: RunLabel }) {
  return (
    <SimLine details={simDetails(run.card_data)}>
      {simLabel({ engine: run.engine, difficulty: run.difficulty, games: run.games, pod: run.pod, date: run.analysed_at ?? run.created_at, run: run.name })}.
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

/** One of your own lists as your paired run rated it (its own field and model fit, not the table's). */
interface MyList {
  id: string;
  name: string;
  state: string;
  run: RunListItem;
  rating: Rating;
  commanders: string[];
  identity: string | null;
}

/** "your after-prints list", "your list now", "your stock copy". */
function listWords(state: string): string {
  if (state === "stock") return "your stock copy";
  if (state === "now") return "your list now";
  if (state === "after") return "your after-prints list";
  return `your ${stateLabel(state)[0].toLowerCase()} list`;
}

/** Your lists from your paired runs, with the commanders and colours of the plan deck they belong to. */
function useMyLists(): MyList[] {
  const runs = useRuns();
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  return useMemo(() => {
    const mine = (runs.data ?? []).filter((r) => !r.global && r.kind === "paired" && r.paired);
    const out: MyList[] = [];
    mine.forEach((run) => {
      // Each list's rating comes with the runs list, so no run's detail is fetched.
      for (const v of run.paired!.variants) {
        const rating = v.rating;
        if (!rating) continue;
        const deck = plan.bundle?.decks.find((p) => variantState(v.id, p.key) != null);
        const state = deck ? variantState(v.id, deck.key)! : (/,\s*([^,)]+)\)\s*$/.exec(v.name)?.[1] ?? "list");
        const base = deck?.name ?? v.name.replace(/\s*\([^)]*\)\s*$/, "");
        out.push({ id: v.id, name: `${base}, ${listWords(state)}`, state, run, rating, commanders: deck?.commander ?? [], identity: deck?.color_identity ?? null });
      }
    });
    return out.sort((a, b) => (b.rating.p4_field ?? -1) - (a.rating.p4_field ?? -1));
  }, [runs.data, plan.bundle]);
}

export function PreconsPage() {
  const precons = usePrecons();
  const myLists = useMyLists();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const colors = params.get("c") ?? "";
  const mode = (params.get("m") ?? "includes") as ColorMode;
  const yr = params.get("y") ? Number(params.get("y")) : null;
  const sort = (params.get("s") ?? "rank") as SortKey;
  const desc = params.has("d") ? params.get("d") === "1" : DEFAULT_DESC[sort];
  const tenPlus = params.get("g") === "10";
  // Off by default: every precon stays listed, and the ones the simulation can't judge carry a mark
  // (and go last when the table is sorted by a simulated number).
  const hideUnjudged = params.get("h") === "1";
  // Phones keep the colour, year and sort controls folded until asked for (or in use).
  const [moreOpen, setMoreOpen] = useState(false);
  const filtering = !!colors || yr != null || tenPlus || hideUnjudged || params.has("s") || params.has("d");

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
  const rows = useMemo(
    () =>
      sortPrecons(filterPrecons(all, { q, colors, mode, year: yr }), sort, desc).filter(
        (p) => (!tenPlus || (p.rating?.games ?? 0) >= FEW) && (!hideUnjudged || !cantJudge(p.rating?.confidence)),
      ),
    [all, q, colors, mode, yr, sort, desc, tenPlus, hideUnjudged],
  );
  // Sorted by what the simulation says, the decks it can't judge go last, under their own heading.
  const simSort = SIM_SORTS.includes(sort);
  const [judged, unjudged] = useMemo(() => (simSort ? splitUnjudged(rows, (p) => p.rating?.confidence) : [rows, []]), [rows, simSort]);
  const needle = q.trim().toLowerCase();
  // Your lists start folded (there can be dozens), and open when asked or when the search finds one.
  const mineOpen = params.get("mine") === "1";
  const mineShown = myLists.filter(
    (m) =>
      (!needle || [m.name, ...m.commanders].some((s) => s.toLowerCase().includes(needle))) &&
      (!colors || (m.identity != null && identityMatches(m.identity, colors, mode))) &&
      (!tenPlus || m.rating.games >= FEW) &&
      (!hideUnjudged || !cantJudge(m.rating.confidence)) &&
      yr == null,
  );
  // One axis for every row, so filtering never rescales the bars.
  const max = useMemo(() => winCeiling([...all.map((p) => p.rating?.p4_hi), ...myLists.map((m) => m.rating.p4_hi)], 0.5), [all, myLists]);
  const years = useMemo(() => yearsOf(all), [all]);
  const rated = all.filter((p) => p.rating).length;
  const few = all.filter((p) => p.rating && p.rating.games < FEW).length;
  const real = all.find((p) => p.playgroup?.source)?.playgroup;
  const unjudgedAll = all.filter((p) => cantJudge(p.rating?.confidence)).length;
  const doubtfulAll = all.filter((p) => p.rating?.confidence?.level === "doubtful").length;
  const hidden = hideUnjudged ? sortPrecons(filterPrecons(all, { q, colors, mode, year: yr }), sort, desc).length - rows.length : 0;

  // No count, filters or table until the list is in: a count from nothing would be made up.
  if (!precons.data) {
    return (
      <>
        <LabHead title="Lab" index />
        {!precons.error && <p className="dim">Loading…</p>}
        <ErrorText error={precons.error} />
      </>
    );
  }
  // Ranks are among every deck in the run, which can include decks the catalogue leaves out.
  const rankedHere = all.filter((p) => p.rating?.rank != null).length;
  const skipped = run ? run.ranked - rankedHere : 0;
  const engine = run ? engineName(run.engine) : null;
  const ai = engine ? `${engine}${engine.endsWith("s") ? "'" : "'s"} AI` : "the engine's AI";
  const level = run?.level ? `${Math.round(run.level * 100)}%` : "90%";

  return (
    <>
      <LabHead title="Lab" index />
      <ErrorText error={precons.error} />
      {run ? (
        <>
          <p className="lab-note">
            <b>{rated} precons rated</b> from {run.games.toLocaleString("en-GB")} simulated {run.pod ?? 4}-player games.
            {" "}{run.engine ?? "Unrecorded engine"}, {(run.difficulty ?? "unrecorded").toLowerCase()} AI, {fmtDate(run.analysed_at ?? run.created_at)}.
            {" "}<a href="#how-ratings-work">How these ratings work{run.warnings.length ? `, ${run.warnings.length} analysis ${run.warnings.length === 1 ? "note" : "notes"}` : ""}</a>
          </p>
        </>
      ) : (
        <p className="area-note">No simulation ratings yet.</p>
      )}

      <div className={`lab-filters${moreOpen || filtering ? " open" : ""}`}>
        <input type="search" className="lab-search" value={q} onChange={(e) => set({ q: e.target.value })} placeholder={`Search ${all.length} precons`} aria-label="Search precons by deck, commander or set" />
        <div className="lab-colors" role="group" aria-label="Colours">
          {COLORS.map((k) => (
            <button key={k} type="button" aria-pressed={colors.includes(k)} onClick={() => toggleColor(k)} aria-label={MANA[k].name} title={MANA[k].name}>
              <span className="pip" style={{ background: MANA[k].fill }} />
            </button>
          ))}
        </div>
        {colors && (
          <select className="lab-select" value={mode} onChange={(e) => set({ m: e.target.value === "includes" ? null : e.target.value })} aria-label="How colours match">
            <option value="includes">Includes these colours</option>
            <option value="exactly">Exactly these colours</option>
            <option value="within">Within these colours</option>
          </select>
        )}
        <select className="lab-select" value={yr ?? ""} onChange={(e) => set({ y: e.target.value })} aria-label="Year">
          <option value="">Any year</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select className="lab-select" value={sort} onChange={(e) => set({ s: e.target.value, d: null })} aria-label="Sort by">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              Sort: {s.label.toLowerCase()}
            </option>
          ))}
        </select>
        <button type="button" className="lab-reverse" aria-pressed={desc !== DEFAULT_DESC[sort]} onClick={() => set({ d: desc ? "0" : "1" })}>
          Reverse
        </button>
        <label className="lab-ten">
          <input type="checkbox" checked={tenPlus} onChange={(e) => set({ g: e.target.checked ? "10" : null })} />
          Only {FEW}+ games
        </label>
        {unjudgedAll > 0 && (
          <label className="lab-ten">
            <input type="checkbox" checked={hideUnjudged} onChange={(e) => set({ h: e.target.checked ? "1" : null })} />
            Hide decks the simulation can't judge
          </label>
        )}
        {!filtering && (
          <button type="button" className="phone-only lab-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            {moreOpen ? "Fewer filters" : "Filters"}
          </button>
        )}
      </div>
      <p className="lab-count">
        {rows.length === all.length ? `${all.length} precons` : `${rows.length} of ${all.length} precons`}
        {colors && `, ${mode === "exactly" ? "exactly" : mode === "within" ? "within" : "including"} ${identityName(colors.replace("C", "")).toLowerCase()}`}
        {hidden > 0 && `, without the ${hidden} the simulation can't judge`}
      </p>

      <div className="lab-table-wrap">
        <table className="lab-table">
          <thead>
            <tr>
              <Th k="rank" label={run && run.ranked > 0 ? `Rank of ${run.ranked}` : "Rank"} sort={sort} desc={desc} onSort={sortBy} num />
              <Th k="name" label="Deck" sort={sort} desc={desc} onSort={sortBy} />
              <Th k="p4" label={`Model win rate in 4-player pods, ${level} interval`} sort={sort} desc={desc} onSort={sortBy} className="bar" />
              <Th k="games" label="Games" sort={sort} desc={desc} onSort={sortBy} num />
              <Th k="strength" label="Strength" sort={sort} desc={desc} onSort={sortBy} num />
              <Th k="upgradeability" label="Upgradeability" sort={sort} desc={desc} onSort={sortBy} num />
              <Th k="real" label="Real games, playgroup.gg" sort={sort} desc={desc} onSort={sortBy} className="real" num />
            </tr>
          </thead>
          {mineShown.length > 0 && (
            <tbody className="lab-mine">
              <tr className="lab-mine-head">
                <th colSpan={7} scope="rowgroup">
                  <div className="lab-mine-bar">
                    <span className="lab-mine-title">
                      Your lists <span>Rated in your own paired runs: each run has its own field and model fit, so its rank is out of that run's decks.</span>
                    </span>
                    {!needle && (
                      <button type="button" className="quiet small" aria-expanded={mineOpen} onClick={() => set({ mine: mineOpen ? null : "1" })}>
                        {mineOpen ? "Hide your lists" : `Show your ${mineShown.length} lists`}
                      </button>
                    )}
                  </div>
                </th>
              </tr>
              {(mineOpen || needle) &&
                mineShown.map((m) => (
                  <MineRow key={m.id} m={m} max={max} level={level} />
                ))}
            </tbody>
          )}
          <tbody>
            {judged.map((p) => (
              <TableRow key={p.id} p={p} max={max} level={level} method={run?.confidence?.method} />
            ))}
          </tbody>
          {unjudged.length > 0 && (
            <tbody>
              <tr className="lab-unjudged-head">
                <th colSpan={7} scope="rowgroup">
                  <b>
                    The simulation can't judge {unjudged.length === 1 ? "this deck" : `these ${unjudged.length} decks`}
                  </b>
                  Real games disagree strongly with their simulated numbers, or a known gap in the engine's AI breaks their plan. Their ranks are the simulation's,
                  shown for reference; tap a mark for why.
                </th>
              </tr>
              {unjudged.map((p) => (
                <TableRow key={p.id} p={p} max={max} level={level} method={run?.confidence?.method} />
              ))}
            </tbody>
          )}
        </table>
      </div>
      <ol className="lab-cards" aria-label="Precons">
        {mineShown.length > 0 && !needle && (
          <li className="lab-card-mine-toggle">
            <button type="button" className="quiet small" aria-expanded={mineOpen} onClick={() => set({ mine: mineOpen ? null : "1" })}>
              {mineOpen ? "Hide your lists" : `Show your ${mineShown.length} lists, from your own runs`}
            </button>
          </li>
        )}
        {(mineOpen || needle ? mineShown : []).map((m) => (
          <li key={m.id} className="lab-card is-mine">
            <span className="rank num">{m.rating.rank ?? ""}</span>
            <span className="lab-card-main">
              <span className="lab-card-name">
                <b>{m.name}</b> {m.identity != null && <Pips identity={m.identity} />}
              </span>
              <WinBar value={m.rating.p4_field} lo={m.rating.p4_lo} hi={m.rating.p4_hi} max={max} few={m.rating.games < FEW} label={rateAria(m.name, m.rating, level)} />
              <span className={`lab-card-games${m.rating.games < FEW ? " few" : ""}`}>
                <ConfidenceMark confidence={m.rating.confidence} name={m.name} method={m.run.confidence?.method} />
                {m.rating.games} games{m.rating.games < FEW ? ", too few to trust" : ""}. Your run {m.run.name}, rank of {m.run.ranked}
              </span>
            </span>
            <b className="lab-card-rate num">{pct(m.rating.p4_field, 1)}</b>
          </li>
        ))}
        {[...judged, ...unjudged].map((p, i) => {
          const r = p.rating;
          const isFew = !!r && r.games < FEW;
          const last = i >= judged.length;
          return (
            <Fragment key={p.id}>
              {last && i === judged.length && (
                <li className="lab-card-unjudged-head">
                  <b>The simulation can't judge {unjudged.length === 1 ? "this deck" : `these ${unjudged.length} decks`}</b>
                  Real games disagree strongly, or a known gap in the engine's AI breaks their plan. Their ranks are the simulation's, shown for reference.
                </li>
              )}
              <li className={`lab-card${isFew ? " few" : ""}${last ? " unjudged" : ""}`}>
                <span className="rank num">{r?.rank ?? ""}</span>
                <span className="lab-card-main">
                  <Link to={`/lab/p/${p.id}`} className="lab-card-name">
                    <b>{p.name}</b> <Pips identity={p.color_identity} />
                  </Link>
                  <span className="dim small">Upgradeability: <UpgradeabilitySummary value={p.upgradeability} /></span>
                  <span className="dim small"><SinglesPrice value={p.singles_value} />. Sealed: {usd(p.sealed_price?.usd)}{p.sealed_price ? `, ${p.sealed_price.source}, ${shortDate(p.sealed_price.price_date)}` : ""}</span>
                  {r?.p4_field != null && <WinBar value={r.p4_field} lo={r.p4_lo} hi={r.p4_hi} max={max} few={isFew} label={rateAria(p.name, r, level)} />}
                  <span className={`lab-card-games${isFew ? " few" : ""}`}>
                    <ConfidenceMark confidence={r?.confidence} name={p.name} method={run?.confidence?.method} />
                    {r ? `${r.games} games${isFew ? ", too few to trust" : ""}` : "Not rated"}
                    {p.playgroup?.rank != null ? `. Real games: ${p.playgroup.rank} of ${p.playgroup.of} on playgroup.gg` : ""}
                  </span>
                </span>
                <b className="lab-card-rate num">{r?.p4_field != null ? pct(r.p4_field, 1) : ""}</b>
              </li>
            </Fragment>
          );
        })}
      </ol>
      {rows.length === 0 && <p className="empty">No precon matches. Clear the search or a colour.</p>}

      {run && (
        <section className="lab-about" id="how-ratings-work" aria-labelledby="how-ratings-work-title">
          <h2 id="how-ratings-work-title">How these ratings work</h2>
          <p className="lab-label">{caveat(run.engine)}</p>
          <div className="lab-about-grid">
            <div>
              <h3>Reading the table</h3>
              <p>
                Every precon played whole games against other precons, with {ai} in every seat, in 4-player pods. The <b>model win rate</b> is a model of
                finishing order ({run.model ?? "Plackett-Luce"})'s chance that the deck wins a pod of three random precons. The amber line is 25%, an even share.
              </p>
              <p>
                The bar is its {level} interval, so a wide bar means few games. Precons with fewer than {FEW} games are faded, with "few games" in amber.
                {few > 0 ? ` ${few} ${few === 1 ? "precon is" : "precons are"} under ${FEW} games, so the order may change.` : ""}
              </p>
              <p>
                <b>Strength</b> is the same model's rating: 1 is an average precon, 2 finishes ahead about twice as often. Each precon's page has its list, raw wins, rank ranges,
                matchups and "Make this a Yama deck".
              </p>
              {skipped > 0 && <p>Ranks are among all {run.ranked} decks in the run, and {skipped} of those aren't in this list, so some ranks are skipped.</p>}
              {mineShown.length > 0 && (
                <p>
                  Your lists come from your own runs with {mineShown.map((m) => m.rating.games).reduce((a, b) => Math.min(a, b))} or more games each, so their
                  intervals are tighter.
                </p>
              )}
            </div>
            {(run.confidence || unjudgedAll > 0 || doubtfulAll > 0) && (
              <div>
                <h3>Sim unreliable and sim doubtful</h3>
                <p>
                  The analysis compares each precon's simulated win rate with real games on playgroup.gg, counts the cards the engine only partly implements,
                  and checks a hand-kept list of known gaps in the engine's AI (a deck whose plan needs plays the AI never makes).
                </p>
                <p>
                  <b>Unreliable</b> means real games disagree strongly or a known gap breaks the deck's plan{unjudgedAll > 0 ? `: ${unjudgedAll} ${unjudgedAll === 1 ? "precon" : "precons"} here, ${hideUnjudged ? "hidden" : simSort ? "listed last" : "marked in the table"}` : ""}.
                  {" "}<b>Doubtful</b> is a lesser warning{doubtfulAll > 0 ? `: ${doubtfulAll} ${doubtfulAll === 1 ? "precon" : "precons"}` : ""}.{unjudgedAll + doubtfulAll > 0 ? " Tap a mark for why." : ""}
                </p>
                <p>
                  No mark only means no problem is known: the simulation as a whole still follows real games only loosely.
                  {run.confidence?.reference_run ? ` Decks without real games of their own are judged by their precon in run ${run.confidence.reference_run}.` : ""}
                </p>
                {run.confidence?.method && (
                  <Details label="Method">
                    <p>{run.confidence.method}</p>
                  </Details>
                )}
              </div>
            )}
            {real && (
              <div>
                <h3>Real games</h3>
                <p>
                  playgroup.gg's precon tier list ({real.method}), fetched {fmtDate(real.fetched)}. It counts people's games, not simulations, and only covers
                  precons with enough logged games.
                </p>
              </div>
            )}
            <div>
              <h3>Upgradeability</h3>
              <p>
                Grades use published guides, checked card examples and the stated commander’s restrictions. Alternate commanders and on-theme swaps have
                separate assessments and lists. Sorting uses the highest supported in-box upgrade grade; the table names those commanders and shows how many
                included options remain ungraded. Replacing the strategy is a separate deck build.
              </p>
            </div>
            <div>
              <h3>This run</h3>
              <dl className="lab-about-run">
                <dt>Run</dt>
                <dd>{run.name}</dd>
                <dt>Engine</dt>
                <dd>{run.engine ?? "Unrecorded"}</dd>
                <dt>AI</dt>
                <dd>{run.difficulty ?? "Unrecorded"}</dd>
                <dt>Games</dt>
                <dd>{run.games.toLocaleString("en-GB")}, {run.pod ?? 4}-player pods</dd>
                <dt>Analysed</dt>
                <dd>{fmtDate(run.analysed_at ?? run.created_at)}</dd>
                {run.card_data && (
                  <>
                    <dt>Card data</dt>
                    <dd>{run.card_data.split(", ").map(shortHash).join(", ")}</dd>
                  </>
                )}
              </dl>
              {run.warnings.length > 0 && (
                <>
                  <h4>From the analysis</h4>
                  <ul>
                    {run.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </section>
      )}
      {!run && mineShown.length > 0 && (
        <p className="lab-note">
          The amber line is 25%, an even share at a 4-player table. Your lists come from your own runs, each with its own field and model fit.
        </p>
      )}
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

const rateAria = (name: string, r: Rating, level: string) =>
  `${name}: model win rate ${pct(r.p4_field, 1)} of 4-player pods${r.p4_lo != null && r.p4_hi != null ? `, ${level} interval ${pctRange(r.p4_lo, r.p4_hi)}` : ""}; a quarter is an even share`;

function TableRow({ p, max, level, method }: { p: PreconItem; max: number; level: string; method?: string | null }) {
  const r = p.rating;
  const pg = p.playgroup;
  const isFew = !!r && r.games < FEW;
  const cls = [isFew ? "few" : "", cantJudge(r?.confidence) ? "unjudged" : ""].filter(Boolean).join(" ");
  return (
    <tr className={cls || undefined}>
      <td className="num rank" title={r?.rank_lo != null ? `Could be anywhere from ${r.rank_lo} to ${r.rank_hi}` : undefined}>
        {r?.rank ?? ""}
      </td>
      <td className="deck">
        <span className={`lab-deck-name${confidenceMark(r?.confidence) ? " has-mark" : ""}`}>
          <Link to={`/lab/p/${p.id}`}>{p.name}</Link> <Pips identity={p.color_identity} />
          <ConfidenceMark confidence={r?.confidence} name={p.name} method={method} />
        </span>
        <span className="sub">
          {p.commanders.join(" and ")}. {p.set_name ?? p.set_code}
          {p.set_name ? ` (${p.set_code})` : ""}, {year(p.released) ?? "no date"}
        </span>
        <span className="sub"><SinglesPrice value={p.singles_value} />. Sealed: {usd(p.sealed_price?.usd)}{p.sealed_price ? `, ${p.sealed_price.source}, ${shortDate(p.sealed_price.price_date)}` : ""}</span>
      </td>
      <td className="bar">
        {r?.p4_field != null ? (
          <span className="lab-rate">
            <b className="num">{pct(r.p4_field, 1)}</b>
            <WinBar value={r.p4_field} lo={r.p4_lo} hi={r.p4_hi} max={max} few={isFew} label={rateAria(p.name, r, level)} />
          </span>
        ) : (
          <span className="dim small">{r ? "no data" : "not rated"}</span>
        )}
      </td>
      <td className={`num games${isFew ? " few" : ""}`}>{r ? `${r.games}${isFew ? ", few games" : ""}` : ""}</td>
      <td className="num strength">
        {r?.strength != null ? (
          <>
            {strengthText(r.strength)}
            {r.lo != null && r.hi != null && <span className="sub">{strengthText(r.lo)} to {strengthText(r.hi)}</span>}
          </>
        ) : (
          <span className="dim small">no data</span>
        )}
      </td>
      <td className="num upg"><UpgradeabilitySummary value={p.upgradeability} /></td>
      <td className="real num">
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
          <span className="dim small">No data</span>
        )}
      </td>
    </tr>
  );
}

function MineRow({ m, max, level }: { m: MyList; max: number; level: string }) {
  const r = m.rating;
  const isFew = r.games < FEW;
  return (
    <tr className={`is-mine${isFew ? " few" : ""}`}>
      <td className="num rank" title={`Rank in your run ${m.run.name}, out of its ${m.run.ranked} decks`}>
        {r.rank ?? ""}
      </td>
      <td className="deck">
        <span className={`lab-deck-name${confidenceMark(r.confidence) ? " has-mark" : ""}`}>
          <b>{m.name}</b> {m.identity != null && <Pips identity={m.identity} />}
          <ConfidenceMark confidence={r.confidence} name={m.name} method={m.run.confidence?.method} />
        </span>
        <span className="sub">
          {m.commanders.length ? `${m.commanders.join(" and ")}. ` : ""}Your run {m.run.name}, {fmtDate(m.run.analysed_at ?? m.run.created_at)}; rank of {m.run.ranked}
        </span>
      </td>
      <td className="bar">
        {r.p4_field != null ? (
          <span className="lab-rate">
            <b className="num">{pct(r.p4_field, 1)}</b>
            <WinBar value={r.p4_field} lo={r.p4_lo} hi={r.p4_hi} max={max} few={isFew} label={rateAria(m.name, r, level)} />
          </span>
        ) : (
          <span className="dim small">no data</span>
        )}
      </td>
      <td className={`num games${isFew ? " few" : ""}`}>{`${r.games}${isFew ? ", few games" : ""}`}</td>
      <td className="num strength">
        {r.strength != null ? (
          <>
            {strengthText(r.strength)}
            {r.lo != null && r.hi != null && <span className="sub">{strengthText(r.lo)} to {strengthText(r.hi)}</span>}
          </>
        ) : (
          <span className="dim small">no data</span>
        )}
      </td>
      <td className="num upg"><span className="dim small">Not assessed for this list</span></td>
      <td className="real num">
        <span className="dim small">Your list</span>
      </td>
    </tr>
  );
}
