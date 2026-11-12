import { replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { describe, expect, it } from "vitest";
import { gameSummary, history } from "./history";
import { setupFromServer } from "./GameDetail";
import { pairing, pairScope, rankByName, resolveDraft, unionIdentity } from "./pickers";
import { vi } from "vitest";
import * as apiModule from "../api";
import { searchOffline, type OfflineCard } from "@yama/core";
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
  it("tells a swap of places by name", () => {
    expect(history(setup, log([{ type: "swap_places", a: 0, b: 1 }])).map((l) => l.text)).toEqual(["Bryan and Sam swapped places."]);
  });

  it("reconciles a corrected terminal result without changing the stored events", () => {
    const detail = {
      id: "g9", status: "finished", winner_seat: 0, win_condition: "combat",
      started_at: "2026-10-29T19:00:00Z", format: "commander", starting_life: 40, playgroup_id: null,
      seats: [{ seat: 0, guest_name: "Bryan" }, { seat: 1, guest_name: "Sam" }],
      events: [
        { seq: 1, payload: { type: "life", seat: 1, delta: -3 } },
        { seq: 2, payload: { type: "finish", winnerSeat: 0, endedAt: "2026-10-29T20:00:00Z", winCondition: "combo" } },
      ],
    } as unknown as GameDetail;
    const original = JSON.stringify(detail.events);
    const shown = () => {
      const { setup, log } = setupFromServer(detail);
      return history(setup, log).map((l) => l.text);
    };
    expect(shown()).toEqual(["Sam lost 3 life, now 37.", "Bryan won (combat)."]);
    detail.win_condition = null;
    expect(shown().at(-1)).toBe("Bryan won.");
    detail.win_condition = "combat";
    detail.winner_seat = null;
    expect(shown().at(-1)).toBe("The game ended in a draw.");
    expect(JSON.stringify(detail.events)).toBe(original);
    detail.status = "in_progress";
    expect(shown().at(-1)).toBe("Bryan won (combo).");
  });

  it("reconciles only each seat's final player event and preserves earlier history", () => {
    const detail = {
      id: "g9", status: "finished", winner_seat: 1, win_condition: "combat",
      started_at: "2026-10-29T19:00:00Z", format: "commander", starting_life: 40, playgroup_id: "pg",
      seats: [{ seat: 0, guest_name: "Bryan" }, { seat: 1, display_name: "Chelsey", member_id: "m-chelsey", user_id: "chelsey" }],
      events: [
        { seq: 1, payload: { type: "life", seat: 1, delta: -3 } },
        { seq: 2, payload: { type: "player", seat: 1, name: "Jo", memberId: "m-jo", was: { name: "Sam" } } },
        { seq: 3, payload: { type: "life", seat: 1, delta: -2 } },
        { seq: 4, payload: { type: "player", seat: 1, name: "Guest 1", userId: "obsolete", was: { name: "Jo" } } },
        { seq: 5, payload: { type: "finish", winnerSeat: 1, endedAt: "2026-10-29T20:00:00Z" } },
      ],
    } as unknown as GameDetail;
    const original = JSON.stringify(detail.events);
    const result = setupFromServer(detail);
    expect(history(result.setup, result.log).map((l) => l.text)).toEqual([
      "Sam lost 3 life, now 37.", "Sam's seat is Jo now.", "Jo lost 2 life, now 35.",
      "Jo's seat is Chelsey now.", "Chelsey won (combat).",
    ]);
    expect(replay(result.setup, result.log).players[1]).toMatchObject({ name: "Chelsey", memberId: "m-chelsey", userId: "chelsey" });
    expect(JSON.stringify(detail.events)).toBe(original);
    detail.seats[1] = { ...detail.seats[1]!, display_name: "Guest", user_id: null, member_id: null };
    const guest = setupFromServer(detail);
    expect(replay(guest.setup, guest.log).players[1]).toMatchObject({ name: "Guest", userId: undefined, memberId: undefined });
    detail.status = "in_progress";
    const live = setupFromServer(detail);
    expect(replay(live.setup, live.log).players[1]).toMatchObject({ name: "Guest 1", userId: "obsolete" });
  });

  it("a saved game's history names whoever sat there at the time", () => {
    const detail = {
      id: "g9", started_at: "2026-10-29T19:00:00Z", format: "commander", starting_life: 40, playgroup_id: null,
      seats: [{ seat: 0, guest_name: "Bryan" }, { seat: 1, guest_name: "Jo", member_id: "m-jo" }],
      events: [
        { seq: 1, created_at: "2026-10-29T19:01:00Z", payload: { type: "life", seat: 1, delta: -3 } },
        { seq: 2, created_at: "2026-10-29T19:02:00Z", payload: { type: "player", seat: 1, name: "Jo", memberId: "m-jo", was: { name: "Sam" } } },
      ],
    } as unknown as GameDetail;
    const { setup, log: saved } = setupFromServer(detail);
    expect(history(setup, saved).map((l) => l.text)).toEqual(["Sam lost 3 life, now 37.", "Sam's seat is Jo now."]);
    expect(replay(setup, saved).players[1]).toMatchObject({ name: "Jo", memberId: "m-jo" });
  });

  it("names a seat's new player with the old name, even from a saved game's seats", () => {
    const renamed = { ...setup, players: [setup.players[0]!, { ...setup.players[1]!, name: "Samantha" }] };
    const lines = history(renamed, log([{ type: "player", seat: 1, name: "Samantha", memberId: "m1", was: { name: "Sam" } }]));
    expect(lines.map((l) => l.text)).toEqual(["Sam's seat is Samantha now."]);
  });

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

  it("says what was applied when a take-back goes past 0", () => {
    const lines = history(setup, log([
      { type: "commander_damage", seat: 1, source: "0", delta: 3 },
      { type: "commander_damage", seat: 1, source: "0", delta: -10 },
      { type: "poison", seat: 1, delta: -2 },
      { type: "commander_cast", seat: 1, delta: -1 },
    ]));
    expect(lines.map((l) => l.text)).toEqual([
      "Sam took 3 commander damage from Tana, the Bloodsower, 3 in all.",
      "3 points of Tana, the Bloodsower's commander damage to Sam taken back.",
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

  it("searches only legal second commanders", () => {
    const pir = "Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)";
    expect(pairScope({ oracle_text: `Flying\n${pir}` })).toBe('!"Toothy, Imaginary Friend"');
    const card = (n: string, o: string): OfflineCard => ({
      n, i: n, m: null, v: 0, t: "Legendary Creature — Human", o, c: "", ci: "", p: null, th: null, l: null, r: "rare", k: [],
      f: { commander: "legal" }, y: "normal", img: null, e: null,
    });
    const pool = [
      card("Tymna the Weaver", "Lifelink\nPartner (You can have two commanders if both have partner.)"),
      card("Pir, Imaginative Rascal", `Flying\nPartner with Toothy, Imaginary Friend (When this creature enters...)`),
      card("Toothy, Imaginary Friend", "Partner with Pir, Imaginative Rascal (When this creature enters...)"),
    ];
    const scope = pairScope({ oracle_text: "Partner (You can have two commanders if both have partner.)" });
    expect(searchOffline(pool, scope).map((c) => c.n)).toEqual(["Tymna the Weaver"]);
    expect(searchOffline(pool, pairScope({ oracle_text: pir })).map((c) => c.n)).toEqual(["Toothy, Imaginary Friend"]);
  });

  it("looks up a commander typed but never picked, and leaves picked ones alone", async () => {
    const spy = vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      const q = decodeURIComponent(path.split("q=")[1] ?? "");
      const cards = q === '!"atraxa, praetors\' voice"'
        ? [{ name: "Atraxa, Praetors' Voice", color_identity: "WUBG", image_art_crop: "https://cards.scryfall.io/art_crop/a.jpg", artist: "Victor Adame Minguez", oracle_text: "Flying" }]
        : [];
      return { total: cards.length, page: 1, page_size: 60, cards } as never;
    });
    const typed = await resolveDraft({ commanderName: "atraxa, praetors' voice", colorIdentity: "" });
    expect(typed).toMatchObject({ commanderName: "Atraxa, Praetors' Voice", colorIdentity: "WUBG", artist: "Victor Adame Minguez" });
    const picked = { commanderName: "Tana", colorIdentity: "RG", ownIdentity: "RG", art: "x" };
    expect(await resolveDraft(picked)).toBe(picked);
    // Atraxa has no partner ability, so a partner left over from the old pair goes.
    const pair = await resolveDraft({ commanderName: "atraxa, praetors' voice", colorIdentity: "WB", partnerName: "Tymna the Weaver", partnerIdentity: "WB", partnerArt: "y" });
    expect(pair.partnerName).toBeUndefined();
    expect(pair.colorIdentity).toBe("WUBG");
    // A partner typed in full must still be one the picked commander can pair with.
    const doctor = await resolveDraft({ commanderName: "The Tenth Doctor", colorIdentity: "URG", ownIdentity: "URG", art: "d", pairScope: 'is:commander o:"doctor\'s companion"', partnerName: "atraxa, praetors' voice" });
    expect(doctor.partnerName).toBeUndefined();
    expect(doctor.colorIdentity).toBe("URG");
    const unknown = { commanderName: "Not a card", colorIdentity: "" };
    expect(await resolveDraft(unknown)).toBe(unknown);
    spy.mockRestore();
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
