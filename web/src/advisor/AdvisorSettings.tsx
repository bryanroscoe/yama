// The advisor's settings: whose Claude your questions use, your own API key (added or removed,
// never shown again), the model, and deleting every conversation.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorText } from "../components/ui";
import { deleteAllConversations, removeKey, saveKey, setModel, type AdvisorStatus } from "./api";
import { useAdvisorStatus } from "./AskClaude";
import "./advisor.css";

function modeLine(s: AdvisorStatus): string {
  if (s.mode === "subscription")
    return s.subscription_connected === false
      ? "Your questions use this server's Claude subscription, which isn't connected yet: run deploy/advisor-token.sh on the Mac."
      : "Your questions use this server's Claude subscription.";
  if (s.mode === "own_key") return `Your questions use your own Anthropic API key ending ${s.key_hint ?? "…"}, billed to your Anthropic account.`;
  if (s.reason === "needs_key") return "Add your own Anthropic API key to ask Claude about your decks. Questions are billed to your Anthropic account.";
  if (s.reason === "keys_off") return "Ask Claude is only available to this server's owner.";
  return "Ask Claude isn't set up on this server.";
}

/** A row for the You section (Group). `className` matches the section's own rows. */
export function AdvisorSettings({ className = "grp-you-row grp-you-stack" }: { className?: string }) {
  const qc = useQueryClient();
  const status = useAdvisorStatus();
  const [key, setKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [cleared, setCleared] = useState(false);
  const put = (s: AdvisorStatus) => qc.setQueryData(["advisor", "status"], s);
  const save = useMutation({
    mutationFn: () => saveKey(key.trim()),
    onSuccess: (s) => {
      put(s);
      setKey("");
      setAdding(false);
    },
  });
  const remove = useMutation({ mutationFn: removeKey, onSuccess: put });
  const model = useMutation({ mutationFn: setModel, onSuccess: put });
  const clear = useMutation({
    mutationFn: deleteAllConversations,
    onSuccess: () => {
      setCleared(true);
      void qc.invalidateQueries({ queryKey: ["advisor"] });
    },
  });
  const s = status.data;
  if (!s) return <ErrorText error={status.error} />;
  if (s.reason === "off") return null;
  return (
    <div className={`${className} advisor-settings`}>
      <div className="grp-you-line">
        <span className="grp-you-text">
          <b>Ask Claude</b>
          <span>{modeLine(s)}</span>
          {s.per_day != null && s.available && <span>{`${s.used_today} of ${s.per_day} questions in the last 24 hours.`}</span>}
        </span>
        {s.can_save_key && s.mode !== "subscription" && !adding && (
          s.has_key ? (
            <button type="button" className="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove key</button>
          ) : (
            <button type="button" onClick={() => setAdding(true)}>Add key</button>
          )
        )}
      </div>
      {adding && (
        <form
          className="advisor-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label>
            Anthropic API key
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" required />
          </label>
          <p className="small dim">
            Make one at console.anthropic.com. Yama stores it encrypted, uses it only for your questions, and never shows it again. Remove it here at any time.
          </p>
          <div className="row">
            <button className="primary" disabled={!key.trim() || save.isPending}>Save key</button>
            <button type="button" className="quiet" onClick={() => { setAdding(false); setKey(""); }}>Cancel</button>
          </div>
        </form>
      )}
      {s.available && (
        <div className="advisor-model-row">
          <label>
            Model
            <select value={s.model} onChange={(e) => model.mutate(e.target.value)} disabled={model.isPending}>
              {s.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}: {m.note}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="quiet" onClick={() => clear.mutate()} disabled={clear.isPending}>Delete all conversations</button>
        </div>
      )}
      {cleared && <p className="small" role="status">Every conversation is deleted.</p>}
      <ErrorText error={save.error ?? remove.error ?? model.error ?? clear.error} />
    </div>
  );
}
