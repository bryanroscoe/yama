import { describe, expect, it } from "vitest";
import { parseManifest, planUpdate, type UpdaterInfo } from "./nativeUpdate";

const sha = "a".repeat(64);
const manifest = {
  native: { versionCode: 12, versionName: "0.2.12", hash: "0123456789abcdef", url: "https://github.com/bryanroscoe/yama/releases/download/android-app/yama-12.apk", sha256: sha },
  web: { version: "abc1234", nativeHash: "0123456789abcdef", url: "https://github.com/bryanroscoe/yama/releases/download/android-app/web-abc1234.zip", sha256: sha },
};
const info: UpdaterInfo = { versionCode: 12, nativeHash: "0123456789abcdef", failed: [], next: "", canInstall: true };

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseManifest(JSON.stringify({ ...manifest, web: null }))?.web).toBeNull();
  });

  it("refuses anything off", () => {
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, native: { ...manifest.native, url: "http://github.com/x.apk" } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, native: { ...manifest.native, url: "https://evil.example/x.apk" } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, web: { ...manifest.web, sha256: "abc" } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, web: { ...manifest.web, version: "../x" } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, web: { ...manifest.web, version: ".." } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, web: { ...manifest.web, version: "ABC1234" } }))).toBeNull();
  });
});

describe("planUpdate", () => {
  const m = parseManifest(JSON.stringify(manifest))!;

  it("offers a newer APK first", () => {
    expect(planUpdate({ ...info, versionCode: 11, nativeHash: "ffffffffffffffff" }, m, "old").kind).toBe("app");
  });

  it("downloads a web build made for this native code", () => {
    expect(planUpdate(info, m, "old")).toMatchObject({ kind: "web", version: "abc1234" });
  });

  it("leaves alone a build that's running, waiting, failed, or for other native code", () => {
    expect(planUpdate(info, m, "abc1234").kind).toBe("none");
    expect(planUpdate({ ...info, next: "abc1234" }, m, "old").kind).toBe("none");
    expect(planUpdate({ ...info, failed: ["abc1234"] }, m, "old").kind).toBe("none");
    expect(planUpdate({ ...info, nativeHash: "ffffffffffffffff" }, m, "old").kind).toBe("none");
  });

  it("never updates a local build", () => {
    expect(planUpdate({ ...info, versionCode: 1, nativeHash: "dev" }, m, "").kind).toBe("none");
  });
});
