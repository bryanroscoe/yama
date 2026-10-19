// The order of sign-out. Plans hold prices paid and the outbox holds unsent answers, so both leave
// the device before anything that can fail or leave the page: before the logout request (which
// throws with no connection) and before the Cloudflare Access redirect. Answers still waiting get
// one short chance to send first, and the person is asked before any are thrown away.

export interface SignOutSteps {
  userId: string | null | undefined;
  /** Answers on this device the server doesn't have yet. */
  pending: () => number;
  /** Try to send them; bounded, never throws. */
  flush: () => Promise<void>;
  /** Ask before deleting answers that couldn't be sent. */
  confirmDiscard: (count: number) => boolean;
  /** Delete the user's plan bundle and outbox from the device. Never throws. */
  clearPlan: (userId: string | null | undefined) => Promise<void>;
  /** Drop the plan queries, which aborts a bundle still on its way. */
  dropQueries: () => void;
  logoutRequest: () => Promise<unknown>;
  authConfig: () => Promise<{ cf_access: boolean } | null>;
  /** Hand over to Cloudflare Access, which holds the real session. */
  cloudflareLogout: () => void;
  /** Forget the user on this device (token, cached user, queries). */
  finish: () => void;
}

export type SignOutResult = "signed-out" | "cloudflare" | "cancelled";

export async function signOut(s: SignOutSteps): Promise<SignOutResult> {
  if (s.userId && s.pending() > 0) {
    await s.flush().catch(() => undefined);
    const left = s.pending();
    if (left > 0 && !s.confirmDiscard(left)) return "cancelled";
  }
  await s.clearPlan(s.userId);
  s.dropQueries();
  let failure: unknown = null;
  try {
    await s.logoutRequest();
  } catch (e) {
    failure = e;
  }
  // Once more, for anything saved while the request was out.
  await s.clearPlan(s.userId);
  if (failure) throw failure;
  const config = await s.authConfig().catch(() => null);
  if (config?.cf_access) {
    s.cloudflareLogout();
    return "cloudflare";
  }
  s.finish();
  return "signed-out";
}

/** Resolve after `promise` or `ms`, whichever comes first. */
export function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([promise.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
}
