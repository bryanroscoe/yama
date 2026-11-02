import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, type DeckSummary, type DeckView } from "../api";
import { CardRef } from "../components/CardRef";
import { AreaHead } from "../components/DeckTabs";
import { ErrorText } from "../components/ui";
import { useMe } from "../auth";
import { usePlan } from "../plan/store";
import { report, reports } from "../research/api";
import { buildFamilies, buildTargets, resolveBuildFamily, duplexPages, exactChanges, printList, slotsText, type BuildChoice, type BuildFamily, type DuplexFace } from "./buildCatalog";
import "./build-choices.css";

export function BuildChoicesPage() {
  const [params, setParams] = useSearchParams();
  const userId = useMe().data?.id;
  const index = useQuery({ queryKey: ["research", userId, "list"], queryFn: reports, enabled: !!userId });
  const notes = useQueries({ queries: (index.data ?? []).map((r) => ({ queryKey: ["research", userId, r.id], queryFn: () => report(r.id), enabled: !!userId })) });
  const plan = usePlan(userId);
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const bundles = notes.flatMap((r) => r.data ? [r.data] : []);
  const families = buildFamilies(bundles, plan.bundle, decks.data ?? []);
  const key = params.get("deck");
  const savedDeck = params.get("savedDeck");
  const planKey = params.get("planKey");
  const family = resolveBuildFamily(families, key, savedDeck, planKey);
  const loading = index.isPending || plan.pending || decks.isPending || notes.some((r) => r.isPending);
  return <main className="page build-choices">
    <div className="bc-controls">
      <AreaHead title="Bracket builds and swap cards" back={{ to: "/decks", label: "Decks" }} />
      <p>Choose two lists to print a double-sided swap card.</p>
      <ErrorText error={index.error || plan.error || decks.error || notes.find((r) => r.error)?.error} />
      {plan.offline && <p role="status">No connection. Showing the plan copy saved on this device.</p>}
      {loading ? <p>Loading your saved builds…</p> : <label>Deck <select value={family?.key ?? ""} onChange={(e) => setParams({ deck: e.target.value })}>
        {!family && <option value="">Choose a deck</option>}{families.map((f) => <option key={f.key} value={f.key}>{f.name}{families.filter((other) => other.name === f.name).length > 1 ? ` — ${f.detail}` : ""}</option>)}
      </select></label>}
      {!loading && !families.length && <p>No saved decks or researched bracket builds yet.</p>}
      {!loading && (key || savedDeck || planKey) && !family && <p>That deck has no build choices. Select another deck above.</p>}
    </div>
    {!loading && family && <FamilyChoices key={family.key} family={family} />}
  </main>;
}

const groups = ["current", "original", "bracket", "legacy"] as const;
function Choices({ choices }: { choices: BuildChoice[] }) {
  return <>{groups.map((kind) => {
    const cs = choices.filter((c) => c.kind === kind).sort((a, b) => (a.bracket ?? 0) - (b.bracket ?? 0));
    return cs.length > 0 && <optgroup key={kind} label={kind === "bracket" ? "Bracket builds" : kind === "legacy" ? "Legacy snapshots" : kind === "original" ? "Original references" : "Current saved deck"}>{cs.map((c) => <option key={c.id} value={c.id}>{c.label} — {sourceAfterLabel(c)}</option>)}</optgroup>;
  })}</>;
}
/** The source without the label it repeats: "[2] Buildable now — decks from cards already at home",
 *  not "…Buildable now — Buildable now: decks…", which a phone's select cut off before the date. */
