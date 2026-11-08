import { useQuery } from "@tanstack/react-query";
import { exportDeck } from "@yama/core";
import { useState } from "react";
import { Link } from "react-router";
import { api, type AnalysisSummary, type DeckAnalysis, type DeckAnalysisView, type DeckEntry, type VectorKey } from "../api";
import { localDay } from "../components/deckCheck";
import { NameList } from "../components/OnlineSupport";
import { Details, ErrorText } from "../components/ui";
import "./deckAnalysis.css";

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

/** "Bracket 3's usual range (5 to 7)" for where the power level sits. */
export function powerBracketText(a: Pick<DeckAnalysis, "power" | "power_bracket">): string {
  const range = a.power_bracket === 2 ? "up to 5" : a.power_bracket === 3 ? "above 5, up to 7" : "above 7";
  return `${a.power.toFixed(1)} is in Bracket ${a.power_bracket}'s usual range (${range}). Your declared bracket is still yours to choose: intent and the table matter more than a score.`;
}

/** Room either side of the pentagon for the side labels ("Consistency"). */
const SIDE = 56;

/** The five vectors on a pentagon, the reference precon (40) dashed behind. */
export function Radar({ scores, size = 200 }: { scores: Record<VectorKey, number>; size?: number }) {
  const c = size / 2;
  const r = size / 2 - 26;
  const at = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / VECTORS.length;
    return [c + Math.cos(a) * r * (v / 100), c + Math.sin(a) * r * (v / 100)] as const;
  };
  const poly = (vals: number[]) => vals.map((v, i) => at(i, v).join(",")).join(" ");
  return (
    <svg className="analysis-radar" viewBox={`${-SIDE} 0 ${size + 2 * SIDE} ${size}`} width={size + 2 * SIDE} height={size} role="img" aria-label={VECTORS.map((v) => `${v.label} ${Math.round(scores[v.key])}`).join(", ")}>
      {[25, 50, 75, 100].map((g) => (
        <polygon key={g} className="grid" points={poly(VECTORS.map(() => g))} />
      ))}
      <polygon className="reference" points={poly(VECTORS.map(() => 40))} />
      <polygon className="deck" points={poly(VECTORS.map((v) => scores[v.key]))} />
      {VECTORS.map((v, i) => {
        const [x, y] = at(i, 122);
        return (
          <text key={v.key} x={x} y={y} textAnchor={Math.abs(x - c) < 4 ? "middle" : x < c ? "end" : "start"} dominantBaseline="middle">
            {v.short}
          </text>
        );
      })}
    </svg>
  );
}

function scoresOf(a: DeckAnalysis): Record<VectorKey, number> {
  return Object.fromEntries(a.vectors.map((v) => [v.key, v.score])) as Record<VectorKey, number>;
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
      <button type="button" className="quiet small" onClick={() => void go()}>
        Check it on ScryCheck <span aria-hidden="true">↗</span><span className="visually-hidden"> (copies the list and opens a new tab)</span>
      </button>
      <p className="small dim" role="status">
        {state === "opened" && <>List copied. In the ScryCheck tab, choose Paste list and paste it. Its formula is its own, so its numbers won't match these exactly.</>}
        {state === "blocked" && <>List copied. {open}, choose Paste list and paste it.</>}
        {state === "manual" && <>Copy this list, then {open}, choose Paste list and paste it.</>}
      </p>
      {state === "manual" && <textarea className="scrycheck-list" readOnly rows={8} value={text} aria-label="Deck list to paste into ScryCheck" />}
    </div>
  );
}

/** The deck page's analysis: power level, the five vectors, themes, how it adds up, and how
 *  it moved across saved versions and configurations. */
