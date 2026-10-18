import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PlaygroupStats, type Playgroup } from "../api";
import { useLogout, useMe } from "../auth";
import { ErrorText } from "../components/ui";

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
      {s && s.games > 0 ? (
        <>
          <div className="figures">
            <div className="figure"><b className="num">{s.games}</b><span>games recorded</span></div>
            {s.average_turns != null && <div className="figure"><b className="num">{s.average_turns.toFixed(1)}</b><span>turns on average</span></div>}
            {s.average_minutes != null && <div className="figure"><b className="num">{Math.round(s.average_minutes)}</b><span>minutes on average</span></div>}
          </div>
          <section>
            <h2>Players</h2>
            <table className="plain">
              <thead><tr><th>Player</th><th className="r">Games</th><th className="r">Wins</th><th className="r">Win rate</th></tr></thead>
              <tbody>
                {s.players.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className="r num">{p.games}</td>
                    <td className="r num">{p.wins}</td>
                    <td className="r num">{Math.round((100 * p.wins) / p.games)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h2>Commanders</h2>
            <table className="plain">
              <thead><tr><th>Commander</th><th className="r">Games</th><th className="r">Wins</th></tr></thead>
              <tbody>
                {s.commanders.map((c) => (
                  <tr key={c.commander}>
                    <td>{c.commander}</td>
                    <td className="r num">{c.games}</td>
                    <td className="r num">{c.wins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <p className="dim">No finished games yet. Play one from the Table tab with this playgroup chosen, and the stats start here.</p>
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
      <div><button onClick={() => void logout()}>Sign out</button></div>
    </section>
  );
}
