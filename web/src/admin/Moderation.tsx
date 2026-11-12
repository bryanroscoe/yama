import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ago } from "@yama/core";
import { ActionBar, Button, EmptyState, ErrorText } from "../components/ui";
import { adminApi, type ContentReport, type Moderation, type Takedown } from "./api";

const KEY = ["admin-moderation"];

/** What a report or takedown is about, as a link to the public page when there still is one. */
function pagePath(r: ContentReport): string | null {
  if (r.kind === "profile") return r.handle ? `/u/${r.handle}` : null;
  return r.deck_token && r.deck_visibility !== "private" && !r.deck_taken_down && !r.deck_archived ? `/d/${r.deck_token}` : null;
}

/** Reports of shared decks and profiles, and decks taken down (server/src/moderation.rs). A
 *  whole account is turned off on the People page. */
export function ModerationPage() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: KEY, queryFn: adminApi.moderation });
  const set = (next: Moderation) => qc.setQueryData(KEY, next);
  const m = data.data;
  const label = (reason: string) => m?.reasons.find(([value]) => value === reason)?.[1] ?? reason;
  return (
    <>
      <section className="admin-section" aria-labelledby="adm-reports">
        <div className="admin-section-head">
          <h2 id="adm-reports">Reports of shared pages</h2>
          <span className="dim">Sent from the Report link on shared decks and profiles. Nothing about the sender is kept.</span>
        </div>
        <ErrorText error={data.error} />
        {m?.open.length === 0 && <EmptyState variant="compact">No reports are waiting.</EmptyState>}
        <ul className="admin-list">
          {m?.open.map((r) => (
            <ReportRow key={r.id} report={r} reason={label(r.reason)} onDone={set} />
          ))}
        </ul>
      </section>

      <section className="admin-section" aria-labelledby="adm-takedown">
        <div className="admin-section-head">
          <h2 id="adm-takedown">Take a deck down</h2>
          <span className="dim">Makes the deck and its configurations private until you restore it. Its owner sees the reason if they try to share it again.</span>
        </div>
        <TakeDownForm onDone={set} />
        {m && m.takedowns.length > 0 && (
          <ul className="admin-list">
            {m.takedowns.map((t) => (
              <TakedownRow key={t.id} takedown={t} onDone={set} />
            ))}
          </ul>
        )}
      </section>

      {m && m.resolved.length > 0 && (
        <section className="admin-section" aria-labelledby="adm-resolved">
          <div className="admin-section-head">
            <h2 id="adm-resolved">Dealt with</h2>
            <span className="dim">The latest {m.resolved.length}.</span>
          </div>
          <ul className="admin-list">
            {m.resolved.map((r) => (
              <li key={r.id}>
                <div className="admin-text">
                  <b>{r.kind === "deck" ? (r.deck_name ?? "A deck that's gone") : `@${r.handle ?? "no handle"}`}</b>
                  <span>
                    {label(r.reason)}. {r.resolution === "taken_down" ? "Taken down" : "Dismissed"} {r.resolved_at ? ago(r.resolved_at) : ""}
                    {r.note ? `: ${r.note}` : "."}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ReportRow({ report: r, reason, onDone }: { report: ContentReport; reason: string; onDone: (m: Moderation) => void }) {
  const [why, setWhy] = useState(reason);
  const dismiss = useMutation({ mutationFn: () => adminApi.dismissReport(r.id), onSuccess: onDone });
  const takeDown = useMutation({ mutationFn: () => adminApi.takeDown(r.deck_id ?? "", why.trim()), onSuccess: onDone });
  const path = pagePath(r);
  const busy = dismiss.isPending || takeDown.isPending;
  return (
    <li>
      <div className="admin-text">
        <b>{r.kind === "deck" ? (r.deck_name ?? "A deck that's gone") : `Profile @${r.handle ?? "no handle"}`}</b>
        <span>
          {reason}, reported {ago(r.created_at)}. {r.owner_email}
          {r.handle && r.kind === "deck" ? `, @${r.handle}` : ""}.
        </span>
        {r.details && <span className="admin-quote">{r.details}</span>}
        {path ? (
          <span>
            <a href={path} target="_blank" rel="noreferrer">
              Open the page
            </a>
          </span>
        ) : (
          <span>The page is no longer shared.</span>
        )}
        <ErrorText error={dismiss.error ?? takeDown.error} />
      </div>
      <ActionBar className="admin-actions">
        <Button variant="outline" disabled={busy} onClick={() => dismiss.mutate()}>
          Dismiss
        </Button>
      </ActionBar>
      {r.kind === "deck" && r.deck_id && !r.deck_taken_down && (
        <form
          className="admin-form admin-shared"
          onSubmit={(e) => {
            e.preventDefault();
            takeDown.mutate();
          }}
        >
          <label>
            Why it is coming down (its owner sees this if they try to share it again)
            <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} />
          </label>
          <Button type="submit" variant="outline" danger disabled={busy || !why.trim()}>
            Take down
          </Button>
        </form>
      )}
    </li>
  );
}

function TakeDownForm({ onDone }: { onDone: (m: Moderation) => void }) {
  const [deck, setDeck] = useState("");
  const [why, setWhy] = useState("");
  const takeDown = useMutation({
    mutationFn: () => adminApi.takeDown(deck.trim(), why.trim()),
    onSuccess: (m) => {
      setDeck("");
      setWhy("");
      onDone(m);
    },
  });
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        takeDown.mutate();
      }}
    >
      <label>
        The deck's shared page address
        <input value={deck} onChange={(e) => setDeck(e.target.value)} placeholder="https://yama.ing/d/…" autoComplete="off" />
      </label>
      <label>
        Why (its owner sees this if they try to share it again)
        <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} />
      </label>
      <Button type="submit" variant="outline" danger disabled={takeDown.isPending || !deck.trim() || !why.trim()}>
        Take down
      </Button>
      <ErrorText error={takeDown.error} />
    </form>
  );
}

function TakedownRow({ takedown: t, onDone }: { takedown: Takedown; onDone: (m: Moderation) => void }) {
  const restore = useMutation({ mutationFn: () => adminApi.restoreDeck(t.id), onSuccess: onDone });
  return (
    <li className={t.restored_at ? "is-off" : undefined}>
      <div className="admin-text">
        <b>{t.deck_name}</b>
        <span>
          {t.owner_email}
          {t.handle ? `, @${t.handle}` : ""}. Taken down {ago(t.created_at)} by {t.admin_email ?? "an admin who has left"}; it was {t.was_visibility === "public" ? "public" : t.was_visibility === "link" ? "shared by link" : "private"}.
        </span>
        <span className="admin-quote">{t.reason}</span>
        {t.restored_at && <span>Restored {ago(t.restored_at)}. It stays private until its owner shares it again.</span>}
        <ErrorText error={restore.error} />
      </div>
      {!t.restored_at && (
        <ActionBar className="admin-actions">
          <Button variant="outline" disabled={restore.isPending} onClick={() => restore.mutate()}>
            Restore
          </Button>
        </ActionBar>
      )}
    </li>
  );
}
