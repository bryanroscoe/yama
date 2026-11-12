import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Sharing } from "../api";
import { useMe } from "../auth";
import { Button, ErrorText, Field } from "../components/ui";

/** A handle as it would be stored: trimmed, without a leading @, lowercase. */
export function typedHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/** Why a typed handle can't be one, before the server is asked; null when its shape is right or nothing is typed. */
export function handleProblem(raw: string): string | null {
  const h = typedHandle(raw);
  if (!h) return null;
  const shape = h.length >= 3 && h.length <= 30 && /^[a-z][a-z0-9_-]*$/.test(h) && !/[-_]$/.test(h);
  return shape ? null : "A handle is 3 to 30 letters, digits, - or _, starting with a letter.";
}

export const HANDLE_HINT = "3 to 30 letters, digits, - or _. It is the name people see on your profile and public decks; your Google name and email never are.";

/** Saves a handle for the signed-in account and keeps the cached sharing settings in step. */
export function useSaveHandle() {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  return useMutation({
    mutationFn: (handle: string) => api<Sharing>("/api/me/sharing", { method: "PUT", json: { handle: typedHandle(handle) } }),
    onSuccess: (s) => {
      qc.setQueryData(["sharing", userId], s);
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck"] });
    },
  });
}

/**
 * Pick a handle where a public deck first needs one (the deck's Share sheet). Until there is a
 * handle a public deck is public by link; with one it joins the profile.
 */
export function ChooseHandle() {
  const [handle, setHandle] = useState("");
  const save = useSaveHandle();
  const problem = handleProblem(handle);
  return (
    <form
      className="choose-handle"
      onSubmit={(e) => {
        e.preventDefault();
        if (typedHandle(handle) && !problem) save.mutate(handle);
      }}
    >
      <p className="small share-line">This deck is public by link. Pick a handle and it joins your profile with your other public decks.</p>
      <Field label="Your handle" hint={HANDLE_HINT} error={problem}>
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" maxLength={31} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </Field>
      <div className="row">
        <Button type="submit" disabled={save.isPending || !typedHandle(handle) || !!problem}>{save.isPending ? "Saving…" : "Save handle"}</Button>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}
