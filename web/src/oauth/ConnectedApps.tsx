import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorText } from "../components/ui";
import { CopyButton } from "../plan/parts";
import { publicOrigin } from "../api";
import { disconnectApp, listConnectedApps } from "./api";
import { appKind, appName, claudeCodeCommand } from "./logic";
import { fmtDate } from "@yama/core";
import { ask } from "../components/confirm";

/**
 * Decks, Plans, Settings: how to connect Claude to Yama by signing in (no key to paste), and the
 * apps connected that way, each with Disconnect. Script keys stay below as the other way.
 */
export function ConnectedApps() {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["connected-apps"], queryFn: listConnectedApps });
  const disconnect = useMutation({ mutationFn: disconnectApp, onSuccess: () => void qc.invalidateQueries({ queryKey: ["connected-apps"] }) });
  if (apps.data && !apps.data.enabled) return null;
  const url = apps.data?.mcp_url ?? `${publicOrigin()}/mcp`;
  const command = claudeCodeCommand(url);
  return (
    <section className="stack">
      <h3>Connect your assistant</h3>
      <p className="dim small">Your assistant can research cards, review your decks, collection and lab runs, and stage changes for approval. Connect it by signing in; there's no key to copy.</p>
      <p className="small"><a href="/docs/mcp/">Read the MCP guide: all features, Claude and Codex setup, and example requests.</a></p>
      <div className="stack">
        <p className="small">
          <b>Claude Code.</b> Run this in Terminal, then type <code>/mcp</code> in Claude Code, pick yama and choose Authenticate. Your browser opens Yama; press Allow.
        </p>
        <code className="plan-key">{command}</code>
        <div className="row">
          <CopyButton text={command} label="Copy the command" />
        </div>
        <p className="small">
          <b>Claude on the web, desktop or phone.</b> In Claude's Customize, Connectors (Settings, Connectors in some versions), choose Add custom connector. Name it Yama, give it <code>{url}</code>, then Connect and press Allow here. If asked how to identify the OAuth client, choose Register automatically.
          Enable Yama for the conversation; the connection can also be used on the phone app.
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
                onClick={async () => (await ask({ title: `Disconnect "${appName(a.name)}"?`, body: "It stops working until you connect it again.", confirm: "Disconnect", danger: true })) && disconnect.mutate(a.id)}
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
