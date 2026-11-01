import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityName, listText } from "@yama/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { usePower } from "../auth";
import { api } from "../api";
import { ErrorText, Pips } from "../components/ui";
import { engineLine, enginesOf, halfOf } from "./engines";
import type { HalfEngine } from "./logic";
import type { ComparePrefill, ExperimentDetail, ExperimentItem, ExperimentMode, ExperimentStatus, FieldChoice, PodView, Summary, TryPrefill } from "./api";
import { ConfidenceLine } from "./confidence";
import {
  baseConfidence,
  baseConfidenceSentence,
  caveat,
  deltaBound,
  durationText,
  fmtDate,
  gameText,
  gamesToSettle,
  hasResults,
  moreOften,
  pct,
  pctRange,
  points,
  pointsRange,
  podCountText,
  pointsWord,
  rateCeiling,
  settleText,
  shortHash,
  simDetails,
  simLabel,
  unscoredText,
  verdictText,
} from "./logic";
import { AskClaude } from "../advisor/AskClaude";
import { ArtPanel, IntervalChart, SimLine, StatusTag } from "./parts";
import { LabHead } from "./LabLayout";
import { usePrecons } from "./Precons";
import { usePace } from "./pickers";
import { gameChoices } from "./logic";

const LIVE = new Set(["queued", "running"]);

/** The label line for an experiment's numbers: the games played so far, out of those planned. */
export function experimentLabel(e: ExperimentItem): string {
  const l = e.label;
  return simLabel({
    engine: l.engine,
    difficulty: l.difficulty,
    games: e.progress.done,
    planned: l.games,
    pod: l.pod,
    date: l.finished_at ?? l.started_at ?? l.created_at,
  });
}

/** The field's label mid-sentence: lower-cased, unless it starts with a deck's name (a pick that sits in every pod). */
function fieldPhrase(e: ExperimentItem): string | undefined {
  const f = e.field;
  if (!f) return undefined;
  return f.every_pod ? f.label : f.label.replace(/^./, (c) => c.toLowerCase());
}

/** A run's mode; runs from before the modes are changes. */
export function modeOf(e: ExperimentItem): ExperimentMode {
  return e.mode ?? "change";
}

const MODE_LINE: Record<ExperimentMode, string> = {
  change: "A list against a changed copy of it, on the same pods",
  compare: "Two decks against the same opponents, on the same pods",
  solo: "One list as it is, against the field",
  versus: "Decks head to head, every deck in every game",
  tournament: "Tournament, balanced randomized four-player pods across one shared field",
};

/** "Run again with more games": the same lists, opponents and AI level, a new seed. */
function Again({ e }: { e: ExperimentDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pace = usePace();
  const choices = gameChoices(pace.data);
  // A "both" run's label counts both engines' games; "again" asks for games per engine.
  const perEngine = modeOf(e) === "tournament" ? (e.games_per_deck ?? 100) : enginesOf(e).mode === "both" ? e.label.games / 2 : e.label.games;
  const bigger = choices.filter((g) => g > perEngine);
  const [games, setGames] = useState<number | null>(null);
  const pick = games ?? bigger[0] ?? choices[choices.length - 1] ?? perEngine;
  const again = useMutation({
    mutationFn: () => api<ExperimentDetail>(`/api/lab/experiments/${e.id}/again`, { method: "POST", json: { games: pick, op_id: `${e.id}-again-${pick}-${Date.now()}` } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ["lab", "experiments"] });
      navigate(`/lab/runs/${d.id}`);
    },
  });
  return (
    <div className="lab-again">
      <span className="lab-games-label">Run again</span>
      <div className="segmented" role="radiogroup" aria-label="Games">
        {choices.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={pick === g} aria-pressed={pick === g} onClick={() => setGames(g)}>
            {g}
          </button>
        ))}
      </div>
      <button className="primary" onClick={() => again.mutate()} disabled={again.isPending}>
        {again.isPending ? "Starting…" : pick > perEngine ? `Run again with ${pick} games` : `Run again (${pick} games)`}
      </button>
      <span className="lab-note">
        Same lists, opponents, engines and AI, new shuffles. More games give a tighter answer. {modeOf(e) === "tournament" ? "The count is appearances per deck, per engine." : ""}{enginesOf(e).mode === "both" ? ` ${pick} ${modeOf(e) === "tournament" ? "appearances per deck" : "games"} on each engine.` : ""}
      </span>
      <ErrorText error={again.error} />
    </div>
  );
}

