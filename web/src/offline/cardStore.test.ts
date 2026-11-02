import { beforeEach, describe, expect, it, vi } from "vitest";

// IndexedDB as a map, counting what's read and written.
const db = new Map<string, unknown>();
const reads: string[] = [];
const writes: string[] = [];
vi.mock("./idb", () => ({
  idbGet: async (k: string) => (reads.push(k), structuredClone(db.get(k))),
  idbPutMany: async (entries: [string, unknown][], remove: string[] = []) => {
    for (const [k, v] of entries) (writes.push(k), db.set(k, structuredClone(v)));
    for (const k of remove) db.delete(k);
  },
}));

import { card, due, forget, LIST_KEY, META_KEY, readMeta, refresh, search, type Meta } from "./cardStore";

const solRing = { i: "sol", n: "Sol Ring", m: "{1}", v: 1, t: "Artifact", o: "{T}: Add {C}{C}.", c: "", ci: "", p: null, th: null, l: null, r: "uncommon", k: [], f: { commander: "legal" }, y: "normal", img: null, e: 1, g: true };
const tower = { ...solRing, i: "ct", n: "Command Tower", t: "Land", e: 2, g: undefined };
const access = { apiBase: "", token: "t0k", credentials: "include" as RequestCredentials };
const at = (iso: string) => () => new Date(iso);

function serve(handler: (headers: Headers) => Response) {
  const calls: Headers[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    calls.push(h);
    return handler(h);
  });
  return calls;
}
const bundle = (version: string, cards = [solRing, tower]) => JSON.stringify({ format: 2, version, game_changers: true, cards });

beforeEach(() => {
  db.clear();
  reads.length = 0;
  writes.length = 0;
  forget();
});

describe("the offline card list", () => {
  it("moves a copy saved in one entry to the two entries, once", async () => {
    db.set("offline-cards", { format: 2, version: "v1", game_changers: true, savedAt: "2026-11-01T00:00:00.000Z", cards: [solRing] });
    const m = await readMeta();
    expect(m).toMatchObject({ version: "v1", count: 1, checkedAt: "2026-11-01T00:00:00.000Z", etag: null });
    expect(db.has("offline-cards")).toBe(false);
    expect(db.get(LIST_KEY)).toEqual([solRing]);
  });

  it("answers a search that arrives while an old copy is being moved", async () => {
    db.set("offline-cards", { format: 2, version: "v1", game_changers: true, savedAt: "2026-11-01T00:00:00.000Z", cards: [solRing, tower] });
    const [m, found, one] = await Promise.all([readMeta(), search("sol", "name", 1), card("ct")]);
    expect(m?.count).toBe(2);
    expect(found.total).toBe(1);
    expect(one?.name).toBe("Command Tower");
    // The old entry was read once, and the list not read again after the move.
    expect(reads.filter((k) => k === "offline-cards")).toHaveLength(1);
    expect(reads).not.toContain(LIST_KEY);
  });

  it("reads the list once for searches that arrive together", async () => {
    db.set(META_KEY, { format: 2, version: "v1", game_changers: true, count: 2, savedAt: "x", checkedAt: "x", etag: null, lastModified: null } satisfies Meta);
    db.set(LIST_KEY, [solRing, tower]);
    await Promise.all([search("sol", "name", 1), search("tower", "name", 1), card("sol")]);
    expect(reads.filter((k) => k === LIST_KEY)).toHaveLength(1);
  });

  it("reads only the small description until a search needs the list", async () => {
    db.set(META_KEY, { format: 2, version: "v1", game_changers: true, count: 2, savedAt: "x", checkedAt: "x", etag: null, lastModified: null } satisfies Meta);
    db.set(LIST_KEY, [solRing, tower]);
    await readMeta();
    expect(reads).not.toContain(LIST_KEY);
    const found = await search("sol", "name", 1);
    expect(found).toMatchObject({ total: 1, offline: true });
    expect(found.cards[0]).toMatchObject({ name: "Sol Ring", game_changer: true });
    expect((await card("ct"))?.game_changer).toBe(false);
    expect(reads.filter((k) => k === LIST_KEY)).toHaveLength(1);
  });

  it("says plainly when there's no saved list", async () => {
    await expect(search("sol", "name", 1)).rejects.toThrow("hasn't saved the card list");
  });

  it("checks a copy with a validator daily, and one without weekly", () => {
    const base = { format: 2, version: "v", count: 1, savedAt: "2026-11-01T00:00:00Z", checkedAt: "2026-11-01T00:00:00Z", lastModified: null };
    const now = Date.parse("2026-11-02T06:00:00Z");
    expect(due({ ...base, etag: '"v"' }, now)).toBe(true);
    expect(due({ ...base, etag: '"v"' }, Date.parse("2026-11-01T20:00:00Z"))).toBe(false);
    expect(due({ ...base, etag: null }, now)).toBe(false);
    expect(due({ ...base, etag: null }, Date.parse("2026-11-09T00:00:00Z"))).toBe(true);
    expect(due({ ...base, etag: null, format: 1 }, now)).toBe(true);
    expect(due(null, now)).toBe(true);
  });

  it("downloads the list only when the server says it changed", async () => {
    let version = "v1";
    const calls = serve((h) => (h.get("if-none-match") === `"${version}"` ? new Response(null, { status: 304 }) : new Response(bundle(version), { headers: { etag: `"${version}"` } })));
    await refresh(access, false, at("2026-11-01T00:00:00Z"));
    expect(calls[0]!.get("authorization")).toBe("Bearer t0k");
    expect(calls[0]!.has("if-none-match")).toBe(false);
    expect(writes).toEqual([LIST_KEY, META_KEY]);
    // Not due yet: nothing asked.
    await refresh(access, false, at("2026-11-01T12:00:00Z"));
    expect(calls).toHaveLength(1);
    // A day on: asked conditionally, unchanged, only the check's date saved.
    writes.length = 0;
    const m = await refresh(access, false, at("2026-11-02T01:00:00Z"));
    expect(calls[1]!.get("if-none-match")).toBe('"v1"');
    expect(writes).toEqual([META_KEY]);
    expect(m).toMatchObject({ checkedAt: "2026-11-02T01:00:00.000Z", savedAt: "2026-11-01T00:00:00.000Z" });
    // New cards: the list comes down and is saved.
    version = "v2";
    writes.length = 0;
    await refresh(access, true, at("2026-11-02T02:00:00Z"));
    expect(writes).toEqual([LIST_KEY, META_KEY]);
    expect((await readMeta())?.etag).toBe('"v2"');
  });

  it("without validators, keeps the saved list when the server's cards haven't changed", async () => {
    serve(() => new Response(bundle("v1")));
    await refresh(access, true, at("2026-11-01T00:00:00Z"));
    writes.length = 0;
    await refresh(access, true, at("2026-11-09T00:00:00Z"));
    expect(writes).toEqual([META_KEY]);
    expect(await readMeta()).toMatchObject({ savedAt: "2026-11-09T00:00:00.000Z", etag: null });
  });

  it("passes on the server's refusal", async () => {
    serve(() => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "content-type": "application/json" } }));
    await expect(refresh(access, true)).rejects.toThrow("Too many requests");
    expect(writes).toEqual([]);
  });
});
