import { describe, expect, it } from "vitest";
import { seatLabel, seatName, statusLine, tableNames, watchRequest } from "./watch";
import type { SeatInfo, WatchStatus } from "./types";

const seat = (n: number, commander: string | null, ai = "Easy"): SeatInfo => ({
  seat: n,
  name: commander ?? "Computer",
  ai,
  deck_name: `Deck ${n + 1}`,
  commander,
  color_identity: "G",
  ready: true,
});
const status = (extra: Partial<WatchStatus> = {}): WatchStatus => ({
  playing: true,
  speed: "1x",
  reveal: false,
  idle: false,
  actions: 10,
  stopped: null,
  finished: false,
  ...extra,
});
const seats = [seat(0, "Éowyn, Lady of Rohan"), seat(1, "Omo, Queen of Vesuva", "Hard"), seat(2, null)];

describe("watch words", () => {
  it("names seats by commander, then deck", () => {
    expect(seatName(seats[0], 0)).toBe("Éowyn");
    expect(seatName(seats[2], 2)).toBe("Deck 3");
    expect(seatName(undefined, 3)).toBe("Seat 4");
    expect(seatLabel(seats[1], 1)).toBe("Omo, hard");
    expect(tableNames(seats)).toBe("Éowyn, Omo and Deck 3");
  });

  it("says who won, why it stopped, or where it is", () => {
    const g = { seats, turn: 9, winner: null as number | null };
    expect(statusLine({ ...g, status: status() })).toBe("Playing, turn 9");
    expect(statusLine({ ...g, status: status({ speed: "end" }) })).toBe("Skipping to the end, turn 9");
    expect(statusLine({ ...g, status: status({ playing: false }) })).toBe("Paused on turn 9");
    expect(statusLine({ ...g, status: status({ idle: true }) })).toBe("Paused on turn 9 while nobody watches");
    expect(statusLine({ ...g, winner: 1, status: status({ finished: true, playing: false }) })).toBe("Omo won on turn 9");
    expect(statusLine({ ...g, status: status({ finished: true }) })).toBe("A draw on turn 9");
    expect(statusLine({ ...g, status: status({ finished: true, stopped: "Stopped by you" }) })).toBe("Stopped by you");
  });

  it("builds the request the server reads", () => {
    const body = watchRequest(
      [
        { source: "deck", deckId: "d1", preconId: "", level: "Hard" },
        { source: "precon", deckId: "", preconId: "counterpunch", level: "Easy" },
      ],
      1,
      true,
      "2x",
    );
    expect(body).toEqual({
      seats: [
        { deck: { kind: "deck", id: "d1" }, pilot: { kind: "ai", difficulty: "Hard" } },
        { deck: { kind: "precon", id: "counterpunch" }, pilot: { kind: "ai", difficulty: "Easy" } },
      ],
      first: 1,
      reveal: true,
      speed: "2x",
    });
  });
});
