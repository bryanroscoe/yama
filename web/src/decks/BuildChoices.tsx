import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api, type DeckSummary, type DeckView } from "../api";
import { CardRef } from "../components/CardRef";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { HowTo } from "../components/HowTo";
import { useCardArt } from "../components/useCardArt";
import { AreaHead, BackButton } from "../components/DeckTabs";
import { ErrorText, Pips } from "../components/ui";
import { useMe } from "../auth";
import { usePlan } from "../plan/store";
import { buildNotes, buildNotesKey } from "../research/api";
import { buildFamilies, resolveBuildFamily, duplexPages, exactChanges, pairChanges, printList, slotsText, type BuildChoice, type BuildFamily, type DuplexFace } from "./buildCatalog";
import { ChangesTable, CopyBox, SectionHead } from "../research/parts";
import { plainList, type ChangeRow } from "../research/view";
import "../plan/plan.css";
import "../research/research.css";
import "./build-choices.css";

/**
 * `/decks/builds`, Swap cards: a deck's lists and plan builds laid out as a plan's deck page
 * (research/Research.tsx, and the shared page it matches): the deck's art, its builds to pick,
 * the changes from another list with their plans' reasons, then the changes printed as
 * double-sided cards for the deck box. Without a deck chosen, every deck as an art tile.
 */
export function BuildChoicesPage() {
  const [params] = useSearchParams();
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const plan = usePlan(userId);
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const families = buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []);
  const key = params.get("deck");
  const savedDeck = params.get("savedDeck");
  const planKey = params.get("planKey");
  const asked = !!(key || savedDeck || planKey);
  const family = asked ? resolveBuildFamily(families, key, savedDeck, planKey) : undefined;
  const loading = notes.isPending || plan.pending || decks.isPending;
  const errors = <>
    <ErrorText error={notes.error || plan.error || decks.error} />
    {plan.offline && <p role="status" className="small dim">No connection. Showing the plan copy saved on this device.</p>}
  </>;
  const artOf = useFamilyArt(families);
  if (!loading && family) return <FamilyPage key={family.key} family={family} status={errors} art={artOf(family)} />;
  const shown = families;
  return <main className="page plan note-page build-choices">
    <AreaHead title="Swap cards" index back={{ to: "/decks", label: "Decks" }} />
    <HowTo
      title="How swap cards work"
      open={!loading && !families.some((f) => f.choices.length > 1)}
      steps={[
        <><b>Pick a deck</b> with at least two lists: the deck as it is and a plan's Bracket 3 build, say, or its stock list or another saved configuration.</>,
        <><b>Pick the build to switch to</b> and the list to change from. Each card that changes shows with the reason its plan gives.</>,
        <><b>Print</b> double-sided on US Letter and cut out the cards. Keep them in the deck box: one side takes the deck to the build, the other brings it back.</>,
      ]}
      actions={<><Link className="button primary" to="/decks/plans">Get a plan with bracket builds</Link><Link className="button outline" to="/decks">Open your decks</Link></>}
    />
    {errors}
    {loading && <p className="dim">Loading your decks and plans…</p>}
    {!loading && asked && <p>That deck has no lists to swap between. Pick another below.</p>}
    {!loading && !shown.length && <p>No saved decks or plan builds yet.</p>}
    {!loading && shown.length > 0 && <>
      <div className="plan-deck-grid note-decks">{shown.map((f) => {
        const brackets = f.choices.filter((c) => c.kind === "bracket").length;
        return <article key={f.key} className="note-tile">
          <Link className="plan-tile" to={`/decks/builds?deck=${encodeURIComponent(f.key)}`}>
            <ArtPanel art={artOf(f).art} artist={artOf(f).artist} wash="left" credit={false} className="plan-tile-art">
              <span className="plan-tile-name">{f.name}</span>
              {commanderOf(f) && <span className="plan-tile-cmdr">{f.deck && <Pips identity={f.deck.color_identity} />} {commanderOf(f)}</span>}
              <span className="plan-tile-counts">{f.choices.length < 2 ? "Nothing to swap between yet" : `${f.choices.length} lists${brackets ? `, ${brackets} bracket ${brackets === 1 ? "build" : "builds"}` : ""}`}</span>
            </ArtPanel>
          </Link>
        </article>;
      })}</div>
      {shown.some((f) => artOf(f).art) && <p className="small dim art-credits">{artCredits(shown.filter((f) => artOf(f).art).map((f) => artOf(f).artist))}</p>}
    </>}
  </main>;
}

