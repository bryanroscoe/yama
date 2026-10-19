import { describe, expect, it } from "vitest";
import { panelFills } from "./mana";
import {
  apply,
  commanderTax,
  initialState,
  lossReason,
  record,
  replay,
  toServerEvents,
  toServerFinish,
  turnPosition,
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
    expect(lossReason(sam)).toBe("21 commander damage (0)");
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
    expect(s.firstSeat).toBe(0); // whoever passed first went first
    s = apply(s, { type: "set_first", seat: 2 });
    expect(s.firstSeat).toBe(2);
    expect(s.activeSeat).toBe(1);
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
      // An out-of-range rating is dropped, not clamped.
      { seat: 2, final_life: 40, eliminated_turn: 1, eliminated_by_seat: 1, fun: null },
    ]);
    // Same log, same body: retries are harmless.
    expect(toServerFinish(setup, log)).toEqual(body);
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
