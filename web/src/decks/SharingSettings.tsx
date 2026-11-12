import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, publicOrigin, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { Button, ErrorText, Field } from "../components/ui";
import { useCopy, VISIBILITY_CHOICES } from "./ShareDeck";
import "./share.css";
import { ask } from "../components/confirm";
import { PublicDefaultDialog } from "./PublicDefaultPrompt";

/** A handle being typed, and the saved handle it was typed over. */
export interface TypedHandle {
  value: string;
  over: string | null;
}

/** The handle box's text: what's being typed while the saved handle is still the one it was typed over, else the saved handle. */
export function handleShown(typed: TypedHandle | null, saved: string | null): string {
  return typed && typed.over === saved ? typed.value : (saved ?? "");
}

/** Sharing: your handle and profile, what new decks start as, and the collection. */
export function SharingSettings() {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: !!userId });
  // What's typed in the handle box holds until the saved handle itself changes. It used to be
  // reset by any save on this form (changing "New decks start as" wiped a handle being typed).
  const [typed, setTyped] = useState<TypedHandle | null>(null);
  const handle = handleShown(typed, sharing.data?.handle ?? null);
  const setHandle = (value: string) => setTyped({ value, over: sharing.data?.handle ?? null });
  const [copied, copy] = useCopy();
  const viewing = !!useMe().data?.viewing;
  const [asking, setAsking] = useState(false);
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
  if (!s) return <ErrorText error={sharing.error} retry={() => void sharing.refetch()} />;
  const profile = s.handle ? `${publicOrigin()}/u/${s.handle}` : null;
  const total = s.decks.private + s.decks.link + s.decks.public;
  const shareAll = async (v: Visibility, title: string, body: string | undefined, confirm: string) => (await ask({ title, body, confirm, danger: true })) && all.mutate(v);

  return (
    <div className="grp-you-row grp-you-stack share-settings" id="sharing">
      <div className="grp-you-text">
        <b>Sharing</b>
        <span>
          New decks start as the setting below, and each deck's Share button changes it. A public deck is on your profile
          {s.public_listed_at ? ", listed in Browse and open to search engines" : ""}; a link-only deck is seen only by people who have its link.
          Shared decks show their cards and printings, never prices you paid, notes, plans or games, and never your name or email. Your
          collection, wish list, plans, games and playgroups stay private unless you share them.
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
          <span className="hint">3–30 letters, digits, - or _. Your profile is at /u/handle.</span>
          <span className="row">
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" maxLength={31} autoCapitalize="none" spellCheck={false} />
            <Button type="submit" disabled={save.isPending || handle.trim().replace(/^@/, "").toLowerCase() === (s.handle ?? "")}>Save</Button>
          </span>
        </label>
      </form>
      {profile && (
        <div className="row share-profile-link">
          <a href={profile} target="_blank" rel="noreferrer">{profile.replace(/^https?:\/\//, "")}</a>
          <Button variant="outline" onClick={() => void copy(profile)}>Copy profile link</Button>
          {copied && <span className="small" role="status">{copied}</span>}
        </div>
      )}

      {s.public_listed_at === null && !viewing && (
        <div className="public-default-banner">
          <span>Yama decks are now public by default. Yours stay as they are, and none is listed in Browse, until you answer.</span>
          <Button onClick={() => setAsking(true)}>Choose for your decks</Button>
        </div>
      )}
      {asking && s.public_listed_at === null && <PublicDefaultDialog sharing={s} onClose={() => setAsking(false)} />}

      <Field label="New decks start as">
        <select value={s.new_deck_visibility} onChange={(e) => save.mutate({ new_deck_visibility: e.target.value })} disabled={save.isPending}>
          {VISIBILITY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>

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
        <Button
          variant="outline"
          disabled={all.isPending || total === 0 || s.decks.public === total}
          onClick={() =>
            shareAll(
              "public",
              `Make all ${total} decks public?`,
              [s.public_listed_at ? "They are listed in Browse and open to search engines, as well as on your profile." : "They are listed on your profile.", s.handle ? "" : "Pick a handle too, so your profile can list them."].filter(Boolean).join(" "),
              "Make them public",
            )
          }
        >
          Make all my decks public
        </Button>
        {/* Outlined like its partner: a quiet button wrapped onto its own line on a phone and
            looked indented by its own padding. */}
        <Button
          variant="outline"
          disabled={all.isPending || total === 0 || s.decks.private === total}
          onClick={() => shareAll("private", `Make all ${total} decks private?`, "Every link you've sent stops working until you share again.", "Make them private")}
        >
          Make all private
        </Button>
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
        <input type="checkbox" checked={s.wants_public} disabled={save.isPending} onChange={(e) => save.mutate({ wants_public: e.target.checked })} />
        Show what I'm looking for on my profile
        <span className="hint">
          Missing real cards for your decks and approved upgrades, plus your wish list. Card names, quantities and market prices;
          not deck names, notes, stores or price limits.
          {!s.handle && " Needs a handle."}
        </span>
      </label>
      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.wants_include_pending ?? false} disabled={save.isPending} onChange={(e) => save.mutate({ wants_include_pending: e.target.checked })} />
        Include pending upgrades on my public want list
        <span className="hint">Show friends cards from plans still waiting for your OK. This doesn't approve the plans or buy anything.</span>
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
