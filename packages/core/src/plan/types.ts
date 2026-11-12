// The planner bundle as GET /api/plan/bundle sends it (server/src/plan/bundle.rs), and the import
// report from POST /api/plan/import. docs/plan-format.md is the contract for the fields that come
// from a plan file. Prices: `null` means unknown, never 0.

export type StateName = "stock" | "now" | "after" | "proposal" | "bracket3" | "bracket2";
export type SlotKind = "stock" | "owner" | "bought" | "standin" | "fill" | "print" | "moved" | "optional";
export type LogStatus = "done" | "standin" | "fill" | "waiting" | "print" | "moved" | "waiting-move" | "spare";
export type Decision = "want" | "unsure" | "no";

export interface ItemRef {
  order: string;
  line: number;
}

/** Where an owned card comes from. */
export type Got =
  | { how: "bought"; order: string }
  | { how: "pulled"; product: string; date?: string | null }
  | { how: "deck"; deck: string | null; deck_name?: string | null; origin: string }
  /** A card you own, as a note's build records it (a plan tracking a note's build; `detail` says where). */
  | { how: "owned"; detail?: string | null };

/** One card in a list. Fields a writer left empty are missing. */
export interface Slot {
  name: string;
  qty: number;
  board: "commander" | "main";
  /** The list's own kinds, plus the ones Yama adds when it builds a list on the device. */
  kind?: SlotKind | "proposed" | "bracket";
  set?: string | null;
  num?: string | null;
  scryfall_id?: string | null;
  replaces?: string | null;
  swap?: string | null;
  from_deck?: string | null;
  got?: Got | null;
  order_item?: ItemRef | null;
  print_order?: string | null;
  /** Private free text. */
  note?: string | null;
  /** Private: the writer's own sentence. A fallback for owner-only pages. */
  source?: string | null;
}

export interface LogEntry {
  swap: string | null;
  status: LogStatus;
}

export interface PlanState {
  id: string;
  content_hash: string;
  computed_by: string;
  updated_at: string;
  cards: Slot[];
  log: LogEntry[];
  /** Names Yama's card data doesn't know yet. */
  unresolved: string[];
}

export interface Bag {
  out: string;
  in: string;
  /** Private: the writer's own sentence (it can name a store and an order date). */
  from?: string | null;
  /**
   * Where the swapped-back card comes from, structured, so a shared page can say it without
   * stores or dates. A card from this deck's own precon names this deck with origin "precon".
   * Missing for a basic land, and from writers that don't send it.
   */
  got?: Got | null;
}

export interface Bracket {
  target?: number | null;
  /** Optional: the bracket the deck is kept at in its box, when that isn't `target`. */
  box?: number | null;
  keep_note?: string | null;
  callouts?: string[];
  bags?: Record<string, Bag[]>;
  /** Optional: cards kept for Bracket 4 that are in no build. */
  extras?: string[] | null;
  /** An export extra (not part of the format): the Game Changers in each bracket's build. */
  game_changers?: Record<string, string[]> | null;
}

export interface PlanGroup {
  label: string;
  bracket: number | null;
  note?: string | null;
}

export interface PlanNote {
  kind: "open_question" | "warning" | "note";
  text: string;
  deck?: string | null;
  source?: string | null;
}

export interface OwnerChange {
  out: string;
  in: string;
  note?: string | null;
}

/** A plan deck's Yama deck (`PlanDeck.yama_deck`). */
export interface YamaDeckRef {
  id: string;
  name: string;
  /** The main deck's own label; null reads as Main. */
  configuration: string | null;
  version_id: string | null;
  /** When its current list was saved. */
  list_at: string | null;
  /** Linked to the plan deck, rather than found by name. */
  linked: boolean;
}

