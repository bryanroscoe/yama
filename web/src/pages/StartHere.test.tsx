import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { GameRow } from "../api";
import { answered, gamesPlayed, StartHereList, startSteps } from "./StartHere";

const list = (has: Parameters<typeof startSteps>[0], hide = true) =>
  renderToStaticMarkup(<MemoryRouter><StartHereList steps={startSteps(has)} onHide={hide ? () => {} : undefined} /></MemoryRouter>);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
const nothing = { decks: 0, copies: 0, playgroups: 0, games: 0 };

describe("Start here", () => {
  it("lists the four first steps for a new account, each with where to do it", () => {
    const html = list(nothing);
    expect(html).toContain("Start here");
    expect(html).toContain("0 of 4 done");
    for (const title of ["Add a deck", "Bring your collection", "Start or join a playgroup", "Play a game"]) expect(html).toContain(`<b>${title}</b>`);
    expect(hrefs(html)).toEqual(["/decks/import", "/lab", "/collection", "/group", "/play/table"]);
    expect(html).toContain("Hide this list");
  });

  it("marks a step done from the account's own data, and drops its links", () => {
    const html = list({ decks: 1, copies: 0, playgroups: 0, games: 2 });
    expect(html).toContain("2 of 4 done");
    expect(hrefs(html)).toEqual(["/collection", "/group"]);
    expect(html.match(/class="is-done"/g)).toHaveLength(2);
    expect(startSteps({ decks: 1, copies: 0, playgroups: 2, games: 0 }).map((s) => s.done)).toEqual([true, false, true, false]);
    expect(startSteps({ decks: 3, copies: 40, playgroups: 1, games: 9 }).every((s) => s.done)).toBe(true);
  });

  it("offers no hiding where it isn't the viewer's list to hide", () => {
    expect(list(nothing, false)).not.toContain("Hide this list");
  });

  it("counts a game as played only if the account sat in it", () => {
    const game = (id: string, users: (string | null)[]) => ({ id, seats: users.map((user_id, seat) => ({ seat, user_id })) }) as GameRow;
    // One it played, one it only recorded for friends, one with guests only.
    const games = [game("g1", ["u1", "u2"]), game("g2", ["u2", "u3"]), game("g3", [null, null])];
    expect(gamesPlayed(games, "u1")).toBe(1);
    expect(gamesPlayed(games, "u9")).toBe(0);
    expect(startSteps({ ...nothing, games: gamesPlayed(games.slice(1), "u1") })[3]?.done).toBe(false);
  });

  it("takes only a current answer: asked since Home opened or a moment before, and not failed since", () => {
    expect(answered({ isSuccess: true, isFetchedAfterMount: true }, false)).toBe(true);
    // Asked a moment ago on another page: still fresh when Home opened, so not asked again.
    expect(answered({ isSuccess: true, isFetchedAfterMount: false }, true)).toBe(true);
    // An old answer kept from an earlier visit: a step may have been done on another device since.
    expect(answered({ isSuccess: true, isFetchedAfterMount: false }, false)).toBe(false);
    // Asked again and failed (offline), with the old answer still held.
    expect(answered({ isSuccess: false, isFetchedAfterMount: true }, false)).toBe(false);
    expect(answered({ isSuccess: false, isFetchedAfterMount: false }, true)).toBe(false);
  });
});
