import { useQuery } from "@tanstack/react-query";
import { identityName, fmtDateTime } from "@yama/core";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { ArtPanel as SharedArtPanel, artCredits } from "../components/ArtPanel";
import { queryFailure, RefreshFailed } from "../components/QueryError";
import { Details, ErrorText, Pips, Loading } from "../components/ui";
import type { ExperimentDetail, TableDeck, TableGame, TableView, Tables } from "./api";
import { enginesOf } from "./engines";
import { LabHead } from "./LabLayout";
import { pct, pctRange, placeText } from "./logic";
import { ArtPanel } from "./parts";
import { FEW_GAMES, deckRecord, endText, filterTables, labeller, placeBadge, placeOf, rivalText, rivals, seatOf, seatText, turnOrder, wilson90, type TableFilter } from "./tables";
import "./tables.css";

/** `?engine=forge` picks a "both" run's Forge half; anything else is the run's first engine. */
function useEngine(e: ExperimentDetail | undefined): "phase" | "forge" {
  const [params] = useSearchParams();
  if (params.get("engine") === "forge") return "forge";
  if (params.get("engine") === "phase") return "phase";
  return e && enginesOf(e).mode === "forge" ? "forge" : "phase";
}

function engineQuery(e: ExperimentDetail, engine: "phase" | "forge"): string {
  return enginesOf(e).mode === "both" ? `?engine=${engine}` : "";
}

export function deckPath(run: string, deck: string, engine?: string, vs?: string): string {
  const q = new URLSearchParams();
  if (engine) q.set("engine", engine);
  if (vs) q.set("vs", vs);
  const s = q.toString();
  return `/lab/runs/${run}/decks/${encodeURIComponent(deck)}${s ? `?${s}` : ""}`;
}

export function tablePath(run: string, table: number, engine?: string): string {
  return `/lab/runs/${run}/tables/${table}${engine ? `?engine=${engine}` : ""}`;
}

const LIVE = new Set(["queued", "running"]);

/** The run, polled every 5 s while it plays and after a cancel until its last games are in, as the run page does. */
function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ["lab", "experiment", id],
    queryFn: ({ signal }) => api<ExperimentDetail>(`/api/lab/experiments/${id}`, { signal }),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      return LIVE.has(d.status) || (d.status === "cancelled" && d.summary && !d.summary.verdict.final) ? 5000 : false;
    },
  });
}