const groups = ["current", "original", "bracket", "legacy"] as const;
/** The lists to compare with, by kind. An option says the build first (a phone's select cuts off
 *  the rest); where two have the same name, which plan each is from follows. */
function Choices({ choices }: { choices: BuildChoice[] }) {
  return <>{groups.map((kind) => {
    const cs = choices.filter((c) => c.kind === kind).sort((a, b) => (a.bracket ?? 0) - (b.bracket ?? 0));
    return cs.length > 0 && <optgroup key={kind} label={kind === "bracket" ? "Bracket builds" : kind === "legacy" ? "Older snapshots" : kind === "original" ? "Stock" : "The deck as it is"}>{cs.map((c) => <option key={c.id} value={c.id}>{c.label}{choices.filter((o) => o.label === c.label).length > 1 ? ` (${c.note ?? c.source})` : ""}</option>)}</optgroup>;
  })}</>;
}
/** A deck's commander: the saved deck's, else the first one its lists name. */
function commanderOf(f: BuildFamily): string | null {
  if (f.deck?.commanders.length) return f.deck.commanders.join(" and ");
  for (const c of f.choices) {
    const m = c.list?.match(/^commander:?\s*\n\s*\d+\s+(.+?)\s*(?:\([A-Z0-9]+\)\s+\S+.*)?$/im);
    if (m) return m[1]!;
  }
  return null;
}
/** Each deck's commander art: the saved deck's, else looked up by its commander's name. */
function useFamilyArt(families: BuildFamily[]): (f: BuildFamily) => { art: string | null; artist: string | null } {
  const looked = useCardArt(families.filter((f) => !f.deck?.commander_image).map(commanderOf));
  return (f) => f.deck?.commander_image ? { art: f.deck.commander_image, artist: f.deck.commander_artist } : { art: looked.get(commanderOf(f) ?? "")?.art ?? null, artist: looked.get(commanderOf(f) ?? "")?.artist ?? null };
}
/** Where a list lives: its plan, or the saved deck. */
const openLabel = (c: BuildChoice) => (c.savedDeck ? "Open the deck" : c.id.startsWith("research:") ? "Open it in its plan" : "Open the tracked plan");
/** Where a build's cards come from, as the pill under its builds says it. */
function trackPill(c: BuildChoice) {
  if (c.savedDeck) return null;
  if (c.track === "owned_now") return <span className="pill good">Built from cards you have</span>;
  if (c.track === "aspirational") return <span className="pill warn">Needs cards bought or printed</span>;
  return <span className="pill quiet">Whether you have its cards isn't checked</span>;
}
/** The builds as rows of chips: the deck's own lists, then each plan's, as a plan's page shows a
 *  deck's builds. Older snapshots fold away. */
