// Types for the simulation lab's API (server/src/lab.rs and server/src/lab/). Every simulated
// number travels with a label (engine, card data, AI level, games, dates); real-game numbers from
// playgroup.gg carry their own source and date and are never mixed in.

/** What every number from an imported rating run is shown with. */
export interface RunLabel {
  id: string;
  name: string;
  kind: "precon-ratings" | "paired";
  global: boolean;
  engine: string | null;
  card_data: string | null;
  runner: string | null;
  difficulty: string | null;
  games: number;
  /** Decks the run ranks: a rank is out of this many, which can be more than the catalogue's precons. */
  ranked: number;
  pod: number | null;
  level: number | null;
  model: string | null;
  created_at: string;
  analysed_at: string | null;
  imported_at: string;
  warnings: string[];
  /** The run's simulation confidence block; null for a run analysed before it existed. */
  confidence: RunConfidence | null;
}

/**
 * Whether the simulation can judge a deck at all (commander-decks' analysis). "unreliable": real
 * games disagree strongly, or a known engine or AI gap breaks the deck's plan, so its simulated
 * numbers say little. "doubtful": a lesser disagreement, or a commander or many cards the engine
 * only partly implements. "ok": no deck-specific problem is known.
 */
export type ConfidenceLevel = "ok" | "doubtful" | "unreliable";

export interface Confidence {
  level: ConfidenceLevel;
  /** The analysis's reasons, in its own words. */
  reasons: string[];
}

export interface RunConfidence {
  /** How the levels are decided, in the analysis's words (it names its files). */
  method: string | null;
  /** The run whose comparison with real games stands in for decks this run doesn't compare itself. */
  reference_run: string | null;
  counts: { ok: number; doubtful: number; unreliable: number };
}

export interface Rating {
  deck_ref: string;
  /** 1 = the geometric mean of the run's field. */
  strength: number | null;
  lo: number | null;
  hi: number | null;
  win_rate: number | null;
  wr_lo: number | null;
  wr_hi: number | null;
  games: number;
  avg_place: number | null;
  rank: number | null;
  rank_lo: number | null;
  rank_hi: number | null;
  /** The model's chance of winning a 4-player pod of the field. */
  p4_field: number | null;
  p4_lo: number | null;
  p4_hi: number | null;
  flags: string[];
  confidence: Confidence | null;
}

export interface Art {
  url: string;
  artist: string | null;
  card: string;
}

/** Real games, from playgroup.gg. */
export interface Playgroup {
  tier?: string | null;
  win_rate_4p?: number | null;
  games?: number | null;
  rank?: number | null;
  of?: number | null;
  url?: string | null;
  source?: string | null;
  fetched?: string | null;
  method?: string | null;
}

export interface PreconItem {
  id: string;
  lab_id: string;
  name: string;
  set_code: string;
  set_name: string | null;
  released: string | null;
  commanders: string[];
  color_identity: string;
  same_list_as: string | null;
  card_count: number;
  art: Art | null;
  playgroup: Playgroup | null;
  rating: Rating | null;
}

export interface PreconList {
  run: RunLabel | null;
  precons: PreconItem[];
}

export interface PreconCard {
  name: string;
  oracle_id: string | null;
  qty: number;
  board: "commander" | "main" | "side";
  type_line: string | null;
  mana_cost: string | null;
  cmc: number | null;
  image_small: string | null;
  image_normal: string | null;
}

export interface Matchup {
  id: string;
  lab_id: string;
  name: string;
  /** Chance this precon beats that one in a neutral 1v1, implied by the model. */
  p: number;
}

export interface PreconDetail {
  run: RunLabel | null;
  precon: PreconItem;
  notes: string[];
  engine_support: unknown;
  source: string;
  imported_at: string;
  cards: PreconCard[];
  matchups: { note: string | null; rows: Matchup[] } | null;
}

export interface BatchVariant {
  id: string;
  name: string;
  games: number;
  wins: number;
  win_rate: number | null;
  wilson: [number, number] | null;
  avg_place: number | null;
  unscored: number;
  failed: number;
  /** From the list's rating in the same run. */
  confidence: Confidence | null;
}

