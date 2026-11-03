import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useMe } from "../auth";
import { forgetTable, rememberTable, useFollowedTable } from "./following";
import { joinFragment, type Relay } from "./share";

interface ActiveTable {
  id: string;
  group_name: string | null;
  host_name: string;
  started_at: string;
  key: string | null;
  relay: Relay;
}

/** A return to the scanned game first, then current games in this account's playgroups. */
export function SharedTables({ localGameId }: { localGameId?: string }) {
  const me = useMe();
  const user = me.data?.id ?? null;
  const saved = useFollowedTable(user);
  const tables = useQuery({
    queryKey: ["table-active", user],
    queryFn: ({ signal }) => api<ActiveTable[]>("/api/table/active", { signal }),
    enabled: !!user,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  // A host moving devices/relays can keep the game id while rotating its join key.
  // Prefer current discovery immediately, and keep that address for the next app open.
  const rediscovered = tables.dataUpdatedAt >= (saved?.at ?? 0) ? tables.data?.find((t) => t.id === saved?.gameId && t.key) : undefined;
  const followed = saved && rediscovered?.key ? { ...saved, key: rediscovered.key, relay: rediscovered.relay } : saved;
  const gameId = saved?.gameId;
  const names = saved?.names;
  const key = followed?.key;
  const relay = followed?.relay;
  useEffect(() => {
    if (gameId && names !== undefined && key && relay && (key !== saved?.key || relay !== saved?.relay)) {
      rememberTable(user, { gameId, names, key, relay });
    }
  }, [user, gameId, names, key, relay, saved?.key, saved?.relay]);
  const active = tables.data?.filter((t) => t.id !== localGameId && t.id !== followed?.gameId) ?? [];
  if (!followed && !active.length) return null;
  return (
    <section className="shared-tables stack" aria-label="Shared games">
      {followed && (
        <div className="guest-banner">
          <div>
            <h2>Your shared table</h2>
            <p className="dim">{followed.names}. Reconnect to see the host’s latest totals.</p>
            <div className="row">
              <Link className="button primary" to={`/table/join/${followed.gameId}${joinFragment(followed.key, followed.relay)}`}>Back to the shared table</Link>
              <button className="quiet" onClick={() => forgetTable(user, followed.gameId)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
      {active.map((t) => (
        <div key={t.id} className="guest-banner">
          <div>
            <h2>{t.group_name ? `${t.group_name} is playing` : "Your table is live"}</h2>
            <p className="dim">{t.host_name} started a game at {new Date(t.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
            <Link className="button primary" to={`/table/join/${t.id}${t.key ? joinFragment(t.key, t.relay) : ""}`}>Join the table</Link>
          </div>
        </div>
      ))}
    </section>
  );
}
