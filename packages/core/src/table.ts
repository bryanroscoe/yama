// Table mode: the in-person life counter.
//
// State is derived by folding an event log over the starting setup, so undo is "drop the last
// event" and the same log syncs to the server as the game's history. Pure: no clocks, no IO.

export type Seat = number;

/**
 * A commander that can deal commander damage: seat plus which of a pair (partners). A commander
 * the seat stopped playing keeps its damage under a retired key ("0~1", "0b~2"), so a new one
 * starts from 0 (it's a different commander, CR 704.6c).
 */
export type CommanderKey = `${number}` | `${number}b` | `${number}~${number}` | `${number}b~${number}`;

/** The seat a commander key belongs to. */
export const keySeat = (k: string): Seat => Number.parseInt(k, 10);

/** Player counters beyond life and poison. "blessing" is the city's blessing: 0 or 1, kept for good. */
export type CounterKind = "energy" | "experience" | "rad" | "tickets" | "storm" | "treasure" | "blessing";

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

/** Who sits at a seat: renamed mid-game, or tied to a playgroup member or account after all. */
export type PlayerPick = Pick<PlayerSetup, "name" | "memberId" | "userId">;

export type TableFormat = "commander" | "standard" | "other";

/**
 * The game types New game and Log a game offer, with the starting life each one usually uses.
 * `label` is the one name a game type goes by: on the picker, on a game's page and in its log.
 */
export const FORMATS: { key: TableFormat; label: string; life: number }[] = [
  { key: "commander", label: "Commander", life: 40 },
  { key: "standard", label: "Constructed", life: 20 },
  { key: "other", label: "Other", life: 20 },
];

/** A game type's name, as the picker shows it (`FORMATS`). */
export function formatLabel(f: TableFormat): string {
  return FORMATS.find((x) => x.key === f)?.label ?? "Other";
}

/**
 * The words the game pages share, so the same thing has one name wherever it shows: a game that
 * isn't over is "Still going", a game nobody won is "A draw", and a result is told in the past
 * ("Sam won"). Counts keep "wins" ("3 wins").
 */
export const GAME_WORDS = {
  going: "Still going",
  draw: "A draw",
  abandoned: "Abandoned",
  finished: "Finished",
} as const;

/** "Sam won" for a result. */
export const wonText = (name: string) => `${name} won`;

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

/** The longest note a game keeps (the server refuses more). */
export const NOTE_MAX = 1000;

/**
 * "Logged after the game" was the fixed note every logged game got before Log a game had a notes
 * field. It says nothing the page doesn't already say, so it isn't shown or offered for editing.
 */
export const LEGACY_LOGGED_NOTE = "Logged after the game";

/** A game's note as people wrote it: trimmed, or null when there is none worth showing. */
export function noteText(note: string | null | undefined): string | null {
  const text = note?.trim();
  return text && text !== LEGACY_LOGGED_NOTE ? text : null;
}

