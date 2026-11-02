import { deckStats, MANA, type CurveBucket, type DeckStats as Stats, type StatCard } from "@yama/core";
import { useMemo, useState } from "react";
import type { DeckEntry } from "../api";
import { Details } from "./ui";
import "./decks.css";

/** The deck page's cards in the shape packages/core's counting rules read. */
export function statCards(cards: DeckEntry[]): StatCard[] {
  return cards.map((e) => ({
    name: e.name,
    qty: e.qty,
    board: e.board,
    cmc: e.card?.cmc ?? null,
    typeLine: e.card?.type_line ?? null,
    manaCost: e.card?.mana_cost ?? null,
    producedMana: e.produced_mana,
    oracleText: e.card?.oracle_text ?? null,
  }));
}

/** Deck stats, worked out on the device from the deck as loaded: curve, averages, lands, and
 *  colored pips against the lands that make each color. */
export function DeckStatsPanel({ cards }: { cards: DeckEntry[] }) {
  const s = useMemo(() => deckStats(statCards(cards)), [cards]);
  if (s.cards === 0) return null;
  const creatures = s.curve.reduce((n, b) => n + b.creatures, 0);
  return (
    <section className="deck-panel deck-stats" aria-labelledby="stats-head">
      <div className="deck-panel-head">
        <h2 id="stats-head">Deck stats</h2>
        <span className="note">{s.cards} cards in commander and main deck</span>
      </div>
      <div className="dstat-row">
        <div className="dstat">
          <span className="label">Lands</span>
          <span className="value">{s.lands}</span>
          <span className="note">{Math.round(s.lands / s.cards * 100)}% of the deck</span>
        </div>
        <div className="dstat">
          <span className="label">Average mana value</span>
          <span className="value">{s.averageMvNonland?.toFixed(2) ?? "—"}</span>
          <span className="note">Without lands{s.averageMv != null && ` (${s.averageMv.toFixed(2)} with lands)`}</span>
        </div>
        <div className="dstat">
          <span className="label">Creatures</span>
          <span className="value">{creatures}</span>
          <span className="note">{s.nonlands - creatures} other spells</span>
        </div>
      </div>
      <div className="dstat-charts">
        <Curve curve={s.curve} />
        <PipTable s={s} />
      </div>
      {s.unknownCards.length > 0 && (
        <p className="note">Not in the card data, so left out of the stats: {s.unknownCards.join(", ")}.</p>
      )}
      <details className="dstat-notes">
        <summary className="small">How these stats are counted</summary>
        <p className="note">Commander and main deck count; sideboard excluded. Double-faced cards use the front face, with either land face counted for land access. Hybrid pips count in both colors.</p>
      </details>
    </section>
  );
}

const LABEL = (mv: number) => (mv === 7 ? "7+" : String(mv));

