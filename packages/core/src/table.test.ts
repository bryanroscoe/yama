import { describe, expect, it } from "vitest";
import { panelFills } from "./mana";
import {
  apply,
  clockAt,
  clockText,
  clockWords,
  commanderSources,
  commanderTax,
  dangerOf,
  initialState,
  longBreak,
  lossOf,
  FORMATS,
  formatLabel,
  GAME_WORDS,
  lossesOf,
  NOTE_MAX,
  noteText,
  record,
  replay,
  settledThrough,
  toServerEvents,
  toServerFinish,
  turnPosition,
  turnSpans,
  wonText,
  type LoggedEvent,
  type TableEvent,
  type TableSetup,
} from "./table";

const setup: TableSetup = {
  id: "g1",
  startedAt: "2026-10-18T19:00:00Z",
  format: "commander",
  startingLife: 40,
  players: [
    { seat: 0, name: "Bryan", colorIdentity: "UG" },
    { seat: 1, name: "Sam", colorIdentity: "WR" },
    { seat: 2, name: "Alex", colorIdentity: "B" },
  ],
};

const t0 = new Date("2026-10-18T19:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("table", () => {
  it("commander damage also reduces life and can trigger a loss", () => {
    let s = initialState(setup);
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 21 });
    const sam = s.players[1]!;
    expect(sam.life).toBe(19);
    expect(lossOf(s, sam)).toMatchObject({ kind: "commander_damage", bySeat: 0, key: "cd:0" });
  });

  it("names the commander that dealt lethal damage, partners included, and skips players already out", () => {
    const pair: TableSetup = { ...setup, players: [{ ...setup.players[0]!, commanderName: "Tana", partnerName: "Tymna" }, setup.players[1]!, setup.players[2]!] };
    let s = initialState(pair);
    s = apply(s, { type: "commander_damage", seat: 1, source: "0b", delta: 20 });
    expect(lossOf(s, s.players[1]!)).toBeNull();
    s = apply(s, { type: "commander_damage", seat: 1, source: "0b", delta: 1 });
    expect(lossOf(s, s.players[1]!)?.text).toBe("21 commander damage from Tymna");
    s = apply(s, { type: "eliminate", seat: 1, bySeat: 0 });
    expect(lossOf(s, s.players[1]!)).toBeNull();
    s = apply(s, { type: "poison", seat: 2, delta: 10 });
    expect(lossOf(s, s.players[2]!)).toMatchObject({ kind: "poison", key: "poison" });
  });

  it("warns as a player nears a loss, most urgent cause first", () => {
    const pair: TableSetup = { ...setup, players: [{ ...setup.players[0]!, commanderName: "Atraxa, Praetors' Voice" }, setup.players[1]!, setup.players[2]!] };
    let s = initialState(pair);
    const sam = () => dangerOf(s, s.players[1]!);
    expect(sam()).toBeNull();
    s = apply(s, { type: "life", seat: 1, delta: -30 });
    expect(sam()).toEqual({ kind: "life", level: "low", text: "Low life" });
    s = apply(s, { type: "life", seat: 1, delta: -6 });
    expect(sam()).toMatchObject({ kind: "life", level: "critical" });
    s = apply(s, { type: "life", seat: 1, delta: 25 });
    s = apply(s, { type: "poison", seat: 1, delta: 7 });
    expect(sam()).toMatchObject({ kind: "poison", level: "low", text: "Lethal in 3 poison" });
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 19 });
    expect(sam()).toEqual({ kind: "commander_damage", level: "critical", text: "Lethal in 2 from Atraxa" });
    s = apply(s, { type: "poison", seat: 1, delta: 2 });
    expect(sam()).toMatchObject({ kind: "poison", level: "critical", text: "Lethal in 1 poison" });
    // At a loss the out prompt takes over; once out, no warning either.
    s = apply(s, { type: "poison", seat: 1, delta: 1 });
    expect(sam()).toBeNull();
    s = apply(s, { type: "poison", seat: 1, delta: -1 });
    s = apply(s, { type: "eliminate", seat: 1, bySeat: 0 });
    expect(sam()).toBeNull();
  });

  it("scales low life to the game's starting life", () => {
    let s = initialState({ ...setup, format: "standard", startingLife: 20 });
    s = apply(s, { type: "life", seat: 2, delta: -14 });
    expect(dangerOf(s, s.players[2]!)).toBeNull();
    s = apply(s, { type: "life", seat: 2, delta: -1 });
    expect(dangerOf(s, s.players[2]!)).toMatchObject({ level: "low" });
    s = apply(s, { type: "life", seat: 2, delta: -2 });
    expect(dangerOf(s, s.players[2]!)).toMatchObject({ level: "critical" });
  });

  it("a seat event swaps the commander and drops a partner it doesn't name", () => {
    const pair: TableSetup = { ...setup, players: [{ ...setup.players[0]!, commanderName: "Tana", partnerName: "Tymna", deckVersionId: "v1" }, setup.players[1]!] };
    let s = initialState(pair);
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 4 });
    s = apply(s, { type: "seat", seat: 0, commanderName: "Atraxa, Praetors' Voice", colorIdentity: "WUBG" });
    expect(s.players[0]).toMatchObject({ commanderName: "Atraxa, Praetors' Voice", colorIdentity: "WUBG", deckLabel: "Atraxa, Praetors' Voice" });
    expect(s.players[0]!.partnerName).toBeUndefined();
    // Another commander isn't the deck the seat started with.
    expect(s.players[0]!.deckVersionId).toBeUndefined();
    // Damage Tana already dealt stays Tana's: Atraxa starts from 0.
    expect(s.players[1]!.commanderDamage["0"]).toBeUndefined();
    expect(s.players[1]!.commanderDamage["0~1"]).toBe(4);
    expect(commanderSources(s, 1).map((c) => [c.key, c.name])).toEqual([["0", "Atraxa, Praetors' Voice"], ["0~1", "Tana"]]);
  });

  it("a player event renames the seat or ties it to a member, keeping everything else", () => {
    let s = initialState(setup);
    s = apply(s, { type: "life", seat: 1, delta: -7 });
    s = apply(s, { type: "player", seat: 1, name: "Samantha", memberId: "m-sam", was: { name: "Sam" } });
    expect(s.players[1]).toMatchObject({ name: "Samantha", memberId: "m-sam", life: 33 });
    // Every field is replaced: a typed name drops the member row.
    s = apply(s, { type: "player", seat: 1, name: "Jo" });
    expect(s.players[1]!.memberId).toBeUndefined();
    expect(toServerEvents([{ seq: 1, at: t0.toISOString(), event: { type: "player", seat: 1, name: "Jo" } }])[0]!.actor_seat).toBe(1);
  });

  it("lists every cause, so a later one can still be asked about", () => {
    let s = initialState(setup);
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 21 });
    s = apply(s, { type: "poison", seat: 1, delta: 10 });
    expect(lossesOf(s, s.players[1]!).map((l) => l.key)).toEqual(["cd:0", "poison"]);
  });

  it("a new commander starts with no tax; the same one keeps its casts", () => {
    let s = initialState({ ...setup, players: [{ ...setup.players[0]!, commanderName: "Edgar Markov" }, setup.players[1]!] });
    s = apply(s, { type: "commander_cast", seat: 0, delta: 2 });
    s = apply(s, { type: "seat", seat: 0, commanderName: "Edgar Markov", colorIdentity: "WBR", art: "x" });
    expect(s.players[0]!.commanderCasts).toBe(2);
    s = apply(s, { type: "seat", seat: 0, commanderName: "Krenko, Mob Boss", colorIdentity: "R" });
    expect(s.players[0]!.commanderCasts).toBe(0);
  });

  it("damage from a replaced commander never adds up with the new one's", () => {
    let s = initialState({ ...setup, players: [{ ...setup.players[0]!, commanderName: "Edgar Markov" }, setup.players[1]!] });
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 20 });
    s = apply(s, { type: "seat", seat: 0, commanderName: "Krenko, Mob Boss", colorIdentity: "R" });
    s = apply(s, { type: "commander_damage", seat: 1, source: "0", delta: 1 });
    expect(lossOf(s, s.players[1]!)).toBeNull();
    s = apply(s, { type: "commander_damage", seat: 1, source: "0~1", delta: 1 });
    expect(lossOf(s, s.players[1]!)?.text).toBe("21 commander damage from Edgar Markov");
    // The same commander picked again (an art fix) keeps its damage where it is.
    s = apply(s, { type: "seat", seat: 0, commanderName: "Krenko, Mob Boss", colorIdentity: "R", art: "x" });
    expect(s.players[1]!.commanderDamage["0"]).toBe(1);
  });

  it("taps on the same counter coalesce, but not across the sync boundary", () => {
    let log = record([], { type: "life", seat: 0, delta: -1 }, t0);
    log = record(log, { type: "life", seat: 0, delta: -1 }, later(500));
    log = record(log, { type: "life", seat: 0, delta: -1 }, later(900));
    expect(log).toHaveLength(1);
    expect(log[0]!.event).toEqual({ type: "life", seat: 0, delta: -3 });

    // After a pause it's a new event.
    log = record(log, { type: "life", seat: 0, delta: -2 }, later(10_000));
    expect(log).toHaveLength(2);

    // An event the server already has is never rewritten.
    const synced = record(log, { type: "life", seat: 0, delta: -1 }, later(10_100), 2);
    expect(synced).toHaveLength(3);
  });

  it("a counter still being tapped isn't ready to upload until the burst settles", () => {
    let log = record([], { type: "monarch", seat: 1 }, t0);
    log = record(log, { type: "life", seat: 0, delta: -1 }, later(1000));
    expect(settledThrough(log, later(2000))).toBe(1);
    expect(settledThrough(log, later(1000 + 2500))).toBe(2);
    // Events that never merge go straight away.
    log = record(log, { type: "pass_turn" }, later(4000));
    expect(settledThrough(log, later(4001))).toBe(3);
    expect(settledThrough([], t0)).toBe(0);
  });

  it("taps that cancel out leave no event", () => {
    let log = record([], { type: "life", seat: 0, delta: 1 }, t0);
    log = record(log, { type: "life", seat: 0, delta: -1 }, later(300));
    expect(log).toHaveLength(0);
  });

  it("turns skip eliminated players and count rounds", () => {
    let s = initialState(setup);
    s = apply(s, { type: "eliminate", seat: 1 });
    s = apply(s, { type: "pass_turn" });
    expect(s.activeSeat).toBe(2);
    expect(s.turn).toBe(1);
    s = apply(s, { type: "pass_turn" });
    expect(s.activeSeat).toBe(0);
    expect(s.turn).toBe(2);
  });

  it("replays a log to the same state and tracks commander tax", () => {
    let log = record([], { type: "commander_cast", seat: 2, delta: 1 }, t0);
    log = record(log, { type: "commander_cast", seat: 2, delta: 1 }, later(100));
    log = record(log, { type: "monarch", seat: 2 }, later(200));
    const s = replay(setup, log);
    expect(commanderTax(s.players[2]!)).toBe(4);
    expect(s.monarch).toBe(2);
  });
});

