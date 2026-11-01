import { describe, expect, it } from "vitest";
import type { Confidence, Pace, PreconItem, Summary } from "./api";
import {
  fieldResult,
  allowanceText,
  gamesToSettle,
  podCountText,
  settleText,
  unscoredText,
  gameChoices,
  baseConfidence,
  baseConfidenceSentence,
  cantJudge,
  confidenceMark,
  confidenceSentence,
  splitUnjudged,
  worstConfidence,
  caveat,
  changeText,
  changedCount,
  cuttable,
  deltaBound,
  durationText,
  engineFamily,
  expectedSeconds,
  filterPrecons,
  fmtDate,
  gameText,
  grouped,
  hasResults,
  identityMatches,
  identityQuery,
  logScale,
  moreOften,
  pct,
  points,
  pointsRange,
  pointsWord,
  rateCeiling,
  simDetails,
  simLabel,
  sortPrecons,
  strengthDomain,
  verdictText,
  yearsOf,
} from "./logic";

const precon = (id: string, over: Partial<PreconItem> = {}): PreconItem => ({
  id,
  lab_id: `precons/${id}`,
  name: id,
  set_code: "TST",
  set_name: "Test Set",
  released: "2024-01-01",
  commanders: [`${id} commander`],
  color_identity: "G",
  same_list_as: null,
  card_count: 100,
  art: null,
  playgroup: null,
  rating: null,
  ...over,
});

const rated = (rank: number, strength: number, p4: number | null = null, confidence: Confidence | null = null) =>
  ({ deck_ref: "", strength, lo: strength / 2, hi: strength * 2, win_rate: null, wr_lo: null, wr_hi: null, games: 10, avg_place: null, rank, rank_lo: null, rank_hi: null, p4_field: p4, p4_lo: null, p4_hi: null, flags: [], confidence });

