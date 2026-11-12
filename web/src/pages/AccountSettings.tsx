import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type User } from "../api";
import { advancedOf, useAuthConfig, useLogout, useMe } from "../auth";
import { Button, ErrorText } from "../components/ui";
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
      <h2 id="grp-you">Settings</h2>
      <div className="grp-you">
        {me.data && <YourName me={me.data} />}
        <OfflineCardsSetting />
        {me.data && !me.data.viewing && <AdvancedSetting me={me.data} />}
        {/* Ask Claude stays private while an admin views as you (server/src/view_as.rs). */}
        {!me.data?.viewing && me.data?.power && <AdvisorSettings />}
        <div className="grp-you-row grp-you-actions">
          <Button variant="outline" onClick={() => logout().catch(setSignOutError)}>Sign out</Button>
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
        {!me.viewing && <Button variant="outline" onClick={() => { setName(me.display_name); save.reset(); setEditing(true); }}>Change name</Button>}
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
          <Button type="submit" disabled={save.isPending || name.trim() === ""}>Save name</Button>{" "}
          <Button variant="outline" disabled={save.isPending} onClick={() => setEditing(false)}>Cancel</Button>
        </span>
      </form>
      <span className="small dim">The name your playgroup and the people you play with see. Your shared pages go by your handle.</span>
      <ErrorText error={save.error} />
    </div>
  );
}

/**
 * Advanced: whether the app shows the Workshop. Off for a new account, which has nothing there;
 * on by itself for admins, power users and anyone who already has a plan, a lab run, a Mythic
 * link or a wish, until they choose here. It hides navigation only: the pages stay open by link.
 */
export function AdvancedSetting({ me }: { me: User }) {
  const qc = useQueryClient();
  const on = advancedOf(me);
  const set = useMutation({
    mutationFn: (advanced: boolean) => api<User>("/api/me", { method: "PATCH", json: { advanced } }),
    // Asked again rather than written here, so the copy kept on this device follows too.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <div className="grp-you-row grp-you-stack">
      <div className="grp-you-line">
        <span className="grp-you-text">
          <b>Advanced: {on ? "on" : "off"}</b>
          <span>
            {on
              ? "The Workshop is showing: plans, getting the cards, swap sheets, simulations and datasets."
              : "Turn it on to show the Workshop: plans, getting the cards, swap sheets, simulations and datasets."}
          </span>
        </span>
        <Button variant="outline" disabled={set.isPending} onClick={() => set.mutate(!on)}>
          {on ? "Turn off Advanced" : "Turn on Advanced"}
        </Button>
      </div>
      <ErrorText small error={set.error} />
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
        <Button
          onClick={() => {
            keepStorage();
            void downloadOfflineCards();
          }}
          disabled={s.downloading}
        >
          {s.downloading ? "Saving…" : s.count ? "Update" : "Save"}
        </Button>
      </div>
      <ErrorText small error={s.error} />
    </div>
  );
}
