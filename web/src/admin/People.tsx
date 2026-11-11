import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accountLine } from "../accounts";
import { api, type AccountInfo } from "../api";
import { useAuthConfig, useMe } from "../auth";
import { ActionBar, Button, Dialog, ErrorText } from "../components/ui";
import { adminApi, type SharedGrant, type SharedOverview, type ViewLogRow } from "./api";
import { startViewing } from "../viewing";
import { confirms, deleteSummary, parseDailyCap, searchAccounts, sharedGrantLine, sharedSummary } from "./logic";
import { ago } from "@yama/core";
import { ask } from "../components/confirm";

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
  const accounts = useQuery({ queryKey: ["admin-users"], queryFn: ({ signal }) => api<AccountInfo[]>("/api/admin/users", { signal }) });
  const shared = useQuery({ queryKey: ["admin-shared"], queryFn: adminApi.sharedOverview });
  const sharing = shared.data?.enabled === true;
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
  const power = useMutation({ mutationFn: (a: AccountInfo) => adminApi.setPower(a.id, !a.power_user), onSuccess: refresh });
  // View as: the page reloads as them (viewing.ts), so there's nothing to do on success here.
  const view = useMutation({ mutationFn: (a: AccountInfo) => startViewing(a.id) });

  const flip = async (a: AccountInfo) => {
    if (!a.disabled_at && !(await ask({ title: `Disable ${a.email}?`, body: "They're signed out at once and can't sign in until you enable the account again.", confirm: "Disable account", danger: true }))) return;
    toggle.mutate(a);
  };
  const flipPower = async (a: AccountInfo) => {
    if (a.power_user && !(await ask({ title: `Stop ${a.email} being a power user?`, body: "They keep their runs but can't start simulations, watch AI games or ask Claude.", confirm: "Stop power user", danger: true }))) return;
    power.mutate(a);
  };
  const flipInvite = async (a: AccountInfo) => {
    if (a.invited) {
      const after = open ? "They're signed out, and can sign in again with the smaller allowance." : "They're signed out and can't sign in again.";
      if (!(await ask({ title: `Remove ${a.email}'s invite?`, body: after, confirm: "Remove invite", danger: true }))) return;
    }
    invite.mutate(a);
  };
  const list = searchAccounts(accounts.data ?? [], q);
  const total = accounts.data?.length ?? 0;

  return (
    <>
      <WhoCanSignIn open={open} />
      {sharing && <SharedKeySection overview={shared.data!} />}
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
        <ErrorText error={accounts.error ?? toggle.error ?? invite.error ?? power.error ?? view.error} />
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
                <ActionBar className="admin-actions">
                  <Button variant="outline" onClick={() => flipInvite(a)} disabled={invite.isPending}>
                    {a.invited ? "Remove invite" : "Invite"}
                  </Button>
                  <Button variant="outline" onClick={() => flipPower(a)} disabled={power.isPending} title="Power users may start simulations and watched AI games and ask Claude">
                    {a.power_user ? "Remove power user" : "Make power user"}
                  </Button>
                  <Button variant="outline" onClick={() => flip(a)} disabled={toggle.isPending}>
                    {a.disabled_at ? "Enable" : "Disable"}
                  </Button>
                  <Button variant="outline" onClick={() => view.mutate(a)} disabled={view.isPending} title="See Yama as they do, read only, for up to 30 minutes">
                    View as
                  </Button>
                  <Button variant="outline" danger onClick={() => setDeleting(a)}>
                    Delete
                  </Button>
                </ActionBar>
              )}
              {sharing && a.id !== me.data?.id && <SharedKeyControl account={a} grant={shared.data!.grants.find((g) => g.user_id === a.id)} />}
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
  const invites = useQuery({ queryKey: ["invites"], queryFn: ({ signal }) => api<{ email: string; created_at: string }[]>("/api/invites", { signal }) });
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
        <Button type="submit" disabled={add.isPending}>Invite</Button>
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
                <Button variant="quiet" onClick={async () => (await ask({ title: `Remove the invite for ${i.email}?`, confirm: "Remove invite", danger: true })) && remove.mutate(i.email)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** The shared API key: what it is, the month's spend, and whether the advisor holds it. */
function SharedKeySection({ overview }: { overview: SharedOverview }) {
  const n = overview.grants.length;
  return (
    <section className="admin-section" aria-labelledby="adm-shared">
      <h2 id="adm-shared">Ask Claude on the shared key</h2>
      <p className="admin-lead">
        People you turn on below ask Claude on your shared Anthropic API key, which you pay for per question (never your subscription). Their own key
        comes first if they add one. {n ? `${n} ${n === 1 ? "account has" : "accounts have"} it.` : "Nobody has it yet."}
      </p>
      <p className="admin-lead">{sharedSummary(overview)}</p>
    </section>
  );
}

/** One account's toggle for the shared key, and its daily cap. */
function SharedKeyControl({ account, grant }: { account: AccountInfo; grant: SharedGrant | undefined }) {
  const qc = useQueryClient();
  const [cap, setCap] = useState(grant?.daily_limit != null ? String(grant.daily_limit) : "");
  const put = (o: SharedOverview) => {
    qc.setQueryData(["admin-shared"], o);
    void qc.invalidateQueries({ queryKey: ["admin-usage"] });
  };
  const on = useMutation({ mutationFn: (limit: number | null) => adminApi.grantShared(account.id, limit), onSuccess: put });
  const off = useMutation({ mutationFn: () => adminApi.revokeShared(account.id), onSuccess: put });
  const parsed = parseDailyCap(cap);
  const busy = on.isPending || off.isPending;
  return (
    <div className="admin-shared">
      <label className="admin-check">
        <input type="checkbox" checked={!!grant} disabled={busy} onChange={(e) => (e.target.checked ? on.mutate(parsed === "invalid" ? null : parsed) : off.mutate())} />
        Ask Claude on the shared key
      </label>
      {grant && (
        <>
          <span className="admin-shared-line">{sharedGrantLine(grant)}</span>
          <form
            className="admin-shared-cap"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed !== "invalid") on.mutate(parsed);
            }}
          >
            <label>
              <span>Daily cap (blank for the usual)</span>
              <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Usual allowance" aria-invalid={parsed === "invalid"} />
            </label>
            <Button type="submit" variant="outline" disabled={busy || parsed === "invalid" || parsed === grant.daily_limit}>
              Save cap
            </Button>
          </form>
          {parsed === "invalid" && <span className="error small">A daily cap is a whole number from 1 to 1,000, or blank for the usual allowance.</span>}
        </>
      )}
      <ErrorText error={on.error ?? off.error} />
    </div>
  );
}

function DeleteSheet({ account, onClose, onDone }: { account: AccountInfo; onClose: () => void; onDone: (summary: string) => void }) {
  const [typed, setTyped] = useState("");
  const del = useMutation({ mutationFn: () => adminApi.deleteAccount(account.id, typed), onSuccess: (r) => onDone(deleteSummary(r)) });
  const ok = confirms(account.email, typed);
  return (
    <Dialog onClose={onClose} label={`Delete ${account.display_name}'s account`}>
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
        <ActionBar className="admin-actions">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!ok || del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? "Deleting…" : "Delete account and data"}
          </Button>
        </ActionBar>
      </div>
    </Dialog>
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
        View as shows Yama as that person sees it, read only, for up to 30 minutes. Every view is logged here, for admins only.
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
