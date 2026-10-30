import { CardRef, CardText } from "../components/CardRef";
import type { Accounting, Build, Combo, GameplayProfile, Power, ResearchDeck } from "./api";

export interface ListEntry { name: string; qty: number; commander: boolean }
export const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes", "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);

export function listEntries(list: string): ListEntry[] {
  let section = "";
  return list.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (/^(commander|deck|mainboard):?$/i.test(line)) { section = line.replace(/:$/, "").toLowerCase(); return []; }
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ name: match[2]!.replace(/\s+\([A-Z0-9]+\)\s+\S+(?:\s+\*[FE]\*)?$/i, ""), qty: Number(match[1]), commander: section === "commander" }];
  });
}

export function buildAccounting(build: Build): Accounting {
  const rows = listEntries(build.list);
  const total = rows.reduce((n, r) => n + r.qty, 0);
  const commander = rows.filter((r) => r.commander).reduce((n, r) => n + r.qty, 0);
  const basics = rows.filter((r) => !r.commander && BASICS.has(r.name)).reduce((n, r) => n + r.qty, 0);
  const added = build.swaps?.reduce((n, s) => n + (s.qty ?? 1), 0) ?? 0;
  const own = build.acquisition?.owned?.filter((r)=>r.kind!=="future_stock").reduce((n, r) => n + (r.qty ?? 1), 0) ?? 0;
  const projected = build.acquisition?.owned?.filter((r)=>r.kind==="future_stock").reduce((n,r)=>n+(r.qty??1),0)??0;
  return { total, commander, main: total - commander, basics, nonbasic: total - basics, unchanged: total - added, added, removed: added, owned: own, projected_stock:projected, local_buys: build.acquisition?.buys?.reduce((n, r) => n + (r.qty ?? 1), 0) ?? 0, prints: build.acquisition?.prints?.reduce((n, r) => n + (r.qty ?? 1), 0) ?? 0, ...build.accounting };
}

export function resolvedCombos(deck: ResearchDeck, build: Build): Combo[] {
  const library = new Map(deck.combo_playbook?.map((c) => [c.id, c]));
  return (build.combos ?? []).map((c) => ({ ...library.get(c.id), ...c }));
}

export function Gameplay({ profile, legacy, names = [] }: { profile?: GameplayProfile; legacy?: Power; names?: string[] }) {
  // Old documents keep their explanatory prose; the unexplained numeric scale is never shown.
  const p = profile ?? { plan: legacy?.rationale, pace: legacy?.speed, confidence: legacy?.confidence, weaknesses: legacy?.vulnerabilities };
  if (!Object.values(p).some((v) => Array.isArray(v) ? v.length : !!v)) return <p className="dim">Gameplay assessment is being updated.</p>;
  const line = (title: string, text?: string) => text && <div><h4>{title}</h4><p><CardText text={text} names={names} /></p></div>;
  const list = (title: string, items?: string[]) => !!items?.length && <div><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}><CardText text={x} names={names} /></li>)}</ul></div>;
  return <div className="research-gameplay">
    <h3>How this build plays</h3>
    {line("Game plan", p.plan)}{list("Setup", p.setup)}{line("When it creates pressure", p.pressure)}
    {list("How it closes the game", p.finishers)}{line("Interaction and protection", p.interaction)}
    {line("Finding its engines", p.consistency)}{line("Recovery", p.recovery)}{list("What stops it", p.weaknesses)}
    {line("Expected pace", p.pace)}{line("Ceiling and limits", p.ceiling)}
    {p.confidence && <p className="small dim">Assessment confidence: {p.confidence}. Gameplay expectations are not measured win rates or guaranteed finish turns.</p>}
  </div>;
}

export function AccountingSummary({ build }: { build: Build }) {
  const a = buildAccounting(build);
  const current = ["current", "stock"].includes(build.id);
  return <div className="research-accounting" aria-label="Complete deck accounting">
    <p className={a.total === 100 ? "research-total" : "research-total warn"}><strong>{a.total} cards total</strong> = {a.commander} commander{a.commander === 1 ? "" : "s"} + {a.main} in the main deck.</p>
    <p>{a.basics} ordinary basic land copies are included in that total. Repeated basics count as separate cards.</p>
    {!current && <p><b>{a.added} cards in, {a.removed} cards out</b>; {a.unchanged} retained from the starting reference. Swaps replace cards; they do not increase the 100-card total.</p>}
    {!current && <p className="small dim">Acquisition, a separate count: {a.owned} assigned owned copies{(a.projected_stock??0)>0&&<> + {a.projected_stock} stock copies after purchase/arrival</>} + {a.local_buys} local singles + {a.prints} new prints + {a.basics} ordinary basics = {a.owned + (a.projected_stock??0) + a.local_buys + a.prints + a.basics} copies.</p>}
  </div>;
}

export function CompleteList({ build }: { build: Build }) {
  const rows = listEntries(build.list);
  return <div className="research-full-list">{[true, false].map((commander) => <div key={String(commander)}><h4>{commander ? "Commander" : "Main deck"} ({rows.filter((r) => r.commander === commander).reduce((n, r) => n + r.qty, 0)})</h4><ul>{rows.filter((r) => r.commander === commander).map((r, i) => <li key={`${r.name}-${i}`}><span className="num research-qty">{r.qty}</span><CardRef name={r.name} /></li>)}</ul></div>)}</div>;
}
