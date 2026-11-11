import { describe, expect, it } from "vitest";
import { lastSetupKey, readLastSetup, writeLastSetup } from "./lastSetup";

function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const setup = (first: string | undefined, name: string) => ({ seats: [{ userId: first, name }, { name: "Guest" }], groupId: "g1", life: 40, phones: "one" });

describe("the last table setup on a device", () => {
  it("is kept apart for each account and for a guest", () => {
    const s = storage();
    writeLastSetup(s, "alice", setup("alice", "Alice"));
    writeLastSetup(s, null, setup(undefined, "Me"));
    expect(readLastSetup(s, "alice")?.seats?.[0]).toMatchObject({ name: "Alice" });
    expect(readLastSetup(s, null)?.seats?.[0]).toMatchObject({ name: "Me" });
    // The next account to sign in on this device starts from empty seats.
    expect(readLastSetup(s, "bob")).toBeNull();
    expect(lastSetupKey("alice")).not.toBe(lastSetupKey("bob"));
    expect(lastSetupKey(undefined)).toBe("yama.table.lastSetup.guest");
  });

  it("gives a setup saved under the old shared key only to the account in its first seat", () => {
    const s = storage({ "yama.table.lastSetup": JSON.stringify(setup("alice", "Alice")) });
    expect(readLastSetup(s, "bob")).toBeNull();
    expect(readLastSetup(s, null)).toBeNull();
    expect(s.m.has("yama.table.lastSetup")).toBe(true);
    expect(readLastSetup(s, "alice")?.groupId).toBe("g1");
    // Moved to Alice's own key, so it is nobody else's afterwards.
    expect(s.m.has("yama.table.lastSetup")).toBe(false);
    expect(readLastSetup(s, "alice")?.groupId).toBe("g1");
    expect(readLastSetup(s, "bob")).toBeNull();
  });

  it("reads nothing from a broken or blocked store", () => {
    expect(readLastSetup(storage({ [lastSetupKey("alice")]: "{not json" }), "alice")).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(readLastSetup(blocked, "alice")).toBeNull();
    expect(() => writeLastSetup(blocked, "alice", {})).not.toThrow();
  });
});
