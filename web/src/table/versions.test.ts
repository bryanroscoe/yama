import { describe, expect, it } from "vitest";
import { localDay, versionOn } from "./versions";

const v = (id: string, created_at: string) => ({ id, note: null, created_at });

describe("versionOn", () => {
  const versions = [v("v3", "2026-10-15T09:00:00"), v("v1", "2026-10-01T09:00:00"), v("v2", "2026-10-10T22:00:00")];

  it("picks the newest version saved by the end of the day", () => {
    expect(versionOn(versions, "2026-10-10")).toBe("v2");
    expect(versionOn(versions, "2026-10-14")).toBe("v2");
    expect(versionOn(versions, "2026-10-19")).toBe("v3");
  });

  it("credits no version for a game played before the deck had one", () => {
    expect(versionOn(versions, "2026-09-01")).toBeNull();
    expect(versionOn([], "2026-09-01")).toBeNull();
  });
});

describe("localDay", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 21:30 local on the 18th, wherever the test runs.
    expect(localDay(new Date(2026, 9, 18, 21, 30))).toBe("2026-10-18");
    expect(localDay(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
  });
});
