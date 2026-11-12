import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { Button, Dialog, ErrorText, Field } from "../components/ui";
import { plural } from "@yama/core";
import { HANDLE_HINT, handleProblem, typedHandle, useSaveHandle } from "./ChooseHandle";
import "./share.css";

/** What happens to the decks an account already has: none changes, all become public, or its public ones become link only. */
export type ExistingDecks = "keep" | "public" | "link";

export interface PublicDefaultAnswer {
  new_decks: Visibility;
  existing: ExistingDecks;
  /** How many public decks the question showed. The server refuses the answer if the account has another number by now. */
  public_decks: number;
}

/** What the question says about the new decks' three choices. */
export const NEW_DECK_CHOICES: readonly { value: Visibility; label: string; hint: string }[] = [
  { value: "public", label: "Public", hint: "On your profile, listed in Browse and open to search engines." },
  { value: "link", label: "Link only", hint: "Seen by anyone who has its link. It isn't listed anywhere." },
  { value: "private", label: "Private", hint: "Seen only by you." },
];

/**
 * The choices for the decks an account already has. Nothing changes them but a choice made here:
 * "keep" leaves every deck as it is, and is the only choice already made for an account with no
 * public deck (keeping changes nothing and lists nothing). An account with public decks has to
 * pick, because answering lists them: they were made public when that meant the profile only.
 * For it the keeping choice is named for what it does ("Keep my 3 public decks public").
 */
export function existingChoices(decks: Sharing["decks"], newDecks: Visibility | null): { value: ExistingDecks; label: string; hint: string }[] {
  const total = decks.private + decks.link + decks.public;
  if (!total) return [];
  const out: { value: ExistingDecks; label: string; hint: string }[] = [
    decks.public
      ? {
          value: "keep",
          label: `Keep my ${plural(decks.public, "public deck")} public`,
          hint: `${decks.public === 1 ? "It is" : "They are"} then listed in Browse and can be found by search engines, like any public deck.${decks.public < total ? " Your other decks stay as they are." : ""}`,
        }
      : { value: "keep", label: "Leave them as they are", hint: "None of them is public, so none is listed." },
  ];
  if (newDecks === "public" && decks.public < total) out.push({ value: "public", label: `Make all ${total} public`, hint: "Every deck you have now, the private and link-only ones too." });
  if (decks.public)
    out.push({
      value: "link",
      label: `Change my ${plural(decks.public, "public deck")} to link only`,
      hint: "They leave your profile and stay out of Browse and search engines. Their links keep working.",
    });
  return out;
}

/** The answer as it would be sent, or null while a question is still open. */
export function readyAnswer(decks: Sharing["decks"], newDecks: Visibility | null, existing: ExistingDecks | null): PublicDefaultAnswer | null {
  if (!newDecks) return null;
  const choices = existingChoices(decks, newDecks);
  if (!choices.length) return { new_decks: newDecks, existing: "keep", public_decks: 0 };
  // Only an account with no public deck has "keep" chosen for it.
  const chosen = existing ?? (decks.public ? null : "keep");
  if (!chosen || !choices.some((c) => c.value === chosen)) return null;
  return { new_decks: newDecks, existing: chosen, public_decks: decks.public };
}

/** The signed-in account's sharing settings while its one-time question is unanswered, else null. */
export function usePublicDefaultQuestion(): Sharing | null {
  const me = useMe().data;
  // Not while an admin is viewing as someone: the answer is the account owner's to give.
  const asking = !!me && !me.viewing;
  const sharing = useQuery({ queryKey: ["sharing", me?.id], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: asking });
  return asking && sharing.data && sharing.data.public_listed_at === null ? sharing.data : null;
}

const LATER = "yama.publicDefault.later";

function askedLater(): boolean {
  try {
    return sessionStorage.getItem(LATER) === "1";
  } catch {
    return false;
  }
}

/**
 * On the Decks page, for an account from before public-by-default that hasn't answered: the
 * question opens once per visit, and a line stays above the decks until it is answered.
 */
export function PublicDefaultBanner() {
  const sharing = usePublicDefaultQuestion();
  const [open, setOpen] = useState(() => !askedLater());
  if (!sharing) return null;
  const later = () => {
    try {
      sessionStorage.setItem(LATER, "1");
    } catch {
      // Private browsing: it asks again on the next page load.
    }
    setOpen(false);
  };
  return (
    <>
      <div className="public-default-banner">
        <span>Yama decks are now public by default. Yours stay as they are until you answer.</span>
        <Button onClick={() => setOpen(true)}>Choose for your decks</Button>
      </div>
      {open && <PublicDefaultDialog sharing={sharing} onClose={later} />}
    </>
  );
}

