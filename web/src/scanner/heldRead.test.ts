import { describe, expect, it } from "vitest";
import { AGREE, AWAY, CLOSEUP_AFTER, GIVE_UP_AFTER, HeldRead, type HeldVerdict } from "./heldRead";

const run = (h: HeldRead, ids: (string | null)[]): HeldVerdict[] => ids.map((id) => h.frame(id));

describe("HeldRead", () => {
  it("settles when the same printing is read in AGREE frames", () => {
    const v = run(new HeldRead(false), Array(AGREE).fill("a"));
    expect(v.slice(0, -1).every((x) => x === "again")).toBe(true);
    expect(v.at(-1)).toBe("settled");
  });

  it("does not let empty frames break a run", () => {
    expect(run(new HeldRead(false), ["a", null, "a", null, "a"]).at(-1)).toBe("settled");
  });

  it("starts a new run when another printing is read", () => {
    const h = new HeldRead(false);
    expect(run(h, ["a", "a", "b", "a", "a"])).not.toContain("settled");
    expect(h.frame("a")).toBe("settled");
  });

  it("hands over to the close-up box after CLOSEUP_AFTER frames with Close-ups on", () => {
    const v = run(new HeldRead(true), Array(CLOSEUP_AFTER).fill(null));
    expect(v.at(-1)).toBe("closeup");
    expect(v.slice(0, -1)).not.toContain("closeup");
  });

  it("settles on the frame that would have opened the close-up", () => {
    const h = new HeldRead(true);
    run(h, Array(CLOSEUP_AFTER - AGREE).fill(null));
    expect(run(h, Array(AGREE).fill("a")).at(-1)).toBe("settled");
  });

  it("keeps reading much longer with Close-ups off, then stops", () => {
    const v = run(new HeldRead(false), Array(GIVE_UP_AFTER).fill(null));
    expect(v).not.toContain("closeup");
    expect(v.at(-1)).toBe("stop");
    expect(v.slice(0, -1).every((x) => x === "again")).toBe(true);
  });

  it("stops when the card is gone for AWAY frames in a row", () => {
    const h = new HeldRead(false);
    for (let i = 1; i < AWAY; i++) expect(h.missed()).toBe("again");
    h.frame(null);
    for (let i = 1; i < AWAY; i++) expect(h.missed()).toBe("again");
    expect(h.missed()).toBe("stop");
  });
});