/** The tables, fetched again whenever the run's game count moves. */
function useTables(id: string | undefined, engine: string, filter: { entrant?: string; table?: number }, done: number | undefined, enabled: boolean) {
  const q = new URLSearchParams({ engine });
  if (filter.entrant) q.set("entrant", filter.entrant);
  if (filter.table) q.set("table", String(filter.table));
  return useQuery({
    queryKey: ["lab", "tables", id, q.toString(), done ?? 0],
    queryFn: ({ signal }) => api<Tables>(`/api/lab/experiments/${id}/tables?${q}`, { signal }),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Players at each of the run's tables (4, or 2 for a 1v1 head to head). */
function podOf(e: ExperimentDetail | undefined): number {
  return e?.label.pod ?? 4;
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six"];
const count = (n: number) => COUNT[n] ?? String(n);

/** A small commander-art tile for a deck at a table; the page credits the artists once. */
function DeckTile({ deck, to, mark, children }: { deck: TableDeck | undefined; to?: string; mark?: boolean; children?: ReactNode }) {
  const body = (
    <SharedArtPanel as="span" className={`rt-tile${mark ? " rt-mark" : ""}`} art={deck?.art?.url} artist={deck?.art?.artist} wash="bottom" credit={false}>
      <span className="rt-tile-name">{deck?.label ?? "Unknown deck"}</span>
      {children}
    </SharedArtPanel>
  );
  return to ? (
    <Link to={to} className="rt-tile-link">
      {body}
    </Link>
  ) : (
    body
  );
}

function Back({ e }: { e: ExperimentDetail }) {
  return <LabHead slim back={{ to: `/lab/runs/${e.id}`, label: "Back to the run" }} />;
}

function Wait({ id, error }: { id?: string; error: unknown }) {
  if (error)
    return (
      <>
        <LabHead slim back={{ to: id ? `/lab/runs/${id}` : "/lab/runs", label: "Back to the run" }} />
        <ErrorText error={error} />
      </>
    );
  return <Loading />;
}

/** One deck's games in a head-to-head or tournament run: its record, who it met, every table. */
export function RunDeckPage() {
  const { id, deck = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const run = useRun(id);
  const e = run.data;
  const engine = useEngine(e);
  const tables = useTables(id, engine, { entrant: deck }, e?.progress.done, !!e);
  const [filter, setFilter] = useState<TableFilter>("all");
  const [rivalSearch, setRivalSearch] = useState("");
  const vs = params.get("vs");
  const data = tables.data;
  const label = useMemo(() => labeller(data?.decks ?? []), [data]);
  const all = data?.tables ?? [];
  const pod = podOf(e);
  const record = useMemo(() => deckRecord(all, deck, pod), [all, deck, pod]);
  const met = useMemo(() => rivals(all, deck, label), [all, deck, label]);
  // A failed refresh of a run already on screen keeps the page (unless the run is gone).
  if (!e || queryFailure(run) === "page") return <Wait id={id} error={run.error} />;
  const me = data?.decks.find((d) => d.id === deck);
  const display = me?.entrant != null ? e.entrants?.[me.entrant] : undefined;
  const shown = filterTables(all, deck, filter, vs);
  const decks = new Map((data?.decks ?? []).map((d) => [d.id, d]));
  const eq = engineQuery(e, engine);
  const rivalRows = met.filter((r) => !rivalSearch || label(r.id).toLowerCase().includes(rivalSearch.toLowerCase()));
  const setVs = (v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set("vs", v);
    else next.delete("vs");
    setParams(next, { replace: true });
  };
  return (
    <>
      <Back e={e} />
      <RefreshFailed query={run} what="this run" />
      <ArtPanel art={me?.art ?? display?.art}>
        <span className="dim small">
          <Link to={`/lab/runs/${e.id}`}>{e.name}</Link>
          {enginesOf(e).mode === "both" ? (engine === "forge" ? ", on Forge" : ", on phase") : ""}
        </span>
        <h1 style={{ fontSize: "var(--t-xl)" }}>{me?.label ?? deck}</h1>
        {(me?.commanders.length ?? 0) > 0 && (
          <span className="dim small">
            {me!.commanders.join(" and ")}
            {display ? (
              <>
                {" "}
                <Pips identity={display.color_identity} /> {identityName(display.color_identity)}
              </>
            ) : null}
          </span>
        )}
      </ArtPanel>
      <ErrorText error={tables.error} />
      {tables.isPending && <Loading>Loading the games…</Loading>}
      {data && (
        <>
          <section className="rt-stats" aria-label="Record">
            <div>
              <span className="rt-big">{record.scored ? pct(record.wins / record.scored) : "–"}</span>
              <span className="small dim">
                won, {record.wins} of {record.scored} scored games
                {record.scored ? ` (90% interval ${pctRange(...wilson90(record.wins, record.scored))})` : ""}
              </span>
            </div>
            <div>
              <span className="rt-big">{record.avgPlace != null ? record.avgPlace.toFixed(2) : "–"}</span>
              <span className="small dim">average place, 1 is best</span>
            </div>
            <div>
              <span className="rt-big">{all.length}</span>
              <span className="small dim">
                {all.length === 1 ? "table" : "tables"}, {record.played} games played
              </span>
            </div>
            {record.scored > 0 && (
              <div className="rt-places" aria-label="Finishing places">
                {record.places.map((n, i) => (
                  <span key={i} className="rt-place-row">
                    <span className="rt-place-name">{placeText(i + 1)}</span>
                    <span className="rt-place-bar" aria-hidden="true">
                      <span style={{ width: `${(n / record.scored) * 100}%` }} className={i === 0 ? "first" : ""} />
                    </span>
                    <span className="num small">{n}</span>
                  </span>
                ))}
                {record.tied.some((n) => n > 0) && (
                  <span className="small dim">
                    Shared places, counted at the place the tie started:{" "}
                    {record.tied
                      .map((n, i) => (n ? `${n} at ${placeText(i + 1)}` : ""))
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
              </div>
            )}
          </section>

          <section>
            <h2>Who it sat with</h2>
            <p className="small dim">
              Finish order between the two decks in the games they shared, whoever won. Under {FEW_GAMES} untied games a pair says very little: one table is {podOf(e)} games.
            </p>
            {met.length > 8 && (
              <label className="small">
                Find a deck
                <input value={rivalSearch} onChange={(ev) => setRivalSearch(ev.target.value)} />
              </label>
            )}
            <ul className="rt-rivals">
              {rivalRows.slice(0, 60).map((r) => (
                <li key={r.id}>
                  <button type="button" className={`rt-rival${vs === r.id ? " on" : ""}`} aria-pressed={vs === r.id} onClick={() => setVs(vs === r.id ? null : r.id)}>
                    <SharedArtPanel as="span" className="rt-thumb" art={decks.get(r.id)?.art?.url} wash="bottom" credit={false} />
                    <span className="rt-rival-text">
                      <b>{label(r.id)}</b>
                      <span className="small dim">
                        {rivalText(r, "them")}
                        {r.ahead + r.behind < FEW_GAMES ? ", too few to tell" : ""}
                      </span>
                    </span>
                    <span className="rt-score num" aria-hidden="true">
                      {r.ahead}–{r.behind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {rivalRows.length > 60 && <p className="small dim">{rivalRows.length - 60} more; search to find one.</p>}
          </section>

          <section>
            <h2>Tables</h2>
            <div className="lab-chips" role="group" aria-label="Which tables">
              {(
                [
                  ["all", "Every table"],
                  ["won", "Won a game"],
                  ["lost", "Won none"],
                ] as const
              ).map(([k, t]) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {t}
                </button>
              ))}
              {vs && (
                <button type="button" aria-pressed onClick={() => setVs(null)}>
                  With {label(vs)}, clear
                </button>
              )}
            </div>
            <p className="small dim">
              {shown.length} of {all.length} {all.length === 1 ? "table" : "tables"}. Each table is the same {count(podOf(e))} decks for {podOf(e)} games, a seat apart, so every deck goes first once.
            </p>
            <ul className="rt-tables">
              {shown.map((t) => (
                <li key={t.table}>
                  <TableCard t={t} deck={deck} decks={decks} to={tablePath(e.id, t.table, eq ? engine : undefined)} label={label} />
                </li>
              ))}
            </ul>
          </section>
          <p className="art-credits small dim">{artCredits(data.decks.map((d) => d.art?.artist))}</p>
        </>
      )}
    </>
  );
}

/** A table in a deck's list: its commanders, then that deck's place in each game. */
function TableCard({ t, deck, decks, to, label }: { t: TableView; deck: string; decks: Map<string, TableDeck>; to: string; label: (id: string) => string }) {
  const others = t.decks.filter((d) => d !== deck);
  return (
    <Link to={to} className="rt-table-card">
      <span className="rt-table-art" aria-hidden="true">
        {[deck, ...others].map((d) => (
          <SharedArtPanel key={d} as="span" className={`rt-thumb${d === deck ? " rt-mark" : ""}`} art={decks.get(d)?.art?.url} wash="bottom" credit={false} />
        ))}
      </span>
      <span className="rt-table-text">
        <b>Table {t.table}</b>
        <span className="small dim">With {others.map(label).join(", ")}</span>
      </span>
      <span className="rt-results" aria-label="Its place in each game">
        {t.games.map((g) => {
          const s = seatOf(g, deck);
          const won = g.played && g.end === "win" && g.winner === s;
          const text = !g.played ? "Not yet" : g.scored ? placeBadge(placeOf(g, s)) : "Unscored";
          return (
            <span key={g.game} className={`rt-pill${won ? " won" : ""}${!g.scored ? " faint" : ""}`}>
              {text}
            </span>
          );
        })}
      </span>
    </Link>
  );
}

/** One table: its decks, how each did there, and every game seat by seat in turn order. */
export function RunTablePage() {
  const { id, table = "" } = useParams();
  const run = useRun(id);
  const e = run.data;
  const engine = useEngine(e);
  const n = Number(table);
  const tables = useTables(id, engine, { table: n }, e?.progress.done, !!e && Number.isInteger(n) && n > 0);
  if (!e || queryFailure(run) === "page") return <Wait id={id} error={run.error} />;
  const data = tables.data;
  const t = data?.tables[0];
  const decks = new Map((data?.decks ?? []).map((d) => [d.id, d]));
  const label = labeller(data?.decks ?? []);
  const eq = engineQuery(e, engine) ? engine : undefined;
  return (
    <>
      <Back e={e} />
      <RefreshFailed query={run} what="this run" />
      <header className="rt-head">
        <span className="dim small">
          <Link to={`/lab/runs/${e.id}`}>{e.name}</Link>
          {enginesOf(e).mode === "both" ? (engine === "forge" ? ", on Forge" : ", on phase") : ""}
        </span>
        <h1>Table {table}</h1>
      </header>
      <ErrorText error={tables.error} />
      {tables.isPending && <Loading>Loading the table…</Loading>}
      {data && !t && <p className="dim">This run has no table {table}.</p>}
      {t && (
        <>
          <section className="rt-seats" aria-label="The decks">
            {t.decks.map((d) => {
              const r = deckRecord([t], d, t.decks.length);
              return (
                <DeckTile key={d} deck={decks.get(d)} to={decks.get(d)?.entrant != null ? deckPath(e.id, d, eq) : undefined}>
                  <span className="rt-tile-sub">{decks.get(d)?.commanders.join(" and ")}</span>
                  <span className="rt-tile-sub">
                    {r.scored ? `Won ${r.wins} of ${r.scored}${r.avgPlace != null ? `, average place ${r.avgPlace.toFixed(2)}` : ""}` : "No scored games"}
                  </span>
                </DeckTile>
              );
            })}
          </section>
          <p className="small dim">
            The same {count(t.decks.length)} decks played {t.games.length} games, each starting from a new shuffle, rotating a seat each time so every deck went first once. Turns count every
            player's turn, so a round of {count(t.decks.length)} players is {count(t.decks.length)} turns.
          </p>
          <ol className="rt-games">
            {t.games.map((g, i) => (
              <li key={g.game}>
                <GameCard g={g} n={i + 1} of={t.games.length} decks={decks} label={label} />
              </li>
            ))}
          </ol>
          <p className="art-credits small dim">{artCredits(data!.decks.map((d) => d.art?.artist))}</p>
        </>
      )}
    </>
  );
}

function GameCard({ g, n, of, decks, label }: { g: TableGame; n: number; of: number; decks: Map<string, TableDeck>; label: (id: string) => string }) {
  const order = turnOrder(g);
  const ranked = g.scored ? [...order].sort((a, b) => (g.places[a] ?? 99) - (g.places[b] ?? 99)) : order;
  return (
    <article className={`rt-game${g.scored ? "" : " unscored"}`}>
      <header>
        <h3>
          Game {n} of {of}
        </h3>
        <p className={g.end === "win" ? "" : "dim"}>{endText(g, label)}</p>
      </header>
      {g.played ? (
        <ol className="rt-finish" aria-label={g.scored ? "Finishing order" : "Seats in turn order"}>
          {ranked.map((s) => {
            const d = g.seats[s] ?? "";
            const won = g.end === "win" && g.winner === s;
            return (
              <li key={s} className={won ? "won" : ""}>
                <span className="rt-place">{placeBadge(placeOf(g, s))}</span>
                <SharedArtPanel as="span" className="rt-thumb" art={decks.get(d)?.art?.url} wash="bottom" credit={false} />
                <span className="rt-finish-name">
                  <b>{label(d)}</b>
                  <span className="small">
                    <span className="dim">Went {placeText(order.indexOf(s) + 1)}</span>
                    {seatText(g, s) ? <span className="rt-finish-how">, {seatText(g, s).replace(/^./, (c) => c.toLowerCase())}</span> : null}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="dim small">Waiting to be played.</p>
      )}
      {g.played && (
        <Details label="Game details">
          <p className="small">
            {g.turns} turns, {Math.round(g.seconds)} s of the engine's CPU time
            {g.finished_at ? `, finished ${fmtDateTime(g.finished_at)}` : ""}.
            {g.error ? ` ${g.error}.` : ""}
          </p>
          <p className="small dim">
            Game id <code>{g.game}</code>. It replays move for move from its schedule line on the same engine build (the yama MCP's lab_games gives the line).
          </p>
        </Details>
      )}
    </article>
  );
}
