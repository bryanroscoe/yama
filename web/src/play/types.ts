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
  /** Out because they conceded (left the game), rather than lost (newer servers). */
  conceded?: boolean;
  commander_damage: Record<string, number>;
}

/** What an option does (play/src/lib.rs, OptionKind). `pay_rest` is the engine's pass while you pay mana by hand. */
export type OptionKind = "pass" | "pay_rest" | "cancel" | "land" | "spell" | "ability" | "keep" | "mulligan" | "attack" | "block" | "target" | "agree" | "refuse" | "other";

/** A target on an option or a decision: a card by object id, or a player by seat. */
export type TargetView = { kind: "object"; id: number } | { kind: "player"; seat: number };

export interface OptionView {
  index: number;
  label: string;
  /** What the option does (newer servers); older ones are read by their labels. */
  kind?: OptionKind;
  object: number | null;
  /** An activated ability's index on its card, so a planeswalker's abilities stay apart. */
  ability?: number;
  /** A target choice: exactly which card or player it targets (newer servers). */
  target?: TargetView;
}

/** The opening hand: the sizes the keep and mulligan buttons name. */
export interface MulliganView {
  /** Cards you keep if you keep now. */
  keep: number;
  /** Cards you'd keep after one more mulligan. */
  next_keep: number;
  mulligans: number;
  /** The next mulligan is free. */
  free: boolean;
}

/** An attack target: a player by seat, or a planeswalker or battle by object id. */
export type AttackAt = { kind: "player"; seat: number } | { kind: "planeswalker"; id: number } | { kind: "battle"; id: number };

/** The widget shape a decision takes (design/README.md, "Generic decision widgets"). */
export type DecisionKind = "yesno" | "pick" | "order" | "pair" | "split" | "number" | "text";

/** Which `act` answers a decision (play/src/act.rs, Answer). */
export type AnswerKind =
  | "select_cards"
  | "order_triggers"
  | "select_modes"
  | "choose_x"
  | "choose_target"
  | "pay_unless_cost"
  | "decide_optional_effect"
  | "choose_option"
  | "choose_replacement"
  | "assign_combat_damage"
  | "distribute_among"
  | "choose_pair";

/** The card asking; the server adds its art, image and artist. */
export interface DecisionSource {
  id: number;
  name: string;
  controller: number;
  art?: string | null;
  image?: string | null;
  artist?: string | null;
}

/** One option. `id` is what the answer names: an object id ("123"), a player ("p2"), an index ("0") or a word. */
export interface DecisionOption {
  id: string;
  name: string;
  /** A trigger's own text, or a replacement's. */
  text?: string;
  img?: string | null;
  art?: string | null;
  artist?: string | null;
  /** "hand", "library", "battlefield"…, or "player". */
  zone?: string;
  controller?: number;
  eligible: boolean;
  toughness?: number;
  /** Combat damage that counts as lethal for it. */
  lethal?: number;
}

/**
 * The seat's decision in the shape the design's generic widgets read (play/src/act.rs, Pending),
 * plus Yama's own fields for building the answer (`answer` onward).
 */
export interface Pending {
  kind: DecisionKind;
  source?: DecisionSource;
  /** The engine's question. */
  prompt: string;
  /** The source's Oracle text. */
  oracle?: string;
  options: DecisionOption[];
  min: number;
  max: number;
  upTo: boolean;
  /** The engine's own answer: ids for a pick, ids in order, amounts by id for a split, a number. */
  defaultAnswer?: string[] | Record<string, number> | number | null;
  yesLabel?: string;
  noLabel?: string;
  remember?: "engine" | "yama";
  /** The engine can remember the answer for every copy of the card, not only this one. */
  rememberSameCard?: boolean;
  zone?: string;
  filter?: string;
  destination?: "top" | "bottom";
  total?: number;
  perOptionMin?: number;
  freeEntry?: boolean;
  choiceType?: string;
  answer: AnswerKind;
  /** scry, surveil, search, dig, discard, bottom, choose, target, modes, replacement, triggers, x, may, pay, name, damage or divide. */
  purpose: string;
  /** The order picked is the order they end up in (the first is on top). */
  ordered?: boolean;
  /** A mode may be chosen more than once. */
  repeat?: boolean;
  /** The total cost for each X. */
  previews?: [number, string][];
  /** Combat damage may all be assigned as though the attacker weren't blocked. */
  unblocked?: boolean;
  /** What a split divides; damage gets a lethal hint. */
  unit?: "damage" | "counters" | "life";
}

