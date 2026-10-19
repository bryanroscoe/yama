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
}

export interface TableSetup {
  id: string;
  startedAt: string;
  format: "commander" | "standard" | "other";
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
   * The seat that took the first turn. Set by a set_first event, or by the first "pass the turn"
   * (whoever passes first evidently went first). null = nobody said.
   */
  firstSeat: Seat | null;
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
      const firstSeat = state.firstSeat ?? state.activeSeat;
      // A new round starts when play wraps back past the first player's seat.
      const wrapped = turnPosition(order, firstSeat, next)! <= turnPosition(order, firstSeat, state.activeSeat)!;
      return { ...state, activeSeat: next, firstSeat, passes: state.passes + 1, turn: wrapped ? state.turn + 1 : state.turn };
    }
    case "set_first":
      if (!state.players.some((p) => p.seat === e.seat)) return state;
      // Before anyone has passed, it's also their turn now. Later it only corrects the record.
      return { ...state, firstSeat: e.seat, activeSeat: state.passes === 0 ? e.seat : state.activeSeat };
    case "eliminate":
      return updatePlayer(state, e.seat, (p) => ({ ...p, eliminated: { turn: state.turn, bySeat: e.bySeat } }));
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

/** Why a player has probably lost. The app suggests; players confirm (some cards change the rules). */
export function lossReason(p: PlayerState): string | null {
  if (p.life <= 0) return "life at 0";
  if (p.poison >= 10) return "10 poison";
  for (const [source, dmg] of Object.entries(p.commanderDamage)) {
    if ((dmg ?? 0) >= 21) return `21 commander damage (${source})`;
  }
  return null;
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
