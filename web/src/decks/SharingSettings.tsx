import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, publicOrigin, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { Button, ErrorText, Field } from "../components/ui";
import { handleProblem } from "./ChooseHandle";
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
  const setHandle = (value: string) => {
    setTyped({ value, over: sharing.data?.handle ?? null });
    // The server's answer was about the handle as it was sent.
    saveHandle.reset();
  };
  const problemId = useId();
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
  // The handle saves on its own, so what the server says about it (taken, not allowed) shows
  // under its box and not after the settings below it.
  const saveHandle = useMutation({
    mutationFn: (handle: string | null) => api<Sharing>("/api/me/sharing", { method: "PUT", json: { handle } }),
    onSuccess: done,
  });
  const all = useMutation({
    mutationFn: (visibility: Visibility) => api<Sharing>("/api/me/sharing/decks", { method: "POST", json: { visibility } }),
    onSuccess: done,
  });
  // One save at a time across the whole form: each answer replaces all the cached settings, so
  // two under way at once (the handle and a switch) could leave one showing the other's old value.
  const saving = save.isPending || saveHandle.isPending || all.isPending;
  const s = sharing.data;
  if (!s) return <ErrorText error={sharing.error} retry={() => void sharing.refetch()} />;
  // Why what's typed can't be a handle, said as it's typed: Save used to send it and the server's
  // refusal showed 700 px down, after the checkboxes.
  const problem = handleProblem(handle);
  const profile = s.handle ? `${publicOrigin()}/u/${s.handle}` : null;
  const total = s.decks.private + s.decks.link + s.decks.public;
  const shareAll = async (v: Visibility, title: string, body: string | undefined, confirm: string) => (await ask({ title, body, confirm, danger: true })) && all.mutate(v);

  return (
    <div className="grp-you-row grp-you-stack share-settings" id="sharing">
      <div className="grp-you-text">
        <b>Sharing</b>
        <span>
          New decks start as the setting below, and each deck's Share button changes it. A public deck is on your profile{s.handle ? "" : " once you pick a handle"}
          {s.public_listed_at ? ", and can be listed in Browse and found by search engines" : ""}; a link-only deck is seen only by people who have its link.
          Shared decks show their cards and printings, never prices you paid, notes, plans or games, and never your name or email. Your
          collection, wish list, plans, games and playgroups stay private unless you share them.
        </span>
      </div>

      <form
        className="share-handle"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !saving) saveHandle.mutate(handle.trim() || null);
        }}
      >
        <label>
          Your handle
          <span className="hint">3–30 letters, digits, - or _. Your profile is at /u/handle.</span>
          <span className="row">
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" maxLength={31} autoCapitalize="none" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={problem ? problemId : undefined} />
            <Button type="submit" disabled={saving || !!problem || handle.trim().replace(/^@/, "").toLowerCase() === (s.handle ?? "")}>{saveHandle.isPending ? "Saving…" : "Save"}</Button>
          </span>
          {problem && <span className="field-error" id={problemId} role="alert">{problem}</span>}
        </label>
        <ErrorText error={saveHandle.error} />
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
        <select value={s.new_deck_visibility} onChange={(e) => save.mutate({ new_deck_visibility: e.target.value })} disabled={saving}>
          {VISIBILITY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>

      <div className="grp-you-line">
        <span className="grp-you-text">
          <span>
            {total === 0
              ? "No decks yet."
              : `${s.decks.public} public, ${s.decks.link} link only, ${s.decks.private} private.`}
          </span>
        </span>
      </div>
      <div className="row">
        <Button
          variant="outline"
          disabled={saving || total === 0 || s.decks.public === total}
          onClick={() =>
            shareAll(
              "public",
              `Make all ${total} decks public?`,
              [s.public_listed_at ? "They are on your profile, and can be listed in Browse and found by search engines." : "They are listed on your profile.", s.handle ? "" : "Pick a handle too, so your profile can list them."].filter(Boolean).join(" "),
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
          disabled={saving || total === 0 || s.decks.private === total}
          onClick={() => shareAll("private", `Make all ${total} decks private?`, "Every link you've sent stops working until you share again.", "Make them private")}
        >
          Make all private
        </Button>
      </div>

      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.collection_public} disabled={saving} onChange={(e) => save.mutate({ collection_public: e.target.checked })} />
        Show my collection on my profile
        <span className="hint">
          Card names, printings, finishes, conditions and counts of real cards. Not proxies, where they're filed, notes or prices. Your shared decks
          then name the printings of your own copies too.
          {!s.handle && " Needs a handle."}
        </span>
      </label>
      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.wants_public} disabled={saving} onChange={(e) => save.mutate({ wants_public: e.target.checked })} />
        Show my wish list on my profile
        <span className="hint">
          Missing real cards for your decks and their plans, plus your wish list. Card names, quantities and market prices;
          not deck names, notes, stores or price limits.
          {!s.handle && " Needs a handle."}
        </span>
      </label>
      <label className="share-collection-toggle">
        <input type="checkbox" checked={s.share_lab_results} disabled={saving} onChange={(e) => save.mutate({ share_lab_results: e.target.checked })} />
        Show simulated win rates on shared decks
        <span className="hint">
          From your upgrade plan's newest lab run: the win rates of a shared deck's list and its public configurations, with their intervals. Not your plan's changes or other lists.
        </span>
      </label>
      <ErrorText error={save.error ?? all.error} />
    </div>
  );
}
