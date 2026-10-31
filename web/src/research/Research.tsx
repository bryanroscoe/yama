import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { ErrorText } from "../components/ui";
import { CardRef, CardText } from "../components/CardRef";
import { AccountingSummary, CompleteList, Gameplay, buildAccounting, listEntries, resolvedCombos } from "./details";
import { changedAnswer, importReport, money, report, reports, safeUrl, saveReview, targetForSwap, type Build, type Combo, type Item, type Power, type ResearchBundle, type ResearchDeck, type ReviewOp, type Scenario, type Source } from "./api";
import { isOwnedBuild, ownedBuildProblems } from "./availability";
import { AgentNotesAbout, DeckChanged } from "./about";
import { ShareNote } from "./ShareNote";
import "./research.css";

const LocalChecks = createContext<NonNullable<ResearchBundle["document"]["local_checks"]>>({});
function CardName({ name }: { name: string }) { return <CardRef name={name} />; }

function Sources({ sources = [] }: { sources?: Source[] }) {
  return <ul className="research-sources">{sources.map((s, i) => <li key={`${s.url}-${i}`}>{safeUrl(s.url) ? <a href={safeUrl(s.url)} target="_blank" rel="noreferrer">{s.title}</a> : s.title}{s.accessed && <span className="dim small"> — checked {s.accessed}</span>}</li>)}</ul>;
}

export function PowerSummary({ power }: { power?: Power }) {
  return <Gameplay legacy={power} />;
}

const KINDS: Record<string, string> = { keep: "Keep in this deck", sealed_purchase: "Precon purchase required", owned: "Available owned card", transfer: "Move from another deck", arrived_print: "Print already here", future_stock: "Stock after purchase/arrival", buy: "Local buy", print: "New print", basic: "Basic land", unknown: "Check source" };
export function AcquisitionItem({ item, showCard = true }: { item: Item; showCard?: boolean }) {
  const quote = item.quote ?? item;
  const check = useContext(LocalChecks)[item.local_check ?? item.card ?? ""];
  return <div className="research-item">
    {showCard && <p><b>{item.qty && item.qty > 1 ? `${item.qty} × ` : ""}{item.card && (item.kind==="sealed_purchase"?item.card:<CardName name={item.card} />)}</b>{item.deck && <span className="dim"> — {item.deck}</span>}</p>}
    {item.kind && <span className={`research-tag kind-${item.kind}`}>{KINDS[item.kind] ?? item.kind}</span>}
    {item.kind === "transfer" && item.source_deck && <p className="small">Move from {item.source_deck} once its replacement is ready.</p>}{item.detail && <details className="small research-provenance"><summary>Source details</summary><p>{item.detail}</p></details>}{item.reason && <p className="small dim">{item.reason}</p>}
    {(quote.store || item.kind === "buy") && <p className="small"><b>{quote.store || "Store unverified"}: {money(quote.price)}</b> before tax{quote.printing && `, ${quote.printing}`}{quote.condition && `, ${quote.condition}`}<br />{item.kind==="sealed_purchase"?"Sealed market reference":"Matched market"}: {money(quote.market)}{quote.checked && `; checked ${quote.checked}`}{safeUrl(quote.url) && <>. <a href={safeUrl(quote.url)} target="_blank" rel="noreferrer">Store listing</a></>}</p>}
    {check && <details className="small"><summary>Local search evidence</summary><p>{check.reason}</p><p className="dim">{check.coverage}</p><ul>{check.local_checks?.map((s, i) => <li key={i}>{s.store}, checked {s.checked ?? check.checked ?? "date unknown"}{s.search_may_be_truncated ? "; search may be incomplete" : ""}{!!s.errors?.length && `; unresolved: ${s.errors.join("; ")}`}</li>)}</ul>{check.market_reference && <p>Cheapest priced market reference: {money(check.market_reference.market)}{check.market_reference.set && `, ${check.market_reference.set.toUpperCase()} #${check.market_reference.num}`}{safeUrl(check.market_reference.url) && <>. <a href={safeUrl(check.market_reference.url)} target="_blank" rel="noreferrer">Market source</a></>}. This is a market reference, not a store offer.</p>}{check.rejected_offers?.map((r, i) => <p key={i}>{r.store}: {money(r.price)}, {r.printing}. {r.reason}{safeUrl(r.url) && <> <a href={safeUrl(r.url)} target="_blank" rel="noreferrer">Listing</a></>}</p>)}</details>}
  </div>;
}

