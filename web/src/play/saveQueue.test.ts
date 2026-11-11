import { describe, expect, it } from "vitest";
import { serialQueue } from "./saveQueue";

describe("serialQueue", () => {
  it("runs saves one at a time in the order asked, so the last answer is the last stored", async () => {
    const enqueue = serialQueue();
    const stored: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    // The first save is slow; the second is asked for before it finishes.
    const first = enqueue(async () => {
      await slow;
      stored.push(2);
    });
    const second = enqueue(async () => {
      stored.push(5);
    });
    await Promise.resolve();
    expect(stored).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(stored).toEqual([2, 5]);
  });

  it("keeps going after a save fails, and tells whoever asked", async () => {
    const enqueue = serialQueue();
    const failed = enqueue(() => Promise.reject(new Error("refused")));
    const next = enqueue(async () => "saved");
    await expect(failed).rejects.toThrow("refused");
    await expect(next).resolves.toBe("saved");
  });
});
