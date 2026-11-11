// Playing the computer without an account (server/src/guests.rs): whether this server allows it,
// and whether this browser is a guest already. A guest is signed in by its own cookie, which only
// the play routes accept, so the rest of the app stays signed out.

import { useQuery } from "@tanstack/react-query";
import { API_BASE, api } from "./api";
import { useMe } from "./auth";

export interface GuestSession {
  /** Someone with no account may play as a guest here. */
  enabled: boolean;
  /** The Cloudflare Turnstile site key for the check before a guest is made. */
  site_key: string | null;
  /** This browser is a guest already. */
  guest: boolean;
  /** The guest's id, which online games name as their host and seats' player. */
  id?: string | null;
  /** When this guest and its games are deleted. */
  expires_at: string | null;
}

export const GUEST_SESSION_KEY = ["guest-session"] as const;

/**
 * The guest session, for someone who isn't signed in. The Android app sends a bearer token and no
 * cookies (api.ts), so a guest's cookie would never reach the server from it: there it's off.
 */
export function useGuestSession(enabled = true) {
  return useQuery({
    queryKey: GUEST_SESSION_KEY,
    queryFn: async () => {
      const s = await api<GuestSession>("/api/guest/session");
      return API_BASE ? { ...s, enabled: false, guest: false } : s;
    },
    enabled,
    staleTime: 60_000,
  });
}

/** Who is playing: the signed-in account, else this browser's guest. Online games compare it with their host. */
export function usePlayerId(): string | undefined {
  const me = useMe();
  const guest = useGuestSession(!me.data && !me.isPending);
  return me.data?.id ?? (guest.data?.guest ? guest.data.id ?? undefined : undefined);
}
