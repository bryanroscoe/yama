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
  mana_colors?: string[];
  imprinted?: string[];
  /** Declared as an attacker in the current combat (older servers leave it out). */
  attacking?: boolean;
  /** The seat it attacks (a planeswalker's or battle's controller, for those). */
  attacks?: number;
  /** The planeswalker or battle it attacks, when it attacks one. */
  attacks_card?: number;
  /** An attacker that was blocked (it stays blocked if its blockers leave). */
  blocked?: boolean;
  /** Declared as a blocker in the current combat. */
  blocking?: boolean;
  /** The attackers it blocks (newer servers). */
  blocks?: number[];
  /** Its keyword abilities as the engine badges them on the battlefield: "Flying", "Deathtouch". */
  keywords?: string[];
  /** A commander (never set on a face-down card). */
  commander?: boolean;
  /** Commander tax: 2 for each earlier cast from the command zone. */
  tax?: number;
  /** A creature that can't attack or tap yet (haste counted). */
  sick?: boolean;
  /** Face down; its name is "Face-down card" unless you may look at it (newer servers). */
  face_down?: boolean;
  /** The card under a face-down card, sent only to a seat that may look at it (its controller). */
  under?: string;
  /** How a card in a graveyard, exile or the command zone got there, as you saw it. */
  came?: Came;
  /** Auras, Equipment and other permanents attached to it. */
  attachments?: number[];
  /** A two-faced card showing its back face. */
  transformed?: boolean;
  /** Its power and toughness before anything changed them, when something has. */
  base_power?: number;
  base_toughness?: number;
  /** The turn it entered the battlefield. */
  entered?: number;
}

// ── what happened (play/src/feed.rs) ──────────────────────────────────────

/** A card as you may know it: its id while it's where you can see it, its name unless hidden. */
export interface Seen {
  id?: number;
  name?: string;
  face_down?: boolean;
}

/** What something was done to: a player or a card. */
export type Hit = { kind: "player"; seat: number } | { kind: "card"; card: Seen };

/** The engine's reason for a move between zones, where it gives one. */
export type How = "moved" | "destroyed" | "sacrificed" | "discarded" | "milled" | "countered" | "left";

export type ZoneWord = "library" | "hand" | "battlefield" | "graveyard" | "stack" | "exile" | "command";

/** How a card got where it is. */
export interface Came {
  turn: number;
  how: How;
  from?: ZoneWord;
}

/** One thing that happened, as you may know it (play/src/feed.rs, Happening). */
export type Happening = { seq: number; turn: number; active: number } & (
  | { kind: "turn"; seat: number }
  | { kind: "cast"; seat: number; card: Seen }
  | { kind: "land"; seat: number; card: Seen }
  | { kind: "activated"; seat: number; card: Seen }
  | { kind: "moved"; card: Seen; owner: number; from?: ZoneWord; to: ZoneWord; how: How; by?: Seen; creature?: boolean }
  | { kind: "damage"; source: Seen; by?: number; to: Hit; amount: number; combat?: boolean; life?: [number, number] }
  | { kind: "life"; seat: number; delta: number; total?: number }
  | { kind: "poison"; seat: number; delta: number }
  | { kind: "attack"; seat: number; attacks: { card: Seen; at: Hit }[] }
  | { kind: "block"; seat: number; blocks: [Seen, Seen][] }
  | { kind: "token"; seat: number; card: Seen; count: number }
  | { kind: "counters"; card: Seen; counter: string; delta: number }
  | { kind: "control"; card: Seen; from: number; to: number }
  | { kind: "transformed"; card: Seen }
  | { kind: "revealed"; seat: number; cards: Seen[] }
  | { kind: "looked"; seat: number; whose?: number; cards: Seen[] }
  | { kind: "drew"; seat: number; count: number; cards: Seen[] }
  /** An answer given for you from memory: the engine's yes or no to a "may", or what Yama did (`did`). */
  | { kind: "automatic"; seat: number; name: string; accept: boolean; answer: string; did?: string }
  | { kind: "out"; seat: number }
  | { kind: "over"; winner?: number }
);

/** Why a player is out. All but a concession are read from the board as they went out. */
export type Why =
  | { kind: "conceded" }
  | { kind: "commander"; name: string; seat: number; damage: number }
  | { kind: "poison"; count: number }
  | { kind: "life"; life: number }
  | { kind: "library" }
  | { kind: "unknown" };

