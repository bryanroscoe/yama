// List text for copying, list differences, review answers and the proposed build.

import { newestChecks } from "./quotes";
import type { PlanGroup, Quote, Review, Slot, Store, Swap } from "./types";

/** Basic lands as commander-decks' library.py counts them: they sort last in copied lists. */
export const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"]);

export interface ExportOptions {
  /** `1 Name (SET) 123` when the printing is known (Moxfield). Without it, names only (EDHbots). */
  printings?: boolean;
}

/**
 * A list as text: a "Commander" section, then "Deck", basics last, otherwise A to Z by lower-cased
 * name. Names only, it matches commander-decks' decks/compare/*.txt; with printings, its
 * library.import_text. Copies of one card in different printings get a line each with printings,
 * and one summed line without.
 */
export function exportText(cards: Slot[], opts: ExportOptions = {}): string {
  const line = (qty: number, s: Slot) => {
    const p = opts.printings && s.set && s.num ? ` (${s.set.toUpperCase()}) ${s.num}` : "";
    return `${qty} ${s.name}${p}`;
  };
  const commanders = cards.filter((c) => c.board === "commander");
  const groups = new Map<string, { slot: Slot; qty: number; key: string[] }>();
  for (const s of cards) {
    if (s.board === "commander") continue;
    // Python sorts ties by str((set, num)): "('ltr', '264')" before "(None, None)".
    const printing = opts.printings ? `(${py(s.set)}, ${py(s.num)})` : "(None, None)";
    const id = JSON.stringify([s.name, printing]);
    const g = groups.get(id);
    if (g) g.qty += s.qty;
    else groups.set(id, { slot: s, qty: s.qty, key: [BASICS.has(s.name) ? "1" : "0", s.name.toLowerCase(), printing] });
  }
  const body = [...groups.values()].sort((a, b) => compareArrays(a.key, b.key));
  const lines = ["Commander", ...commanders.map((c) => line(c.qty, c)), "", "Deck", ...body.map((g) => line(g.qty, g.slot))];
  return lines.join("\n") + "\n";
}

/** A string as Python's repr writes it inside a tuple ('abc'), or None. */
const py = (v: string | null | undefined) => (v == null ? "None" : `'${v}'`);

