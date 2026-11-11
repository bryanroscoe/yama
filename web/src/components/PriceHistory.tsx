import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { usd } from "@yama/core";

interface Point {
  date: string;
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
}

// One series, so no legend: the heading names it. White is the night table's only accent, so the
// line and its current-point dot are drawn in the text color.
const LINE = "var(--text)";
const W = 300;
const H = 72;
const PAD = { top: 8, right: 8, bottom: 8, left: 8 };

/**
 * What the history shows: nothing while it first loads, the failure (with Try again) when the last
 * request failed and there is nothing to show, otherwise the prices. `failure` is the last error
 * seen, kept through a retry.
 */
export function historyView({ hasData, loading }: { hasData: boolean; loading: boolean }, failure: unknown): "wait" | "failed" | "show" {
  if (hasData) return "show";
  if (failure) return "failed";
  return loading ? "wait" : "show";
}

/** Daily market price for one printing and finish, with a hover readout and a table view. */
export function PriceHistory({ scryfallId, finish, setName }: { scryfallId: string; finish: "nonfoil" | "foil" | "etched"; setName: string }) {
  const history = useQuery({ queryKey: ["prices", scryfallId], queryFn: ({ signal }) => api<Point[]>(`/api/printings/${scryfallId}/prices`, { signal }) });
  const [hover, setHover] = useState<number | null>(null);
  const pick = (p: Point) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);
  const points = (history.data ?? []).map((p) => ({ date: p.date, value: pick(p) })).filter((p): p is { date: string; value: number } => p.value !== null);
  const label = `${setName}${finish === "nonfoil" ? "" : ` (${finish})`}`;

  // The last failure stays on screen while Try again is out: the query drops its error (and reads
  // as loading) for the length of the attempt.
  const failure = useRef<unknown>(null);
  if (history.error) failure.current = history.error;
  else if (history.data) failure.current = null;
  const view = historyView({ hasData: history.data !== undefined, loading: history.isPending }, failure.current);
  if (view === "wait") return null;
  // A request that failed says so: it isn't the same as a printing with no price on record.
  if (view === "failed") {
    return (
      <p className="small" role="alert">
        <span className="error">Couldn't load the price history for {label}: {errorMessage(failure.current)}</span>{" "}
        <button type="button" className="small" disabled={history.isFetching} onClick={() => void history.refetch()}>{history.isFetching ? "Trying…" : "Try again"}</button>
      </p>
    );
  }
  if (points.length === 0) return <p className="small dim">No market price recorded for {label}.</p>;
  if (points.length === 1) {
    return <p className="small dim">{label}: {usd(points[0]!.value)} on {points[0]!.date}. The chart fills in as daily prices arrive.</p>;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / span) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const shown = hover === null ? last : points[hover]!;
  const change = last.value - first.value;

  return (
    <figure className="price-history">
      <figcaption className="small">
        <span className="dim">{label}, market price</span>{" "}
        <b className="num">{usd(shown.value)}</b> <span className="dim num">{shown.date}</span>
        {hover === null && (
          <span className="dim num">
            {" "}({change === 0 ? "no change" : `${change > 0 ? "up" : "down"} ${usd(Math.abs(change))}`} since {first.date})
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Market price for ${label} from ${first.date} to ${last.date}: low ${usd(min)}, high ${usd(max)}, latest ${usd(last.value)}`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((rel - PAD.left) / (W - PAD.left - PAD.right)) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={y(min)} y2={y(min)} stroke="var(--line)" strokeWidth="1" />
        <path d={path} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--dim)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(points[hover]!.value)} r="4" fill={LINE} stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
        {hover === null && <circle cx={x(points.length - 1)} cy={y(last.value)} r="4" fill={LINE} stroke="var(--surface)" strokeWidth="2" />}
      </svg>
      <details className="small">
        <summary className="dim">Show as a table</summary>
        <table className="plain">
          <thead><tr><th>Date</th><th className="r">Price</th></tr></thead>
          <tbody>
            {[...points].reverse().map((p) => (
              <tr key={p.date}><td className="num">{p.date}</td><td className="r num">{usd(p.value)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
