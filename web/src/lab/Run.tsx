import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityName } from "@yama/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { ErrorText, Pips } from "../components/ui";
import type { ExperimentDetail, ExperimentItem, ExperimentStatus, FieldChoice, PodView, Summary, TryPrefill } from "./api";
import {
  caveat,
  deltaBound,
  durationText,
  fmtDate,
  gameText,
  hasResults,
  moreOften,
  pct,
  pctRange,
  points,
  pointsRange,
  pointsWord,
  rateCeiling,
  shortHash,
  simLabel,
  verdictText,
} from "./logic";
import { ArtPanel, IntervalChart, SimLine, StatusTag } from "./parts";

const LIVE = new Set(["queued", "running"]);

/** The label line for an experiment's numbers: the games played so far, out of those planned. */
export function experimentLabel(e: ExperimentItem): string {
  const l = e.label;
  return simLabel({
    engine: l.engine,
    card_data: l.card_data,
    difficulty: l.difficulty,
    games: e.progress.done,
    planned: l.games,
    pod: l.pod,
    date: l.finished_at ?? l.started_at ?? l.created_at,
  });
}

export function RunPage() {
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
      navigate("/decks/lab/runs");
    },
  });

  if (exp.error) {
    return (
      <>
        <Link className="lab-back" to="/decks/lab/runs">My runs</Link>
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
      <Link className="lab-back" to="/decks/lab/runs">My runs</Link>
      <ArtPanel art={e.base?.art}>
        <span>
          <StatusTag status={e.status} />
        </span>
        <h1 style={{ fontSize: "var(--t-xl)" }}>{e.name}</h1>
        {e.base && (
          <span className="dim small">
            {e.base.commanders.join(" and ")} <Pips identity={e.base.color_identity} /> {identityName(e.base.color_identity)}
          </span>
        )}
      </ArtPanel>

      {live && <Progress e={e} />}
      {e.status === "failed" && <p className="error">This run failed: {e.error ?? "no reason recorded"}.</p>}
      {e.status === "cancelled" && (
        <p className="dim">
          Cancelled after {e.progress.done} of {e.progress.total} games{s && !s.verdict.final ? "; games that were playing still count when they finish" : ""}.
        </p>
      )}

      {scored ? (
        <Results e={e} s={scored} />
      ) : (
        !live && (
          <p className="dim">
            {s && s.unscored.total > 0
              ? `None of the games that finished was scored (${s.unscored.total} ran out of time, crashed or hit an error), so there are no results.`
              : "No games finished, so there are no results."}
          </p>
        )
      )}

      <section>
        <h2>The change</h2>
        <Change e={e} />
      </section>

      {e.progress.done > 0 && <Pods id={e.id} done={e.progress.done} status={e.status} />}

      <section>
        <div className="row">
          {live && (
            <button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel the rest
            </button>
          )}
          <button onClick={() => navigate("/decks/lab/try", { state: { prefill: prefillFrom(e) } })}>Try again</button>
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
            text: [
              "Commander",
              ...e.lists.base.cards.filter((c) => c.commander).map((c) => `${c.qty} ${c.name}`),
              "",
              "Deck",
              ...e.lists.base.cards.filter((c) => !c.commander).map((c) => `${c.qty} ${c.name}`),
            ].join("\n"),
          };
  const copies = (cards: { name: string; qty: number }[]) => cards.flatMap((c) => Array<string>(c.qty).fill(c.name));
  const f = e.field;
  const field: FieldChoice | undefined = !f
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
  return { base, add: copies(e.variant?.added ?? []), cut: copies(e.variant?.cut ?? []), field, games: e.label.games, difficulty: e.label.difficulty };
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
      <p className="lab-note" style={{ margin: "0.2rem 0 0" }}>
        {e.status === "queued" ? "Waiting for earlier runs to finish" : "Playing"}
        {games_ahead ? ` (${games_ahead} games ahead in the queue)` : ""}. This page checks every 5 seconds; you can leave and come back.
      </p>
    </section>
  );
}