/** Plain code-unit order, as Python sorts strings (localeCompare would differ by locale). */
function compareArrays(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface DiffLine {
  name: string;
  qty: number;
  board: "commander" | "main";
}

/** What `to` adds and removes compared with `from`, by name and board. Printings don't count. */
export function deckDiff(from: Slot[], to: Slot[]): { added: DiffLine[]; removed: DiffLine[] } {
  const count = (cards: Slot[]) => {
    const m = new Map<string, number>();
    for (const c of cards) {
      const k = `${c.board}\u0000${c.name}`;
      m.set(k, (m.get(k) ?? 0) + c.qty);
    }
    return m;
  };
  const a = count(from);
  const b = count(to);
  const lines = (x: Map<string, number>, y: Map<string, number>) =>
    [...x]
      .filter(([k, n]) => n > (y.get(k) ?? 0))
      .map(([k, n]) => {
        const [board, name] = k.split("\u0000") as ["commander" | "main", string];
        return { name, board, qty: n - (y.get(k) ?? 0) };
      })
      .sort((p, q) => compareArrays([p.board === "commander" ? "0" : "1", p.name.toLowerCase()], [q.board === "commander" ? "0" : "1", q.name.toLowerCase()]));
  return { added: lines(b, a), removed: lines(a, b) };
}

/** Names in `cards` that aren't in `base` (more copies than `base` counts as new too). */
export function newNames(base: Slot[], cards: Slot[]): Set<string> {
  return new Set(deckDiff(base, cards).added.map((l) => l.name));
}

// ── review answers ─────────────────────────────────────────────────────────

/** An entry with decision, note and cut all empty is a cleared answer (a tombstone). */
export function isAnswer(r: Review | undefined | null): r is Review {
  return !!r && (!!r.decision || !!r.note?.trim() || !!r.cut);
}

/** Follow aliases from `key` to a live key, at most ten hops; `null` when it reaches none. */
export function resolveKey(key: string, live: Set<string>, aliases: Record<string, string>): string | null {
  let k: string | undefined = key;
  for (let i = 0; i <= 10 && k !== undefined; i++) {
    if (live.has(k)) return k;
    k = aliases[k];
  }
  return null;
}

/**
 * Each live swap's current answer, following aliases (a renamed or promoted swap keeps its answer).
 * When two keys reach the same swap the later `at` wins, and a newer tombstone clears an older
 * answer. Answers that reach no live swap are returned as `orphans`, never dropped.
 */
export function answerIndex(
  reviews: Record<string, Review>,
  aliases: Record<string, string>,
  liveKeys: Iterable<string>,
): { answers: Map<string, Review>; orphans: [string, Review][] } {
  const live = new Set(liveKeys);
  const latest = new Map<string, Review>();
  const orphans: [string, Review][] = [];
  for (const [key, r] of Object.entries(reviews)) {
    const to = resolveKey(key, live, aliases);
    if (to === null) {
      if (isAnswer(r)) orphans.push([key, r]);
      continue;
    }
    const prev = latest.get(to);
    if (!prev || r.at > prev.at || (r.at === prev.at && r.origin === "yama")) latest.set(to, r);
  }
  const answers = new Map([...latest].filter(([, r]) => isAnswer(r)));
  return { answers, orphans };
}

// ── the proposed build ─────────────────────────────────────────────────────

export interface ProposalOptions {
  /**
   * Groups are cumulative: the build for a group includes every group before it. With a label,
   * only proposals in that group, the groups before it, or no listed group are used. Without one,
   * every group is.
   */
  throughGroup?: string | null;
  /** Keep only the proposals this accepts, for example cards in hand or stocked locally. */
  only?: (s: Swap) => boolean;
}

export interface ProposalBuild {
  cards: Slot[];
  /** One line per proposal: what went in for what, or why it was left out. */
  notes: string[];
  added: { key: string; in: string; cut: string }[];
}

/**
 * The after list plus the proposals not answered "no" (a port of commander-decks' server.export_text
 * 'proposals'). Each takes out the owner's chosen cut, else its suggested `out` if still in the list,
 * else its `later_out`; with none of those in the list it is left out.
 */
export function proposalBuild(
  after: Slot[],
  proposals: Swap[],
  answers: Map<string, Review>,
  groups: PlanGroup[] = [],
  opts: ProposalOptions = {},
): ProposalBuild {
  const cards = after.map((c) => ({ ...c }));
  const notes: string[] = [];
  const added: ProposalBuild["added"] = [];
  const order = groups.map((g) => g.label);
  const limit = opts.throughGroup ? order.indexOf(opts.throughGroup) : -1;
  const inScope = (s: Swap) => {
    if (limit < 0 || !s.group) return true;
    const i = order.indexOf(s.group);
    return i < 0 || i <= limit;
  };
  const has = (name: string) => cards.some((c) => c.board === "main" && c.name === name);
  for (const s of [...proposals].sort((a, b) => a.sort - b.sort)) {
    if (s.stage !== "proposed" || s.retired || !inScope(s)) continue;
    if (opts.only && !opts.only(s)) continue;
    const a = answers.get(s.key);
    if (a?.decision === "no") {
      notes.push(`Left out ${s.in} (you said no)`);
      continue;
    }
    const cut = a?.cut || (s.out && has(s.out) ? s.out : s.later_out);
    if (!cut || !has(cut)) {
      notes.push(`Left out ${s.in} (no cut in the deck)`);
      continue;
    }
    const i = cards.findIndex((c) => c.board === "main" && c.name === cut);
    const slot = cards[i]!;
    if (slot.qty > 1) slot.qty -= 1;
    else cards.splice(i, 1);
    cards.push({ name: s.in, qty: 1, board: "main", kind: "proposed", replaces: cut, swap: s.key });
    added.push({ key: s.key, in: s.in, cut });
    notes.push(`${s.in} in for ${cut}`);
  }
  return { cards, notes, added };
}

/** Total cards in a list, commander included. */
export function cardCount(cards: Slot[]): number {
  return cards.reduce((n, c) => n + c.qty, 0);
}

/**
 * For "only cards you have or can buy nearby": proposals of a card you own, or of one a local store
 * was recorded as having in stock. A stock check is dated evidence, not a promise it's still there.
 */
export function ownedOrStockedLocally(quotes: Quote[], stores: Store[]): (s: Swap) => boolean {
  const local = new Set(stores.filter((st) => st.kind === "local").map((st) => st.key));
  const bySwap = new Map<string, Quote[]>();
  for (const q of quotes) if (q.swap && q.store && local.has(q.store)) bySwap.set(q.swap, [...(bySwap.get(q.swap) ?? []), q]);
  // Only each store's newest check counts: a newer "sold out" replaces an older "in stock".
  const stocked = new Set([...bySwap].filter(([, qs]) => newestChecks(qs).some((q) => q.in_stock === true)).map(([k]) => k));
  return (s) => s.src === "owned" || (s.src === "buy" && stocked.has(s.key));
}