export function DeckAnalysisPanel({ deckId, versionId, cards, onCard }: { deckId: string; versionId: string | null; cards: DeckEntry[]; onCard: (name: string) => void }) {
  const q = useDeckAnalysis(deckId, versionId);
  const a = q.data?.current ?? null;
  return (
    <section className="deck-panel deck-analysis" aria-labelledby="analysis-head">
      <div className="deck-panel-head">
        <h2 id="analysis-head">Power level</h2>
        <ScryCheckButton cards={cards} />
      </div>
      <ErrorText error={q.error} />
      {q.isPending && versionId != null && <p className="dim small">Working it out…</p>}
      {versionId == null && <p className="dim small">Add cards to see the deck's power level.</p>}
      {a && (
        <>
          <div className="analysis-top">
            <div className="analysis-score">
              <p className="analysis-power">
                <span className="value">{a.power.toFixed(1)}</span>
                <span className="margin">±{a.margin.toFixed(1)}</span>
              </p>
              <p className="analysis-label"><b>{a.label}</b></p>
              <p className="small">{a.description}</p>
              <p className="small dim">{confidenceText(a)}</p>
              <p className="small dim">{powerBracketText(a)}</p>
            </div>
            <Radar scores={scoresOf(a)} />
          </div>
          <ul className="analysis-vectors">
            {a.vectors.map((v) => (
              <li key={v.key}>
                <span className="vector-label">{v.label}</span>
                <span className="vector-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, v.score))}%` }} /></span>
                <span className="num">{Math.round(v.score)}</span>
                <span className="small dim">{v.band}</span>
              </li>
            ))}
          </ul>
          <p className="small dim">Out of 100: about 40 is a typical stock precon, 75 a typical Bracket 4 build, 95 a cEDH list.</p>
          {a.caps.map((c) => <p key={c.reason} className="small">{c.note}</p>)}
          {a.themes.length > 0 && <Themes analysis={a} onCard={onCard} />}
          <Breakdown analysis={a} onCard={onCard} />
          <AnalysisHistory view={q.data!} />
        </>
      )}
    </section>
  );
}

function confidenceText(a: DeckAnalysis): string {
  const why: string[] = [];
  if (!a.combos.checked) why.push("Commander Spellbook hasn't checked this list for combos yet");
  else if (a.combos.unrecognized) why.push(`Commander Spellbook didn't know ${a.combos.unrecognized} ${a.combos.unrecognized === 1 ? "card" : "cards"}, so combos with ${a.combos.unrecognized === 1 ? "it" : "them"} may be missing`);
  if (a.unknown_cards.length) why.push(`${a.unknown_cards.length} ${a.unknown_cards.length === 1 ? "card isn't" : "cards aren't"} in Yama's card data`);
  if (a.nonland > 0 && a.unscored / a.nonland > 0.35) why.push("many cards do things the text rules don't score");
  const level = a.confidence === "high" ? "High" : a.confidence === "medium" ? "Medium" : "Low";
  return `${level} confidence${why.length ? `: ${why.join("; ")}` : ""}. An unofficial Yama estimate from card text, not from how the deck plays.`;
}

function Themes({ analysis, onCard }: { analysis: DeckAnalysis; onCard: (name: string) => void }) {
  return (
    <div className="analysis-themes">
      <h3 className="bracket-subhead">Themes</h3>
      <ul>
        {analysis.themes.map((t) => (
          <li key={t.key}>
            <details>
              <summary>
                <b>{t.label}</b> <span className="dim small">{t.strength === "core" ? "Core" : t.strength === "major" ? "Major" : "Minor"}, {t.count} cards</span>
              </summary>
              <p className="small">{t.description}</p>
              <p className="small names"><NameList names={t.cards} onCard={onCard} /></p>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Breakdown({ analysis, onCard }: { analysis: DeckAnalysis; onCard: (name: string) => void }) {
  const a = analysis;
  return (
    <Details label="How it adds up">
      <p>
        Each card earns points for what its text does, cheaper cards more, and your commander half again because it's always there. A vector adds its cards up, each
        next-best card counting a little less, and compares the total with Yama's reference lists. The power level weighs Speed and Consistency most, then Interaction,
        then Threats; a weak mana base takes a little off and can cap it. Other sites use their own formulas.
      </p>
      {a.vectors.map((v) => (
        <div key={v.key} className="analysis-group">
          <h4>
            {v.label} <span className="num">{Math.round(v.score)}</span>
          </h4>
          {v.groups.length === 0 && <p className="small dim">Nothing counted.</p>}
          {v.groups.map((g) => (
            <p key={g.key} className="small">
              <b>{g.label}</b> <span className="dim">{g.cards.length}</span>
              <br />
              <span className="names">
                {g.cards.map((c, i) => (
                  <span key={c.name + i}>
                    {i > 0 && ", "}
                    {c.copies > 1 && `${c.copies} `}
                    <NameList names={[c.name]} onCard={onCard} /> <span className="dim">{c.points.toFixed(1)}</span>
                  </span>
                ))}
              </span>
            </p>
          ))}
          {v.key === "mana" && <p className="small dim">A land's points are its quality for this deck's colors, out of 10.</p>}
          {v.groups.some((g) => g.cards.some((c) => c.copies > 1)) && v.key !== "mana" && <p className="small dim">Points are per copy; every copy counts.</p>}
          {v.key === "threats" && (
            <p className="small dim">
              {a.combos.checked
                ? a.combos.lines.length
                  ? `Commander Spellbook found ${a.combos.lines.length} combo ${a.combos.lines.length === 1 ? "line" : "lines"} in ${a.combos.families} ${a.combos.families === 1 ? "group" : "groups"}; they add to Threats and to the power level, compact game-ending lines most.`
                  : "Commander Spellbook found no combos in this list."
                : "Combos count once Commander Spellbook has checked this list."}
            </p>
          )}
        </div>
      ))}
      {a.unknown_cards.length > 0 && (
        <p className="small">Not in Yama's card data, so not counted: <NameList names={a.unknown_cards} onCard={onCard} /></p>
      )}
    </Details>
  );
}

/** Power across saved versions (oldest left), and each configuration side by side. */
export function AnalysisHistory({ view }: { view: DeckAnalysisView }) {
  const versions = view.versions;
  const configs = view.configurations.filter((c) => c.power != null);
  if (versions.length < 2 && configs.length < 2) return null;
  return (
    <div className="analysis-history">
      {versions.length >= 2 && (
        <>
          <h3 className="bracket-subhead">Over time</h3>
          <PowerLine points={[...versions].reverse()} />
          <Details label="Every saved version">
            <ScoreTable rows={versions.map((v) => ({ key: v.id, name: `Version ${v.number}${v.current ? " (current)" : ""}`, sub: localDay(v.created_at), note: v.note, summary: v }))} />
          </Details>
        </>
      )}
      {configs.length >= 2 && (
        <>
          <h3 className="bracket-subhead">Configurations</h3>
          <ScoreTable
            rows={configs.map((c) => ({
              key: c.id,
              name: c.configuration ?? "Main deck",
              link: c.this ? undefined : `/decks/${c.id}`,
              sub: c.this ? "This one" : undefined,
              summary: c as AnalysisSummary,
            }))}
          />
        </>
      )}
      <p className="small dim">Worked out from each saved list; combos count where Commander Spellbook checked that list.</p>
    </div>
  );
}

function PowerLine({ points }: { points: { id: string; number: number; power: number; created_at: string }[] }) {
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
            <title>{`Version ${p.number}, ${localDay(p.created_at)}: ${p.power.toFixed(1)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="small dim">
        Version {first.number}: {first.power.toFixed(1)}. Version {last.number}: {last.power.toFixed(1)}.
      </figcaption>
    </figure>
  );
}

function ScoreTable({ rows }: { rows: { key: string; name: string; link?: string; sub?: string; note?: string | null; summary: AnalysisSummary }[] }) {
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