describe("wording", () => {
  it("words differences as the server does, with a real minus sign", () => {
    expect(points(0.04)).toBe("+4");
    expect(points(-0.031)).toBe("−3");
    expect(points(0.004)).toBe("0");
    expect(pointsWord(-0.01)).toBe("−1 point");
    expect(pointsRange([0.01, 0.07])).toBe("+1 to +7");
    expect(pct(0.4427)).toBe("44%");
    expect(pct(null)).toBe("no data");
  });

  it("says how much more often in words", () => {
    expect(moreOften(0.04)).toBe("4 points more often than");
    expect(moreOften(-0.01)).toBe("1 point less often than");
    expect(moreOften(0.002)).toBe("about as often as");
  });

  it("formats dates day month year and keeps unreadable ones", () => {
    expect(fmtDate("2026-10-19T04:15:40Z")).toBe("19 Oct 2026");
    expect(fmtDate("2026-10-19")).toBe("19 Oct 2026");
    expect(fmtDate("soon")).toBe("soon");
    expect(fmtDate(null)).toBe("");
  });

  it("gives rough durations", () => {
    expect(durationText(30)).toBe("under a minute");
    expect(durationText(61)).toBe("about 2 minutes");
    expect(durationText(6 * 60)).toBe("about 6 minutes");
    expect(durationText(2 * 3600 + 9 * 60)).toBe("about 2 hours 10 minutes");
    expect(durationText(3600 + 58 * 60)).toBe("about 2 hours");
  });

  it("takes expected times from the server's estimates", () => {
    const pace = { available: true, message: null, threads: 2, estimates: [{ games: 100, seconds: 3000 }, { games: 200, seconds: 5100 }], seconds_per_game: null, basis: null, sample: null, your_pending: 50 };
    expect(expectedSeconds(pace, 100)).toBe(3000);
    expect(expectedSeconds(pace, 400)).toBeNull();
    expect(expectedSeconds({ ...pace, estimates: [] }, 100)).toBeNull();
    expect(expectedSeconds(undefined, 100)).toBeNull();
  });

  it("labels simulated numbers with engine, AI level, games and date, no middle dots", () => {
    const s = simLabel({ engine: "phase-rs v0.113.0", difficulty: "Easy", games: 1234, pod: 4, date: "2026-10-19T04:15:40Z", run: "pilot-2" });
    expect(s).toBe("Simulated on phase-rs v0.113.0, Easy AI, 1,234 games in 4-player pods, run pilot-2, 19 Oct 2026");
    expect(s).not.toContain("·");
  });

  it("keeps the card data hash for the Details line, not the label", () => {
    expect(simDetails("eb309108eb0df708")).toBe("Card data eb309108.");
    expect(simDetails("eb309108eb0df708, 0123456789abcdef")).toBe("Card data eb309108, 01234567.");
    expect(simDetails(null)).toBeNull();
  });

  it("labels a run that stopped early with the games behind its numbers", () => {
    const l = { engine: "phase-rs v0.113.0", difficulty: "Easy", pod: 4, date: "2026-10-19" };
    expect(simLabel({ ...l, games: 1, planned: 100 })).toBe("Simulated on phase-rs v0.113.0, Easy AI, 1 of 100 planned games in 4-player pods, 19 Oct 2026");
    expect(simLabel({ ...l, games: 100, planned: 100 })).toBe("Simulated on phase-rs v0.113.0, Easy AI, 100 games in 4-player pods, 19 Oct 2026");
  });

  it("names the run's engine in the caveat", () => {
    expect(caveat("phase-rs v0.113.0")).toBe("AI vs AI games on the phase engine: evidence about the simulation, not your table.");
    expect(caveat("forge 2.0.15")).toBe("AI vs AI games on the Forge engine: evidence about the simulation, not your table.");
    expect(caveat(null)).toBe("AI vs AI games: evidence about the simulation, not your table.");
    expect(engineFamily("phase-rs v0.113.0, phase-rs v0.114.0")).toBe("phase");
    expect(engineFamily("phase-rs v0.113.0, forge 2.0.15")).toBe("phase and Forge");
    expect(caveat("phase-rs v0.113.0, forge 2.0.15")).toContain("on the phase and Forge engines:");
  });

  it("has no results before a scored game, and a cancelled run doesn't ask for more games", () => {
    const empty = { base: { games: 0 }, variant: { games: 0 }, verdict: { kind: "unclear", text: "Can't tell yet: run more games", final: true } } as unknown as Summary;
    expect(hasResults(empty)).toBe(false);
    expect(hasResults(null)).toBe(false);
    const some = { ...empty, base: { games: 3 } } as unknown as Summary;
    expect(hasResults(some)).toBe(true);
    expect(verdictText("cancelled", some)).toBe("Can't tell from the games played before it was cancelled");
    expect(verdictText("running", some)).toBe("Can't tell yet: run more games");
    const better = { ...some, verdict: { kind: "better", text: "Probably better (+4 points, 90% interval +1 to +7)", final: true } } as unknown as Summary;
    expect(verdictText("cancelled", better)).toBe(better.verdict.text);
  });

  it("says how a game went for the tested list", () => {
    expect(gameText({ end: "win", won: true, place: 1, turns: 12 })).toBe("Won on turn 12");
    expect(gameText({ end: "win", won: false, place: 3, turns: 12 })).toBe("3rd");
    expect(gameText({ end: "turn_cap", won: false, place: 2, turns: 120 })).toBe("Turn cap, no winner (2nd)");
    expect(gameText({ end: "time_cap", won: false, place: null, turns: 40 })).toBe("Out of time, not scored");
    expect(gameText({ end: "error", won: false, place: null, turns: 0 })).toBe("Error, not scored");
  });
});

