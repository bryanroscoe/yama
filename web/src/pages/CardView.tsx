// One card: its art behind the top, the full card, rules text, what you own, the cheapest market
// price with its last month, and every printing (design/screens/CardPage.dc.html, CardPhone).
// The same view fills the Cards tab's card page and the card sheet other screens open; it lays
// itself out by its own width, so the sheet gets the phone layout.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { api, priceSource, shortDate, usd, type Card, type CollectionItem, type Printing } from "../api";
import { signInPath } from "../auth";
import { cardDetailQuery } from "../cardDetail";
import { isGuest } from "../guest";
import { PriceHistory } from "../components/PriceHistory";
import { Rulings } from "../components/Rulings";
import { CardImage, ErrorText, ManaCost, Pips } from "../components/ui";
import { ownedFinishes } from "./collectionEdit";
import "./cards.css";

type Finish = "nonfoil" | "foil" | "etched";
const CONDITIONS: Record<string, string> = { NM: "near mint", LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };
const listWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A legendary creature, or a card that says it can be your commander. */
export function canBeCommander(c: Pick<Card, "type_line" | "oracle_text">): boolean {
  return (/\bLegendary\b/.test(c.type_line) && /\bCreature\b/.test(c.type_line)) || /can be your commander/i.test(c.oracle_text);
}

/** "{1}{W}{W}" → "1 W W", the way the card page writes a cost in its display face. */
const costText = (cost: string | null) => (cost ? cost.replace(/\{([^}]+)\}/g, " $1").replace(/\s\/\/\s/g, " // ").trim() : "");

/** The cheapest market price across printings and finishes, with where it's from. */
export function cheapest(printings: Printing[]): { p: Printing; finish: Finish; value: number } | null {
  let best: { p: Printing; finish: Finish; value: number } | null = null;
  for (const p of printings) {
    const options: [Finish, number | null][] = [
      ["nonfoil", p.finishes.includes("nonfoil") ? p.usd : null],
      ["foil", p.finishes.includes("foil") ? p.usd_foil : null],
      ["etched", p.finishes.includes("etched") ? p.usd_etched : null],
    ];
    for (const [finish, value] of options) {
      if (value != null && (!best || value < best.value)) best = { p, finish, value };
    }
  }
  return best;
}

interface Point {
  date: string;
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
}

