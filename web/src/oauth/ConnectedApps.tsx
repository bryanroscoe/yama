import { fmtDate } from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorText } from "../components/ui";
import { CopyButton } from "../plan/parts";
import { disconnectApp, listConnectedApps } from "./api";
import { appKind, appName, claudeCodeCommand } from "./logic";

/**
 * Decks, Plans, Settings: how to connect Claude to Yama by signing in (no key to paste), and the
 * apps connected that way, each with Disconnect. Script keys stay below as the other way.
 */
export function ConnectedApps() {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["connected-apps"], queryFn: listConnectedApps });
  const disconnect = useMutation({ mutationFn: disconnectApp, onSuccess: () => void qc.invalidateQueries({ queryKey: ["connected-apps"] }) });
  if (apps.data && !apps.data.enabled) return null;
  const url = apps.data?.mcp_url ?? `${window.location.origin}/mcp`;
  const command = claudeCodeCommand(url);
  return (
    <section className="stack">
      <h3>Connect Claude</h3>
      <p className="dim small">Claude can read your decks, plans, Review, collection and lab runs with Yama's tools. Connect it by signing in; there's no key to copy.</p>
      <div className="stack">
        <p className="small">
          <b>Claude Code.</b> Run this in Terminal, then type <code>/mcp</code> in Claude Code, pick yama and choose Authenticate. Your browser opens Yama; press Allow.
        </p>
        <code className="plan-key">{command}</code>
        <div className="row">
          <CopyButton text={command} label="Copy the command" />
        </div>
        <p className="small">
          <b>Claude on the web, desktop or phone.</b> In Claude's Settings, Connectors, choose Add custom connector. Name it Yama, give it <code>{url}</code>, then Connect and press Allow here.
          A connector added there also shows up in Claude Code and the phone app.
        </p>
      </div>
      <h3>Connected apps</h3>
      <ErrorText error={apps.error ?? disconnect.error} />
      {apps.data && apps.data.apps.length === 0 && <p className="dim small">None yet.</p>}
      {apps.data && apps.data.apps.length > 0 && (
        <div className="list">
          {apps.data.apps.map((a) => (
            <div key={a.id} className="list-row">
              <span>
                <span className="title">{appName(a.name)}</span> <span className="small dim">{appKind(a)}</span>
                <br />
                <span className="small dim">
                  Connected {fmtDate(a.connected_at)}. Last used {a.last_used_at ? fmtDate(a.last_used_at) : "never"}.
                </span>
              </span>
              <button
                className="quiet small"
                disabled={disconnect.isPending}
                onClick={() => window.confirm(`Disconnect "${appName(a.name)}"? It stops working until you connect it again.`) && disconnect.mutate(a.id)}
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