export interface PlanDeck {
  key: string;
  name: string;
  source: "import" | "yama";
  status: "active" | "proposals_only" | "archived";
  product: string | null;
  commander: string[];
  color_identity: string | null;
  owner_changes: OwnerChange[];
  bracket: Bracket | null;
  groups: PlanGroup[];
  notes: PlanNote[];
  /** The owner's Yama deck for this physical deck, when linked. */
  deck_id: string | null;
  /**
   * The Yama deck installs are read from: the main deck of the linked deck's group, else the one
   * live main deck with this name. Null when there's none (bundles before 2026-10-28 lack it).
   */
  yama_deck?: YamaDeckRef | null;
  /** A plan made from a note's build: which note, deck and build (bundle shape 8). Null otherwise. */
  note?: { id: string; deck: string; build: string } | null;
  sort: number;
  updated_at: string;
  states: Partial<Record<StateName, PlanState>>;
  /** The deck's plan state and version (server `plan/versions.rs`, bundle shape 9). Missing from older bundles. */
  plan?: DeckPlanState | null;
}

/** waiting: waiting for your OK; empty: no changes yet ("No plan yet"). */
export type PlanStateName = "waiting" | "in_progress" | "done" | "archived" | "empty";

/** Where a plan version came from. */
export type VersionSource =
  | { kind: "plan_file"; app?: string | null; guide_version?: number | null; imported_at?: string | null }
  | { kind: "note"; note: string; title?: string | null }
  | { kind: "yama" }
  | { kind: "before_versions"; note?: string };

/**
 * One waiting change's cut: the card it takes out (your chosen cut, else the plan's), and the card
 * going in for the change in force that already takes it out (server `versions.rs` `Cut`).
 */
export interface PlanCut {
  key: string;
  in: string;
  out: string | null;
  /** The plan's own cut, when its fallback (`later_out`) is used because that one already goes out. */
  instead_of?: string | null;
  gone_for: string | null;
}

/** A deck's plan: one state, the approved version in force, and the version waiting for your OK. */
export interface DeckPlanState {
  state: PlanStateName;
  /** The approved version in force; null before the first approval. */
  version: number | null;
  approved_at: string | null;
  /** Waiting for your OK: the first version (state waiting), or a new one of a plan in progress. */
  next: {
    n: number;
    /** Every change in it (live proposal keys), in plan order. */
    keys: string[];
    /** Changes in it you already said no to: they start skipped. */
    skipped: string[];
    proposed_at: string | null;
    source: VersionSource;
    /** What its changes say: an approval names it, so an edited change is never approved unseen. */
    hash: string;
    /** What each swap in it takes out, for the approval checks (`planProblems`). Absent from older bundles. */
    cuts?: PlanCut[];
  } | null;
  /** Changes in the plan in force (swaps, not stand-ins or optional extras), and how many are in the deck. */
  changes: number;
  installed: number;
  /** Open questions: each needs an answer before you approve. */
  questions: string[];
  /** You archived it (or another plan for the deck replaced it), and why. */
  archived_at: string | null;
  archived_note: string | null;
}

/** One decided version of a deck's plan (newest first in the bundle). */
export interface PlanVersion {
  deck: string;
  deck_name: string;
  n: number;
  /** approved, or kept (you kept the version before it). */
  status: "approved" | "kept";
  changes: { key: string; in?: string; out?: string | null; src?: string; why?: string | null }[];
  skipped: { key: string; in?: string; out?: string | null }[];
  answers: { question: string; answer: string }[];
  source: VersionSource | Record<string, unknown>;
  proposed_at: string | null;
  decided_at: string;
  superseded_at: string | null;
}

export interface Swap {
  key: string;
  deck: string;
  stage: "planned" | "proposed";
  role: "swap" | "standin" | "optional";
  /** Stand-ins: the print swap they hold. */
  parent: string | null;
  src: "buy" | "print" | "owned";
  src_declared: string | null;
  store_label: string | null;
  out: string | null;
  in: string;
  plan_card: string | null;
  /** Advice as recorded, not applied to any list. */
  later_out: string | null;
  after_print: boolean;
  tier: string | null;
  band: string | null;
  group: string | null;
  sort: number;
  game_changer: boolean | null;
  got: Got | null;
  order_item: ItemRef | null;
  print_order: string | null;
  listing: string | null;
  when: string | null;
  advice: string | null;
  why: string | null;
  why_out: string | null;
  note: string | null;
  upgrade: { id: string; status: string } | null;
  /**
   * Installed, read from the plan deck's Yama deck (its current list has the card in and the card
   * out gone; server `plan/installed.rs`). Null or absent when there's no Yama deck to read, or for
   * proposals: then the tick and the plan's record decide.
   */
  deck_installed?: boolean | null;
  /** A stand-in out of the deck because the print it held a slot for is in: done, not waiting. */
  deck_superseded?: boolean;
  retired: boolean;
  retired_at: string | null;
  updated_at: string;
}

