import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { ErrorText } from "../components/ui";
import { changedAnswer, importReport, money, report, reports, safeUrl, saveReview, targetForSwap, type Build, type Combo, type Item, type Power, type ResearchBundle, type ResearchDeck, type ReviewOp, type Scenario, type Source } from "./api";
import "./research.css";

const LocalChecks = createContext<NonNullable<ResearchBundle["document"]["local_checks"]>>({});
function CardName({ name }: { name: string }) { return <Link to={`/cards?q=${encodeURIComponent(`!\"${name}\"`)}`} target="_blank">{name}</Link>; }

function Sources({ sources = [] }: { sources?: Source[] }) {
  return <ul className="research-sources">{sources.map((s, i) => <li key={`${s.url}-${i}`}>{safeUrl(s.url) ? <a href={safeUrl(s.url)} target="_blank" rel="noreferrer">{s.title}</a> : s.title}{s.accessed && <span className="dim small"> — checked {s.accessed}</span>}</li>)}</ul>;
}

export function PowerSummary({ power }: { power?: Power }) {
  if (!power?.range && !power?.label) return <p className="dim">Power not assessed.</p>;
  return <div className="research-power"><p><strong className="num">{power.range}</strong> {power.label}</p>{power.confidence && <p className="small dim">Confidence: {power.confidence}</p>}{power.rationale && <p>{power.rationale}</p>}{power.speed && <p className="small">{power.speed}</p>}{!!power.vulnerabilities?.length && <p className="small dim">Weaknesses: {power.vulnerabilities.join("; ")}</p>}</div>;
}

const KINDS: Record<string, string> = { owned: "Owned copy", transfer: "Move from another deck", arrived_print: "Print already here", future_stock: "Stock only after arrival", buy: "Local buy", print: "New print", basic: "Basic land", unknown: "Check source" };
export function AcquisitionItem({ item, showCard = true }: { item: Item; showCard?: boolean }) {
  const quote = item.quote ?? item;
  const check = useContext(LocalChecks)[item.local_check ?? item.card ?? ""];
  return <div className="research-item">
    {showCard && <p><b>{item.qty && item.qty > 1 ? `${item.qty} × ` : ""}{item.card && <CardName name={item.card} />}</b>{item.deck && <span className="dim"> — {item.deck}</span>}</p>}
    {item.kind && <span className={`research-tag kind-${item.kind}`}>{KINDS[item.kind] ?? item.kind}</span>}
    {item.detail && <p className="small">{item.detail}</p>}{item.reason && <p className="small dim">{item.reason}</p>}
    {(quote.store || item.kind === "buy") && <p className="small"><b>{quote.store || "Store unverified"}: {money(quote.price)}</b> before tax{quote.printing && `, ${quote.printing}`}{quote.condition && `, ${quote.condition}`}<br />Matched market: {money(quote.market)}{quote.checked && `; checked ${quote.checked}`}{safeUrl(quote.url) && <>. <a href={safeUrl(quote.url)} target="_blank" rel="noreferrer">Store listing</a></>}</p>}
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
    <p className="small">{combo.cards?.join(" + ")}</p>{!!combo.missing_cards?.length && <p className="warn small">Missing: {combo.missing_cards.join(", ")}</p>}
    {!!combo.setup?.length && <><h4>Setup</h4><ul>{combo.setup.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
    {!!combo.steps?.length && <><h4>Sequence</h4><ol>{combo.steps.map((x, i) => <li key={i}>{x}</li>)}</ol></>}
    {combo.outcome && <p><b>Outcome:</b> {combo.outcome}</p>}{!!combo.stop_points?.length && <><h4>Where it stops</h4><ul>{combo.stop_points.map((x, i) => <li key={i}>{x}</li>)}</ul></>}{combo.bracket_fit && <p className="small">{combo.bracket_fit}</p>}<Sources sources={combo.sources} />
  </details>;
}

function BuildView({ bundle, deck, build }: { bundle: ResearchBundle; deck: ResearchDeck; build: Build }) {
  const [copy, setCopy] = useState("");
  const download = () => { const url = URL.createObjectURL(new Blob([build.list], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = `${deck.key}-${build.id}.txt`; a.click(); URL.revokeObjectURL(url); };
  const combos = build.combos ?? [];
  const present = combos.filter((c) => c.present !== false);
  const missing = combos.filter((c) => c.present === false);
  const acq = build.acquisition;
  const pref = bundle.reviews.find((r) => r.target === `deck:${deck.key}`);
  return <article className="research-build">
    <section className="research-build-head"><div><h2>{build.label}</h2>{build.prospective && <p className="warn">Prospective build. Future stock is not in your collection today; unreleased cards may not yet be legal.</p>}<p>{build.why}</p>{build.option_swap && <p className="research-option"><b>Optional change from base Bracket 4:</b> add {build.option_swap.card_in ?? build.option_swap.inn}; cut {build.option_swap.card_out ?? build.option_swap.out}. The exact changes below compare with the current reference.</p>}<PowerSummary power={build.power} /></div>
      <div className="research-preference"><p className="small dim">This records a research preference. It does not change the sleeved deck or approve orders.</p><ReviewEditor key={`deck:${deck.key}:${pref?.version ?? 0}`} bundle={bundle} target={`deck:${deck.key}`} buildId={build.id} /></div></section>
    <div className="research-facts"><span>{build.bracket ? `Proposed bracket ${build.bracket}` : "Bracket needs table discussion"}</span><span>{build.game_changers?.length ?? 0} Game Changers</span>{typeof build.stats?.lands === "number" && <span>{build.stats.lands} lands</span>}{typeof build.stats?.nonland_mean_mana_value === "number" && <span>Nonland average MV {build.stats.nonland_mean_mana_value.toFixed(2)}</span>}</div>
    {!!build.game_changers?.length && <p className="small">Game Changers: {build.game_changers.join(", ")}</p>}{!!build.risks?.length && <ul className="small dim">{build.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>}
    <section><h3>Cards to reuse, buy or print</h3><p className="small dim">{acq?.note || `Allocation for ${acq?.scenario || "this configuration"}.`} A transfer depends on its donor deck releasing that copy. Bracket alternatives are separate lists.</p>
      <div className="research-acquisition-grid"><details><summary>{build.prospective ? "Stock after arrival and assigned copies" : "Reuse owned cards"} ({acq?.owned?.reduce((s, x) => s + (x.qty ?? 1), 0) ?? 0})</summary>{acq?.owned?.map((item, i) => <AcquisitionItem key={i} item={item} />)}</details><details open={!!acq?.buys?.length}><summary>Verified local buys ({acq?.buys?.length ?? 0})</summary>{acq?.buys?.length ? acq.buys.map((item, i) => <AcquisitionItem key={i} item={item} />) : <p className="small dim">No additional qualifying buy allocated in this scenario.</p>}</details><details open><summary>Additional prints ({acq?.prints?.reduce((s, x) => s + (x.qty ?? 1), 0) ?? 0})</summary>{acq?.prints?.length ? acq.prints.map((item, i) => <AcquisitionItem key={i} item={item} />) : <p className="small dim">No additional print allocated.</p>}</details></div>
    </section>
    <section><h3>Exact changes from the current reference ({build.swaps?.length ?? 0})</h3><p className="small dim">Want, Unsure and Don’t want save your opinion on this alternative. They do not apply swaps.</p><div className="research-swaps">{build.swaps?.map((swap) => { const target = targetForSwap(deck.key, build.id, swap.id); const answer = bundle.reviews.find((r) => r.target === target); return <article className="research-swap" key={swap.id}><div className="research-swap-cards"><p><span className="dim small">Add</span><br /><b>{swap.card_in}</b></p><p><span className="dim small">Cut</span><br /><b>{swap.card_out || "No paired cut"}</b></p></div><p>{swap.why}</p>{swap.why_out && <p className="small dim">Cut reason: {swap.why_out}</p>}{swap.pairing_note && <p className="small dim">{swap.pairing_note}</p>}{swap.acquisition && <AcquisitionItem item={swap.acquisition} showCard={false} />}<ReviewEditor key={`${target}:${answer?.version ?? 0}`} bundle={bundle} target={target} /></article>; })}</div></section>
    <section><h3>Combos and engines ({present.length} with pieces in this list)</h3><p className="small dim">Card presence does not make an engine an automatic win. Read setup, payoff and interruption points; some entries explain a claim that does not work.</p>{present.map((c) => <ComboCard key={c.id} combo={c} />)}{!!missing.length && <details><summary>Other lines and missing-piece cautions ({missing.length})</summary>{missing.map((c) => <ComboCard key={c.id} combo={c} />)}</details>}</section>
    <section><h3>Exact full list</h3><div className="research-review-actions"><button type="button" className="outline" onClick={() => { void navigator.clipboard.writeText(build.list).then(() => setCopy("Copied")).catch(() => setCopy("Could not copy; use Download or select the text.")); }}>Copy list</button><button type="button" className="outline" onClick={download}>Download list</button><span className="small" role="status">{copy}</span></div><details><summary>Show all cards</summary><pre className="research-list">{build.list}</pre></details></section>
  </article>;
}

function Shopping({ scenarios = [] }: { scenarios?: Scenario[] }) {
  const [selected, setSelected] = useState(scenarios.find((s) => s.id === "default")?.id ?? scenarios[0]?.id);
  const s = scenarios.find((x) => x.id === selected) ?? scenarios[0];
  if (!s) return null;
  return <section className="research-shopping"><h2>Across the decks: local buys and prints</h2><label className="research-select">Configuration<select value={s.id} onChange={(e) => setSelected(e.target.value)}>{scenarios.map((x) => <option value={x.id} key={x.id}>{x.label}</option>)}</select></label><p>{s.note}</p><p className="research-shopping-total"><b>{s.buys?.length ?? 0} local buys; {money(s.buy_total)} before tax; {s.print_count ?? s.prints?.length ?? 0} proposed prints</b></p><p className="small dim">These configurations are alternatives. Do not add their totals together. Store quotes and availability are dated; a missing offer is not proof of no shelf stock.</p><div className="research-acquisition-grid"><details open><summary>Local order list</summary>{s.buys?.map((x, i) => <AcquisitionItem key={i} item={x} />)}</details><details><summary>Proposed print order</summary>{s.prints?.map((x, i) => <AcquisitionItem key={i} item={x} />)}</details></div></section>;
}

function DeckOverview({ bundle }: { bundle: ResearchBundle }) {
  const d = bundle.document;
  return <><div className="research-deck-grid">{d.decks.map((deck) => { const current = deck.builds.find((b) => ["current", "stock"].includes(b.id)); const recommended = deck.builds.find((b) => b.id === deck.recommended_build); const preferred = bundle.reviews.find((r) => r.target === `deck:${deck.key}`); return <Link className="research-deck-card" to={`/decks/research/${d.id}/${deck.key}`} key={deck.key}><h2>{deck.name}</h2><p className="small dim">{deck.commander}</p><p className="small">{deck.ownership} — {deck.installed_state}</p><div className="research-power-pair"><div><span className="small dim">{current?.label ?? "Current"}</span><p><b className="num">{current?.power?.range || "Unassessed"}</b></p></div><div><span className="small dim">Suggested {recommended?.label}</span><p><b className="num">{recommended?.power?.range || "Unassessed"}</b></p></div></div>{preferred?.decision && <p className="small">Your preference: {deck.builds.find((b) => b.id === preferred.decision)?.label ?? preferred.decision}{changedAnswer(bundle, preferred) && " (evidence changed)"}</p>}<p className="small">Review builds, combos and acquisitions →</p></Link>; })}</div><Shopping scenarios={d.scenarios} /></>;
}

function ImportResearch() {
  const navigate = useNavigate();const qc = useQueryClient();
  const save = useMutation({ mutationFn: async (f: File) => { if (f.size > 4 << 20) throw new Error("Research files must be under 4 MiB."); return importReport(JSON.parse(await f.text())); }, onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["research"] }); navigate(`/decks/research/${r.id}`); } });
  return <details><summary>Import research</summary><p className="small dim">Store a yama-research/1 report in your private account. This imports advice, not decks or collection cards.</p><input type="file" accept="application/json,.json" disabled={save.isPending} onChange={(e) => { const f = e.target.files?.[0]; if (f) save.mutate(f); }} /><ErrorText error={save.error} /></details>;
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
  return <LocalChecks.Provider value={b?.document.local_checks ?? {}}><main className="page research-page"><AreaHead title={deck?.name ?? b?.document.title ?? "Deck research"} index={!deckKey} back={deckKey ? { to: `/decks/research/${reportId}`, label: "Research overview" } : undefined} />
    {!reportId && <><p className="dim">Review power estimates, complete bracket builds, combos, local buys and prints. Your preferences and notes stay in Yama.</p><ErrorText error={listing.error} />{listing.isPending && <p>Loading…</p>}{listing.data?.map((r) => <p key={r.id}><Link to={`/decks/research/${r.id}`}>{r.title}</Link><span className="small dim"> — updated {r.updated_at.slice(0, 10)}, revision {r.revision}</span></p>)}{listing.data?.length === 0 && <p>No research saved yet.</p>}<ImportResearch /></>}
    {reportId && <><ErrorText error={data.error} />{data.isPending && <p>Loading research…</p>}{b && <><p className="dim">{b.document.summary}</p><p className="small dim">Research updated {b.updated_at.slice(0, 10)}, revision {b.revision}. Estimates are advice, not game results. Bracket and power are separate.</p>{!deckKey ? <><details><summary>How to read the estimates and acquisition evidence</summary><ul>{b.document.method?.map((m, i) => <li key={i}>{m}</li>)}</ul>{b.document.power_scale?.map((p) => <p key={p.range}><b>{p.range}:</b> {p.meaning}</p>)}</details><DeckOverview bundle={b} /></> : deck && build ? <><nav className="research-deck-picker" aria-label="Research decks">{b.document.decks.map((d) => <Link key={d.key} aria-current={d.key === deck.key ? "page" : undefined} to={`/decks/research/${reportId}/${d.key}`}>{d.name}</Link>)}</nav><p>{deck.summary}</p>{!!deck.warnings?.length && <ul className="warn small">{deck.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}<details><summary>Upgrade guides, prior swaps and mechanics rechecked</summary>{deck.guide_comparison && <p>{deck.guide_comparison}</p>}<ul>{deck.mechanics?.map((m,i)=><li key={i}>{m}</li>)}</ul>{!!deck.existing_swap_audit?.length && <><h3>Existing upgrade judgments ({deck.existing_swap_audit.length})</h3>{deck.existing_swap_audit.map((r,i)=><div className="research-item" key={i}><p><b>{r.inn}</b>{r.out && ` for ${r.out}`} — {r.verdict}</p><p className="small">{r.reason}</p></div>)}</>}{deck.combo_limits?.map((m,i)=><p className="small dim" key={i}>{m}</p>)}</details><p className="small dim">{deck.commander}. {deck.ownership}. {deck.installed_state}.</p><nav className="research-build-tabs" aria-label="Build alternatives">{deck.builds.map((x) => <button type="button" key={x.id} aria-pressed={x.id === build.id} className={x.id === build.id ? "primary" : "outline"} onClick={() => setParams({ build: x.id })}>{x.label}</button>)}</nav><BuildView key={`${deck.key}:${build.id}`} bundle={b} deck={deck} build={build} />{deck.pilot && <section><h2>How to pilot this deck</h2><p>{deck.pilot}</p></section>}<section><h2>Research sources</h2><Sources sources={deck.sources} /></section></> : <p>That deck is not in this research report. <Link to={`/decks/research/${reportId}`}>Open the overview.</Link></p>}{retired.length > 0 && <details><summary>Answers for retired research targets ({retired.length})</summary>{retired.map((r) => <p key={r.target}><b>{r.target}</b>: {r.decision ?? "No choice"}. {r.note}</p>)}</details>}</>}</>}
  </main></LocalChecks.Provider>;
}
