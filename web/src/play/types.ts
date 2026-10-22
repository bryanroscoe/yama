// Mirrors play/src/lib.rs (View and friends) plus the server's lobby payloads.

export interface CardView {
  id: number;
  name: string;
  controller: number;
  owner: number;
  tapped: boolean;
  power: number | null;
  toughness: number | null;
  loyalty: number | null;
  damage: number;
  counters: Record<string, number>;
  types: string[];
  attached_to: unknown;
  /** Declared as an attacker in the current combat (older servers leave it out). */
  attacking?: boolean;
  /** The seat it attacks (a planeswalker's or battle's controller, for those). */
  attacks?: number;
  /** Declared as a blocker in the current combat. */
  blocking?: boolean;
  /** A commander (never set on a face-down card). */
  commander?: boolean;
  /** Commander tax: 2 for each earlier cast from the command zone. */
  tax?: number;
  /** A creature that can't attack or tap yet (haste counted). */
  sick?: boolean;
}

export interface PlayerView {
  seat: number;
  life: number;
  poison: number;
  hand: number;
  library: number;
  graveyard: CardView[];
  eliminated: boolean;
  commander_damage: Record<string, number>;
}

export interface OptionView {
  index: number;
  label: string;
  object: number | null;
}

/** An attack target: a player by seat, or a planeswalker or battle by object id. */
export type AttackAt = { kind: "player"; seat: number } | { kind: "planeswalker"; id: number } | { kind: "battle"; id: number };

export interface Decision {
  revision: number;
  prompt: string;
  options: OptionView[];
  /** While declaring attackers: who may attack and whom (newer servers). */
  attack?: { attackers: { id: number; targets: AttackAt[] }[] };
  /** While declaring blockers: who may block and which attackers. */
  block?: { blockers: { id: number; attackers: number[] }[] };
}

export interface View {
  revision: number;
  turn: number;
  active: number;
  phase: string;
  waiting_on: number[];
  waiting: string;
  players: PlayerView[];
  battlefield: CardView[];
  stack: { name: string; controller: number }[];
  command_zone: CardView[];
  exile: CardView[];
  hand: CardView[];
  /** Every hand by seat, when a watched all-AI game shows hands face up. */
  hands?: Record<string, CardView[]>;
  decision: Decision | null;
  log: { turn: number; text: string }[];
  over: boolean;
  winner: number | null;
}

export interface SeatInfo {
  seat: number;
  name: string;
  ai: string | null;
  deck_name: string | null;
  /** The deck's commander ("A and B" for partners), for its art. */
  commander?: string | null;
  /** The commander's art crop and its artist (newer servers send them). */
  commander_art?: string | null;
  commander_artist?: string | null;
  color_identity: string;
  ready: boolean;
  /** The bracket the deck's owner declared. */
  bracket?: number | null;
  /** Commander Spellbook's estimate for the seated deck version. */
  estimate?: import("../api").Estimated | null;
}

export interface CardMeta {
  oracle_id: string;
  image: string | null;
  back_image: string | null;
  /** Art crop for square battlefield tiles, and its artist. */
  art?: string | null;
  artist?: string | null;
  mana_cost: string | null;
  type_line: string;
  oracle_text: string;
}

export type Speed = "1x" | "2x" | "4x" | "end";

/** Where a watched all-AI game stands (server/src/watch.rs, Status). */
export interface WatchStatus {
  /** Playing, or paused by the viewer. */
  playing: boolean;
  speed: Speed;
  /** Hands face up. */
  reveal: boolean;
  /** Paused because nobody has been watching. */
  idle: boolean;
  actions: number;
  /** Why it ended before anyone won: a limit, an error, or the viewer stopping it. */
  stopped: string | null;
  finished: boolean;
}

/** What the server sends over the play socket (and the watch socket, which adds `watch`). */
export type ServerMessage =
  | { type: "view"; you: number | null; seats: SeatInfo[]; cards: Record<string, CardMeta>; view: View; watch?: WatchStatus }
  | { type: "error"; message: string };

export interface OnlineGame {
  id: string;
  code: string;
  status: "lobby" | "in_progress" | "finished" | "abandoned";
  host: string;
  seats: SeatInfo[];
  you: number | null;
  created_at: string;
  /** When the game last changed (newer servers). */
  updated_at?: string;
  /** The winning seat of a finished game. */
  winner?: number | null;
  turns?: number | null;
  /** The playgroup whose stats it counts toward. */
  playgroup?: string | null;
  missing_cards: Record<string, string[]>;
}