export interface OrderItem {
  line: number;
  card: string;
  qty: number;
  listing: string | null;
  set: string | null;
  num: string | null;
  finish: string | null;
  scryfall_id: string | null;
  received: { set: string | null; num: string | null; note: string | null } | null;
  arrived: boolean | null;
  deck: string | null;
  replaces: string | null;
  role: string | null;
  /** Paid (real orders) or cost per card (print orders); null when not recorded. */
  unit_price: number | null;
}

export interface Order {
  key: string;
  kind: "real" | "proxy";
  status: "draft" | "placed" | "received" | "cancelled";
  vendor: string;
  store: string | null;
  order_number: string | null;
  date_ordered: string | null;
  placed_by: string | null;
  date_fulfilled: string | null;
  fulfillment: string | null;
  currency: string;
  subtotal: number | null;
  subtotal_note: string | null;
  shipping: number | null;
  tax: number | null;
  total: number | null;
  card_stock: string | null;
  evidence: string | null;
  issues: unknown[];
  note: string | null;
  origin: string;
  retired: boolean;
  retired_at: string | null;
  items: OrderItem[];
}

export interface Quote {
  swap: string | null;
  card: string;
  kind: "stock_check" | "market_benchmark";
  store: string | null;
  store_label: string | null;
  checked: string;
  result: string | null;
  in_stock: boolean | null;
  price: number | null;
  price_from_text: boolean;
  currency: string;
  printing: string | null;
  set: string | null;
  num: string | null;
  printing_from_text: boolean;
  scryfall_id: string | null;
  variant: string | null;
  url: string | null;
  source: string;
  origin: string;
  /** Copies the listing says it has (store snapshots); missing or null when it doesn't say. */
  qty?: number | null;
  quantity_checked_at?: string;
}

export interface Store {
  key: string;
  name: string;
  short: string | null;
  kind: "local" | "online" | "printer";
  cart_url_template: string | null;
  homepage: string | null;
  location: string | null;
  note: string | null;
  print_tiers: number[] | null;
  sort: number;
  origin: string;
  retired: boolean;
  retired_at: string | null;
}

/**
 * How you feel about going to a store (yours, set in Yama; docs/shopping-design.md): a favourite
 * you want to support is on every trip it has a card for; "maybe" only for cards no other store has.
 */
export type StorePreference = "favorite" | "ok" | "maybe" | "never";

export interface StorePref {
  /** Bundles before migration 0051 say "default" for a favourite; `storePreference` reads both. */
  preference: StorePreference | "default";
  note: string | null;
  updated_at: string;
  /** Your order of how easy a store is to get to: 1 is the easiest. Null: after the ones you ordered. */
  hassle?: number | null;
  /** How much more a card may cost here and still come from this store, in USD; null or 0: only on a tie. */
  premium_usd?: number | null;
}

/** A card on your real-card wishlist (a research scenario with purpose `permanent_real_wishlist`). */
export interface WishItem {
  card: string;
  reason: string | null;
  detail: string | null;
  url: string | null;
  report: string;
  scenario: string;
}

export interface Review {
  decision: Decision | null;
  note: string | null;
  cut: string | null;
  deck: string | null;
  card: string | null;
  /** UTC, whole seconds. */
  at: string;
  origin: "yama" | "import";
  /** The op that set it; null for an answer that came in an import. */
  op_id?: string | null;
  /** That op's place in the inbox; compared with `inputs.pulled_through`. */
  seq?: number | null;
  /** Set on the device only: a tap still in the outbox, or sent but not yet in the bundle. */
  local?: "pending" | "sent";
}

/** An installed tick or a "bought it" mark: a claim, never an order or a list change. */
export interface Mark {
  value: boolean;
  at: string;
  payload: Record<string, unknown>;
  op_id?: string | null;
  seq?: number | null;
  local?: "pending" | "sent";
}

