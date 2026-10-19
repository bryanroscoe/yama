import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ErrorText } from "../components/ui";
import type { BatchComparison, ExperimentItem, RunDetail, RunListItem } from "./api";
import { caveat, deltaBound, durationText, fmtDate, hasResults, pct, pctRange, points, pointsRange, pointsWord, rateCeiling, sentence, simLabel, verdictText } from "./logic";
import { IntervalChart, SimLine } from "./parts";
import { RunWarnings } from "./Precons";
import { experimentLabel } from "./Run";
import { LabHead } from "./LabLayout";
import { stateLabel } from "./paired";

/** A run's headline: the verdict when there is one, else where it has got to. */
export function headline(e: ExperimentItem): string {
  const p = e.progress;
  const s = e.summary && hasResults(e.summary) ? e.summary : null;
  switch (e.status) {
    case "queued":
      return p.eta_seconds != null ? `Waiting, done in ${durationText(p.eta_seconds)}` : "Waiting for its turn";
    case "running":
      return `${p.done} of ${p.total} games${p.eta_seconds != null ? `, ${durationText(p.eta_seconds)} left` : ""}${s ? `. So far: ${s.verdict.text}` : ""}`;
    case "failed":
      return `Failed: ${e.error ?? "no reason recorded"}`;
    case "cancelled":
      return `Cancelled after ${p.done} of ${p.total} games${s ? `. ${verdictText(e.status, s)}` : ""}`;
    default:
      return s?.verdict.text ?? "Done";
  }
}