/** An answer sent with `{type: "act"}` (play/src/act.rs, Act). */
export type Act =
  | { kind: "select_cards"; cards: number[] }
  | { kind: "order_triggers"; order: number[] }
  | { kind: "select_modes"; indices: number[] }
  | { kind: "choose_x"; value: number }
  | { kind: "choose_target"; target: TargetView | null }
  | { kind: "cancel_cast" }
  | { kind: "pay_unless_cost"; pay: boolean }
  | { kind: "decide_optional_effect"; accept: boolean }
  | { kind: "choose_option"; choice: string }
  | { kind: "choose_replacement"; index: number }
  | { kind: "assign_combat_damage"; assignments: [number, number][]; trample: number; controller: number; unblocked?: boolean }
  | { kind: "distribute_among"; distribution: [TargetView, number][] }
  /** A "may" answered and remembered by the engine for this card (or, with same_card, every copy). */
  | { kind: "decide_optional_effect_and_remember"; accept: boolean; same_card?: boolean }
  /** Replacement effects chosen and remembered: the whole order by index, or a "you may" branch (0 yes, 1 no). */
  | { kind: "choose_replacement_and_remember"; choice: { type: "order"; order: number[] } | { type: "optional"; index: number } }
  /** Soulbond: the creature to pair with, or none. */
  | { kind: "choose_pair"; partner: number | null }
  // A seat's own settings (any time) and Resolve all (play/src/turns.rs). Selectors and targets
  // are the engine's, echoed back as the view lists them.
  | { kind: "set_may_trigger_auto_choice"; change: { op: "remove"; selector: unknown } | { op: "clear_all" } }
  | { kind: "set_replacement_auto_choice"; id: string | null }
  | { kind: "set_priority_yield"; change: { op: "add"; source: number; every: boolean } | { op: "remove"; target: unknown } | { op: "clear_all" } }
  | { kind: "reorder_hand"; order: number[] }
  | { kind: "resolve_all" };

/** A way to pass more than once (GPriority): until something happens, the rest of this turn, end your turn, to your next turn. */
export type PassMode = "until" | "turn" | "end" | "mine";

/** Stops in the server's shape: phase's step names on your turns and on others'. */
export interface ServerStops {
  own: string[];
  others: string[];
}

/** A trigger Yama passes for you while it's on top of the stack (GSettings). */
export interface YieldView {
  id: string;
  name: string;
  text?: string;
  controller?: number;
  /** The card and its copies (tokens and copies of it), not only this object. */
  every: boolean;
  /** What to send to remove it. */
  remove: Act;
}

/** An answer the engine gives for you from memory (GSettings, GLog). */
export interface AnswerView {
  id: string;
  kind: "may" | "replacement";
  name: string;
  answer: string;
  /** This card only, or every copy of it. */
  scope: "card" | "copies";
  /** What to send to turn it off. */
  forget: Act;
}

/** Your own turn controls and remembered answers, as the game holds them (play/src/turns.rs, TurnsView). */
export interface TurnsView {
  full_control: boolean;
  /** Your own stops; null for the usual ones. */
  stops: ServerStops | null;
  passing?: PassMode;
  hold?: boolean;
  yields: YieldView[];
  answers: AnswerView[];
}

/** Someone asked to resolve the whole stack: who, and who has agreed (GTogether). */
export interface ResolveAllView {
  asked_by: number;
  seats: { seat: number; agreed: boolean; deciding: boolean }[];
}

/** One item on the stack. Newer servers say which entry and source it is, and whether it's a trigger. */
export interface StackItem {
  id?: number;
  source?: number;
  name: string;
  controller: number;
  trigger?: boolean;
  /** A trigger's own words. */
  text?: string;
  /** You yielded to it: Yama passes for you while it's on top. */
  yielded?: boolean;
}

/** A log line. `seat` lines are only yours (an answer Yama gave for you); `auto` names that answer. */
export interface LogLine {
  turn: number;
  text: string;
  seat?: number;
  auto?: string;
}

export interface Decision {
  /** When this seat's decision was issued; it holds while other seats act and it doesn't change. */
  revision: number;
  prompt: string;
  options: OptionView[];
  /** Keeping or mulliganing: the hand sizes (newer servers). */
  mulligan?: MulliganView;
  /** The decision in the generic widgets' shape, when `act` answers it (newer servers). */
  pending?: Pending;
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
  stack: StackItem[];
  command_zone: CardView[];
  exile: CardView[];
  hand: CardView[];
  /** Every hand by seat, when a watched all-AI game shows hands face up. */
  hands?: Record<string, CardView[]>;
  decision: Decision | null;
  log: LogLine[];
  over: boolean;
  winner: number | null;
  /** Your own turn controls (newer servers, people only). */
  turns?: TurnsView;
  /** Resolve all is being asked (newer servers). */
  resolve_all?: ResolveAllView;
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
  | { type: "error"; message: string }
  /** Sent on connecting: whether your account has saved turn controls yet. */
  | { type: "prefs"; saved: boolean };

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
