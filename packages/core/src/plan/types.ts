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
  | { how: "deck"; deck: string | null; deck_name?: string | null; origin: string };

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
  keep_note?: string | null;
  callouts?: string[];
  bags?: Record<string, Bag[]>;
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
  sort: number;
  updated_at: string;
  states: Partial<Record<StateName, PlanState>>;
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

export interface Review {
  decision: Decision | null;
  note: string | null;
  cut: string | null;
  deck: string | null;
  card: string | null;
  /** UTC. */
  at: string;
  origin: "yama" | "import";
}

export interface PlanCard {
  name: string;
  type_line: string;
  cmc: number;
  color_identity: string;
  layout: string | null;
  image_small: string | null;
  image_art_crop: string | null;
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

export interface PlanBundle {
  rev: string;
  revision: number;
  head: PlanHead | null;
  notes: PlanNote[];
  game_changers: GameChangers | null;
  library: unknown;
  settings: { effective_from: string; rules: Record<string, unknown>; note: string | null; origin: string }[];
  stores: Store[];
  decks: PlanDeck[];
  swaps: Swap[];
  /** Old key → new key. */
  aliases: Record<string, string>;
  orders: Order[];
  quotes: Quote[];
  reviews: Record<string, Review>;
  marks: Record<string, unknown>;
  inputs: { pending_pull: number; outcomes: { op_id: string; outcome: string; outcome_at: string | null }[] };
  /** Card name as the plan writes it → oracle id. */
  names: Record<string, string>;
  unresolved: string[];
  cards: Record<string, PlanCard>;
  /** Cheapest non-foil market price per oracle id; null when there is none. */
  market: Record<string, MarketPrice | null>;
  market_by_printing: Record<string, { usd: number | null; usd_foil: number | null; date: string | null; set: string; num: string; source: string }>;
  printing_ids: Record<string, string>;
  prices_as_of: string | null;
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
