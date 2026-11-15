import { describe, expect, it } from "vitest";
import { versionLine } from "./version";

const TIME = "2026-11-15T15:30:00Z";

describe("versionLine", () => {
  it("names the app, the web build's commit and the build date inside the Android app", () => {
    const line = versionLine({ versionName: "0.2.100", versionCode: 100 }, "638954329799", TIME);
    expect(line).toMatch(/^Yama app 0\.2\.100 \(100\), web 6389543, built Nov 1[45], 2026$/);
  });

  it("leaves the app out in a browser", () => {
    expect(versionLine(null, "638954329799", "2026-11-15")).toBe("Yama web 6389543, built Nov 15, 2026");
  });

  it("says when the build didn't know its commit", () => {
    expect(versionLine(null, "", "2026-11-15")).toBe("Yama web (local build), built Nov 15, 2026");
  });

  it("gives the version code alone when the app has no version name", () => {
    expect(versionLine({ versionCode: 7 }, "abc1234def", "")).toBe("Yama app 7, web abc1234");
  });
});
