import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type User } from "../api";
import { useAuthConfig, useLogout, useMe } from "../auth";
import { contactHref } from "../components/PowerOnly";
import { ErrorText } from "../components/ui";
import { downloadOfflineCards, useOfflineCards } from "../offline/cards";
import { keepStorage } from "../storage";
import { AdvisorSettings } from "../advisor/AdvisorSettings";
import { DeleteAccount } from "./DeleteAccount";
import "./group.css";
import { count, shortDate } from "@yama/core";

export function AccountSettings() {
  const me = useMe();
  const logout = useLogout();
  const authConfig = useAuthConfig();
  const [signOutError, setSignOutError] = useState<unknown>(null);
  return (
    <section className="grp-section" aria-labelledby="grp-you">
      <h2 id="grp-you">Account settings</h2>
      <div className="grp-you">
        {me.data && <YourName me={me.data} />}
        <OfflineCardsSetting />
        {!me.data?.viewing && <div className="grp-you-row" id="sharing"><span className="grp-you-text"><b>Sharing</b><span>Your public profile, shared decks, builds and privacy settings.</span></span><Link className="button outline" to="/sharing">Open Sharing</Link></div>}
        {/* Ask Claude stays private while an admin views as you (server/src/view_as.rs). */}
        {!me.data?.viewing && me.data?.power && <AdvisorSettings />}
        {me.data?.is_admin && (
          <div className="grp-you-row">
            <span className="grp-you-text">
              <b>Admin</b>
              <span>Who can sign in, accounts, usage and the server.</span>
            </span>
            <Link className="button" to="/admin">Open</Link>
          </div>
        )}
        <div className="grp-you-row grp-you-actions">
          <button className="outline" onClick={() => logout().catch(setSignOutError)}>Sign out</button>
          <Link className="grp-new" to="/new">What's new in Yama</Link>
          <a className="grp-new" href={contactHref()}>Help and contact</a>
        </div>
        <ErrorText error={signOutError} />
        {/* Not while an admin views as you (read only), nor for an admin or behind Cloudflare Access, which would make the account again. */}
        {me.data && !me.data.viewing && !me.data.is_admin && !authConfig.data?.cf_access && <DeleteAccount email={me.data.email} />}
      </div>
      <p className="small dim" style={{ margin: 0 }}>Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast.</p>
    </section>
  );
}

/** The server's cap on a display name (server/src/auth.rs, MAX_NAME). */
const NAME_MAX = 60;

/** The name you go by, and changing it. Read only while an admin views as you. */
export function YourName({ me }: { me: User }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.display_name);
  const save = useMutation({
    mutationFn: () => api<User>("/api/me", { method: "PATCH", json: { display_name: name } }),
    onSuccess: () => {
      setEditing(false);
      // Asked again rather than written here, so the copy kept on this device follows too.
      void qc.invalidateQueries({ queryKey: ["me"] });
      // Playgroup member lists and game seats show the name.
      void qc.invalidateQueries({ queryKey: ["playgroups"] });
    },
  });
  if (!editing) {
    return (
      <div className="grp-you-row">
        <span className="grp-you-text">
          <b>{me.display_name}</b>
          <span>Signed in as {me.email}</span>
        </span>
        {!me.viewing && <button className="outline" onClick={() => { setName(me.display_name); save.reset(); setEditing(true); }}>Change name</button>}
      </div>
    );
  }
  return (
    <div className="grp-you-row grp-you-stack">
      <form className="grp-guest" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>
          <span className="visually-hidden">Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} required autoFocus autoComplete="nickname" />
        </label>
        <span className="grp-you-actions">
          <button disabled={save.isPending || name.trim() === ""}>Save name</button>{" "}
          <button type="button" className="outline" disabled={save.isPending} onClick={() => setEditing(false)}>Cancel</button>
        </span>
      </form>
      <span className="small dim">The name your playgroup and the people you play with see. Your shared pages go by your handle.</span>
      <ErrorText error={save.error} />
    </div>
  );
}

function OfflineCardsSetting() {
  const s = useOfflineCards();
  const saved = s.savedAt ? shortDate(s.savedAt) : "";
  return (
    <div className="grp-you-row grp-you-stack">
      <div className="grp-you-line">
        <span className="grp-you-text">
          <b>Cards on this device</b>
          <span>
            {s.count
              ? `${count(s.count)} cards saved ${saved}, so search works offline`
              : "Save every card's rules text (a 5 MB download) so card search works without signal."}
          </span>
        </span>
        <button
          onClick={() => {
            keepStorage();
            void downloadOfflineCards();
          }}
          disabled={s.downloading}
        >
          {s.downloading ? "Saving…" : s.count ? "Update" : "Save"}
        </button>
      </div>
      <ErrorText small error={s.error} />
    </div>
  );
}
