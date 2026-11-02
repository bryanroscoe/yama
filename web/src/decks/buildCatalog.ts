import type { PlanBundle, Slot } from "@yama/core/plan";
import { bracketBuilds, slotSource, sourceContext, type PlanDeck, type SourceContext } from "@yama/core/plan";
import { ownedBuildProblems } from "../research/availability";
import type { Item, ResearchBundle } from "../research/api";
import type { DeckSummary } from "../api";

export type BuildKind = "current" | "original" | "bracket" | "legacy";
export interface BuildChoice {
  id: string; label: string; kind: BuildKind; bracket?: number;
  track?: "owned_now" | "aspirational" | "unverified";
  list?: string; savedDeck?: string; source: string; href: string; warnings: string[];
  /** The build's known swaps (card out, card in), and where the card going in comes from. */
  pairs?: SwapPair[];
}
export interface SwapPair { out: string; in: string; where?: string | null; why?: string | null }

/** Where a research swap's card comes from, from its acquisition record, without copy ids. */
export function researchWhere(a: Item | undefined): string | null {
  if (!a) return null;
  if (a.transfer && a.source_deck) return `From ${a.source_deck}.`;
  const real = a.detail?.match(/^real: ([^.]+)\./);
  if (real) return `Yours, in ${real[1]}.`;
  if (a.kind === "arrived_print" || a.detail?.startsWith("arrived_print")) return "A print that has arrived.";
  if (a.kind === "print") return "To print.";
  if (a.kind === "buy" || a.store) return "To buy.";
  return null;
}
/** A plan list's swaps: each card that names the card it replaces. */
function slotPairs(cards: Slot[], ctx: SourceContext, deck: PlanDeck): SwapPair[] {
  return cards.flatMap((c) => (c.replaces ? [{ out: c.replaces, in: c.name, where: slotSource(c, ctx, deck) || null }] : []));
}
export interface BuildFamily { key: string; name: string; choices: BuildChoice[]; planKeys?: string[]; detail?: string }
export type BuildTrack = "owned_now" | "aspirational" | "saved";
export function buildTargets(choices: BuildChoice[], track: BuildTrack) {
  return choices.filter((c) => track === "saved" ? c.kind !== "bracket" || c.track === "unverified" : c.kind === "bracket" && c.track === track);
}
export function resolveBuildFamily(families: BuildFamily[], key: string | null, savedDeck: string | null, planKey?: string | null) {
  if (savedDeck) return families.find((f) => f.choices.some((c) => c.savedDeck === savedDeck));
  if (planKey) return families.find((f) => f.planKeys?.includes(planKey));
  if (!key) return families[0];
  const exact = families.find((f) => f.key === key);
  if (exact) return exact;
  // Compatibility for earlier name-based links: ambiguity must require an explicit choice.
  const named = families.filter((f) => f.name === key);
  return named.length === 1 ? named[0] : undefined;
}
export function slotsText(cards: Pick<Slot, "name" | "qty" | "board">[]): string {
  return ["commander", "main"].map((board) => `${board === "main" ? "Deck" : "Commander"}\n${cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`).join("\n")}`).join("\n\n");
}
export function legacyConfiguration(label: string | null): boolean {
  return /^(legacy(?:\b|:)|after[ -]prints$|now$)/i.test(label?.trim() ?? "");
}
export function configurationLabel(label: string | null, name: string, main = false): string {
  const text = label?.trim();
  if (main) return text || "Current";
  if (/^(stock|original)$/i.test(text ?? "")) return "Original";
  return text || name;
}

/** Keep sources distinct: an approved plan, independent research, and the sleeved list are not
 * interchangeable. No title or bracket label changes an installed list or research approval. */
export function buildFamilies(research: ResearchBundle[], plan: PlanBundle | undefined, decks: DeckSummary[]): BuildFamily[] {
  const families = new Map<string, BuildFamily>();
  const aliases = new Map<string, Set<string>>();
  const family = (key: string, name: string, detail?: string) => {
    if (!families.has(key)) families.set(key, { key, name, detail, choices: [], planKeys: [] });
    const names = aliases.get(key) ?? new Set<string>(); names.add(name); aliases.set(key, names);
    return families.get(key)!;
  };
  const byId = new Map(decks.map((d) => [d.id, d]));
  const rootOf = (id: string) => { const d = byId.get(id); return d?.parent_id ? byId.get(d.parent_id) : d; };
  const roots = decks.filter((d) => !d.parent_id);
  for (const root of roots) family(`saved:${root.id}`, root.name, `Saved deck ${root.id}`);
  const plans = (plan?.decks ?? []).filter((d) => d.status !== "archived");
  const planFamilies = new Map<string, BuildFamily>();
  for (const deck of plans) {
    const explicit = deck.yama_deck?.id ?? deck.deck_id;
    const sameName = roots.filter((d) => d.name === deck.name);
    // Explicit links outrank names. Never guess when either side has duplicate names.
    const root = explicit ? rootOf(explicit) : sameName.length === 1 && plans.filter((p) => p.name === deck.name).length === 1 ? sameName[0] : undefined;
    const f = family(root ? `saved:${root.id}` : `plan:${deck.key}`, deck.name, `Plan ${deck.key}`);
    f.name = deck.name; f.planKeys!.push(deck.key); planFamilies.set(deck.key, f);
  }
  // Only these saved/plan identities are candidates for name-based research association.
  // Ambiguous research remains independent; it never combines two live saved decks.
  const anchors = [...families.values()];
  for (const bundle of research) for (const deck of bundle.document.decks) {
    if (!deck.builds.some((b) => [2, 3, 4].includes(b.bracket ?? 0))) continue;
    const matches = anchors.filter((f) => aliases.get(f.key)?.has(deck.name));
    const f = matches.length === 1 ? matches[0]! : family(`research:${JSON.stringify([bundle.document.id, deck.key])}`, deck.name, `Research ${bundle.document.title} (${bundle.document.id}, ${deck.key})`);
    for (const b of deck.builds) {
      const ownershipProblems = ownedBuildProblems(b);
      const isBracket = [2, 3, 4].includes(b.bracket ?? 0) && !["stock", "current"].includes(b.id);
      f.choices.push({
        id: `research:${bundle.document.id}:${deck.key}:${b.id}`, kind: isBracket ? "bracket" : "legacy",
        track: b.acquisition?.track === "owned_now" ? ownershipProblems.length ? "unverified" : "owned_now" : "aspirational",
        bracket: isBracket ? b.bracket! : undefined, label: ownershipProblems.length ? `[${b.bracket ?? "?"}] Ownership not verified` : isBracket ? `[${b.bracket}] ${b.label.replace(/^(?:\[\d\]|(?:Bracket\s*|B)\d)\s*[—:-]?\s*/i, "") || "Research"}` : `Research starting snapshot (${bundle.updated_at.slice(0, 10)})`,
        list: b.list, pairs: (b.swaps ?? []).flatMap((s) => (s.card_out ? [{ out: s.card_out, in: s.card_in, where: researchWhere(s.acquisition), why: s.why ?? null }] : [])),
        source: `${bundle.document.title}, revision ${bundle.revision}, ${bundle.updated_at.slice(0, 10)}`,
        href: `/decks/research/${encodeURIComponent(bundle.document.id)}/${encodeURIComponent(deck.key)}?build=${encodeURIComponent(b.id)}`,
        warnings: [...ownershipProblems, ...(b.prospective ? ["Future build: requires purchase or arrival; not an owned or installed deck."] : []), ...(b.risks ?? [])],
      });
    }
  }
  // Bundles from before orders and stores (and test plans) can lack them.
  const ctx = plan ? sourceContext({ orders: plan.orders ?? [], stores: plan.stores ?? [], decks: plan.decks ?? [] }) : null;
  for (const deck of plans) {
    const f = planFamilies.get(deck.key)!;
    const href = `/decks/plan/d/${encodeURIComponent(deck.key)}`;
    for (const state of ["stock", "now", "after"] as const) {
      const s = deck.states[state]; if (!s) continue;
      f.choices.push({ id: `plan:${deck.key}:${state}`, label: state === "stock" ? "Original (plan commander)" : state === "now" ? "Legacy: now snapshot" : "Legacy: after prints", kind: state === "stock" ? "original" : "legacy", list: slotsText(s.cards), pairs: ctx ? slotPairs(s.cards, ctx, deck) : [], source: `Plan v${plan?.head?.guide_version ?? "?"}, ${s.updated_at.slice(0, 10)}`, href, warnings: s.unresolved.map((name) => `Unresolved card: ${name}`) });
    }
    if (deck.bracket && deck.states.after) {
      for (const b of bracketBuilds(deck.states.after.cards, deck.bracket)) {
        // A bag with the same number as the full target is not another build.
        if (f.choices.some((c) => c.id === `plan:${deck.key}:b${b.bracket}`)) continue;
        f.choices.push({ id: `plan:${deck.key}:b${b.bracket}`, label: `[${b.bracket}] Plan (availability unchecked)`, kind: "bracket", track: "unverified", bracket: b.bracket, list: slotsText(b.cards), pairs: ctx ? slotPairs(b.cards, ctx, deck) : [], source: `Plan v${plan?.head?.guide_version ?? "?"}`, href: `${href}?tab=brackets`, warnings: [...b.warnings, ...(deck.bracket.callouts ?? [])] });
      }
    }
  }
  for (const deck of decks) {
    const root = deck.parent_id ? byId.get(deck.parent_id) : deck;
    if (!root) continue;
    const f = families.get(`saved:${root.id}`)!;
    const original = /^(stock|original)$/i.test(deck.configuration ?? "");
    const legacy = !!deck.parent_id && legacyConfiguration(deck.configuration);
    f.choices.push({ id: `saved:${deck.id}`, label: !deck.parent_id ? "Current (saved deck)" : original ? "Original" : legacy ? `Legacy: ${deck.configuration}` : deck.configuration ?? deck.name, kind: !deck.parent_id ? "current" : original ? "original" : legacy ? "legacy" : "bracket", bracket: deck.bracket ?? undefined, track: "unverified", savedDeck: deck.id, source: `Saved ${deck.updated_at.slice(0, 10)}`, href: `/decks/${deck.id}`, warnings: [] });
  }
  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export interface CardCopy { name: string; board: "commander" | "main" }
/** Strict parser for printing: do not silently drop an unrecognised line or sideboard. */
export function printList(text: string): CardCopy[] {
  let board: CardCopy["board"] | undefined;
  const cards: CardCopy[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^commander:?$/i.test(line)) { board = "commander"; continue; }
    if (/^(deck|mainboard):?$/i.test(line)) { board = "main"; continue; }
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m || !board) throw new Error(`Cannot read this deck line: ${line}`);
    const qty = Number(m[1]); if (qty < 1 || qty > 100) throw new Error("Invalid card quantity.");
    const name = m[2]!.replace(/\s+\([A-Z0-9]+\)\s+\S+(?:\s+\*[FE]\*)?$/i, "");
    for (let i = 0; i < qty; i++) cards.push({ name, board });
  }
  const commanders = cards.filter((c) => c.board === "commander").length;
  if (cards.length !== 100 || commanders < 1 || commanders > 2) throw new Error(`This list has ${cards.length} cards and ${commanders} commanders. Use a complete 100-card build.`);
  return cards;
}
// Match case-insensitively across canonical multiface and front-only names; retain display text.
const copyKey = (c: CardCopy) => `${c.board}\0${c.name.split(" // ")[0]!.trim().toLowerCase()}`;
export function exactChanges(from: CardCopy[], to: CardCopy[]): { out: CardCopy; in: CardCopy }[] {
  const subtract = (left: CardCopy[], right: CardCopy[]) => {
    const counts = new Map<string, number>();
    for (const c of right) counts.set(copyKey(c), (counts.get(copyKey(c)) ?? 0) + 1);
    return left.filter((c) => { const n = counts.get(copyKey(c)) ?? 0; if (n) { counts.set(copyKey(c), n - 1); return false; } return true; }).sort((a, b) => copyKey(a).localeCompare(copyKey(b)));
  };
  const out = subtract(from, to), add = subtract(to, from);
  if (out.length !== add.length) throw new Error("These builds have different card counts.");
  return out.map((c, i) => ({ out: c, in: add[i]! }));
}
export interface DuplexFace { part: number; reverse: boolean; swaps: ReturnType<typeof exactChanges> }
/** Fronts then matching backs; mirror columns for portrait long-edge duplex. Always pad all nine
 * slots, including the last sheet. The grid must be centred horizontally on the physical page. */
export function duplexPages(swaps: ReturnType<typeof exactChanges>, rows = 6): (DuplexFace | null)[][] {
  if (!Number.isInteger(rows) || rows < 1) throw new Error("Rows must be positive.");
  const fronts: DuplexFace[] = [];
  for (let i = 0; i < Math.max(1, swaps.length); i += rows) fronts.push({ part: fronts.length + 1, reverse: false, swaps: swaps.slice(i, i + rows) });
  const pages: (DuplexFace | null)[][] = [];
  for (let i = 0; i < fronts.length; i += 9) {
    const front = Array.from({ length: 9 }, (_, j) => fronts[i + j] ?? null);
    const back = Array.from({ length: 9 }, (_, j) => { const c = front[Math.floor(j / 3) * 3 + 2 - j % 3]; return c ? { ...c, reverse: true, swaps: c.swaps.map((s) => ({ out: s.in, in: s.out })) } : null; });
    pages.push(front, back);
  }
  return pages;
}
