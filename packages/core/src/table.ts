// Table mode: the in-person life counter.
//
// State is derived by folding an event log over the starting setup, so undo is "drop the last
// event" and the same log syncs to the server as the game's history. Pure: no clocks, no IO.

export type Seat = number;

/** A commander that can deal commander damage: seat plus which of a pair (partners). */
export type CommanderKey = `${number}` | `${number}b`;

export type CounterKind = "energy" | "experience" | "rad" | "tickets";

export interface PlayerSetup {
  seat: Seat;
  name: string;
  memberId?: string;
  userId?: string;
  deckVersionId?: string;
  deckLabel?: string;
  commanderName?: string;
  partnerName?: string;
  /** WUBRG subset, e.g. "UG". Drives the panel colors. */
  colorIdentity: string;
  /** The commander's art crop (a Scryfall image URL), if known. Drawn behind the panel. */
  art?: string;
  /** Who painted `art`. Scryfall asks for the artist's credit wherever an art crop shows. */
  artist?: string;
  /** The partner's (or background's) art crop and artist, like `art` and `artist`. */
  partnerArt?: string;
  partnerArtist?: string;
}

/** The commander fields a seat can change mid-game (someone grabbed another deck, or a typo). */
export type CommanderPick = Pick<PlayerSetup, "commanderName" | "partnerName" | "colorIdentity" | "art" | "artist" | "partnerArt" | "partnerArtist" | "deckLabel" | "deckVersionId">;

export type TableFormat = "commander" | "standard" | "other";

/** The game types New game offers, with the starting life each one usually uses. */
export const FORMATS: { key: TableFormat; label: string; life: number }[] = [
  { key: "commander", label: "Commander", life: 40 },
  { key: "standard", label: "Constructed (20 life)", life: 20 },
  { key: "other", label: "Something else", life: 20 },
];

export function formatLabel(f: TableFormat): string {
  return f === "commander" ? "Commander" : f === "standard" ? "Constructed" : "Casual";
}

export interface TableSetup {
  id: string;
  startedAt: string;
  format: TableFormat;
  startingLife: number;
  playgroupId?: string;
  players: PlayerSetup[];
}

/** How a game was won, as the table tells it. Optional at the end of every game. */
export const WIN_CONDITIONS = [
  { key: "combat", label: "Combat" },
  { key: "commander_damage", label: "Commander damage" },
  { key: "combo", label: "Combo" },
  { key: "alternate", label: "Alternate win" },
  { key: "mill", label: "Mill" },
  { key: "poison", label: "Poison" },
  { key: "concession", label: "Concession" },
  { key: "other", label: "Other" },
] as const;

export type WinCondition = (typeof WIN_CONDITIONS)[number]["key"];

export function winConditionLabel(key: string | null | undefined): string | null {
  return WIN_CONDITIONS.find((w) => w.key === key)?.label ?? null;
}

/** One player's fun rating for the game, 1 to 5. */
export interface FunRating {
  seat: Seat;
  rating: number;
}

export interface FinishDetails {
  winCondition?: WinCondition;
  fun?: FunRating[];
}

export type TableEvent =
  | { type: "life"; seat: Seat; delta: number }
  | { type: "poison"; seat: Seat; delta: number }
  | { type: "commander_damage"; seat: Seat; source: CommanderKey; delta: number }
  | { type: "counter"; seat: Seat; counter: CounterKind; delta: number }
  | { type: "commander_cast"; seat: Seat; partner?: boolean; delta: number }
  | { type: "monarch"; seat: Seat | null }
  | { type: "initiative"; seat: Seat | null }
  | { type: "day_night"; value: "day" | "night" | null }
  | { type: "pass_turn" }
  /** Who takes (or took) the first turn: chosen, or picked by "Roll for first". */
  | { type: "set_first"; seat: Seat; rolled?: boolean }
  | { type: "eliminate"; seat: Seat; bySeat?: Seat }
  | { type: "revive"; seat: Seat }
  /** The seat changed commanders (or the one picked at setup was wrong). History keeps the old one. */
  | ({
      type: "seat";
      seat: Seat;
      /** What it was playing before, so the game's history can still name it (the server keeps only the newest). */
      was?: { commanderName?: string; partnerName?: string };
    } & CommanderPick)
  | ({ type: "finish"; winnerSeat: Seat | null; endedAt: string } & FinishDetails);

