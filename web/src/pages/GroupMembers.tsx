import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Member, type Playgroup } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { ask } from "../components/confirm";

/** The server's caps (server/src/playgroups.rs), so the fields stop where a save would. */
const NAME_MAX = 60;
const GUEST_NAME_MAX = 40;

/**
 * Who is in a playgroup, and what each person may do about it. Any member adds guests and may
 * leave; the owner also renames the group, makes a new join code, removes people, hands the group
 * on and deletes it (server/src/playgroups.rs has the rules).
 */
export function Members({ group }: { group: Playgroup }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const owner = !!me && group.owner_id === me.id;
  const others = group.members.filter((m) => m.user_id && m.user_id !== me?.id);
  // Everything here changes what the Group page shows (and, for a removal, the group's games).
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["playgroups"] });
    void qc.invalidateQueries({ queryKey: ["stats", group.id] });
    void qc.invalidateQueries({ queryKey: ["games"] });
  };
  // After leaving or deleting, this group's own stats and games would only answer "not found":
  // ask again for the list of groups and for games outside it.
  const gone = () => {
    void qc.invalidateQueries({ queryKey: ["playgroups"] });
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "games" && q.queryKey[1] !== "group" });
  };
  const [guest, setGuest] = useState("");
  const addGuest = useMutation({
    mutationFn: () => api(`/api/playgroups/${group.id}/guests`, { method: "POST", json: { name: guest } }),
    onSuccess: () => {
      setGuest("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (m: Member) => api(`/api/playgroups/${group.id}/members/${m.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const handOn = useMutation({
    mutationFn: (m: Member) => api(`/api/playgroups/${group.id}/owner`, { method: "POST", json: { member_id: m.id } }),
    onSuccess: refresh,
  });
  const leave = useMutation({ mutationFn: () => api(`/api/playgroups/${group.id}/leave`, { method: "POST" }), onSuccess: gone });
  const error = addGuest.error ?? remove.error ?? handOn.error ?? leave.error;
  const busy = remove.isPending || handOn.isPending || leave.isPending;

  const askRemove = async (m: Member) => {
    const body = m.user_id
      ? "Their past games stay. The join code changes, so share the new one with anyone you invite next."
      : "Their past games stay under their name.";
    if (await ask({ title: `Remove ${m.display_name} from ${group.name}?`, body, confirm: "Remove", danger: true })) remove.mutate(m);
  };
  const askHandOn = async (m: Member) => {
    if (await ask({ title: `Make ${m.display_name} the owner of ${group.name}?`, body: "You stay a member, and only they can then rename it, remove people or delete it.", confirm: "Make them the owner", danger: true })) handOn.mutate(m);
  };
  const askLeave = async () => {
    const next = owner ? "It passes to the member who has been in it longest. " : "";
    if (await ask({ title: `Leave ${group.name}?`, body: `${next}Games you played stay in your own history.`, confirm: "Leave", danger: true })) leave.mutate();
  };

  return (
    <section className="grp-section" aria-labelledby="grp-members">
      <h2 id="grp-members">Members</h2>
      <ul className="grp-you grp-members">
        {group.members.map((m) => {
          const mine = !!m.user_id && m.user_id === me?.id;
          const role = m.user_id === group.owner_id ? "Owner" : m.user_id ? "Member" : "Guest, no account";
          return (
            <li key={m.id} className="grp-you-row">
              <span className="grp-you-text">
                <b>{m.display_name}{mine ? " (you)" : ""}</b>
                <span>{role}</span>
              </span>
              {owner && !mine && (
                <span className="grp-member-actions">
                  {m.user_id && <button className="outline" disabled={busy} onClick={() => askHandOn(m)} aria-label={`Make ${m.display_name} the owner`}>Make owner</button>}
                  <button className="outline" disabled={busy} onClick={() => askRemove(m)} aria-label={`Remove ${m.display_name}`}>Remove</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="dim" style={{ margin: 0 }}>Friends with an account join with the code {group.join_code}. Add a guest for anyone without one.</p>
      <form className="grp-guest" onSubmit={(e) => { e.preventDefault(); addGuest.mutate(); }}>
        <label>
          <span className="visually-hidden">Guest name</span>
          <input value={guest} onChange={(e) => setGuest(e.target.value)} placeholder="Guest name" maxLength={GUEST_NAME_MAX} required />
        </label>
        <button disabled={addGuest.isPending}>Add guest</button>
      </form>
      <ErrorText error={error} />
      {owner && <OwnerTools group={group} alone={others.length === 0} onChange={refresh} onGone={gone} />}
      {/* The only account in a group can't leave it to nobody: they delete it (owner tools). */}
      {me && (!owner || others.length > 0) && (
        <div className="grp-you-row grp-you-actions">
          <button className="outline" disabled={busy} onClick={askLeave}>Leave this playgroup</button>
        </div>
      )}
    </section>
  );
}

/** Rename, a new join code and deleting: the owner's part of the Members section. */
function OwnerTools({ group, alone, onChange, onGone }: { group: Playgroup; alone: boolean; onChange: () => void; onGone: () => void }) {
  const [name, setName] = useState(group.name);
  const [renaming, setRenaming] = useState(false);
  const rename = useMutation({
    mutationFn: () => api(`/api/playgroups/${group.id}`, { method: "PATCH", json: { name } }),
    onSuccess: () => {
      setRenaming(false);
      onChange();
    },
  });
  const newCode = useMutation({ mutationFn: () => api(`/api/playgroups/${group.id}/code`, { method: "POST" }), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => api(`/api/playgroups/${group.id}`, { method: "DELETE" }), onSuccess: onGone });
  const askNewCode = async () => {
    if (await ask({ title: `Make a new join code for ${group.name}?`, body: `The code ${group.join_code} stops working. Everyone already in the group stays.`, confirm: "Make a new code", danger: true })) newCode.mutate();
  };
  const askDelete = async () => {
    if (await ask({ title: `Delete ${group.name}?`, body: "Its stats and guests go. The games stay in your own history, without the playgroup. This can't be undone.", confirm: "Delete playgroup", danger: true })) remove.mutate();
  };
  return (
    <div className="grp-you" role="group" aria-label="Owner settings">
      {renaming ? (
        <form className="grp-guest" onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
          <label>
            <span className="visually-hidden">Playgroup name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} required autoFocus />
          </label>
          <span className="grp-member-actions">
            <button disabled={rename.isPending || name.trim() === ""}>Save name</button>
            <button type="button" className="outline" disabled={rename.isPending} onClick={() => setRenaming(false)}>Cancel</button>
          </span>
        </form>
      ) : (
        <div className="grp-you-row">
          <span className="grp-you-text"><b>Name</b><span>{group.name}</span></span>
          <button className="outline" onClick={() => { setName(group.name); setRenaming(true); }}>Rename</button>
        </div>
      )}
      <div className="grp-you-row">
        <span className="grp-you-text"><b>Join code {group.join_code}</b><span>A new code stops the old one working. Removing someone with an account changes it too.</span></span>
        <button className="outline" disabled={newCode.isPending} onClick={askNewCode}>New code</button>
      </div>
      <div className="grp-you-row">
        <span className="grp-you-text">
          <b>Delete this playgroup</b>
          <span>{alone ? "Its games stay in your history, without the playgroup." : "Other people are in it. Leave to hand it on, or remove them first."}</span>
        </span>
        <button className="outline" disabled={!alone || remove.isPending} onClick={askDelete}>Delete</button>
      </div>
      <ErrorText error={rename.error ?? newCode.error ?? remove.error} />
    </div>
  );
}