/** A player knocked out, in the order they went out. */
export interface Out {
  seat: number;
  turn: number;
  life: number;
  why: Why;
  /** The cause is Yama's reading of the board, not something the engine stated. */
  inferred: boolean;
  /** Players with the same batch went out at the same moment. */
  batch: number;
}

export interface SeatStats {
  seat: number;
  spells: number;
  lands: number;
  drew: number;
  /** Damage this seat's sources dealt to players. */
  damage: number;
  /** Combat damage this seat's commanders dealt to players. */
  commander_damage: number;
}

export interface Stats {
  turns: number;
  seats: SeatStats[];
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
  /** The companion they revealed before the game (public), and whether it's been put into their hand. */
  companion?: { name: string; used?: boolean };
}

/** What an option does (play/src/lib.rs, OptionKind). `pay_rest` is the engine's pass while you pay mana by hand. */
export type OptionKind =
  | "pass"
  | "pay_rest"
  | "cancel"
  | "land"
  | "spell"
  | "ability"
  | "keep"
  | "mulligan"
  | "attack"
  | "block"
  | "target"
  | "agree"
  | "refuse"
  // Special actions (play/src/rare.rs), sent with their own `act`.
  | "ninjutsu"
  | "face_up"
  | "foretell"
  | "companion"
  | "serum_powder"
  | "other";

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
  /** A target choice: exactly which card or player it targets (newer servers); ninjutsu's attacker to return. */
  target?: TargetView;
  /** What a special action costs, printed ("{1}{U}"). */
  cost?: string;
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
  | "choose_pair"
  | "retarget_spell"
  | "pay_combat_tax"
  | "choose_exert"
  | "choose_enlist"
  | "crew_vehicle"
  | "saddle_mount"
  // Paying (play/src/pay.rs): the sacrificial-source question, mana colours, Phyrexian mana and extra costs.
  | "tap_mana"
  | "choose_mana_color"
  | "pay_mana_ability_mana"
  | "pay_phyrexian"
  | "decide_optional_cost"
  | "choose_cost_branch"
  // Ways to cast, permanents and counters (play/src/ways.rs).
  | "cast_offer"
  | "choose_adventure_face"
  | "choose_modal_face"
  | "choose_alternative_cast"
  | "choose_casting_variant"
  | "choose_mutate_side"
  | "choose_legend"
  | "choose_ring_bearer"
  | "equip"
  | "select_targets"
  | "move_counters"
  | "remove_counters"
  | "remove_counter_cost"
  // Everyone takes part, and choosing a player (play/src/together.rs).
  | "submit_vote_candidate"
  | "submit_pile_partition"
  | "choose_pile"
  | "choose_branch"
  | "select_coin_flips"
  | "select_die_rolls"
  | "choose_top_or_bottom"
  | "redistribute_life"
  | "choose_player"
  // The library (play/src/library.rs).
  | "learn"
  // The rarer cards and rules (play/src/rare.rs).
  | "declare_companion"
  | "choose_meld_pair"
  | "choose_entry_attack_target"
  | "cipher_encode"
  | "choose_dungeon"
  | "choose_dungeon_room"
  | "time_travel"
  | "propose_shortcut"
  | "respond_to_shortcut"
  // A special action at priority, when the board puts its pick together itself (ninjutsu).
  | "ninjutsu";

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
  /** What it adds toward the decision's `need` when picked (crew or saddle power). */
  power?: number;
  /** What choosing it costs, printed: a kicker row ("{4}{R}"), the mana that pays a Phyrexian symbol. */
  cost?: string;
  /** The counters on it now, in words with how many: [["+1/+1", 2]] (proliferate, empower Jace, counters). */
  counters?: [string, number][];
  /** The most a split may give it. */
  cap?: number;
  /** The counter kind it stands for, by the engine's key ("P1P1"); moving counters shares one cap per kind. A pile's card: "a" or "b". */
  group?: string;
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
  /**
   * scry, surveil, search, dig, discard, bottom, choose, target, modes, replacement, triggers, x,
   * may, pay, name, damage or divide; ways to cast: cascade, discover, ripple, madness, miracle,
   * miracle_reveal, adventure, face, alt_cost, variant, mutate; permanents: legend, clone, equip,
   * ring, empower, host, populate, explore; counters: proliferate, move_counters,
   * remove_counters, counter_cost; everyone takes part: vote, piles_split, piles_choose, branch,
   * coin, die, guess, clash, life; a player: gift, entry_controller, zone_chooser,
   * clash_opponent, announcer, pile_opponent; the library: top_or_bottom, partition, dig_split,
   * reveal, kept, manifest, learn; the rarer cards and rules: companion, meld, entry_attack,
   * cipher, dungeon, dungeon_room, time_travel, shortcut, shortcut_response, precast_shortcut,
   * precast_response, repeat, commander_zone, face_down (a morph cast face down), and the board's
   * own ninjutsu.
   */
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
  unit?: "damage" | "counters" | "life" | "mana";
  /** Targets chosen one at a time: this one's place (from 0) and how many there are. */
  slot?: [number, number];
  /** The targets already chosen for the earlier ones, by option id, in order. */
  picked?: string[];
  /** What a copy or a spell on the stack targets now, by option id; picking it keeps it. */
  current?: string;
  /** Every remaining target of a copy may be kept at once. */
  keepRest?: boolean;
  /** Crew or saddle: the total power the picked creatures must reach. */
  need?: number;
  /** What not paying means, in red (ward: "If you don't pay, your Swords to Plowshares is countered."). */
  warn?: string;
  /** Phyrexian mana: the rest of the cost, printed, paid with mana either way. */
  rest?: string;
  /** Moving or removing counters: the permanent they come off, by option id. */
  origin?: string;
  /** Cards shown that aren't options: the card going to the top or bottom, each clashing player's card, a pile's cards (`group` "a" or "b"). */
  shown?: DecisionOption[];
  /** Where the picked cards go, then where the rest go ("Onto the battlefield tapped", "Into your hand"). */
  places?: string[];
  /** An order whose first `topCount` cards go on top of the library and the rest to the bottom. */
  topCount?: number;
  /** The top and bottom piles are settled: only the order within each may change. */
  fixedSplit?: boolean;
  /** Dungeons: each dungeon offered, or the one being explored, with every room (play/src/rare.rs). */
  dungeons?: DungeonMap[];
  /** Time travel: "remove" (the engine asks about removing first) or "add". */
  step?: "remove" | "add";
  /** A loop shortcut: what repeats, and where everyone is in answering it. */
  shortcut?: ShortcutView;
  /** A special action's cost, printed, for a pick the board puts together itself (ninjutsu's "{1}{U}"). */
  cost?: string;
}