function ReviewEditor({ bundle, target, buildId }: { bundle: ResearchBundle; target: string; buildId?: string }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const answer = bundle.reviews.find((r) => r.target === target);
  const [note, setNote] = useState(answer?.note ?? "");
  const save = useMutation({ mutationFn: (op: ReviewOp) => saveReview(bundle.document.id, op), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["research", userId, bundle.document.id] }); } });
  const decide = (decision: string | null) => { const hash = bundle.target_hashes[target]; if (hash) save.mutate({ op_id: crypto.randomUUID(), target, decision, note: note.trim() || null, expected_version: answer?.version ?? 0, target_hash: hash }); };
  const stale = answer && changedAnswer(bundle, answer);
  return <div className="research-review">
    {stale && <p className="small warn">The evidence changed since your answer. Your previous answer is kept; review it again.</p>}
    <div className="research-review-actions">{buildId ? <button type="button" className={answer?.decision === buildId && !stale ? "primary" : "outline"} disabled={save.isPending} onClick={() => decide(answer?.decision === buildId && !stale ? null : buildId)}>{answer?.decision === buildId && !stale ? "Preferred build ✓" : "Prefer this build"}</button> : ([ ["want", "Want"], ["unsure", "Unsure"], ["no", "Don’t want"] ] as const).map(([value, label]) => <button type="button" key={value} className={answer?.decision === value && !stale ? "primary" : "outline"} aria-pressed={answer?.decision === value && !stale} disabled={save.isPending} onClick={() => decide(answer?.decision === value && !stale ? null : value)}>{label}</button>)}</div>
    <label className="research-note"><span className="small">Your note</span><textarea rows={2} maxLength={6000} value={note} disabled={save.isPending} onChange={(e) => setNote(e.target.value)} /></label>
    <button type="button" className="outline small" disabled={save.isPending || note === (answer?.note ?? "")} onClick={() => decide(answer?.decision ?? null)}>Save note</button>
    <span className="small dim" role="status">{save.isPending ? " Saving…" : save.isError ? " Latest edit not saved" : save.isSuccess || answer ? " Saved in Yama" : " No answer yet"}</span>
    <ErrorText error={save.error} />{save.isError && save.variables && <button type="button" className="outline small" onClick={() => save.mutate(save.variables!)}>Retry same save</button>}
  </div>;
}

function ComboCard({ combo }: { combo: Combo }) {
  return <details className={`research-combo ${combo.present === false ? "is-missing" : ""}`}><summary><b>{combo.name}</b> <span className="dim small">{combo.kind}{combo.is_caution ? " — rules caution" : combo.present === false ? " — missing pieces" : " — pieces in this list"}</span></summary>
    <p className="small">{combo.cards?.map((name,i)=><span key={name}>{i>0 && " + "}<CardName name={name}/></span>)}</p>{!!combo.missing_cards?.length && <p className="warn small">Missing: {combo.missing_cards.map((name,i)=><span key={name}>{i>0 && ", "}<CardName name={name}/></span>)}</p>}
    {!!combo.setup?.length && <><h4>Setup</h4><ul>{combo.setup.map((x, i) => <li key={i}><CardText text={x} names={combo.cards ?? []}/></li>)}</ul></>}
    {!!combo.steps?.length && <><h4>Sequence</h4><ol>{combo.steps.map((x, i) => <li key={i}><CardText text={x} names={combo.cards ?? []}/></li>)}</ol></>}
    {combo.outcome && <p><b>Outcome:</b> <CardText text={combo.outcome} names={combo.cards ?? []}/></p>}{!!combo.stop_points?.length && <><h4>Where it stops</h4><ul>{combo.stop_points.map((x, i) => <li key={i}><CardText text={x} names={combo.cards ?? []}/></li>)}</ul></>}{combo.bracket_fit && <p className="small">{combo.bracket_fit}</p>}<Sources sources={combo.sources} />
  </details>;
}