function BuildChips({ choices, value, onChange }: { choices: BuildChoice[]; value: string; onChange: (id: string) => void }) {
  const rows = new Map<string, BuildChoice[]>();
  const add = (title: string, c: BuildChoice) => rows.set(title, [...(rows.get(title) ?? []), c]);
  const sorted = [...choices].sort((a, b) => groups.indexOf(a.kind) - groups.indexOf(b.kind) || (a.bracket ?? 0) - (b.bracket ?? 0));
  for (const c of sorted.filter((c) => c.kind !== "legacy")) add(c.savedDeck ? "Your lists" : c.note ? `From ${c.note}` : "From your tracked plan", c);
  const older = sorted.filter((c) => c.kind === "legacy");
  const chips = (cs: BuildChoice[]) => cs.map((c) => <button key={c.id} type="button" className="choice-chip" aria-pressed={c.id === value} onClick={() => onChange(c.id)}>{c.label}</button>);
  return <div className="bc-builds">
    {[...rows].map(([title, cs]) => <div key={title} className="choice-chips" role="group" aria-label={title}><span className="dim small">{title}</span>{chips(cs)}</div>)}
    {older.length > 0 && <details className="bc-older" open={older.some((c) => c.id === value)}><summary className="small dim">Older snapshots ({older.length})</summary><div className="choice-chips" role="group" aria-label="Older snapshots">{chips(older)}</div></details>}
  </div>;
}
function useChoiceList(choice?: BuildChoice) {
  const saved = useQuery({ queryKey: ["deck", choice?.savedDeck], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${encodeURIComponent(choice!.savedDeck!)}`, { signal }), enabled: !!choice?.savedDeck });
  // Never use a historical research baseline as today's sleeved deck.
  const text = choice?.list ?? (saved.data ? slotsText(saved.data.cards.flatMap((c) => c.board === "main" || c.board === "commander" ? [{ name: c.name, qty: c.qty, board: c.board }] : [])) : undefined);
  return { text, error: saved.error, version: saved.data?.version_id };
}
function preferred(choices: BuildChoice[], bracket: number) {
  return choices.find((c) => c.bracket === bracket && /lower.friction/i.test(c.label)) ?? choices.find((c) => c.bracket === bracket);
}
/** What a deck's page opens on: to its best checked Bracket 3 build (else any bracket build,
 *  else another list), from the deck as it is. */
function defaults(choices: BuildChoice[]) {
  const builds = choices.filter((c) => c.kind === "bracket");
  const owned = builds.filter((c) => c.track === "owned_now");
  const to = preferred(owned, 3) ?? preferred(owned, 2) ?? preferred(builds, 3) ?? preferred(builds, 2) ?? builds[0] ?? choices.find((c) => c.kind !== "current") ?? choices[0];
  const from = choices.find((c) => c.kind === "current" && c.id !== to?.id) ?? choices.find((c) => c.kind === "original" && c.id !== to?.id) ?? choices.find((c) => c.id !== to?.id);
  return { to, from };
}
function FamilyPage({ family, status, art }: { family: BuildFamily; status: ReactNode; art: { art: string | null; artist: string | null } }) {
  const [params, setParams] = useSearchParams();
  const all = family.choices;
  const fallback = defaults(all);
  const to = all.find((c) => c.id === params.get("to")) ?? fallback.to;
  const from = all.find((c) => c.id === params.get("from") && c.id !== to?.id) ?? (fallback.from?.id !== to?.id ? fallback.from : all.find((c) => c.id !== to?.id));
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
  // Switching builds keeps the comparison, unless it's the build switched to: then the build
  // just left becomes it.
  const pick = (side: "from" | "to", id: string) => {
    const next = { from: from?.id ?? "", to: to?.id ?? "", [side]: id };
    if (next.from === next.to) next[side === "to" ? "from" : "to"] = side === "to" ? to?.id ?? "" : from?.id ?? "";
    setParams({ deck: family.key, ...next }, { replace: true, preventScrollReset: true });
  };
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
  const deck = family.deck;
  const swaps = comparison.swaps;
  const parts = Math.max(1, Math.ceil((swaps?.length ?? 0) / rows));
  const rowsOf = (swaps ?? []).map((s): ChangeRow => ({ add: s.in.name, cut: s.out.name, n: 1, why: s.why ?? "", notes: [s.where, s.out.board === "commander" || s.in.board === "commander" ? "Changes the commander." : null].filter((x): x is string => !!x), add_image: null, cut_image: null }));
  return <main className="plan plan-deck-page note-page build-choices">
    <ArtPanel as="header" className="plan-hero" art={art.art} artist={art.artist} wash="bottom" toGround credit={false}>
      <BackButton to="/decks/builds" label="Back to swap cards" className="on-art" />
      {art.art && <span className="plan-hero-credit">{commanderOf(family)}. {artCredit(art.artist)}</span>}
      <div className="plan-hero-inner">
        <nav className="plan-crumbs" aria-label="Breadcrumb"><Link to="/decks">Decks</Link><span aria-hidden="true">/</span><Link to="/decks/builds">Swap cards</Link></nav>
        {commanderOf(family) && <span className="plan-hero-cmdr">{deck && <Pips identity={deck.color_identity} />} {commanderOf(family)}</span>}
        <h1 className="plan-hero-title">{family.name}</h1>
        {to && <span className="plan-hero-chips"><span className="art-chip plain">{to.label}</span></span>}
      </div>
    </ArtPanel>
    <div className="page plan-deck-body">
      {status}
      {!to || !from ? <div className="stack">
        <p>This deck has one list so far, so there's nothing to swap between yet. Give it another: save its stock list or a new configuration from the deck's page, or get a plan with bracket builds for it.</p>
        <div className="row">{deck && <Link className="button primary" to={`/decks/${deck.id}`}>Open the deck</Link>}<Link className="button outline" to="/decks/plans">Get a plan</Link></div>
      </div> : <>
        <BuildChips choices={all} value={to.id} onChange={(id) => pick("to", id)} />
        <div className="note-pills">
          {trackPill(to)}
          {swaps && <a className="pill note-pill-link" href="#bc-changes">{swaps.length} in, {swaps.length} out from {from.label}</a>}
        </div>
        <p className="small dim bc-source">{to.source}. <Link to={to.href}>{openLabel(to)}</Link></p>
        {to.warnings.length > 0 && <details className="note-fold"><summary>Notes and limits for this build ({to.warnings.length})</summary><ul className="small">{to.warnings.map((w, j) => <li key={j}>{w}</li>)}</ul></details>}

        <section className="note-section" aria-labelledby="bc-changes">
          <SectionHead id="bc-changes" eyebrow={swaps ? `${swaps.length} in, ${swaps.length} out` : undefined} after={<label className="note-vs"><span className="visually-hidden">Compare with</span><select value={from.id} onChange={(e) => pick("from", e.target.value)}><Choices choices={all.filter((c) => c.id !== to.id)} /></select></label>}>Changes from<span className="visually-hidden"> {from.label}</span></SectionHead>
          {from.source !== to.source && <p className="small dim">{from.source}. <Link to={from.href}>{openLabel(from)}</Link></p>}
          <ErrorText error={left.error || right.error} />
          {comparison.error && <p role="alert" className="error">{comparison.error}</p>}
          {!left.text || !right.text ? <p className="dim">Loading both lists…</p> : swaps && (swaps.length ? <ChangesTable rows={rowsOf} /> : <p className="dim">These lists play the same cards.</p>)}
          <p className="small dim">Bracket labels are the plans' own assessments; legality isn't rechecked here. Printing doesn't mark any swap as done.</p>
        </section>

        {swaps && swaps.length > 0 && <section className="note-section" aria-labelledby="bc-print">
          <SectionHead id="bc-print" eyebrow={`${parts} two-sided card${parts === 1 ? "" : "s"}`}>Print swap cards</SectionHead>
          <p className="small">Print on US Letter, double-sided, <b>flip on long edge</b>, actual size (100%), headers and footers off. Cut on the lines. Each card is 2.5 × 3.5 inches; the back undoes the same swaps. Test one sheet for your printer's alignment first.</p>
          <div className="row bc-print"><label>Swaps per card <select value={rows} onChange={(e) => setRows(Number(e.target.value))}>{[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><button className="primary" disabled={overflow || !fontsReady} onClick={() => window.print()}>Print double-sided swap cards</button></div>
          {overflow && <p className="error" role="alert">Some text does not fit. Choose fewer swaps per card before printing.</p>}
        </section>}

        {right.text && <section className="note-section" aria-labelledby="bc-list">
          <SectionHead id="bc-list" eyebrow={to.label}>Decklist</SectionHead>
          <CopyBox title="Standard list (Commander, then Deck)" text={plainList(right.text)} rows={12} />
        </section>}
      </>}
    </div>
    {from && to && pages.length > 0 && <div ref={sheet} className={`bc-sheet${overflow ? " bc-overflow" : ""}`}>
      {pages.map((page, i) => <div className="bc-paper" key={i} aria-label={`Sheet ${Math.floor(i / 2) + 1}, ${i % 2 ? "back" : "front"}`}>{page.map((face, j) => face ? <SwapFace key={j} face={face} name={family.name} from={from} to={to} parts={parts} versions={[left.version, right.version]} /> : <div className="bc-blank" key={j} />)}</div>)}
    </div>}
  </main>;
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
