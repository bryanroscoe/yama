import { deckStats, MANA, type CurveBucket, type DeckStats as Stats } from "@yama/core";
import { useMemo, useState } from "react";
import type { DeckEntry } from "../api";
import "./decks.css";

/** Deck stats, worked out on the device from the deck as loaded: curve, averages, lands, and
 *  colored pips against the lands that make each color. */
export function DeckStatsPanel({ cards }: { cards: DeckEntry[] }) {
  const s = useMemo(
    () =>
      deckStats(
        cards.map((e) => ({
          name: e.name,
          qty: e.qty,
          board: e.board,
          cmc: e.card?.cmc ?? null,
          typeLine: e.card?.type_line ?? null,
          manaCost: e.card?.mana_cost ?? null,
          producedMana: e.produced_mana,
          oracleText: e.card?.oracle_text ?? null,
        })),
      ),
    [cards],
  );
  if (s.cards === 0) return null;
  return (
    <section className="deck-panel" aria-labelledby="stats-head">
      <h2 id="stats-head">Deck stats</h2>
      <div className="dstat-row">
        <div className="dstat">
          <span className="label">Lands</span>
          <span className="value">{s.lands} <small>of {s.cards}</small></span>
        </div>
        <div className="dstat">
          <span className="label">Average mana value</span>
          <span className="value">
            {s.averageMvNonland?.toFixed(2) ?? "none"}{" "}
            <small>without lands{s.averageMv != null && `, ${s.averageMv.toFixed(2)} with them`}</small>
          </span>
        </div>
      </div>
      <Curve curve={s.curve} />
      <PipTable s={s} />
      {s.unknownCards.length > 0 && (
        <p className="note">Not in the card data, so left out of the stats: {s.unknownCards.join(", ")}.</p>
      )}
      <p className="note">Commander and main deck. Double-faced cards count by their front face, except that a land on either face counts as a source.</p>
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
      <h3 style={{ fontSize: "var(--t-base)", margin: 0 }}>Mana curve</h3>
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
      <p className="curve-tip" aria-live="polite">{tip ?? "Mana value along the bottom. Hover or focus a column for its split."}</p>
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
  return (
    <div>
      <h3 style={{ fontSize: "var(--t-base)", margin: "0 0 0.4rem" }}>Colored pips and land sources</h3>
      <table className="pip-table">
        <thead>
          <tr>
            <th scope="col">Color</th>
            <th scope="col">Pips</th>
            <th scope="col">Land sources</th>
            <th scope="col" className="status">Sources per 3 pips</th>
          </tr>
        </thead>
        <tbody>
          {s.colors.map((c) => (
            <tr key={c.color}>
              <td>
                <span className="color">
                  <span className="pip" style={{ background: MANA[c.color].fill }} aria-hidden="true" />
                  {MANA[c.color].name}
                </span>
              </td>
              <td>{c.pips}</td>
              <td>{c.sources ?? <span className="dim">not counted yet</span>}</td>
              <td className="status">
                {c.sources == null ? (
                  <span className="dim">not known yet</span>
                ) : c.short ? (
                  <span className="short-flag">
                    <WarnIcon />
                    {((c.sources * 3) / c.pips).toFixed(1)}, short
                  </span>
                ) : (
                  ((c.sources * 3) / c.pips).toFixed(1)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: "0.4rem" }}>
        "Short" means fewer than one land source for every three pips of that color. Hybrid pips count for both colors; mana rocks and creatures aren't counted.
        {s.landsWithoutManaData.length > 0 &&
          (s.landsWithManaData === 0
            ? " Land sources aren't counted yet: which colors each land makes comes with the next card data import."
            : ` Land sources aren't counted until the next card data import brings the mana of ${s.landsWithoutManaData.join(", ")}.`)}
      </p>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6v3.6M8 11.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