describe("first player", () => {
  it("set_first gives the first player the turn and rounds count from them", () => {
    let s = initialState(setup);
    s = apply(s, { type: "set_first", seat: 2, rolled: true });
    expect(s.firstSeat).toBe(2);
    expect(s.activeSeat).toBe(2);
    s = apply(s, { type: "pass_turn" }); // 2 -> 0, still round 1
    expect(s.activeSeat).toBe(0);
    expect(s.turn).toBe(1);
    s = apply(s, { type: "pass_turn" }); // 0 -> 1
    expect(s.turn).toBe(1);
    s = apply(s, { type: "pass_turn" }); // 1 -> 2: back to the first player, round 2
    expect(s.activeSeat).toBe(2);
    expect(s.turn).toBe(2);
  });

  it("after the first pass, set_first only corrects the record", () => {
    let s = initialState(setup);
    s = apply(s, { type: "pass_turn" });
    expect(s.firstSeat).toBeNull(); // passing says nothing about who went first
    s = apply(s, { type: "set_first", seat: 2 });
    expect(s.firstSeat).toBe(2);
    expect(s.activeSeat).toBe(1);
  });

  it("passing without a first player still counts rounds, from the seat that passed first", () => {
    let s = initialState(setup);
    s = apply(s, { type: "pass_turn" }); // 0 -> 1
    s = apply(s, { type: "pass_turn" }); // 1 -> 2
    expect(s.turn).toBe(1);
    s = apply(s, { type: "pass_turn" }); // 2 -> 0: round 2
    expect(s.turn).toBe(2);
    expect(s.firstSeat).toBeNull();
  });

  it("doesn't record a first player when the table only moved the marker", () => {
    // Alex won a dice roll at the table. Nobody used Roll for first or "goes first"; they tapped
    // Pass the turn twice to put the marker on Alex, then played. Who went first stays unknown,
    // so the finish sheet asks instead of crediting seat 0.
    let log = record([], { type: "pass_turn" }, t0);
    log = record(log, { type: "pass_turn" }, later(1000));
    log = record(log, { type: "pass_turn" }, later(60_000));
    log = record(log, { type: "finish", winnerSeat: 2, endedAt: "2026-10-18T21:00:00Z" }, later(70_000));
    expect(replay(setup, log).firstSeat).toBeNull();
    expect(toServerFinish(setup, log)!.first_seat).toBeNull();
  });

  it("ignores a seat that isn't at the table and leaves first unknown until someone says", () => {
    let s = initialState(setup);
    expect(s.firstSeat).toBeNull();
    s = apply(s, { type: "set_first", seat: 9 });
    expect(s.firstSeat).toBeNull();
    expect(s.activeSeat).toBe(0);
  });

  it("is an ordinary logged event, so it syncs once like the others", () => {
    let log = record([], { type: "set_first", seat: 1 }, t0);
    log = record(log, { type: "set_first", seat: 1 }, later(100)); // not merged: two events
    expect(log.map((l) => l.seq)).toEqual([1, 2]);
    expect(toServerEvents(log)[0]).toMatchObject({ seq: 1, actor_seat: 1, kind: "set_first" });
  });

  it("turn positions count clockwise from the first seat", () => {
    expect(turnPosition([0, 1, 2, 3], 2, 2)).toBe(1);
    expect(turnPosition([0, 1, 2, 3], 2, 3)).toBe(2);
    expect(turnPosition([0, 1, 2, 3], 2, 0)).toBe(3);
    expect(turnPosition([0, 1, 2, 3], 2, 1)).toBe(4);
    expect(turnPosition([0, 1, 2, 3], null, 1)).toBeNull();
  });
});