/** "Yama decks are now public by default. Make yours public?" Asked once; either answer is kept. */
export function PublicDefaultDialog({ sharing, onClose }: { sharing: Sharing; onClose: () => void }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const [newDecks, setNewDecks] = useState<Visibility | null>(null);
  const [existing, setExisting] = useState<ExistingDecks | null>(null);
  const [handle, setHandle] = useState("");
  const saveHandle = useSaveHandle();
  const choices = existingChoices(sharing.decks, newDecks);
  const answer = readyAnswer(sharing.decks, newDecks, existing);
  const total = sharing.decks.private + sharing.decks.link + sharing.decks.public;
  // A handle is the name public decks are listed under; without one they are public by link.
  const somethingPublic = !!answer && (answer.new_decks === "public" || answer.existing === "public" || (answer.existing === "keep" && sharing.decks.public > 0));
  const needsHandle = !sharing.handle && somethingPublic;
  const badHandle = needsHandle ? handleProblem(handle) : null;
  // The settings as the server answered, once the answer is in. A handle that then fails to
  // save (taken, say) leaves the question on screen for the handle alone.
  const [answered, setAnswered] = useState<Sharing | null>(null);
  const finish = (s: Sharing) => {
    qc.setQueryData(["sharing", userId], s);
    void qc.invalidateQueries({ queryKey: ["decks"] });
    void qc.invalidateQueries({ queryKey: ["deck"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async (a: PublicDefaultAnswer) => {
      // The answer first, then the handle. A handle gives the account a profile, and a profile
      // lists its public decks: saved first, it would show decks the answer is about to make
      // link only, and keep showing them if the answer then failed.
      const s = answered ?? (await api<Sharing>("/api/me/sharing/public-default", { method: "POST", json: a }));
      setAnswered(s);
      return needsHandle && typedHandle(handle) ? saveHandle.mutateAsync(handle) : s;
    },
    onSuccess: finish,
  });
  // The server refused the answer as out of date: answered already (another device or tab), or
  // the decks changed since the question opened. Its words say which; the question as shown
  // here is no longer true, so it can only be closed, and closing reads the settings again.
  const outdated = !answered && save.error instanceof ApiError && save.error.status === 409;
  const reread = () => {
    void qc.invalidateQueries({ queryKey: ["sharing"] });
    void qc.invalidateQueries({ queryKey: ["decks"] });
    onClose();
  };
  // Closing after the answer is in closes an answered question, whatever became of the handle.
  const close = answered ? () => finish(answered) : outdated ? reread : onClose;
  const locked = save.isPending || !!answered || outdated;

  return (
    <Dialog title="Yama decks are now public by default" onClose={close}>
      <form
        className="share-sheet public-default"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer && !badHandle && !outdated) save.mutate(answer);
        }}
      >
        <p className="share-line">
          Make yours public? A public deck is on your profile, listed in Browse and can be found by search engines. A link-only deck is seen only by people who have
          its link. This changes only your decks: your collection, wish list and plans stay as you set them, and your games, notes, prices paid and account details
          are never public.
        </p>
        <p className="small dim share-line">Until you answer, your decks stay as they are and none of them is listed. You are asked once; you can change any deck later from its Share button.</p>

        <fieldset className="share-choices">
          <legend className="share-legend">New decks, and decks an import or a connected assistant adds</legend>
          {NEW_DECK_CHOICES.map((c) => (
            <label key={c.value} className="share-card">
              <input
                type="radio"
                name="public-default-new"
                checked={newDecks === c.value}
                disabled={locked}
                onChange={() => {
                  setNewDecks(c.value);
                  // "Make all public" goes with public new decks only.
                  if (c.value !== "public" && existing === "public") setExisting(null);
                }}
              />
              <span className="public-default-choice">
                <b>{c.label}</b>
                <span className="small dim">{c.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {choices.length > 0 && (
          <fieldset className="share-choices">
            <legend className="share-legend">Your {plural(total, "existing deck")}</legend>
            {choices.map((c) => (
              <label key={c.value} className="share-card">
                <input type="radio" name="public-default-existing" checked={(existing ?? (sharing.decks.public ? null : "keep")) === c.value} disabled={locked} onChange={() => setExisting(c.value)} />
                <span className="public-default-choice">
                  <b>{c.label}</b>
                  <span className="small dim">{c.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {needsHandle && (
          <Field
            className="import-handle"
            label="Your handle"
            error={badHandle}
            hint={`Public decks are listed under your handle. ${HANDLE_HINT} Leave it blank and they are public by link until you pick one.`}
          >
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" maxLength={31} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={save.isPending} />
          </Field>
        )}

        {answered && <p className="share-line" role="status">Your answer is saved. The handle wasn't: pick another, or skip it and your public decks are public by link until you choose one.</p>}
        <ErrorText error={save.error} />
        <div className="row">
          {!outdated && <Button type="submit" variant="primary" disabled={!answer || !!badHandle || save.isPending}>{save.isPending ? "Saving…" : answered ? "Save handle" : "Save my answer"}</Button>}
          <Button variant={outdated ? "primary" : "quiet"} disabled={save.isPending} onClick={close}>{answered ? "Skip the handle" : outdated ? "OK" : "Ask me later"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
