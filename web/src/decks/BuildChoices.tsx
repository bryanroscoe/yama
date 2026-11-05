import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, type DeckSummary, type DeckView } from "../api";
import { CardRef } from "../components/CardRef";
import { AreaHead } from "../components/DeckTabs";
import { ErrorText } from "../components/ui";
import { useMe } from "../auth";
import { usePlan } from "../plan/store";
import { buildNotes, buildNotesKey } from "../research/api";
import { buildFamilies, buildTargets, resolveBuildFamily, duplexPages, exactChanges, pairChanges, printList, slotsText, type BuildChoice, type BuildFamily, type DuplexFace } from "./buildCatalog";
import { ChangesTable, Choices as Choices2, SectionHead } from "../research/parts";
import type { ChangeRow } from "../research/view";
import "../research/research.css";
import "./build-choices.css";

export function BuildChoicesPage() {
  const [params, setParams] = useSearchParams();
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const plan = usePlan(userId);
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const families = buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []);
  const key = params.get("deck");
  const savedDeck = params.get("savedDeck");
  const planKey = params.get("planKey");
  const family = resolveBuildFamily(families, key, savedDeck, planKey);
  const loading = notes.isPending || plan.pending || decks.isPending;
  return <main className="page build-choices">
    <div className="bc-controls">
      <AreaHead title="Swap cards" index back={{ to: "/decks", label: "Decks" }} />
      <p className="bc-intro">Pick a deck and two of its lists, such as the deck as it is and a plan's Bracket 3 build. Yama shows each card that changes and prints the changes as double-sided cards for the deck box: one side takes the deck there, the other brings it back.</p>
      <ErrorText error={notes.error || plan.error || decks.error} />
      {plan.offline && <p role="status">No connection. Showing the plan copy saved on this device.</p>}
      {loading ? <p>Loading your saved builds…</p> : <label>Deck <select value={family?.key ?? ""} onChange={(e) => setParams({ deck: e.target.value })}>
        {!family && <option value="">Choose a deck</option>}{families.map((f) => <option key={f.key} value={f.key}>{f.name}{families.filter((other) => other.name === f.name).length > 1 ? ` — ${f.detail}` : ""}</option>)}
      </select></label>}
      {!loading && !families.length && <p>No saved decks or plan builds yet.</p>}
      {!loading && (key || savedDeck || planKey) && !family && <p>That deck has no build choices. Select another deck above.</p>}
    </div>
    {!loading && family && <FamilyChoices key={family.key} family={family} />}
  </main>;
}

const groups = ["current", "original", "bracket", "legacy"] as const;
/** The lists to pick from, by kind. An option says the build first (a phone's select cuts off
 *  the rest); where two have the same name, which plan each is from follows. */
