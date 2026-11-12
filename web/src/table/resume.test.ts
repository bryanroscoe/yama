import { describe, expect, it } from "vitest";
import { lastTouched, resumesOnOpen, RESUME_WITHIN_MS } from "./resume";

const at = (iso: string) => Date.parse(iso);
const game = (startedAt: string, touched: string[] = []) => ({ setup: { startedAt } as never, log: touched.map((t, i) => ({ seq: i + 1, at: t, event: { type: "pass" } as never })) });

describe("opening Yama on a game in progress", () => {
  it("goes by when the game was last touched, not when it started", () => {
    const g = game("2026-11-12T01:00:00Z", ["2026-11-12T01:30:00Z", "2026-11-12T03:00:00Z"]);
    expect(lastTouched(g)).toBe(at("2026-11-12T03:00:00Z"));
    expect(lastTouched(game("2026-11-12T01:00:00Z"))).toBe(at("2026-11-12T01:00:00Z"));
  });

  it("opens on a game touched within a long game night, and leaves an older one on Home", () => {
    const g = game("2026-11-12T01:00:00Z", ["2026-11-12T03:00:00Z"]);
    expect(resumesOnOpen(g, at("2026-11-12T03:05:00Z"))).toBe(true);
    expect(resumesOnOpen(g, at("2026-11-12T03:00:00Z") + RESUME_WITHIN_MS)).toBe(true);
    expect(resumesOnOpen(g, at("2026-11-12T03:00:00Z") + RESUME_WITHIN_MS + 1)).toBe(false);
    expect(resumesOnOpen(g, at("2026-11-20T03:00:00Z"))).toBe(false);
  });

  it("has nothing to open on without a game, or with one whose times can't be read", () => {
    expect(resumesOnOpen(null, at("2026-11-12T03:00:00Z"))).toBe(false);
    expect(resumesOnOpen(undefined, at("2026-11-12T03:00:00Z"))).toBe(false);
    expect(resumesOnOpen(game("not a date"), at("2026-11-12T03:00:00Z"))).toBe(false);
    // A device clock set back since the last touch: the game is still the one being played.
    expect(resumesOnOpen(game("2026-11-12T03:00:00Z"), at("2026-11-12T02:00:00Z"))).toBe(true);
  });
});