export interface LoggedEvent {
  seq: number;
  at: string;
  event: TableEvent;
}

export interface PlayerState extends PlayerSetup {
  life: number;
  poison: number;
  commanderDamage: Partial<Record<CommanderKey, number>>;
  counters: Partial<Record<CounterKind, number>>;
  /** Times each commander has been cast from the command zone; tax is 2 per cast. */
  commanderCasts: number;
  partnerCasts: number;
  eliminated?: { turn: number; bySeat?: Seat };
}

export interface TableState {
  setup: TableSetup;
  players: PlayerState[];
  turn: number;
  activeSeat: Seat;
  /**
   * The seat that took the first turn, set only by a set_first event (Roll for first, "goes
   * first", or the finish sheet). null = nobody said. Passing the turn never fills it in: the
   * app can't tell who pressed the button, and a table that rolled dice may just be moving the
   * marker to the winner of the roll.
   */
  firstSeat: Seat | null;
  /**
   * Where rounds start for the turn counter: the first player if someone said, else whoever
   * held the turn at the first pass. A guess, so it's never sent as the first player.
   */
  roundStart?: Seat;
  /** Times the turn has been passed. Before the first pass, set_first also moves the turn. */
  passes: number;
  monarch: Seat | null;
  initiative: Seat | null;
  dayNight: "day" | "night" | null;
  finished?: { winnerSeat: Seat | null; endedAt: string } & FinishDetails;
}

export function initialState(setup: TableSetup): TableState {
  return {
    setup,
    players: setup.players.map((p) => ({
      ...p,
      life: setup.startingLife,
      poison: 0,
      commanderDamage: {},
      counters: {},
      commanderCasts: 0,
      partnerCasts: 0,
    })),
    turn: 1,
    activeSeat: setup.players[0]?.seat ?? 0,
    firstSeat: null,
    passes: 0,
    monarch: null,
    initiative: null,
    dayNight: null,
  };
}

function updatePlayer(state: TableState, seat: Seat, fn: (p: PlayerState) => PlayerState): TableState {
  return { ...state, players: state.players.map((p) => (p.seat === seat ? fn(p) : p)) };
}