function AcquisitionGroups({ deck, build }: { deck: ResearchDeck; build: Build }) {
  const acq = build.acquisition;
  const baseline = deck.builds.find((b) => ["current", "stock"].includes(b.id));
  const starting = new Set(baseline ? listEntries(baseline.list).map((r) => r.name) : []);
  const current = ["current", "stock"].includes(build.id);
  const kept = acq?.owned?.filter((r) => r.kind === "keep" || (starting.has(r.card ?? "") && !["future_stock", "transfer"].includes(r.kind ?? ""))) ?? [];
  const available = acq?.owned?.filter((r) => !kept.includes(r)) ?? [];
  const count = (rows: Item[] = []) => rows.reduce((n,r)=>n+(r.qty??1),0);
  if (current) return <p className="dim small">{acq?.note || "This is the starting reference, not an upgrade order. Its complete 100-card list is below."}</p>;
  return <section>
    <h3>What to keep, move, buy or print</h3>
    <p className="small dim">{acq?.note || "Keep the starting cards below. Other owned cards and arrived prints only need an action when they are entering this build."} Transfers wait for the donor deck to release its copy.</p>
    <div className="research-acquisition-grid">
      <details><summary>Keep in this deck ({count(kept)})</summary><p className="small dim">Already in the starting reference; no acquisition or move is needed.</p>{kept.map((r,i)=><p className="small" key={i}>{r.qty && r.qty>1 && `${r.qty} × `}{r.card && <CardName name={r.card}/>}</p>)}</details>
      <details open={available.length>0}><summary>Other owned cards and projected stock ({count(available)})</summary>{available.map((r,i)=><AcquisitionItem key={i} item={r}/>)}</details>
      <details open={!!acq?.buys?.length}><summary>Local singles to buy ({count(acq?.buys)})</summary>{acq?.buys?.length ? acq.buys.map((r,i)=><AcquisitionItem key={i} item={r}/>) : <p className="small dim">No additional qualifying local single allocated.</p>}</details>
      <details open><summary>Additional prints ({count(acq?.prints)})</summary>{acq?.prints?.length ? acq.prints.map((r,i)=><AcquisitionItem key={i} item={r}/>) : <p className="small dim">No additional print allocated.</p>}</details>
      {!!acq?.basics?.length && <details><summary>Ordinary basic lands ({count(acq.basics)})</summary><p className="small dim">Included in the 100-card total; excluded from print orders.</p>{acq.basics.map((r,i)=><p key={i}>{r.qty??1} × {r.card && <CardName name={r.card}/>}</p>)}</details>}
    </div>
  </section>;
}

