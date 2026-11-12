import { useQuery } from "@tanstack/react-query";
import { exportDeck, fmtDate } from "@yama/core";
import { useState } from "react";
import { Link } from "react-router";
import { api, type AnalysisSummary, type DeckAnalysisView, type DeckEntry, type VectorKey } from "../api";
import "./deckAnalysis.css";
import { Button } from "../components/ui";

export const VECTORS: { key: VectorKey; label: string; short: string }[] = [
  { key: "speed", label: "Speed", short: "Speed" },
  { key: "consistency", label: "Consistency", short: "Consistency" },
  { key: "interaction", label: "Interaction", short: "Interaction" },
  { key: "mana", label: "Mana base", short: "Mana" },
  { key: "threats", label: "Threats", short: "Threats" },
];

const SCRYCHECK = "https://scrycheck.com/";

export function useDeckAnalysis(deckId: string, versionId: string | null) {
  return useQuery({
    queryKey: ["deck-analysis", deckId, versionId],
    queryFn: ({ signal }) => api<DeckAnalysisView>(`/api/decks/${deckId}/analysis`, { signal }),
    enabled: versionId != null,
  });
}

/**
 * Copies the list, then opens ScryCheck in a new tab to paste it into: ScryCheck takes a
 * pasted list or a Moxfield or Archidekt link, and nothing can fill its box from here. Nothing
 * goes to ScryCheck until you paste and press Analyze there.
 */
export function ScryCheckButton({ cards }: { cards: DeckEntry[] }) {
  const [state, setState] = useState<"idle" | "opened" | "blocked" | "manual">("idle");
  const text = exportDeck(cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board })), "names");
  const go = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setState("manual");
      return;
    }
    // Without "noopener" so a blocked pop-up shows as null; the new tab gets no handle back.
    const tab = window.open(SCRYCHECK, "_blank");
    if (tab) tab.opener = null;
    setState(tab ? "opened" : "blocked");
  };
  const open = <a href={SCRYCHECK} target="_blank" rel="noopener noreferrer">Open ScryCheck<span className="visually-hidden"> (opens in a new tab)</span></a>;
  return (
    <div className="scrycheck-open">
      <Button variant="quiet" size="small" onClick={() => void go()}>
        Check it on ScryCheck <span aria-hidden="true">↗</span><span className="visually-hidden"> (copies the list and opens a new tab)</span>
      </Button>
      <p className="small dim" role="status">
        {state === "opened" && <>List copied. In the ScryCheck tab, choose Paste list and paste it. Its formula is its own, so its numbers won't match these exactly.</>}
        {state === "blocked" && <>List copied. {open}, choose Paste list and paste it.</>}
        {state === "manual" && <>Copy this list, then {open}, choose Paste list and paste it.</>}
      </p>
      {state === "manual" && <textarea className="scrycheck-list" readOnly rows={8} value={text} aria-label="Deck list to paste into ScryCheck" />}
    </div>
  );
}

/** Power across saved versions, oldest left. */
export function PowerLine({ points }: { points: { id: string; number: number; power: number; created_at: string }[] }) {
  const w = 320;
  const h = 96;
  const pad = 14;
  const lo = Math.max(1, Math.floor(Math.min(...points.map((p) => p.power)) - 0.5));
  const hi = Math.min(10, Math.ceil(Math.max(...points.map((p) => p.power)) + 0.5));
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (v: number) => h - pad - ((v - lo) * (h - 2 * pad)) / Math.max(0.5, hi - lo);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <figure className="analysis-line">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Power level from ${first.power.toFixed(1)} at version ${first.number} to ${last.power.toFixed(1)} at version ${last.number}`}>
        <line className="axis" x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} />
        <text className="tick" x={2} y={y(hi)} dominantBaseline="middle">{hi}</text>
        <text className="tick" x={2} y={y(lo)} dominantBaseline="middle">{lo}</text>
        <polyline points={points.map((p, i) => `${x(i)},${y(p.power)}`).join(" ")} />
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.power)} r={3}>
            <title>{`Version ${p.number}, ${fmtDate(p.created_at)}: ${p.power.toFixed(1)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="small dim">
        Version {first.number}: {first.power.toFixed(1)}. Version {last.number}: {last.power.toFixed(1)}.
      </figcaption>
    </figure>
  );
}

/** Power and the five scores for each list of the deck. */
export function ScoreTable({ rows }: { rows: { key: string; name: string; link?: string; sub?: string; note?: string | null; summary: AnalysisSummary }[] }) {
  return (
    <div className="analysis-table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            <th scope="col">List</th>
            <th scope="col">Power</th>
            {VECTORS.map((v) => <th key={v.key} scope="col">{v.short}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">
                {r.link ? <Link to={r.link}>{r.name}</Link> : r.name}
                {r.sub && <span className="small dim"> {r.sub}</span>}
                {r.note && <span className="small dim note">{r.note}</span>}
              </th>
              <td className="num">{r.summary.power.toFixed(1)}</td>
              {VECTORS.map((v) => <td key={v.key} className="num">{Math.round(r.summary.scores[v.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