/** A dungeon as the board draws it: its card, its rooms with what each leads to and where it's drawn (thousandths of the card), and the room the marker is on. */
export interface DungeonMap {
  id: string;
  name: string;
  /** The dungeon card's image on Scryfall (dungeon cards credit no artist there). */
  image: string;
  rooms: { index: number; name: string; text: string; next: number[]; x: number; y: number }[];
  current?: number;
}

/** A proposed shortcut (play/src/rare.rs, ShortcutView). */
export interface ShortcutView {
  proposer: number;
  /** How many times it repeats; absent until a player loses. */
  count?: number;
  /** What grows each time round, in words. */
  grows?: string[];
  /** How it ends the game, when the engine says. */
  wins?: string;
  winner?: number;
  /** Everyone else, in the order they answer. */
  responders: [number, "answered" | "deciding" | "next"][];
  shortened_by?: number;
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
  /** New targets for a spell on the stack, one for each it has. */
  | { kind: "retarget_spell"; new_targets: (TargetView | null)[] }
  /** Keep every remaining target of a copy. */
  | { kind: "keep_all_copy_targets" }
  | { kind: "pay_combat_tax"; accept: boolean }
  | { kind: "choose_exert"; exert: boolean }
  | { kind: "choose_enlist"; target: number | null }
  | { kind: "crew_vehicle"; vehicle: number; creatures: number[] }
  | { kind: "saddle_mount"; mount: number; creatures: number[] }
  // A seat's own settings (any time) and Resolve all (play/src/turns.rs). Selectors and targets
  // are the engine's, echoed back as the view lists them.
  | { kind: "set_may_trigger_auto_choice"; change: { op: "remove"; selector: unknown } | { op: "clear_all" } }
  | { kind: "set_replacement_auto_choice"; id: string | null }
  | { kind: "set_priority_yield"; change: { op: "add"; source: number; every: boolean } | { op: "remove"; target: unknown } | { op: "clear_all" } }
  | { kind: "reorder_hand"; order: number[] }
  | { kind: "resolve_all" }
  // Paying (play/src/pay.rs).
  /** Cast a spell the engine offers, paying as "Tap mana for me" says. */
  | { kind: "cast_spell"; object: number; payment: TapMana }
  /** Use a mana source while paying: a choice's key from the payment's sources, or its first. */
  | { kind: "tap_mana"; source: number; choice?: string }
  /** Untap a source tapped by hand that just makes mana. */
  | { kind: "untap_mana"; source: number }
  /** Don't sacrifice a source for mana; pay by hand (the Treasure prompt's "Keep it"). */
  | { kind: "keep_mana" }
  /** The mana to add: one colour, or one letter per mana with `combination`. */
  | { kind: "choose_mana_color"; mana: string[]; combination?: boolean }
  | { kind: "pay_mana_ability_mana"; mana: string[] }
  /** Phyrexian mana: for each Phyrexian symbol in order, whether it's paid with 2 life. */
  | { kind: "pay_phyrexian"; life: boolean[] }
  | { kind: "decide_optional_cost"; pay: boolean }
  | { kind: "choose_cost_branch"; index: number }
  // Ways to cast, permanents and counters (play/src/ways.rs).
  /** Cast what a cascade, discover, ripple, madness or miracle offers, or don't; madness and miracle pay as "Tap mana for me" says. */
  | { kind: "cast_offer"; cast: boolean; payment?: TapMana }
  | { kind: "choose_adventure_face"; creature: boolean }
  | { kind: "choose_modal_face"; back_face: boolean }
  | { kind: "choose_alternative_cast"; alternative: boolean }
  | { kind: "choose_casting_variant"; index: number }
  | { kind: "choose_mutate_side"; top: boolean }
  | { kind: "choose_legend"; keep: number }
  | { kind: "choose_ring_bearer"; target: number }
  | { kind: "equip"; equipment: number; target: number }
  /** Proliferate: any number of permanents and players. */
  | { kind: "select_targets"; targets: TargetView[] }
  /** Counters by the engine's key for their kind: onto (or, as a cost, off) a permanent. */
  | { kind: "move_counters"; moves: { on: number; counter: string; count: number }[] }
  | { kind: "remove_counters"; counters: { counter: string; count: number }[] }
  | { kind: "remove_counter_cost"; counters: { on: number; counter: string; count: number }[] }
  // Everyone takes part, and choosing a player (play/src/together.rs).
  /** A vote for the object at this place in the vote's list (a vote for a word is choose_option). */
  | { kind: "submit_vote_candidate"; candidate: number }
  /** The cards in pile A; the rest are pile B. */
  | { kind: "submit_pile_partition"; pile_a: number[] }
  | { kind: "choose_pile"; pile: "a" | "b" }
  | { kind: "choose_branch"; index: number }
  /** The coins kept, by their place among the results. */
  | { kind: "select_coin_flips"; keep: number[] }
  /** The rolls ignored, by their place among the results. */
  | { kind: "select_die_rolls"; ignore: number[] }
  | { kind: "choose_top_or_bottom"; top: boolean }
  | { kind: "redistribute_life"; option: number }
  /** A player, by seat: a gift's recipient, an opponent who chooses, separates or clashes, who a permanent enters under. */
  | { kind: "choose_player"; seat: number }
  /** Learn: discard this card and draw a card, or (null) don't. */
  | { kind: "learn"; discard: number | null }
  // The rarer cards and rules (play/src/rare.rs).
  /** Reveal this companion before the game (by name), or none. */
  | { kind: "declare_companion"; name: string | null }
  | { kind: "choose_meld_pair"; source: number; partner: number }
  /** What a permanent entering attacking attacks. */
  | { kind: "choose_entry_attack_target"; target: TargetView }
  /** Encode the cipher spell on this creature, or (null) don't. */
  | { kind: "cipher_encode"; creature: number | null }
  /** By the engine's name for the dungeon ("LostMineOfPhandelver"). */
  | { kind: "choose_dungeon"; dungeon: string }
  | { kind: "choose_dungeon_room"; room: number }
  /** Time travel: a time counter off each of `remove`, then onto each of `add`. */
  | { kind: "time_travel"; remove: TargetView[]; add: TargetView[] }
  /** Propose the shortcut: repeat it `count` times, or (null) until a player loses. */
  | { kind: "propose_shortcut"; count: number | null }
  | { kind: "decline_shortcut" }
  /** Accept a shortcut (null), or stop it after that many repetitions (or at the engine's stopping place with that id). */
  | { kind: "respond_to_shortcut"; stop_at: number | null }
  // Special actions at priority and at the mulligan, matched to the engine's own options.
  | { kind: "ninjutsu"; card: number; attacker: number }
  | { kind: "turn_face_up"; object: number }
  | { kind: "foretell"; object: number }
  | { kind: "companion_to_hand" }
  | { kind: "use_serum_powder"; object: number }
  // Answers Yama remembers (play/src/remember.rs).
  /** Answer, and have Yama give the same answer from now on. */
  | { kind: "remember_answer"; accept: boolean }
  /** Stop one (any time). */
  | { kind: "forget_answer"; id: string };

/** "Tap mana for me" (GPay): automatic but ask before sacrificing, always automatic, or by hand. */
export type TapMana = "ask" | "auto" | "manual";

/** What using a mana source costs beyond the tap (play/src/pay.rs, Penalty). */
export interface ManaPenalty {
  kind: "damage" | "life" | "sacrifice" | "other";
  amount?: number;
}

/** One way to use a mana source. */
export interface ManaChoiceView {
  key: string;
  kind: "tap" | "ability" | "source" | "convoke" | "delve";
  /** What it adds: "W", "U", "B", "R", "G", "C", or "any" when a colour is chosen after. */
  mana: string[];
  /** "Add {W}", the ability's own text, "Tap it to pay {1}". */
  text: string;
  penalty?: ManaPenalty;
}

/** A card that can help pay now: a land or rock, a creature for convoke, a graveyard card for delve. */
export interface ManaSourceView {
  id: number;
  name: string;
  zone: string;
  choices: ManaChoiceView[];
}

/** The payment in progress (play/src/pay.rs, PaymentView). */
export interface PaymentView {
  payingFor?: { id: number; name: string; ability: boolean };
  /** The cost as printed; empty while a mana ability pays its own cost. */
  cost: string;
  /** Each symbol, coloured ones first, and whether the pool covers it. */
  pips: { symbol: string; paid: boolean }[];
  pool: { mana: string; source?: number; name: string; convoke?: boolean }[];
  sources: ManaSourceView[];
  /** Sources tapped by hand that can be untapped. */
  untap: number[];
  /** Taps made by hand that can't be undone. */
  kept: { id: number; name: string; penalty: ManaPenalty }[];
  convoke?: "convoke" | "improvise" | "waterbend" | "delve";
  payRest: boolean;
  cancel: boolean;
}

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

/** An answer given for you from memory (GSettings, GLog): by the engine, or by Yama ("yama"). */
export interface AnswerView {
  id: string;
  kind: "may" | "replacement" | "yama";
  name: string;
  /** Whose card it is, when it's someone else's ("Jules's Rhystic Study"). */
  owner?: number;
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
  /** "Tap mana for me" (newer servers). */
  tap_mana?: TapMana;
}

/** A card as you may know it in a table-wide decision: its id while it's on the battlefield, its name unless hidden. */
export interface SeenCard {
  id?: number;
  name?: string;
  face_down?: boolean;
}

/**
 * A decision everyone takes part in, as you may see it (play/src/together.rs, TogetherView): the
 * votes cast so far and who votes next, the piles, who has faced a villainous choice, or a clash's
 * revealed cards.
 */
export type TogetherView =
  | {
      kind: "vote";
      source: SeenCard;
      controller: number;
      /** What is voted for: a permanent (with its id) or a word. */
      options: SeenCard[];
      /** Each vote so far: who cast it and the option's place in `options`. */
      ballots: [number, number][];
      voters: { seat: number; state: "voted" | "voting" | "next" }[];
      /** A secret vote: no ballots are shown until it ends. */
      secret?: boolean;
    }
  | {
      kind: "piles";
      source: SeenCard;
      chooser: number;
      splitter?: number;
      step: "opponent" | "split" | "choose";
      cards?: SeenCard[];
      pile_a?: SeenCard[];
      pile_b?: SeenCard[];
      split?: boolean;
    }
  | { kind: "branch"; source: SeenCard; controller: number; facing: [number, "chose" | "choosing" | "waiting"][] }
  | { kind: "clash"; source: SeenCard; cards: [number, SeenCard][]; placing: number }
  /** A proposed shortcut being answered: what repeats, and who has answered. */
  | { kind: "shortcut"; source: SeenCard; shortcut: ShortcutView };

/** Someone asked to resolve the whole stack: who, and who has agreed (GTogether). */
export interface ResolveAllView {
  asked_by: number;
  seats: { seat: number; agreed: boolean; deciding: boolean }[];
}

/** What a stack item targets, as you may see it: a card or a player, or only "a card" when it's hidden. */
export interface StackTarget {
  target?: TargetView;
  name: string;
  /** The card's controller, or the player targeted. */
  controller?: number;
}

/** One item on the stack. Newer servers say which entry and source it is, and whether it's a trigger. */
export interface StackItem {
  id?: number;
  source?: number;
  name: string;
  controller: number;
  trigger?: boolean;
  /** An ability (triggered, activated or a keyword action such as crew), not a spell (newer servers). */
  ability?: boolean;
  /** A triggered or activated ability's own words (a spell's are its Oracle text). */
  text?: string;
  /** The modes chosen for a modal spell or ability. */
  modes?: string[];
  /** What it targets (newer servers). */
  targets?: StackTarget[];
  /** Still being cast: its targets aren't chosen yet. */
  casting?: boolean;
  /** You yielded to it: Yama passes for you while it's on top. */
  yielded?: boolean;
  /** A face-down spell's card, for its caster only. */
  under?: string;
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
  attack?: AttackChoice;
  /** While declaring blockers: who may block and which attackers. */
  block?: BlockChoice;
  /** While paying: the cost, the pool and the sources you can use (newer servers). */
  payment?: PaymentView;
}

/** A creature a restriction holds back (can't attack, can't block), and the cards that do. */
export interface Held {
  id: number;
  because?: string[];
}

export interface AttackChoice {
  attackers: {
    id: number;
    targets: AttackAt[];
    /** It attacks this combat if able: the defenders it must attack, or [] when anyone will do. */
    must?: AttackAt[];
    /** The cards that make it attack. */
    because?: string[];
    /** What attacking each taxed target costs, printed ("{2}"). */
    taxes?: [AttackAt, string][];
  }[];
  /** Creatures that can't attack. */
  cant?: Held[];
}

export interface BlockChoice {
  blockers: {
    id: number;
    attackers: number[];
    /** It blocks this combat if able. */
    must?: boolean;
  }[];
  /** Attackers that need more than one blocker (menace), and how many. */
  needs?: [number, number][];
  /** Creatures that can't block. */
  cant?: Held[];
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
  abandoned?: boolean;
  can_go_back?: boolean;
  winner: number | null;
  /** Your own turn controls (newer servers, people only). */
  turns?: TurnsView;
  /** Resolve all is being asked (newer servers). */
  resolve_all?: ResolveAllView;
  /** A decision everyone takes part in: votes, piles, a villainous choice, a clash (newer servers). */
  together?: TogetherView;
  /** The newest things that happened, as you may know them, oldest first (newer servers). */
  events?: Happening[];
  /** Players knocked out, in order, each with its cause. */
  outs?: Out[];
  /** The game's numbers, once it's over. */
  stats?: Stats;
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
  /** A two-faced or adventurer card's faces, each in its own words (choosing which face or half to cast). */
  faces?: { name: string; mana_cost?: string | null; type_line?: string | null; oracle_text?: string | null }[];
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
  | { type: "prefs"; saved: boolean }
  /** The sources paying automatically would tap to cast `object` (GCast's "Will tap"). */
  | { type: "preview"; revision: number; object: number; sources: number[] };

export interface OnlineGame {
  /** This live game can use the installed current-runtime Phase board. */
  phase_board?: boolean;
  /** A game the server is playing, from your view of the board: its turn, whose turn it is, and
   *  whether you have a move other than passing (the games list only). */
  turn?: number;
  active?: number;
  your_move?: boolean;
  /** Preserved game cannot currently run on its verified historical runtime. */
  runtime_error?: string | null;
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
  /** When play started and, once over, ended (newer servers). */
  started_at?: string | null;
  ended_at?: string | null;
  /** The rematch the host started from this finished game, for its players: the lobby to join. */
  rematch?: { id: string; code: string; deck_id: string | null };
}
