// The deck page's Stats tab (/decks/:id/stats), from the redesign canvas's Power level board
// (DeckPower, PhoneDeckPower) and the Stats tab of Deck/PhoneDeck: power level, mana curve,
// color balance, themes, combos, bracket, Game Changers and Reserve List, online play, value and
// results, every section open. Explanations sit behind one "?" per section.

import { useQuery } from "@tanstack/react-query";
import { deckStats, MANA, fmtDate } from "@yama/core";
import { useMemo, useState } from "react";
import { api, type AnalysisSummary, type Combo, type DeckAnalysis, type DeckAnalysisView, type DeckEntry, type DeckView } from "../api";
import { BracketPanel, SPELLBOOK, useDeckCheck } from "../components/Bracket";
import { DeckPrices } from "../components/DeckPrices";
import { DeckResults } from "../components/DeckResults";
import { statCards } from "../components/DeckStats";
import { HelpPopover } from "../components/HelpPopover";
import { NameList, useOnlineSupport } from "../components/OnlineSupport";
import { Button, CardImage, ErrorText, Loading, Segmented } from "../components/ui";
import { BuyDeck } from "./BuyDeck";
import { PowerLine, ScoreTable, ScryCheckButton, useDeckAnalysis } from "./DeckAnalysis";
import { colorShares, curveColumns, isStockConfiguration, landFaceCopies, curveSpread, DIAL, dialArc, dialPoint, groupTotal, inputsNote, marginSpan, pctWidth, playsLike, points, POWER_BANDS, REFERENCES, comparisonOf, earlierVersions, powerChange, stockListOf, type Reference } from "./statsTab";
import "./deckStatsTab.css";

type OnCard = (name: string) => void;
type Images = Map<string, string | null>;