export interface Verdict {
  kind: "better" | "worse" | "unclear";
  text: string;
  final: boolean;
}

export interface BatchComparison {
  base: string;
  base_name: string;
  variant: string;
  variant_name: string;
  pods: number;
  delta_win_rate: number | null;
  delta_ci: [number, number] | null;
  delta_avg_place: number | null;
  delta_avg_place_ci: [number, number] | null;
  variant_only: number;
  base_only: number;
  verdict: Verdict;
}

export interface BatchPaired {
  templates: number | null;
  variants: BatchVariant[];
  comparisons: BatchComparison[];
}

export interface RunListItem extends RunLabel {
  decks: number;
  paired: BatchPaired | null;
}

export interface RunDetail {
  run: RunLabel;
  ratings: (Rating & { precon_id: string | null; name: string })[];
  summary: Record<string, unknown>;
  paired: BatchPaired | null;
}

// ── experiments ("Try a change") ─────────────────────────────────────────────

export type ExperimentStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface LabCard {
  name: string;
  oracle_id?: string;
  qty: number;
  commander?: boolean;
}

export interface Build {
  engine: string;
  card_data: string;
  runner: string;
  games: number;
}

export interface SimLabel {
  simulated: boolean;
  engine: string;
  card_data: string;
  runner: string;
  builds: Build[];
  difficulty: string;
  games: number;
  pod: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface ListStats {
  games: number;
  wins: number;
  win_rate: number | null;
  wilson: [number, number] | null;
  avg_place: number | null;
  ends: Record<string, number>;
  pending: number;
}

export interface Summary {
  level: number;
  pods: number;
  base: ListStats;
  variant: ListStats;
  paired: {
    pods: number;
    both_won: number;
    variant_only: number;
    base_only: number;
    neither: number;
    delta_win_rate: number | null;
    delta_ci: [number, number] | null;
    delta_avg_place: number | null;
    delta_avg_place_ci: [number, number] | null;
    split_builds: number;
  };
  unscored: { time_cap: number; panic: number; error: number; total: number };
  no_winner: { draw: number; turn_cap: number; action_cap: number; total: number };
  builds: Build[];
  verdict: Verdict;
  method: string;
  /** Head to head only. */
  versus?: Versus | null;
}

/** One deck in a head-to-head run. */
export interface Entrant {
  id: string;
  label: string;
  games: number;
  wins: number;
  win_rate: number | null;
  wilson: [number, number] | null;
  avg_place: number | null;
  /** Games it went first in. */
  first: number;
}

/** Two decks that sat in the same scored games: how often each finished ahead (ties apart). */
export interface Meeting {
  a: number;
  b: number;
  games: number;
  a_ahead: number;
  b_ahead: number;
  ties: number;
  a_share: number | null;
  a_share_ci: [number, number] | null;
}

export interface Versus {
  pod: number;
  games: number;
  pending: number;
  entrants: Entrant[];
  meetings: Meeting[];
  filler_wins: number;
  /** Every player's turn counted; rounds are about avg_turns / pod. */
  avg_turns: number | null;
}

/** What a run compares: a change, two decks, one deck as it is, or decks head to head. */
export type ExperimentMode = "change" | "compare" | "solo" | "versus";

export interface ListDisplay {
  label: string;
  commanders: string[];
  color_identity: string;
  art: Art | null;
  source: { kind: string; id?: string; version?: string };
}

export interface FieldInfo {
  kind: string;
  n: number | null;
  ids: string[];
  label: string;
  run: { id: string; name: string } | null;
  decks: number;
}

export interface ExperimentItem {
  id: string;
  name: string;
  status: ExperimentStatus;
  error: string | null;
  label: SimLabel;
  progress: { done: number; total: number; eta_seconds: number | null; games_ahead: number | null };
  /** Missing on runs from before the modes: a change. */
  mode?: ExperimentMode;
  base: ListDisplay | null;
  variant: { label: string; added: LabCard[]; cut: LabCard[] } | null;
  /** compare: the two decks; versus: every deck. */
  entrants?: ListDisplay[];
  field: FieldInfo | null;
  summary: Summary | null;
}

export interface LabList {
  id: string;
  label: string;
  source: Record<string, unknown>;
  sha256: string;
  cards: LabCard[];
}

export interface ExperimentDetail extends ExperimentItem {
  lists: { base: LabList; variant: LabList | null; entrants?: LabList[] };
  opponents: { id: string; label: string; source: Record<string, unknown>; sha256: string; pods: number }[];
  warnings: string[];
  /** A u64: past 2^53 a JavaScript number loses digits, so it's never shown. */
  seed: number;
  limits: { max_turns: number; max_actions: number; max_seconds: number; turn_action_cap: number };
}

export interface GameView {
  game: string;
  end: string;
  scored: boolean;
  won: boolean;
  place: number | null;
  turns: number;
  seconds: number;
  error: string | null;
  finished_at: string | null;
}

export interface PodView {
  pod: number;
  seat: number;
  seats: (string | null)[];
  base: GameView | null;
  variant: GameView | null;
  /** Head to head: the row's one game, every seat named in `seats`. */
  game?: VersusGame | null;
}

export interface VersusGame {
  game: string;
  end: string;
  scored: boolean;
  winner: string | null;
  places: (number | null)[];
  turns: number;
  seconds: number;
  error: string | null;
  finished_at: string | null;
}

export interface Pace {
  available: boolean;
  message: string | null;
  threads: number;
  /**
   * Lab time for a new experiment of each size, after your own unfinished games: whole minutes
   * for admins, rounded up to 5 minutes for anyone else. Empty with nothing to go on.
   */
  estimates: { games: number; seconds: number }[];
  /** Admins only (null for anyone else, since the pace counts everyone's games). */
  seconds_per_game: number | null;
  basis: "recent" | "average" | null;
  sample: number | null;
  your_pending: number;
  /** Game counts this account may choose (missing on older servers: 100, 200 and 400). */
  game_choices?: number[];
  /** The smaller allowance of an account that joined without an invite; null for anyone else. */
  allowance?: Allowance | null;
}

export interface Allowance {
  /** Games in one experiment. */
  games: number;
  /** Experiments at once. */
  at_a_time: number;
  games_per_day: number;
  /** Games asked for in the last 24 hours. */
  used_today: number;
}

export type BaseChoice = { kind: "deck"; id: string } | { kind: "precon"; id: string } | { kind: "list"; text: string; label?: string };

export type FieldChoice =
  | { kind: "precons_top"; n: number }
  | { kind: "precons_all" }
  | { kind: "precons_near"; n: number; ids: string[] }
  | { kind: "my_decks"; ids: string[] };

export interface NewExperiment {
  name?: string;
  op_id: string;
  mode?: ExperimentMode;
  /** change and solo: the list; compare: the first deck. */
  base?: BaseChoice;
  /** change only. */
  variant?: { add: string[]; cut: string[] };
  /** compare: the second deck. */
  other?: BaseChoice;
  /** versus: 2 to 4 decks. */
  entrants?: BaseChoice[];
  /** versus: 4 (precons fill empty seats) or 2 (1v1). */
  pod?: number;
  /** Needed by every mode but a versus with no empty seat. */
  field?: FieldChoice;
  games: number;
  difficulty: string;
}

/** What "Try again" carries to the Try a change page. */
export interface TryPrefill {
  base: BaseChoice;
  add: string[];
  cut: string[];
  /** Which adds replace which cuts, when known. */
  pairs?: [string, string][];
  field?: FieldChoice;
  games?: number;
  difficulty?: string;
}

/** What "Edit and run again" carries to the Compare page. */
export interface ComparePrefill {
  mode: "compare" | "versus";
  decks: BaseChoice[];
  pod?: number;
  field?: FieldChoice;
  games?: number;
  difficulty?: string;
}
