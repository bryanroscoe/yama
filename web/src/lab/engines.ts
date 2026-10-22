// Engines for Lab runs: phase (Yama's own rules engine), Forge (a separate worker), or both side by
// side. Pure helpers for the run pages, kept apart from the components so they can be tested.

import type { EngineMode, Engines, ExperimentDetail, ExperimentItem, Pace } from "./api";

/** The engine choice on a run page: which engines play, and each one's AI. */
export interface EngineState {
  mode: EngineMode;
  /** phase's AI level (Easy or Medium). */
  difficulty: string;
  /** Forge's AI profile. */
  forgeAi: string;
}

export function engineState(prefill?: { difficulty?: string; engines?: Engines }): EngineState {
  return {
    mode: prefill?.engines?.mode ?? "phase",
    difficulty: prefill?.difficulty === "Medium" ? "Medium" : "Easy",
    forgeAi: prefill?.engines?.forge_ai ?? "Default",
  };
}

/** The request fields for an engine choice. */
export function engineFields(e: EngineState): { difficulty: string; engine?: EngineMode; forge_ai?: string } {
  return e.mode === "phase" ? { difficulty: e.difficulty } : { difficulty: e.difficulty, engine: e.mode, forge_ai: e.forgeAi };
}

/** "Easy AI", "Forge's Default AI", or "Easy AI on phase and Forge's Default AI". */
export function engineText(e: EngineState): string {
  if (e.mode === "phase") return `${e.difficulty} AI`;
  if (e.mode === "forge") return `Forge's ${e.forgeAi} AI`;
  return `${e.difficulty} AI on phase and Forge's ${e.forgeAi} AI`;
}

/** Rough time for the Forge games of a run: their length spread over the worker's slots. */
export function forgeSeconds(pace: Pace | undefined, games: number): number | null {
  const per = pace?.forge_seconds_per_game;
  const slots = pace?.forge?.slots ?? 0;
  if (!per || slots <= 0) return null;
  return Math.ceil((games * per) / slots / 300) * 300;
}

/** Which engines a run uses; runs from before Forge use phase. */
export function enginesOf(e: ExperimentItem): Engines {
  return e.engines ?? { mode: "phase" };
}

/** "On phase", "On Forge (Default AI)" or "On phase and Forge, side by side". */
export function engineLine(e: ExperimentItem): string {
  const en = enginesOf(e);
  if (en.mode === "forge") return `On Forge, ${en.forge_ai ?? "Default"} AI`;
  if (en.mode === "both") return `On phase (${e.label.difficulty} AI) and Forge (${en.forge_ai ?? "Default"} AI), side by side`;
  return `On phase, ${e.label.difficulty} AI`;
}

/** One engine's half of a "both" run, shaped like a run of its own so the result views show it. */
export function halfOf(e: ExperimentDetail, half: "phase" | "forge"): ExperimentDetail {
  const s = half === "phase" ? e.summary : (e.summary_forge ?? null);
  const fg = e.forge_games ?? { done: 0, total: 0 };
  const done = half === "forge" ? fg.done : e.progress.done - fg.done;
  const total = half === "forge" ? fg.total : e.progress.total - fg.total;
  const builds = s?.builds ?? [];
  const engines = [...new Set(builds.map((b) => b.engine))];
  return {
    ...e,
    summary: s,
    label: {
      ...e.label,
      engine: engines.length ? engines.join(", ") : half === "forge" ? "forge" : e.label.engine.split(", ")[0]!,
      difficulty: half === "forge" ? (enginesOf(e).forge_ai ?? "Default") : e.label.difficulty,
      builds,
      games: total,
    },
    progress: { ...e.progress, done, total },
  };
}