export function apply(state: TableState, e: TableEvent): TableState {
  switch (e.type) {
    case "life":
      return updatePlayer(state, e.seat, (p) => ({ ...p, life: p.life + e.delta }));
    case "poison":
      return updatePlayer(state, e.seat, (p) => ({ ...p, poison: Math.max(0, p.poison + e.delta) }));
    case "commander_damage":
      // Commander damage is combat damage, so it also comes off life (CR 903.10a).
      return updatePlayer(state, e.seat, (p) => {
        const before = p.commanderDamage[e.source] ?? 0;
        const after = Math.max(0, before + e.delta);
        return { ...p, life: p.life - (after - before), commanderDamage: { ...p.commanderDamage, [e.source]: after } };
      });
    case "counter":
      return updatePlayer(state, e.seat, (p) => ({
        ...p,
        counters: { ...p.counters, [e.counter]: Math.max(0, (p.counters[e.counter] ?? 0) + e.delta) },
      }));
    case "commander_cast":
      return updatePlayer(state, e.seat, (p) =>
        e.partner
          ? { ...p, partnerCasts: Math.max(0, p.partnerCasts + e.delta) }
          : { ...p, commanderCasts: Math.max(0, p.commanderCasts + e.delta) },
      );
    case "monarch":
      return { ...state, monarch: e.seat };
    case "initiative":
      return { ...state, initiative: e.seat };
    case "day_night":
      return { ...state, dayNight: e.value };
    case "pass_turn": {
      const alive = state.players.filter((p) => !p.eliminated);
      if (alive.length === 0) return state;
      const order = state.players.map((p) => p.seat);
      let i = order.indexOf(state.activeSeat);
      let next = state.activeSeat;
      for (let step = 0; step < order.length; step++) {
        i = (i + 1) % order.length;
        const candidate = state.players[i];
        if (candidate && !candidate.eliminated) {
          next = candidate.seat;
          break;
        }
      }
      const roundStart = state.firstSeat ?? state.roundStart ?? state.activeSeat;
      // A new round starts when play wraps back past the seat rounds start from.
      const wrapped = turnPosition(order, roundStart, next)! <= turnPosition(order, roundStart, state.activeSeat)!;
      return { ...state, activeSeat: next, roundStart, passes: state.passes + 1, turn: wrapped ? state.turn + 1 : state.turn };
    }
    case "set_first":
      if (!state.players.some((p) => p.seat === e.seat)) return state;
      // Before anyone has passed, it's also their turn now. Later it only corrects the record.
      return { ...state, firstSeat: e.seat, activeSeat: state.passes === 0 ? e.seat : state.activeSeat };
    case "eliminate":
      return updatePlayer(state, e.seat, (p) => ({ ...p, eliminated: { turn: state.turn, bySeat: e.bySeat } }));
    case "seat": {
      const { type: _, seat, was: __, ...pick } = e;
      // Every commander field is replaced, so dropping a partner clears it.
      return updatePlayer(state, seat, (p) => ({
        ...p,
        commanderName: pick.commanderName,
        partnerName: pick.partnerName,
        colorIdentity: pick.colorIdentity ?? "",
        art: pick.art,
        artist: pick.artist,
        partnerArt: pick.partnerArt,
        partnerArtist: pick.partnerArtist,
        deckLabel: pick.deckLabel ?? pick.commanderName,
        // Another commander is another deck: the seat keeps its deck only if the event says so.
        deckVersionId: pick.deckVersionId,
      }));
    }
    case "revive":
      return updatePlayer(state, e.seat, (p) => {
        const { eliminated: _, ...rest } = p;
        return rest;
      });
    case "finish": {
      const { type: _, ...finished } = e;
      return { ...state, finished };
    }
  }
}

export function replay(setup: TableSetup, log: LoggedEvent[]): TableState {
  return log.reduce((s, l) => apply(s, l.event), initialState(setup));
}

/** Window in which repeated taps on the same counter fold into one logged event. */
export const COALESCE_MS = 2500;

function coalesceKey(e: TableEvent): string | null {
  switch (e.type) {
    case "life":
    case "poison":
      return `${e.type}:${e.seat}`;
    case "commander_damage":
      return `cd:${e.seat}:${e.source}`;
    case "counter":
      return `counter:${e.seat}:${e.counter}`;
    default:
      return null;
  }
}

/**
 * Append an event, merging it into the previous one when it's the same counter tapped again
 * within COALESCE_MS. `syncedThrough` is the highest seq the server already has; those events
 * are never rewritten.
 */
export function record(log: LoggedEvent[], event: TableEvent, at: Date, syncedThrough = 0): LoggedEvent[] {
  const last = log[log.length - 1];
  const key = coalesceKey(event);
  if (
    last &&
    key !== null &&
    last.seq > syncedThrough &&
    coalesceKey(last.event) === key &&
    at.getTime() - Date.parse(last.at) < COALESCE_MS &&
    "delta" in last.event &&
    "delta" in event
  ) {
    const merged = { ...last.event, delta: last.event.delta + event.delta } as TableEvent;
    if ("delta" in merged && merged.delta === 0) return log.slice(0, -1);
    return [...log.slice(0, -1), { ...last, at: at.toISOString(), event: merged }];
  }
  return [...log, { seq: (last?.seq ?? 0) + 1, at: at.toISOString(), event }];
}

/** Combat damage from one commander that knocks a player out (CR 704.6c). */
export const COMMANDER_LETHAL = 21;
/** Poison counters that knock a player out (CR 704.5c). */
export const POISON_LETHAL = 10;