/** The cheapest printing's last 30 days as a line, and the dates it covers. */
function Sparkline({ scryfallId, finish, fallbackDate }: { scryfallId: string; finish: Finish; fallbackDate: string | null }) {
  const history = useQuery({ queryKey: ["prices", scryfallId], queryFn: ({ signal }) => api<Point[]>(`/api/printings/${scryfallId}/prices`, { signal }) });
  const pick = (p: Point) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);
  const points = (history.data ?? [])
    .map((p) => ({ date: p.date, value: pick(p) }))
    .filter((p): p is { date: string; value: number } => p.value !== null)
    .slice(-30);
  if (points.length < 2) return <span className="cp-fact-note">{priceSource(points[0]?.date ?? fallbackDate)}</span>;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const coords = points.map((p, i) => `${((i / (points.length - 1)) * 200).toFixed(1)},${(4 + (1 - (p.value - min) / span) * 32).toFixed(1)}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <>
      <svg className="cp-spark" viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label={`Price from ${usd(first.value)} on ${shortDate(first.date)} to ${usd(last.value)} on ${shortDate(last.date)}`}>
        <polyline points={coords} fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="cp-fact-note">
        TCGplayer market via Scryfall, {shortDate(first.date)} to {shortDate(last.date)}
      </span>
    </>
  );
}

/**
 * The card's details. `onBack` draws the back button over the art ("Search results" on the card
 * page, a close button in a sheet). `readOnly` (plan pages) hides the buttons that add copies.
 * Signed out, the card's details come from the search result (`hit`): printings, prices and
 * copies need an account.
 */
export function CardView({ oracleId, onBack, backLabel, readOnly = false, close = false, hit }: { oracleId: string; onBack: () => void; backLabel: string; readOnly?: boolean; close?: boolean; hit?: Card }) {
  const guest = isGuest();
  const { pathname, search } = useLocation();
  const detail = useQuery({ ...cardDetailQuery(oracleId), enabled: !guest });
  const card = detail.data?.card ?? (guest ? hit : undefined);
  const [flipped, setFlipped] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [allPrintings, setAllPrintings] = useState(false);
  const [chart, setChart] = useState<{ id: string; finish: Finish; set: string } | null>(null);
  const qc = useQueryClient();
  // Your copies of this card, any printing: the collection filtered by name, then by the card.
  const owned = useQuery({
    queryKey: ["collection", "card", oracleId],
    queryFn: ({ signal }) => api<CollectionItem[]>(`/api/collection?q=${encodeURIComponent(card!.name.split(" // ")[0]!)}`, { signal }),
    enabled: !!card && !guest,
    select: (items) => items.filter((i) => i.oracle_id === oracleId && i.qty > 0),
  });
  const add = useMutation({
    mutationFn: (v: { p: Printing; finish: string; proxy?: boolean }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "add", scryfall_id: v.p.scryfall_id, qty: 1, finish: v.finish, proxy: !!v.proxy }],
      }),
    onSuccess: (_, v) => {
      setAdded(
        v.proxy
          ? `Added a proxy of ${card!.name} (${v.p.set_name} art) to your collection.`
          : `Added ${v.finish === "nonfoil" ? "a" : `a ${v.finish}`} ${v.p.set_name} copy to your collection.`,
      );
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "search" });
    },
  });

  if (!card) {
    return (
      <div className="cp">
        <div className="cp-inner">
          <button className="cp-back" onClick={onBack} aria-label={backLabel}>
            {close ? <CloseIcon /> : <BackIcon />}
            <span className="cp-back-text">{backLabel}</span>
          </button>
          <ErrorText error={detail.error} />
          {guest ? (
            <p className="dim">
              <Link to={signInPath(pathname + search)}>Sign in</Link> to open a card from a link, or search for it.
            </p>
          ) : (
            detail.isPending && <p className="dim">Loading the card…</p>
          )}
        </div>
      </div>
    );
  }

  const printings = detail.data?.printings ?? [];
  const low = cheapest(printings);
  const mine = owned.data ?? [];
  const copies = mine.reduce((a, i) => a + i.qty, 0);
  // Your copies' finishes by printing, so a printing's line says whether yours is foil.
  const myPrintings = new Map<string, string[]>();
  for (const i of mine) myPrintings.set(i.scryfall_id, [...(myPrintings.get(i.scryfall_id) ?? []), i.finish]);
  const places = [...new Set(mine.map((i) => i.container_name ?? "Not filed"))];
  const ownedLong =
    mine.length === 1
      ? `In ${mine[0]!.container_name ?? "no binder or box"}, ${mine[0]!.set_name ?? "unknown set"} #${mine[0]!.collector_number}, ${CONDITIONS[mine[0]!.condition] ?? mine[0]!.condition}${mine[0]!.finish !== "nonfoil" ? `, ${mine[0]!.finish}` : ""}`
      : `In ${listWords(places)}`;
  const ownedShort = places.length === 1 ? (places[0] === "Not filed" ? "Not filed" : `In ${places[0]}`) : `In ${places.length} places`;
  const pt = card.power ? `${card.power}/${card.toughness}` : card.loyalty ? `Loyalty ${card.loyalty}` : "";
  const typeLine = `${card.type_line.replace(" — ", ", ")}${pt ? `. ${pt}` : ""}`;
  const defaultPrinting = printings.find((p) => p.scryfall_id === card.default_printing) ?? printings[0];
  const addDefault = defaultPrinting && (defaultPrinting.finishes.includes("nonfoil") ? "nonfoil" : defaultPrinting.finishes[0]);
  const shown = printings.slice(0, allPrintings ? undefined : 12);
  const priceDate = printings.find((p) => p.price_date)?.price_date;

  return (
    <div className="cp">
      {card.image_art_crop && (
        <div className="cp-hero" aria-hidden="true">
          <img src={card.image_art_crop} alt="" crossOrigin="anonymous" />
          <span className="cp-hero-wash" />
        </div>
      )}
      <div className="cp-inner">
        <button className="cp-back" onClick={onBack} aria-label={backLabel} autoFocus>
          {close ? <CloseIcon /> : <BackIcon />}
          <span className="cp-back-text">{backLabel}</span>
        </button>
        <div className="cp-body">
          {/* The full card shows here, so it carries the art's credit. */}
          <figure className="cp-figure">
            <CardImage src={flipped && card.back_image_normal ? card.back_image_normal : card.image_normal} name={card.name} />
            <figcaption>
              {card.artist ? `Art by ${card.artist}. ` : ""}™ &amp; © Wizards of the Coast. Image from Scryfall.
            </figcaption>
            {card.back_image_normal && (
              <button className="quiet small" onClick={() => setFlipped((f) => !f)}>Show the other face</button>
            )}
          </figure>

          <div className="cp-main">
            <div className="cp-title">
              <span className="cp-cost">
                <ManaCost cost={card.mana_cost} />
                <Pips identity={card.color_identity} />
              </span>
              <h1>{card.name}</h1>
              <p className="cp-type">
                <span className="cp-cost-inline">{costText(card.mana_cost) ? `${costText(card.mana_cost)}. ` : ""}</span>
                {typeLine}
              </p>
            </div>
            {card.oracle_text && <p className="cp-oracle">{card.oracle_text}</p>}
            <div className="cp-chips">
              <Legality status={card.legalities.commander} />
              {canBeCommander(card) && <span className="cp-chip">Can be your commander</span>}
              {card.game_changer === true && <span className="tag gc" title="On the Commander Game Changers list, per Scryfall">Game Changer</span>}
            </div>

            {guest ? (
              <p className="cp-signin">
                <Link to={signInPath(pathname + search)}>Sign in</Link> for every printing with its market price, price history and the copies you own.
              </p>
            ) : (
            <div className="cp-facts">
              <div className="cp-fact">
                <span className="cp-fact-label">You own</span>
                <b className="cp-fact-big">
                  <span className="cp-wide">{copies === 0 ? "None" : `${copies} ${copies === 1 ? "copy" : "copies"}`}</span>
                  <span className="cp-narrow">{copies}</span>
                </b>
                <span className="cp-fact-note">
                  {owned.isPending ? "Checking your collection…" : copies === 0 ? "Not in your collection" : (
                    <>
                      <span className="cp-wide">{ownedLong}</span>
                      <span className="cp-narrow">{ownedShort}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="cp-fact">
                <span className="cp-fact-label">
                  <span className="cp-wide">Cheapest market price</span>
                  <span className="cp-narrow">Cheapest market</span>
                </span>
                <b className="cp-fact-big num">{low ? usd(low.value) : "No price"}</b>
                {low ? (
                  <Sparkline scryfallId={low.p.scryfall_id} finish={low.finish} fallbackDate={low.p.price_date} />
                ) : (
                  <span className="cp-fact-note">{printings.length ? `No printing has a market price on ${shortDate(priceDate) ?? "the latest date"}` : "No printings saved on this device"}</span>
                )}
              </div>
            </div>

            )}

            {!readOnly && !guest && defaultPrinting && addDefault && (
              <div className="cp-actions">
                <button className="primary" onClick={() => add.mutate({ p: defaultPrinting, finish: addDefault })} disabled={add.isPending}>
                  Add to collection
                </button>
                <button className="outline" onClick={() => add.mutate({ p: defaultPrinting, finish: "nonfoil", proxy: true })} disabled={add.isPending}>
                  Add a proxy
                </button>
              </div>
            )}
            {added && <p className="small" role="status" style={{ margin: 0 }}>{added}</p>}
            <ErrorText error={add.error} />

            {detail.data?.rulings !== undefined && <Rulings rulings={detail.data.rulings} />}

            {printings.length > 0 && (
              <section className="cp-printings" aria-labelledby={`pr-${oracleId}`}>
                <h2 id={`pr-${oracleId}`}>Printings</h2>
                {chart && <PriceHistory key={chart.id} scryfallId={chart.id} finish={chart.finish} setName={chart.set} />}
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>Set</th>
                      <th className="r">Normal</th>
                      <th className="r">Foil</th>
                      {!readOnly && <th className="r"><span className="visually-hidden">Add</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => {
                      const foil = p.finishes.includes("foil") ? p.usd_foil : p.finishes.includes("etched") ? p.usd_etched : undefined;
                      const hasFoil = p.finishes.includes("foil") || p.finishes.includes("etched");
                      const finish: Finish = p.finishes.includes("nonfoil") ? "nonfoil" : (p.finishes[0] as Finish);
                      const yourFinishes = myPrintings.get(p.scryfall_id);
                      const yours = yourFinishes ? ownedFinishes(yourFinishes) : null;
                      return (
                        <tr key={p.scryfall_id}>
                          <td>
                            <button className="cp-set" onClick={() => setChart({ id: p.scryfall_id, finish, set: p.set_name })} aria-label={`${p.set_name} #${p.collector_number}: show its price history`}>
                              <span className="cp-set-name">{p.set_name}</span> <span className="cp-set-num">#{p.collector_number}</span>
                            </button>
                            {yours != null && <span className="tag good cp-yours">Yours, {yours}</span>}
                            {/* Phones: one line under the set for the number, your copies' finish, then the foil market price. */}
                            <span className="cp-set-sub">
                              #{p.collector_number}
                              {yours != null && <span className="good">, yours ({yours})</span>}
                              {hasFoil && p.finishes.includes("nonfoil") ? `. Foil market ${usd(foil)}` : ""}
                            </span>
                          </td>
                          <td className={`r num${p.finishes.includes("nonfoil") && p.usd == null ? " dim" : ""}`}>
                            {p.finishes.includes("nonfoil") ? usd(p.usd) : <span className="cp-only-foil">{usd(foil)}</span>}
                          </td>
                          <td className={`r num cp-foil${hasFoil && foil == null ? " dim" : ""}`}>{hasFoil ? usd(foil) : ""}</td>
                          {!readOnly && (
                            <td className="r cp-add">
                              <span className="cp-add-row">
                                {p.finishes.map((f) => (
                                  <button key={f} onClick={() => add.mutate({ p, finish: f })} aria-label={`Add a ${f === "nonfoil" ? "regular" : f} ${p.set_name} copy to your collection`}>
                                    {f === "nonfoil" ? "+1" : f === "foil" ? "+F" : "+E"}
                                  </button>
                                ))}
                              </span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {printings.length > 12 && !allPrintings && (
                  <button className="quiet small" onClick={() => setAllPrintings(true)}>Show all {printings.length} printings</button>
                )}
                <p className="cp-note">
                  Tap a set to see its price history.{readOnly ? "" : " +1 adds a regular copy, +F a foil, +E an etched foil."} Prices are {priceSource(priceDate)}. Market prices aren't a quote from any store. A missing price says so.
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Legality({ status }: { status: string | undefined }) {
  if (status === "legal") return <span className="tag good">Commander: legal</span>;
  if (status === "banned") return <span className="tag bad">Commander: banned</span>;
  const text = status ? status.replace("_", " ") : "unknown";
  return <span className="tag">Commander: {text}</span>;
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
