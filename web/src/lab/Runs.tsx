import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ErrorText } from "../components/ui";
import type { BatchComparison, ExperimentItem, RunDetail, RunListItem } from "./api";
import { caveat, deltaBound, durationText, fmtDate, hasResults, pct, pctRange, points, pointsRange, pointsWord, rateCeiling, sentence, simLabel, verdictText } from "./logic";
import { IntervalChart, SimLine, StatusTag } from "./parts";
import { RunWarnings } from "./Precons";
import { experimentLabel } from "./Run";

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
  const exps = useQuery({
    queryKey: ["lab", "experiments"],
    queryFn: () => api<ExperimentItem[]>("/api/lab/experiments"),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "queued" || e.status === "running") ? 5000 : false),
  });
  const runs = useQuery({ queryKey: ["lab", "runs"], queryFn: () => api<RunListItem[]>("/api/lab/runs") });
  const batch = (runs.data ?? []).filter((r) => !r.global && r.kind === "paired");

  return (
    <>
      <div className="page-head">
        <h1>My runs</h1>
        <Link className="button primary" to="/decks/lab/try">Try a change</Link>
      </div>
      <ErrorText error={exps.error} />
      {exps.data?.length === 0 && (
        <p className="empty">
          No runs yet. <Link to="/decks/lab/try">Try a change</Link> to play a list against a changed copy of it, or start from a precon in{" "}
          <Link to="/decks/lab">Precons</Link>.
        </p>
      )}
      {exps.data && exps.data.length > 0 && (
        <div className="list" style={{ marginBottom: "2rem" }}>
          {exps.data.map((e) => (
            <Link key={e.id} to={`/decks/lab/runs/${e.id}`} className="lab-runrow">
              {e.base?.art ? <img className="art-thumb lab-thumb" src={e.base.art.url} alt="" /> : <span className="art-thumb lab-thumb" />}
              <span>
                <span className="title">{e.name}</span>
                <br />
                <span className="sub">
                  <StatusTag status={e.status} />
                  {headline(e)}
                </span>
                <br />
                <span className="sub">
                  {experimentLabel(e)}. Against {e.field?.label.replace(/^./, (c) => c.toLowerCase()) ?? "an unrecorded field"}.
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {batch.length > 0 && (
        <section>
          <h2>Batch runs</h2>
          <p className="lab-note">Paired runs from your overnight batches, analysed in commander-decks and imported here. Only you see them.</p>
          <div className="list">
            {batch.map((r) => (
              <Link key={r.id} to={`/decks/lab/runs/batch/${r.id}`} className="lab-runrow" style={{ gridTemplateColumns: "1fr" }}>
                <span>
                  <span className="title">{r.name}</span>
                  {r.paired?.comparisons.map((c) => (
                    <span key={`${c.base}>${c.variant}`} className="sub" style={{ display: "block" }}>
                      {sentence(shortName(c.variant_name))} against {shortName(c.base_name)}: {comparisonText(c)}
                    </span>
                  ))}
                  <span className="sub" style={{ display: "block" }}>
                    {simLabel({ engine: r.engine, difficulty: r.difficulty, games: r.games, pod: r.pod, date: r.analysed_at ?? r.created_at })}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <ErrorText error={runs.error} />
    </>
  );
}

/** "The Fantastic Four (Bryan, after)" → "after", when it ends in a bracketed state. */
function shortName(name: string): string {
  const m = /\(([^)]*,\s*)?([^,)]+)\)\s*$/.exec(name);
  return m ? m[2]!.trim() : name;
}

function comparisonText(c: BatchComparison): string {
  if (c.delta_win_rate == null || !c.delta_ci) return c.verdict.text;
  return c.verdict.kind === "unclear"
    ? `can't tell yet (${pointsWord(c.delta_win_rate)}, 90% interval ${pointsRange(c.delta_ci)}, ${c.pods} pods)`
    : `${c.verdict.text.replace(/^./, (x) => x.toLowerCase())}, ${c.pods} pods`;
}

export function BatchPage() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["lab", "run", id], queryFn: () => api<RunDetail>(`/api/lab/runs/${id}`) });
  if (run.error) {
    return (
      <>
        <Link className="lab-back" to="/decks/lab/runs">My runs</Link>
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
      <Link className="lab-back" to="/decks/lab/runs">My runs</Link>
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

