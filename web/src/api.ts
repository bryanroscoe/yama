export interface SinglesValue {
  usd: number | null;
  priced_copies: number;
  unpriced_copies: number;
  oldest_date: string | null;
  newest_date: string | null;
  source: string;
}
export interface SealedPrice {
  product_id: number;
  product_name: string;
  usd: number | null;
  price_date: string;
  source: string;
  url: string;
}

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
  /**
   * Joined through open sign-up and not invited: the smaller lab and online play allowance.
   * Missing from a user cached by an older build, which reads as false.
   */
  limited?: boolean;
  /** Set while an admin views Yama as this person, read only (viewing.ts). */
  viewing?: import("./viewing").Viewing;
}

/** An account in the admin area's People list. */
export interface AccountInfo {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  limited: boolean;
  invited: boolean;
  google: boolean;
  password: boolean;
  disabled_at: string | null;
  created_at: string;
  last_sign_in: string | null;
  /** When the account last used Yama, to the hour. Null before the admin area existed. */
  last_seen_at?: string | null;
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
  /** On the Commander Game Changers list, per Scryfall. null until the server has loaded the
   *  flags (or the saved offline list lacks them): unknown, not false. */
  game_changer: boolean | null;
}

/** A ruling from Scryfall's rulings file. */
export interface Ruling {
  /** "wotc" (Wizards of the Coast) or "scryfall" */
  source: string;
  /** YYYY-MM-DD */
  published_at: string;
  comment: string;
}

export interface CardDetail {
  card: Card;
  printings: Printing[];
  /** null when the server hasn't loaded rulings yet; missing when the card came from the
   *  offline copy on this device. */
  rulings?: Ruling[] | null;
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
  /** Market value of the copies that have a price; the others are counted separately. */
  market_value_usd?: number;
  copies_without_price?: number;
  /** Art crop of the most valuable card inside, and its artist, for the container's tile. */
  art?: string | null;
  artist?: string | null;
}

export interface CollectionSummary {
  copies: number;
  /** Proxies among copies; they have no market value and aren't counted in it. */
  proxies?: number;
  distinct_printings: number;
  market_value_usd: number;
  copies_without_price: number;
  price_date: string | null;
  purchase_total_usd: number;
}

export type Board = "commander" | "main" | "side";

export interface DeckCard {
  oracle_id: string;
  name: string;
  qty: number;
  board: Board;
}

export interface DeckSummary {
  singles_value?: SinglesValue;
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
  /** Who painted commander_image; credit them wherever the art shows. */
  commander_artist: string | null;
  /** Real copies you own of the main deck and commanders, out of card_count. */
  owned?: number;
  /** Further copies covered by proxies (real copies count first). */
  proxies?: number;
  /** Finished games played with any version of this deck. */
  games?: number;
  wins?: number;
  draws?: number;
  /** The bracket the owner declares (1-5). */
  bracket: number | null;
  /** Commander Spellbook's estimate for the current version, once it has answered. */
  estimate: Estimated | null;
  /** The main deck this is a configuration of, and its label ("stock"). */
  parent_id: string | null;
  configuration: string | null;
  visibility: Visibility;
  /** The token in its share link, /d/<token>. */
  share_token: string | null;
}

/** private: only you. link: anyone with the link. public: that, and listed on your profile. */
export type Visibility = "private" | "link" | "public";

/** One deck of a configuration group. */
export interface ConfigurationRef {
  id: string;
  name: string;
  configuration: string | null;
  visibility: Visibility;
  share_token: string | null;
}

/** Your sharing settings (`/api/me/sharing`). */
export interface Sharing {
  handle: string | null;
  new_deck_visibility: Visibility;
  collection_public: boolean;
  /** Live decks by visibility. */
  decks: Record<Visibility, number>;
}

/** A deck someone shared, as "Save a copy in Yama" reads it (`/api/public/decks/<token>`). */
export interface PublicDeck {
  name: string;
  handle: string | null;
  commanders: string[];
  /** Moxfield format. */
  text: string;
}

/** "https://yama.example/d/abc…" for a share token, on this site. */
export function shareUrl(token: string): string {
  return `${location.origin}/d/${token}`;
}

/** An outside bracket estimate, shown beside the declared bracket and never instead of it. */
export interface Estimated {
  /** Commander Spellbook's tag: E C O P S R, or B for a banned card. Any other tag is one Yama
   *  doesn't know yet. */
  tag: string;
  /** Yama's label for the signals; E is "Core starting point". */
  label: string;
  /** Yama's starting suggestion, 2-4; null for a banned card or unknown tag.
   * Older cached E answers can contain 1; presentation must normalize these to provisional 2. */
  bracket: number | null;
  checked_at: string | null;
}