export interface Idea {
  op_id: string;
  seq: number;
  deck_key: string | null;
  in: string;
  out: string | null;
  why: string | null;
  at: string;
  outcome: string | null;
  outcome_at: string | null;
}

export interface PlanCard {
  name: string;
  type_line: string;
  cmc: number;
  color_identity: string;
  layout: string | null;
  image_small: string | null;
  image_art_crop: string | null;
  /** The full card. Missing from bundles saved before it was added. */
  image_normal?: string | null;
  /** Who painted the art crop: credit them wherever it shows. Missing from older saved bundles. */
  artist?: string | null;
  faces: unknown;
}

export interface MarketPrice {
  usd: number;
  printing: string;
  set: string;
  num: string;
  scryfall_id: string;
  date: string;
  source: string;
}

export interface PlanHead {
  import_id: string;
  imported_at: string;
  content_hash: string;
  via: string;
  forced: boolean;
  app: string | null;
  guide_version: number | null;
  guide_date: string | null;
  git_sha: string | null;
  dirty: boolean | null;
  generated_at: string | null;
  warnings: string[];
  export_warnings: ExportWarning[];
}

export interface ExportWarning {
  deck: string | null;
  swap: string | null;
  text: string;
}

export interface GameChangers {
  checked_on: string | null;
  source: string | null;
  names: string[];
}

/** One bought copy as the export's library matched it with the newest collection scan. */
export interface LibraryBought {
  order: string;
  line: number;
  card: string;
  deck: string | null;
  replaces: string | null;
  set: string | null;
  num: string | null;
  arrived: boolean | null;
  /** "ok": scanned as listed; "diff": scanned as another printing; null: not in the scan. */
  scan: "ok" | "diff" | null;
  scanned: { set: string; num: string } | null;
}

/** What the export knows about the owner's cards beyond the plan (commander-decks' library.py). */
export interface PlanLibrary {
  bought?: LibraryBought[];
  scan?: { date?: string | null; file?: string | null } | null;
  precon_lists_fetched?: string | null;
}

export interface PlanBundle {
  rev: string;
  revision: number;
  head: PlanHead | null;
  notes: PlanNote[];
  game_changers: GameChangers | null;
  library: PlanLibrary | null;
  settings: { effective_from: string; rules: Record<string, unknown>; note: string | null; origin: string }[];
  stores: Store[];
  decks: PlanDeck[];
  swaps: Swap[];
  /** Old key → new key. */
  aliases: Record<string, string>;
  orders: Order[];
  quotes: Quote[];
  reviews: Record<string, Review>;
  marks: Record<string, { installed?: Mark; bought?: Mark }>;
  inputs: {
    /** Ops for the export side it hasn't picked up yet. */
    pending_pull: number;
    /** The highest op seq the export side has picked up, and when it last asked. */
    pulled_through: number;
    pulled_at: string | null;
    outcomes: { op_id: string; outcome: string; outcome_at: string | null }[];
    ideas: Idea[];
  };
  /** Card name as the plan writes it → oracle id. */
  names: Record<string, string>;
  unresolved: string[];
  cards: Record<string, PlanCard>;
  /** Cheapest non-foil market price per oracle id; null when there is none. */
  market: Record<string, MarketPrice | null>;
  market_by_printing: Record<string, { usd: number | null; usd_foil: number | null; date: string | null; set: string; num: string; source: string }>;
  printing_ids: Record<string, string>;
  prices_as_of: string | null;
  /** Your store preferences by store key; a store without one is "ok". Missing from older bundles. */
  store_prefs?: Record<string, StorePref>;
  /** Your real-card wishlist, from research. Missing from older bundles. */
  wishlist?: WishItem[];
  /**
   * Store stock snapshots as stock checks: for each card the trip plans for and each store, the
   * newest snapshot that answered for it (`checked` is its fetch time). Missing from older bundles.
   */
  store_quotes?: Quote[];
  /** Your newest store snapshots, newest first (no listings). Missing from older bundles. */
  snapshots?: StoreSnapshot[];
  /** Cards (and sealed products) you added to your shopping list by hand. Missing from older bundles. */
  shopping_wants?: ShoppingWant[];
  /**
   * The sealed products on your list as of the bundle (every store; no pick for those along the
   * way), so the Trip page has them offline. Missing from older bundles.
   */
  sealed?: SealedView;
  /** Every decided plan version, newest first (bundle shape 9). Missing from older bundles. */
  versions?: PlanVersion[];
}