describe("the words game pages share", () => {
  it("names a game type the way the picker does", () => {
    // The picker's buttons and a game's page read the same list.
    expect(FORMATS.map((f) => formatLabel(f.key))).toEqual(FORMATS.map((f) => f.label));
    expect(FORMATS.map((f) => f.label)).toEqual(["Commander", "Constructed", "Other"]);
  });

  it("has one name each for a game still going, a draw and a result", () => {
    expect([GAME_WORDS.going, GAME_WORDS.draw, wonText("Sam")]).toEqual(["Still going", "A draw", "Sam won"]);
  });
});

describe("finish", () => {
  it("carries first seat, win condition, fun and the killer to the server", () => {
    let log = record([], { type: "set_first", seat: 1 }, t0);
    log = record(log, { type: "eliminate", seat: 2, bySeat: 1 }, later(100));
    log = record(
      log,
      { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z", winCondition: "combat", fun: [{ seat: 0, rating: 4 }, { seat: 2, rating: 9 }] },
      later(200),
    );
    const body = toServerFinish(setup, log)!;
    expect(body).toMatchObject({ winner_seat: 1, first_seat: 1, win_condition: "combat", ended_at: "2026-10-18T21:00:00Z" });
    expect(body.seats).toEqual([
      { seat: 0, final_life: 40, eliminated_turn: null, eliminated_by_seat: null, fun: 4 },
      { seat: 1, final_life: 40, eliminated_turn: null, eliminated_by_seat: null, fun: null },
      // An out-of-range rating is dropped, not clamped. Nobody passed the turn, so no turn is sent.
      { seat: 2, final_life: 40, eliminated_turn: null, eliminated_by_seat: 1, fun: null },
    ]);
    expect(body.turns).toBeNull();
    // Same log, same body: retries are harmless.
    expect(toServerFinish(setup, log)).toEqual(body);
  });

  it("carries the finish sheet's note, and nothing when none was written", () => {
    const finish = (note?: string) => record([], { type: "finish", winnerSeat: 0, endedAt: "2026-10-18T21:00:00Z", ...(note === undefined ? {} : { note }) }, t0);
    expect(toServerFinish(setup, finish("  Sam's new deck  "))!.note).toBe("Sam's new deck");
    expect(toServerFinish(setup, finish())!.note).toBeNull();
    expect(toServerFinish(setup, finish("   "))!.note).toBeNull();
    expect(toServerFinish(setup, finish("x".repeat(NOTE_MAX + 50)))!.note).toHaveLength(NOTE_MAX);
    // A long note is cut between characters, never through one (an emoji is two UTF-16 units).
    const cut = toServerFinish(setup, finish("x".repeat(NOTE_MAX - 1) + "🎲🎲"))!.note!;
    expect(Array.from(cut)).toHaveLength(NOTE_MAX);
    expect(cut.endsWith("🎲")).toBe(true);
    // The note every logged game used to get isn't one anybody wrote.
    expect([noteText("Logged after the game"), noteText("  "), noteText(null), noteText(" Close one ")]).toEqual([null, null, null, "Close one"]);
  });

  it("sends turns only from a table that passed the turn", () => {
    let log = record([], { type: "pass_turn" }, t0);
    for (let i = 1; i < 5; i++) log = record(log, { type: "pass_turn" }, later(i * 100));
    log = record(log, { type: "eliminate", seat: 2, bySeat: 1 }, later(600));
    log = record(log, { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z" }, later(700));
    const body = toServerFinish(setup, log)!;
    expect(body.turns).toBe(2);
    expect(body.seats[2]).toMatchObject({ eliminated_turn: 2 });
  });

  it("an elimination before the table counted turns has no turn, even once counting starts", () => {
    let log = record([], { type: "eliminate", seat: 2, bySeat: 1 }, t0);
    log = record(log, { type: "pass_turn" }, later(100));
    log = record(log, { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z" }, later(200));
    const body = toServerFinish(setup, log)!;
    // A knockout before the first pass means counting started late: no total either.
    expect(body.turns).toBeNull();
    expect(body.seats[2]).toMatchObject({ eliminated_turn: null, eliminated_by_seat: 1 });
  });

  it("sends no elimination turns at all if one knockout came before turns were counted", () => {
    let log = record([], { type: "eliminate", seat: 2, bySeat: 1 }, t0);
    for (let i = 1; i <= 3; i++) log = record(log, { type: "pass_turn" }, later(i * 100));
    log = record(log, { type: "eliminate", seat: 0, bySeat: 1 }, later(500));
    log = record(log, { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z" }, later(600));
    const body = toServerFinish(setup, log)!;
    expect(body.turns).toBeNull();
    expect(body.seats.map((s) => s.eliminated_turn)).toEqual([null, null, null]);
    expect(body.seats.map((s) => s.eliminated_by_seat)).toEqual([1, null, 1]);
  });

  it("sends no turn count when counting started partway through", () => {
    // Two players' totals moved before anyone passed: it wasn't the first turn any more.
    let log = record([], { type: "life", seat: 0, delta: -2 }, t0);
    log = record(log, { type: "life", seat: 1, delta: -5 }, later(3000));
    log = record(log, { type: "pass_turn" }, later(6000));
    log = record(log, { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z" }, later(9000));
    expect(toServerFinish(setup, log)!.turns).toBeNull();
    // Only the starting player paid life (a shock land), then passed: counted from the start.
    let ok = record([], { type: "life", seat: 0, delta: -2 }, t0);
    ok = record(ok, { type: "pass_turn" }, later(3000));
    ok = record(ok, { type: "finish", winnerSeat: 1, endedAt: "2026-10-18T21:00:00Z" }, later(6000));
    expect(toServerFinish(setup, ok)!.turns).toBe(1);
  });

  it("keeps the city's blessing at one, and other counters at zero or more", () => {
    let s = initialState(setup);
    s = apply(s, { type: "counter", seat: 0, counter: "blessing", delta: 1 });
    s = apply(s, { type: "counter", seat: 0, counter: "blessing", delta: 1 });
    s = apply(s, { type: "counter", seat: 0, counter: "storm", delta: -2 });
    expect(s.players[0]!.counters).toEqual({ blessing: 1, storm: 0 });
  });

  it("a draw sends no win condition, and an unfinished log sends nothing", () => {
    const log = record([], { type: "finish", winnerSeat: null, endedAt: "2026-10-18T21:00:00Z", winCondition: "combo" }, t0);
    expect(toServerFinish(setup, log)!.win_condition).toBeNull();
    expect(toServerFinish(setup, [])).toBeNull();
  });
});

describe("panelFills", () => {
  it("gives each player a different color from their own identity when it can", () => {
    expect(panelFills(["UG", "WUR", "WURG", "WBR"])).toEqual(["U", "R", "G", "B"]);
    expect(panelFills(["W", "W"])).toEqual(["W", "W"]);
    expect(panelFills([""])).toEqual(["C"]);
  });
});

describe("the clock", () => {
  const start = { startedAt: "2026-11-11T19:00:00.000Z" };
  const at = (min: number, sec = 0) => new Date(Date.parse(start.startedAt) + (min * 60 + sec) * 1000);
  const ev = (seq: number, when: Date, event: TableEvent): LoggedEvent => ({ seq, at: when.toISOString(), event });
  const life = (seq: number, when: Date) => ev(seq, when, { type: "life", seat: 0, delta: -1 });
  const pass = (seq: number, when: Date) => ev(seq, when, { type: "pass_turn" });
  const finish = (seq: number, when: Date) => ev(seq, when, { type: "finish", winnerSeat: 0, endedAt: when.toISOString() });

  it("times the game from its start and the turn from the last pass", () => {
    // Nothing passed yet: the table isn't known to count turns (it may start mid-game), so
    // there is no turn to time, only the game.
    expect(clockAt(start, [life(1, at(1))], at(2, 30))).toEqual({ game: 150_000, turn: null, running: true });
    const log = [life(1, at(1)), pass(2, at(4)), life(3, at(5)), pass(4, at(9, 20)), life(5, at(10))];
    expect(clockAt(start, log, at(12))).toEqual({ game: 720_000, turn: 160_000, running: true });
    // Undo takes the last pass out of the log, and the turn's time with it.
    expect(clockAt(start, log.slice(0, 3), at(12)).turn).toBe(480_000);
  });

  it("stands still once the game is finished", () => {
    const log = [pass(1, at(4)), finish(2, at(30))];
    for (const now of [at(31), at(600)]) expect(clockAt(start, log, now)).toEqual({ game: 1_800_000, turn: 1_560_000, running: false });
  });

  it("never runs backwards or reads a broken time", () => {
    // A phone whose clock was set back, or an event stamped before the game's start.
    expect(clockAt(start, [pass(1, at(4))], at(3))).toEqual({ game: 180_000, turn: 0, running: true });
    expect(clockAt(start, [pass(1, at(-5))], at(2))).toEqual({ game: 120_000, turn: 120_000, running: true });
    expect(clockAt(start, [], at(-1))).toEqual({ game: 0, turn: null, running: true });
    expect(clockAt({ startedAt: "not a date" }, [], at(1))).toEqual({ game: 0, turn: null, running: true });
    expect(clockAt(start, [{ seq: 1, at: "nonsense", event: { type: "pass_turn" } }], at(2))).toEqual({ game: 120_000, turn: 120_000, running: true });
    // A pass stamped before the one before it happened when that one did, for the clock and
    // for the turns alike.
    const backwards = [pass(1, at(8)), pass(2, at(4))];
    expect(clockAt(start, backwards, at(10)).turn).toBe(120_000);
    expect(turnSpans(start, backwards)).toEqual([0]);
  });

  it("gives each player's turn its length: from one pass to the next", () => {
    expect(turnSpans(start, [life(1, at(1))])).toEqual([]);
    // One pass: the stretch before it (shuffling, or turns not counted yet) isn't a turn.
    expect(turnSpans(start, [pass(1, at(47))])).toEqual([]);
    const log = [pass(1, at(4)), life(2, at(5)), pass(3, at(9, 20)), pass(4, at(11))];
    expect(turnSpans(start, log)).toEqual([320_000, 100_000]);
    // The stretch after the last pass, until the result was entered, isn't one either.
    expect(turnSpans(start, [...log, finish(5, at(15))])).toEqual([320_000, 100_000]);
    expect(turnSpans(start, [finish(1, at(15))])).toEqual([]);
  });

  it("knows a game that was left for hours from one played through", () => {
    const hour = 3_600_000;
    expect(longBreak(start, [life(1, at(20)), pass(2, at(50)), finish(3, at(95))], 3 * hour)).toBe(false);
    // Carried on the next day: nothing between 9 pm and 7 pm.
    expect(longBreak(start, [life(1, at(120)), life(2, at(22 * 60)), finish(3, at(23 * 60))], 3 * hour)).toBe(true);
    expect(longBreak(start, [finish(1, at(4 * 60))], 3 * hour)).toBe(true);
    expect(longBreak(start, [], 3 * hour)).toBe(false);
    expect(longBreak({ startedAt: "not a date" }, [life(1, at(1)), life(2, at(300))], 3 * hour)).toBe(true);
  });

  it("writes a span as a clock and in words", () => {
    expect([0, 999, 7_000, 252_000, 3_599_000, 3_730_000, 36_000_000].map(clockText)).toEqual(["0:00", "0:00", "0:07", "4:12", "59:59", "1:02:10", "10:00:00"]);
    expect([-5, Number.NaN].map(clockText)).toEqual(["0:00", "0:00"]);
    expect([0, 1_000, 7_000, 60_000, 252_000, 3_600_000, 3_730_000, 7_260_000].map(clockWords)).toEqual([
      "0 seconds", "1 second", "7 seconds", "1 minute", "4 minutes 12 seconds", "1 hour", "1 hour 2 minutes", "2 hours 1 minute",
    ]);
  });
});
