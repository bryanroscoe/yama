import { describe, expect, it } from "vitest";
import type { TableGame, TableView } from "./api";
import { placeOf, wilson90, deckRecord, endText, filterTables, placeBadge, rivalText, rivals, seatText, turnOrder } from "./tables";

function game(seats: string[], o: Partial<TableGame> = {}): TableGame {
  return {
    game: "g",
    seats,
    played: true,
    end: "win",
    scored: true,
    first_seat: 0,
    winner: 0,
    places: [1, 2, 3, 4],
    out_turn: [null, 40, 30, 20],
    final_life: [17, 0, 0, 0],
    turns: 44,
    seconds: 9,
    error: null,
    finished_at: null,
    ...o,
  };
}

// One table: a, b, c, d rotating a seat per game; a wins game 1, b game 2, nobody game 3, game 4 unplayed.
const t: TableView = {
  table: 3,
  decks: ["a", "b", "c", "d"],
  games: [
    game(["a", "b", "c", "d"]),
    game(["b", "c", "d", "a"], { winner: 0, places: [1, 3, 4, 2] }),
    game(["c", "d", "a", "b"], { end: "turn_cap", winner: null, places: [2.5, 2.5, 1, 4] }),
    game(["d", "a", "b", "c"], { played: false, end: null, scored: false, winner: null, places: [null, null, null, null] }),
  ],
};
const label = (id: string) => id.toUpperCase();

describe("a run's tables", () => {
  it("orders seats from the first player", () => {
    expect(turnOrder(game(["a", "b", "c", "d"], { first_seat: 2 }))).toEqual([2, 3, 0, 1]);
  });

  it("tells each seat's game and the table's end in words", () => {
    const g = t.games[0]!;
    expect(endText(g, label)).toBe("A won on turn 44");
    expect(seatText(g, 0)).toBe("Won");
    expect(seatText(g, 3)).toBe("Out on turn 20");
    expect(seatText(game(["a", "b"], { winner: 1, out_turn: [null, null], final_life: [6, 20], places: [2, 1] }), 0)).toBe("Still in, 6 life");
    expect(endText(t.games[2]!, label)).toMatch(/^Nobody won: the game reached the turn cap/);
    expect(endText(game(["a"], { end: "time_cap", scored: false }), label)).toBe("Not scored: the game ran out of CPU time");
    expect(endText(t.games[3]!, label)).toBe("Not played yet");
  });

  it("names places, tied ones by the place their group started at", () => {
    const g = t.games[0]!;
    expect(placeBadge(placeOf(g, 0))).toBe("1st");
    expect(placeBadge(placeOf(g, 3))).toBe("4th");
    // Two survivors at the cap share 1st and 2nd (1.5 each); the server sends the mean.
    expect(placeBadge(placeOf(t.games[2]!, 0))).toBe("Tied 2nd");
    expect(placeBadge(placeOf(t.games[2]!, 2))).toBe("1st");
    // A winner and three survivors: 1, 3, 3, 3 is a win and a three-way tie for 2nd.
    const three = game(["a", "b", "c", "d"], { places: [1, 3, 3, 3] });
    expect([0, 1, 2, 3].map((s) => placeBadge(placeOf(three, s)))).toEqual(["1st", "Tied 2nd", "Tied 2nd", "Tied 2nd"]);
    // Four out together: 2.5 each, a four-way tie for 1st.
    expect(placeBadge(placeOf(game(["a", "b", "c", "d"], { end: "draw", winner: null, places: [2.5, 2.5, 2.5, 2.5] }), 1))).toBe("Tied 1st");
    expect(placeBadge(placeOf(t.games[3]!, 0))).toBe("");
  });

  it("adds up a deck's record from its seats, leaving out unplayed games", () => {
    const a = deckRecord([t], "a");
    expect(a).toMatchObject({ played: 3, scored: 3, wins: 1, places: [2, 1, 0, 0], tied: [0, 0, 0, 0] });
    expect(a.avgPlace).toBeCloseTo((1 + 2 + 1) / 3);
    // b: 2nd, then won, then 4th at the cap; c tied for 2nd there.
    expect(deckRecord([t], "b")).toMatchObject({ wins: 1, places: [1, 1, 0, 1], tied: [0, 0, 0, 0] });
    expect(deckRecord([t], "c")).toMatchObject({ places: [0, 1, 2, 0], tied: [0, 1, 0, 0] });
    // A 1v1 table has two places.
    const duel: TableView = { table: 1, decks: ["a", "b"], games: [game(["a", "b"], { places: [1, 2] }), game(["b", "a"], { places: [1, 2] })] };
    expect(deckRecord([duel], "a", 2)).toMatchObject({ scored: 2, wins: 1, places: [1, 1], tied: [0, 0] });
  });

  it("counts who finished above whom, whoever won", () => {
    const r = rivals([t], "a", label);
    const b = r.find((x) => x.id === "b")!;
    // a above b in games 1 and 3, below in game 2.
    expect(b).toMatchObject({ games: 3, ahead: 2, behind: 1, tables: 1 });
    expect(rivalText(b, "B")).toBe("Placed above B in 2 of 3 games");
    const c = rivals([t], "c", label).find((x) => x.id === "d")!;
    expect(c).toMatchObject({ games: 3, ahead: 2, behind: 0 });
    expect(rivalText(c, "D")).toBe("Placed above D in 2 of 3 games, level in 1");
  });

  it("filters tables by wins and by who else sat there", () => {
    const other: TableView = { table: 4, decks: ["a", "e", "f", "g"], games: [game(["e", "a", "f", "g"])] };
    expect(filterTables([t, other], "a", "won").map((x) => x.table)).toEqual([3]);
    expect(filterTables([t, other], "a", "lost").map((x) => x.table)).toEqual([4]);
    expect(filterTables([t, other], "a", "all", "e").map((x) => x.table)).toEqual([4]);
  });

  it("gives the same 90% Wilson interval as the server", () => {
    // stats.rs wilson_matches_the_python_analysis: wilson(5, 10) and wilson(0, 20).
    const [lo, hi] = wilson90(5, 10);
    expect(lo).toBeCloseTo(0.26927, 4);
    expect(hi).toBeCloseTo(0.73073, 4);
    expect(wilson90(0, 20)[0]).toBe(0);
    expect(wilson90(0, 20)[1]).toBeCloseTo(0.1192, 3);
  });
});