/** The printing an export names: your copy, else a paper printing (Scryfall's default when it's
 *  on paper). */
export interface PrintRef {
  set_code: string;
  collector_number: string;
  finish: string;
  from: "owned" | "default";
}

export interface DeckEntry extends DeckCard {
  card: Card | null;
  owned: number;
  in_deck_container: number;
  proxies: number;
  locations: Record<string, number>;
  needed: number;
  cheapest_usd: number | null;
  printing: PrintRef | null;
  /** Colors of mana the card makes ("WUBRGC" letters), "" for none, null until loaded. */
  produced_mana: string | null;
}

export interface DeckView {
  singles_value?: SinglesValue;
  id: string;
  name: string;
  container_id: string | null;
  version_id: string | null;
  /** The declared bracket (1-5). */
  bracket: number | null;
  parent_id: string | null;
  configuration: string | null;
  visibility: Visibility;
  share_token: string | null;
  /** The main deck and every configuration of it, this one included, main deck first. */
  configurations: ConfigurationRef[];
  cards: DeckEntry[];
  validation: { ok: boolean; total: number; color_identity: string; errors: string[]; warnings: string[] };
  ownership: {
    cards: number;
    /** Real copies. */
    owned: number;
    /** Copies covered by proxies beyond the real ones; a proxied card isn't needed. */
    proxies?: number;
    needed: number;
    needed_cost_usd: number;
    needed_without_price: number;
    /** The Scryfall price snapshot behind those prices (YYYY-MM-DD). */
    price_date?: string | null;
  };
  /** Game Changers in the commander and main deck, by name. null while any of those cards has
   *  no flag loaded yet. */
  game_changers: string[] | null;
  /** Date of the Scryfall data behind the flags (YYYY-MM-DD). */
  game_changers_as_of: string | null;
}

/** GET /api/decks/:id/check: Commander Spellbook's check of the current version. */
export interface DeckCheck {
  /** Whether this server runs checks (YAMA_DECK_CHECKS). */
  enabled: boolean;
  version_id: string | null;
  source: string;
  source_url: string;
  /** A try is due now or running; an answer or an error comes within seconds. */
  pending: boolean;
  /** The last try failed and the next one waits until next_try_at. */
  retrying: boolean;
  /** RFC 3339; set while retrying. */
  next_try_at: string | null;
  /** The last try failed. */
  error: string | null;
  /** Tries stopped until someone asks again. */
  gave_up: boolean;
  /** The deck is archived, so it isn't checked. */
  archived: boolean;
  requested_at: string | null;
  /** The newest answer; can be older than a pending re-check. */
  result: DeckCheckResult | null;
}

export interface DeckCheckResult {
  checked_at: string;
  bracket_tag: string;
  bracket_label: string;
  bracket: number | null;
  game_changers: string[];
  mld: string[];
  extra_turns: string[];
  combos: Combo[];
  /** Deck cards Spellbook didn't know. */
  unrecognized: string[];
}

export interface Combo {
  id: string;
  cards: string[];
  templates: string[];
  results: string[];
  /** Spellbook's own count: two pieces at most, the commander left out (it's always there). */
  definitely_two_card: boolean;
  /** Two cards, but one more thing to set up (a prerequisite, or a result that needs context). */
  arguably_two_card: boolean;
  mana_needed: string | null;
  flags: string[];
  bracket_tag: string | null;
}

export interface DeckVersionRow {
  id: string;
  note: string | null;
  created_at: string;
}

export interface DeckVersion extends DeckVersionRow {
  cards: DeckCard[];
}

