import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessage, unanswered } from "./api";
import { priceSource, shortDate, usd } from "@yama/core";

describe("prices", () => {
  it("never shows a missing price as $0", () => {
    expect(usd(null)).toBe("No price");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd(1630.766)).toBe("$1,630.77");
  });
  it("reads a snapshot date as a local date", () => {
    expect(shortDate("2026-10-19")).toBe("Oct 19");
    expect(shortDate(null)).toBeNull();
  });
  it("names the source and date", () => {
    expect(priceSource("2026-10-18")).toBe("TCGplayer market via Scryfall, Oct 18");
    expect(priceSource(undefined)).toBe("TCGplayer market via Scryfall, date unknown");
  });
});

describe("error messages", () => {
  it("says Yama didn't answer instead of the browser's fetch error", () => {
    for (const raw of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(unanswered(new TypeError(raw))).toBe(true);
      expect(errorMessage(new TypeError(raw))).toBe("Yama didn't answer. Check the connection and try again.");
    }
  });
  it("keeps every other error's own words, code bugs included", () => {
    expect(unanswered(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe("Cannot read properties of undefined (reading 'x')");
    expect(errorMessage(new Error("A seat's deck isn't yours"))).toBe("A seat's deck isn't yours");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("API authentication across origins", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => {
    localStorage.removeItem("yama.token");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    { base: "", token: null, credentials: "include" },
    { base: "https://api.yama.example/", token: "fixture-bearer", credentials: "omit" },
  ])("authenticates requests with base '$base'", async ({ base, token, credentials }) => {
    vi.stubEnv("VITE_API_BASE", base);
    vi.resetModules();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "me" }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const { api, setToken } = await import("./api");
    setToken(token);
    expect(await api("/api/me")).toEqual({ id: "me" });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(base.replace(/\/$/, "") + "/api/me");
    expect(options.credentials).toBe(credentials);
    expect(options.headers.get("Authorization")).toBe(token ? `Bearer ${token}` : null);
  });

  it("keeps no bearer token on the web, where the session cookie is the sign-in", async () => {
    vi.stubEnv("VITE_API_BASE", "");
    vi.resetModules();
    // A token an older build stored. Its session may have ended, and the server reads
    // Authorization before the cookie without falling back.
    localStorage.setItem("yama.token", "stale-token");
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "me" }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const { api, currentToken, setToken } = await import("./api");
    expect(localStorage.getItem("yama.token")).toBeNull();
    expect(currentToken()).toBeNull();
    await api("/api/me");
    expect(fetcher.mock.calls[0]![1].headers.get("Authorization")).toBeNull();
    expect(fetcher.mock.calls[0]![1].credentials).toBe("include");
    // Signing in doesn't store one either.
    setToken("fresh-token");
    expect(localStorage.getItem("yama.token")).toBeNull();
    await api("/api/me");
    expect(fetcher.mock.calls[1]![1].headers.get("Authorization")).toBeNull();
  });

  it("keeps the bearer token in the native app, which has no cookie", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.yama.example");
    vi.resetModules();
    localStorage.setItem("yama.token", "native-token");
    const { currentToken, setToken } = await import("./api");
    expect(currentToken()).toBe("native-token");
    setToken("next-token");
    expect(localStorage.getItem("yama.token")).toBe("next-token");
    setToken(null);
    expect(currentToken()).toBeNull();
  });
});
