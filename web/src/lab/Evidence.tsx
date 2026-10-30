import { Details } from "../components/ui";
import type { CommanderObservation, PreconEvidence, RatingV2, RealHistory } from "./api";
import { fmtDate } from "./logic";

const rate = (x: number, digits = 1) => `${x.toFixed(digits)}%`;

/** Words for a trend in points per 30 days; small moves read as steady. */
export function trendText(points: number | null | undefined): string | null {
  if (points == null || !Number.isFinite(points)) return null;
  if (Math.abs(points) < 0.5) return "Steady over the snapshots.";
  return `${points < 0 ? "Falling" : "Rising"} about ${Math.abs(points).toFixed(1)} points a month.`;
}

function History({ real }: { real: RealHistory }) {
  const intervals = new Map(real.intervals.map((i) => [i.to, i]));
  const rows = [...real.snapshots].reverse();
  const datasets = real.source.datasets.map((d) => `${d.id} revision ${d.revision}, imported ${fmtDate(d.imported_at)}`).join("; ");
  return (
    <>
      <p style={{ margin: 0 }}>
        All time: {rate(real.latest.rate)} wins in 4-player pods over {real.latest.games.toLocaleString()} games, as of {fmtDate(real.latest.as_of)}.
      </p>
      {real.recent && (
        <p style={{ margin: 0 }}>
          Games since {fmtDate(real.recent.from)}: about {rate(real.recent.rate)} over {real.recent.games.toLocaleString()} newer games.{" "}
          {trendText(real.trend_points_per_30_days)}
        </p>
      )}
      <p className="lab-note">
        From {real.url ? <a href={real.url} target="_blank" rel="noreferrer">{real.entity_name}</a> : real.entity_name} on {real.source.name}. {real.source.attribution}, {real.source.license}.
      </p>
      <Details label="Snapshots and method">
        <table className="lab-evidence">
          <thead>
            <tr><th>Snapshot</th><th className="num">Games</th><th className="num">All-time rate</th><th className="num">New games</th><th className="num">Rate on new games</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const i = intervals.get(s.as_of);
              return (
                <tr key={s.as_of}>
                  <td>{fmtDate(s.as_of)}</td>
                  <td className="num">{s.games.toLocaleString()}</td>
                  <td className="num">{rate(s.rate, 2)}</td>
                  <td className="num">{i ? i.games.toLocaleString() : ""}</td>
                  <td className="num">{i ? rate(i.rate) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>{real.method}</p>
        {real.notes.length > 0 && <ul>{real.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <p>Datasets: {datasets}. Linked by {real.matched_by === "manual" ? "an operator's choice" : `its ${real.matched_by}`}.</p>
      </Details>
    </>
  );
}

function Commander({ c }: { c: CommanderObservation }) {
  return (
    <p className="lab-note">
      Commander, all lists: {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name} won {rate(c.rate)} of {c.games.toLocaleString()} games on {c.source} in the {c.window_days} days to {fmtDate(c.as_of)}. {c.note}
    </p>
  );
}

/** Dataset-derived real-game evidence, kept apart from simulated numbers. */
export function EvidenceSection({ evidence }: { evidence: PreconEvidence | null | undefined }) {
  if (!evidence?.real && !evidence?.commander) return null;
  return (
    <section className="lab-real">
      <h3>Real games over time</h3>
      {evidence.real && <History real={evidence.real} />}
      {evidence.also?.map((other) => (
        <div key={other.source.name} className="lab-evidence-other">
          <h4>From {other.source.name}</h4>
          <History real={other} />
        </div>
      ))}
      {evidence.commander && <Commander c={evidence.commander} />}
    </section>
  );
}

/** The experimental combined rating for one precon, with whether the simulation earned its place. */
export function RatingV2Section({ v2, id }: { v2: RatingV2 | undefined; id: string }) {
  const e = v2?.precons.find((p) => p.precon === id);
  if (!v2 || !e) return null;
  const real = Math.round(e.real_share * 100);
  return (
    <section className="lab-real">
      <h3>Rating v2 (experimental)</h3>
      <p style={{ margin: 0 }}>
        About {rate(e.rate)} expected wins in 4-player pods ({rate(e.lo)} to {rate(e.hi)}), rank {e.rank} of {v2.ranked}
        {e.rank_lo !== e.rank_hi ? `, somewhere from ${e.rank_lo} to ${e.rank_hi}` : ""}.{" "}
        {real === 100 ? "All of it comes from real games." : real === 0 ? "All of it comes from the simulation." : `${real}% of its weight comes from real games.`}
      </p>
      <p className="lab-note">
        {v2.gate_passed
          ? "The simulation earned its place beside real games in the time-split test."
          : "The simulation hasn't earned a place beside real games in the time-split test, so it only ranks precons without real games."}
      </p>
      <Details label="How it's tested">
        <p>{v2.note}</p>
        {v2.calibration && <p>Test with the split at {fmtDate(v2.split)}, on {v2.calibration.cases} precons and {v2.calibration.held_out_games.toLocaleString()} later games: {v2.calibration.verdict}</p>}
        {v2.simulation && <p>Simulation: {v2.simulation.name} ({v2.simulation.engine}), {v2.simulation.precons} precons.</p>}
      </Details>
    </section>
  );
}
