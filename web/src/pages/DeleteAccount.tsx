import { useState } from "react";
import { useDeleteAccount } from "../auth";
import { Button, Dialog, ErrorText } from "../components/ui";

/** Whether what was typed confirms the account's email: case and spaces at the ends don't matter. */
export function confirmsEmail(email: string, typed: string): boolean {
  return email.trim() !== "" && typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * "Delete account" under You: the person deletes their own account and everything it owns. Google
 * Play asks for this in the app and at a web link (`/delete-account/`, which points here).
 */
export function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grp-you-row" id="delete-account">
      <span className="grp-you-text">
        <b>Delete account</b>
        <span>Your account and everything in it, for good.</span>
      </span>
      <Button variant="outline" danger onClick={() => setOpen(true)}>
        Delete
      </Button>
      {open && <DeleteSheet email={email} onClose={() => setOpen(false)} />}
    </div>
  );
}

function DeleteSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const del = useDeleteAccount();
  const ok = confirmsEmail(email, typed);
  return (
    <Dialog onClose={onClose} label="Delete your account">
      <form
        className="grp-delete"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) del.mutate(typed);
        }}
      >
        <h2>Delete your account?</h2>
        <p>
          This deletes your account and everything in it: decks, collection, plans, simulation runs, Ask Claude conversations and keys,
          connected apps and script keys. It can't be undone.
        </p>
        <p className="dim">
          Other people's records stay whole. Games you played with others stay without your name, playgroups you run pass to another
          member, and your place in other playgroups becomes "Former member".
        </p>
        <label className="grp-delete-confirm">
          <span>Type {email} to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <ErrorText error={del.error} />
        <div className="grp-delete-actions">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!ok || del.isPending}>
            {del.isPending ? "Deleting…" : "Delete my account"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
