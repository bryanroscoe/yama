import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { CardRef } from "../components/CardRef";
import { ErrorText } from "../components/ui";
import { money, report, reports, safeUrl, type ResearchBundle } from "../research/api";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { choicesFor, knownStockChoices, optionalUse, portfolioRows, sourceSnapshot, sourceCarts, type SourceChoice } from "./sourcing-model";
import "./sourcing.css";

/** Private, read-only portfolio preview. Does not approve builds or change the active trip. */
export function Sourcing() {
  const { userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const notes = useQuery({ queryKey: ["research", userId], queryFn: reports });
  const id = params.get("report") ?? notes.data?.find(n => /sourc/i.test(n.title))?.id ?? "";
  const snapshot = useQuery({ queryKey: ["research", userId, id], queryFn: ({ signal }) => report(id, signal), enabled: !!id });
  return <>
    <PlansHead title="Source cards across decks" />
    <p>One combined list for all your decks, with each physical copy counted once per recipient. Preview proposed builds without approving or installing them.</p>
    <nav className="row wrap"><Link to="/decks/plans/get/trip">Active plan store trip</Link><a href="/docs/mcp/#local-shopping">How local sourcing works</a></nav>
    <label>Saved sourcing evidence <select value={id} onChange={e => setParams(e.target.value ? { report: e.target.value } : {})}><option value="">Choose a report</option>{notes.data?.map(n => <option key={n.id} value={n.id}>{n.title} · revision {n.revision}</option>)}</select></label>
    <ErrorText error={notes.error ?? snapshot.error} />
    {(notes.isPending || (!!id && snapshot.isPending)) && <p>Loading sourcing evidence…</p>}
    {!notes.isPending && !id && <p>No sourcing report selected. Ask your assistant to save a portfolio source check with per-copy allocations and dated store offers, then choose it here. Your active plan trip remains available above.</p>}
    {snapshot.data && <Portfolio key={`${userId}:${id}:${snapshot.data.revision}`} bundle={snapshot.data} />}
  </>;
}

export function Portfolio({ bundle }: { bundle: ResearchBundle }) {
  const { view } = usePlanOutlet();
  const doc = bundle.document;
  const parsed = useMemo(() => sourceSnapshot(doc.local_sources), [doc]);
  const cards = parsed.cards;
  const recipients = useMemo(() => {
    const valid = portfolioRows(cards,doc,new Set(cards.flatMap(c => c.uses.map(u => u.deck))),"","all");
    return new Map(valid.flatMap(c => c.uses.map(u => [u.deck,u.deck_name] as const)));
  }, [cards,doc]);
  const [decks, setDecks] = useState(() => new Set(recipients.keys()));
  const [bracket, setBracket] = useState("");
  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");
  const [onlyOffers, setOnlyOffers] = useState(true);
  const [choices, setChoices] = useState<Record<string, SourceChoice[]>>({});
  const [limit, setLimit] = useState(100);
  const rows = useMemo(() => portfolioRows(cards, doc, decks, bracket, scope), [cards, doc, decks, bracket, scope]);
  const visible = rows.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) && (!onlyOffers || c.offers.some(o => o.qualifies && o.qty !== 0 && o.price != null)));
  const stores = view.b.stores.filter(s => !s.retired && s.kind !== "printer");
  const cartTemplates = new Map<string,string>();
  for (const s of stores) {
    if (!s.cart_url_template?.startsWith("https://") || !s.cart_url_template.includes("{items}")) continue;
    const home = safeUrl(s.homepage ?? "");
    if (home) cartTemplates.set(new URL(home).origin, s.cart_url_template);
    for (const o of cards.flatMap(c => c.offers).filter(o => o.store === s.name)) cartTemplates.set(new URL(o.url).origin, s.cart_url_template);
  }
  const carts = sourceCarts(rows, choices, cartTemplates);
  const selectedCopies = carts.reduce((n,c) => n+c.rows.reduce((n,r) => n+r.qty,0),0);
  const copies = rows.flatMap(c => c.uses), optional = copies.filter(optionalUse).length;
  const change = (name: string, url: string, qty: number) => setChoices(c => ({ ...c, [name]: [...choicesFor(c,name).filter(o => o.offer !== url), { offer: url, qty }] }));
  const dates = [...new Set(cards.flatMap(c => c.offers.map(o => o.checked_at).filter(Boolean)))].sort();
  if (!cards.some(c => c.uses.length)) return <p>This report has no portfolio source rows. Ask your assistant for a <code>local_sources</code> snapshot, or use the active plan store trip. Individual research sources do not establish copy quantities.</p>;
  return <>
    {parsed.conflicts.length > 0 && <p role="alert">{parsed.conflicts.length} conflicting copy identities were excluded. Ask your assistant to reconcile the source report before buying those copies.</p>}
    <section className="source-notice"><p><b>Saved preview, revision {bundle.revision}.</b> Lists recorded {doc.generated_at}; quotes checked {dates.length ? `${dates[0]} to ${dates.at(-1)}` : "at an unknown time"}. These are dated observations, not reserved stock or a live refresh.</p><p>{doc.summary}</p><p>This view uses the selected report’s recorded targets and copy allocations. Recheck it against newer deck versions, orders and inventory before buying. Optional real replacements do not cancel print reservations. Its qualifying offers use the report’s dated buy rules; compare <Link to="/decks/plans/settings#shopping-rules">your current rules</Link> before checkout.</p><Link to={`/decks/plans/archived/${encodeURIComponent(doc.id)}`}>Open source report and methods</Link></section>
    <details className="plans-details"><summary>Choose decks ({decks.size} of {recipients.size})</summary><div className="row wrap"><button onClick={() => setDecks(new Set(recipients.keys()))}>All decks</button><button onClick={() => setDecks(new Set())}>Clear decks</button></div><div className="source-decks">{[...recipients].sort((a,b) => a[1].localeCompare(b[1])).map(([key,name]) => <label key={key}><input type="checkbox" checked={decks.has(key)} onChange={() => setDecks(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })} />{name}</label>)}</div></details>
    <div className="source-filters"><label>Bracket <select value={bracket} onChange={e => setBracket(e.target.value)}><option value="">All bracket alternatives (union)</option>{[2,3,4,5].map(b => <option key={b} value={b}>Bracket {b}</option>)}</select></label><label>Copies <select value={scope} onChange={e => setScope(e.target.value)}><option value="all">All source wishes</option><option value="gaps">Unresolved source only</option><option value="optional">Optional real replacements only</option></select></label><label>Find a card <input value={search} onChange={e => setSearch(e.target.value)} /></label><label><input type="checkbox" checked={onlyOffers} onChange={e => setOnlyOffers(e.target.checked)} />Qualifying offers only</label></div>
    <p>{rows.length} card names / {copies.length} copy wishes across selected decks: {copies.length - optional} unresolved sources and {optional} optional real replacements. Bracket alternatives are not added together. The all-brackets view also retains explicitly recorded permanent optional wishes and packet bonuses outside those builds.</p>
    <section aria-label="Selected store carts"><h2>Your combined carts</h2><p>{selectedCopies} selected copies · {money(carts.reduce((n,c) => n+c.total,0))} before tax. This subtotal covers the selected copies only.</p><button onClick={() => setChoices(knownStockChoices(rows))}>Select all known-stock copies</button><p>Enter only quantities you confirmed on the listing. Deck, bracket and copy filters change cart demand; card search and pagination do not. Quantities are capped by selected copy wishes and known listed stock. The bulk button leaves unknown quantities unselected; confirm those with the store. No cards are bought or marked bought here.</p>{carts.length === 0 && <p>No quantities selected.</p>}{carts.map(cart => <div className="source-cart" key={cart.rows[0]!.offer.url}><h3>{cart.store} · {money(cart.total)} before tax</h3><ul>{cart.rows.map(r => <li key={`${r.card}:${r.offer.url}`}>{r.qty} × {r.card} — <a href={r.offer.url} target="_blank" rel="noreferrer">open listing</a></li>)}</ul>{cart.url ? <a className="button" href={cart.url} target="_blank" rel="noreferrer">Replace store cart with these cards</a> : <p>Add these variants on their listing pages; no filled-cart link is available for this store.</p>}</div>)}{carts.length > 0 && <button onClick={() => setChoices({})}>Clear selected quantities</button>}<p className="small dim">Filled Shopify cart links replace the existing store cart. Confirm stock, price, finish and condition, choose in-store pickup and complete checkout on the store’s site. Selected subtotals are not a full-deck completion cost.</p></section>
    <p>{visible.length} matching names. {onlyOffers && "Turn off “Qualifying offers only” to see unresolved and overpriced cards too."}</p>
    <div className="source-rows">{visible.slice(0,limit).map(c => {
      const offers = c.offers.filter(o => o.qualifies && o.price != null && o.qty !== 0);
      
      return <article className="source-card" key={c.name}><h3><CardRef name={c.name} /> · {c.uses.length} {c.uses.length === 1 ? "copy" : "copies"}</h3><p className="small dim">{c.status}</p><ul>{[...new Set(c.uses.map(u => u.deck))].map(key => { const uses = c.uses.filter(u => u.deck === key); return <li key={key}>{uses[0]!.deck_name}: {uses.length} ({uses.every(u => u.build_match === false) ? "standalone optional wish, outside these builds" : uses.every(optionalUse) ? "optional real replacement" : "check source before buying"})</li>; })}</ul>{offers.length > 0 ? offers.map(o => <div className="source-offer" key={o.url}><p><a href={o.url} target="_blank" rel="noreferrer">{o.store} · {money(o.price)}</a> · {o.condition}</p><p className="small dim">{o.qty == null ? "Quantity unknown; confirm on the store page" : `${o.qty} listed in snapshot`} · checked {o.checked_at || "date unknown"}</p><label>Copies from {o.store} (confirm stock) <input type="number" min={0} max={Math.min(c.uses.length,o.qty ?? Infinity)} step={1} value={choicesFor(choices,c.name).find(choice => choice.offer === o.url)?.qty ?? 0} onChange={e => change(c.name,o.url,+e.target.value)} /></label></div>) : <p>No verified qualifying listing in this snapshot.</p>}<details><summary>Search all your stores</summary><div className="source-links">{stores.map(s => { const safe = safeUrl(s.homepage ?? ""); if (!safe) return <span key={s.key}>{s.name}: ask the store{s.note ? ` — ${s.note}` : ""}</span>; const url = new URL(safe); if (s.cart_url_template?.includes("/cart/{items}")) { url.pathname="/search"; url.search=new URLSearchParams({type:"product",q:c.name}).toString(); } else if (/^[a-z0-9-]+\.tcgplayerpro\.com$/i.test(url.hostname)) { url.pathname="/search/products"; url.search=new URLSearchParams({q:c.name,productLineName:"Magic: The Gathering",sort:"price-asc"}).toString(); } return <a key={s.key} href={url.href} target="_blank" rel="noreferrer">{s.name}</a>; })}</div></details></article>;
    })}</div>{limit < visible.length && <button onClick={() => setLimit(n => n+100)}>Show next 100 names</button>}
    <details className="plans-details"><summary>How to refresh or sell cards</summary><p>Ask your assistant to read <code>yama://shopping/workflow</code>, verify all selected deck targets, and stage <code>check_stores</code> for explicit card names and stores, at most 300 names per check. Review before applying. Refreshing trip snapshots does not regenerate this saved research preview; the assistant must refresh the report and read it back. Failed checks stay unknown. No plan approval is required to preview sources.</p><p>Selling is separate from buying: use your collection’s Sell list and dated cash/credit offers. Store buylist entry points for Austin include <a href="https://buylist.mothershipatx.com/">Mothership</a> and <a href="https://patsgames.com/pages/buylist">Pat’s Games</a>.</p></details>
  </>;
}
