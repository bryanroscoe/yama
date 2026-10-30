import type { PlanBundle, Slot } from "@yama/core/plan";
import { bracketBuilds } from "@yama/core/plan";
import type { ResearchBundle } from "../research/api";
import type { DeckSummary } from "../api";

export type BuildKind = "current" | "original" | "bracket" | "legacy";
export interface BuildChoice {
  id: string; label: string; kind: BuildKind; bracket?: number;
  list?: string; savedDeck?: string; source: string; href: string; warnings: string[];
}
export interface BuildFamily { key: string; name: string; choices: BuildChoice[] }
export const familyKey = (name: string) => name.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function slotsText(cards: Pick<Slot, "name" | "qty" | "board">[]): string {
  return ["commander", "main"].map((board) => `${board === "main" ? "Deck" : "Commander"}\n${cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`).join("\n")}`).join("\n\n");
}
export function legacyConfiguration(label: string | null): boolean {
  return /^(legacy(?:\b|:)|after[ -]prints$|now$)/i.test(label?.trim() ?? "");
}
export function configurationLabel(label: string | null, main = false): string {
  if (main) return label ?? "Current";
  if (/^(stock|original)$/i.test(label ?? "")) return "Original";
  return label ?? "Build";
}

/** Keep sources distinct: an approved plan, independent research, and the sleeved list are not
 * interchangeable. No title or bracket label changes an installed list or research approval. */
export function buildFamilies(research: ResearchBundle[], plan: PlanBundle | undefined, decks: DeckSummary[]): BuildFamily[] {
  const families = new Map<string, BuildFamily>();
  const family = (key: string, name: string) => {
    if (!families.has(key)) families.set(key, { key, name, choices: [] });
    return families.get(key)!;
  };
  for (const bundle of research) for (const deck of bundle.document.decks) {
    if (!deck.builds.some((b) => [2, 3, 4].includes(b.bracket ?? 0))) continue;
    const f = family(familyKey(deck.name), deck.name);
    for (const b of deck.builds) {
      const isBracket = [2, 3, 4].includes(b.bracket ?? 0) && !["stock", "current"].includes(b.id);
      f.choices.push({
        id: `research:${bundle.document.id}:${deck.key}:${b.id}`, kind: isBracket ? "bracket" : "legacy",
        bracket: isBracket ? b.bracket! : undefined, label: isBracket ? `[${b.bracket}] ${b.label.replace(/^(?:Bracket\s*|B)\d\s*[—:-]?\s*/i, "") || "Research"}` : `Research starting snapshot (${bundle.updated_at.slice(0, 10)})`,
        list: b.list, source: `${bundle.document.title}, revision ${bundle.revision}, ${bundle.updated_at.slice(0, 10)}`,
        href: `/decks/research/${encodeURIComponent(bundle.document.id)}/${encodeURIComponent(deck.key)}?build=${encodeURIComponent(b.id)}`,
        warnings: [...(b.prospective ? ["Future build: requires purchase or arrival; not an owned or installed deck."] : []), ...(b.risks ?? [])],
      });
    }
  }
  for (const deck of plan?.decks ?? []) {
    if (deck.status === "archived") continue;
    const f = family(familyKey(deck.name), deck.name);
    const href = `/decks/plan/d/${encodeURIComponent(deck.key)}`;
    for (const state of ["stock", "now", "after"] as const) {
      const s = deck.states[state]; if (!s) continue;
      f.choices.push({ id: `plan:${deck.key}:${state}`, label: state === "stock" ? "Original (plan commander)" : state === "now" ? "Legacy: now snapshot" : "Legacy: after prints", kind: state === "stock" ? "original" : "legacy", list: slotsText(s.cards), source: `Plan v${plan?.head?.guide_version ?? "?"}, ${s.updated_at.slice(0, 10)}`, href, warnings: s.unresolved.map((name) => `Unresolved card: ${name}`) });
    }
    if (deck.bracket && deck.states.after) {
      for (const b of bracketBuilds(deck.states.after.cards, deck.bracket)) {
        // A bag with the same number as the full target is not another build.
        if (f.choices.some((c) => c.id === `plan:${deck.key}:b${b.bracket}`)) continue;
        f.choices.push({ id: `plan:${deck.key}:b${b.bracket}`, label: `[${b.bracket}] Plan`, kind: "bracket", bracket: b.bracket, list: slotsText(b.cards), source: `Plan v${plan?.head?.guide_version ?? "?"}`, href: `${href}?tab=brackets`, warnings: [...b.warnings, ...(deck.bracket.callouts ?? [])] });
      }
    }
  }
  const byId = new Map(decks.map((d) => [d.id, d]));
  for (const deck of decks) {
    const root = deck.parent_id ? byId.get(deck.parent_id) : deck;
    if (!root) continue;
    const linked = plan?.decks.find((p) => p.yama_deck?.id === root.id || p.deck_id === root.id);
    const f = family(familyKey(linked?.name ?? root.name), linked?.name ?? root.name);
    const original = /^(stock|original)$/i.test(deck.configuration ?? "");
    const legacy = !!deck.parent_id && legacyConfiguration(deck.configuration);
    f.choices.push({ id: `saved:${deck.id}`, label: !deck.parent_id ? "Current (saved deck)" : original ? "Original" : legacy ? `Legacy: ${deck.configuration}` : deck.configuration ?? deck.name, kind: !deck.parent_id ? "current" : original ? "original" : legacy ? "legacy" : "bracket", bracket: deck.bracket ?? undefined, savedDeck: deck.id, source: `Saved ${deck.updated_at.slice(0, 10)}`, href: `/decks/${deck.id}`, warnings: [] });
  }
  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CardCopy { name: string; board: "commander" | "main" }
/** Strict parser for printing: do not silently drop an unrecognised line or sideboard. */
export function printList(text: string): CardCopy[] {
  let board: CardCopy["board"] | undefined;
  const cards: CardCopy[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^commander$/i.test(line)) { board = "commander"; continue; }
    if (/^(deck|mainboard)$/i.test(line)) { board = "main"; continue; }
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
const copyKey = (c: CardCopy) => `${c.board}\0${c.name}`;
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
