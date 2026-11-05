import { api } from "../api";
import { listEntries } from "./details";
import type { Build, ResearchBundle, ResearchDeck } from "./api";

/**
 * A note's pages as the server works them out for its owner (`/api/research/{id}/view`,
 * server/src/sharing/research.rs): the same changes, market prices and card details the shared
 * page (`/r/<token>`) shows, so the two pages say the same thing about the same note.
 */

/** Copies to get and what they come to. A missing worth or cost is unknown, never zero. */
export interface Totals {
  cards: number;
  buy: number;
  buy_cost: number;
  print: number;
  print_cost: number;
  worth: number | null;
  cost: number | null;
  unpriced: number;
  uncosted: number;
  buy_uncosted: number;
}

export type GetId = "split" | "buy" | "print";

export interface ShopItem {
  name: string;
  n: number;
  usd: number | null;
  date: string | null;
  image: string | null;
  decks: string[];
  get: "buy" | "print" | "unknown";
  cost: number | null;
}

export interface ShoppingData {
  get: GetId;
  gets: { id: GetId; label: string }[];
  explain: string;
  prices_from: string | null;
  prices_to: string | null;
  total: Totals;
  items: ShopItem[];
}

export interface Art {
  image: string;
  artist: string | null;
}

export interface NoteView {
  /** Every list the choice covers, in the standard text format, from the server. */
  lists: { deck: string; build: string; text: string }[];
  which: "recommended" | "build" | "all";
  build: string | null;
  decks: { key: string; art: Art | null; identity: string | null; label: string | null; builds: { id: string; label: string }[]; totals: Totals }[];
  shopping: ShoppingData;
}

export interface ChangeRow {
  add: string;
  cut: string;
  n: number;
  why: string;
  notes: string[];
  add_image: string | null;
  cut_image: string | null;
  /** The build's swap this row is, when the changes are from the starting list. */
  swap?: string | null;
}

export interface ListCard {
  name: string;
  qty: number;
  board: "commander" | "main" | "side";
  type_line: string | null;
  cmc: number;
  image: string | null;
}

export interface DeckView {
  build: string;
  vs: string | null;
  vs_label: string;
  art: Art | null;
  identity: string | null;
  changes: ChangeRow[];
  shopping: ShoppingData | null;
  cards: ListCard[];
  cut: boolean;
  unknown: string[];
  /** The list in the standard text format (Commander, then Deck), as the shared page gives it. */
  text: string;
}

/** The note page's choices: which builds to price (`build` id, `all`, else each deck's
 *  recommended) and how to get the cards. */
export interface NoteChoice {
  build?: string | null;
  all?: boolean;
  get?: GetId;
}

function query(parts: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(parts)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

const getParam = (g?: GetId) => (g && g !== "split" ? g : null);

export const noteView = (id: string, c: NoteChoice, signal?: AbortSignal) =>
  api<NoteView>(`/api/research/${encodeURIComponent(id)}/view${query({ build: c.all ? null : c.build, builds: c.all ? "all" : null, get: getParam(c.get) })}`, { signal });

export const deckView = (id: string, deck: string, c: { build: string; vs?: string | null; get?: GetId }, signal?: AbortSignal) =>
  api<DeckView>(`/api/research/${encodeURIComponent(id)}/view/${encodeURIComponent(deck)}${query({ build: c.build, vs: c.vs, get: getParam(c.get) })}`, { signal });

/** A deck's recommended build, else its first: what the shared page prices by default. */
export function recommendedOf(deck: ResearchDeck): Build | undefined {
  return deck.builds.find((b) => b.id === deck.recommended_build) ?? deck.builds[0];
}

/** The build a deck page opens at: the one asked for, else the owner's preferred build, else the
 *  recommended one, else the first. */
export function pickBuild(bundle: ResearchBundle, deck: ResearchDeck, asked: string | null): Build | undefined {
  const preferred = bundle.reviews.find((r) => r.target === `deck:${deck.key}`)?.decision;
  return deck.builds.find((b) => b.id === asked) ?? deck.builds.find((b) => b.id === preferred) ?? deck.builds.find((b) => b.id === deck.recommended_build) ?? deck.builds[0];
}

/** A build's list in the standard text format (Commander, then Deck), names sorted, as the
 *  shared page's copy boxes and downloads give it. */
export function plainList(list: string): string {
  const rows = listEntries(list);
  const out: string[] = [];
  for (const [title, commander] of [["Commander", true], ["Deck", false]] as const) {
    const merged = new Map<string, number>();
    for (const r of rows.filter((r) => r.commander === commander && r.qty > 0)) merged.set(r.name, (merged.get(r.name) ?? 0) + r.qty);
    if (!merged.size) continue;
    out.push(title, ...[...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, qty]) => `${qty} ${name}`), "");
  }
  return out.join("\n");
}

/** "21 in, 21 out": copies a build's swaps add and cut. */
export function moved(build: Build): { added: number; removed: number } {
  const n = (s: { qty?: number }) => (s.qty && s.qty > 0 ? s.qty : 1);
  const swaps = build.swaps ?? [];
  return { added: swaps.filter((s) => s.card_in).reduce((a, s) => a + n(s), 0), removed: swaps.filter((s) => s.card_out).reduce((a, s) => a + n(s), 0) };
}

const BRACKETS: Record<number, string> = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };
/** "Bracket 3, Upgraded", as the shared page labels a build's bracket. */
export function bracketLabel(build: Build): string | null {
  const n = build.bracket;
  return n != null && n >= 1 && n <= 5 ? `Bracket ${n}, ${BRACKETS[n]}` : null;
}

export const cardsWord = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** A plan as the Plans page lists it (`/api/research-plans`). */
export interface PlanSummary {
  id: string;
  title: string;
  revision: number;
  updated_at: string;
  visibility: "private" | "link" | "public";
  share_token: string | null;
  decks: number;
  copied_by: string | null;
  art: { commander: string; image: string; artist: string | null }[];
}

export const planSummaries = ({ signal }: { signal?: AbortSignal } = {}) => api<PlanSummary[]>("/api/research-plans", { signal });
/** Under "research", so saving, importing or copying a note refreshes it. */
export const planSummariesKey = (userId: string | undefined) => ["research", userId, { plans: true }] as const;
