import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorText } from "../components/ui";
import { adminApi, type ServerInfo, type WatchItem } from "./api";
import { ago, bytes } from "./logic";

const yes = (b: boolean) => (b ? "On" : "Off");

export function ServerPage() {
  const server = useQuery({ queryKey: ["admin-server"], queryFn: adminApi.server, refetchInterval: 15_000 });
  const s = server.data;
  return (
    <>
      <ErrorText error={server.error} />
      {s && (
        <>
          <section className="admin-section" aria-labelledby="adm-version">
            <h2 id="adm-version">This server</h2>
            <Facts
              rows={[
                ["Version", s.version],
                ["Running since", `${ago(s.started_at)} (${new Date(s.started_at).toLocaleString("en-US")})`],
                ["Google sign-in", yes(s.sign_in.google)],
                ["Open sign-up", yes(s.sign_in.open_signup)],
                ["Password sign-in", yes(s.sign_in.password)],
                ["Development sign-in", yes(s.sign_in.dev_login)],
                ["Cloudflare Access", yes(s.sign_in.cloudflare_access)],
                ["Admin emails set", String(s.sign_in.admin_emails)],
              ]}
            />
          </section>
          <EngineSection s={s} />
          <section className="admin-section" aria-labelledby="adm-data">
            <h2 id="adm-data">Card data and calendar</h2>
            <Facts
              rows={[
                ...s.scryfall.map((r): [string, ReactNode] => [
                  `Scryfall ${r.kind.replace("_", " ")}`,
                  r.error ? (
                    <span className="admin-bad">Failed {ago(r.started_at)}: {r.error}</span>
                  ) : r.finished_at ? (
                    `${(r.rows ?? 0).toLocaleString("en-US")} rows, imported ${ago(r.finished_at)}${r.source_updated_at ? `; Scryfall's file from ${ago(r.source_updated_at)}` : ""}`
                  ) : (
                    `Started ${ago(r.started_at)}, still running`
                  ),
                ]),
                ...(s.scryfall.length ? [] : [["Scryfall", "Never imported"] as [string, ReactNode]]),
                ["Release calendar", s.calendar.sets_checked_at ? `Checked ${ago(s.calendar.sets_checked_at)}` : "Never checked"],
                ["Commander precons", `${s.calendar.precons} lists${s.calendar.precons_fetched_at ? `, newest fetched ${ago(s.calendar.precons_fetched_at)}` : ""}`],
              ]}
            />
          </section>
          <section className="admin-section" aria-labelledby="adm-db">
            <h2 id="adm-db">Database and backups</h2>
            <Facts
              rows={[
                ["Database", s.database.file ? `${bytes(s.database.bytes)}, plus ${bytes(s.database.wal_bytes ?? 0)} in the write-ahead log` : "In memory"],
                [
                  "Newest backup",
                  s.backups[0] ? `${s.backups[0].name}, ${bytes(s.backups[0].bytes)}, ${ago(s.backups[0].modified)}` : "None in the backups folder",
                ],
              ]}
            />
            {s.backups.length > 1 && (
              <details className="admin-details">
                <summary>All recent backups ({s.backups.length})</summary>
                <ul className="admin-plain">
                  {s.backups.map((b) => (
                    <li key={b.name}>
                      {b.name}, {bytes(b.bytes)}, {ago(b.modified)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          <section className="admin-section" aria-labelledby="adm-lab">
            <h2 id="adm-lab">Lab</h2>
            <Facts
              rows={[
                ["Experiments", s.lab.unavailable ? <span className="admin-bad">{s.lab.unavailable}</span> : `Running on ${s.lab.threads} game threads`],
                ["Runs", `${s.lab.running} running, ${s.lab.queued} queued, ${s.lab.games_waiting.toLocaleString("en-US")} games to play`],
                ["Imported runs everyone sees", String(s.lab.global_runs)],
              ]}
            />
          </section>
          <ForgeSection s={s} />
          <AdvisorSection s={s} />
          <WatchSection games={s.watch} />
        </>
      )}
    </>
  );
}

function EngineSection({ s }: { s: ServerInfo }) {
  const e = s.engine;
  const state =
    e.status === "ready"
      ? `Ready, ${(e.cards ?? 0).toLocaleString("en-US")} cards`
      : e.status === "loading"
        ? "Still loading"
        : `${e.status === "off" ? "Off" : "Failed"}: ${e.why ?? "no reason given"}`;
  return (
    <section className="admin-section" aria-labelledby="adm-engine">
      <h2 id="adm-engine">Rules engine</h2>
      <Facts
        rows={[
          ["Engine", e.label],
          ["State", e.status === "ready" ? state : <span className="admin-bad">{state}</span>],
          ["Card data", e.card_data_file ?? "Not set"],
          ["Lab runner build", e.runner],
          ["Live online games", String(e.live_online_games)],
        ]}
      />
    </section>
  );
}

function ForgeSection({ s }: { s: ServerInfo }) {
  const f = s.forge;
  if (!f) return null;
  const state = !f.configured ? "Off (not set up on this server)" : f.online ? "Answering" : "Not answering";
  return (
    <section className="admin-section" aria-labelledby="adm-forge">
      <h2 id="adm-forge">Forge worker</h2>
      <Facts
        rows={[
          ["Worker", f.configured && !f.online ? <span className="admin-bad">{state}{f.error ? `: ${f.error}` : ""}</span> : state],
          ["Engine", f.engine ?? "Unknown until it answers"],
          ["Worker build", f.runner ?? "Unknown until it answers"],
          ["Games at once", f.configured ? String(f.slots) : "None"],
          ["Playing now", String(f.playing)],
          ["Forge games waiting", f.games_waiting.toLocaleString("en-US")],
          ["Last answered", f.last_seen ? ago(f.last_seen) : "Never"],
        ]}
      />
    </section>
  );
}

function AdvisorSection({ s }: { s: ServerInfo }) {
  const a = s.advisor;
  const sidecar = !a.enabled ? "Off (not set up on this server)" : a.reachable ? "Answering" : "Not answering";
  const sub = !a.enabled ? "Off" : a.subscription_connected == null ? "Unknown" : a.subscription_connected ? "Connected" : "Not connected yet (run deploy/advisor-token.sh)";
  return (
    <section className="admin-section" aria-labelledby="adm-advisor">
      <h2 id="adm-advisor">Ask Claude</h2>
      <Facts
        rows={[
          ["Advisor", a.enabled && !a.reachable ? <span className="admin-bad">{sidecar}</span> : sidecar],
          ["Your subscription", sub],
          ["Accounts on the subscription", String(a.subscription_accounts)],
          ["People's own API keys", a.own_keys_enabled ? `On, ${a.own_keys_saved} saved` : "Off"],
          ["Questions in the last 24 hours", String(a.questions_today)],
        ]}
      />
    </section>
  );
}

function WatchSection({ games }: { games: WatchItem[] }) {
  const qc = useQueryClient();
  const stop = useMutation({ mutationFn: (id: string) => adminApi.stopWatch(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-server"] }) });
  return (
    <section className="admin-section" aria-labelledby="adm-watch">
      <h2 id="adm-watch">Watched games</h2>
      {games.length === 0 ? (
        <p className="dim">No watched games on the server right now.</p>
      ) : (
        <ul className="admin-list">
          {games.map((g) => (
            <li key={g.id} className={g.finished ? "is-off" : undefined}>
              <div className="admin-text">
                <b>{g.seats.map((s) => s.deck ?? s.name).join(", ")}</b>
                <span>
                  {g.owner_name ?? "Someone"} ({g.owner_email ?? "unknown"}), started {ago(g.created_at)}.
                </span>
                <span>
                  {g.finished ? (g.stopped ?? "Finished") : g.playing ? "Playing" : "Paused"}, turn {g.turn}, {g.actions.toLocaleString("en-US")} moves,{" "}
                  {g.viewers === 1 ? "1 person watching" : `${g.viewers} people watching`}.
                </span>
              </div>
              {!g.finished && (
                <div className="admin-actions">
                  <button className="outline danger" onClick={() => stop.mutate(g.id)} disabled={stop.isPending}>
                    Stop
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={stop.error} />
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="admin-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