/** GET /api/decks/:id/online-support: what the rules engine can play of a deck. */
export interface OnlineSupport {
  /** "starting" while the engine loads its card data; "off" when online play is off. */
  state: "ready" | "starting" | "off";
  reason: string | null;
  engine_version: string;
  version_id: string | null;
  support: {
    /** Copies in the commander and main deck. */
    total: number;
    supported: number;
    /** Not in the engine's card data; left out of online games. */
    missing: string[];
    /** Loaded, but some abilities aren't implemented. */
    partial: string[];
    /** Nothing marked unimplemented, but the engine had trouble reading part of the text. */
    uncertain: string[];
  } | null;
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

/** A count with what it's out of: every rate on the Group page travels with its n. */
export interface Average {
  value: number;
  games: number;
}

export interface PlayerStat {
  key: string;
  name: string;
  member_id: string | null;
  games: number;
  wins: number;
  draws: number;
  /** The share they'd win by chance: 1/N averaged over their pods (0 to 1). */
  expected: number;
  streak: { kind: "win" | "no_win"; games: number } | null;
  /** Out of knockout_games: their games with at least one recorded knockout. */
  first_out: number;
  knockout_games: number;
  /** Out of last_out_games: their games with a recorded knockout and a winner. */
  last_out: number;
  last_out_games: number;
  knockouts: number;
  archnemesis: { names: string[]; knockouts: number; of: number } | null;
  fun: number | null;
  fun_ratings: number;
}

export interface PodSeats {
  players: number;
  /** Games of this size with a known first player and a winner. */
  games: number;
  positions: { position: number; wins: number }[];
}

export interface PlaygroupStats {
  games: number;
  players: PlayerStat[];
  commanders: { commander: string; games: number; wins: number; expected: number }[];
  average_turns: Average | null;
  average_minutes: Average | null;
  seats: PodSeats[];
  /** Games with a winner but no recorded first player. */
  seats_unknown: number;
  seat_reference: {
    players: number;
    /** Percent, first player first. */
    rates: number[];
    games: number;
    source: string;
    url: string;
    computed: string;
    show_until_games: number;
  };
  win_conditions: { decided: number; recorded: { condition: string; games: number }[]; not_recorded: number };
  head_to_head: { a: string; a_name: string; b: string; b_name: string; a_over_b: number; b_over_a: number }[];
  /** Games with at least one recorded knockout. */
  knockout_games: number;
  provisional_under: number;
  computed_at: string;
}

export interface GameSeat {
  seat: number;
  member_id: string | null;
  user_id: string | null;
  guest_name: string | null;
  /** Set for a computer seat in an online game ("phase-ai easy"). */
  ai_kind?: string | null;
  deck_label: string | null;
  commander_name: string | null;
  final_life: number | null;
  eliminated_turn: number | null;
  eliminated_by_seat: number | null;
  fun: number | null;
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
  first_seat: number | null;
  win_condition: string | null;
  seats: GameSeat[];
}

/** GET /api/decks/:id/results: finished games per deck version, newest version first. */
export interface DeckResults {
  versions: {
    id: string;
    number: number;
    note: string | null;
    created_at: string;
    current: boolean;
    games: number;
    wins: number;
    losses: number;
    draws: number;
  }[];
  provisional_under: number;
  computed_at: string;
}

/** A Commander precon MTGJSON has a list for (GET /api/calendar). */
export interface PreconSummary {
  file_name: string;
  set_code: string;
  name: string;
  release_date: string | null;
  /** Where MTGJSON got the list, usually Wizards' decklist announcement. */
  source_url: string | null;
  first_seen_at: string;
  /** null until Yama has downloaded the list. */
  commanders: string[] | null;
  list_cards: number | null;
  /** The deck's Collector's Edition, which MTGJSON lists separately: same deck, its own list. */
  variants: PreconVariant[];
}

export interface PreconVariant {
  file_name: string;
  name: string;
}

/** A set from Scryfall's /sets that releases today or later, or one the reader watches. */
export interface CalendarSet {
  code: string;
  name: string;
  set_type: string;
  released_at: string | null;
  /** Cards Scryfall has in the set so far. */
  card_count: number;
  /** The printed set size, when Scryfall knows it. */
  printed_size: number | null;
  parent_set_code: string | null;
  parent_name: string | null;
  digital: boolean;
  scryfall_uri: string | null;
  checked_at: string;
  watched: boolean;
  /** The reader watches the set this one sits under. */
  parent_watched: boolean;
  precons: PreconSummary[];
}

export interface CalendarRun {
  checked_at: string | null;
  source_date: string | null;
  error: string | null;
}

export interface CalendarView {
  today: string;
  sets: CalendarRun;
  precons: CalendarRun;
  auto_refresh: boolean;
  upcoming: CalendarSet[];
}

/** GET /api/calendar/precons/:file_name: an MTGJSON precon's stock list, ready to paste into a new deck. */
export interface PreconList {
  file_name: string;
  name: string;
  set_code: string;
  release_date: string | null;
  source_url: string | null;
  commanders: string[];
  text: string;
  cards: number | null;
  fetched_at: string;
  /** Names Yama's card data doesn't match (new cards, or a name written differently); a deck
   *  made now leaves them out. */
  unknown: string[];
}

/** A market price, or "No price" when there isn't one (never $0). */
export const usd = (v: number | null | undefined) => (v == null ? "No price" : `$${v.toFixed(2)}`);

/** A price snapshot date ("2026-10-19") as people say it: "Oct 19". Read as a local date, not UTC. */
export function shortDate(iso: string | null | undefined): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Where a market price comes from, with its date: "TCGplayer market via Scryfall, Oct 19". */
export function priceSource(date: string | null | undefined): string {
  const d = shortDate(date);
  return d ? `TCGplayer market via Scryfall, ${d}` : "TCGplayer market via Scryfall, date unknown";
}