/** "Add games": more pods for this run, counted together with the ones played. */
function MoreGames({ e }: { e: ExperimentDetail }) {
  const qc = useQueryClient();
  const pace = usePace();
  const choices = gameChoices(pace.data);
  const both = enginesOf(e).mode === "both";
  const halves = (both ? [e.summary, e.summary_forge] : [e.summary]).filter((s): s is Summary => s != null);
  const needs = halves.map((s) => gamesToSettle(s, choices)).filter((n): n is NonNullable<typeof n> => n != null);
  const need = needs.sort((x, y) => y.games - x.games)[0] ?? null;
  const unclear = halves.some((s) => s.verdict.kind === "unclear");
  const [games, setGames] = useState<number | null>(null);
  const pick = games ?? need?.pick ?? choices[0] ?? 100;
  const seenPods = e.summary?.pods ?? (modeOf(e) === "solo" ? e.label.games : e.label.games / 2);
  const more = useMutation({
    mutationFn: () => api<ExperimentDetail>(`/api/lab/experiments/${e.id}/more`, { method: "POST", json: { games: pick, seen_pods: seenPods } }),
    onSuccess: (d) => {
      qc.setQueryData(["lab", "experiment", e.id], d);
      void qc.invalidateQueries({ queryKey: ["lab", "experiments"] });
    },
  });
  const each = both ? " on each engine" : "";
  return (
    <section className="lab-more">
      <h2>{unclear ? "Get a clearer answer" : "Add games"}</h2>
      <p className="small" style={{ marginTop: 0 }}>
        {need
          ? `About ${need.games} more games${each} would get there, at the rate pods have been left out so far.`
          : unclear
            ? "More games give a tighter answer."
            : "More games tighten the interval further."}{" "}
        New games play more pods on the same lists, opponents and AI with new shuffles, and count together with the ones above.
      </p>
      <div className="lab-again">
        <span className="lab-games-label">Add</span>
        <div className="segmented" role="radiogroup" aria-label="Games to add">
          {choices.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={pick === g} aria-pressed={pick === g} onClick={() => setGames(g)}>
              {g}
            </button>
          ))}
        </div>
        <button className="primary" onClick={() => more.mutate()} disabled={more.isPending}>
          {more.isPending ? "Adding…" : `Add ${pick} games${each}`}
        </button>
      </div>
      <ErrorText error={more.error} />
    </section>
  );
}

/** What "Edit and run again" brings back to the Compare page. */
function comparePrefill(e: ExperimentDetail): ComparePrefill {
  const lists = ["versus", "tournament"].includes(modeOf(e)) ? (e.lists.entrants ?? []) : [e.lists.base, ...(e.lists.variant ? [e.lists.variant] : [])];
  const decks = lists.map((l) => {
    const src = l.source as { kind?: string; id?: string };
    if (src.kind === "precon" && src.id) return { kind: "precon" as const, id: src.id };
    if (src.kind === "deck" && src.id) return { kind: "deck" as const, id: src.id };
    return { kind: "list" as const, text: listText(l.cards.map((c) => ({ qty: c.qty, name: c.name, board: c.commander ? "commander" : "main" }))), label: l.label };
  });
  return {
    mode: modeOf(e) === "tournament" ? "tournament" : modeOf(e) === "versus" ? "versus" : "compare",
    decks,
    pod: e.label.pod,
    field: fieldFrom(e),
    games: modeOf(e) === "tournament" ? (e.games_per_deck ?? 100) : enginesOf(e).mode === "both" ? e.label.games / 2 : e.label.games,
    difficulty: phaseDifficulty(e),
    engines: enginesOf(e),
  };
}

function fieldFrom(e: ExperimentItem): FieldChoice | undefined {
  const f = e.field;
  return !f
    ? undefined
    : f.kind === "precons_top"
      ? { kind: "precons_top", n: f.n ?? 20 }
      : f.kind === "precons_near"
        ? { kind: "precons_near", n: f.n ?? 20, ids: f.ids }
        : f.kind === "precons_all"
          ? { kind: "precons_all" }
          : f.kind === "my_decks"
            ? { kind: "my_decks", ids: f.ids }
            : undefined;
}

