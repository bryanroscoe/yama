import { describe, expect, it } from "vitest";
import { panelFills } from "./mana";
import { apply, commanderTax, initialState, lossReason, record, replay, type TableSetup } from "./table";

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

describe("panelFills", () => {
  it("gives each player a different color from their own identity when it can", () => {
    expect(panelFills(["UG", "WUR", "WURG", "WBR"])).toEqual(["U", "R", "G", "B"]);
    expect(panelFills(["W", "W"])).toEqual(["W", "W"]);
    expect(panelFills([""])).toEqual(["C"]);
  });
});
