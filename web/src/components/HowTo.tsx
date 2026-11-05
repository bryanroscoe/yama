import { useState, type ReactNode } from "react";
import { ConnectedApps } from "../oauth/ConnectedApps";
import { Sheet } from "./ui";

/**
 * How a page works, with what to do next (Bryan, 2026-11-04: "telling folks how to use this ...
 * right now most of them are blank pages with no way to interact with them"). Open on an empty
 * page, where it is the page; folded to one line once there is something to see.
 */
export function HowTo({ title, open, steps, actions }: { title: string; open: boolean; steps: ReactNode[]; actions?: ReactNode }) {
  return (
    <details className="how-to" open={open}>
      <summary>{title}</summary>
      <ol className="how-to-steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {actions && <div className="row how-to-actions">{actions}</div>}
    </details>
  );
}

/** "Connect your assistant": the sign-in steps for Claude and other MCP clients, in a sheet. */
export function ConnectButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">
        Connect your assistant
      </button>
      {open && (
        <Sheet label="Connect your assistant" onClose={() => setOpen(false)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Use Yama from your assistant</h2>
              <button className="quiet" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <ConnectedApps />
            <p className="small dim">
              The <a href="/docs/mcp/">MCP guide</a> has every tool, setup for Claude and Codex, and example requests.
            </p>
          </div>
        </Sheet>
      )}
    </>
  );
}
