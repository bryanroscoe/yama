import { relayShareKey, RELAY_TOKEN } from "@yama/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const items = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
});
vi.stubGlobal("location", { origin: "https://yama.ing" });
vi.mock("../api", () => ({ api: vi.fn(async () => ({})), API_BASE: "" }));

/** share.tsx reads the relay address once, as it loads. */
async function load(relay: string) {
  vi.resetModules();
  vi.stubEnv("VITE_RELAY_URL", relay);
  return import("./share");
}

describe("shared table credentials", () => {
  beforeEach(() => {
    items.clear();
    vi.unstubAllEnvs();
  });

  it("derives the share key from a secret this phone keeps, the same every time", async () => {
    const share = await load("wss://relay.yama.ing");
    const key = share.shareKey("g1");
    expect(key).toMatch(RELAY_TOKEN);
    const { secret } = JSON.parse(items.get("yama.host.g1")!) as { secret: string };
    expect(secret).toMatch(RELAY_TOKEN);
    expect(key).toBe(relayShareKey("g1", secret));
    expect(share.shareKey("g1")).toBe(key);
    expect(share.shareKey("g2")).not.toBe(key);
    expect(share.joinUrl("g1")).toBe(`https://yama.ing/table/join/g1#k=${key}`);
  });

  it("sends guests to the Cloudflare relay with only the key", async () => {
    const share = await load("wss://relay.yama.ing/");
    expect(share.EDGE_RELAY).toBe("wss://relay.yama.ing");
    expect(share.guestWsUrl("g1", "abc")).toBe("wss://relay.yama.ing/table/g1/ws?role=guest&key=abc");
  });

  it("keeps a game's older random key on the server's relay, so phones that scanned it stay in", async () => {
    items.set("yama.share.g1", "an-older-random-key-0123456789");
    const server = await load("");
    expect(server.EDGE_RELAY).toBe("");
    expect(server.shareKey("g1")).toBe("an-older-random-key-0123456789");
    expect(server.guestWsUrl("g1", "k")).toBe("wss://yama.ing/api/table/g1/ws?role=guest&key=k");
    // The Cloudflare relay only knows derived keys.
    const edge = await load("wss://relay.yama.ing");
    expect(edge.shareKey("g1")).not.toBe("an-older-random-key-0123456789");
  });
});
