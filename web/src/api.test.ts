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
});