function BuildView({ bundle, deck, build }: { bundle: ResearchBundle; deck: ResearchDeck; build: Build }) {
  const [copy, setCopy] = useState("");
  const download = () => {
    const url = URL.createObjectURL(new Blob([build.list], { type: "text/plain" }));
    const a = document.createElement("a");a.href = url;a.download = `${deck.key}-${build.id}.txt`;a.click();URL.revokeObjectURL(url);
  };
  const combos = resolvedCombos(deck,build);
  const present = combos.filter((c) => c.present !== false);
  const missing = combos.filter((c) => c.present === false);
  const pref = bundle.reviews.find((r) => r.target === `deck:${deck.key}`);
  const names=[...new Set([...deck.builds.flatMap((b)=>listEntries(b.list).map((r)=>r.name)),...combos.flatMap((c)=>c.cards??[])])];
  const accounting=buildAccounting(build);
  return <article className="research-build">
    <section className="research-build-head">
      <div>
        <h2>{build.label}</h2>
        {isOwnedBuild(build) && <p className="pill">Buildable now: allocated real cards and arrived prints</p>}
        {ownedBuildProblems(build).length > 0 && <p className="warn">Ownership not verified: {ownedBuildProblems(build).join(" ")}</p>}
        {build.prospective && <p className="warn">Proposed future build. Its stock cards become available only after the product is bought and arrives. Any unreleased-card legality limit remains in the guide.</p>}
        <p><CardText text={build.why??""} names={names}/></p>
        {build.option_swap && <p className="research-option"><b>Optional change from base Bracket 4:</b> add <CardName name={build.option_swap.card_in??build.option_swap.inn??"Unnamed"}/>; cut <CardName name={build.option_swap.card_out??build.option_swap.out??"Unnamed"}/>. The exact changes below compare with the current reference.</p>}
      </div>
      <div className="research-preference"><p className="small dim">This records your preferred proposal. It does not install cards or approve orders.</p><ReviewEditor key={`deck:${deck.key}:${pref?.version??0}`} bundle={bundle} target={`deck:${deck.key}`} buildId={build.id}/></div>
    </section>
    <AccountingSummary build={build}/>
    <div className="research-facts">
      <span>{build.bracket ? `Proposed bracket ${build.bracket}` : "Starting reference; discuss bracket at the table"}</span>
      <span>{build.game_changers?.length??0}{build.bracket===3?" / 3":""} Game Changers</span>
      {typeof build.stats?.lands === "number" && <span>{build.stats.lands} lands</span>}
      {typeof build.stats?.nonland_mean_mana_value === "number" && <span>Nonland average MV {build.stats.nonland_mean_mana_value.toFixed(2)}</span>}
    </div>
    {!!build.game_changers?.length && <section><h3>Game Changer package</h3><p className="small">{build.game_changers.map((n,i)=><span key={n}>{i>0&&", "}<CardName name={n}/></span>)}</p>{build.gc_choices?.map((g)=><div className="research-item" key={g.card}><p><b><CardName name={g.card}/></b>{g.cut&&<> replaces <CardName name={g.cut}/></>}</p><p><CardText text={g.reason} names={names}/></p></div>)}</section>}
    <Gameplay profile={build.gameplay_profile} legacy={build.power} names={names}/>
    {!!build.risks?.length && <details><summary>Build-specific limits</summary><ul>{build.risks.map((x,i)=><li key={i}><CardText text={x} names={names}/></li>)}</ul></details>}
    <AcquisitionGroups deck={deck} build={build}/>
    <section>
      <h3>Exact changes from the starting reference: {accounting.added} in, {accounting.removed} out</h3>
      <p className="small dim">Every addition has its exact cut. Want, Unsure and Don’t want save your opinion on this build; they do not apply swaps.</p>
      <div className="research-swaps">{build.swaps?.map((swap)=>{
        const target=targetForSwap(deck.key,build.id,swap.id);const answer=bundle.reviews.find((r)=>r.target===target);
        return <article className="research-swap" key={swap.id}>
          <div className="research-swap-cards"><p><span className="dim small">Add {swap.qty && swap.qty>1?`×${swap.qty}`:""}</span><br/><b><CardName name={swap.card_in}/></b></p><p><span className="dim small">Cut {swap.qty && swap.qty>1?`×${swap.qty}`:""}</span><br/><b>{swap.card_out?<CardName name={swap.card_out}/>:"No paired cut"}</b></p></div>
          <p><CardText text={swap.why??""} names={names}/></p>
          {swap.why_out&&<p className="small dim">Cut reason: <CardText text={swap.why_out} names={names}/></p>}
          {swap.pairing_note&&<p className="small dim">{swap.pairing_note}</p>}
          {swap.acquisition&&<AcquisitionItem item={swap.acquisition} showCard={false}/>}
          <ReviewEditor key={`${target}:${answer?.version??0}`} bundle={bundle} target={target}/>
        </article>;
      })}</div>
    </section>
    <section><h3>Combos and engines ({present.length} with pieces in this list)</h3><p className="small dim">Presence is not an automatic win. Read the setup, payoff and interruption points; some entries explain a claim that does not work.</p>{present.map((c)=><ComboCard key={c.id} combo={c}/>)}{!!missing.length&&<details><summary>Other lines and missing-piece cautions ({missing.length})</summary>{missing.map((c)=><ComboCard key={c.id} combo={c}/>)}</details>}</section>
    <section><h3>Complete {accounting.total}-card list</h3><div className="research-review-actions"><button type="button" className="outline" onClick={()=>{void navigator.clipboard.writeText(build.list).then(()=>setCopy("Copied")).catch(()=>setCopy("Could not copy; use Download or select the text."));}}>Copy list</button><button type="button" className="outline" onClick={download}>Download list</button><span className="small" role="status">{copy}</span></div><CompleteList build={build}/><details><summary>Plain text for another reviewer or simulator</summary><pre className="research-list">{build.list}</pre></details></section>
  </article>;
}

