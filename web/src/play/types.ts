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

export interface Decision {
  revision: number;
  prompt: string;
  options: OptionView[];
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
  color_identity: string;
  ready: boolean;
}

/** What the server sends over the play socket. */
export type ServerMessage =
  | { type: "view"; you: number | null; seats: SeatInfo[]; images: Record<string, string>; view: View }
  | { type: "error"; message: string };

export interface OnlineGame {
  id: string;
  code: string;
  status: "lobby" | "in_progress" | "finished" | "abandoned";
  host: string;
  seats: SeatInfo[];
  you: number | null;
  created_at: string;
  missing_cards: Record<string, string[]>;
}
