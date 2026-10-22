import { describe, expect, it } from "vitest";
import type { ExperimentDetail, Pace, Summary } from "./api";
import { engineFields, engineLine, engineState, engineText, forgeSeconds, halfOf } from "./engines";

const summary = (engine: string, wins: number): Summary =>
  ({
    level: 0.9,
    pods: 5,
    base: { games: 5, wins, win_rate: wins / 5, wilson: [0, 1], avg_place: 2, ends: { win: 5 }, pending: 0 },
    variant: { games: 5, wins, win_rate: wins / 5, wilson: [0, 1], avg_place: 2, ends: { win: 5 }, pending: 0 },
    paired: { pods: 5, both_won: 0, variant_only: 0, base_only: 0, neither: 5, delta_win_rate: 0, delta_ci: [-0.1, 0.1], delta_avg_place: 0, delta_avg_place_ci: null, split_builds: 0 },
    unscored: { time_cap: 0, panic: 0, error: 0, total: 0 },
    no_winner: { draw: 0, turn_cap: 0, action_cap: 0, total: 0 },
    builds: [{ engine, card_data: "c", runner: "r", games: 10 }],
    verdict: { kind: "unclear", text: "Can't tell yet", final: true },
    method: "",
  }) as Summary;

describe("engine choice", () => {
  it("sends only what the server needs", () => {
    const phase = engineState();
    expect(engineFields(phase)).toEqual({ difficulty: "Easy" });
    const both = engineState({ difficulty: "Medium", engines: { mode: "both", forge_ai: "Reckless" } });
    expect(engineFields(both)).toEqual({ difficulty: "Medium", engine: "both", forge_ai: "Reckless" });
    expect(engineText(phase)).toBe("Easy AI");
    expect(engineText({ ...both, mode: "forge" })).toBe("Forge's Reckless AI");
    expect(engineText(both)).toBe("Medium AI on phase and Forge's Reckless AI");
  });

  it("estimates Forge time from its game length and slots, rounded up to 5 minutes", () => {
    const pace = { forge_seconds_per_game: 240, forge: { slots: 3 } } as unknown as Pace;
    expect(forgeSeconds(pace, 100)).toBe(8100);
    expect(forgeSeconds(undefined, 100)).toBeNull();
    expect(forgeSeconds({ ...pace, forge_seconds_per_game: null } as Pace, 100)).toBeNull();
  });
});

describe("a run on both engines", () => {
  const run = {
    id: "x",
    name: "n",
    status: "running",
    error: null,
    label: { simulated: true, engine: "phase-rs v1, forge 9.9", card_data: "c", runner: "r", builds: [], difficulty: "Easy", games: 200, pod: 4, created_at: "", started_at: null, finished_at: null, updated_at: "" },
    progress: { done: 130, total: 200, eta_seconds: null, games_ahead: null },
    base: null,
    variant: null,
    field: null,
    summary: summary("phase-rs v1", 2),
    summary_forge: summary("forge 9.9", 3),
    engines: { mode: "both", forge_ai: "Default" },
    forge_games: { done: 30, total: 100 },
  } as unknown as ExperimentDetail;

  it("splits into halves that read like runs of their own", () => {
    const phase = halfOf(run, "phase");
    expect(phase.progress).toMatchObject({ done: 100, total: 100 });
    expect(phase.label.engine).toBe("phase-rs v1");
    expect(phase.summary?.base.wins).toBe(2);
    const forge = halfOf(run, "forge");
    expect(forge.progress).toMatchObject({ done: 30, total: 100 });
    expect(forge.label).toMatchObject({ engine: "forge 9.9", difficulty: "Default", games: 100 });
    expect(forge.summary?.base.wins).toBe(3);
  });

  it("says which engines played", () => {
    expect(engineLine(run)).toBe("On phase (Easy AI) and Forge (Default AI), side by side");
    expect(engineLine({ ...run, engines: undefined })).toBe("On phase, Easy AI");
  });
});
