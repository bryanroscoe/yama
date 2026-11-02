import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("authenticated dataset exports", () => {
  it("keeps gzip bytes intact and attaches the native bearer token to the configured server", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE", "https://yama.ing/");
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "yama.token" ? "native-session" : null });
    const bytes = new Uint8Array([0x1f, 0x8b, 0, 0xff, 0x80, 0x7f]);
    const fetch = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "application/gzip" } }));
    vi.stubGlobal("fetch", fetch);
    const { apiBlob } = await import("../api");
    const blob = await apiBlob("/api/datasets/playgroup/export?revision=3");
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://yama.ing/api/datasets/playgroup/export?revision=3");
    expect(options.headers.get("Authorization")).toBe("Bearer native-session");
    expect(options.credentials).toBe("omit");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe("application/gzip");
  });
  it("uses web cookies and surfaces authentication errors instead of saving them as a gzip", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE", "");
    vi.stubGlobal("localStorage", { getItem: () => null });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Please sign in" }), { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { apiBlob, ApiError } = await import("../api");
    await expect(apiBlob("/api/datasets/playgroup/export?revision=3")).rejects.toEqual(new ApiError(401, "Please sign in", { error: "Please sign in" }));
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/datasets/playgroup/export?revision=3");
    expect(options.headers.has("Authorization")).toBe(false);
    expect(options.credentials).toBe("include");
  });
});
