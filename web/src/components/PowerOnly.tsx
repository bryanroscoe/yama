// Pages for admins and power users only (2026-10-31): starting simulations. Watching the computer
// play is open to every account since 12 Nov 2026. The server refuses everyone else; this says so
// instead of showing a form that can't work.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { publicOrigin } from "../api";
import { useMe } from "../auth";

/** Why a power-user page or control isn't there, in a sentence. */
export const POWER_NOTE = "Starting simulations and Ask Claude need access that an admin turns on for an account.";

/** Where to ask: the contact on the About page (a server page, so the Android app opens it on the site). */
export function contactHref(): string {
  return `${publicOrigin()}/about/#contact`;
}

/** The note, with what to do about it. */
export function PowerNote() {
  return (
    <>
      {POWER_NOTE} <a href={contactHref()}>Ask for access</a>.
    </>
  );
}

/** `children` for admins and power users; for anyone else, `head` and a short note. */
export function PowerOnly({ head, children }: { head?: ReactNode; children: ReactNode }) {
  const me = useMe();
  if (me.data?.power) return <>{children}</>;
  if (me.isPending) return null;
  return (
    <>
      {head}
      <p className="empty power-only" role="note">
        <PowerNote /> Results stay open to everyone: see the <Link to="/lab">simulated precon rankings</Link>.
      </p>
    </>
  );
}