export function DeckStatsTab({ deck: d, onCard }: { deck: DeckView; onCard: OnCard }) {
  const images = useMemo<Images>(() => new Map(d.cards.map((c) => [c.name, c.card?.image_small ?? c.card?.image_normal ?? null])), [d.cards]);
  const inDeck = useMemo(() => new Set(d.cards.map((c) => c.name)), [d.cards]);
  const analysis = useDeckAnalysis(d.id, d.version_id);
  const a = analysis.data?.current ?? null;
  const v = d.validation;
  return (
    <section className="deck-stats-tab" aria-label="Stats">
      <PowerSection deckId={d.id} versionId={d.version_id} cards={d.cards} images={images} inDeck={inDeck} onCard={onCard} />
      <div className="stats-pair">
        <CurveSection deck={d} />
        <ColorSection cards={d.cards} />
      </div>
      {a && a.themes.length > 0 && <ThemesSection analysis={a} images={images} inDeck={inDeck} onCard={onCard} />}
      <CombosSection deckId={d.id} versionId={d.version_id} images={images} inDeck={inDeck} onCard={onCard} />
      <BracketPanel deckId={d.id} versionId={d.version_id} declared={d.bracket} gameChangers={d.game_changers} onCard={onCard} open />
      <FlagsSection deck={d} onCard={onCard} />
      <OnlineSection deckId={d.id} versionId={d.version_id} onCard={onCard} />
      {analysis.data && <PowerOverTime view={analysis.data} />}
      <div className="stats-panel stats-value">
        <DeckPrices singles={d.singles_value} ownership={d.ownership} buylist={d.buylist} />
        <BuyDeck cards={d.cards} />
      </div>
      <DeckResults deckId={d.id} versionId={d.version_id} />
      {(v.warnings.length > 0 || !!v.prerelease?.length) && (
        <section className="stats-panel" aria-labelledby="stats-legal">
          <h2 id="stats-legal" className="stats-h">{v.ok ? "Legal, with warnings" : "Not legal yet"}</h2>
          <ul className="stats-list">
            {v.warnings.map((w) => <li key={w}>{w}</li>)}
            {v.prerelease?.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </section>
      )}
    </section>
  );
}

/** A card picture you can tap for the full card when it's in the deck. */
function Pic({ name, images, inDeck, onCard, className = "stats-pic" }: { name: string; images: Images; inDeck: Set<string>; onCard: OnCard; className?: string }) {
  const img = <CardImage src={images.get(name)} name={name} className="stats-pic-img" />;
  if (!inDeck.has(name)) return <span className={`${className} out`} title={name}>{img}</span>;
  return (
    <Button className={className} onClick={() => onCard(name)} aria-label={`${name}, full card`}>
      {img}
    </Button>
  );
}

/* ── Power level ──────────────────────────────────────────────────────── */

function PowerSection({ deckId, versionId, cards, images, inDeck, onCard }: { deckId: string; versionId: string | null; cards: DeckEntry[]; images: Images; inDeck: Set<string>; onCard: OnCard }) {
  const q = useDeckAnalysis(deckId, versionId);
  const a = q.data?.current ?? null;
  const [ref, setRef] = useState<Reference | "own-stock" | "version">("none");
  const [sel, setSel] = useState<string | null>(null);
  const earlier = earlierVersions(q.data);
  const [versionPick, setVersionPick] = useState<string | null>(null);
  const pickedVersion = versionPick && earlier.some((v) => v.id === versionPick) ? versionPick : (earlier[0]?.id ?? null);
  const ownStock = stockListOf(q.data);
  const r = comparisonOf(ref === "version" ? (pickedVersion ? `version:${pickedVersion}` : "none") : ref, q.data);
  const compareOptions: [Reference | "own-stock" | "version", string][] = [
    ["none", "Nothing"],
    ...(ownStock ? [["own-stock", "Its stock list"] as ["own-stock", string]] : []),
    ...(earlier.length ? [["version", "Earlier version"] as ["version", string]] : []),
    ...REFERENCES.map((x) => [x.key, x.label] as [Reference, string]),
  ];
  const selected = a ? (a.vectors.find((x) => x.key === sel) ?? a.vectors[0] ?? null) : null;
  return (
    <section className="stats-power" aria-labelledby="stats-power-h">
      <div className="stats-head">
        <span className="stats-title">
          <h2 id="stats-power-h" className="stats-h big">Power level</h2>
          {a && <HelpPopover label="how power is measured"><PowerHelp analysis={a} /></HelpPopover>}
        </span>
        {a && (
          <span className="stats-compare">
            <span className="dim">Compare with</span>
            <Segmented as="span" label="Compare with" value={ref} onChange={setRef} options={compareOptions} />
            {ref === "version" && (
              <select className="stats-version-pick" aria-label="Which version" value={pickedVersion ?? ""} onChange={(e) => setVersionPick(e.target.value)}>
                {earlier.map((v) => (
                  <option key={v.id} value={v.id}>
                    {`Version ${v.number}, ${fmtDate(v.created_at)}${v.note ? `: ${v.note}` : ""}`}
                  </option>
                ))}
              </select>
            )}
          </span>
        )}
      </div>
      <ErrorText error={q.error} />
      {versionId == null && <p className="dim">Add cards to see the deck's power level.</p>}
      {q.isPending && versionId != null && <Loading>Working it out…</Loading>}
      {a && selected && (
        <>
          <div className="power-grid">
            <div className="stats-panel power-score">
              <PowerDial analysis={a} />
              <span className="power-number">
                <b>{a.power.toFixed(1)}</b>
                <span className="dim">±{a.margin.toFixed(1)}</span>
              </span>
              <span className="power-pills">
                <span className="stats-pill on">{playsLike(a)}</span>
                <span className="stats-pill">{a.label}</span>
                <span className={`stats-pill ${a.confidence === "high" ? "good" : "warn"}`}>{inputsNote(a.confidence)}</span>
              </span>
              {r && (
                <span className="power-ref">
                  Amber marks: {r.name} on each score
                  {r.power != null && <>. It was {r.power.toFixed(1)}, so {powerChange(a.power, r.power)}</>}
                </span>
              )}
              {a.caps.length > 0 && (
                <div className="power-caps">
                  <h3>Holding it down</h3>
                  {a.caps.map((c) => <span key={c.reason}>{c.note}</span>)}
                </div>
              )}
            </div>
            <div className="power-vectors" role="group" aria-label="Five scores">
              {a.vectors.map((x) => (
                <Button key={x.key} className="vector" aria-pressed={x.key === selected.key} onClick={() => setSel(x.key)}>
                  <span className="vector-name"><b>{x.label}</b><span className="dim">{x.band}</span></span>
                  <span className="vector-track" aria-hidden="true">
                    <span className="fill" style={{ width: pctWidth(x.score) }} />
                    {REFERENCES.map((m) => <span key={m.key} className="mark" style={{ left: `${m.value}%` }} />)}
                    {r && <span className="ref" style={{ left: pctWidth(r.value(x.key)) }} />}
                  </span>
                  <b className="vector-score">{Math.round(x.score)}</b>
                </Button>
              ))}
              <span className="vector-marks dim">
                {REFERENCES.map((m) => <span key={m.key}>{m.value} {m.key === "stock" ? "a typical precon" : m.label}</span>)}
              </span>
            </div>
          </div>
          <VectorCards analysis={a} vector={selected} images={images} inDeck={inDeck} onCard={onCard} />
          <div className="stats-actions">
            <ScryCheckButton cards={cards} />
          </div>
        </>
      )}
    </section>
  );
}

/** The dial: 1 to 10, each bracket's usual range a band, the margin marked, the needle at the score. */
export function PowerDial({ analysis: a }: { analysis: Pick<DeckAnalysis, "power" | "margin" | "power_bracket"> }) {
  const [lo, hi] = marginSpan(a.power, a.margin);
  const [nx, ny] = dialPoint(a.power, DIAL.needle);
  const label = (p: number) => {
    const [x, y] = dialPoint(p, DIAL.r + 24);
    return { x: x.toFixed(1), y: y.toFixed(1) };
  };
  const ticks = [1, ...POWER_BANDS.map((b) => b.to)];
  return (
    <svg className="power-dial" viewBox="0 -8 320 196" role="img" aria-label={`Power ${a.power.toFixed(1)} of 10, give or take ${a.margin.toFixed(1)}, in Bracket ${a.power_bracket}'s usual range`}>
      <path className="track" d={dialArc(1, 10)} />
      {POWER_BANDS.map((b) => (
        <path key={b.bracket} className={`band b${b.bracket}${b.bracket === a.power_bracket ? " here" : ""}`} d={dialArc(b.from, b.to)} />
      ))}
      {hi > lo && <path className="margin" d={dialArc(lo, hi)} />}
      <line className="needle" x1={DIAL.cx} y1={DIAL.cy} x2={nx.toFixed(1)} y2={ny.toFixed(1)} />
      <circle className="pivot" cx={DIAL.cx} cy={DIAL.cy} r={9} />
      {ticks.map((t) => {
        const p = label(t);
        return <text key={t} x={p.x} y={t === 1 || t === 10 ? 184 : p.y} textAnchor="middle" dominantBaseline="middle">{t}</text>;
      })}
    </svg>
  );
}

function VectorCards({ analysis: a, vector, images, inDeck, onCard }: { analysis: DeckAnalysis; vector: DeckAnalysis["vectors"][number]; images: Images; inDeck: Set<string>; onCard: OnCard }) {
  const count = new Set(vector.groups.flatMap((g) => g.cards.map((c) => c.name))).size;
  const combos = vector.key === "threats" && a.combos.checked && a.combos.families > 0;
  return (
    <section className="stats-panel vector-cards" aria-labelledby="stats-vector-h" aria-live="polite">
      <div className="stats-head-line">
        <h3 id="stats-vector-h" className="stats-h">{vector.label} {Math.round(vector.score)}</h3>
        <span className="dim">{count === 0 ? "Nothing counts toward it" : `${count} ${count === 1 ? "card counts" : "cards count"} toward it`}</span>
      </div>
      {vector.groups.length > 0 && (
        <div className="vector-groups">
          {vector.groups.map((g) => (
            <div key={g.key} className="vector-group">
              <span className="vector-group-head"><b>{g.label}</b><span className="dim">+{points(groupTotal(g.cards))}</span></span>
              {g.cards.map((c, i) => (
                <span key={c.name + i} className="point-row">
                  <Pic name={c.name} images={images} inDeck={inDeck} onCard={onCard} className="point-pic" />
                  <span className="point-name">
                    {c.copies > 1 && `${c.copies} `}
                    {inDeck.has(c.name) ? <Button className="name-link" onClick={() => onCard(c.name)}>{c.name}</Button> : c.name}
                  </span>
                  <span className="point-bar" aria-hidden="true"><span style={{ width: pctWidth(c.points * 10) }} /></span>
                  <b className="point-num">{points(c.points)}</b>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      {combos && (
        <div className="vector-bonus">
          <span className="stats-pill">{a.combos.families} combo {a.combos.families === 1 ? "family" : "families"}</span>
          {a.combos.compact > 0 && <span className="stats-pill">{a.combos.compact} compact</span>}
        </div>
      )}
    </section>
  );
}

/** Why the margin is what it is, from the analysis. */
export function confidenceText(a: DeckAnalysis): string {
  const why: string[] = [];
  if (!a.combos.checked) why.push("Commander Spellbook hasn't checked this list for combos yet");
  else if (a.combos.unrecognized) why.push(`Commander Spellbook didn't know ${a.combos.unrecognized} ${a.combos.unrecognized === 1 ? "card" : "cards"}, so combos with ${a.combos.unrecognized === 1 ? "it" : "them"} may be missing`);
  if (a.unknown_cards.length) why.push(`${a.unknown_cards.length} ${a.unknown_cards.length === 1 ? "card isn't" : "cards aren't"} in Yama's card data`);
  if (a.nonland > 0 && a.unscored / a.nonland > 0.35) why.push("many cards do things the text rules don't score");
  return `${inputsNote(a.confidence)}${why.length ? `: ${why.join("; ")}` : ""}. The margin is never narrower than lists built for the same bracket were measured to spread. An unofficial Yama estimate from card text, not from how the deck plays.`;
}

function PowerHelp({ analysis: a }: { analysis: DeckAnalysis }) {
  return (
    <>
      <p>Each card scores 0 to 10 in the jobs it does, cheaper cards more, and your commander half again because it's always there. Five scores of 0 to 100 add up to a power of 1 to 10, Speed and Consistency weighing most. A stock precon scores about 40, a Bracket 4 build about 75, cEDH about 95.</p>
      <p>A land's points are its quality for this deck's colors. Points are per copy; every copy counts. Combos Commander Spellbook found add to Threats.</p>
      <p>{a.description}</p>
      <p>{confidenceText(a)}</p>
      <p>"Plays like" is the bracket whose usual power range holds the score, give or take the margin. Wizards' card rules are a separate question: Game Changers, mass land denial and early combos can put a list in a higher bracket than it plays like, and the deck's Bracket panel lists them.</p>
      <p>Your declared bracket is still yours to choose: intent and the table matter more than a score. Other sites use their own formulas.</p>
      {a.unknown_cards.length > 0 && <p>Not counted: {a.unknown_cards.join(", ")}.</p>}
    </>
  );
}

/* ── Curve and colors ─────────────────────────────────────────────────── */

function CurveSection({ deck: d }: { deck: DeckView }) {
  const s = useMemo(() => deckStats(statCards(d.cards)), [d.cards]);
  const stockRef = d.configurations.find((c) => isStockConfiguration(c.configuration) && c.id !== d.id) ?? null;
  const [cmp, setCmp] = useState<"none" | "stock">("none");
  const stock = useQuery({
    queryKey: ["deck", stockRef?.id],
    queryFn: ({ signal }) => api<DeckView>(`/api/decks/${stockRef!.id}`, { signal }),
    enabled: cmp === "stock" && !!stockRef,
  });
  const stockStats = useMemo(() => (cmp === "stock" && stock.data ? deckStats(statCards(stock.data.cards)) : null), [cmp, stock.data]);
  if (s.nonlands === 0) return null;
  const cols = curveColumns(s.curve);
  const stockAt = new Map(stockStats ? curveColumns(stockStats.curve).map((c) => [c.mv, c.n]) : []);
  const max = Math.max(1, ...cols.map((c) => c.n), ...stockAt.values());
  const spread = curveSpread(s.curve);
  const aria = `Mana curve: ${cols.map((c) => `${c.mv === 7 ? "7 or more" : c.label}, ${c.n}${stockStats ? ` (stock ${stockAt.get(c.mv) ?? 0})` : ""}`).join("; ")}`;
  return (
    <section className="stats-panel stats-curve" aria-labelledby="stats-curve-h">
      <div className="stats-head">
        <span className="stats-title">
          <h2 id="stats-curve-h" className="stats-h">Mana curve</h2>
          <HelpPopover label="mana curve">
            <p>{s.nonlands} nonland cards in the commander and main deck, by mana value; the sideboard isn't counted. Double-faced cards use the front face.</p>
            {s.unknownCards.length > 0 && <p>Not in the card data, so left out: {s.unknownCards.join(", ")}.</p>}
          </HelpPopover>
        </span>
        {stockRef && (
          <Segmented as="span" label="Compare with" value={cmp} onChange={setCmp} options={[["none", "Nothing"], ["stock", "Stock"]]} />
        )}
      </div>
      <ErrorText error={stock.error} />
      <div className="curve-plot">
      <div className="curve-bars" role="img" aria-label={aria} style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((c) => (
          <div key={c.mv} className="curve-col">
            <span className="curve-n">{c.n}</span>
            <span className="curve-bar" style={{ height: `calc((100% - 24px) * ${c.n / max})` }} />
            {stockStats && <span className="curve-cmp" style={{ bottom: `calc((100% - 24px) * ${(stockAt.get(c.mv) ?? 0) / max})` }} />}
          </div>
        ))}
      </div>
      <div className="curve-labels" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((c) => <span key={c.mv}>{c.label}</span>)}
      </div>
      </div>
      <div className="curve-figures">
        <span><b>{s.averageMvNonland?.toFixed(2) ?? "None"}</b><span className="dim">Average</span></span>
        <span><b>{spread.low}</b><span className="dim">2 or less</span></span>
        <span><b>{spread.mid}</b><span className="dim">3 or 4</span></span>
        <span><b>{spread.high}</b><span className="dim">5 or more</span></span>
        {stockStats && <span className="cmp"><b>{stockStats.averageMvNonland?.toFixed(2) ?? "None"}</b><span className="dim">Stock average</span></span>}
      </div>
    </section>
  );
}

function ColorSection({ cards }: { cards: DeckEntry[] }) {
  const stat = useMemo(() => statCards(cards), [cards]);
  const s = useMemo(() => deckStats(stat), [stat]);
  const lands = useMemo(() => landFaceCopies(stat), [stat]);
  if (!s.colors.length) return null;
  const shares = colorShares(s.colors, lands);
  const uncounted = s.landsWithoutManaData.length > 0;
  return (
    <section className="stats-panel stats-colors" aria-labelledby="stats-colors-h">
      <span className="stats-title">
        <h2 id="stats-colors-h" className="stats-h">Color balance</h2>
        <HelpPopover label="color balance">
          <p>Shares of the colored symbols in spell costs, and of the {lands} lands (and land faces) that can make each color. Fetch lands count for the lands they find, land back faces count, and a land making two colors counts in both. Mana rocks, creatures and spells aren't included.</p>
          <p>No target ratio is implied: symbol shares alone can't show a shortage. Casting odds need a target turn, draws and mulligans; see <a href="https://www.tcgplayer.com/content/article/How-Many-Sources-Do-You-Need-to-Consistently-Cast-Your-Spells-A-2022-Update/dc23a7d2-0a16-4c0b-ad36-586fcca03ad8/" target="_blank" rel="noreferrer">Frank Karsten's source counts</a>.</p>
          {uncounted && <p>Lands aren't counted until the card data brings the mana of {s.landsWithoutManaData.join(", ")}.</p>}
        </HelpPopover>
      </span>
      <span className="color-legend" aria-hidden="true">
        <span><i className="sym" />Symbols</span>
        <span><i className="land" />Lands</span>
      </span>
      <div className="color-rows">
        {shares.map((c) => (
          <div key={c.color} className="color-row">
            <span className="color-name">
              <span className="dot" style={{ background: MANA[c.color].fill }} aria-hidden="true" />
              {MANA[c.color].name}
            </span>
            <span className="color-track" aria-hidden="true"><span className="sym" style={{ width: pctWidth(c.pipShare) }} /></span>
            <span className="color-val">{c.pipShare}%<span className="visually-hidden"> of symbols, {c.pips}</span></span>
            <span className="color-track" aria-hidden="true"><span className="land" style={{ width: pctWidth(c.sourceShare ?? 0) }} /></span>
            <span className="color-val">
              {c.sourceShare == null ? <span className="dim">Not counted</span> : <>{c.sourceShare}%<span className="visually-hidden"> of lands, {c.sources} of {lands}</span></>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Themes and combos ────────────────────────────────────────────────── */

function ThemesSection({ analysis: a, images, inDeck, onCard }: { analysis: DeckAnalysis; images: Images; inDeck: Set<string>; onCard: OnCard }) {
  const [all, setAll] = useState<Set<string>>(new Set());
  return (
    <section className="stats-themes" aria-labelledby="stats-themes-h">
      <span className="stats-title">
        <h2 id="stats-themes-h" className="stats-h">Themes</h2>
        <HelpPopover label="themes">
          <p>Read from the card text by Yama's power estimate: a core theme has many cards behind it, a minor one a few.</p>
        </HelpPopover>
      </span>
      <div className="theme-grid">
        {a.themes.map((t) => {
          const open = all.has(t.key);
          const shown = open ? t.cards : t.cards.slice(0, 5);
          return (
            <div key={t.key} className="stats-panel theme">
              <span className="theme-head"><b>{t.label}</b><span className="dim">{t.strength === "core" ? "Core" : t.strength === "major" ? "Major" : "Minor"}, {t.count} cards</span></span>
              <span className="dim">{t.description}</span>
              <span className="theme-pics">
                {shown.map((n) => <Pic key={n} name={n} images={images} inDeck={inDeck} onCard={onCard} />)}
              </span>
              {t.cards.length > 5 && (
                <Button
                  variant="quiet" size="small" className="theme-more"
                  aria-expanded={open}
                  onClick={() => setAll((s) => { const n = new Set(s); if (open) n.delete(t.key); else n.add(t.key); return n; })}
                >
                  {open ? "Show fewer" : `Show all ${t.cards.length}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CombosSection({ deckId, versionId, images, inDeck, onCard }: { deckId: string; versionId: string | null; images: Images; inDeck: Set<string>; onCard: OnCard }) {
  const check = useDeckCheck(deckId, versionId);
  const c = check.data;
  const r = c?.result ?? null;
  if (!c) return null;
  const twoCard = r?.combos.filter((x) => x.definitely_two_card) ?? [];
  const arguably = r?.combos.filter((x) => !x.definitely_two_card && x.arguably_two_card) ?? [];
  const longer = r?.combos.filter((x) => !x.definitely_two_card && !x.arguably_two_card) ?? [];
  const groups: [string, Combo[]][] = [["Two cards", twoCard], ["Two cards and a setup", arguably], ["More pieces", longer]];
  return (
    <section className="stats-combos" aria-labelledby="stats-combos-h">
      <div className="stats-head-line">
        <h2 id="stats-combos-h" className="stats-h">Combos</h2>
        {r && <span className="dim small"><a href={SPELLBOOK} target="_blank" rel="noreferrer">Commander Spellbook</a>, {fmtDate(r.checked_at)}</span>}
      </div>
      {!c.enabled ? (
        <p className="dim">Combo checks are off on this server.</p>
      ) : !r ? (
        <p className="dim">Not checked yet.</p>
      ) : r.combos.length === 0 ? (
        <p className="dim">None found in this list.</p>
      ) : (
        groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
          <div key={label} className="combo-group">
            <h3 className="combo-group-h">{label} <span className="dim">{list.length}</span></h3>
            <div className="stats-panel stats-combo-list">
              {list.map((k) => (
                <div key={k.id} className="combo-row">
                  <span className="combo-pics">
                    {k.cards.map((n, i) => (
                      <span key={n} className="combo-piece">
                        {i > 0 && <span className="plus" aria-hidden="true">+</span>}
                        <Pic name={n} images={images} inDeck={inDeck} onCard={onCard} className="combo-pic" />
                      </span>
                    ))}
                    {k.templates.map((t) => (
                      <span key={t} className="combo-piece">
                        <span className="plus" aria-hidden="true">+</span>
                        <span className="combo-pic slot">{t}</span>
                      </span>
                    ))}
                  </span>
                  <span className="stats-combo-text">
                    <b><NameList names={k.cards} onCard={(n) => inDeck.has(n) && onCard(n)} />{k.templates.length > 0 && <>, plus {k.templates.join(", ").toLowerCase()}</>}</b>
                    <span className="dim">{k.results.slice(0, 4).join(", ")}{k.results.length > 4 ? ", and more" : ""}</span>
                    {k.flags.length > 0 && <span className="dim">Counts toward a higher bracket: {k.flags.join(", ")}</span>}
                    <a href={`${SPELLBOOK}combo/${encodeURIComponent(k.id)}/`} target="_blank" rel="noreferrer">How it works</a>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <ErrorText error={check.error} />
    </section>
  );
}

/* ── Game Changers, Reserve List, online play, history ───────────────── */

function FlagsSection({ deck: d, onCard }: { deck: DeckView; onCard: OnCard }) {
  return (
    <section className="stats-panel stats-flags" aria-labelledby="stats-flags-h">
      <span className="stats-title">
        <h2 id="stats-flags-h" className="stats-h">Game Changers and Reserve List</h2>
        <HelpPopover label="Game Changers and Reserve List">
          <p>Game Changers are Wizards' list of cards that set a deck's bracket floor. The Reserve List is cards Wizards has promised never to reprint: it says a card is scarce, not that it's strong, so the power level leaves it out.</p>
        </HelpPopover>
      </span>
      <div className="flag-cols">
        <div>
          <span className="stats-head-line">
            <b>Game Changers {d.game_changers ? d.game_changers.length : ""}</b>
            {d.game_changers_as_of && <span className="dim small">Scryfall, {fmtDate(d.game_changers_as_of)}</span>}
          </span>
          {d.game_changers == null ? <span className="dim">Not checked yet</span> : d.game_changers.length > 0 ? <span className="names"><NameList names={d.game_changers} onCard={onCard} /></span> : <span className="dim">None</span>}
        </div>
        <div>
          <span className="stats-head-line">
            <b>Reserve List {d.reserved_list ? d.reserved_list.length : ""}</b>
            {d.reserved_list_as_of && <span className="dim small">Scryfall, {fmtDate(d.reserved_list_as_of)}</span>}
          </span>
          {d.reserved_list == null ? <span className="dim">Not checked yet</span> : d.reserved_list.length > 0 ? <span className="names"><NameList names={d.reserved_list} onCard={onCard} /></span> : <span className="dim">None</span>}
        </div>
      </div>
    </section>
  );
}

function OnlineSection({ deckId, versionId, onCard }: { deckId: string; versionId: string | null; onCard: OnCard }) {
  const q = useOnlineSupport(deckId, versionId);
  const d = q.data;
  if (!d) return null;
  const s = d.state === "ready" ? d.support : null;
  if (s && s.total === 0) return null;
  return (
    <section className="stats-online" aria-labelledby="stats-online-h">
      <div className="stats-head-line">
        <h2 id="stats-online-h" className="stats-h">Online play</h2>
        <span className="dim">
          {!s ? (d.state === "starting" ? "Checking once the rules engine has started" : "Off on this server") : s.supported === s.total ? `All ${s.total} cards playable` : `${s.supported} of ${s.total} cards playable`}
        </span>
      </div>
      {s && (s.missing.length > 0 || s.partial.length > 0 || s.uncertain.length > 0) && (
        <dl className="online-lists">
          {s.missing.length > 0 && <div><dt>Left out of online games</dt><dd><NameList names={s.missing} onCard={onCard} /></dd></div>}
          {s.partial.length > 0 && <div><dt>Some abilities unsupported</dt><dd><NameList names={s.partial} onCard={onCard} /></dd></div>}
          {s.uncertain.length > 0 && <div><dt>May not work fully</dt><dd><NameList names={s.uncertain} onCard={onCard} /></dd></div>}
        </dl>
      )}
    </section>
  );
}

/** Power across saved versions (oldest left), and each list of the deck side by side. */
function PowerOverTime({ view }: { view: DeckAnalysisView }) {
  const versions = view.versions;
  const configs = view.configurations.filter((c) => c.power != null);
  if (versions.length < 2 && configs.length < 2) return null;
  return (
    <section className="stats-panel stats-history" aria-labelledby="stats-history-h">
      <span className="stats-title">
        <h2 id="stats-history-h" className="stats-h">Power over time</h2>
        <HelpPopover label="power over time">
          <p>Worked out from each saved list; combos count where Commander Spellbook checked that list.</p>
        </HelpPopover>
      </span>
      {versions.length >= 2 && <PowerLine points={[...versions].reverse()} />}
      {configs.length >= 2 && (
        <ScoreTable
          rows={configs.map((c) => ({
            key: c.id,
            name: c.configuration ?? "Main deck",
            link: c.this ? undefined : `/decks/${c.id}`,
            sub: c.this ? "This one" : undefined,
            summary: c as AnalysisSummary,
          }))}
        />
      )}
    </section>
  );
}
