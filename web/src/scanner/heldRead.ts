// Reading the printing while the card is held (Bryan, 15 Nov 2026: "I want to just hold and scan
// the card and get all the details of the card... I don't want to have to move the card"). When
// several printings fit and the first read of the collector line didn't settle it, the scanner
// keeps reading the line from new full-resolution frames of the whole card, rather than asking
// for the close-up box at once. Which printing the reads point to is weighed in evidence.ts; this
// is the outer cap: when to hand over to the close-up box or the picker, and when the card has gone.
//
// The budgets are time, not frames (Bryan, 15 Nov 2026: "the printing read gives up too early";
// frame rate differs by phone and by text reader). The first numbers (6 frames to the close-up,
// 40 to give up, 4 missed frames to stop) came to one to two seconds, ten at most, and under a
// second without the card on a phone reading three crops a frame. These are guesses too
// [inferred], to retune from real attempts (docs/scanner.md).
//
// Longer since 21 Nov 2026 (Bryan: "it also seems to give up really fast"): the card can leave
// the finder's view for 6 s, not 2.5 s, while it's brought close to read its corner (the art half
// out of the frame isn't found as the card), and the close-up box waits 12 s, not 8 s.

export interface HoldBudget {
  /** With Close-ups on: read this long (and at least `closeupFrames`) before the close-up box takes over. */
  closeupAfterMs: number;
  closeupFrames: number;
  /** With Close-ups off: read this long (and at least `giveUpFrames`) before leaving it to the picker. */
  giveUpAfterMs: number;
  giveUpFrames: number;
  /** Without the card in view (or with another card) this long, the attempt stops. */
  awayMs: number;
  /**
   * At the start, how long to wait for the card to come into view at all (a typed name: the card
   * may not be held up yet). The away time counts only once it has been seen.
   */
  findMs: number;
  /** Reads that fail (an error, not an empty read) this many times in a row stop it too. */
  failures: number;
}

/** Every hold-and-read time and count, in one place. */
export const HOLD_BUDGET: HoldBudget = {
  closeupAfterMs: 12_000,
  closeupFrames: 6,
  giveUpAfterMs: 25_000,
  giveUpFrames: 12,
  awayMs: 6_000,
  findMs: 10_000,
  failures: 8,
};

export type HeldVerdict = "again" | "closeup" | "stop";

/** How an attempt ended. */
export interface HeldSummary {
  /** Frames read. */
  frames: number;
  /** Frames skipped before reading: too blurred or washed out (quality.ts). */
  skipped: number;
  misses: number;
  failures: number;
  ms: number;
  ended: HeldVerdict | null;
  why?: "away" | "failures" | "time" | "never-seen";
}

export class HeldRead {
  private frames = 0;
  private skips = 0;
  private misses = 0;
  private failedInARow = 0;
  private failures = 0;
  private lastSeen: number;
  private ended: HeldVerdict | null = null;
  private why: HeldSummary["why"];
  private latest: number;
  private seen = false;

  /** `start`: when the attempt began, in ms (performance.now or Date.now; the same clock for every call). */
  constructor(
    private readonly closeups: boolean,
    private readonly start: number,
    private readonly budget: HoldBudget = HOLD_BUDGET,
  ) {
    this.lastSeen = start;
    this.latest = start;
  }

  private end(v: HeldVerdict, why?: HeldSummary["why"]): HeldVerdict {
    if (v !== "again") {
      this.ended = v;
      this.why = why;
    }
    return v;
  }

  /**
   * The time budget, checked on every frame, seen or not. The frame counts keep a slow phone
   * reading long enough; at twice the time it's over whatever the count (every frame skipped as
   * blurred, say).
   */
  private timeUp(now: number): HeldVerdict {
    const ms = now - this.start;
    const b = this.budget;
    if (this.closeups && ms >= b.closeupAfterMs && (this.frames >= b.closeupFrames || ms >= 2 * b.closeupAfterMs)) return this.end("closeup", "time");
    if (ms >= b.giveUpAfterMs && (this.frames >= b.giveUpFrames || ms >= 2 * b.giveUpAfterMs)) return this.end("stop", "time");
    return "again";
  }

  /** One frame of the card read (its reads go to evidence.ts, which settles the printing). */
  frame(now: number): HeldVerdict {
    if (this.ended) return this.ended;
    this.latest = now;
    this.lastSeen = now;
    this.seen = true;
    this.failedInARow = 0;
    this.frames += 1;
    return this.timeUp(now);
  }

  /**
   * A frame with the card in view but too blurred or washed out to read: the card is still there,
   * but the frame doesn't count toward the frames the close-up and the picker wait for.
   */
  skipped(now: number): HeldVerdict {
    if (this.ended) return this.ended;
    this.latest = now;
    this.lastSeen = now;
    this.seen = true;
    this.skips += 1;
    return this.timeUp(now);
  }

  /** A frame where the card wasn't seen (or another card was), or, with `failed`, a read that failed. */
  missed(now: number, failed = false): HeldVerdict {
    if (this.ended) return this.ended;
    this.latest = now;
    this.misses += 1;
    if (failed) {
      this.failures += 1;
      this.failedInARow += 1;
      if (this.failedInARow >= this.budget.failures) return this.end("stop", "failures");
    }
    if (!this.seen) return now - this.start >= this.budget.findMs ? this.end("stop", "never-seen") : "again";
    if (now - this.lastSeen >= this.budget.awayMs) return this.end("stop", "away");
    return this.timeUp(now);
  }

  /**
   * Past twice the attempt's time: over, whatever the frames said (an attempt whose every read
   * failed, or every frame skipped). The verdict to act on, or null while there's time.
   */
  capped(now: number): Exclude<HeldVerdict, "again"> | null {
    if (this.ended) return this.ended === "again" ? null : this.ended;
    const ms = now - this.start;
    if (this.closeups && ms >= 2 * this.budget.closeupAfterMs) return this.end("closeup", "time") as "closeup";
    if (ms >= 2 * this.budget.giveUpAfterMs) return this.end("stop", "time") as "stop";
    return null;
  }

  summary(): HeldSummary {
    return { frames: this.frames, skipped: this.skips, misses: this.misses, failures: this.failures, ms: Math.round(this.latest - this.start), ended: this.ended, why: this.why };
  }
}
