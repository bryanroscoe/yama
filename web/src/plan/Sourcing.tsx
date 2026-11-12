import { usd, fmtDateTime, count, plural } from "@yama/core";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { CardRef } from "../components/CardRef";
import { Button, ButtonLink, ErrorText, Loading } from "../components/ui";
import { report, reports, safeUrl, type ResearchBundle } from "../research/api";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { allChoices, choicesFor, offerRows, offerId, optionalUse, portfolioRows, sourceSnapshot, sourceCarts, type SourceChoice } from "./sourcing-model";
import { localBuyRule, rulesAt, MAX_RULE_USD, shoppingRulesProblems, type RuleSet } from "@yama/core/plan";
import { fetchBundle, saveShoppingRules, storeCatalogs, checkStores, storeSnapshots } from "./api";
import { capDraft, pricedRows, readCap } from "./source-pricing";
import "./sourcing.css";

export function Sourcing() {
  const { userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const notes = useQuery({ queryKey: ["research", userId], queryFn: reports });
  const id = params.get("report") ?? notes.data?.find(n => /sourc/i.test(n.title))?.id ?? "";
  const snapshot = useQuery({ queryKey: ["research", userId, id], queryFn: ({ signal }) => report(id, signal), enabled: !!id });
  return <div className="sourcing-page">
    <PlansHead title="Shop across your decks" />
    <nav className="source-nav"><Link to="/decks/plans/get/trip">Active plan store trip</Link><a href="/docs/mcp/#local-shopping">Buying guide</a></nav>
    <label className="source-report">Saved shopping list <select value={id} onChange={e => setParams(e.target.value ? { report: e.target.value } : {})}><option value="">Choose a report</option>{notes.data?.map(n => <option key={n.id} value={n.id}>{n.title} (revision {n.revision})</option>)}</select></label>
    <ErrorText error={notes.error ?? snapshot.error} />
    {(notes.isPending || (!!id && snapshot.isPending)) && <Loading>Loading shopping list…</Loading>}
    {!notes.isPending && !id && <p>No sourcing report selected. Ask your assistant to save a portfolio source check with per-copy allocations and dated store offers.</p>}
    {snapshot.data && <Portfolio key={`${userId}:${id}:${snapshot.data.revision}`} bundle={snapshot.data} />}
  </div>;
}

export function Portfolio({ bundle }: { bundle: ResearchBundle }) {
  const { view, userId } = usePlanOutlet();
  const qc = useQueryClient();
  const [freshSettings, setFreshSettings] = useState<RuleSet[] | null>(null);
  useEffect(() => setFreshSettings(null), [view.b.settings]);
  const settings = freshSettings ?? view.b.settings ?? [];
  const today = view.today ?? new Date().toISOString().slice(0,10);
  const current = localBuyRule(rulesAt(settings,today));
  const savedCap = current.rule?.max_usd ?? null;
  const [capText, setCapText] = useState<string | null>(null);
  const capInput = capText ?? (savedCap == null ? "" : String(savedCap));
  const cap = readCap(capInput);
  const draft = capDraft(settings,today,cap.value);
  const problems = cap.valid ? shoppingRulesProblems(draft) : [`Enter a price from $0 to $${MAX_RULE_USD}, or leave blank for no ceiling.`];
  const saveCap = useMutation({
    mutationFn: async (maximum: number | null) => {
      const latest = await fetchBundle();
      if (!("settings" in latest)) throw new Error("Could not load current shopping rules. Try again before saving.");
      setFreshSettings(latest.settings);
      const next = capDraft(latest.settings,today,maximum);
      const invalid = shoppingRulesProblems(next);
      if (invalid.length) throw new Error(invalid.join(" "));
      return saveShoppingRules({ effective_from: today, ...next, note: "Local per-card cap set from sourcing" });
    },
    // Keep the entered preview: a failed refetch must not restore the stale saved ceiling.
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["plan",userId] }); },
  });
  const catalogMeta = useQuery({queryKey:["store-catalogs",userId],queryFn:storeCatalogs});
  const refreshCatalog = useMutation({mutationFn:()=>checkStores({stores:catalogMeta.data?.catalogs.map(c=>c.store) ?? [],cards:[],yestcg:false,refresh_catalog:true}),onSuccess:()=>qc.invalidateQueries({queryKey:["plan-stock",userId]})});
  const catalogProgress = useQuery({queryKey:["plan-stock",userId],queryFn:storeSnapshots,enabled:refreshCatalog.isSuccess,refetchInterval:q=>q.state.data?.snapshots.some(s=>s.status==="running") ? 4000 : false});
  const catalogSnapshots = catalogProgress.data?.snapshots.filter(s=>refreshCatalog.data?.snapshots.some(start=>start.id===s.id)) ?? [];
  const catalogRunning = refreshCatalog.isPending || (refreshCatalog.isSuccess && (!catalogSnapshots.length || catalogSnapshots.some(s=>s.status==="running")));
  useEffect(()=>{if(catalogProgress.data && !catalogRunning) void qc.invalidateQueries({queryKey:["store-catalogs",userId]});},[catalogProgress.data,catalogRunning,qc,userId]);
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
  const [store, setStore] = useState("");
  const [condition, setCondition] = useState("nm");
  const [onlyOffers, setOnlyOffers] = useState(true);
  const [recordedStockOnly, setRecordedStockOnly] = useState(false);
  const [choices, setChoices] = useState<Record<string, SourceChoice[]>>({});
  const portfolio = useMemo(() => portfolioRows(cards, doc, decks, bracket, scope), [cards, doc, decks, bracket, scope]);
  const rows = offerRows(pricedRows(portfolio,draft.local_buy,problems.length === 0),condition,store,recordedStockOnly).filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const visible = rows.filter(c => !onlyOffers || c.offers.some(o => o.qualifies && o.qty !== 0 && o.price != null));
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
  const unconfirmed = carts.flatMap(c => c.rows).filter(r => r.offer.qty == null).reduce((n,r) => n+r.qty,0);
  const copies = visible.flatMap(c => c.uses), optional = copies.filter(optionalUse).length;
  const change = (name: string, url: string, qty: number) => setChoices(c => ({ ...c, [name]: [...choicesFor(c,name).filter(o => o.offer !== url), { offer: url, qty }] }));
  const dates = [...new Set(cards.flatMap(c => c.offers.map(o => o.checked_at).filter(Boolean)))].sort();
  if (!cards.some(c => c.uses.length)) return <p>This report has no portfolio source rows. Ask your assistant for a <code>local_sources</code> snapshot, or use the active plan store trip.</p>;
  return <>
    {parsed.conflicts.length > 0 && <p role="alert">{parsed.conflicts.length} conflicting copy identities excluded; these need reconciliation.</p>}
    <div className="source-freshness"><b>Saved quotes{dates.at(-1) ? ` through ${fmtDateTime(dates.at(-1))}` : ": date unknown"}</b><span>Search links open a store; they do not run a stock check.</span><details><summary>List version and evidence</summary><p>{doc.summary}</p><p>Report revision {bundle.revision}. Quote dates: {dates.length ? `${fmtDateTime(dates[0])} to ${fmtDateTime(dates.at(-1))}` : "unknown"}. Owned cards and print reservations have not been rechecked. This list does not approve a plan or place an order.</p><Link to={`/decks/plans/archived/${encodeURIComponent(doc.id)}`}>Source report and methods</Link> and <Link to="/decks/plans/settings#shopping-rules">Your buying rules</Link></details></div>
    <details className="source-methods"><summary>Cached store catalogs</summary>
      <p>A catalog contains printings, condition and finish variants, prices and availability flags. Exact quantities need variant-specific stock evidence. Cached prices are dated; refreshing a catalog does not refresh this saved report or change a cart.</p>
      {catalogMeta.data?.catalogs.map(c=><p key={c.store}>{c.name}: {c.fetched_at ? `${count(c.products ?? 0)} products, fetched ${fmtDateTime(c.fetched_at)}` : "No saved catalog"}.</p>)}
      <Button disabled={!catalogMeta.data?.catalogs.length || refreshCatalog.isPending || catalogRunning} onClick={()=>refreshCatalog.mutate()}>{catalogRunning ? "Refreshing catalogs…" : "Refresh store catalogs"}</Button>
      <ErrorText error={catalogMeta.error ?? refreshCatalog.error ?? catalogProgress.error}/>
      {catalogSnapshots.filter(s=>s.error).map(s=><p key={s.id} role="alert">{s.error}</p>)}
      {refreshCatalog.isSuccess && !catalogRunning && catalogProgress.data && <p role="status">Catalog check finished. Read the store check results for any errors. Ask your assistant to check the wanted cards against the cache and update this saved report; existing builds and choices stay intact.</p>}
    </details>
    <section className="source-cap" aria-label="Local price limit">
      <label>Maximum per card ($)<input type="number" inputMode="decimal" min={0} max={MAX_RULE_USD} step="0.05" disabled={saveCap.isPending} placeholder="No ceiling" value={capInput} onChange={e => { setCapText(e.target.value); saveCap.reset(); }} /></label>
      <Button disabled={problems.length > 0 || saveCap.isPending || (cap.value === savedCap || (saveCap.isSuccess && cap.value === saveCap.variables))} onClick={() => saveCap.mutate(cap.value)}>{saveCap.isPending ? "Saving…" : "Save cap as default"}</Button>
      <span className="small dim">Applies now to this page and its carts. Save to use it for future shopping. Blank means no dollar ceiling; your market limits still apply.</span>
      {cap.value != null && current.rule?.always_ok_usd != null && cap.value < current.rule.always_ok_usd && <span className="small dim">Saving also lowers your always-okay amount to {usd(cap.value)} to fit this ceiling.</span>}
      {problems.length > 0 && <p role="alert">{problems.join(" ")}</p>}
      <ErrorText error={saveCap.error} />{saveCap.isSuccess && <span role="status">Local cap saved.</span>}
      <details><summary>Market limits and other buying rules</summary><p>Last loaded buying rule: {current.text}</p><Link to="/decks/plans/settings#shopping-rules">Change the full buying rule</Link></details>
    </section>
    {rows.some(c => c.offers.some(o => o.eligibility_unknown)) && <p className="small dim">Some older listings lack condition, finish or language evidence. They stay out of carts until the saved report is updated; a higher dollar ceiling alone cannot verify those details.</p>}
    <div className="source-filters">
      <label>Bracket<select value={bracket} onChange={e => setBracket(e.target.value)}><option value="">All brackets (one copy per deck)</option>{[2,3,4,5].map(b => <option key={b} value={b}>Bracket {b}</option>)}</select></label>
      <label>Cards for<select value={scope} onChange={e => setScope(e.target.value)}><option value="all">All needs and optional upgrades</option><option value="gaps">Cards to source</option><option value="optional">Real replacements for proxies</option></select></label>
      <label>Condition<select value={condition} onChange={e => setCondition(e.target.value)}><option value="nm">Near Mint only</option><option value="any">Any saved condition (prefer NM)</option></select></label>
      <label>Store<select value={store} onChange={e => setStore(e.target.value)}><option value="">All stores</option>{stores.map(s => <option key={s.key}>{s.name}</option>)}</select></label>
      <label>Find a card<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="source-filter-options"><label className="source-check"><input type="checkbox" checked={onlyOffers} onChange={e => setOnlyOffers(e.target.checked)} />Within buy rules only</label><label className="source-check"><input type="checkbox" checked={recordedStockOnly} onChange={e => setRecordedStockOnly(e.target.checked)} />Exclude unknown stock counts</label></div>
    </div>
    <details className="source-deck-picker"><summary>Decks: {count(decks.size)} of {count(recipients.size)} selected</summary><div className="source-actions"><Button onClick={() => setDecks(new Set(recipients.keys()))}>All decks</Button><Button onClick={() => setDecks(new Set())}>Clear decks</Button></div><div className="source-decks">{[...recipients].sort((a,b) => a[1].localeCompare(b[1])).map(([key,name]) => <label className="source-check" key={key}><input type="checkbox" checked={decks.has(key)} onChange={() => setDecks(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })} />{name}</label>)}</div></details>
    <section className="source-selection" aria-label="Selected store carts">
      <div className="source-actions"><Button onClick={() => setChoices(allChoices(visible))}>Add all matching cards</Button>{selectedCopies > 0 && <Button onClick={() => setChoices({})}>Clear selection</Button>}</div>
      <p><b>{plural(selectedCopies,"selected copy","selected copies")}. {usd(carts.reduce((n,c) => n+c.total,0))} before tax.</b>{unconfirmed > 0 && <span> {plural(unconfirmed,"copy needs","copies need")} stock confirmation.</span>}</p>
      <p className="small dim">Adds matching copies up to the saved stock counts, using other eligible printings for any remainder. Listings without a count are not added automatically: the store listed the card, but we have not verified how many copies it can supply. You can request those copies individually; the store may reject or reduce the quantity. No purchase is made.</p>
      {carts.length > 0 && <details open><summary>Store carts and listings</summary>{carts.map(cart => <div className="source-cart" key={cart.rows[0]!.offer.url}><h3>{cart.store}: {usd(cart.total)}</h3>{cart.url && <ButtonLink href={cart.url} target="_blank" rel="noreferrer">Open filled store cart</ButtonLink>}<ul>{cart.rows.map(r => <li key={`${r.card}:${offerId(r.offer)}`}>{r.qty} × <a href={r.offer.url} target="_blank" rel="noreferrer">{r.card}</a>{r.offer.qty == null && " — stock unconfirmed"}</li>)}</ul>{!cart.url && <p>Add these on their store listing pages; this store has no filled-cart link.</p>}</div>)}<p className="small dim">Filled Shopify links replace the existing store cart. Choose pickup at checkout. This is the selected subtotal, not the cost to complete every deck.</p></details>}
    </section>
    <p className="small dim">{plural(Math.max(0,copies.length-selectedCopies),"matching copy not selected","matching copies not selected")}. Missing stock counts and shortages stay unresolved; a cart is not proof that every copy is available.</p>
    <p className="source-count">{plural(visible.length,"matching card")}. {plural(copies.length-optional,"copy to source","copies to source")} and {plural(optional,"optional real replacement","optional real replacements")} across selected decks. {condition === "nm" && "Only saved Near Mint offers are shown; other conditions and unrecorded NM variants are excluded."}</p>
    <div className="source-rows">{visible.map(c => {
      const offers = c.offers.filter(o => (!onlyOffers || o.qualifies) && o.price != null && o.qty !== 0);
      return <article className="source-card" key={c.name}>
        <header><h3><CardRef name={c.name} /></h3><span>{plural(c.uses.length,"copy","copies")}</span></header>
        <div className="source-recipients">{[...new Set(c.uses.map(u => u.deck))].map(key => {const uses=c.uses.filter(u=>u.deck===key);const brackets=[...new Set(uses.flatMap(u=>u.brackets??[]))].sort();return <span key={key}><b>Deck: {uses[0]!.deck_name}</b>. {brackets.length ? `Bracket ${brackets.join(" / ")}` : "Outside bracket builds"}. {uses.length} {uses.every(optionalUse) ? "optional real replacement" : "to source"}</span>;})}</div>
        {offers.map(o => {
          const exact=!!o.printing_id && /^(retailer image ID|retailer set and collector number|scryfall id)$/i.test(o.market_match ?? "") && !!o.market_source;
          const peers=o.printing_id && o.finish ? offers.filter(p=>p.printing_id===o.printing_id && p.finish===o.finish && p.condition===o.condition && p.price!=null) : [];
          const low=peers.length ? Math.min(...peers.map(p=>p.price!)) : null;
          return <div className="source-offer" key={offerId(o)}>
            <div><a href={o.url} target="_blank" rel="noreferrer">{o.store}</a><span className="small dim">{o.title || "Printing not recorded"}. {o.condition || "Condition unknown"}.</span><span className="small dim">{o.qty == null ? "Stock count unknown: available quantity not verified" : `${o.qty} listed`}. {o.qty != null && <>Stock checked: {o.quantity_checked_at || o.checked_at ? fmtDateTime(o.quantity_checked_at || o.checked_at) : "date unknown"}. </>}Price checked: {o.checked_at ? fmtDateTime(o.checked_at) : "date unknown"}.</span></div>
            <div className="source-prices"><b>{usd(o.price!)}</b>{!o.qualifies && <span className="small">{o.eligibility_unknown ? "Listing details need verification" : "Outside buy rules"}</span>}<span className="small">{o.market != null ? <>{exact ? "Printing market" : "Market reference"}: {o.market_source ? <a href={o.market_source} target="_blank" rel="noreferrer">{usd(o.market)}</a> : usd(o.market)}</> : "Printing market unavailable"}</span><span className="small dim">{low != null ? `Lowest saved ${o.condition || "condition unknown"}: ${usd(low)}` : "Condition low unavailable"}</span>{o.market != null && <span className="small dim">Market is not condition-specific.{o.market_checked_at ? ` Checked: ${fmtDateTime(o.market_checked_at)}.` : ""}</span>}</div>
            <label className="source-qty">Copies<input disabled={!o.qualifies} aria-label={`${c.name} copies from ${o.store}`} type="number" min={0} max={Math.min(c.uses.length,o.qty ?? Infinity)} step={1} value={choicesFor(choices,c.name).find(choice => choice.offer === offerId(o))?.qty ?? 0} onChange={e=>change(c.name,offerId(o),+e.target.value)} /></label>
          </div>;
        })}
        {!offers.length && <p className="small dim">No saved offer matches these condition and store filters.</p>}
        <details className="source-searches"><summary>Search stores for {c.name}</summary><div className="source-links">{stores.map(s=>{const safe=safeUrl(s.homepage??"");if(!safe)return <span key={s.key}>{s.name}: contact store</span>;const url=new URL(safe);if(s.cart_url_template?.includes("/cart/{items}")){url.pathname="/search";url.search=new URLSearchParams({type:"product",q:c.name}).toString();}else if(/^[a-z0-9-]+\.tcgplayerpro\.com$/i.test(url.hostname)){url.pathname="/search/products";url.search=new URLSearchParams({q:c.name,productLineName:"Magic: The Gathering",sort:"price-asc"}).toString();}return <a key={s.key} href={url.href} target="_blank" rel="noreferrer">{s.name}</a>;})}</div><p className="small dim">Links open a new search when you click. They have no saved result or check date.</p></details>
      </article>;
    })}</div>
    <details className="source-methods"><summary>Refresh availability and sell cards</summary><p>Checks can run programmatically through Yama. Ask your assistant to refresh the selected cards with <code>check_stores</code> (300 names per check), then save the results back to this report. The active plan store trip also has a Check stores button. Refreshing trip stock does not regenerate this saved preview.</p><p>Sell cards separately: <a href="https://buylist.mothershipatx.com/">Mothership buylist</a> and <a href="https://patsgames.com/pages/buylist">Pat’s buylist</a>.</p></details>
  </>;
}