export function RunPage() {
  const power = usePower();
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const exp = useQuery({
    queryKey: ["lab", "experiment", id],
    queryFn: () => api<ExperimentDetail>(`/api/lab/experiments/${id}`),
    // Every 5 s while it plays, and after a cancel until the games that were playing are in.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      return LIVE.has(d.status) || (d.status === "cancelled" && d.summary && !d.summary.verdict.final) ? 5000 : false;
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<ExperimentDetail>(`/api/lab/experiments/${id}/cancel`, { method: "POST" }),
    onSuccess: (d) => {
      qc.setQueryData(["lab", "experiment", id], d);
      void qc.invalidateQueries({ queryKey: ["lab", "experiments"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/lab/experiments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lab", "experiments"] });
      navigate("/lab/runs");
    },
  });

  if (exp.error) {
    return (
      <>
        <LabHead slim back={{ to: "/lab/runs", label: "Back to my runs" }} />
        <ErrorText error={exp.error} />
      </>
    );
  }
  const e = exp.data;
  if (!e) return <p className="dim">Loading…</p>;
  const live = LIVE.has(e.status);
  const s = e.summary;
  const scored = s && hasResults(s) ? s : null;

  return (
    <>
      <LabHead slim back={{ to: "/lab/runs", label: "Back to my runs" }} />
      <ArtPanel art={e.base?.art}>
        <span>
          <StatusTag status={e.status} />
        </span>
        <h1 style={{ fontSize: "var(--t-xl)" }}>{e.name}</h1>
        <span className="dim small">{MODE_LINE[modeOf(e)]}</span>
        <span className="dim small">{engineLine(e)}</span>
        {e.base && !["versus", "tournament"].includes(modeOf(e)) && modeOf(e) !== "compare" && (
          <span className="dim small">
            {e.base.commanders.join(" and ")} <Pips identity={e.base.color_identity} /> {identityName(e.base.color_identity)}
          </span>
        )}
      </ArtPanel>

      {!live && (
        <div className="row" style={{ marginBottom: "1rem" }}>
          <AskClaude context={{ kind: "experiment", ref: e.id }} about={`the run "${e.name}"`} />
        </div>
      )}
      {live && <Progress e={e} />}
      {e.status === "failed" && <p className="error">This run failed: {e.error ?? "no reason recorded"}.</p>}
      {e.status === "cancelled" && (
        <p className="dim">
          Cancelled after {e.progress.done} of {e.progress.total} games{s && !s.verdict.final ? "; games that were playing still count when they finish" : ""}.
        </p>
      )}

      {enginesOf(e).mode === "both" ? (
        <BothResults e={e} live={live} />
      ) : scored ? (
        <ModeResults e={e} s={scored} />
      ) : (
        !live && (
          <p className="dim">
            {s && s.unscored.total > 0
              ? `None of the games that finished was scored (${s.unscored.total} ran out of time, crashed or hit an error), so there are no results.`
              : "No games finished, so there are no results."}
          </p>
        )
      )}

      {power && e.status === "done" && !["versus", "tournament"].includes(modeOf(e)) && <MoreGames e={e} />}

      <section>
        <h2>{modeOf(e) === "change" ? "The change" : modeOf(e) === "solo" ? "The list" : "The decks"}</h2>
        <Change e={e} />
      </section>

      {enginesOf(e).mode === "both" ? (
        <>
          {halfOf(e, "phase").progress.done > 0 && <Pods id={e.id} done={halfOf(e, "phase").progress.done} status={e.status} mode={modeOf(e)} engine="phase" />}
          {halfOf(e, "forge").progress.done > 0 && <Pods id={e.id} done={halfOf(e, "forge").progress.done} status={e.status} mode={modeOf(e)} engine="forge" />}
        </>
      ) : (
        e.progress.done > 0 && <Pods id={e.id} done={e.progress.done} status={e.status} mode={modeOf(e)} />
      )}

      <section>
        {!live && power && <Again e={e} />}
        <div className="row">
          {live && (
            <button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel the rest
            </button>
          )}
          {!power ? null : modeOf(e) === "change" || modeOf(e) === "solo" ? (
            <button onClick={() => navigate("/lab/try", { state: { prefill: prefillFrom(e) } })}>{modeOf(e) === "solo" ? "Try a change to it" : "Edit the change"}</button>
          ) : (
            <button onClick={() => navigate("/lab/compare", { state: { prefill: comparePrefill(e) } })}>Edit and run again</button>
          )}
          <button className="quiet" onClick={() => confirm("Delete this run and its results?") && remove.mutate()} disabled={remove.isPending}>
            Delete
          </button>
        </div>
        <ErrorText error={cancel.error ?? remove.error} />
      </section>
    </>
  );
}

/** What "Try again" starts from: the same base, change, field, games and AI level. */
function prefillFrom(e: ExperimentDetail): TryPrefill {
  const src = e.lists.base.source as { kind?: string; id?: string };
  const base: TryPrefill["base"] =
    src.kind === "precon" && src.id
      ? { kind: "precon", id: src.id }
      : src.kind === "deck" && src.id
        ? { kind: "deck", id: src.id }
        : {
            kind: "list",
            text: listText(e.lists.base.cards.map((c) => ({ qty: c.qty, name: c.name, board: c.commander ? "commander" : "main" }))),
            ...(e.lists.base.label !== "Pasted list" ? { label: e.lists.base.label } : {}),
          };
  const copies = (cards: { name: string; qty: number }[]) => cards.flatMap((c) => Array<string>(c.qty).fill(c.name));
  const solo = modeOf(e) === "solo";
  return { base, add: solo ? [] : copies(e.variant?.added ?? []), cut: solo ? [] : copies(e.variant?.cut ?? []), field: fieldFrom(e), games: modeOf(e) === "tournament" ? (e.games_per_deck ?? 100) : enginesOf(e).mode === "both" ? e.label.games / 2 : e.label.games, difficulty: phaseDifficulty(e), engines: enginesOf(e) };
}

/** The phase AI level a run used (a Forge-only run's label shows its Forge profile instead). */
function phaseDifficulty(e: ExperimentItem): string {
  return enginesOf(e).mode === "forge" ? "Easy" : e.label.difficulty;
}

function Progress({ e }: { e: ExperimentDetail }) {
  const { done, total, eta_seconds, games_ahead } = e.progress;
  const share = total ? done / total : 0;
  return (
    <section aria-live="polite">
      <div className="lab-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Games played">
        <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
      </div>
      <p style={{ margin: 0 }}>
        <b className="num">
          {done} of {total} games
        </b>
        {eta_seconds != null ? `, ${durationText(eta_seconds)} left` : e.status === "queued" ? ", waiting for its turn" : ", working out how long"}.
      </p>
      {e.forge_games && enginesOf(e).mode === "both" && (
        <p className="lab-note" style={{ margin: "0.2rem 0 0" }}>
          phase {e.progress.done - e.forge_games.done} of {e.progress.total - e.forge_games.total}, Forge {e.forge_games.done} of {e.forge_games.total}.
        </p>
      )}
      <ForgeWait e={e} />
      <p className="lab-note" style={{ margin: "0.2rem 0 0" }}>
        {e.status === "queued" ? "Waiting for earlier runs to finish" : "Playing"}
        {games_ahead ? ` (${games_ahead} games ahead in the queue)` : ""}. This page checks every 5 seconds; you can leave and come back.
      </p>
    </section>
  );
}

/** On a run still waiting for Forge games: whether the Forge worker is there to play them. */
function ForgeWait({ e }: { e: ExperimentItem }) {
  const f = e.forge;
  if (!f) return null;
  if (!f.configured) return <p className="lab-note lab-warn">Forge isn't set up on this server any more, so this run's Forge games can't play. Cancel the rest to keep what's in.</p>;
  if (!f.online)
    return (
      <p className="lab-note lab-warn">
        Forge worker offline{f.last_seen ? ` (last answered ${new Date(f.last_seen).toLocaleString("en-US")})` : ""}. The Forge games wait and play when it's back.
      </p>
    );
  return (
    <p className="lab-note" style={{ margin: "0.2rem 0 0" }}>
      Forge plays {f.slots} {f.slots === 1 ? "game" : "games"} at a time{f.playing ? `, ${f.playing} playing now` : ""}.
    </p>
  );
}

/** The results view for a run's mode. */
function ModeResults({ e, s, engine }: { e: ExperimentDetail; s: Summary; engine?: HalfEngine }) {
  const on = engine ?? (enginesOf(e).mode === "forge" ? "forge" : "phase");
  return ["versus", "tournament"].includes(modeOf(e)) ? <VersusResults e={e} s={s} /> : modeOf(e) === "solo" ? <SoloResults e={e} s={s} engine={on} /> : <Results e={e} s={s} engine={on} />;
}

/** A "both" run: whether the engines agree, then each engine's results under its own heading. */
function BothResults({ e, live }: { e: ExperimentDetail; live: boolean }) {
  const a = e.agreement;
  const halves = (["phase", "forge"] as const).map((h) => ({ h, d: halfOf(e, h) }));
  return (
    <>
      {a && a.kind !== "waiting" && (
        <p className={`lab-agreement ${a.kind}`} role="status">
          <b>{a.kind === "agree" ? "The engines agree." : a.kind === "disagree" ? "The engines disagree." : "No clear answer yet."}</b> {a.text}.
        </p>
      )}
      {halves.map(({ h, d }) => (
        <section key={h} className="lab-engine-half" aria-label={h === "phase" ? "Results on phase" : "Results on Forge"}>
          <h2 className="lab-engine-head">{h === "phase" ? "On phase" : "On Forge"}</h2>
          {d.summary && hasResults(d.summary) ? (
            <ModeResults e={d} s={d.summary} engine={h} />
          ) : (
            <p className="dim">{live ? `No ${h === "phase" ? "phase" : "Forge"} results yet: ${d.progress.done} of ${d.progress.total} games played.` : "No scored games on this engine."}</p>
          )}
        </section>
      ))}
    </>
  );
}

/** The base list's simulation confidence: its precon's, or the precon's on the same commanders. */
export function useBaseConfidence(e: ExperimentItem) {
  const precons = usePrecons();
  const src = e.base?.source;
  return e.base ? baseConfidence(precons.data?.precons ?? [], { precon: src?.kind === "precon" ? src.id : null, commanders: e.base.commanders }) : null;
}

function Results({ e, s, engine }: { e: ExperimentDetail; s: Summary; engine: HalfEngine }) {
  const level = `${Math.round(s.level * 100)}%`;
  const conf = useBaseConfidence(e);
  const cancelled = e.status === "cancelled";
  const d = s.paired.delta_win_rate;
  const ci = s.paired.delta_ci;
  const bound = deltaBound([ci?.[0], ci?.[1], d]);
  const top = rateCeiling([s.base.wilson?.[1], s.variant.wilson?.[1]]);
  const ticks = (max: number) => [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= max + 1e-9).map((t) => ({ at: t, label: pct(t) }));
  const compare = modeOf(e) === "compare";
  const nameA = e.base?.label ?? "Base list";
  const nameB = compare ? (e.variant?.label ?? "Second deck") : "Changed list";
  const row = (key: "base" | "variant") => {
    const st = s[key];
    const label = key === "base" ? nameA : nameB;
    const head = compare ? (key === "base" ? "First deck" : "Second deck") : key === "base" ? "Base list" : "Changed list";
    return {
      key,
      label: (
        <>
          <b>{head}</b>
          <span>{key === "base" ? label : compare ? nameB : changeShort(e)}</span>
        </>
      ),
      value: st.win_rate,
      lo: st.wilson?.[0] ?? null,
      hi: st.wilson?.[1] ?? null,
      dim: key === "base",
      aria: `${head}: won ${pct(st.win_rate)} of ${st.games} scored games${st.wilson ? `, ${level} interval ${pctRange(st.wilson[0], st.wilson[1])}` : ""}`,
      text: (
        <>
          <b>{pct(st.win_rate)}</b> won, {st.wins} of {st.games}
          {st.wilson ? ` (${level} interval ${pctRange(st.wilson[0], st.wilson[1])})` : ""}
          {st.avg_place != null ? `, average place ${st.avg_place.toFixed(2)}` : ""}
        </>
      ),
    };
  };
  return (
    <section>
      <h2>{s.verdict.final ? "Result" : "So far"}</h2>
      <p className="lab-verdict">{compare ? compareVerdict(e.status, s, nameA, nameB) : verdictText(e.status, s)}</p>
      {conf && (
        <ConfidenceLine confidence={conf.confidence} name={conf.precon.name}>
          {baseConfidenceSentence(conf, "verdict")}
        </ConfidenceLine>
      )}
      <p className="dim" style={{ marginTop: 0 }}>
        {d != null && ci
          ? compare
            ? `${nameB} won ${moreOften(d)} ${nameA} on the same ${s.paired.pods} pods (${pointsWord(d)}, ${level} interval ${pointsRange(ci)}).`
            : `The changed list won ${moreOften(d)} the base on the same ${s.paired.pods} pods (${pointsWord(d)}, ${level} interval ${pointsRange(ci)}).`
          : cancelled
            ? "Too few pods where both lists finished."
            : "Not enough pods where both lists finished yet."}
        {cancelled ? " The rest of the games were cancelled." : !s.verdict.final ? " More games are still to come." : ""}
      </p>
      <div className="lab-counts">
        <h3>How the games count</h3>
        {podCountText(s, compare ? { a: nameA, b: nameB, finished: s.verdict.final, noun: "decks" } : { a: "the base", b: "the changed list", finished: s.verdict.final }).map((line) => (
          <p key={line} className="small">
            {line}
          </p>
        ))}
        {s.unscored.total > 0 && <p className="lab-note">{unscoredText(engine, e.limits.max_seconds)}</p>}
        {s.verdict.final && settleText(s) && <p className="small">{settleText(s)}</p>}
      </div>

      {d != null && ci && (
        <IntervalChart
          caption={compare ? `Difference in win rate, ${nameB} minus ${nameA}` : "Difference in win rate, changed list minus base"}
          rows={[
            {
              key: "delta",
              label: (
                <>
                  <b>Difference</b>
                  <span>{compare ? "second minus first" : "changed minus base"}</span>
                </>
              ),
              value: d,
              lo: ci[0],
              hi: ci[1],
              aria: `Difference ${pointsWord(d)}, ${level} interval ${pointsRange(ci)}; the line is no change`,
              text: (
                <>
                  <b>{pointsWord(d)}</b> ({level} interval {pointsRange(ci)}); the line is no change
                </>
              ),
            },
          ]}
          domain={[-bound, bound]}
          reference={0}
          ticks={[-bound, -bound / 2, 0, bound / 2, bound].map((t) => ({ at: t, label: t === 0 ? "0" : `${points(t)} pts` }))}
        />
      )}
      <div style={{ height: "0.75rem" }} />
      <IntervalChart caption="Win rates in 4-player pods" rows={[row("base"), row("variant")]} domain={[0, top]} reference={0.25} ticks={ticks(top)} />
      <p className="lab-note">The line on the win rates marks a quarter, an even share of a 4-player pod.</p>

      <details>
        <summary>Pod by pod and unscored games</summary>
        <table className="plain small" style={{ maxWidth: "36rem" }}>
          <tbody>
            <tr><td>Both {compare ? "decks" : "lists"} won</td><td className="r num">{s.paired.both_won}</td></tr>
            <tr><td>Only {compare ? nameB : "the changed list"} won</td><td className="r num">{s.paired.variant_only}</td></tr>
            <tr><td>Only {compare ? nameA : "the base"} won</td><td className="r num">{s.paired.base_only}</td></tr>
            <tr><td>Neither won</td><td className="r num">{s.paired.neither}</td></tr>
            {s.paired.split_builds > 0 && <tr><td>Left out: the two games ran on different builds</td><td className="r num">{s.paired.split_builds}</td></tr>}
            <tr><td>Games nobody won (draws, turn or action cap)</td><td className="r num">{s.no_winner.total}</td></tr>
            <tr><td>Not scored (out of time {s.unscored.time_cap}, crashed {s.unscored.panic}, errors {s.unscored.error})</td><td className="r num">{s.unscored.total}</td></tr>
          </tbody>
        </table>
        <p className="lab-note">{s.method}</p>
      </details>
      <SimLine
        details={
          s.builds.length > 1
            ? `${simDetails(e.label.card_data) ?? ""} Played on ${s.builds.length} builds: ${s.builds.map((b) => `${b.games} games on ${b.engine}, card data ${shortHash(b.card_data)}, runner ${shortHash(b.runner)}`).join("; ")}.`.trim()
            : simDetails(e.label.card_data)
        }
      >
        {experimentLabel(e)}.{s.builds.length > 1 ? ` Played on ${s.builds.length} builds.` : ""}
      </SimLine>
      <p className="lab-caveat">{caveat(e.label.engine)} These numbers are apart from your playgroup's real games.</p>
    </section>
  );
}

/** The paired verdict in the two decks' names (the server words it for a change). */
function compareVerdict(status: ExperimentStatus, s: Summary, a: string, b: string): string {
  if (status === "cancelled" && s.verdict.kind === "unclear") return "Can't tell from the games played before it was cancelled";
  const d = s.paired.delta_win_rate;
  const ci = s.paired.delta_ci;
  if (s.verdict.kind === "unclear" || d == null || !ci) return "Can't tell yet: run more games";
  const lead = s.verdict.kind === "better" ? b : a;
  const lag = s.verdict.kind === "better" ? a : b;
  return `${lead} probably does better than ${lag} (${pointsWord(Math.abs(d))}, ${Math.round(s.level * 100)}% interval ${pointsRange(s.verdict.kind === "better" ? ci : [-ci[1], -ci[0]])})`;
}

/** One list as it is: its win rate against the field, beside the no-edge share. */
function SoloResults({ e, s, engine }: { e: ExperimentDetail; s: Summary; engine: HalfEngine }) {
  const level = `${Math.round(s.level * 100)}%`;
  const conf = useBaseConfidence(e);
  const st = s.base;
  const top = rateCeiling([st.wilson?.[1]]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= top + 1e-9).map((t) => ({ at: t, label: pct(t) }));
  return (
    <section>
      <h2>{s.verdict.final ? "Result" : "So far"}</h2>
      <p className="lab-verdict">{verdictText(e.status, s)}</p>
      {conf && (
        <ConfidenceLine confidence={conf.confidence} name={conf.precon.name}>
          {baseConfidenceSentence(conf, "verdict")}
        </ConfidenceLine>
      )}
      <IntervalChart
        caption="Win rate in 4-player pods"
        rows={[
          {
            key: "base",
            label: (
              <>
                <b>{e.base?.label ?? "The list"}</b>
                <span>as it is</span>
              </>
            ),
            value: st.win_rate,
            lo: st.wilson?.[0] ?? null,
            hi: st.wilson?.[1] ?? null,
            aria: `Won ${pct(st.win_rate)} of ${st.games} scored games${st.wilson ? `, ${level} interval ${pctRange(st.wilson[0], st.wilson[1])}` : ""}`,
            text: (
              <>
                <b>{pct(st.win_rate)}</b> won, {st.wins} of {st.games}
                {st.wilson ? ` (${level} interval ${pctRange(st.wilson[0], st.wilson[1])})` : ""}
                {st.avg_place != null ? `, average place ${st.avg_place.toFixed(2)}` : ""}
              </>
            ),
          },
        ]}
        domain={[0, top]}
        reference={0.25}
        ticks={ticks}
      />
      <p className="lab-note">The line marks a quarter: what a list with no edge over its three opponents would win.</p>
      {s.unscored.total > 0 && (
        <p className="lab-note">
          {s.unscored.total} of {s.pods} games didn't finish and aren't counted ({[s.unscored.time_cap ? `${s.unscored.time_cap} out of time` : "", s.unscored.error ? `${s.unscored.error} errors` : "", s.unscored.panic ? `${s.unscored.panic} crashed` : ""].filter(Boolean).join(", ")}).{" "}
          {unscoredText(engine, e.limits.max_seconds)}
        </p>
      )}
      <details>
        <summary>Unscored games and the method</summary>
        <table className="plain small" style={{ maxWidth: "36rem" }}>
          <tbody>
            <tr><td>Games nobody won (draws, turn or action cap)</td><td className="r num">{s.no_winner.total}</td></tr>
            <tr><td>Not scored (out of time {s.unscored.time_cap}, crashed {s.unscored.panic}, errors {s.unscored.error})</td><td className="r num">{s.unscored.total}</td></tr>
          </tbody>
        </table>
        <p className="lab-note">{s.method}</p>
      </details>
      <SimLine details={simDetails(e.label.card_data)}>{experimentLabel(e)}.</SimLine>
      <p className="lab-caveat">{caveat(e.label.engine)} These numbers are apart from your playgroup's real games.</p>
    </section>
  );
}

/** Decks head to head: each deck's win share, who finished ahead of whom, and game length. */
function VersusResults({ e, s }: { e: ExperimentDetail; s: Summary }) {
  const v = s.versus!;
  const level = `${Math.round(s.level * 100)}%`;
  const even = 1 / v.pod;
  const top = rateCeiling(v.entrants.map((x) => x.wilson?.[1]));
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= top + 1e-9).map((t) => ({ at: t, label: pct(t) }));
  const names = v.entrants.map((x) => x.label);
  const ranked = [...v.entrants].sort((a, b) => (b.win_rate ?? -1) - (a.win_rate ?? -1));
  const [matchupFilter, setMatchupFilter] = useState("");
  const [matchupPage, setMatchupPage] = useState(0);
  const meetings = v.meetings.filter((m) => m.games > 0 && (!matchupFilter || (names[m.a] ?? "").toLowerCase().includes(matchupFilter.toLowerCase()) || (names[m.b] ?? "").toLowerCase().includes(matchupFilter.toLowerCase())));
  const rounds = v.avg_turns != null ? v.avg_turns / v.pod : null;
  return (
    <section>
      <h2>{s.verdict.final ? "Result" : "So far"}</h2>
      <p className="lab-verdict">{verdictText(e.status, s)}</p>
      {modeOf(e) === "tournament" && !s.verdict.final && <p className="small dim">Progress updates each game; the ranking may lag by up to 24 games while a batch finishes.</p>}
      <IntervalChart
        caption={`Win share in ${v.pod === 2 ? "1v1 games" : "4-player pods"}`}
        rows={ranked.map((x) => ({
          key: x.id,
          label: (
            <>
              <b>{x.label}</b>
              <span>
                first in {x.first} {x.first === 1 ? "game" : "games"}
              </span>
            </>
          ),
          value: x.win_rate,
          lo: x.wilson?.[0] ?? null,
          hi: x.wilson?.[1] ?? null,
          aria: `${x.label}: won ${pct(x.win_rate)} of ${x.games} scored games${x.wilson ? `, ${level} interval ${pctRange(x.wilson[0], x.wilson[1])}` : ""}`,
          text: (
            <>
              <b>{pct(x.win_rate)}</b> won, {x.wins} of {x.games}
              {x.wilson ? ` (${level} interval ${pctRange(x.wilson[0], x.wilson[1])})` : ""}
              {x.avg_place != null ? `, average place ${x.avg_place.toFixed(2)}` : ""}
              {x.strength ? `, strength ${x.strength.strength.toFixed(2)} (${level} interval ${x.strength.lo.toFixed(2)} to ${x.strength.hi.toFixed(2)})` : ""}
            </>
          ),
        }))}
        domain={[0, top]}
        reference={even}
        ticks={ticks}
      />
      <p className="lab-note">
        The line marks {v.pod === 2 ? "a half" : "a quarter"}: what a deck with no edge would win.
        {v.entrants.some((x) => x.strength) ? " Strength accounts for who each deck sat with: 1 is the field's average, and a strength-2 deck is twice as likely as a strength-1 deck to win a pod they share." : ""}
        {v.filler_wins > 0 ? ` Precons filling empty seats won ${v.filler_wins} games.` : ""}
        {rounds != null ? ` Games lasted about ${Math.round(rounds)} rounds (${v.avg_turns!.toFixed(0)} turns counting every player's).` : ""}
      </p>
      {v.meetings.length > 0 && (
        <>
          <h3>Head to head</h3>
          <label>Filter matchups by deck<input value={matchupFilter} onChange={(e) => { setMatchupFilter(e.target.value); setMatchupPage(0); }} /></label>
          <p className="small dim">Only decks that shared scored games are compared. Showing {meetings.length ? matchupPage * 200 + 1 : 0}–{Math.min((matchupPage + 1) * 200, meetings.length)} of {meetings.length} matching pairs. This is finish order in multiplayer pods, not a simulated 1v1 win rate.</p>
          <div className="lab-scroll">
            <table className="plain small lab-h2h">
              <thead>
                <tr>
                  <th>Decks</th>
                  <th className="r">Games</th>
                  <th>Who finished ahead</th>
                </tr>
              </thead>
              <tbody>
                {meetings.slice(matchupPage * 200, (matchupPage + 1) * 200).map((m) => (
                  <tr key={`${m.a}-${m.b}`}>
                    <td>
                      {names[m.a]} and {names[m.b]}
                    </td>
                    <td className="r num">{m.games}</td>
                    <td>
                      {names[m.a]} {m.a_ahead}, {names[m.b]} {m.b_ahead}
                      {m.ties ? `, level ${m.ties}` : ""}
                      {m.a_share != null && m.a_share_ci ? ` (${names[m.a]} ahead in ${pct(m.a_share)}, ${level} interval ${pctRange(m.a_share_ci[0], m.a_share_ci[1])})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {meetings.length > 200 && <div className="lab-chips">
            <button type="button" disabled={matchupPage === 0} onClick={() => setMatchupPage((p) => p - 1)}>Previous matchups</button>
            <button type="button" disabled={(matchupPage + 1) * 200 >= meetings.length} onClick={() => setMatchupPage((p) => p + 1)}>Next matchups</button>
          </div>}
        </>
      )}
      <details>
        <summary>Unscored games and the method</summary>
        <table className="plain small" style={{ maxWidth: "36rem" }}>
          <tbody>
            <tr><td>Games nobody won (draws, turn or action cap)</td><td className="r num">{s.no_winner.total}</td></tr>
            <tr><td>Not scored (out of time {s.unscored.time_cap}, crashed {s.unscored.panic}, errors {s.unscored.error})</td><td className="r num">{s.unscored.total}</td></tr>
          </tbody>
        </table>
        <p className="lab-note">{s.method}</p>
      </details>
      <SimLine details={simDetails(e.label.card_data)}>{experimentLabel(e)}.</SimLine>
      <p className="lab-caveat">{caveat(e.label.engine)} AI-piloted games: they say how these decks do in the simulation, not at your table.</p>
    </section>
  );
}

function changeShort(e: ExperimentItem): string {
  const v = e.variant;
  if (!v) return "";
  const line = (sign: string, c: { name: string; qty: number }) => `${sign}${c.qty > 1 ? `${c.qty} ` : ""}${c.name}`;
  const parts = [...v.cut.map((c) => line("−", c)), ...v.added.map((c) => line("+", c))];
  return parts.length > 4 ? `${parts.slice(0, 4).join(", ")}, and ${parts.length - 4} more` : parts.join(", ");
}

function Change({ e }: { e: ExperimentDetail }) {
  const v = e.variant;
  const mode = modeOf(e);
  // A "both" run's label counts both engines' games; say them per engine.
  const both = enginesOf(e).mode === "both";
  const n = both ? e.label.games / 2 : e.label.games;
  const each = both ? " on each engine" : "";
  const ai = `${engineLine(e)}.`;
  if (mode !== "change") {
    const decks = mode === "solo" ? (e.base ? [e.base] : []) : (e.entrants ?? []);
    const games = mode === "compare" ? `${n} games${each} (${n / 2} pods, each played by both decks)` : mode === "solo" ? `${n} games${each} (each pod once)` : `${n} games${each}${e.label.pod === 2 ? ", 1v1" : ""}`;
    return (
      <>
        <ul className="lab-decks small">
          {decks.map((d) => (
            <li key={d.label}>
              <b>{d.label}</b>
              {d.commanders.length ? `: ${d.commanders.join(" and ")}` : ""}
              {d.source.kind === "deck" ? " (the deck's version when the run was made)" : d.source.kind === "precon" ? " (the precon's stock list)" : ""}
            </li>
          ))}
        </ul>
        <p className="small">
          {mode === "tournament" ? "One shared tournament field; every participant is scored." : ["versus", "tournament"].includes(mode) ? (e.field?.kind === "none" ? "No other decks at the table." : `Empty seats: ${fieldPhrase(e) ?? "unknown"}.`) : `Opponents: ${fieldPhrase(e) ?? "unknown"}.`}{" "}
          {ai} {games.replace(/^./, (c) => c.toUpperCase())}. The lists were frozen when the run was made.
        </p>
        <RunNotes e={e} />
      </>
    );
  }
  return (
    <>
      <div className="lab-two">
        <div>
          <h3>Cut</h3>
          {v?.cut.length ? <ul className="small">{v.cut.map((c) => <li key={c.name}>{c.qty > 1 ? `${c.qty} ` : ""}{c.name}</li>)}</ul> : <p className="dim small">Nothing</p>}
        </div>
        <div>
          <h3>Added</h3>
          {v?.added.length ? <ul className="small">{v.added.map((c) => <li key={c.name}>{c.qty > 1 ? `${c.qty} ` : ""}{c.name}</li>)}</ul> : <p className="dim small">Nothing</p>}
        </div>
      </div>
      <p className="small">
        Base: {e.base?.label ?? "unknown"}
        {e.base?.source.kind === "deck" ? " (the deck's version when the run was made)" : e.base?.source.kind === "precon" ? " (the precon's stock list)" : ""}. Opponents:{" "}
        {fieldPhrase(e) ?? "unknown"}. {ai} {n} games{each} ({n / 2} pods, each played by both lists).
        The lists were frozen when the run was made.
      </p>
      <RunNotes e={e} />
    </>
  );
}

/** A run's deck-check notes, its opponents and when it was made. */
function RunNotes({ e }: { e: ExperimentDetail }) {
  const unit = modeOf(e) === "change" || modeOf(e) === "compare" ? ["pod", "pods"] : ["game", "games"];
  return (
    <>
      {e.warnings.length > 0 && (
        <details className="small">
          <summary>
            {e.warnings.length} {e.warnings.length === 1 ? "note" : "notes"} from the deck check
          </summary>
          <ul className="lab-note">{e.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}
      {e.opponents.length > 0 && (
        <details className="small">
          <summary>
            {["versus", "tournament"].includes(modeOf(e)) ? "Precons in the empty seats" : "Opponents"} ({e.opponents.length})
          </summary>
          <ul className="lab-note">
            {e.opponents.map((o) => (
              <li key={o.id}>
                {(o.source as { kind?: string; id?: string }).kind === "precon" ? <Link to={`/lab/p/${(o.source as { id: string }).id}`}>{o.label}</Link> : o.label}, in {o.pods}{" "}
                {o.pods === 1 ? unit[0] : unit[1]}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="lab-note">Made {fmtDate(e.label.created_at)}.</p>
    </>
  );
}

/** What an empty cell says: a game still to come, or one that won't be played. */
const MISSING: Record<ExperimentStatus, string> = {
  queued: "not played yet",
  running: "not played yet",
  cancelled: "cancelled",
  failed: "not played",
  done: "not played",
};

function Pods({ id, done, status, mode, engine }: { id: string; done: number; status: ExperimentStatus; mode: ExperimentMode; engine?: "phase" | "forge" }) {
  const [open, setOpen] = useState(false);
  const pods = useQuery({
    queryKey: ["lab", "pods", id, done, engine ?? ""],
    queryFn: () => api<PodView[]>(`/api/lab/experiments/${id}/pods${engine ? `?engine=${engine}` : ""}`),
    enabled: open,
    placeholderData: (prev) => prev,
  });
  const played = (pods.data ?? []).filter((p) => p.base || p.variant || p.game);
  const cell = (g: PodView["base"]) => {
    if (!g) return <span className="faint">{MISSING[status]}</span>;
    return (
      <span className={g.won ? "won" : g.scored ? "" : "faint"} title={g.error ?? undefined}>
        {gameText(g)}
        <span className="faint">, {Math.round(g.seconds)} s</span>
      </span>
    );
  };
  return (
    <section>
      <details onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
        <summary>Every game{engine ? (engine === "forge" ? " on Forge" : " on phase") : ""} ({done} played)</summary>
        <ErrorText error={pods.error} />
        {pods.isPending && open && <p className="dim small">Loading…</p>}
        {played.length > 0 && ["versus", "tournament"].includes(mode) && (
          <div className="lab-scroll">
            <table className="lab-pods">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Seats, first player first</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {played.map((p) => (
                  <tr key={p.pod}>
                    <td className="num">{p.pod}</td>
                    <td>
                      {p.seats.map((x, i) => (
                        <span key={i}>
                          {i > 0 ? ", " : ""}
                          {p.game?.winner === x ? <b>{x}</b> : x}
                        </span>
                      ))}
                    </td>
                    <td>
                      {p.game ? (
                        <span className={p.game.scored ? "" : "faint"} title={p.game.error ?? undefined}>
                          {p.game.end === "win" && p.game.winner ? `${p.game.winner} won on turn ${p.game.turns}` : p.game.end === "draw" ? "Draw" : p.game.scored ? "Nobody won (cap)" : "Not scored"}
                          <span className="faint">, {Math.round(p.game.seconds)} s</span>
                        </span>
                      ) : (
                        <span className="faint">{MISSING[status]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {played.length > 0 && !["versus", "tournament"].includes(mode) && (
          <div className="lab-scroll">
            <table className="lab-pods">
              <thead>
                <tr>
                  <th>Pod</th>
                  <th>Seat</th>
                  <th>Opponents</th>
                  <th>{mode === "compare" ? "First deck" : mode === "solo" ? "Result" : "Base"}</th>
                  {mode !== "solo" && <th>{mode === "compare" ? "Second deck" : "Changed"}</th>}
                </tr>
              </thead>
              <tbody>
                {played.map((p) => (
                  <tr key={p.pod}>
                    <td className="num">{p.pod}</td>
                    <td className="num" title={p.seat === 0 ? "Takes the first turn" : undefined}>
                      {p.seat + 1}
                      {p.seat === 0 ? ", first" : ""}
                    </td>
                    <td>{p.seats.filter((x): x is string => x != null).join(", ")}</td>
                    <td>{cell(p.base)}</td>
                    {mode !== "solo" && <td>{cell(p.variant)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
