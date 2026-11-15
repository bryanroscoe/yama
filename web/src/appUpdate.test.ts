import { beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  info: vi.fn(),
  fetchText: vi.fn(),
  downloadBuild: vi.fn(),
  installApk: vi.fn(),
}));
vi.mock("./nativeUpdate", async (orig) => ({ ...(await orig<typeof import("./nativeUpdate")>()), Updater: updater }));

import { checkForUpdates, getAppUpdate, installApp, resetAppUpdate, resumed } from "./appUpdate";
import { appStatus } from "./components/AppUpdate";

const sha = "a".repeat(64);
const native = { versionCode: 101, versionName: "0.2.101", hash: "0123456789abcdef", url: "https://github.com/bryanroscoe/yama/releases/download/android-app/yama-101.apk", sha256: sha, notes: "Update the app from Settings" };
const manifest = JSON.stringify({ native, web: null });
const info = { versionCode: 100, versionName: "0.2.100", nativeHash: "ffffffffffffffff", failed: [], next: "", canInstall: true };

beforeEach(() => {
  resetAppUpdate();
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { onLine: true });
  updater.info.mockResolvedValue(info);
  updater.fetchText.mockResolvedValue({ text: manifest });
});

describe("the shared update state", () => {
  it("offers a newer APK with its notes, and Settings says so", async () => {
    await checkForUpdates(true);
    const s = getAppUpdate();
    expect(s.app).toMatchObject({ versionCode: 101, notes: "Update the app from Settings" });
    expect(appStatus(s)).toBe("Update available: 0.2.101");
  });

  it("says up to date when the APK is current", async () => {
    updater.info.mockResolvedValue({ ...info, versionCode: 101, nativeHash: "0123456789abcdef" });
    await checkForUpdates(true);
    expect(getAppUpdate().app).toBeNull();
    expect(appStatus(getAppUpdate())).toMatch(/^Up to date \(checked /);
  });

  it("says when it couldn't check", async () => {
    updater.fetchText.mockRejectedValue(new Error("offline"));
    await checkForUpdates(true);
    expect(appStatus(getAppUpdate())).toBe("Couldn't check for updates. Try again when you have signal.");
  });

  it("asks once for checks close together: the banner and Settings share it", async () => {
    await Promise.all([checkForUpdates(true), checkForUpdates(true)]);
    await checkForUpdates();
    expect(updater.fetchText).toHaveBeenCalledTimes(1);
  });

  it("carries on with the install after Android's permission page allows it", async () => {
    await checkForUpdates(true);
    updater.installApk.mockResolvedValueOnce({ status: "permission" });
    await installApp();
    expect(getAppUpdate().awaitingPermission).toBe(true);
    updater.installApk.mockResolvedValueOnce({ status: "installing" });
    await resumed();
    expect(updater.installApk).toHaveBeenCalledTimes(2);
    expect(getAppUpdate()).toMatchObject({ awaitingPermission: false, installError: null });
  });

  it("says so when the person came back without allowing it", async () => {
    await checkForUpdates(true);
    updater.installApk.mockResolvedValueOnce({ status: "permission" });
    await installApp();
    updater.info.mockResolvedValue({ ...info, canInstall: false });
    await resumed();
    expect(updater.installApk).toHaveBeenCalledTimes(1);
    expect(getAppUpdate().installError).toMatch(/isn't allowed to install apps yet/);
  });

  it("never offers updates to a local build", async () => {
    updater.info.mockResolvedValue({ ...info, nativeHash: "dev" });
    await checkForUpdates(true);
    expect(updater.fetchText).not.toHaveBeenCalled();
    expect(appStatus(getAppUpdate())).toBe("A local build: it doesn't update itself.");
  });
});