export function PrintedWishlist({ scenarios = [] }: { scenarios?: Scenario[] }) {
  return <>{scenarios.filter((s)=>s.purpose==="permanent_real_wishlist").map((wishlist)=><section key={wishlist.id} className="research-shopping" id="printed-real-wishlist">
    <h2>{wishlist.label}</h2><p>{wishlist.note}</p>
    <details><summary>{wishlist.buys?.length??0} card names to keep watching for real copies</summary>
      {wishlist.buys?.map((item,i)=><div className="research-item" key={`${item.card}-${i}`}>
        <p><b>{item.card&&<CardName name={item.card}/>}</b></p>
        {item.reason&&<p className="small">{item.reason}</p>}{item.detail&&<p className="small dim">{item.detail}</p>}
        <p className="small dim">Local price and stock: Unknown. Quantity to buy: undecided.</p>
        {safeUrl(item.url)&&<a className="small" href={safeUrl(item.url)} target="_blank" rel="noreferrer">Card reference</a>}
      </div>)}
    </details>
  </section>)}</>;
}

export function Shopping({ scenarios: allScenarios = [], defaultId }: { scenarios?: Scenario[]; defaultId?: string }) {
  const scenarios=allScenarios.filter((s)=>s.purpose!=="permanent_real_wishlist");
  const [selected,setSelected]=useState(defaultId??scenarios.find((s)=>s.id==="default")?.id??scenarios[0]?.id);
  const scenario=scenarios.find((s)=>s.id===selected)??scenarios[0];
  if(!scenario)return null;
  const singles=scenario.buys?.reduce((n,r)=>n+(r.qty??1),0)??0;
  return <section className="research-shopping">
    <h2>Across the decks: purchases and prints</h2>
    <label className="research-select">Configuration<select value={scenario.id} onChange={(e)=>setSelected(e.target.value)}>{scenarios.map((s)=><option value={s.id} key={s.id}>{s.label}</option>)}</select></label>
    <p>{scenario.note}</p>
    {!!scenario.sealed_purchases?.length&&<div className="research-sealed"><h3>Buy these precons first</h3><p className="small dim">These decks are planned purchases. Their cards are projected stock, not cards you own now. Sealed deck prices are separate from the $2 singles ceiling and singles total.</p>{scenario.sealed_purchases.map((r,i)=><AcquisitionItem key={i} item={r}/>)}</div>}
    <p className="research-shopping-total"><b>{singles} local singles; {money(scenario.buy_total)} before tax; {scenario.print_count??scenario.prints?.length??0} proposed prints</b></p>
    <p className="small dim">These configurations are alternatives; do not add their totals. Quotes and availability are dated. A missing offer is not proof of no shelf stock. Sealed purchases are excluded from this singles total.</p>
    <div className="research-acquisition-grid"><details open><summary>Local singles order list</summary>{scenario.buys?.map((r,i)=><AcquisitionItem key={i} item={r}/>)}</details><details><summary>Proposed print order</summary>{scenario.prints?.map((r,i)=><AcquisitionItem key={i} item={r}/>)}</details></div>
  </section>;
}

