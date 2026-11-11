// Whose data this tab holds, and what happens when the signed-in account changes under an open
// page (project review, 11 Nov 2026).
//
// - The query cache belongs to one account. When another signs in, or the account signs out,
//   every cached query goes except the few that hold nothing of an account (`keptAcrossAccounts`),
//   before any page renders as the new account.
// - A sign-in that ends under an open account page (a 401 on a save or a read) doesn't throw the
//   page away with whatever is typed in it: the page stays, with a sign-in prompt over it
//   (components/RequireAccount.tsx). That account's cache is kept meanwhile; signing in as the
//   same account carries on, anyone else gets a fresh page and an empty cache.
// - Signing out in another tab signs this one out too, and an account that changes in another tab
//   is asked about here straight away.

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiError } from "./api";

/** The cached user (auth.tsx keeps it): a change from another tab means the account changed there. */
export const ME_KEY = "yama.me";
/** Written by Sign out and Delete account, so every other tab of this browser signs out with it. */
export const SIGNED_OUT_KEY = "yama.signedOut";

/**
 * Queries that hold nothing of an account, so they outlive a change of account: who is signed in,
 * the server's sign-in settings, a guest's own card search (Cards.tsx keys it `true`) and a deck
 * read by its public share link.
 */
export function keptAcrossAccounts(key: readonly unknown[]): boolean {
  const family = key[0];
  return family === "me" || family === "auth-config" || family === "shared-deck" || (family === "search" && key[4] === true);
}

/** A request refused with 401 while the app believes an account is signed in: its sign-in may have ended. */
export function signInEnded(error: unknown, signedIn: boolean): boolean {
  return signedIn && error instanceof ApiError && error.status === 401;
}

export interface CacheState {
  /** The account whose data the cache may hold; null for nobody. */
  owner: string | null;
  /** The account whose open page is waiting for it to sign in again. */
  lapsed: string | null;
}

/**
 * What the cache does when the server says who is signed in (`now`; null for nobody).
 * `pages` is how many account pages are open in this tab, and `deliberate` marks a sign-out the
 * person asked for (here or in another tab), which never keeps a page waiting.
 */
export function cacheStep(state: CacheState, now: string | null, { pages, deliberate }: { pages: number; deliberate: boolean }): CacheState & { clear: boolean; refresh: boolean } {
  // Signed in again as the account whose page was waiting: carry on, and ask again for what failed.
  if (now !== null && now === state.owner) return { owner: now, lapsed: null, clear: false, refresh: state.lapsed !== null };
  if (now === state.owner) return { ...state, clear: false, refresh: false };
  // The sign-in ended under an open page: keep the page and its data for that account's return.
  if (now === null && state.owner !== null && pages > 0 && !deliberate) return { owner: state.owner, lapsed: state.owner, clear: false, refresh: false };
  return { owner: now, lapsed: null, clear: true, refresh: false };
}

/** A page stopped waiting (Continue signed out, or it closed): the account's data goes. */
export function releaseStep(state: CacheState): CacheState & { clear: boolean } {
  if (state.lapsed === null) return { ...state, clear: false };
  return { owner: null, lapsed: null, clear: true };
}

/**
 * What another tab's change to this browser's storage means here: a deliberate sign-out reloads
 * this tab signed out; a different cached user (or none) asks the server who is signed in now.
 */
export function storageStep(event: { key: string | null; newValue: string | null }, currentId: string | null): "reload" | "ask" | "none" {
  if (event.key === SIGNED_OUT_KEY) return event.newValue ? "reload" : "none";
  if (event.key !== ME_KEY) return "none";
  let id: string | null = null;
  try {
    id = event.newValue ? ((JSON.parse(event.newValue) as { id?: string }).id ?? null) : null;
  } catch {
    id = null;
  }
  return id === currentId ? "none" : "ask";
}

let state: CacheState = { owner: null, lapsed: null };
let pages = 0;
let deliberate = false;
/** The server has answered for an account in this tab. Until then the app only opened as the
 *  account this device last saw, and a 401 means signed out, not a sign-in ending mid-work. */
let confirmed = false;
let client: QueryClient | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

const clearAccountData = () => client?.removeQueries({ predicate: (q) => !keptAcrossAccounts(q.queryKey) });

/** Start following the session for this tab's cache: `owner` is the account the app opened as. */
export function startSession(queryClient: QueryClient, owner: string | null) {
  client = queryClient;
  state = { owner, lapsed: null };
  pages = 0;
  deliberate = false;
  confirmed = false;
}

/** The server said who is signed in (main.tsx calls this before any page renders with it). */
export function followSession(now: string | null) {
  const next = cacheStep(state, now, { pages: confirmed ? pages : 0, deliberate });
  if (now !== null) confirmed = true;
  const changed = next.lapsed !== state.lapsed;
  state = { owner: next.owner, lapsed: next.lapsed };
  if (next.clear) clearAccountData();
  // Everything on screen asked while signed out and failed: ask again as the account that's back.
  if (next.refresh) void client?.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  if (changed) emit();
}

/**
 * Sign out or Delete account in this tab: nothing waits for the account to come back, and the
 * browser's other tabs are told. `tellOtherTabs` is false for a sign-out that Cloudflare Access
 * finishes after this page has gone: until then the server would sign a reloading tab straight
 * back in, so those tabs find out on their next request instead.
 */
export function signingOut({ tellOtherTabs = true }: { tellOtherTabs?: boolean } = {}) {
  deliberate = true;
  if (!tellOtherTabs) return;
  try {
    localStorage.setItem(SIGNED_OUT_KEY, String(Date.now()));
  } catch {
    // Storage blocked: other tabs find out on their next request.
  }
}

/** An account page is on screen (RequireAccount); returns its cleanup. */
export function accountPageOpen(): () => void {
  pages++;
  return () => {
    pages--;
    // The last page that was waiting closed (Back, another address): stop keeping the data.
    if (pages === 0) releaseSession();
  };
}

/** Stop waiting for the account to sign in again: its data leaves the cache. */
export function releaseSession() {
  const next = releaseStep(state);
  if (!next.clear) return;
  state = { owner: next.owner, lapsed: next.lapsed };
  clearAccountData();
  emit();
}

/** The account whose open page is waiting for it to sign in again, or null. */
export function useLapsedAccount(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.lapsed,
    () => state.lapsed,
  );
}

/** Follow sign-outs and account changes made in this browser's other tabs. */
export function watchOtherTabs(queryClient: QueryClient, reload: () => void = () => location.reload()) {
  window.addEventListener("storage", (e) => {
    const current = (queryClient.getQueryData(["me"]) as { id?: string } | null | undefined)?.id ?? null;
    const step = storageStep(e, current);
    if (step === "reload") {
      deliberate = true;
      reload();
    } else if (step === "ask") void queryClient.invalidateQueries({ queryKey: ["me"] });
  });
}
