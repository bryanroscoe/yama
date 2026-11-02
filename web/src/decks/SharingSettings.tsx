import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, publicOrigin, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { useCopy, VISIBILITY_CHOICES } from "./ShareDeck";
import "./share.css";

/** Sharing: your handle and profile, what new decks start as, and the collection. */
export function SharingSettings() {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: () => api<Sharing>("/api/me/sharing"), enabled: !!userId });
  const [handle, setHandle] = useState("");
  useEffect(() => {
    if (sharing.data) setHandle(sharing.data.handle ?? "");
  }, [sharing.data]);
  const [copied, copy] = useCopy();
  const done = (s: Sharing) => {
    qc.setQueryData(["sharing", userId], s);
    void qc.invalidateQueries({ queryKey: ["decks"] });
    void qc.invalidateQueries({ queryKey: ["deck"] });
  };
  const save = useMutation({
    mutationFn: (json: Record<string, unknown>) => api<Sharing>("/api/me/sharing", { method: "PUT", json }),
    onSuccess: done,
  });
  const all = useMutation({
    mutationFn: (visibility: Visibility) => api<Sharing>("/api/me/sharing/decks", { method: "POST", json: { visibility } }),
    onSuccess: done,
  });
  const s = sharing.data;
  if (!s) return <ErrorText error={sharing.error} />;
  const profile = s.handle ? `${publicOrigin()}/u/${s.handle}` : null;
  const total = s.decks.private + s.decks.link + s.decks.public;
  const shareAll = (v: Visibility, ask: string) => confirm(ask) && all.mutate(v);

  return (
    <div className="grp-you-row grp-you-stack share-settings" id="sharing">
      <div className="grp-you-text">
        <b>Sharing</b>
        <span>
          Everything is private until you share it. Shared decks show their cards and printings, never prices you paid, notes, plans or
          games, and never your name or email.
        </span>
      </div>

      <form
        className="share-handle"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ handle: handle.trim() || null });
        }}
      >
        <label>
          Your handle
          <span className="hint">Your profile's address, /u/handle. 3 to 30 letters, digits, - or _. People seating a game can find you by it.</span>
          <span className="row">
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="saget" maxLength={31} autoCapitalize="none" spellCheck={false} />
            <button disabled={save.isPending || handle.trim().replace(/^@/, "").toLowerCase() === (s.handle ?? "")}>Save</button>
          </span>
        </label>
      </form>
      {profile && (
        <div className="row share-profile-link">
          <a href={profile} target="_blank" rel="noreferrer">{profile.replace(/^https?:\/\//, "")}</a>
          <button className="outline" onClick={() => void copy(profile)}>Copy profile link</button>
          {copied && <span className="small" role="status">{copied}</span>}
        </div>
      )}

      <label>
        New decks start as
        <select value={s.new_deck_visibility} onChange={(e) => save.mutate({ new_deck_visibility: e.target.value })} disabled={save.isPending}>
          {VISIBILITY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>

      <div className="grp-you-line">
        <span className="grp-you-text">
          <span>
            {total === 0
              ? "No decks yet."
              : `${s.decks.public} public, ${s.decks.link} shared by link, ${s.decks.private} private.`}
          </span>
        </span>
      </div>
      <div className="row">
        <button
          className="outline"
          disabled={all.isPending || total === 0 || s.decks.public === total}
          onClick={() => shareAll("public", `Make all ${total} decks public on your profile?${s.handle ? "" : " Pick a handle too, so your profile can list them."}`)}
        >
          Make all my decks public
        </button>
        {/* Outlined like its partner: a quiet button wrapped onto its own line on a phone and
            looked indented by its own padding. */}
        <button
          className="outline"
          disabled={all.isPending || total === 0 || s.decks.private === total}
          onClick={() => shareAll("private", `Make all ${total} decks private? Every link you've sent stops working until you share again.`)}
        >
          Make all private
        </button>
      </div>

      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.collection_public} disabled={save.isPending} onChange={(e) => save.mutate({ collection_public: e.target.checked })} />
        Show my collection on my profile
        <span className="hint">
          Card names, printings, finishes, conditions and counts of real cards. Not proxies, where they're filed, notes or prices.
          {!s.handle && " Needs a handle."}
        </span>
      </label>
      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.share_lab_results} disabled={save.isPending} onChange={(e) => save.mutate({ share_lab_results: e.target.checked })} />
        Show simulated win rates on shared decks
        <span className="hint">
          From your upgrade plan's newest lab run: the win rates of a shared deck's list and its public configurations, with their intervals. Not your plan's changes or other lists.
        </span>
      </label>
      <ErrorText error={save.error ?? all.error} />
    </div>
  );
}