function DeckOverview({ bundle }: { bundle: ResearchBundle }) {
  const doc=bundle.document;
  return <>
    <div className="research-deck-grid">{doc.decks.map((deck)=>{
      const current=deck.builds.find((b)=>["current","stock"].includes(b.id));
      const recommended=deck.builds.find((b)=>b.id===deck.recommended_build);
      const preference=bundle.reviews.find((r)=>r.target===`deck:${deck.key}`);
      return <article className="research-deck-card" key={deck.key}>
        <h2><Link to={`/decks/research/${doc.id}/${deck.key}`}>{deck.name}</Link></h2>
        <p className="small dim"><CardName name={deck.commander}/></p>
        <DeckChanged name={deck.name} savedAt={bundle.updated_at} />
        <p className="small">{deck.ownership} — {deck.installed_state}</p>
        <div className="research-overview-profile"><b>{recommended?.label??"Suggested build"}</b><p className="small">{recommended?.gameplay_profile?.plan??recommended?.power?.rationale??deck.summary}</p>{recommended?.gameplay_profile?.pace&&<p className="small dim">{recommended.gameplay_profile.pace}</p>}</div>
        {current&&<p className="small dim">Starting reference: {buildAccounting(current).total} cards. Each proposed build is an independent full list.</p>}
        {preference?.decision&&<p className="small">Your preference: {deck.builds.find((b)=>b.id===preference.decision)?.label??preference.decision}{changedAnswer(bundle,preference)&&" (evidence changed)"}</p>}
        <Link to={`/decks/research/${doc.id}/${deck.key}`}>Review exact builds, guide and cards →</Link>
      </article>;
    })}</div>
    <PrintedWishlist scenarios={doc.scenarios}/>
    <Shopping scenarios={doc.scenarios} defaultId={doc.default_scenario_id}/>
  </>;
}

function ImportResearch() {
  const navigate = useNavigate();const qc = useQueryClient();
  const save = useMutation({ mutationFn: async (f: File) => { if (f.size > 4 << 20) throw new Error("Research files must be under 4 MiB."); return importReport(JSON.parse(await f.text())); }, onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["research"] }); navigate(`/decks/research/${r.id}`); } });
  return <details><summary>Import a note file</summary><p className="small dim">Store a yama-research/1 file in your private account. This imports advice, not decks or collection cards.</p><input type="file" accept="application/json,.json" disabled={save.isPending} onChange={(e) => { const f = e.target.files?.[0]; if (f) save.mutate(f); }} /><ErrorText error={save.error} /></details>;
}

