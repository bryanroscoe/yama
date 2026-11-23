import { describe, expect, it } from "vitest";
import { HOLD_BUDGET, HeldRead, type HeldVerdict } from "./heldRead";

/** `n` frames read, `step` ms apart, from `from`. */
const run = (h: HeldRead, n: number, step = 200, from = 0): HeldVerdict[] => Array.from({ length: n }, (_, i) => h.frame(from + (i + 1) * step));

describe("HeldRead, the outer cap on reading a held card", () => {
  it("reads for seconds, not frames, before the close-up takes over with Close-ups on", () => {
    // Fast frames: the old six-frame budget would have handed over after 0.6 s.
    const h = new HeldRead(true, 0);
    expect(run(h, 30, 100)).not.toContain("closeup");
    expect(h.frame(HOLD_BUDGET.closeupAfterMs)).toBe("closeup");
    expect(h.summary()).toMatchObject({ ended: "closeup", why: "time", frames: 31 });
  });

  it("on a slow phone, waits for enough frames as well as the time", () => {
    const h = new HeldRead(true, 0);
    expect(run(h, HOLD_BUDGET.closeupFrames - 1, 2000)).not.toContain("closeup");
    expect(h.frame(2 * HOLD_BUDGET.closeupAfterMs - 1)).toBe("closeup");
  });

  it("keeps reading much longer with Close-ups off, then stops", () => {
    const h = new HeldRead(false, 0);
    const v = run(h, Math.floor(HOLD_BUDGET.giveUpAfterMs / 250) - 1, 250);
    expect(v).not.toContain("closeup");
    expect(v).not.toContain("stop");
    expect(h.frame(HOLD_BUDGET.giveUpAfterMs)).toBe("stop");
    expect(h.summary().why).toBe("time");
  });

  it("doesn't count blurred or washed-out frames toward the frames it waits for", () => {
    const h = new HeldRead(true, 0);
    for (let t = 100; t <= 15_000; t += 100) expect(h.skipped(t)).toBe("again");
    // Seen all along (not "away"), but nothing read yet: the close-up waits for real frames.
    expect(h.summary()).toMatchObject({ frames: 0, skipped: 150 });
    expect(run(h, HOLD_BUDGET.closeupFrames - 1, 10, 15_000)).not.toContain("closeup");
    expect(h.frame(15_100)).toBe("closeup");
  });

  it("still ends at twice the time when every frame is skipped", () => {
    const closeup = new HeldRead(true, 0);
    expect(closeup.skipped(2 * HOLD_BUDGET.closeupAfterMs - 1)).toBe("again");
    expect(closeup.skipped(2 * HOLD_BUDGET.closeupAfterMs)).toBe("closeup");
    const picker = new HeldRead(false, 0);
    expect(picker.skipped(2 * HOLD_BUDGET.giveUpAfterMs)).toBe("stop");
  });

  it("rides out a card wobbling out of view, and stops once it's gone for the away time", () => {
    const h = new HeldRead(false, 0);
    h.frame(100);
    for (let t = 300; t < 100 + HOLD_BUDGET.awayMs; t += 300) expect(h.missed(t)).toBe("again");
    const back = 100 + HOLD_BUDGET.awayMs - 50;
    expect(h.frame(back)).toBe("again");
    for (let t = back + 200; t < back + HOLD_BUDGET.awayMs; t += 300) expect(h.missed(t)).toBe("again");
    expect(h.missed(back + HOLD_BUDGET.awayMs)).toBe("stop");
    expect(h.summary()).toMatchObject({ ended: "stop", why: "away" });
  });

  it("stops at once when another card is plainly in view for a few frames in a row, not after the away time (Bryan, 22 Nov 2026)", () => {
    const h = new HeldRead(false, 0);
    h.frame(100);
    for (let i = 1; i < HOLD_BUDGET.anotherFrames; i++) expect(h.another(100 + i * 60)).toBe("again");
    expect(h.another(100 + HOLD_BUDGET.anotherFrames * 60)).toBe("stop");
    expect(h.summary()).toMatchObject({ ended: "stop", why: "another" });
    // Well inside the away time the same card is allowed.
    expect(100 + HOLD_BUDGET.anotherFrames * 60).toBeLessThan(HOLD_BUDGET.awayMs);
  });

  it("counts another card only in a row: the card back in view, or a plain miss, starts the count again", () => {
    const h = new HeldRead(false, 0);
    h.frame(100);
    let t = 100;
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < HOLD_BUDGET.anotherFrames; i++) expect(h.another((t += 60))).toBe("again");
      // The held card again (or a frame with no card at all, the card on its way back).
      expect(round === 1 ? h.missed((t += 60)) : h.frame((t += 60))).toBe("again");
    }
    expect(h.summary().ended).toBeNull();
    // Frames of another card still count as away time.
    const away = new HeldRead(false, 0);
    away.frame(0);
    for (let t2 = 60; t2 < HOLD_BUDGET.awayMs; t2 += 60) expect(t2 % 120 === 0 ? away.another(t2) : away.missed(t2)).toBe("again");
    expect(away.another(HOLD_BUDGET.awayMs)).toBe("stop");
    expect(away.summary().why).toBe("away");
  });

  it("stops after too many failed reads in a row, and a good frame resets the count", () => {
    const h = new HeldRead(false, 0);
    for (let i = 1; i < HOLD_BUDGET.failures; i++) expect(h.missed(i * 10, true)).toBe("again");
    h.frame(200);
    for (let i = 1; i < HOLD_BUDGET.failures; i++) expect(h.missed(200 + i * 10, true)).toBe("again");
    expect(h.missed(300, true)).toBe("stop");
    expect(h.summary()).toMatchObject({ why: "failures", failures: 2 * HOLD_BUDGET.failures - 1 });
  });

  it("waits longer for a card that hasn't been held up yet (a typed name), then gives up", () => {
    const h = new HeldRead(false, 0);
    for (let t = 500; t < HOLD_BUDGET.findMs; t += 500) expect(h.missed(t)).toBe("again");
    expect(h.missed(HOLD_BUDGET.findMs)).toBe("stop");
    expect(h.summary().why).toBe("never-seen");
    const seen = new HeldRead(false, 0);
    seen.frame(100);
    expect(seen.missed(100 + HOLD_BUDGET.awayMs)).toBe("stop");
  });

  it("a fresh attempt gets the whole budget again", () => {
    const first = new HeldRead(true, 0);
    const end = HOLD_BUDGET.closeupAfterMs + 2000;
    run(first, end / 250, 250);
    expect(first.summary().ended).toBe("closeup");
    // Keep reading, Wrong printing or leaving the close-up start a new HeldRead from that moment.
    const again = new HeldRead(true, end);
    expect(run(again, 20, 250, end)).not.toContain("closeup");
    expect(again.frame(end + 5100)).toBe("again");
  });

  it("answers the same once ended", () => {
    const h = new HeldRead(false, 0);
    h.frame(100);
    expect(h.missed(100 + HOLD_BUDGET.awayMs)).toBe("stop");
    expect(h.frame(9000)).toBe("stop");
  });

  // Review of #138: an error at the close-up deadline returned "closeup", which the loop ignored,
  // so a run of failing reads never ended.
  it("answers closeup (not only stop) from a failed read past the deadline, and the cap ends it whatever was said", () => {
    const h = new HeldRead(true, 0);
    run(h, 7, 1000);
    expect(h.missed(HOLD_BUDGET.closeupAfterMs + 1, true)).toBe("closeup");
    // Once ended, every call says so, and capped() does too.
    expect(h.missed(9000, true)).toBe("closeup");
    expect(h.capped(9000)).toBe("closeup");
    const never = new HeldRead(false, 0);
    for (let t = 100; t < 2 * HOLD_BUDGET.giveUpAfterMs; t += 3000) expect(never.capped(t)).toBeNull();
    expect(never.capped(2 * HOLD_BUDGET.giveUpAfterMs)).toBe("stop");
  });

  it("stops at once, to the picker and not the close-up, when frame after frame names the same printing and its twin", () => {
    // Compel Brutality, 23 Nov 2026: "0101 FRA • EN" on every frame, fra 101 and fra 101b alike.
    const h = new HeldRead(true, 0);
    const v: HeldVerdict[] = [];
    for (let i = 1; i <= HOLD_BUDGET.twinFrames; i += 1) v.push(h.frame(i * 1000, "fra-101"));
    expect(v.slice(0, -1)).not.toContain("stop");
    expect(v.at(-1)).toBe("stop");
    expect(h.summary().why).toBe("twin");
    // Frames that name another printing, or none, start the count again.
    const mixed = new HeldRead(false, 0);
    const twins = ["a", "a", "a", null, "a", "a", "a", "b", "a", "a", "a"];
    expect(twins.map((t, i) => mixed.frame((i + 1) * 200, t))).not.toContain("stop");
    expect(mixed.frame(5000, "a")).toBe("stop");
    // A blurred frame between doesn't break the run (it reads nothing).
    const blurred = new HeldRead(false, 0);
    blurred.frame(100, "a");
    blurred.frame(200, "a");
    blurred.skipped(300);
    blurred.frame(400, "a");
    expect(blurred.frame(500, "a")).toBe("stop");
  });
});