function Choices({ choices }: { choices: BuildChoice[] }) {
  return <>{groups.map((kind) => {
    const cs = choices.filter((c) => c.kind === kind).sort((a, b) => (a.bracket ?? 0) - (b.bracket ?? 0));
    return cs.length > 0 && <optgroup key={kind} label={kind === "bracket" ? "Bracket builds" : kind === "legacy" ? "Older snapshots" : kind === "original" ? "Stock" : "The deck as it is"}>{cs.map((c) => <option key={c.id} value={c.id}>{c.label}{choices.filter((o) => o.label === c.label).length > 1 ? ` (${c.note ?? c.source})` : ""}</option>)}</optgroup>;
  })}</>;
}
const TRACKS: { id: "owned_now" | "aspirational" | "saved"; label: string; about: string }[] = [
  { id: "owned_now", label: "With cards you have", about: "Builds your agent checked against the cards you have: real copies and prints that have arrived. A card moving from another deck waits until that deck has its replacement." },
  { id: "aspirational", label: "Upgrades", about: "Builds that need cards bought or printed, or a precon that hasn't arrived. Each plan says which." },
  { id: "saved", label: "Saved lists", about: "Your deck's saved lists and tracked plans. Yama hasn't checked that you have their cards." },
];
/** Where a list lives: its plan, or the saved deck. */
const openLabel = (c: BuildChoice) => (c.savedDeck ? "Open the deck" : c.id.startsWith("research:") ? "Open it in its plan" : "Open the tracked plan");
function useChoiceList(choice?: BuildChoice) {
  const saved = useQuery({ queryKey: ["deck", choice?.savedDeck], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${encodeURIComponent(choice!.savedDeck!)}`, { signal }), enabled: !!choice?.savedDeck });
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
    try { return { swaps: pairChanges(exactChanges(printList(left.text), printList(right.text)), from?.pairs, to?.pairs) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [left.text, right.text, from?.pairs, to?.pairs]);
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
  const about = TRACKS.find((t) => t.id === track)!.about;
  const trackControls = <>
    <Choices2 label="Which builds" options={TRACKS} value={track} onChange={(t) => setParams({ deck: family.key, track: t, from: from?.id ?? "" })} />
    <p className="small dim bc-about">{about}</p>
  </>;
  if (!from || !to) return <div className="bc-controls stack">{trackControls}<p>{track === "owned_now" ? "No build for this deck has been checked against the cards you have yet. Cards still to buy, print or receive don't count." : track === "aspirational" ? "No upgrade build is saved for this deck yet." : "This deck has no other saved lists yet."}</p></div>;
  const parts = Math.max(1, Math.ceil((comparison.swaps?.length ?? 0) / rows));
  const rowsOf = (comparison.swaps ?? []).map((s): ChangeRow => ({ add: s.in.name, cut: s.out.name, n: 1, why: s.why ?? "", notes: [s.where, s.out.board === "commander" || s.in.board === "commander" ? "Changes the commander." : null].filter((x): x is string => !!x), add_image: null, cut_image: null }));
  return <>
    <div className="bc-controls stack">
      {trackControls}
      <Choices2 label="Bracket to print for" title="To" options={[2, 3, 4].map((b) => ({ id: String(b), label: preferred(targets, b) ? `Bracket ${b}` : `Bracket ${b}: none saved`, disabled: !preferred(targets, b) }))} value={String(to.bracket ?? "")} onChange={(b) => { const c = preferred(targets, Number(b)); if (c) choose("to", c.id); }} />
      <div className="bc-selects">
        <label>From<select value={from.id} onChange={(e) => choose("from", e.target.value)}><Choices choices={available} /></select></label>
        <label>To<select value={to.id} onChange={(e) => choose("to", e.target.value)}><Choices choices={targets} /></select></label>
      </div>
      <div className="bc-selects bc-sources">{[from, to].map((c, i) => <section key={i} className="bc-source"><h3>{c.label}</h3><p className="small dim">{c.source}</p><Link className="small" to={c.href}>{openLabel(c)}</Link>{c.warnings.length > 0 && <details><summary className="small">Notes and limits ({c.warnings.length})</summary><ul className="small">{c.warnings.map((w, j) => <li key={j}>{w}</li>)}</ul></details>}</section>)}</div>
      <ErrorText error={left.error || right.error} />
      {comparison.error && <p role="alert" className="error">{comparison.error}</p>}
      {!left.text || !right.text ? <p>Loading complete lists…</p> : comparison.swaps && <>
        <SectionHead id="bc-changes" eyebrow={`${comparison.swaps.length} out, ${comparison.swaps.length} in`}>The changes</SectionHead>
        {comparison.swaps.length ? <ChangesTable rows={rowsOf} /> : <p className="dim">No card changes between these lists.</p>}
        <p className="small dim">Bracket labels are the plans' own assessments; legality isn't rechecked here. Printing doesn't mark any swap as done.</p>
        <SectionHead id="bc-print" eyebrow={`${parts} two-sided card${parts === 1 ? "" : "s"}`}>Print</SectionHead>
        <p className="small">Print on US Letter, double-sided, <b>flip on long edge</b>, actual size (100%), headers and footers off. Cut on the lines. Each card is 2.5 × 3.5 inches; the back undoes the same swaps. Test one sheet for your printer's alignment first.</p>
        <div className="row bc-print"><label>Swaps per card <select value={rows} onChange={(e) => setRows(Number(e.target.value))}>{[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><button className="primary" disabled={overflow || !fontsReady} onClick={() => window.print()}>Print double-sided swap cards</button></div>
        {overflow && <p className="error" role="alert">Some text does not fit. Choose fewer swaps per card before printing.</p>}
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
