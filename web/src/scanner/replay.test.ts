import { describe, expect, it } from "vitest";
import { replayFrames, type DiagnosticRecord } from "./replay";

const options = [
  { id: "woc", set: "woc", number: "145", rarity: "common", lang: "en", released_at: "2023-09-08" },
  { id: "cmm", set: "cmm", number: "390", rarity: "common", lang: "en", released_at: "2023-08-04" },
  { id: "c21", set: "c21", number: "236", rarity: "common", lang: "en", released_at: "2021-04-23" },
];
const rec = (frames: { t: number; source: string; reads: string[]; skipped?: boolean }[]): DiagnosticRecord => ({ outcome: "picked", detail: { options, frames, final: { id: "woc", how: "picked" } } });

describe("replaying a diagnostic record", () => {
  it("settles where the recorded frames add up, and says on which frame", () => {
    const r = rec([
      { t: 0, source: "first", reads: ["0145 C", ""] },
      { t: 300, source: "hold", reads: [], skipped: true },
      { t: 600, source: "hold", reads: ["", "WOC • EN"] },
    ]);
    expect(replayFrames(r)).toEqual({ settled: "woc", frame: 2, frames: 2 });
  });

  it("leaves unsettled what never adds up, and counts only frames read", () => {
    const r = rec([
      { t: 0, source: "first", reads: ["W0C"] },
      { t: 300, source: "hold", reads: [""] },
      { t: 600, source: "hold", reads: ["O14S"] },
    ]);
    expect(replayFrames(r)).toEqual({ settled: null, frame: null, frames: 2 });
  });
});
