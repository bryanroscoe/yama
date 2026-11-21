import { describe, expect, it } from "vitest";
import { cardSpeed, GATE_DEFAULTS, Motion, PlacementGate, thumbLikeness, THUMB_SIDE, type GateCard, type GateDecision } from "./gate";
import type { Quad } from "./types";

// The placement gate (gate.ts): a card is read when it has come to rest, once, from the sharpest
// frame of its stay; five tries, then "No match"; and the same card isn't reported twice in 3 s
// unless it left. Fed here as the native camera will feed it: times and corners, nothing else.

const card = (x: number, y: number, w = 200, h = 280): Quad => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
/** A thumbnail with its own pattern: `seed` picks the card, `gain` and `lift` the light it's seen in. */
const thumb = (seed: number, gain = 1, lift = 0): Uint8Array => {
  const t = new Uint8Array(THUMB_SIDE * THUMB_SIDE);
  let s = seed >>> 0;
  for (let i = 0; i < t.length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    t[i] = Math.min(255, Math.max(0, (40 + (s >>> 24) / 2) * gain + lift));
  }
  return t;
};
type Frame = string;
const seen = (quad: Quad, opts: Partial<GateCard<Frame>> = {}): GateCard<Frame> => ({ quad, thumb: thumb(1), ...opts });

/** A gate with a clock: `pass` is one pass of the finder, 33 ms after the last. */
function bench(options = {}) {
  const gate = new PlacementGate<Frame>(options);
  let at = 0;
  const pass = (c: GateCard<Frame> | null, ms = 33): GateDecision<Frame> => {
    at += ms;
    return gate.observe({ at, cards: c ? [c] : [] });
  };
  /** Passes of a card at rest until the gate asks for a read (or `limit` passes). */
  const untilRead = (c: () => GateCard<Frame>, limit = 20) => {
    for (let i = 0; i < limit; i += 1) {
      const d = pass(c());
      if (d.kind === "read") return d;
    }
    throw new Error("the gate never asked for a read");
  };
  return { gate, pass, untilRead, now: () => at, wait: (ms: number) => (at += ms) };
}

describe("moving or still", () => {
  it("measures speed in the card's own short sides a second, by the corner that moved furthest", () => {
    // 20 px in 100 ms on a card 200 px across: one short side a second.
    expect(cardSpeed({ at: 0, quad: card(0, 0) }, { at: 100, quad: card(20, 0) })).toBeCloseTo(1, 5);
    // The finder calling another corner the top isn't movement.
    const q = card(0, 0);
    expect(cardSpeed({ at: 0, quad: q }, { at: 100, quad: [q[2], q[3], q[0], q[1]] })).toBe(0);
    // A tilt moves two corners though the centre stays.
    expect(cardSpeed({ at: 0, quad: q }, { at: 100, quad: [[0, 0], [200, 30], [200, 310], [0, 280]] })).toBeGreaterThan(1);
    expect(cardSpeed({ at: 100, quad: q }, { at: 100, quad: q })).toBe(Infinity);
  });

  it("can't call a card still until it has been watched for the window, nor from a stale sighting", () => {
    const m = new Motion();
    expect(m.speed(0, card(0, 0))).toBeNull();
    expect(m.speed(50, card(0, 0))).toBeNull();
    expect(m.speed(100, card(0, 0))).toBe(0);
    // Measured against the newest sighting at least 100 ms old.
    expect(m.speed(150, card(10, 0))).toBeCloseTo(0.5, 5);
    // The finder stalled for a second: nothing recent enough to measure from.
    expect(m.speed(1200, card(10, 0))).toBeNull();
    expect(m.speed(1300, card(10, 0))).toBe(0);
  });

  it("says moving while the card moves, and reads nothing", () => {
    const { pass } = bench();
    const kinds: string[] = [];
    for (let i = 0; i < 12; i += 1) kinds.push(pass(seen(card(i * 15, 0))).kind);
    expect(new Set(kinds)).toEqual(new Set(["moving"]));
  });

  it("ends a placement the moment the card moves again", () => {
    const { pass, untilRead, gate } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.missed(0);
    expect(pass(seen(card(60, 0))).kind).toBe("moving");
    expect(gate.attempts).toBe(0);
  });
});

