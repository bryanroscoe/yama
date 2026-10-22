import { beforeEach, describe, expect, it } from "vitest";
import { bannerText, isViewing, minutesLeft, noteViewing, VIEWING_KEY, type Viewing } from "./viewing";
import type { User } from "./api";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

const v: Viewing = { admin_id: "bryan", admin_name: "Bryan", admin_email: "b@example.com", target_disabled: false, started_at: "2026-10-22T20:00:00Z", expires_at: "2026-10-22T20:30:00Z" };
const pat: User = { id: "p", email: "pat@example.com", display_name: "Pat", is_admin: false };

describe("view as", () => {
  it("counts minutes left, never below zero", () => {
    expect(minutesLeft(v.expires_at, Date.parse("2026-10-22T20:00:00Z"))).toBe(30);
    expect(minutesLeft(v.expires_at, Date.parse("2026-10-22T20:29:30Z"))).toBe(1);
    expect(minutesLeft(v.expires_at, Date.parse("2026-10-22T21:00:00Z"))).toBe(0);
  });
  it("says who, read only, and when it ends", () => {
    expect(bannerText(pat, v, Date.parse("2026-10-22T20:10:00Z"))).toBe("Viewing as Pat (pat@example.com), read only. Ends in 20 minutes.");
    expect(bannerText(pat, { ...v, target_disabled: true }, Date.parse("2026-10-22T20:29:30Z"))).toContain("turned off. Ends in 1 minute.");
  });
  it("keeps the flag in step with the server, so sync knows to hold back", () => {
    noteViewing({ ...pat, viewing: v });
    expect(isViewing()).toBe(true);
    expect(store.get(VIEWING_KEY)).toBe("p");
    noteViewing({ ...pat, id: "bryan", viewing: undefined });
    expect(isViewing()).toBe(false);
    noteViewing(null);
    expect(isViewing()).toBe(false);
  });
});