function Results({ e, s }: { e: ExperimentDetail; s: Summary }) {
  const level = `${Math.round(s.level * 100)}%`;
  const cancelled = e.status === "cancelled";
  const d = s.paired.delta_win_rate;
  const ci = s.paired.delta_ci;
  const bound = deltaBound([ci?.[0], ci?.[1], d]);
  const top = rateCeiling([s.base.wilson?.[1], s.variant.wilson?.[1]]);
  const ticks = (max: number) => [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= max + 1e-9).map((t) => ({ at: t, label: pct(t) }));
  const row = (key: "base" | "variant") => {
    const st = s[key];
    const label = key === "base" ? e.base?.label ?? "Base list" : "Changed list";
    return {
      key,
      label: (
        <>
          <b>{key === "base" ? "Base list" : "Changed list"}</b>
          <span>{key === "base" ? label : changeShort(e)}</span>
        </>
      ),
      value: st.win_rate,
      lo: st.wilson?.[0] ?? null,
      hi: st.wilson?.[1] ?? null,
      dim: key === "base",
      aria: `${key === "base" ? "Base list" : "Changed list"}: won ${pct(st.win_rate)} of ${st.games} scored games${st.wilson ? `, ${level} interval ${pctRange(st.wilson[0], st.wilson[1])}` : ""}`,
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
      <p className="lab-verdict">{verdictText(e.status, s)}</p>
      <p className="dim" style={{ marginTop: 0 }}>
        {d != null && ci
          ? `The changed list won ${moreOften(d)} the base on the same ${s.paired.pods} pods (${pointsWord(d)}, ${level} interval ${pointsRange(ci)}).`
          : cancelled
            ? "Too few pods where both lists finished."
            : "Not enough pods where both lists finished yet."}
        {cancelled ? " The rest of the games were cancelled." : !s.verdict.final ? " More games are still to come." : ""}
      </p>

      {d != null && ci && (
        <IntervalChart
          caption="Difference in win rate, changed list minus base"
          rows={[
            {
              key: "delta",
              label: (
                <>
                  <b>Difference</b>
                  <span>changed minus base</span>
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
            <tr><td>Both lists won</td><td className="r num">{s.paired.both_won}</td></tr>
            <tr><td>Only the changed list won</td><td className="r num">{s.paired.variant_only}</td></tr>
            <tr><td>Only the base won</td><td className="r num">{s.paired.base_only}</td></tr>
            <tr><td>Neither won</td><td className="r num">{s.paired.neither}</td></tr>
            {s.paired.split_builds > 0 && <tr><td>Left out: the two games ran on different builds</td><td className="r num">{s.paired.split_builds}</td></tr>}
            <tr><td>Games nobody won (draws, turn or action cap)</td><td className="r num">{s.no_winner.total}</td></tr>
            <tr><td>Not scored (out of time {s.unscored.time_cap}, crashed {s.unscored.panic}, errors {s.unscored.error})</td><td className="r num">{s.unscored.total}</td></tr>
          </tbody>
        </table>
        <p className="lab-note">{s.method}</p>
      </details>
      <SimLine>{experimentLabel(e)}.{s.builds.length > 1 ? ` Played on ${s.builds.length} builds: ${s.builds.map((b) => `${b.games} games on ${b.engine}, card data ${shortHash(b.card_data)}, runner ${shortHash(b.runner)}`).join("; ")}.` : ""}</SimLine>
      <p className="lab-caveat">{caveat(e.label.engine)} These numbers are apart from your playgroup's real games.</p>
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
        {e.field?.label.replace(/^./, (c) => c.toLowerCase()) ?? "unknown"}. {e.label.difficulty} AI, {e.label.games} games ({e.label.games / 2} pods, each played by both lists).
        The lists were frozen when the run was made.
      </p>
      {e.warnings.length > 0 && (
        <details className="small">
          <summary>
            {e.warnings.length} {e.warnings.length === 1 ? "note" : "notes"} from the deck check
          </summary>
          <ul className="lab-note">{e.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}
      <details className="small">
        <summary>Opponents ({e.opponents.length})</summary>
        <ul className="lab-note">
          {e.opponents.map((o) => (
            <li key={o.id}>
              {(o.source as { kind?: string; id?: string }).kind === "precon" ? <Link to={`/decks/lab/p/${(o.source as { id: string }).id}`}>{o.label}</Link> : o.label}, in {o.pods}{" "}
              {o.pods === 1 ? "pod" : "pods"}
            </li>
          ))}
        </ul>
      </details>
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

function Pods({ id, done, status }: { id: string; done: number; status: ExperimentStatus }) {
  const [open, setOpen] = useState(false);
  const pods = useQuery({
    queryKey: ["lab", "pods", id, done],
    queryFn: () => api<PodView[]>(`/api/lab/experiments/${id}/pods`),
    enabled: open,
    placeholderData: (prev) => prev,
  });
  const played = (pods.data ?? []).filter((p) => p.base || p.variant);
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
        <summary>Every game ({done} played)</summary>
        <ErrorText error={pods.error} />
        {pods.isPending && open && <p className="dim small">Loading…</p>}
        {played.length > 0 && (
          <div className="lab-scroll">
            <table className="lab-pods">
              <thead>
                <tr>
                  <th>Pod</th>
                  <th>Seat</th>
                  <th>Opponents</th>
                  <th>Base</th>
                  <th>Changed</th>
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
                    <td>{cell(p.variant)}</td>
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
