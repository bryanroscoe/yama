import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, API_BASE, type PlaygroupStats, type Playgroup } from "../api";
import { useLogout, useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { GroupStats } from "../components/GroupStats";
import { downloadOfflineCards, useOfflineCards } from "../offline/cards";

export function GroupPage() {
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const [selected, setSelected] = useState<string | null>(null);
  const group = groups.data?.find((g) => g.id === selected) ?? groups.data?.[0];

  return (
    <main className="page">
      <div className="page-head">
        <h1>{group?.name ?? "Playgroup"}</h1>
        {groups.data && groups.data.length > 1 && (
          <select value={group?.id} onChange={(e) => setSelected(e.target.value)} style={{ width: "auto" }} aria-label="Playgroup">
            {groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>
      <ErrorText error={groups.error} />
      {groups.data?.length === 0 && <p className="empty">You're not in a playgroup yet. Start one for your table, or join with a friend's code.</p>}
      {group && <GroupDetail group={group} />}
      <ExportGames group={group} />
      <GroupActions />
      <Account />
    </main>
  );
}

function GroupDetail({ group }: { group: Playgroup }) {
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ["stats", group.id], queryFn: () => api<PlaygroupStats>(`/api/playgroups/${group.id}/stats`) });
  const [guest, setGuest] = useState("");
  const addGuest = useMutation({
    mutationFn: () => api(`/api/playgroups/${group.id}/guests`, { method: "POST", json: { name: guest } }),
    onSuccess: () => {
      setGuest("");
      void qc.invalidateQueries({ queryKey: ["playgroups"] });
    },
  });
  const s = stats.data;
  return (
    <div className="stack" style={{ marginBottom: "2.5rem" }}>
      <ErrorText error={stats.error} />
      {s && s.games > 0 ? (
        <GroupStats s={s} />
      ) : (
        s && <p className="dim">No finished games yet. Play one from the Table tab with this playgroup chosen, and the stats start here.</p>
      )}

      <section>
        <h2>Members</h2>
        <p className="dim">Friends join with the code <b className="num" style={{ color: "var(--paper)", letterSpacing: "0.08em" }}>{group.join_code}</b>. Add guests for people without an account.</p>
        <div className="list">
          {group.members.map((m) => (
            <div key={m.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="title">{m.display_name}</span>
              <span className="dim small">{m.user_id ? "Account" : "Guest"}</span>
            </div>
          ))}
        </div>
        <form className="row" style={{ marginTop: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); addGuest.mutate(); }}>
          <input value={guest} onChange={(e) => setGuest(e.target.value)} placeholder="Guest name" style={{ flex: "1 1 12rem" }} required />
          <button disabled={addGuest.isPending}>Add guest</button>
        </form>
        <ErrorText error={addGuest.error} />
      </section>
    </div>
  );
}

/** Game history as JSON (shaped for commander-decks' data/games.json) or CSV, one row per seat. */
function ExportGames({ group }: { group?: Playgroup }) {
  // The browser's time zone, so each game's date is the local day it was played, with daylight
  // saving as it was that day. The offset is the fallback if the server doesn't know the zone.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();
  const link = (ext: "json" | "csv", playgroup?: string) =>
    `${API_BASE}/api/games/export.${ext}?offset=${offset}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}${playgroup ? `&playgroup=${encodeURIComponent(playgroup)}` : ""}`;
  return (
    <section className="stack" style={{ marginBottom: "2.5rem", gap: "0.6rem" }}>
      <h2 style={{ margin: 0 }}>Export games</h2>
      <p className="dim small" style={{ margin: 0 }}>
        Finished games with seats, players, deck versions, who went first, the winner and how, knockouts and fun ratings. The JSON
        fits commander-decks' data/games.json; the CSV has one row per seat.
      </p>
      {group && (
        <div className="row">
          <span style={{ minWidth: "9rem" }}>{group.name}</span>
          <a className="button" href={link("json", group.id)} download>JSON</a>
          <a className="button" href={link("csv", group.id)} download>CSV</a>
        </div>
      )}
      <div className="row">
        <span style={{ minWidth: "9rem" }}>Every game you played or recorded</span>
        <a className="button" href={link("json")} download>JSON</a>
        <a className="button" href={link("csv")} download>CSV</a>
      </div>
    </section>
  );
}

function GroupActions() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: ["playgroups"] });
  const create = useMutation({ mutationFn: () => api("/api/playgroups", { method: "POST", json: { name } }), onSuccess: () => { setName(""); done(); } });
  const join = useMutation({ mutationFn: () => api("/api/playgroups/join", { method: "POST", json: { code } }), onSuccess: () => { setCode(""); done(); } });
  return (
    <section className="stack" style={{ marginBottom: "2.5rem" }}>
      <h2>Start or join a playgroup</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Playgroup name" required style={{ flex: "1 1 12rem" }} />
        <button disabled={create.isPending}>Start playgroup</button>
      </form>
      <form className="row" onSubmit={(e) => { e.preventDefault(); join.mutate(); }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Join code" required style={{ flex: "1 1 12rem" }} autoCapitalize="characters" />
        <button disabled={join.isPending}>Join</button>
      </form>
      <ErrorText error={create.error ?? join.error} />
    </section>
  );
}

function Account() {
  const me = useMe();
  const logout = useLogout();
  const [signOutError, setSignOutError] = useState<unknown>(null);
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const invites = useQuery({
    queryKey: ["invites"],
    queryFn: () => api<{ email: string; created_at: string }[]>("/api/invites"),
    enabled: !!me.data?.is_admin,
  });
  const invite = useMutation({
    mutationFn: () => api("/api/invites", { method: "POST", json: { email } }),
    onSuccess: () => {
      setEmail("");
      void qc.invalidateQueries({ queryKey: ["invites"] });
    },
  });
  return (
    <section className="stack">
      <h2>Account</h2>
      <p className="dim">Signed in as {me.data?.display_name} ({me.data?.email}).</p>
      {me.data?.is_admin && (
        <div className="stack">
          <h3>Who can sign in</h3>
          <p className="dim small">Yama is invite-only. Add a friend's Google email to let them in.</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" required style={{ flex: "1 1 14rem" }} />
            <button disabled={invite.isPending}>Invite</button>
          </form>
          <ErrorText error={invite.error} />
          {invites.data && invites.data.length > 0 && (
            <ul className="small dim">{invites.data.map((i) => <li key={i.email}>{i.email}</li>)}</ul>
          )}
        </div>
      )}
      <OfflineCardsSetting />
      <p style={{ margin: 0 }}><Link to="/new">What's new in Yama</Link></p>
      <div><button onClick={() => logout().catch(setSignOutError)}>Sign out</button></div>
      <ErrorText error={signOutError} />
    </section>
  );
}

function OfflineCardsSetting() {
  const s = useOfflineCards();
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <h3>Cards on this device</h3>
      <p className="dim small">
        {s.count
          ? `${s.count.toLocaleString()} cards saved ${s.savedAt ? new Date(s.savedAt).toLocaleDateString() : ""}, so card search works without signal.`
          : "Save every card's rules text (a 5 MB download) so card search works without signal."}
      </p>
      <div className="row">
        <button onClick={() => void downloadOfflineCards()} disabled={s.downloading}>
          {s.downloading ? "Saving cards…" : s.count ? "Update saved cards" : "Save cards to this device"}
        </button>
      </div>
      {s.error && <p className="error small">{s.error}</p>}
    </div>
  );
}