export interface FinishDetails {
  winCondition?: WinCondition;
  fun?: FunRating[];
  /** Anything the table wants to remember about the game. */
  note?: string;
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
  /**
   * Two players trade places at the table (they sat down somewhere other than the setup said).
   * Each keeps their seat number, totals and history; only where their panel sits and when their
   * turn comes move. No `seat` field: it's nobody's action (toServerEvents' actor_seat).
   */
  | { type: "swap_places"; a: Seat; b: Seat }
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
  /**
   * Someone else sits here, or the same person under another name or tied to their member row or
   * account. Every field is replaced. `was` keeps the old name for the game's history, and the old
   * account so deleting it can take its name out of the history too (server/src/admin/delete.rs).
   */
  | ({ type: "player"; seat: Seat; was?: { name: string; userId?: string } } & PlayerPick)
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
  /** `uncounted`: knocked out before the table started counting turns, so `turn` means nothing. */
  eliminated?: { turn: number; bySeat?: Seat; uncounted?: true };
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
  /**
   * The seats in the order they sit, clockwise from the device's own (the panels' layout and turn
   * order). Missing until someone swaps places: then it's setup order.
   */
  order?: Seat[];
  /** Commanders a seat stopped playing that had dealt damage, by retired key, with their names. */
  retired?: Partial<Record<CommanderKey, { seat: Seat; partner: boolean; name: string }>>;
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
      return updatePlayer(state, e.seat, (p) => {
        const next = Math.max(0, (p.counters[e.counter] ?? 0) + e.delta);
        // Once you have the city's blessing you keep it (CR 702.131c); it's a yes or no.
        return { ...p, counters: { ...p.counters, [e.counter]: e.counter === "blessing" ? Math.min(1, next) : next } };
      });
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
      const next = nextSeat(state);
      if (next === null) return state;
      const order = seatOrder(state);
      const roundStart = state.firstSeat ?? state.roundStart ?? state.activeSeat;
      // A new round starts when play wraps back past the seat rounds start from.
      const wrapped = turnPosition(order, roundStart, next)! <= turnPosition(order, roundStart, state.activeSeat)!;
      return { ...state, activeSeat: next, roundStart, passes: state.passes + 1, turn: wrapped ? state.turn + 1 : state.turn };
    }
    case "swap_places": {
      const order = seatOrder(state);
      const i = order.indexOf(e.a);
      const j = order.indexOf(e.b);
      if (i < 0 || j < 0 || i === j) return state;
      const swapped = [...order];
      swapped[i] = e.b;
      swapped[j] = e.a;
      return { ...state, order: swapped };
    }
    case "set_first":
      if (!state.players.some((p) => p.seat === e.seat)) return state;
      // Before anyone has passed, it's also their turn now. Later it only corrects the record.
      return { ...state, firstSeat: e.seat, activeSeat: state.passes === 0 ? e.seat : state.activeSeat };
    case "eliminate":
      return updatePlayer(state, e.seat, (p) => ({
        ...p,
        eliminated: { turn: state.turn, bySeat: e.bySeat, ...(turnsCounted(state) ? {} : { uncounted: true as const }) },
      }));
    case "seat": {
      const { type: _, seat, was: __, ...pick } = e;
      const old = state.players.find((p) => p.seat === seat);
      if (!old) return state;
      // A commander replaced by a different one keeps the damage it dealt under its own name.
      let next = state;
      const retire = (partner: boolean, oldName: string | undefined, newName: string | undefined) => {
        const live = `${seat}${partner ? "b" : ""}` as CommanderKey;
        if (oldName === newName || !next.players.some((p) => (p.commanderDamage[live] ?? 0) > 0)) return;
        const retiredKey = `${live}~${Object.keys(next.retired ?? {}).length + 1}` as CommanderKey;
        next = {
          ...next,
          retired: { ...next.retired, [retiredKey]: { seat, partner, name: oldName ?? `${old.name}'s commander` } },
          players: next.players.map((p) => {
            const d = p.commanderDamage[live];
            if (!d) return p;
            const { [live]: _moved, ...rest } = p.commanderDamage;
            return { ...p, commanderDamage: { ...rest, [retiredKey]: d } };
          }),
        };
      };
      retire(false, old.commanderName, pick.commanderName);
      retire(true, old.partnerName, pick.partnerName);
      // Every commander field is replaced, so dropping a partner clears it.
      return updatePlayer(next, seat, (p) => ({
        ...p,
        commanderName: pick.commanderName,
        partnerName: pick.partnerName,
        colorIdentity: pick.colorIdentity ?? "",
        art: pick.art,
        artist: pick.artist,
        partnerArt: pick.partnerArt,
        partnerArtist: pick.partnerArtist,
        deckLabel: pick.deckLabel ?? pick.commanderName,
        // Tax is per card: a different commander hasn't been cast yet (CR 903.8).
        commanderCasts: pick.commanderName === p.commanderName ? p.commanderCasts : 0,
        partnerCasts: pick.partnerName === p.partnerName ? p.partnerCasts : 0,
        // Another commander is another deck: the seat keeps its deck only if the event says so.
        deckVersionId: pick.deckVersionId,
      }));
    }
    case "player":
      return updatePlayer(state, e.seat, (p) => ({ ...p, name: e.name, memberId: e.memberId, userId: e.userId }));
    case "revive":
      return updatePlayer(state, e.seat, (p) => {
        const { eliminated: _, ...rest } = p;
        return rest;
      });
    case "finish": {
      const { type: _, ...finished } = e;
      return { ...state, finished };
    }
    default:
      // An event from a newer version of the app: skip it rather than lose the game.
      return state;
  }
}

