// Pages for admins and power users only (2026-10-31): starting simulations and watched AI games.
// The server refuses everyone else; this says so instead of showing a form that can't work.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../auth";

/** Why a power-user page or control isn't there, in a sentence. */
export const POWER_NOTE = "Simulations, watched AI games and Ask Claude are open to admins and power users for now.";

/** `children` for admins and power users; for anyone else, `head` and a short note. */
export function PowerOnly({ head, children }: { head?: ReactNode; children: ReactNode }) {
  const me = useMe();
  if (me.data?.power) return <>{children}</>;
  if (me.isPending) return null;
  return (
    <>
      {head}
      <p className="empty power-only" role="note">
        {POWER_NOTE} Results stay open to everyone: see the <Link to="/lab">simulated precon rankings</Link>.
      </p>
    </>
  );
}