export function RunsPage() {
  const qc = useQueryClient();
  const exps = useQuery({
    queryKey: ["lab", "experiments"],
    queryFn: () => api<ExperimentItem[]>("/api/lab/experiments"),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "queued" || e.status === "running") ? 5000 : false),
  });
  const runs = useQuery({ queryKey: ["lab", "runs"], queryFn: () => api<RunListItem[]>("/api/lab/runs") });
  const batch = (runs.data ?? []).filter((r) => !r.global && r.kind === "paired");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["lab", "experiments"] });
  const stop = useMutation({ mutationFn: (id: string) => api(`/api/lab/experiments/${id}/cancel`, { method: "POST" }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/lab/experiments/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const engines = [...new Set([...(exps.data ?? []).map((e) => e.label.engine), ...batch.map((r) => r.engine)].filter(Boolean))];

  return (
    <>
      <LabHead
        title="My runs"
        action={
          <Link className="button primary" to="/decks/lab/try">
            Try a change
          </Link>
        }
      />
      <ErrorText error={exps.error ?? stop.error ?? remove.error} />
      {exps.data?.length === 0 && batch.length === 0 && (
        <p className="empty">
          No runs yet. <Link to="/decks/lab/try">Try a change</Link> to play a list against a changed copy of it, or start from a precon in{" "}
          <Link to="/decks/lab">Precons</Link>.
        </p>
      )}
      {exps.data && exps.data.length > 0 && (
        <section className="lab-runs" aria-label="Your experiments">
          {exps.data.map((e) => {
            const live = e.status === "queued" || e.status === "running";
            const s = e.summary && hasResults(e.summary) ? e.summary : null;
            const tag = live
              ? { text: e.status === "running" ? "Running" : "Waiting", tone: "" }
              : e.status === "failed"
                ? { text: "Failed", tone: "bad" }
                : s
                  ? verdictTag(s.verdict.kind)
                  : { text: e.status === "cancelled" ? "Cancelled" : "Done", tone: "quiet" };
            return (
              <article key={e.id} className="lab-runcard">
                <div className="lab-runcard-head">
                  {e.base?.art ? <img className="crop crop-sm" src={e.base.art.url} alt="" loading="lazy" /> : <span className="crop crop-sm" aria-hidden="true" />}
                  <span className="lab-runcard-title">
                    <Link to={`/decks/lab/runs/${e.id}`}>{e.name}</Link>
                    <span>
                      {e.field?.label ?? "An unrecorded field"}, {e.label.games} games, started {fmtDate(e.label.started_at ?? e.label.created_at)}
                    </span>
                  </span>
                  <span className={`pill ${tag.tone}`}>{tag.text}</span>
                </div>
                {live && (
                  <span className="lab-progress" role="progressbar" aria-label="Games played" aria-valuemin={0} aria-valuemax={e.progress.total} aria-valuenow={e.progress.done}>
                    <span style={{ width: `${e.progress.total ? (e.progress.done / e.progress.total) * 100 : 0}%` }} />
                  </span>
                )}
                <span className="lab-runcard-result">{headline(e)}</span>
                <span className="lab-note">{experimentLabel(e)}.</span>
                <span className="lab-runcard-actions">
                  <Link className="button" to={`/decks/lab/runs/${e.id}`}>
                    Open
                  </Link>
                  {live ? (
                    <button className="quiet" disabled={stop.isPending} onClick={() => confirm("Stop this run? Games already played are kept.") && stop.mutate(e.id)}>
                      Stop
                    </button>
                  ) : (
                    <button className="quiet" disabled={remove.isPending} onClick={() => confirm(`Delete ${e.name}? Its games and results go too.`) && remove.mutate(e.id)}>
                      Delete
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        </section>
      )}

      {batch.length > 0 && (
        <section className="lab-runs" aria-labelledby="batch-runs">
          <h2 id="batch-runs" className="lab-runs-head">
            Batch runs
          </h2>
          <p className="lab-note">Paired runs from your overnight batches, analysed in commander-decks and imported here. Only you see them.</p>
          {batch.flatMap((r) =>
            (r.paired?.comparisons ?? []).map((c) => {
              const tag = verdictTag(c.verdict.kind);
              return (
                <article key={`${r.id}-${c.base}-${c.variant}`} className="lab-runcard">
                  <div className="lab-runcard-head">
                    <span className="lab-runcard-title">
                      <Link to={`/decks/lab/runs/batch/${r.id}`}>
                        {deckOf(c.base_name)} {stateLabel(shortName(c.base_name))[0].toLowerCase()} vs {stateLabel(shortName(c.variant_name))[0].toLowerCase()}
                      </Link>
                      <span>
                        Field of {r.ranked} decks, {c.pods} paired pods, {fmtDate(r.analysed_at ?? r.created_at)}
                      </span>
                    </span>
                    <span className={`pill ${tag.tone}`}>{tag.text}</span>
                  </div>
                  <span className="lab-runcard-result">
                    {c.delta_win_rate != null && c.delta_ci
                      ? `${pointsWord(c.delta_win_rate)}, ${r.level ? Math.round(r.level * 100) : 90}% interval ${pointsRange(c.delta_ci)}.`
                      : `${c.verdict.text}.`}
                    {c.verdict.kind === "unclear" ? " Run more games to tell." : ""} Only {shortName(c.variant_name)} won {c.variant_only}, only {shortName(c.base_name)} won {c.base_only}.
                  </span>
                  <span className="lab-note">
                    {simLabel({ engine: r.engine, difficulty: r.difficulty, games: r.games, pod: r.pod, date: r.analysed_at ?? r.created_at, run: r.name })}.
                  </span>
                  <span className="lab-runcard-actions">
                    <Link className="button" to={`/decks/lab/runs/batch/${r.id}`}>
                      Open
                    </Link>
                  </span>
                </article>
              );
            }),
          )}
        </section>
      )}
      <ErrorText error={runs.error} />
      {(exps.data?.length || batch.length) && engines.length ? (
        <p className="lab-note">
          Runs use {engines.join(" and ")} with AI in every seat. {caveat()}
        </p>
      ) : null}
    </>
  );
}

/** "Probably better" (good), "Probably worse" (bad) or "Can't tell yet" (warn). */
function verdictTag(kind: "better" | "worse" | "unclear"): { text: string; tone: string } {
  return kind === "better" ? { text: "Probably better", tone: "good" } : kind === "worse" ? { text: "Probably worse", tone: "bad" } : { text: "Can't tell yet", tone: "warn" };
}

/** "Riders of Rohan (Bryan, stock)" → "Riders of Rohan". */
function deckOf(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "");
}

/** "The Fantastic Four (Bryan, after)" → "after", when it ends in a bracketed state. */
function shortName(name: string): string {
  const m = /\(([^)]*,\s*)?([^,)]+)\)\s*$/.exec(name);
  return m ? m[2]!.trim() : name;
}

export function BatchPage() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["lab", "run", id], queryFn: () => api<RunDetail>(`/api/lab/runs/${id}`) });
  if (run.error) {
    return (
      <>
        <LabHead slim back={{ to: "/decks/lab/runs", label: "Back to my runs" }} />
        <ErrorText error={run.error} />
      </>
    );
  }
  const d = run.data;
  if (!d) return <p className="dim">Loading…</p>;
  const r = d.run;
  const p = d.paired;
  const level = r.level ? `${Math.round(r.level * 100)}%` : "90%";
  const top = rateCeiling((p?.variants ?? []).map((v) => v.wilson?.[1]));
  const bound = deltaBound((p?.comparisons ?? []).flatMap((c) => [c.delta_ci?.[0], c.delta_ci?.[1]]));
  return (
    <>
      <LabHead slim back={{ to: "/decks/lab/runs", label: "Back to my runs" }} />
      <div className="page-head">
        <div>
          <h1>{r.name}</h1>
          <SimLine>{simLabel({ engine: r.engine, card_data: r.card_data, difficulty: r.difficulty, games: r.games, pod: r.pod, date: r.analysed_at ?? r.created_at })}.</SimLine>
        </div>
      </div>
      <p className="lab-caveat">{caveat(r.engine)}</p>
      {r.warnings.length > 0 && <RunWarnings warnings={r.warnings} />}
      {!p ? (
        <p className="dim">This run has no paired comparison.</p>
      ) : (
        <>
          <section>
            <h2>Win rates</h2>
            <IntervalChart
              caption="Win rates in 4-player pods"
              domain={[0, top]}
              reference={0.25}
              ticks={[0, 0.25, 0.5, 0.75, 1].filter((t) => t <= top + 1e-9).map((t) => ({ at: t, label: pct(t) }))}
              rows={p.variants.map((v, i) => ({
                key: v.id,
                label: (
                  <>
                    <b>{sentence(shortName(v.name))}</b>
                    <span>{v.name}</span>
                  </>
                ),
                value: v.win_rate,
                lo: v.wilson?.[0] ?? null,
                hi: v.wilson?.[1] ?? null,
                dim: i < p.variants.length - 1,
                aria: `${v.name}: won ${pct(v.win_rate)} of ${v.games} games${v.wilson ? `, ${level} interval ${pctRange(v.wilson[0], v.wilson[1])}` : ""}`,
                text: (
                  <>
                    <b>{pct(v.win_rate)}</b> won, {v.wins} of {v.games}
                    {v.wilson ? ` (${level} interval ${pctRange(v.wilson[0], v.wilson[1])})` : ""}
                    {v.avg_place != null ? `, average place ${v.avg_place.toFixed(2)}` : ""}
                    {v.failed ? `, ${v.failed} failed` : ""}
                  </>
                ),
              }))}
            />
            <p className="lab-note">The line marks a quarter, an even share of a 4-player pod. Each list played the same {p.templates ?? ""} pods.</p>
          </section>
          <section>
            <h2>Comparisons</h2>
            {p.comparisons.map((c) => (
              <div key={`${c.base}>${c.variant}`} style={{ marginBottom: "1.25rem" }}>
                <h3>
                  {sentence(shortName(c.variant_name))} against {shortName(c.base_name)}
                </h3>
                <p style={{ margin: "0 0 0.5rem" }}>
                  <b>{c.verdict.text}</b>
                  {c.verdict.kind === "unclear" && c.delta_win_rate != null && c.delta_ci ? ` (${pointsWord(c.delta_win_rate)}, ${level} interval ${pointsRange(c.delta_ci)})` : ""}.{" "}
                  <span className="dim">
                    {c.pods} pods: only {shortName(c.variant_name)} won {c.variant_only}, only {shortName(c.base_name)} won {c.base_only}.
                  </span>
                </p>
                {c.delta_win_rate != null && c.delta_ci && (
                  <IntervalChart
                    caption={`Difference in win rate, ${c.variant_name} minus ${c.base_name}`}
                    domain={[-bound, bound]}
                    reference={0}
                    ticks={[-bound, -bound / 2, 0, bound / 2, bound].map((t) => ({ at: t, label: t === 0 ? "0" : `${points(t)} pts` }))}
                    rows={[
                      {
                        key: "d",
                        label: (
                          <>
                            <b>Difference</b>
                            <span>{shortName(c.variant_name)} minus {shortName(c.base_name)}</span>
                          </>
                        ),
                        value: c.delta_win_rate,
                        lo: c.delta_ci[0],
                        hi: c.delta_ci[1],
                        aria: `Difference ${pointsWord(c.delta_win_rate)}, ${level} interval ${pointsRange(c.delta_ci)}`,
                        text: (
                          <>
                            <b>{pointsWord(c.delta_win_rate)}</b> ({level} interval {pointsRange(c.delta_ci)}); the line is no change
                          </>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            ))}
            <p className="lab-note">
              Intervals here are commander-decks' bootstrap over pods (analyze.py), not the interval "Try a change" uses; the verdict wording is the same.
            </p>
          </section>
        </>
      )}
      <p className="lab-note">Imported {fmtDate(r.imported_at)}. Only you see this run.</p>
    </>
  );
}