function sourceAfterLabel(c: BuildChoice) {
  const name = c.label.replace(/^\[\d\]\s*/, "");
  return c.source.startsWith(`${name}: `) ? c.source.slice(name.length + 2) : c.source;
}
function useChoiceList(choice?: BuildChoice) {
  const saved = useQuery({ queryKey: ["deck", choice?.savedDeck], queryFn: () => api<DeckView>(`/api/decks/${encodeURIComponent(choice!.savedDeck!)}`), enabled: !!choice?.savedDeck });
  // Never use a historical research baseline as today's sleeved deck.
  const text = choice?.list ?? (saved.data ? slotsText(saved.data.cards.flatMap((c) => c.board === "main" || c.board === "commander" ? [{ name: c.name, qty: c.qty, board: c.board }] : [])) : undefined);
  return { text, error: saved.error, version: saved.data?.version_id };
}
function preferred(choices: BuildChoice[], bracket: number) {
  return choices.find((c) => c.bracket === bracket && /lower.friction/i.test(c.label)) ?? choices.find((c) => c.bracket === bracket);
}
function FamilyChoices({ family }: { family: BuildFamily }) {
  const [params, setParams] = useSearchParams();
  const track = params.get("track") === "aspirational" ? "aspirational" : params.get("track") === "saved" ? "saved" : "owned_now";
  const targets = buildTargets(family.choices, track);
  const references = family.choices.filter((c) => c.kind !== "bracket");
  const available = family.choices;
  const from = available.find((c) => c.id === params.get("from")) ?? preferred(targets, 2) ?? references.find((c) => c.kind === "current") ?? available[0];
  const to = targets.find((c) => c.id === params.get("to")) ?? preferred(targets, 3) ?? preferred(targets, 2) ?? targets[0];
  const left = useChoiceList(from), right = useChoiceList(to);
  const comparison = useMemo(() => {
    if (!left.text || !right.text) return {};
    try { return { swaps: exactChanges(printList(left.text), printList(right.text)) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [left.text, right.text]);
  const [rows, setRows] = useState(6);
  const pages = useMemo(() => comparison.swaps ? duplexPages(comparison.swaps, rows) : [], [comparison.swaps, rows]);
  const sheet = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const choose = (side: "from" | "to", value: string) => setParams({ deck: family.key, track, from: from?.id ?? "", to: to?.id ?? "", [side]: value });
  useEffect(() => {
    const style = document.createElement("style"); style.textContent = "@page { size: letter; margin: 0.25in 0.5in; }"; document.head.appendChild(style);
    return () => style.remove();
  }, []);
  useLayoutEffect(() => {
    const root = sheet.current; if (!root) return;
    const check = () => setOverflow([...root.querySelectorAll<HTMLElement>(".bc-card")].some((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1));
    check(); const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check); observer?.observe(root);
    let live = true;
    void document.fonts.ready.then(() => { if (live) { check(); setFontsReady(true); } });
    document.fonts.addEventListener("loadingdone", check);
    return () => { live = false; observer?.disconnect(); document.fonts.removeEventListener("loadingdone", check); };
  }, [pages, from, to]);
  const trackControls = <div className="row bc-toggles" aria-label="Cards used by these builds">
    <button className={track === "owned_now" ? "primary" : "outline"} onClick={() => setParams({ deck: family.key, track: "owned_now", from: from?.id ?? "" })}>Buildable now</button>
    <button className={track === "aspirational" ? "primary" : "outline"} onClick={() => setParams({ deck: family.key, track: "aspirational", from: from?.id ?? "" })}>Aspirational</button>
    <button className={track === "saved" ? "primary" : "outline"} onClick={() => setParams({ deck: family.key, track: "saved", from: from?.id ?? "" })}>Other saved versions</button>
  </div>;
  if (!from || !to) return <div className="bc-controls stack">{trackControls}<p>{track === "owned_now" ? "No verified owned-card build is saved for this deck yet. Future purchases and prints do not count as available copies." : track === "aspirational" ? "No aspirational bracket build is saved for this deck yet." : "No other saved versions are available for this deck yet."}</p></div>;
  const parts = Math.max(1, Math.ceil((comparison.swaps?.length ?? 0) / rows));
  return <>
    <div className="bc-controls stack">
      {trackControls}
      <p>{track === "owned_now" ? "Buildable-now targets use real cards and arrived prints already at home. Cross-deck moves follow the saved allocation scenario; install donor replacements before taking their cards." : track === "aspirational" ? "Upgrade targets may require buying cards, receiving precons or ordering more prints. Review the source for exact missing copies and dated offers." : "These saved lists, plans and historical references have no current portfolio availability audit. Comparing or printing them does not establish that their cards are available."}</p>
      <div className="row bc-toggles">{[2, 3, 4].map((b) => {
        const c = preferred(targets, b); return c ? <button key={b} className={to.bracket === b ? "primary" : "outline"} onClick={() => choose("to", c.id)}>[{b}] Bracket {b}</button> : <span key={b}>[{b}] No build saved yet</span>;
      })}</div>
      <div className="bc-selects">
        <label>From<select value={from.id} onChange={(e) => choose("from", e.target.value)}><Choices choices={available} /></select></label>
        <label>To<select value={to.id} onChange={(e) => choose("to", e.target.value)}><Choices choices={targets} /></select></label>
      </div>
      <div className="bc-selects">{[from, to].map((c, i) => <section key={i}><h2>{c.label}</h2><p className="small">{c.source}</p><Link to={c.href}>Review full list, guide and source</Link>{c.warnings.length > 0 && <details><summary>Build notes and limits ({c.warnings.length})</summary><ul>{c.warnings.map((w, j) => <li key={j}>{w}</li>)}</ul></details>}</section>)}</div>
      {family.choices.some((c) => c.kind === "bracket" && c.track === "unverified") && <details><summary>Other saved plans (availability not audited)</summary><ul>{family.choices.filter((c) => c.kind === "bracket" && c.track === "unverified").map((c) => <li key={c.id}><Link to={c.href}>{c.label}</Link></li>)}</ul></details>}
      <p className="small">Saved bracket assessments; legality hasn't been rechecked. Printing doesn't mark swaps installed.</p>
      <ErrorText error={left.error || right.error} />
      {comparison.error && <p role="alert" className="error">{comparison.error}</p>}
      {!left.text || !right.text ? <p>Loading complete lists…</p> : comparison.swaps && <>
        <p><b>100 → 100 cards. {comparison.swaps.length} out, {comparison.swaps.length} in.</b> {parts} two-sided insert{parts === 1 ? "" : "s"}.</p>
        <p>Print on US Letter, double-sided, <b>flip on long edge</b>, actual size (100%), headers and footers off. Cut on the lines. Each insert is 2.5 × 3.5 inches; the back reverses the same swaps. Test one sheet for your printer’s alignment first.</p>
        <div className="row bc-print"><label>Swaps per insert <select value={rows} onChange={(e) => setRows(Number(e.target.value))}>{[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><button className="primary" disabled={overflow || !fontsReady} onClick={() => window.print()}>Print double-sided swap cards</button></div>
        {overflow && <p className="error" role="alert">Some text does not fit. Choose fewer swaps per insert before printing.</p>}
        <details><summary>Read the complete swap checklist</summary><ol>{comparison.swaps.map((s, i) => <li key={i}>Out: <CardRef name={s.out.name} />{s.out.board === "commander" && " (commander)"}. In: <CardRef name={s.in.name} />{s.in.board === "commander" && " (commander)"}.</li>)}</ol>{!comparison.swaps.length && <p>No card changes between these lists.</p>}</details>
      </>}
    </div>
    {pages.length > 0 && <div ref={sheet} className={`bc-sheet${overflow ? " bc-overflow" : ""}`}>
      {pages.map((page, i) => <div className="bc-paper" key={i} aria-label={`Sheet ${Math.floor(i / 2) + 1}, ${i % 2 ? "back" : "front"}`}>{page.map((face, j) => face ? <SwapFace key={j} face={face} name={family.name} from={from} to={to} parts={parts} versions={[left.version, right.version]} /> : <div className="bc-blank" key={j} />)}</div>)}
    </div>}
  </>;
}
export function SwapFace({ face, name, from, to, parts, versions }: { face: DuplexFace; name: string; from: BuildChoice; to: BuildChoice; parts: number; versions: (string | null | undefined)[] }) {
  const a = face.reverse ? to : from, b = face.reverse ? from : to;
  return <article className="bc-card">
    <h2>{name}</h2><p className="bc-direction">{a.label} → {b.label}</p><p className="bc-part">{face.reverse ? "Back" : "Front"}, part {face.part} of {parts}</p>
    <table><thead><tr><th>Out</th><th>In</th></tr></thead><tbody>{face.swaps.map((s, i) => <tr key={i}><td><CardRef name={s.out.name} />{s.out.board === "commander" && <small>Commander</small>}</td><td><CardRef name={s.in.name} />{s.in.board === "commander" && <small>Commander</small>}</td></tr>)}</tbody></table>
    {!face.swaps.length && <p>No card changes.</p>}
    <footer>{from.source}{to.source !== from.source && <><br />{to.source}</>}{versions.some(Boolean) && <><br />Saved list: {versions.filter(Boolean).map((v) => v!.slice(0, 8)).join(" / ")}</>}<br />{parts > 1 && `Complete all ${parts} parts. `}Reverse side undoes these swaps.</footer>
  </article>;
}