export function ResearchPage() {
  const { reportId, deckKey } = useParams();
  const userId = useMe().data?.id;
  const listing = useQuery({ queryKey: ["research", userId, "list"], queryFn: reports, enabled: !reportId });
  const data = useQuery({ queryKey: ["research", userId, reportId], queryFn: () => report(reportId!), enabled: !!reportId });
  const [params, setParams] = useSearchParams();
  const b = data.data;const deck = b?.document.decks.find((d) => d.key === deckKey);
  const preferred = b?.reviews.find((r) => r.target === `deck:${deckKey}`)?.decision;
  const build = deck?.builds.find((x) => x.id === params.get("build")) ?? deck?.builds.find((x) => x.id === preferred) ?? deck?.builds.find((x) => x.id === deck.recommended_build) ?? deck?.builds[0];
  const retired = b?.reviews.filter((r) => !b.target_hashes[r.target]) ?? [];
  const guideNames=[...new Set(deck?.builds.flatMap((x)=>listEntries(x.list).map((r)=>r.name))??[])];
  return <LocalChecks.Provider value={b?.document.local_checks ?? {}}><main className="page research-page"><AreaHead title={deck?.name ?? b?.document.title ?? "Agent notes"} index={!reportId} back={deckKey ? { to: `/decks/research/${reportId}`, label: "Back to this note" } : { to: "/decks/research", label: "Back to agent notes" }} />
    {!reportId && <><AgentNotesAbout /><ErrorText error={listing.error} />{listing.isPending && <p>Loading…</p>}{listing.data?.map((r) => <p key={r.id}><Link to={`/decks/research/${r.id}`}>{r.title}</Link><span className="small dim"> — updated {r.updated_at.slice(0, 10)}, revision {r.revision}{r.visibility === "link" ? ", shared by link" : r.visibility === "public" ? ", public on your profile" : ""}</span></p>)}{listing.data?.length === 0 && <p>No agent notes saved yet.</p>}<ImportResearch /></>}
    {reportId && <><ErrorText error={data.error} />{data.isPending && <p>Loading the note…</p>}{b && <><AgentNotesAbout short /><p className="dim">{b.document.summary}</p><p className="small dim">Note saved {b.updated_at.slice(0, 10)}, revision {b.revision}. Estimates are advice, not game results. Bracket and power are separate.</p>{!deckKey ? <><ShareNote bundle={b} /><details><summary>How to read the estimates and acquisition evidence</summary><ul>{b.document.method?.map((m, i) => <li key={i}><CardText text={m} names={guideNames}/></li>)}</ul><p>Build strength is explained through setup, pressure, finishing lines, interaction, consistency, recovery and weaknesses. Official brackets run 1–5; cEDH is Bracket 5.</p></details><DeckOverview bundle={b} /></> : deck && build ? <><nav className="research-deck-picker" aria-label="Research decks">{b.document.decks.map((d) => <Link key={d.key} aria-current={d.key === deck.key ? "page" : undefined} to={`/decks/research/${reportId}/${d.key}`}>{d.name}</Link>)}</nav><DeckChanged name={deck.name} savedAt={b.updated_at} /><p><CardText text={deck.summary??""} names={guideNames}/></p>{!!deck.warnings?.length && <ul className="warn small">{deck.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}<details><summary>Upgrade guides, prior swaps and mechanics rechecked</summary>{deck.guide_comparison && <p><CardText text={deck.guide_comparison} names={guideNames}/></p>}<ul>{deck.mechanics?.map((m,i)=><li key={i}><CardText text={m} names={guideNames}/></li>)}</ul>{!!deck.existing_swap_audit?.length && <><h3>Existing upgrade judgments ({deck.existing_swap_audit.length})</h3>{deck.existing_swap_audit.map((r,i)=><div className="research-item" key={i}><p><b>{r.inn&&<CardName name={r.inn}/>}</b>{r.out&&<> for <CardName name={r.out}/></>} — {r.verdict}</p><p className="small"><CardText text={r.reason??""} names={guideNames}/></p></div>)}</>}{deck.combo_limits?.map((m,i)=><p className="small dim" key={i}>{m}</p>)}</details><p className="small dim"><CardName name={deck.commander}/>. {deck.ownership}. {deck.installed_state}.</p><nav className="research-build-tabs" aria-label="Build alternatives">{deck.builds.map((x) => <button type="button" key={x.id} aria-pressed={x.id === build.id} className={x.id === build.id ? "primary" : "outline"} onClick={() => setParams({ build: x.id })}>{x.label}</button>)}</nav><BuildView key={`${deck.key}:${build.id}`} bundle={b} deck={deck} build={build} />{deck.pilot && <section><h2>How to pilot this deck</h2><p><CardText text={deck.pilot} names={guideNames}/></p></section>}{deck.competitive_path&&<section><h2>Competitive path: Bracket 5</h2><p><b>{deck.competitive_path.status}</b></p><p><CardText text={deck.competitive_path.summary??""} names={guideNames}/></p>{deck.competitive_path.commander_change&&<p className="small">Commander/archetype changes: {deck.competitive_path.commander_change}</p>}<Sources sources={deck.competitive_path.sources}/><p className="small dim">This is a discussion of a sourced competitive direction, not an automatic claim that this identity build is tournament-tested. There is no official Bracket 6.</p></section>}<section><h2>Research sources</h2><Sources sources={deck.sources}/></section></> : <p>That deck is not in this note. <Link to={`/decks/research/${reportId}`}>Open the note.</Link></p>}{retired.length > 0 && <details><summary>Answers for retired research targets ({retired.length})</summary>{retired.map((r) => <p key={r.target}><b>{r.target}</b>: {r.decision ?? "No choice"}. {r.note}</p>)}</details>}</>}</>}
  </main></LocalChecks.Provider>;
}
