// One card: its art behind the top, the full card, rules text, what you own, the cheapest market
// price with its last month, and every printing (design/screens/CardPage.dc.html, CardPhone).
// The same view fills the Cards tab's card page and the card sheet other screens open; it lays
// itself out by its own width, so the sheet gets the phone layout.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SymbolText } from "../components/ManaSymbols";
import { Fragment, useState } from "react";
import { Link, useLocation } from "react-router";
import { api, placeName, type Card, type CollectionItem, type Printing } from "../api";
import { signInPath } from "../auth";
import { cardDetailQuery } from "../cardDetail";
import { isGuest } from "../guest";
import { PriceHistory } from "../components/PriceHistory";
import { Rulings } from "../components/Rulings";
import { Button, CardThumb, ErrorText, Loading, ManaCost, Pips, ShowMore, StatusPill, Tag, ZoomableCard } from "../components/ui";
import { usePageTitle } from "../pageTitle";
import { addWant } from "../plan/api";
import { CardInDecks } from "./CardInDecks";
import { opIds, ownedFinishes } from "./collectionEdit";
import "./cards.css";
import { foilKind, plural, priceSource, shortDate, treatmentLabel, usd } from "@yama/core";

type Finish = "nonfoil" | "foil" | "etched";
const CONDITIONS: Record<string, string> = { NM: "near mint", LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };
const listWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Regular", "Foil", "Surge foil", "Etched": a button's word for adding a copy of `p` in `finish`. */
function finishWord(p: Printing, finish: string): string {
  return finish === "nonfoil" ? "Regular" : finish === "foil" ? (foilKind(p) ?? "Foil") : finish === "etched" ? "Etched" : finish;
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** A legendary creature, or a card that says it can be your commander. */
export function canBeCommander(c: Pick<Card, "type_line" | "oracle_text">): boolean {
  return (/\bLegendary\b/.test(c.type_line) && /\bCreature\b/.test(c.type_line)) || /can be your commander/i.test(c.oracle_text);
}

/** Today as "2026-11-21" on this device: a release date after it is a printing that isn't out. */
function today(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * The printing "Add to collection" adds: Scryfall's default when it is out and has a market price,
 * else the first printing that is out with a price, else one that is out. Scryfall makes a coming
 * set's printing the default months before it is on sale, with no price, and a card someone holds
 * can't be that one. The price is the one for the finish the button adds.
 */
export function addPrinting(printings: Printing[], defaultId: string | null | undefined, day: string = today()): Printing | undefined {
  const rank = (p: Printing) => {
    const price = p.finishes.includes("nonfoil") || p.finishes.length === 0 ? p.usd : p.finishes[0] === "etched" ? p.usd_etched : p.usd_foil;
    return (p.released_at != null && p.released_at > day ? 4 : 0) + (price == null ? 2 : 0) + (p.scryfall_id === defaultId ? 0 : 1);
  };
  let best: Printing | undefined;
  for (const p of printings) if (!best || rank(p) < rank(best)) best = p;
  return best;
}

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
  usePageTitle(card?.name);
  const [flipped, setFlipped] = useState(false);
  // What the last add did, and which printing's row it was tapped in (none: the buttons at the
  // top), so the line shows beside that button.
  const [added, setAdded] = useState<{ p: Printing; finish: string; proxy: boolean; row?: string; undone?: boolean } | null>(null);
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
  // One op id per add until the server confirms it: tapping again after a failed save (its answer
  // may only have been lost) sends the same op, never a second copy.
  const [ids] = useState(() => opIds());
  const addKey = (v: { p: Printing; finish: string; proxy?: boolean }) => `${v.p.scryfall_id}:${v.finish}:${v.proxy ? "proxy" : "real"}`;
  const add = useMutation({
    mutationFn: (v: { p: Printing; finish: string; proxy?: boolean; row?: string }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: ids.idFor(addKey(v)), kind: "add", scryfall_id: v.p.scryfall_id, qty: 1, finish: v.finish, proxy: !!v.proxy }],
      }),
    onMutate: () => setAdded(null),
    onSuccess: (_, v) => {
      ids.saved(addKey(v));
      setAdded({ p: v.p, finish: v.finish, proxy: !!v.proxy, row: v.row });
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "search" });
    },
  });
  // Undo takes the copy back off the row the add went to. It is an op like the add, with an id
  // that outlives a failed send.
  const undo = useMutation({
    mutationFn: (item: CollectionItem) => api("/api/collection/ops", { method: "POST", json: [{ op_id: ids.idFor(`undo:${item.id}`), kind: "adjust", item_id: item.id, delta: -1 }] }),
    onSuccess: (_, item) => {
      ids.saved(`undo:${item.id}`);
      setAdded((a) => a && { ...a, undone: true });
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "search" });
    },
  });
  // The wish list is the plan's list of cards to buy (Collection, Wish list).
  const wish = useMutation({
    mutationFn: (name: string) => addWant({ kind: "card", name, qty: 1, priority: "need", deck_id: null, deck_name: null, why: null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan"] }),
  });

  if (!card) {
    return (
      <div className="cp">
        <div className="cp-inner">
          <Button className="cp-back" onClick={onBack} aria-label={backLabel}>
            {close ? <CloseIcon /> : <BackIcon />}
            <span className="cp-back-text">{backLabel}</span>
          </Button>
          <ErrorText error={detail.error} />
          {guest ? (
            <p className="dim">
              <Link to={signInPath(pathname + search)}>Sign in</Link> to open a card from a link, or search for it.
            </p>
          ) : (
            detail.isPending && <Loading>Loading the card…</Loading>
          )}
        </div>
      </div>
    );
  }

  const printings = detail.data?.printings ?? [];
  const low = cheapest(printings);
  const mine = owned.data ?? [];
  // A proxy isn't a card you own: counted apart.
  const real = mine.reduce((a, i) => a + (i.proxy ? 0 : i.qty), 0);
  const proxies = mine.reduce((a, i) => a + (i.proxy ? i.qty : 0), 0);
  const copies = real + proxies;
  // Your copies' finishes by printing, so a printing's line says whether yours is foil.
  const myPrintings = new Map<string, string[]>();
  for (const i of mine) myPrintings.set(i.scryfall_id, [...(myPrintings.get(i.scryfall_id) ?? []), i.finish]);
  const places = [...new Set(mine.map((i) => placeName(i)))];
  const ownedLong =
    mine.length === 1
      ? `In ${placeName(mine[0]!, "no binder or box")}, ${mine[0]!.set_name ?? "unknown set"} #${mine[0]!.collector_number}, ${CONDITIONS[mine[0]!.condition] ?? mine[0]!.condition}${mine[0]!.finish !== "nonfoil" ? `, ${mine[0]!.finish}` : ""}`
      : `In ${listWords(places.map((p) => (p === "Not filed" ? "no binder or box" : p)))}`;
  const ownedShort = places.length === 1 ? (places[0] === "Not filed" ? "Not filed" : `In ${places[0]}`) : `In ${places.length} places`;
  const pt = card.power ? `${card.power}/${card.toughness}` : card.loyalty ? `Loyalty ${card.loyalty}` : "";
  const typeLine = `${card.type_line.replace(" — ", ", ")}${pt ? `. ${pt}` : ""}`;
  const defaultPrinting = addPrinting(printings, card.default_printing);
  const addDefault = defaultPrinting && (defaultPrinting.finishes.includes("nonfoil") ? "nonfoil" : defaultPrinting.finishes[0]);
  const shown = printings.slice(0, allPrintings ? undefined : 12);
  const priceDate = printings.find((p) => p.price_date)?.price_date;

  // What the last add did, with how many there are now and a way to take it back. An add from
  // the card page sends no place, condition or language, so it lands on (or makes) the row of
  // that printing and finish that is not filed, near mint and English: Undo takes one off it.
  const sameKind = (i: CollectionItem) => !!added && i.scryfall_id === added.p.scryfall_id && i.finish === added.finish && i.proxy === added.proxy;
  const addedRow = added && !added.undone && !owned.isFetching ? mine.find((i) => sameKind(i) && i.container_id == null && i.condition === "NM" && i.lang === "en" && !i.altered && !i.signed && !i.misprint) : undefined;
  const addedCount = added && !owned.isFetching ? mine.reduce((a, i) => a + (sameKind(i) ? i.qty : 0), 0) : 0;
  const addedKind = added ? (added.finish === "foil" ? (foilKind(added.p)?.toLowerCase() ?? "foil") : added.finish) : "";
  const addedLine = added && (
    <>
      {added.undone
        ? `Took that ${added.proxy ? "proxy" : "copy"} back out of your collection.`
        : added.proxy
          ? `Added a proxy of ${card.name} (${added.p.set_name} #${added.p.collector_number} art) to your collection.`
          : `Added ${added.finish === "nonfoil" ? "a" : `${article(addedKind)} ${addedKind}`} ${added.p.set_name} #${added.p.collector_number} copy to your collection.`}
      {!added.undone && addedCount > 0 ? ` You have ${addedCount} now.` : ""}
      {addedRow && (
        <>
          {" "}
          <Button variant="quiet" size="small" className="cp-undo" disabled={undo.isPending} onClick={() => undo.mutate(addedRow)}>Undo</Button>
        </>
      )}
    </>
  );

  return (
    <div className="cp">
      {card.image_art_crop && (
        <div className="cp-hero" aria-hidden="true">
          <CardThumb src={card.image_art_crop} eager />
          <span className="cp-hero-wash" />
        </div>
      )}
      <div className="cp-inner">
        <Button className="cp-back" onClick={onBack} aria-label={backLabel} autoFocus>
          {close ? <CloseIcon /> : <BackIcon />}
          <span className="cp-back-text">{backLabel}</span>
        </Button>
        <div className="cp-body">
          {/* The full card shows here, so it carries the art's credit. */}
          <figure className="cp-figure">
            <ZoomableCard src={flipped && card.back_image_normal ? card.back_image_normal : card.image_normal} name={card.name} />
            <figcaption>
              {card.artist ? `Art by ${card.artist}. ` : ""}™ &amp; © Wizards of the Coast. Image from Scryfall.
            </figcaption>
            {card.back_image_normal && (
              <Button variant="quiet" size="small" className="cp-flip" onClick={() => setFlipped((f) => !f)}>Show the other face</Button>
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
                {card.mana_cost && <span className="cp-cost-inline"><ManaCost cost={card.mana_cost} />{". "}</span>}
                {typeLine}
              </p>
            </div>
            {card.oracle_text && <p className="cp-oracle"><SymbolText text={card.oracle_text} /></p>}
            <div className="cp-chips">
              <Legality status={card.legalities.commander} />
              {canBeCommander(card) && <span className="cp-chip">Can be your commander</span>}
              {card.game_changer === true && <Tag className="gc" title="On the Commander Game Changers list, per Scryfall">Game Changer</Tag>}
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
                  {real === 0 && proxies > 0 ? plural(proxies, "proxy", "proxies") : (
                    <>
                      <span className="cp-wide">{real === 0 ? "None" : `${real} ${real === 1 ? "copy" : "copies"}`}</span>
                      <span className="cp-narrow">{real}</span>
                      {proxies > 0 && <span className="cp-fact-also">, and {plural(proxies, "proxy", "proxies")}</span>}
                    </>
                  )}
                </b>
                <span className="cp-fact-note">
                  {owned.isPending ? "Checking your collection…" : copies === 0 ? "Not in your collection" : (
                    <>
                      {real === 0 ? "No real copy. " : ""}
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
                <Button variant="primary" onClick={() => add.mutate({ p: defaultPrinting, finish: addDefault })} disabled={add.isPending || undo.isPending}>
                  Add to collection
                </Button>
                <Button variant="outline" onClick={() => add.mutate({ p: defaultPrinting, finish: "nonfoil", proxy: true })} disabled={add.isPending || undo.isPending}>
                  Add a proxy
                </Button>
                <Button variant="outline" onClick={() => wish.mutate(card.name)} disabled={wish.isPending || wish.isSuccess}>
                  {wish.isSuccess ? "On your wish list" : "Add to wish list"}
                </Button>
                {/* Which printing the button files the card under, and where it goes. */}
                <p className="cp-note cp-adds">
                  Add to collection adds {defaultPrinting.set_name} #{defaultPrinting.collector_number}
                  {addDefault === "nonfoil" ? "" : `, ${addDefault === "etched" ? "etched" : (foilKind(defaultPrinting)?.toLowerCase() ?? "foil")}`}, not filed. {printings.length > 1 ? "Pick another printing below." : ""}
                </p>
              </div>
            )}
            {added && !added.row && <p className="small" role="status" style={{ margin: 0 }}>{addedLine}</p>}
            {!add.variables?.row && <ErrorText error={add.error} />}
            {!added?.row && <ErrorText error={undo.error} />}
            {wish.isSuccess && (
              <p className="small" role="status" style={{ margin: 0 }}>
                Added {card.name} to your <Link to="/collection/wishlist">wish list</Link>.
              </p>
            )}
            <ErrorText error={wish.error} />

            {!guest && <CardInDecks oracleId={oracleId} />}

            {detail.data?.rulings !== undefined && <Rulings rulings={detail.data.rulings} />}

            {printings.length > 0 && (
              <section className="cp-printings" aria-labelledby={`pr-${oracleId}`}>
                <h2 id={`pr-${oracleId}`}>Printings</h2>
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th className="cp-pic"><span className="visually-hidden">Picture</span></th>
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
                      // "Surge foil", "Showcase, Borderless": what sets this printing apart.
                      const special = treatmentLabel(p);
                      const label = `${card.name}, ${p.set_name} #${p.collector_number}${special ? `, ${special}` : ""}`;
                      const charted = chart?.id === p.scryfall_id;
                      return (
                        <Fragment key={p.scryfall_id}>
                        <tr>
                          {/* Each printing's own picture; tapping it shows the card full size. */}
                          <td className="cp-pic">
                            {p.image_small || p.image_normal ? (
                              <ZoomableCard src={p.image_small || p.image_normal} zoomSrc={p.image_normal} name={label} className="cp-pic-img" />
                            ) : (
                              <span className="cp-pic-none">No picture</span>
                            )}
                          </td>
                          <td className="cp-what">
                            <Button className="cp-set" aria-expanded={charted} onClick={() => setChart(charted ? null : { id: p.scryfall_id, finish, set: p.set_name })} aria-label={`${p.set_name} #${p.collector_number}: show its price history`}>
                              <span className="cp-set-name">{p.set_name}</span> <span className="cp-set-num">#{p.collector_number}</span>
                              {special && <span className="cp-set-num">, {special}</span>}
                            </Button>
                            {yours != null && <StatusPill tone="good" className="cp-yours">Yours, {yours}</StatusPill>}
                            {/* Phones: one line under the set for the number, your copies' finish, then the foil market price. */}
                            <span className="cp-set-sub">
                              #{p.collector_number}
                              {special ? `, ${special}` : ""}
                              {yours != null && <span className="good">, yours ({yours})</span>}
                              {hasFoil && p.finishes.includes("nonfoil") ? (foil == null ? ". No foil price" : `. Foil market ${usd(foil)}`) : ""}
                            </span>
                            {/* An add from this row says what it did here, not off-screen at the top. */}
                            {added?.row === p.scryfall_id && <span className="cp-row-status" role="status">{addedLine}</span>}
                            {add.variables?.row === p.scryfall_id && <ErrorText error={add.error} small />}
                            {added?.row === p.scryfall_id && <ErrorText error={undo.error} small />}
                          </td>
                          <td className={`r num cp-normal${p.finishes.includes("nonfoil") && p.usd == null ? " dim" : ""}`}>
                            {p.finishes.includes("nonfoil") ? usd(p.usd) : <span className="cp-only-foil">{usd(foil)}</span>}
                          </td>
                          <td className={`r num cp-foil${hasFoil && foil == null ? " dim" : ""}`}>{hasFoil ? usd(foil) : ""}</td>
                          {!readOnly && (
                            <td className="r cp-add">
                              <span className="cp-add-row">
                                {p.finishes.map((f) => {
                                  const word = finishWord(p, f);
                                  return (
                                    <Button key={f} size="small" disabled={add.isPending || undo.isPending} onClick={() => add.mutate({ p, finish: f, row: p.scryfall_id })} aria-label={`Add ${article(word)} ${word.toLowerCase()} ${p.set_name} #${p.collector_number} copy to your collection`}>
                                      + {word}
                                    </Button>
                                  );
                                })}
                                <Button size="small" variant="outline" disabled={add.isPending || undo.isPending} onClick={() => add.mutate({ p, finish: "nonfoil", proxy: true, row: p.scryfall_id })} aria-label={`Add a proxy with the ${p.set_name} #${p.collector_number} art to your collection`}>
                                  + Proxy
                                </Button>
                              </span>
                            </td>
                          )}
                        </tr>
                        {/* Its price history opens under the printing that was tapped, not above the table. */}
                        {chart && charted && (
                          <tr className="cp-chart-row">
                            <td colSpan={readOnly ? 4 : 5}>
                              <PriceHistory key={chart.id} scryfallId={chart.id} finish={chart.finish} setName={chart.set} reveal />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {printings.length > 12 && !allPrintings && (
                  <ShowMore total={printings.length} noun="printings" onToggle={() => setAllPrintings(true)} />
                )}
                <p className="cp-note">
                  Tap a picture to see it full size, or a set for its price history.{readOnly ? "" : " The + buttons add one copy of that printing to your collection, not filed; + Proxy adds a proxy with its art."} Prices are {priceSource(priceDate)}. Market prices aren't a quote from any store. A missing price says so.
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
  if (status === "legal") return <StatusPill tone="good">Commander: legal</StatusPill>;
  if (status === "banned") return <StatusPill tone="bad">Commander: banned</StatusPill>;
  const text = status ? status.replace("_", " ") : "unknown";
  return <StatusPill>Commander: {text}</StatusPill>;
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