describe("scales", () => {
  it("puts strength on a log axis with average inside", () => {
    const [lo, hi] = strengthDomain([{ strength: 2, lo: 1.5, hi: 4 }, { strength: null, lo: null, hi: null }]);
    expect(lo).toBeLessThan(1);
    expect(hi).toBeGreaterThan(4);
    const s = logScale(0.5, 2);
    expect(s(1)).toBeCloseTo(0.5);
    expect(s(0.1)).toBe(0);
    expect(s(9)).toBe(1);
    expect(s(-1)).toBe(0);
  });

  it("rounds axes up to tenths", () => {
    expect(rateCeiling([0.44, 0.52])).toBe(0.6);
    expect(rateCeiling([0.1])).toBe(0.5);
    expect(deltaBound([0.05, -0.31])).toBe(0.4);
    expect(deltaBound([null])).toBe(0.2);
  });
});

describe("the precon table", () => {
  it("matches colour identities including, exactly or within", () => {
    expect(identityMatches("WUG", "UG", "includes")).toBe(true);
    expect(identityMatches("WUG", "UG", "exactly")).toBe(false);
    expect(identityMatches("UG", "UG", "exactly")).toBe(true);
    expect(identityMatches("G", "UG", "within")).toBe(true);
    expect(identityMatches("WG", "UG", "within")).toBe(false);
    expect(identityMatches("", "C", "exactly")).toBe(true);
    expect(identityMatches("G", "C", "includes")).toBe(false);
    expect(identityMatches("", "UG", "within")).toBe(true);
    expect(identityMatches("RG", "", "exactly")).toBe(true);
  });

  it("filters by search, colour and year", () => {
    const list = [
      precon("counterpunch", { color_identity: "WRG", released: "2025-01-01", commanders: ["Ghave"] }),
      precon("spore-tide", { color_identity: "BG", released: "2024-06-01", set_name: "Spores" }),
    ];
    expect(filterPrecons(list, { q: "ghave", colors: "", mode: "includes", year: null }).map((p) => p.id)).toEqual(["counterpunch"]);
    expect(filterPrecons(list, { q: "spores", colors: "", mode: "includes", year: null }).map((p) => p.id)).toEqual(["spore-tide"]);
    expect(filterPrecons(list, { q: "", colors: "G", mode: "includes", year: 2024 }).map((p) => p.id)).toEqual(["spore-tide"]);
    expect(yearsOf(list)).toEqual([2025, 2024]);
  });

  it("sorts with missing values last either way", () => {
    const list = [precon("b", { rating: rated(2, 1.5, 0.3) }), precon("a"), precon("c", { rating: rated(1, 2.5, 0.4) })];
    expect(sortPrecons(list, "rank", false).map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(sortPrecons(list, "rank", true).map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(sortPrecons(list, "strength", true).map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(sortPrecons(list, "name", false).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("simulation confidence", () => {
  const bad: Confidence = { level: "unreliable", reasons: ["known phase gap: the AI gives Omo's counters away", "real games disagree"] };
  const meh: Confidence = { level: "doubtful", reasons: ["commander partly unimplemented in phase: Omo"] };
  const fine: Confidence = { level: "ok", reasons: [] };

  it("marks only decks with a known problem", () => {
    expect(confidenceMark(bad)).toBe("sim unreliable");
    expect(confidenceMark(meh)).toBe("sim doubtful");
    expect(confidenceMark(fine)).toBeNull();
    expect(confidenceMark(null)).toBeNull();
    expect([bad, meh, fine, null].map(cantJudge)).toEqual([true, false, false, false]);
  });

  it("says plainly what a level means for numbers, a verdict or a run", () => {
    expect(confidenceSentence("unreliable")).toBe("The simulator can't judge this deck yet, so these numbers say little about real games.");
    expect(confidenceSentence("unreliable", "verdict")).toBe("The simulator can't judge this deck yet, so this verdict says little about real games.");
    expect(confidenceSentence("doubtful", "run")).toBe("The simulator may misjudge this deck, so read a run's result with care.");
    expect(confidenceSentence("ok")).toBeNull();
  });

  it("takes the worst level across a deck's versions, with each reason once", () => {
    const other: Confidence = { level: "unreliable", reasons: ["real games disagree", "5 cards partly unimplemented in phase"] };
    expect(worstConfidence([meh, bad, other, null])).toEqual({
      level: "unreliable",
      reasons: ["known phase gap: the AI gives Omo's counters away", "real games disagree", "5 cards partly unimplemented in phase"],
    });
    expect(worstConfidence([fine, meh])?.level).toBe("doubtful");
    expect(worstConfidence([null, undefined])).toBeNull();
  });

  it("lists the decks the simulation can't judge after the rest, each group in order", () => {
    const rows = [precon("a", { rating: rated(1, 3, null, bad) }), precon("b", { rating: rated(2, 2, null, meh) }), precon("c", { rating: rated(3, 1) }), precon("d")];
    const [judged, not] = splitUnjudged(rows, (p) => p.rating?.confidence);
    expect(judged.map((p) => p.id)).toEqual(["b", "c", "d"]);
    expect(not.map((p) => p.id)).toEqual(["a"]);
  });

  it("judges a Try a change base by its precon, or the precon on the same commanders", () => {
    const tricky = precon("tricky-terrain", { name: "Tricky Terrain", commanders: ["Omo, Queen of Vesuva"], rating: rated(165, 0.5, null, bad) });
    const repeat = precon("tricky-terrain-ce", { name: "Tricky Terrain CE", commanders: ["Omo, Queen of Vesuva"], rating: rated(160, 0.6, null, meh) });
    const plain = precon("counterpunch", { commanders: ["Ghave"], rating: rated(1, 2, null, fine) });
    const list = [repeat, plain, tricky];
    const own = baseConfidence(list, { precon: "tricky-terrain", commanders: [] });
    expect([own?.precon.id, own?.own, own?.confidence.level]).toEqual(["tricky-terrain", true, "unreliable"]);
    // A deck on Omo: the most cautious precon on Omo speaks for it.
    const deck = baseConfidence(list, { precon: null, commanders: ["Omo, Queen of Vesuva"] });
    expect([deck?.precon.id, deck?.own]).toEqual(["tricky-terrain", false]);
    expect(baseConfidenceSentence(deck!, "run")).toBe("The simulator can't judge Tricky Terrain, the precon on the same commander, so a run says little about real games.");
    expect(baseConfidenceSentence(own!, "verdict")).toBe("The simulator can't judge this deck yet, so this verdict says little about real games.");
    expect(baseConfidence(list, { precon: null, commanders: ["Nobody"] })).toBeNull();
    expect(baseConfidence(list, { precon: null, commanders: [] })).toBeNull();
    expect(baseConfidence([precon("unrated")], { precon: "unrated", commanders: [] })).toBeNull();
  });
});

describe("try a change", () => {
  const base = [
    { name: "Ghave", qty: 1, board: "commander" as const, type_line: "Legendary Creature" },
    { name: "Forest", qty: 3, board: "main" as const, type_line: "Basic Land — Forest", cmc: 0 },
    { name: "Sol Ring", qty: 1, board: "main" as const, type_line: "Artifact", cmc: 1 },
    { name: "Spare", qty: 2, board: "side" as const, type_line: "Instant" },
  ];

  it("counts the changed list without the sideboard", () => {
    expect(changedCount(base, [], [])).toBe(5);
    expect(changedCount(base, ["Llanowar Elves"], ["Forest", "Forest"])).toBe(4);
  });

  it("cuts only copies the main deck has", () => {
    expect(cuttable(base, ["Forest"], "Forest")).toBe(2);
    expect(cuttable(base, [], "Ghave")).toBe(0);
    expect(cuttable(base, [], "Spare")).toBe(0);
  });

  it("words the change with repeats", () => {
    expect(changeText(["Toxic Deluge"], ["Forest", "Forest", "Darkness"])).toBe("−2 Forest, −Darkness, +Toxic Deluge");
  });

  it("groups lists like the Decks page", () => {
    expect(grouped(base).map(([g, items]) => [g, items.map((i) => i.name)])).toEqual([
      ["Commander", ["Ghave"]],
      ["Artifacts", ["Sol Ring"]],
      ["Lands", ["Forest"]],
      ["Sideboard", ["Spare"]],
    ]);
  });

  it("limits the card search to the commander's colours", () => {
    expect(identityQuery("WUG")).toBe("id<=wug");
    expect(identityQuery("")).toBe("id:c");
    expect(identityQuery(null)).toBe("");
  });
});

describe("the smaller lab allowance", () => {
  const pace = (game_choices?: number[]): Pace => ({
    available: true,
    message: null,
    threads: 2,
    estimates: [],
    seconds_per_game: null,
    basis: null,
    sample: null,
    your_pending: 0,
    game_choices,
  });

  it("offers the game counts the server allows, else the usual three", () => {
    expect(gameChoices(pace([100]))).toEqual([100]);
    expect(gameChoices(pace([100, 200, 400]))).toEqual([100, 200, 400]);
    expect(gameChoices(pace())).toEqual([100, 200, 400]);
    expect(gameChoices(pace([]))).toEqual([100, 200, 400]);
    expect(gameChoices(undefined)).toEqual([100, 200, 400]);
  });

  it("says what an account without an invite may run and what's left today", () => {
    expect(allowanceText({ games: 100, at_a_time: 1, games_per_day: 300, used_today: 100 })).toBe(
      "Accounts that joined without an invite run 100-game experiments, one at a time, up to 300 games a day (200 left today). An invite from the host lifts this.",
    );
    expect(allowanceText({ games: 100, at_a_time: 1, games_per_day: 300, used_today: 400 })).toContain("(0 left today)");
  });
});

describe("how a paired run's games count", () => {
  // Run 7cc7910c's phase half (2026-10-23): 100 pods, 22 games cut short, 83 pods counted.
  const run = {
    level: 0.9,
    pods: 100,
    base: { games: 90, wins: 15, pending: 0 },
    variant: { games: 88, wins: 21, pending: 0 },
    paired: { pods: 83, both_won: 6, variant_only: 14, base_only: 9, neither: 54, delta_win_rate: 5 / 83, delta_ci: [-0.035, 0.153], split_builds: 0, settle_pods: 267 },
    unscored: { time_cap: 19, panic: 0, error: 3, total: 22 },
    verdict: { kind: "unclear", text: "Can't tell yet: run more games", final: true },
  } as unknown as Summary;

  it("says how many pods each list played, which are left out and which decide it", () => {
    const lines = podCountText(run, { a: "the base", b: "the changed list", finished: true });
    expect(lines[0]).toBe("Both lists played the same 100 pods (200 games), with the same opponents, seats and shuffles.");
    expect(lines[1]).toBe("22 games didn't finish (19 ran out of time, 3 stopped with an error), so 17 pods are left out: a pod counts only when both lists' games finished.");
    expect(lines[2]).toBe(
      "Of the 83 pods that count, both did the same in 60 (both won 6, neither won 54). The answer rests on the other 23: the changed list won 14 that the base lost, and the base won 9 that the changed list lost.",
    );
    const clean = { ...run, unscored: { time_cap: 0, panic: 0, error: 0, total: 0 }, paired: { ...run.paired, pods: 100 } } as Summary;
    expect(podCountText(clean, { a: "A", b: "B", finished: true })).toHaveLength(2);
  });

  it("explains what out of time means on each engine", () => {
    expect(unscoredText("phase", 600)).toContain("once it has used 10 minutes of computer time");
    expect(unscoredText("forge", 600)).toContain("Forge stops a game after 15 minutes");
  });

  it("works out the games that would settle it, allowing for pods that get lost", () => {
    // 184 more counted pods at 83 in 100 kept: 222 pods, 444 games; the smallest choice that covers it.
    expect(gamesToSettle(run, [100, 200, 400, 1000])).toEqual({ pods: 222, games: 444, pick: 1000 });
    expect(gamesToSettle(run, [100, 200, 400])?.pick).toBe(400);
    expect(gamesToSettle({ ...run, paired: { ...run.paired, settle_pods: null } } as Summary, [100])).toBeNull();
    expect(settleText(run)).toBe("If the difference stays near +6 points, about 267 counted pods would settle it (83 so far). A smaller real difference needs more; a bigger one, fewer.");
    const close = { ...run, paired: { ...run.paired, delta_win_rate: 0.01, settle_pods: null } } as Summary;
    expect(settleText(close)).toContain("thousands of games");
    expect(settleText({ ...run, verdict: { ...run.verdict, kind: "better" } } as Summary)).toBeNull();
  });
});

describe("fieldResult", () => {
  const entrant = (id: string, win_rate: number, wilson: [number, number]) => ({ id, label: id, games: 100, wins: 0, win_rate, wilson, avg_place: null, first: 0 });
  const run = (entrants: ReturnType<typeof entrant>[], kind: "better" | "unclear", games = 100) =>
    ({
      level: 0.9,
      verdict: { kind, text: "server text", is_final: true },
      versus: { pod: 4, games, pending: 0, entrants, meetings: [], filler_wins: 0, avg_turns: null },
    }) as unknown as Summary;

  it("leaves two-deck runs to their own verdict", () => {
    expect(fieldResult(run([entrant("A", 0.6, [0.5, 0.7]), entrant("B", 0.4, [0.3, 0.5])], "better"), true)).toBeNull();
  });

  it("counts the decks within the margin of the leader and lists the top three", () => {
    const r = fieldResult(
      run([entrant("C", 0.2, [0.15, 0.25]), entrant("A", 0.65, [0.6, 0.71]), entrant("B", 0.62, [0.56, 0.67]), entrant("D", 0.61, [0.55, 0.66])], "unclear"),
      true,
    )!;
    expect(r.clear).toBe(false);
    expect(r.text).toBe("No clear winner: A wins most often (wins 65%, 90% interval 60 to 71%), but 2 other decks are within the margin");
    expect(r.leaders.map((l) => l.label)).toEqual(["A", "B", "D"]);
    expect(fieldResult(run([entrant("A", 0.65, [0.6, 0.71]), entrant("B", 0.62, [0.56, 0.67]), entrant("C", 0.1, [0.05, 0.15])], "unclear"), false)!.text).toMatch(
      /^No clear winner yet: .*1 other deck is within/,
    );
  });

  it("breaks a tie for the lead as the server does, towards the later entrant", () => {
    const r = fieldResult(run([entrant("A", 0.4, [0.3, 0.5]), entrant("B", 0.4, [0.3, 0.5]), entrant("C", 0.2, [0.1, 0.3])], "unclear"), true)!;
    expect(r.text).toMatch(/^No clear winner: B wins most often/);
  });

  it("names a clear winner and leaves runs with too few games to the ordinary verdict", () => {
    expect(fieldResult(run([entrant("A", 0.6, [0.5, 0.7]), entrant("B", 0.2, [0.1, 0.3]), entrant("C", 0.2, [0.1, 0.3])], "better"), true)).toMatchObject({
      clear: true,
      text: "A wins most often, clear of the other 2 (wins 60%, 90% interval 50 to 70%)",
    });
    expect(fieldResult(run([entrant("A", 0.6, [0.5, 0.7]), entrant("B", 0.2, [0.1, 0.3]), entrant("C", 0.2, [0.1, 0.3])], "unclear", 5), true)).toBeNull();
  });
});
