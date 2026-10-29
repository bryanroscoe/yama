import { replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { describe, expect, it } from "vitest";
import { gameSummary, history } from "./history";
import { setupFromServer } from "./GameDetail";
import { pairing, rankByName, unionIdentity } from "./pickers";
import { deckLabel } from "./store";
import { uprightLayout } from "./TablePlay";
import type { GameDetail } from "../api";

const setup: TableSetup = {
  id: "g1",
  startedAt: "2026-10-29T19:00:00Z",
  format: "commander",
  startingLife: 40,
  players: [
    { seat: 0, name: "Bryan", commanderName: "Tana, the Bloodsower", partnerName: "Tymna the Weaver", colorIdentity: "WBRG" },
    { seat: 1, name: "Sam", commanderName: "Atraxa, Praetors' Voice", colorIdentity: "WUBG" },
  ],
};
const log = (events: TableEvent[]): LoggedEvent[] => events.map((event, i) => ({ seq: i + 1, at: `2026-10-29T19:0${i}:00Z`, event }));

describe("table history", () => {
  it("tells a game turn by turn, naming commanders and partners", () => {
    const lines = history(
      setup,
      log([
        { type: "set_first", seat: 0, rolled: true },
        { type: "commander_damage", seat: 1, source: "0b", delta: 6 },
        { type: "pass_turn" },
        { type: "pass_turn" },
        { type: "life", seat: 0, delta: -3 },
        { type: "eliminate", seat: 1, bySeat: 0 },
        { type: "finish", winnerSeat: 0, endedAt: "2026-10-29T20:00:00Z", winCondition: "commander_damage" },
      ]),
    );
    expect(lines.map((l) => [l.turn, l.text])).toEqual([
      [1, "Bryan goes first (rolled)."],
      [1, "Sam took 6 commander damage from Tymna the Weaver, 6 in all."],
      [1, "Sam's turn."],
      [1, "Bryan's turn, turn 2 begins."],
      [2, "Bryan lost 3 life, now 37."],
      [2, "Bryan knocked Sam out."],
      [2, "Bryan won (commander damage)."],
    ]);
  });

  it("sums up a game in progress without middle dots", () => {
    const s = replay(setup, log([{ type: "pass_turn" }]));
    expect(gameSummary(s)).toBe("Commander game on turn 1. Sam's turn.");
  });
});

describe("partners", () => {
  it("knows which commanders can take a second one", () => {
    expect(pairing({ oracle_text: "Partner (You can have two commanders if both have partner.)" })).toBe("partner");
    expect(pairing({ oracle_text: "Flying\nPartner with Pir, Imaginative Rascal (When this creature enters...)" })).toBe("partner");
    expect(pairing({ oracle_text: "Choose a Background (You can have a Background as a second commander.)" })).toBe("background");
    expect(pairing({ oracle_text: "Friends forever" })).toBe("partner");
    expect(pairing({ oracle_text: "Flying, vigilance, deathtouch, lifelink" })).toBeNull();
    // A Doctor's companion ability is on the companion, so the Doctor pairs by its type.
    expect(pairing({ oracle_text: "Whenever a creature you control deals combat damage...", type_line: "Legendary Creature — Time Lord Doctor" })).toBe("partner");
    expect(unionIdentity("WB", "RG")).toBe("WBRG");
  });

  it("puts names that start with the search first", () => {
    const found = [{ name: "Altanak, the Thrice-Called" }, { name: "Ayesha Tanaka" }, { name: "Tana, the Bloodsower" }];
    expect(rankByName(found, "tana").map((c) => c.name)).toEqual(["Tana, the Bloodsower", "Ayesha Tanaka", "Altanak, the Thrice-Called"]);
  });

  it("travels to the server in the seat's label and comes back from it", () => {
    expect(deckLabel({ commanderName: "Tana, the Bloodsower", partnerName: "Tymna the Weaver", deckLabel: "Tana, the Bloodsower" })).toBe("Tana, the Bloodsower and Tymna the Weaver");
    // A deck's own name is kept.
    expect(deckLabel({ commanderName: "Tana, the Bloodsower", partnerName: "Tymna the Weaver", deckLabel: "Tana Tymna stax" })).toBe("Tana Tymna stax");
    const detail = {
      id: "g1",
      mode: "in_person",
      playgroup_id: null,
      format: "commander",
      starting_life: 40,
      status: "in_progress",
      started_at: "2026-10-29T19:00:00Z",
      ended_at: null,
      turns: null,
      winner_seat: null,
      first_seat: null,
      win_condition: null,
      can_continue: true,
      seats: [
        { seat: 0, member_id: null, user_id: "me", guest_name: null, deck_label: "Tana, the Bloodsower and Tymna the Weaver", commander_name: "Tana, the Bloodsower", final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: "Bryan" },
        { seat: 1, member_id: null, user_id: null, guest_name: "Sam", deck_label: "Atraxa, Praetors' Voice", commander_name: "Atraxa, Praetors' Voice", final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: "Sam" },
      ],
      events: [{ seq: 1, actor_seat: 1, kind: "life", payload: { type: "life", seat: 1, delta: -4 }, created_at: "2026-10-29T19:05:00Z" }],
    } satisfies GameDetail;
    const back = setupFromServer(detail);
    expect(back.setup.players[0]).toMatchObject({ name: "Bryan", userId: "me", commanderName: "Tana, the Bloodsower", partnerName: "Tymna the Weaver" });
    expect(back.setup.players[1]!.partnerName).toBeUndefined();
    expect(replay(back.setup, back.log).players[1]!.life).toBe(36);
  });
});

describe("a commander changed mid-game", () => {
  it("rebuilds the history with the commander a seat started with", () => {
    const detail = {
      id: "g2", mode: "in_person", playgroup_id: null, format: "commander", starting_life: 40, status: "in_progress",
      started_at: "2026-10-29T19:00:00Z", ended_at: null, turns: null, winner_seat: null, first_seat: null, win_condition: null, can_continue: true,
      seats: [
        { seat: 0, member_id: null, user_id: "me", guest_name: null, deck_version_id: null, deck_label: "Krenko, Mob Boss", commander_name: "Krenko, Mob Boss", final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: "Bryan" },
        { seat: 1, member_id: null, user_id: null, guest_name: "Sam", deck_label: null, commander_name: null, final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: "Sam" },
      ],
      events: [
        { seq: 1, actor_seat: 1, kind: "commander_damage", payload: { type: "commander_damage", seat: 1, source: "0", delta: 5 }, created_at: "2026-10-29T19:05:00Z" },
        { seq: 2, actor_seat: 0, kind: "seat", payload: { type: "seat", seat: 0, commanderName: "Krenko, Mob Boss", colorIdentity: "R", was: { commanderName: "Edgar Markov" } }, created_at: "2026-10-29T19:06:00Z" },
      ],
    } satisfies GameDetail;
    const { setup, log } = setupFromServer(detail);
    expect(setup.players[0]!.commanderName).toBe("Edgar Markov");
    expect(history(setup, log).map((l) => l.text)).toEqual([
      "Sam took 5 commander damage from Edgar Markov, 5 in all.",
      "Bryan is playing Krenko, Mob Boss now.",
    ]);
    expect(replay(setup, log).players[0]!.commanderName).toBe("Krenko, Mob Boss");
  });
});

describe("upright layout", () => {
  it("puts every panel upright, two across, filling an odd last row", () => {
    const three = uprightLayout(3);
    expect(three.cols).toBe(2);
    expect(three.cells.map((c) => [c.rot, c.area])).toEqual([[0, "1 / 1"], [0, "1 / 2"], [0, "2 / 1 / 3 / 3"]]);
    expect(uprightLayout(6).cols).toBe(3);
    expect(uprightLayout(1).cells[0]!.area).toBe("1 / 1");
  });
});