/** The seats in the order they sit at the table (and take turns): setup order until someone swaps places. */
export function seatOrder(state: Pick<TableState, "players" | "order">): Seat[] {
  return state.order ?? state.players.map((p) => p.seat);
}

/**
 * A seat's number in the next game after Play again, which numbers seats in the order people sat
 * (seatOrder). A device's own seat moves with its player; -1 (watching) or a seat not in the game
 * stays as it is.
 */
export function rematchSeat(state: Pick<TableState, "players" | "order">, seat: Seat): Seat {
  const i = seatOrder(state).indexOf(seat);
  return i < 0 ? seat : i;
}

/** Whose turn comes after the current one, skipping anyone out. null when everyone is out. */
export function nextSeat(state: Pick<TableState, "players" | "order" | "activeSeat">): Seat | null {
  const order = seatOrder(state);
  const i = order.indexOf(state.activeSeat);
  for (let step = 1; step <= order.length; step++) {
    const seat = order[(i + step) % order.length]!;
    if (state.players.some((p) => p.seat === seat && !p.eliminated)) return seat;
  }
  return null;
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

/**
 * The highest seq that is safe to hand to an upload at `now`. Uploading freezes events (later
 * taps can't merge into them), so a counter still being tapped (the last event, coalescable and
 * tapped within COALESCE_MS) is held back until the burst settles. Otherwise a sync landing
 * mid-burst splits it, and the running "−N" beside the life total starts over at 1.
 */
export function settledThrough(log: LoggedEvent[], now: Date): number {
  const last = log[log.length - 1];
  if (!last) return 0;
  const hot = coalesceKey(last.event) !== null && now.getTime() - Date.parse(last.at) < COALESCE_MS;
  return hot ? (log[log.length - 2]?.seq ?? 0) : last.seq;
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
  return lossesOf(state, p)[0] ?? null;
}

/** Every reason a player has probably lost, commander damage first, then poison, then life. */
export function lossesOf(state: TableState, p: PlayerState): Loss[] {
  if (p.eliminated) return [];
  const out: Loss[] = [];
  for (const [source, dmg] of Object.entries(p.commanderDamage) as [CommanderKey, number | undefined][]) {
    if ((dmg ?? 0) >= COMMANDER_LETHAL) {
      const from = state.players.find((x) => x.seat === keySeat(source));
      const name = sourceName(state, source) ?? (from ? `${from.name}'s commander` : "one commander");
      out.push({ kind: "commander_damage", text: `${dmg} commander damage from ${name}`, bySeat: from?.seat, key: `cd:${source}` });
    }
  }
  if (p.poison >= POISON_LETHAL) out.push({ kind: "poison", text: `${p.poison} poison counters`, key: "poison" });
  if (p.life <= 0) out.push({ kind: "life", text: `Life at ${p.life}`, key: "life" });
  return out;
}

export interface Danger {
  kind: Loss["kind"];
  /** "low" is worth a look; "critical" is about one hit from out. */
  level: "low" | "critical";
  /** "Low life", "Lethal in 1 poison", "Lethal in 3 from Atraxa". */
  text: string;
}

/**
 * How close a player still in the game is to a loss, the most urgent cause first; null when
 * they're comfortable or already at a loss (`lossOf` asks about that). Life counts against the
 * game's starting life: a quarter left is low and an eighth is critical (10 and 5 in Commander).
 */
export function dangerOf(state: TableState, p: PlayerState): Danger | null {
  if (p.eliminated || lossesOf(state, p).length) return null;
  const found: (Danger & { left: number })[] = [];
  for (const [source, dmg] of Object.entries(p.commanderDamage) as [CommanderKey, number | undefined][]) {
    const left = COMMANDER_LETHAL - (dmg ?? 0);
    if (left > 5) continue;
    const from = state.players.find((x) => x.seat === keySeat(source));
    const name = (sourceName(state, source) ?? (from ? `${from.name}'s commander` : "one commander")).split(",")[0]!;
    found.push({ kind: "commander_damage", level: left <= 3 ? "critical" : "low", text: `Lethal in ${left} from ${name}`, left });
  }
  const poisonLeft = POISON_LETHAL - p.poison;
  if (poisonLeft <= 3) found.push({ kind: "poison", level: poisonLeft <= 1 ? "critical" : "low", text: `Lethal in ${poisonLeft} poison`, left: poisonLeft });
  const start = state.setup.startingLife;
  if (p.life <= Math.ceil(start / 4)) found.push({ kind: "life", level: p.life <= Math.ceil(start / 8) ? "critical" : "low", text: "Low life", left: p.life });
  // Critical before low; among equals, the fewest points from out.
  const best = found.sort((a, b) => (a.level === b.level ? a.left - b.left : a.level === "critical" ? -1 : 1))[0];
  return best ? { kind: best.kind, level: best.level, text: best.text } : null;
}

/** The name of the commander behind a key, retired ones included; undefined if it has none. */
export function sourceName(state: TableState, key: CommanderKey): string | undefined {
  const gone = state.retired?.[key];
  if (gone) return gone.name;
  const from = state.players.find((x) => x.seat === keySeat(key));
  return key.endsWith("b") ? from?.partnerName : from?.commanderName;
}

/**
 * The commanders that can deal this player commander damage: each opponent's, partners too,
 * then any a seat stopped playing that already dealt this player some (`retired`).
 */
export function commanderSources(state: TableState, seat: Seat): { key: CommanderKey; seat: Seat; partner: boolean; name: string; retired?: boolean }[] {
  const live = state.players
    .filter((o) => o.seat !== seat)
    .flatMap((o) => {
      const main = { key: `${o.seat}` as CommanderKey, seat: o.seat, partner: false, name: o.commanderName ?? `${o.name}'s commander` };
      return o.partnerName ? [main, { key: `${o.seat}b` as CommanderKey, seat: o.seat, partner: true, name: o.partnerName }] : [main];
    });
  const me = state.players.find((p) => p.seat === seat);
  const gone = (Object.entries(state.retired ?? {}) as [CommanderKey, { seat: Seat; partner: boolean; name: string }][])
    .filter(([k, r]) => r.seat !== seat && (me?.commanderDamage[k] ?? 0) > 0)
    .map(([k, r]) => ({ key: k, seat: r.seat, partner: r.partner, name: r.name, retired: true }));
  return [...live, ...gone];
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

/**
 * Whether this table counted turns: someone passed the turn at least once. Tables that don't
 * (most don't bother) send no turn count, so the stats don't learn that every game lasted one turn.
 */
export function turnsCounted(state: TableState): boolean {
  return state.passes > 0;
}

/**
 * Whether the turn count covers the whole game: someone passed the turn, and before the first
 * pass only the starting player's own totals changed (a shock land on turn one is fine).
 * Counting begun mid-game would undercount, so its total isn't sent.
 */
export function turnsFromStart(setup: TableSetup, log: LoggedEvent[]): boolean {
  let s = initialState(setup);
  for (const { event: e } of log) {
    if (e.type === "pass_turn") return true;
    const touches = e.type === "life" || e.type === "poison" || e.type === "commander_damage" || e.type === "counter" || e.type === "commander_cast" || e.type === "eliminate";
    if (touches && e.seat !== s.activeSeat) return false;
    s = apply(s, e);
  }
  return false;
}

/** The finish body POST /api/games/:id/finish expects, from a log that ends in "finish". */
export function toServerFinish(setup: TableSetup, log: LoggedEvent[]) {
  const last = log[log.length - 1];
  if (!last || last.event.type !== "finish") return null;
  const f = last.event;
  const state = replay(setup, log);
  // Elimination turns go all or nothing: the stats order knockouts by them (first out, last out),
  // so one knockout from before the table counted turns leaves the order unknown for everyone.
  const fromStart = turnsFromStart(setup, log);
  const outTurns = fromStart && state.players.every((p) => !p.eliminated?.uncounted);
  const ratings = new Map((f.fun ?? []).filter((r) => r.rating >= 1 && r.rating <= 5).map((r) => [r.seat, Math.round(r.rating)]));
  return {
    winner_seat: f.winnerSeat,
    turns: fromStart ? state.turn : null,
    ended_at: f.endedAt,
    first_seat: state.firstSeat,
    // A draw has no way it was won.
    win_condition: f.winnerSeat === null ? null : (f.winCondition ?? null),
    // Cut by character, never through the middle of one: half an emoji isn't valid JSON text.
    note: f.note?.trim() ? Array.from(f.note.trim()).slice(0, NOTE_MAX).join("") : null,
    seats: state.players.map((p) => ({
      seat: p.seat,
      final_life: p.life,
      eliminated_turn: outTurns ? (p.eliminated?.turn ?? null) : null,
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

// ── the clock ──────────────────────────────────────────────────────────────
//
// The clock keeps nothing of its own. It reads what a game already records: when it started, when
// each turn was passed (every logged event has its time) and when it finished. So it works with
// no connection, comes back after a reload, follows an undo, and a saved game keeps its times.

/**
 * The instants a clock reads from a game's record, in milliseconds, none earlier than the one
 * before it: an event stamped before its predecessor (a phone's clock set back) counts as
 * happening at the same moment, and one with no readable time too. `start` is NaN when the
 * game's own start can't be read.
 */
function clockMarks(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[]): { start: number; passes: number[]; end: number | null } {
  const start = Date.parse(setup.startedAt);
  let last = Number.isFinite(start) ? start : Number.NEGATIVE_INFINITY;
  const after = (at: number) => (last = Number.isFinite(at) ? Math.max(last, at) : last);
  const passes: number[] = [];
  let end: number | null = null;
  for (const l of log) {
    if (l.event.type === "pass_turn") passes.push(after(Date.parse(l.at)));
    else if (l.event.type === "finish") end = after(Date.parse(l.event.endedAt) || Date.parse(l.at));
  }
  return { start, passes, end };
}

/**
 * How long the game and the current turn have run at `now`, in milliseconds. `turn` is the time
 * since the turn was last passed, and null until it has been passed once: before that the table
 * isn't known to be counting turns (it may start mid-game), so there is no turn to time. A
 * finished game's clock stands where the game ended (`running` false). A time never runs
 * backwards: a phone whose clock was set back reads 0.
 */
export function clockAt(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[], now: Date): { game: number; turn: number | null; running: boolean } {
  const { start, passes, end } = clockMarks(setup, log);
  const until = end ?? now.getTime();
  const since = (from: number) => (Number.isFinite(from) && Number.isFinite(until) ? Math.max(0, until - from) : 0);
  return { game: since(start), turn: passes.length > 0 ? since(passes[passes.length - 1]!) : null, running: end === null };
}

/**
 * How long each player's turn ran, in order, in milliseconds: from one pass to the next. The
 * stretch before the first pass (shuffling, or a game whose turns weren't counted yet) and the
 * one after the last (until the result was entered, or still running) aren't a player's turn.
 * Empty for a table that passed the turn fewer than twice.
 */
export function turnSpans(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[]): number[] {
  const { passes } = clockMarks(setup, log);
  return passes.slice(1).map((at, i) => at - passes[i]!).filter((ms) => Number.isFinite(ms));
}

/**
 * Whether the record has a gap longer than `ms` with nothing in it: a game left on the table
 * overnight, or carried on another day. Its start-to-finish time isn't how long it was played.
 */
export function longBreak(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[], ms: number): boolean {
  let last = Date.parse(setup.startedAt);
  for (const l of log) {
    const at = l.event.type === "finish" ? Date.parse(l.event.endedAt) || Date.parse(l.at) : Date.parse(l.at);
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(last) && at - last > ms) return true;
    last = Number.isFinite(last) ? Math.max(last, at) : at;
  }
  return false;
}

/** A span as a clock shows it: "0:07", "4:12", "1:02:10". */
export function clockText(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(total % 60)}` : `${m}:${two(total % 60)}`;
}

/** The same span in words, for a sentence or a screen reader: "7 seconds", "4 minutes 12 seconds", "1 hour 2 minutes". */
export function clockWords(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => (n > 0 ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  // Past an hour the seconds stop mattering.
  const parts = h > 0 ? [part(h, "hour"), part(m, "minute")] : [part(m, "minute"), part(s, "second")];
  return parts.filter(Boolean).join(" ") || "0 seconds";
}
