import { afterEach, describe, expect, it, vi } from "vitest";
import { clientString } from "./clientBuild";

describe("the build the app reports (X-Yama-Client)", () => {
  it("names the Android app's version, the web build and the native code", () => {
    expect(clientString("638954329799abcdef", { versionName: "0.2.100", versionCode: 100, nativeHash: "0123456789abcdef" })).toBe(
      "android/0.2.100 (100) web/638954329799 native/0123456789abcdef",
    );
    expect(clientString("", { versionCode: 7, nativeHash: "dev" })).toBe("android/7 (7) web/local native/dev");
  });
  it("names a browser's web build", () => {
    expect(clientString("638954329799", null)).toBe("web/638954329799");
    expect(clientString("", null)).toBe("web/local");
  });
  it("keeps only the characters the server accepts", () => {
    const s = clientString("abc<x>", { versionName: "1.0; evil\nline", versionCode: 1.9, nativeHash: "h a s h" });
    expect(s).toBe("android/1.0evilline (1) web/abcx native/hash");
    expect(s).toMatch(/^[A-Za-z0-9 ._/()+-]{1,160}$/);
  });
});

describe("api() sends the build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const fetcher = () => vi.fn().mockImplementation(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));

  it("from a browser, on every request", async () => {
    vi.stubEnv("VITE_API_BASE", "");
    vi.stubEnv("VITE_BUILD_COMMIT", "638954329799");
    vi.resetModules();
    const f = fetcher();
    vi.stubGlobal("fetch", f);
    const { api } = await import("./api");
    await api("/api/me");
    expect(f.mock.calls[0]![1].headers.get("X-Yama-Client")).toBe("web/638954329799");
  });

  it("from the Android app, once it knows its version, and only with its token", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubEnv("VITE_API_BASE", "https://yama.example");
    vi.stubEnv("VITE_BUILD_COMMIT", "638954329799");
    vi.resetModules();
    const f = fetcher();
    vi.stubGlobal("fetch", f);
    const { api, setClientBuild, setToken } = await import("./api");
    setToken("native-token");
    await api("/api/me");
    expect(f.mock.calls[0]![1].headers.get("X-Yama-Client")).toBeNull();
    setClientBuild({ versionName: "0.2.100", versionCode: 100, nativeHash: "0123456789abcdef" });
    await api("/api/me");
    expect(f.mock.calls[1]![1].headers.get("X-Yama-Client")).toBe("android/0.2.100 (100) web/638954329799 native/0123456789abcdef");
    // Signed out, a request isn't preflighted for it.
    setToken(null);
    await api("/api/health");
    expect(f.mock.calls[2]![1].headers.get("X-Yama-Client")).toBeNull();
  });
});