export interface Loss {
  kind: "life" | "poison" | "commander_damage";
  /** "Life at 0", "10 poison", "21 commander damage from Atraxa". */
  text: string;
  /** Whose commander dealt it, for "who knocked them out". */
  bySeat?: Seat;
  /** Stable per cause, so a prompt the table dismissed isn't asked again for the same thing. */
  key: string;
}

/**
 * Why a player has probably lost, naming the commander when it's commander damage. The app
 * asks; players confirm, since some cards change the rules (Platinum Angel, Phyrexian Unlife).
 */
export function lossOf(state: TableState, p: PlayerState): Loss | null {
  if (p.eliminated) return null;
  for (const [source, dmg] of Object.entries(p.commanderDamage) as [CommanderKey, number | undefined][]) {
    if ((dmg ?? 0) >= COMMANDER_LETHAL) {
      const from = state.players.find((x) => x.seat === Number.parseInt(source, 10));
      const name = (source.endsWith("b") ? from?.partnerName : from?.commanderName) ?? (from ? `${from.name}'s commander` : "one commander");
      return { kind: "commander_damage", text: `${dmg} commander damage from ${name}`, bySeat: from?.seat, key: `cd:${source}` };
    }
  }
  if (p.poison >= POISON_LETHAL) return { kind: "poison", text: `${p.poison} poison counters`, key: "poison" };
  if (p.life <= 0) return { kind: "life", text: `Life at ${p.life}`, key: "life" };
  return null;
}

/** The commanders that can deal this player commander damage: each opponent's, partners too. */
export function commanderSources(state: TableState, seat: Seat): { key: CommanderKey; seat: Seat; partner: boolean; name: string }[] {
  return state.players
    .filter((o) => o.seat !== seat)
    .flatMap((o) => {
      const main = { key: `${o.seat}` as CommanderKey, seat: o.seat, partner: false, name: o.commanderName ?? `${o.name}'s commander` };
      return o.partnerName ? [main, { key: `${o.seat}b` as CommanderKey, seat: o.seat, partner: true, name: o.partnerName }] : [main];
    });
}

export function commanderTax(p: PlayerState, partner = false): number {
  return 2 * (partner ? p.partnerCasts : p.commanderCasts);
}

/** Seats still in the game. One left means they've won. */
export function remaining(state: TableState): PlayerState[] {
  return state.players.filter((p) => !p.eliminated);
}

/**
 * Place in turn order, 1 for the first player, counting clockwise (the order of `seats`).
 * null when the first seat or this seat isn't in the list.
 */
export function turnPosition(seats: Seat[], firstSeat: Seat | null, seat: Seat): number | null {
  if (firstSeat === null) return null;
  const f = seats.indexOf(firstSeat);
  const s = seats.indexOf(seat);
  if (f < 0 || s < 0) return null;
  return ((s - f + seats.length) % seats.length) + 1;
}

/** The finish body POST /api/games/:id/finish expects, from a log that ends in "finish". */
export function toServerFinish(setup: TableSetup, log: LoggedEvent[]) {
  const last = log[log.length - 1];
  if (!last || last.event.type !== "finish") return null;
  const f = last.event;
  const state = replay(setup, log);
  const ratings = new Map((f.fun ?? []).filter((r) => r.rating >= 1 && r.rating <= 5).map((r) => [r.seat, Math.round(r.rating)]));
  return {
    winner_seat: f.winnerSeat,
    turns: state.turn,
    ended_at: f.endedAt,
    first_seat: state.firstSeat,
    // A draw has no way it was won.
    win_condition: f.winnerSeat === null ? null : (f.winCondition ?? null),
    seats: state.players.map((p) => ({
      seat: p.seat,
      final_life: p.life,
      eliminated_turn: p.eliminated?.turn ?? null,
      eliminated_by_seat: p.eliminated?.bySeat ?? null,
      fun: ratings.get(p.seat) ?? null,
    })),
  };
}

/** Shape the server's /api/games endpoints expect. */
export function toServerEvents(log: LoggedEvent[]) {
  return log.map((l) => ({
    seq: l.seq,
    actor_seat: "seat" in l.event ? l.event.seat : null,
    kind: l.event.type,
    payload: l.event,
    created_at: l.at,
  }));
}