/** A card or sealed product you want, added by hand in Yama or by a change from Claude you applied. */
export interface ShoppingWant {
  id: string;
  kind: "card" | "sealed";
  name: string;
  qty: number;
  /** "need": a reason to go to a store; "along": only from a store already on the trip. */
  priority: "need" | "along";
  /** Your Yama deck it's for, when it is one; `deck_name` is its name, or a label for a deck not in Yama. */
  deck_id: string | null;
  deck_name: string | null;
  why: string | null;
  source: "page" | "assistant";
  added_at: string;
  /** For a sealed product: the precon Yama matched it to by name, when there is one. */
  precon_id?: string | null;
}

/** A store's dated price for a sealed product on your list (server/src/plan/sealed.rs). */
export interface SealedQuote {
  id: string;
  store: string;
  store_name: string;
  preference: StorePreference;
  /** False when a later import retired the store: it's never the best choice. */
  store_live: boolean;
  price: number | null;
  in_stock: boolean;
  checked_on: string;
  note: string | null;
  /** Null when there's no price or no cap. */
  over_cap: boolean | null;
  vs_market_pct: number | null;
  vs_singles_pct: number | null;
}

export interface SealedItem {
  want: string;
  name: string;
  qty: number;
  priority: "need" | "along";
  why: string | null;
  precon: { id: string; name: string; set_name: string | null; released: string | null } | null;
  market: { usd: number | null; price_date: string; source: string; url: string; product_name: string } | null;
  singles: { usd: number | null; priced_copies: number; unpriced_copies: number; oldest_date: string | null; newest_date: string | null; source: string } | null;
  /** Each store's newest price, cheapest first. */
  quotes: SealedQuote[];
  /** The cheapest in stock at a store you're going to (along the way: one the trip visits), within the cap when one is set. */
  best: string | null;
}

/** Your sealed products with store prices, the sealed market and the singles inside. */
export interface SealedView {
  date: string;
  cap_usd: number | null;
  items: SealedItem[];
}

/** One dated read of one store's stock (server/src/plan/stock.rs). */
export interface StoreSnapshot {
  id: string;
  store: string;
  source: "shopify" | "tcgplayer_pro" | "yestcg" | "import";
  /** How many cards it asked about; null: the whole catalog. */
  cards: number | null;
  /** Cards whose answer is unknown (a request failed). */
  failed: number;
  query: string;
  requested_at: string;
  fetched_at: string | null;
  status: "running" | "ok" | "partial" | "error";
  error: string | null;
  listings: number;
  via: "page" | "assistant" | "import";
  raw: boolean;
}

export interface RowCounts {
  added: number;
  changed: number;
  unchanged: number;
  retired: number;
  restored: number;
}

export interface ImportReport {
  import_id: string | null;
  unchanged: boolean;
  dry_run: boolean;
  forced: boolean;
  content_hash: string;
  app: string | null;
  guide_version: number | null;
  guide_date: string | null;
  git_sha: string | null;
  dirty: boolean | null;
  head_before: { content_hash: string | null; guide_version: number | null; git_sha: string | null; imported_at: string | null; revision: number } | null;
  counts: {
    decks: RowCounts;
    swaps: RowCounts;
    orders: RowCounts;
    stores: RowCounts;
    settings: number;
    quotes: number;
    aliases: number;
    states_new: number;
    states_refreshed: number;
  };
  unknown_cards: { name: string; where: string[] }[];
  unknown_printings: { card: string; set: string | null; num: string | null; scryfall_id: string | null; where: string[] }[];
  orphan_answers: { swap_key: string; deck: string | null; card: string | null; decision: string | null; marks: string[] }[];
  reviews: { from_document_applied: number; yama_newer_kept: number };
  existing_decks: { id: string; name: string; folder: string | null }[];
  warnings: string[];
  export_warnings: ExportWarning[];
}
