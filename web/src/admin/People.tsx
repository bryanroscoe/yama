import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accountLine } from "../accounts";
import { api, type AccountInfo } from "../api";
import { useAuthConfig, useMe } from "../auth";
import { ErrorText, Sheet } from "../components/ui";
import { adminApi, type ViewLogRow } from "./api";
import { startViewing } from "../viewing";
import { ago, confirms, deleteSummary, searchAccounts } from "./logic";

const signInWays = (a: AccountInfo) => {
  const ways = [a.google && "Google", a.password && "a password"].filter(Boolean);
  return ways.length ? `Signs in with ${ways.join(" or ")}.` : "Signs in through the server's own sign-in.";
};

const seenLine = (a: AccountInfo) =>
  a.last_seen_at ? `Last seen ${ago(a.last_seen_at)}.` : a.last_sign_in ? `Last signed in ${ago(a.last_sign_in)}.` : "Not seen yet.";

export function PeoplePage() {
  const me = useMe();
  const qc = useQueryClient();
  const auth = useAuthConfig(true);
  const open = auth.data?.open_signup === true;
  const [q, setQ] = useState("");
  const [deleting, setDeleting] = useState<AccountInfo | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const accounts = useQuery({ queryKey: ["admin-users"], queryFn: () => api<AccountInfo[]>("/api/admin/users") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
    void qc.invalidateQueries({ queryKey: ["invites"] });
    void qc.invalidateQueries({ queryKey: ["admin-usage"] });
  };
  const toggle = useMutation({
    mutationFn: (a: AccountInfo) => api(`/api/admin/users/${encodeURIComponent(a.id)}/${a.disabled_at ? "enable" : "disable"}`, { method: "POST" }),
    onSuccess: refresh,
  });
  const invite = useMutation({ mutationFn: (a: AccountInfo) => (a.invited ? adminApi.uninvite(a.id) : adminApi.invite(a.id)), onSuccess: refresh });
  // View as: the page reloads as them (viewing.ts), so there's nothing to do on success here.
  const view = useMutation({ mutationFn: (a: AccountInfo) => startViewing(a.id) });

  const flip = (a: AccountInfo) => {
    if (!a.disabled_at && !window.confirm(`Disable ${a.email}? They're signed out at once and can't sign in until you enable the account again.`)) return;
    toggle.mutate(a);
  };
  const flipInvite = (a: AccountInfo) => {
    if (a.invited) {
      const after = open ? "They're signed out, and can sign in again with the smaller allowance." : "They're signed out and can't sign in again.";
      if (!window.confirm(`Remove ${a.email}'s invite? ${after}`)) return;
    }
    invite.mutate(a);
  };
  const list = searchAccounts(accounts.data ?? [], q);
  const total = accounts.data?.length ?? 0;

  return (
    <>
      <WhoCanSignIn open={open} />
      {done && (
        <p className="admin-done" role="status">
          {done}
        </p>
      )}
      <section className="admin-section" aria-labelledby="adm-people">
        <div className="admin-section-head">
          <h2 id="adm-people">People</h2>
          <span className="dim">{accounts.data ? `${total} ${total === 1 ? "account" : "accounts"}, newest first` : ""}</span>
        </div>
        <label className="admin-search">
          <span className="visually-hidden">Search people</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" />
        </label>
        <ErrorText error={accounts.error ?? toggle.error ?? invite.error ?? view.error} />
        {accounts.data && list.length === 0 && <p className="dim">Nobody matches that search.</p>}
        <ul className="admin-list">
          {list.map((a) => (
            <li key={a.id} className={a.disabled_at ? "is-off" : undefined}>
              <div className="admin-text">
                <b>{a.display_name}</b>
                <span>{accountLine(a)}</span>
                <span>
                  {signInWays(a)} {seenLine(a)}
                </span>
              </div>
              {!a.is_admin && a.id !== me.data?.id && (
                <div className="admin-actions">
                  <button className="outline" onClick={() => flipInvite(a)} disabled={invite.isPending}>
                    {a.invited ? "Remove invite" : "Invite"}
                  </button>
                  <button className="outline" onClick={() => flip(a)} disabled={toggle.isPending}>
                    {a.disabled_at ? "Enable" : "Disable"}
                  </button>
                  <button className="outline" onClick={() => view.mutate(a)} disabled={view.isPending} title="See Yama as they do, read only, for up to 30 minutes">
                    View as
                  </button>
                  <button className="outline danger" onClick={() => setDeleting(a)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <ViewLog />
      {deleting && (
        <DeleteSheet
          account={deleting}
          onClose={() => setDeleting(null)}
          onDone={(summary) => {
            setDone(summary);
            setDeleting(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

/** Who may sign in, invites for people who haven't joined yet, and the invite form. */
function WhoCanSignIn({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const invites = useQuery({ queryKey: ["invites"], queryFn: () => api<{ email: string; created_at: string }[]>("/api/invites") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["invites"] });
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
  };
  const add = useMutation({
    mutationFn: () => api("/api/invites", { method: "POST", json: { email } }),
    onSuccess: () => {
      setEmail("");
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (e: string) => api(`/api/invites/${encodeURIComponent(e)}`, { method: "DELETE" }), onSuccess: refresh });
  const n = invites.data?.length ?? 0;
  return (
    <section className="admin-section" aria-labelledby="adm-signin">
      <h2 id="adm-signin">Who can sign in</h2>
      <p className="admin-lead">
        {open
          ? "Anyone with a Google account can join. Invited people get the full lab, play and Ask Claude allowance; everyone else gets a smaller one."
          : "Only invited people can sign in."}{" "}
        {invites.data ? `${n} ${n === 1 ? "invite" : "invites"}.` : ""}
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label>
          <span>Invite someone by their Google email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" required />
        </label>
        <button disabled={add.isPending}>Invite</button>
      </form>
      <ErrorText error={add.error ?? remove.error ?? invites.error} />
      {n > 0 && (
        <details className="admin-details">
          <summary>Invites ({n})</summary>
          <ul className="admin-invites">
            {invites.data!.map((i) => (
              <li key={i.email}>
                <span>
                  {i.email} <span className="dim">invited {ago(i.created_at)}</span>
                </span>
                <button className="quiet" onClick={() => window.confirm(`Remove the invite for ${i.email}?`) && remove.mutate(i.email)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function DeleteSheet({ account, onClose, onDone }: { account: AccountInfo; onClose: () => void; onDone: (summary: string) => void }) {
  const [typed, setTyped] = useState("");
  const del = useMutation({ mutationFn: () => adminApi.deleteAccount(account.id, typed), onSuccess: (r) => onDone(deleteSummary(r)) });
  const ok = confirms(account.email, typed);
  return (
    <Sheet onClose={onClose} label={`Delete ${account.display_name}'s account`}>
      <div className="admin-sheet">
        <h2>Delete {account.display_name}'s account?</h2>
        <p>
          This deletes the account and everything it owns: decks, collection, plans, lab runs, Ask Claude conversations and keys,
          sessions and script keys. It can't be undone.
        </p>
        <p className="dim">
          Other people's records stay whole. Games it played with others stay without its name, playgroups it runs pass to
          another member, and its place in other playgroups becomes "Former member".
        </p>
        <label className="admin-confirm">
          <span>Type {account.email} to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <ErrorText error={del.error} />
        <div className="admin-actions">
          <button className="outline" onClick={onClose}>
            Cancel
          </button>
          <button className="danger-fill" disabled={!ok || del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? "Deleting…" : "Delete account and data"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

const endedText = (r: ViewLogRow) => {
  if (!r.ended_at) return Date.parse(r.expires_at) > Date.now() ? "still going" : "ran out";
  const mins = Math.max(1, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000));
  const how = { stopped: "stopped", expired: "ran out", "signed out": "signed out", replaced: "switched to someone else", ended: "ended" }[r.end_reason ?? "ended"] ?? "ended";
  return `${mins} ${mins === 1 ? "minute" : "minutes"}, ${how}`;
};

/** Every "View as", newest first: the audit log. */
function ViewLog() {
  const log = useQuery({ queryKey: ["admin-views"], queryFn: () => adminApi.views() });
  const n = log.data?.length ?? 0;
  return (
    <section className="admin-section" aria-labelledby="adm-views">
      <h2 id="adm-views">Viewing log</h2>
      <p className="admin-lead">
        View as shows Yama as that person sees it, read only, for up to 30 minutes. Every view is logged here, and the person sees it under
        Group, You.
      </p>
      <ErrorText error={log.error} />
      {log.data && n === 0 && <p className="dim">Nobody has used View as yet.</p>}
      {n > 0 && (
        <ul className="admin-list">
          {log.data!.map((r) => (
            <li key={r.id}>
              <div className="admin-text">
                <b>
                  {r.admin_name} viewed {r.target_name}
                </b>
                <span>
                  {r.target_email}, {ago(r.started_at)}: {endedText(r)}.
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