describe("a placement", () => {
  it("waits briefly for a sharper frame and reads the sharpest of them", () => {
    const { pass } = bench();
    // Coming to rest: the first passes can't be called still yet.
    expect(pass(seen(card(0, 0), { sharpness: 10, frame: "a" })).kind).toBe("moving");
    expect(pass(seen(card(0, 0), { sharpness: 10, frame: "b" })).kind).toBe("moving");
    expect(pass(seen(card(0, 0), { sharpness: 10, frame: "c" })).kind).toBe("moving");
    expect(pass(seen(card(0, 0), { sharpness: 10, frame: "c2" })).kind).toBe("moving");
    // Still from here (a sighting 100 ms old to measure from): two frames waited on, the third read.
    expect(pass(seen(card(0, 0), { sharpness: 40, frame: "d" })).kind).toBe("steadying");
    expect(pass(seen(card(0, 0), { sharpness: 90, frame: "e" })).kind).toBe("steadying");
    const d = pass(seen(card(1, 0), { sharpness: 60, frame: "f" }));
    expect(d).toMatchObject({ kind: "read", attempt: 1, frame: "e", sharpness: 90 });
    // The quad is the sharpest frame's own.
    expect(d.kind === "read" && d.quad).toEqual(card(0, 0));
  });

  it("reads a frame that is sharp enough at once, when the source says what that is", () => {
    const { pass } = bench({ sharpEnough: 80 });
    for (let i = 0; i < 4; i += 1) pass(seen(card(0, 0), { sharpness: 10 }));
    expect(pass(seen(card(0, 0), { sharpness: 85, frame: "sharp" }))).toMatchObject({ kind: "read", frame: "sharp" });
  });

  it("doesn't ask again while a read is out", () => {
    const { pass, untilRead } = bench();
    untilRead(() => seen(card(0, 0)));
    expect(pass(seen(card(0, 0))).kind).toBe("reading");
    expect(pass(seen(card(0, 0))).kind).toBe("reading");
  });

  it("tries again 50 ms after a miss, from the sharpest frame since, up to five times, then says No match", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0), { frame: "first" }));
    for (let attempt = 2; attempt <= GATE_DEFAULTS.maxAttempts; attempt += 1) {
      gate.missed(now());
      // 33 ms later is too soon; 66 ms is not.
      expect(pass(seen(card(0, 0), { sharpness: 5, frame: `dull${attempt}` })).kind).toBe("steadying");
      const d = pass(seen(card(0, 0), { sharpness: 50, frame: `sharp${attempt}` }));
      expect(d).toMatchObject({ kind: "read", attempt, frame: `sharp${attempt}` });
    }
    gate.missed(now());
    for (let i = 0; i < 10; i += 1) expect(pass(seen(card(0, 0))).kind).toBe("no-match");
    // Moved, as it asks: a new placement, with its five tries again.
    for (let i = 1; i <= 4; i += 1) pass(seen(card(i * 40, 0)));
    const again = untilRead(() => seen(card(160, 0)));
    expect(again).toMatchObject({ kind: "read", attempt: 1 });
  });

  it("doesn't count a read that was dropped unanswered", () => {
    const { pass, untilRead, gate } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.dropped();
    expect(gate.attempts).toBe(0);
    expect(pass(seen(card(0, 0))).kind).not.toBe("reading");
    expect(untilRead(() => seen(card(0, 0)))).toMatchObject({ kind: "read", attempt: 1 });
  });

  it("goes by the largest card when the finder sees several", () => {
    const { pass } = bench();
    let d: GateDecision<Frame> = { kind: "none" };
    const gate = new PlacementGate<Frame>();
    for (let at = 0; at <= 400; at += 33) d = gate.observe({ at, cards: [seen(card(600, 0, 80, 112), { frame: "small" }), seen(card(0, 0), { frame: "large" })] });
    expect(pass(null).kind).toBe("none");
    expect(["read", "reading"]).toContain(d.kind);
    expect(PlacementGate.primary([seen(card(600, 0, 80, 112), { frame: "small" }), seen(card(0, 0), { frame: "large" })])?.frame).toBe("large");
    expect(PlacementGate.primary([])).toBeNull();
  });
});

