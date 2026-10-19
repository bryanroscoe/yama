// Thin client for the Rust server. Types mirror the server's JSON.

export class ApiError extends Error {
  /** The JSON error body, when there was one: some 400s add details beside `error`. */
  constructor(public status: number, message: string, public body?: Record<string, unknown>) {
    super(message);
  }
}

const TOKEN_KEY = "yama.token";

/** Empty on the web (same origin). The phone apps load from the device, so they set the server URL. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

/** Native apps can't share the web cookie, so they keep the bearer token. Web relies on the cookie. */
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(API_BASE + path, { ...init, headers, body, credentials: "include" });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let data: Record<string, unknown> | undefined;
    try {
      data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message, data);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

export interface Card {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  cmc: number;
  type_line: string;
  oracle_text: string;
  colors: string;
  color_identity: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  rarity: string | null;
  layout: string | null;
  legalities: Record<string, string>;
  image_small: string | null;
  image_normal: string | null;
  image_art_crop: string | null;
  back_image_normal: string | null;
  artist: string | null;
  default_printing: string | null;
  edhrec_rank: number | null;
}

export interface Printing {
  scryfall_id: string;
  oracle_id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  lang: string;
  rarity: string | null;
  finishes: string[];
  released_at: string | null;
  image_normal: string | null;
  image_small: string | null;
  back_image_normal: string | null;
  artist: string | null;
  price_date: string | null;
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
  eur: number | null;
  eur_foil: number | null;
}

export interface SearchResult {
  total: number;
  page: number;
  page_size: number;
  cards: Card[];
}

export interface CollectionItem {
  id: string;
  scryfall_id: string;
  qty: number;
  condition: string;
  finish: string;
  lang: string;
  proxy: boolean;
  container_id: string | null;
  container_name: string | null;
  container_kind: string | null;
  purchase_price: number | null;
  oracle_id: string | null;
  name: string | null;
  set_code: string | null;
  set_name: string | null;
  collector_number: string | null;
  rarity: string | null;
  image_small: string | null;
  image_normal: string | null;
  type_line: string | null;
  color_identity: string | null;
  unit_price_usd: number | null;
  price_date: string | null;
}

export interface Container {
  id: string;
  kind: string;
  name: string;
  copies: number;
}

export interface CollectionSummary {
  copies: number;
  distinct_printings: number;
  market_value_usd: number;
  copies_without_price: number;
  price_date: string | null;
  purchase_total_usd: number;
}

export interface ImportReport {
  rows: number;
  copies: number;
  added_rows: number;
  already_imported_rows: number;
  containers: string[];
  unknown_printings: string[];
  errors: string[];
  decks_created: string[];
  decks_updated: string[];
}

export type Board = "commander" | "main" | "side";

export interface DeckCard {
  oracle_id: string;
  name: string;
  qty: number;
  board: Board;
}

export interface DeckSummary {
  id: string;
  name: string;
  folder: string | null;
  format: string;
  container_id: string | null;
  current_version_id: string | null;
  updated_at: string;
  commanders: string[];
  color_identity: string;
  card_count: number;
  commander_image: string | null;
}

export interface DeckEntry extends DeckCard {
  card: Card | null;
  owned: number;
  in_deck_container: number;
  proxies: number;
  locations: Record<string, number>;
  needed: number;
  cheapest_usd: number | null;
}

export interface DeckView {
  id: string;
  name: string;
  container_id: string | null;
  version_id: string | null;
  cards: DeckEntry[];
  validation: { ok: boolean; total: number; color_identity: string; errors: string[]; warnings: string[] };
  ownership: { cards: number; owned: number; needed: number; needed_cost_usd: number; needed_without_price: number };
}

export interface Member {
  id: string;
  user_id: string | null;
  guest_name: string | null;
  display_name: string;
}

export interface Playgroup {
  id: string;
  name: string;
  owner_id: string;
  join_code: string;
  members: Member[];
}

export interface PlaygroupStats {
  games: number;
  players: { name: string; member_id: string | null; games: number; wins: number }[];
  commanders: { commander: string; games: number; wins: number }[];
  average_turns: number | null;
  average_minutes: number | null;
}

export interface GameSeat {
  seat: number;
  member_id: string | null;
  user_id: string | null;
  guest_name: string | null;
  deck_label: string | null;
  commander_name: string | null;
  final_life: number | null;
  eliminated_turn: number | null;
  display_name: string | null;
}

export interface GameRow {
  id: string;
  mode: string;
  playgroup_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  turns: number | null;
  winner_seat: number | null;
  seats: GameSeat[];
}

export const usd = (v: number | null | undefined) => (v == null ? "no price" : `$${v.toFixed(2)}`);