/** Mana curve: one column per mana value, creatures at the base, other spells above. */
function Curve({ curve }: { curve: CurveBucket[] }) {
  const [tip, setTip] = useState<string | null>(null);
  const slot = 45;
  const bar = 22;
  const plot = 110;
  const top = 18;
  const gap = 2;
  const width = slot * curve.length;
  const height = top + plot + 22;
  const max = Math.max(1, ...curve.map((b) => b.creatures + b.others));
  const scale = (n: number) => (n / max) * plot;
  const describe = (b: CurveBucket) => {
    const total = b.creatures + b.others;
    const mv = b.mv === 7 ? "7 or more mana" : `${b.mv} mana`;
    return `${mv}: ${total} ${total === 1 ? "card" : "cards"}, ${b.creatures} ${b.creatures === 1 ? "creature" : "creatures"} and ${b.others} other ${b.others === 1 ? "spell" : "spells"}`;
  };

  return (
    <div className="curve-wrap">
      <h3>Mana curve</h3>
      <ul className="curve-legend" aria-hidden="true">
        <li><span className="curve-swatch creatures" />Creatures</li>
        <li><span className="curve-swatch others" />Other spells</li>
      </ul>
      <svg className="curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Mana curve. ${curve.map(describe).join(". ")}.`}>
        {curve.map((b, i) => {
          const x = i * slot + (slot - bar) / 2;
          const base = top + plot;
          const hc = scale(b.creatures);
          const ho = scale(b.others);
          const both = b.creatures > 0 && b.others > 0;
          const othersBase = base - hc - (both ? gap : 0);
          const total = b.creatures + b.others;
          const capY = base - hc - ho - (both ? gap : 0) - 5;
          return (
            <g
              key={b.mv}
              className="col"
              tabIndex={0}
              aria-label={describe(b)}
              onMouseEnter={() => setTip(describe(b))}
              onMouseLeave={() => setTip(null)}
              onFocus={() => setTip(describe(b))}
              onBlur={() => setTip(null)}
              onClick={() => setTip(describe(b))}
            >
              <title>{describe(b)}</title>
              <rect className="hit" x={i * slot} y={0} width={slot} height={base} rx={4} />
              {b.creatures > 0 && <path className="creatures" d={column(x, base - hc, bar, hc, b.others === 0)} />}
              {b.others > 0 && <path className="others" d={column(x, othersBase - ho, bar, ho, true)} />}
              {total > 0 && (
                <text className="cap" x={x + bar / 2} y={capY} textAnchor="middle">{total}</text>
              )}
              <text className="tick" x={x + bar / 2} y={base + 16} textAnchor="middle">{LABEL(b.mv)}</text>
            </g>
          );
        })}
        <line className="baseline" x1={0} x2={width} y1={top + plot + 0.5} y2={top + plot + 0.5} />
      </svg>
      <p className="curve-tip" aria-live="polite">{tip}</p>
      <details>
        <summary className="small">Curve as a table</summary>
        <table className="curve-table">
          <thead>
            <tr><th scope="row">Mana value</th>{curve.map((b) => <th key={b.mv} scope="col">{LABEL(b.mv)}</th>)}</tr>
          </thead>
          <tbody>
            <tr><th scope="row">Creatures</th>{curve.map((b) => <td key={b.mv}>{b.creatures}</td>)}</tr>
            <tr><th scope="row">Other spells</th>{curve.map((b) => <td key={b.mv}>{b.others}</td>)}</tr>
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** A column segment growing up from y + h: square at the bottom, 4px rounded top when it's the
 *  topmost segment. */
function column(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function PipTable({ s }: { s: Stats }) {
  if (!s.colors.length) return null;
  // Different units: scale each column independently, never imply a target pip/source ratio.
  const maxPips = Math.max(1, ...s.colors.map((c) => c.pips));
  const maxSources = Math.max(1, ...s.colors.map((c) => c.sources ?? 0));
  return (
    <div className="mana-balance">
      <h3>Mana colors</h3>
      <table className="pip-table">
        <thead>
          <tr>
            <th scope="col">Color</th>
            <th scope="col">Pips</th>
            <th scope="col">Land access</th>
          </tr>
        </thead>
        <tbody>
          {s.colors.map((c) => (
            <tr key={c.color}>
              <th scope="row">
                <span className="color">
                  <span className="pip" style={{ background: MANA[c.color].fill }} aria-hidden="true" />
                  {MANA[c.color].name}
                </span>
              </th>
              <td>
                <span className="mana-count">{c.pips}</span>
                <span className="mana-track" aria-hidden="true"><span style={{ width: `${c.pips / maxPips * 100}%` }} /></span>
              </td>
              <td>
                {c.sources == null ? <span className="dim">Not counted</span> : <>
                  <span className="mana-count">{c.sources}</span>
                  <span className="mana-track sources" aria-hidden="true"><span style={{ width: `${c.sources / maxSources * 100}%` }} /></span>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Details label="About mana colors and consistency">
        <p>Pips in spell costs and potential land access. Bars compare colors within each column; each column has its own scale.</p>
        <p>Access includes fetch lands with matching targets, land back faces and conditional producers. Shared sources count in each color, without guaranteeing mana on a given turn. Mana rocks, creatures and spell abilities aren't included.</p>
        <p className="note">Total pip ratios alone can't establish a shortage. Casting estimates need a target turn, draw and mulligan assumptions, and a model of tapped lands, shared sources and ramp. See <a href="https://www.tcgplayer.com/content/article/How-Many-Sources-Do-You-Need-to-Consistently-Cast-Your-Spells-A-2022-Update/dc23a7d2-0a16-4c0b-ad36-586fcca03ad8/" target="_blank" rel="noreferrer">Frank Karsten's source-requirement method</a>.</p>
      </Details>
      {s.landsWithoutManaData.length > 0 && <p className="note">
        {
          (s.landsWithManaData === 0
            ? "Land sources aren't counted yet: which colors each land makes comes with the next card data import."
            : `Land sources aren't counted until the next card data import brings the mana of ${s.landsWithoutManaData.join(", ")}.`)}
      </p>}
    </div>
  );
}
