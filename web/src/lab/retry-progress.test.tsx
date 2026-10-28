import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Progress } from "./Run";
import type { ExperimentDetail } from "./api";

describe("slow Phase retry progress", () => {
  it("explains retry-only progress without a fast-game ETA", () => {
    const e = {
      status: "running", engines: { mode: "phase" },
      progress: { done: 9489, total: 9500, eta_seconds: null, games_ahead: 0, phase_pending: 11, phase_retries: 11 },
    } as ExperimentDetail;
    const html = renderToStaticMarkup(<Progress e={e} />);
    expect(html).toContain("finishing slow Phase retries");
    expect(html).toContain("including 11 retries");
    expect(html).toContain("no ETA is shown");
    expect(html).not.toContain("working out how long");
  });
  it("labels a completed Phase half while Forge continues", () => {
    const e = {
      status: "running", engines: { mode: "both" }, forge_games: { done: 20, total: 100 },
      progress: { done: 120, total: 200, eta_seconds: null, games_ahead: null, phase_pending: 0, phase_retries: 0 },
    } as ExperimentDetail;
    const html = renderToStaticMarkup(<Progress e={e} />);
    expect(html).toContain("Phase finished; Forge continuing");
    expect(html).not.toContain("working out how long");
  });
});
