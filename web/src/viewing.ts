// Admin "View as" on this device (server/src/view_as.rs): an admin sees Yama as another person
// does, read only. The server refuses every change; this side keeps the device from trying
// (nothing waiting to sync is sent while viewing) and from keeping the person's data afterwards
// (their plan and its unsent taps are deleted when the view ends).

import { api, type User } from "./api";
import { clearPlanData } from "./plan/store";
import { isViewing, viewingFlag, VIEWING_KEY } from "./viewingFlag";

export { isViewing, VIEWING_KEY };
const ME_KEY = "yama.me";

export interface Viewing {
  admin_id: string;
  admin_name: string;
  admin_email: string;
  target_disabled: boolean;
  started_at: string;
  expires_at: string;
}

const read = viewingFlag;

/**
 * Keep the flag in step with what the server says /api/me is. A view that ended without Stop
 * (it ran out, or the admin signed out elsewhere) leaves the person's plan data behind: delete it.
 */
export function noteViewing(me: User | null): void {
  const flagged = read();
  try {
    if (me?.viewing) {
      localStorage.setItem(VIEWING_KEY, me.id);
    } else if (flagged !== null) {
      localStorage.removeItem(VIEWING_KEY);
      void clearPlanData(flagged);
    }
  } catch {
    /* storage blocked: the server still refuses every change */
  }
}

/** Start viewing as `targetId` and load the app afresh as them. */
export async function startViewing(targetId: string): Promise<void> {
  await api(`/api/admin/users/${encodeURIComponent(targetId)}/view`, { method: "POST" });
  localStorage.setItem(VIEWING_KEY, targetId);
  localStorage.removeItem(ME_KEY);
  location.replace("/");
}

/** Stop viewing: end the view, delete the person's data from this device, back to `to`. */
export async function stopViewing(targetId: string | null | undefined, to = "/admin"): Promise<void> {
  await api("/api/view/stop", { method: "POST" }).catch(() => undefined);
  await clearPlanData(targetId ?? read());
  localStorage.removeItem(ME_KEY);
  localStorage.removeItem(VIEWING_KEY);
  location.replace(to);
}

/** Whole minutes left in a view (at least 0). */
export function minutesLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

/** The banner's words. */
export function bannerText(target: Pick<User, "display_name" | "email">, v: Viewing, now = Date.now()): string {
  const left = minutesLeft(v.expires_at, now);
  const off = v.target_disabled ? " Their account is turned off." : "";
  return `Viewing as ${target.display_name} (${target.email}), read only.${off} Ends in ${left} ${left === 1 ? "minute" : "minutes"}.`;
}
