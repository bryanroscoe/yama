import { relayShareKey, RELAY_TOKEN } from "@yama/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const items = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
  get length() {
    return items.size;
  },
  key: (i: number) => [...items.keys()][i] ?? null,
});
const location = { origin: "https://yama.ing", hash: "" };
vi.stubGlobal("location", location);
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
    location.hash = "";
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
    expect(share.joinUrl("g1")).toBe(`https://yama.ing/table/join/g1#k=${key}&r=cf`);
  });

  it("forgets the credentials of games long past when a new one gets its own", async () => {
    const share = await load("wss://relay.yama.ing");
    items.set("yama.host.old", JSON.stringify({ secret: "a".repeat(32), at: Date.now() - 40 * 24 * 3600 * 1000 }));
    items.set("yama.host.recent", JSON.stringify({ secret: "b".repeat(32), at: Date.now() - 24 * 3600 * 1000 }));
    share.shareKey("new");
    expect(items.has("yama.host.old")).toBe(false);
    expect(items.has("yama.host.recent")).toBe(true);
    expect(items.has("yama.host.new")).toBe(true);
  });

  it("sends guests where their link says, with only the key on the Cloudflare relay", async () => {
    const share = await load("wss://relay.yama.ing/");
    expect(share.EDGE_RELAY).toBe("wss://relay.yama.ing");
    location.hash = "#k=abc&r=cf";
    expect(share.joinLink("g1")).toEqual({ key: "abc", relay: "edge" });
    expect(share.guestWsUrl("g1", "abc", "edge")).toBe("wss://relay.yama.ing/table/g1/ws?role=guest&key=abc");
    // A reload keeps both.
    location.hash = "";
    expect(share.joinLink("g1")).toEqual({ key: "abc", relay: "edge" });
    // A link from a phone still on the server's relay (it loaded the app before a deploy).
    location.hash = "#k=def";
    expect(share.joinLink("g2")).toEqual({ key: "def", relay: "server" });
    expect(share.guestWsUrl("g2", "def", "server")).toBe("wss://yama.ing/api/table/g2/ws?role=guest&key=def");
  });

  it("can't follow a Cloudflare link without the Cloudflare relay, so uses the server's", async () => {
    const share = await load("");
    location.hash = "#k=abc&r=cf";
    expect(share.joinLink("g1").relay).toBe("server");
  });

  it("keeps a game shared through the server there, with its older random key, so phones that scanned it stay in", async () => {
    items.set("yama.share.g1", "an-older-random-key-0123456789");
    for (const relay of ["", "wss://relay.yama.ing"]) {
      const share = await load(relay);
      expect(share.shareKey("g1")).toBe("an-older-random-key-0123456789");
      expect(share.joinUrl("g1")).toBe("https://yama.ing/table/join/g1#k=an-older-random-key-0123456789");
    }
  });
});
