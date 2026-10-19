import { describe, expect, it } from "vitest";
import { versionOn } from "./versions";

const v = (id: string, created_at: string) => ({ id, note: null, created_at });

describe("versionOn", () => {
  const versions = [v("v3", "2026-10-15T09:00:00"), v("v1", "2026-10-01T09:00:00"), v("v2", "2026-10-10T22:00:00")];

  it("picks the newest version saved by the end of the day", () => {
    expect(versionOn(versions, "2026-10-10")).toBe("v2");
    expect(versionOn(versions, "2026-10-14")).toBe("v2");
    expect(versionOn(versions, "2026-10-19")).toBe("v3");
  });

  it("falls back to the first version for a game before the deck was added", () => {
    expect(versionOn(versions, "2026-09-01")).toBe("v1");
    expect(versionOn([], "2026-09-01")).toBeNull();
  });
});
