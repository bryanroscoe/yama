import type { ReactNode } from "react";
import { ArtPanel as SharedArtPanel } from "../components/ArtPanel";
import { Details } from "../components/ui";
import type { Art, ExperimentStatus } from "./api";
import { linScale, type Scale } from "./logic";

/**
 * The commander's art behind a page's title: the shared ArtPanel (Scryfall's art crop, never
 * filtered, darkened by a wash on top) with the artist credited as Scryfall asks.
 */
export function ArtPanel({ art, children }: { art: Art | null | undefined; children: ReactNode }) {
  return (
    <SharedArtPanel as="header" className="lab-art" art={art?.url} artist={art?.artist} wash="bottom" toGround>
      {children}
    </SharedArtPanel>
  );
}

/**
 * The line every simulated number carries (engine, AI level, games, date), with build hashes
 * folded into a Details disclosure under it.
 */
export function SimLine({ children, details }: { children: ReactNode; details?: ReactNode }) {
  return (
    <>
      <p className="lab-label">{children}</p>
      {details ? <Details>{typeof details === "string" ? <p>{details}</p> : details}</Details> : null}
    </>
  );
}

/**
 * An interval as a range with a point, on a shared axis (`scale` maps a value to 0..1), with an
 * optional hairline reference ("average", "no change"). `dim` draws the comparison, not the
 * measured thing. The label is the accessible name and the hover text.
 */
export function IntervalBar({
  value,
  lo,
  hi,
  scale,
  reference,
  label,
  dim = false,
}: {
  value: number | null | undefined;
  lo?: number | null;
  hi?: number | null;
  scale: Scale;
  reference?: number;
  label: string;
  dim?: boolean;
}) {
  const at = (v: number) => `${(scale(v) * 100).toFixed(2)}%`;
  return (
    <span className={`ibar${dim ? " dim" : ""}`} role="img" aria-label={label} title={label}>
      {reference != null && <span className="ibar-ref" style={{ left: at(reference) }} />}
      {lo != null && hi != null && <span className="ibar-range" style={{ left: at(lo), width: `${((scale(hi) - scale(lo)) * 100).toFixed(2)}%` }} />}
      {value != null && <span className="ibar-dot" style={{ left: at(value) }} />}
    </span>
  );
}

export interface ChartRow {
  key: string;
  label: ReactNode;
  value: number | null;
  lo: number | null;
  hi: number | null;
  text: ReactNode;
  aria: string;
  dim?: boolean;
}

/** Rows of interval bars on one axis, with tick labels underneath. */
export function IntervalChart({
  rows,
  domain,
  ticks,
  reference,
  caption,
}: {
  rows: ChartRow[];
  domain: [number, number];
  ticks: { at: number; label: string }[];
  reference?: number;
  caption?: string;
}) {
  const scale = linScale(domain[0], domain[1]);
  return (
    <figure className="ichart" style={{ margin: 0 }} aria-label={caption}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "contents" }}>
          <div className="ichart-label">{r.label}</div>
          <div className="ichart-bar">
            <IntervalBar value={r.value} lo={r.lo} hi={r.hi} scale={scale} reference={reference} label={r.aria} dim={r.dim} />
            <span className="ichart-value">{r.text}</span>
          </div>
        </div>
      ))}
      <div className="ichart-axis-pad" />
      <div className="ichart-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.at} style={{ left: `${scale(t.at) * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

const STATUS: Record<ExperimentStatus, string> = {
  queued: "Waiting",
  running: "Playing",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusTag({ status }: { status: ExperimentStatus }) {
  return <span className={`lab-status ${status}`}>{STATUS[status]}</span>;
}
