import { useState } from "react";
import { Link } from "react-router";
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
        <div className="grp-you-row">
          <span className="grp-you-text">
            <b>{me.data?.display_name}</b>
            <span>Signed in as {me.data?.email}</span>
          </span>
        </div>
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