describe("a card that was read stays read", () => {
  it("is latched for as long as it lies there", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    expect(gate.named("Sol Ring", now())).toBe(true);
    for (let i = 0; i < 200; i += 1) expect(pass(seen(card(0, 0)))).toMatchObject({ kind: "latched", key: "Sol Ring" });
  });

  it("stays latched through a missed pass, a nudge and a change of light, by its thumbnail", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    // The finder misses it for two passes: not gone.
    expect(pass(null).kind).toBe("none");
    expect(pass(null).kind).toBe("none");
    expect(pass(seen(card(0, 0))).kind).not.toBe("read");
    // Nudged across the table, in a brighter frame: the same card when it comes to rest.
    const kinds: string[] = [];
    for (let i = 1; i <= 5; i += 1) kinds.push(pass(seen(card(i * 30, 0), { thumb: thumb(1, 1.3, 12) })).kind);
    for (let i = 0; i < 8; i += 1) kinds.push(pass(seen(card(150, 0), { thumb: thumb(1, 1.3, 12) })).kind);
    expect(kinds).toContain("moving");
    expect(kinds).not.toContain("read");
    expect(kinds[kinds.length - 1]).toBe("latched");
  });

  it("reads another card put in its place at once, with no empty view between, and says the latch is over", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    pass(seen(card(0, 0)));
    // Another card slid over it and came to rest.
    for (let i = 1; i <= 4; i += 1) pass(seen(card(i * 25, 0), { thumb: thumb(2) }));
    const decisions: GateDecision<Frame>[] = [];
    for (let i = 0; i < 8; i += 1) decisions.push(pass(seen(card(100, 0), { thumb: thumb(2), frame: "other" })));
    const read = decisions.find((d) => d.kind === "read");
    expect(read).toMatchObject({ kind: "read", attempt: 1, frame: "other" });
    expect(decisions.filter((d) => d.released)).toHaveLength(1);
    expect(decisions.findIndex((d) => d.released)).toBeLessThanOrEqual(decisions.indexOf(read!));
  });

  it("is let go when the view has been empty long enough, and the same card set down again is read again", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    const gone: GateDecision<Frame>[] = [];
    for (let i = 0; i < 12; i += 1) gone.push(pass(null));
    expect(gone.filter((d) => d.released)).toHaveLength(1);
    // Before it left, `since` says when it appeared; once it has left there is none.
    expect(gone[0]!.since).toBeDefined();
    expect(gone[gone.length - 1]!.since).toBeUndefined();
    // A second copy of the same card: the same thumbnail, read again, and reported (it left the view).
    const d = untilRead(() => seen(card(0, 0)));
    expect(d.kind).toBe("read");
    expect(gate.named("Sol Ring", now())).toBe(true);
  });

  it("without thumbnails takes the card at rest for the same one", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => ({ quad: card(0, 0) }));
    gate.named("Sol Ring", now());
    for (let i = 1; i <= 4; i += 1) pass({ quad: card(i * 25, 0) });
    for (let i = 0; i < 6; i += 1) expect(pass({ quad: card(100, 0) }).kind).not.toBe("read");
  });

  it("can be let go from outside, to read the card lying there once more", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    expect(pass(seen(card(0, 0))).kind).toBe("latched");
    gate.unlatch();
    const d = untilRead(() => seen(card(0, 0)));
    expect(d).toMatchObject({ kind: "read", attempt: 1 });
    expect(d.released).toBeUndefined();
    // Asked for, so it's reported though under 3 s have passed.
    expect(gate.named("Sol Ring", now())).toBe(true);
  });
});

describe("the same card within three seconds", () => {
  it("isn't reported again unless it left the view", () => {
    const { pass, untilRead, gate, now, wait } = bench();
    untilRead(() => seen(card(0, 0)));
    expect(gate.named("Sol Ring", now())).toBe(true);
    // Its thumbnail changed beyond recognition (a hand's shadow): read again, the same card.
    for (let i = 1; i <= 4; i += 1) pass(seen(card(i * 25, 0), { thumb: thumb(3) }));
    untilRead(() => seen(card(100, 0), { thumb: thumb(3) }));
    expect(gate.suppresses("Sol Ring", now())).toBe(true);
    expect(gate.suppresses("Arcane Signet", now())).toBe(false);
    expect(gate.named("Sol Ring", now())).toBe(false);
    // Latched again all the same.
    expect(pass(seen(card(100, 0), { thumb: thumb(3) })).kind).toBe("latched");
    // After three seconds it would be reported.
    wait(GATE_DEFAULTS.suppressMs);
    expect(gate.suppresses("Sol Ring", now())).toBe(false);
  });

  it("is reported again at once after leaving the view", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    for (let i = 0; i < 12; i += 1) pass(null);
    untilRead(() => seen(card(0, 0)));
    expect(gate.suppresses("Sol Ring", now())).toBe(false);
  });
});

describe("thumbnails", () => {
  it("are the same card under another light, and not another card", () => {
    expect(thumbLikeness(thumb(1), thumb(1))).toBeCloseTo(1, 5);
    expect(thumbLikeness(thumb(1), thumb(1, 0.6, 30))).toBeGreaterThan(0.95);
    expect(Math.abs(thumbLikeness(thumb(1), thumb(2)))).toBeLessThan(0.2);
    // Nothing to go by: a flat thumbnail, or sizes that differ.
    expect(thumbLikeness(new Uint8Array(THUMB_SIDE * THUMB_SIDE).fill(90), thumb(1))).toBe(0);
    expect(thumbLikeness(thumb(1), new Uint8Array(10))).toBe(0);
  });
});

describe("starting over", () => {
  it("forgets the latch and the placement on reset", () => {
    const { pass, untilRead, gate, now } = bench();
    untilRead(() => seen(card(0, 0)));
    gate.named("Sol Ring", now());
    gate.reset();
    expect(gate.suppresses("Sol Ring", now())).toBe(false);
    const d = untilRead(() => seen(card(0, 0)));
    expect(d).toMatchObject({ kind: "read", attempt: 1 });
    expect(d.released).toBeUndefined();
    expect(pass(seen(card(0, 0))).kind).toBe("reading");
  });
});
