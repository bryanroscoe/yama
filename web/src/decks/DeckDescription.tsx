// A deck's description: a short plain text its owner writes about the deck. Unlike a version's
// note it is not private: the deck's shared page shows it to anyone who can see the deck, and
// the place it is written says so. It is shown as text (React escapes it; the shared page
// escapes it on the server), never as markup.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { count } from "@yama/core";
import { useId, useState } from "react";
import { api, type DeckView, type Visibility } from "../api";
import { Dialog, ErrorText } from "../components/ui";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import "./deck-settings.css";

/** The server's cap (decks.rs DESCRIPTION_MAX), in characters. */
export const DESCRIPTION_MAX = 2000;

/** Paragraphs and their lines: a blank line starts a paragraph, a single line break stays one. */
export function descriptionParagraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split("\n"));
}

/** What gets saved: trimmed, and null when nothing is left. */
export function descriptionToSave(text: string): string | null {
  return text.replace(/\r\n?/g, "\n").trim() || null;
}

/** Who sees the description, for the deck's sharing as it is now. */
export function whoSees(visibility: Visibility): string {
  if (visibility === "public") return "This deck is public on your profile, so anyone can read it now.";
  if (visibility === "link") return "This deck is shared by link, so anyone with the link can read it now.";
  return "This deck is private, so only you see it for now. Share the deck and they will see it too.";
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {descriptionParagraphs(text).map((lines, i) => (
        <p key={i}>
          {lines.map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {line}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

/** The description on the deck's page, with the way to change it. Nothing when there is none. */
export function DeckAbout({ deck, onEdit }: { deck: Pick<DeckView, "description" | "visibility">; onEdit: () => void }) {
  const heading = useId();
  if (!deck.description?.trim()) return null;
  return (
    <section className="deck-about" aria-labelledby={heading}>
      <div className="deck-about-head">
        <h2 id={heading}>About this deck</h2>
        <button type="button" className="quiet" onClick={onEdit}>Edit</button>
      </div>
      <Paragraphs text={deck.description} />
      <p className="small dim">{deck.visibility === "private" ? "Only you see this while the deck is private." : "Shown to anyone who can see this deck."}</p>
    </section>
  );
}

/** Write or change the description, in a sheet that says who will read it. */
export function EditDescription({ deck, onClose: closeSheet }: { deck: Pick<DeckView, "id" | "description" | "visibility">; onClose: () => void }) {
  const qc = useQueryClient();
  const hint = useId();
  const saved = deck.description ?? "";
  const [text, setText] = useState(saved);
  const guard = useUnsavedChanges(descriptionToSave(text) !== descriptionToSave(saved), { onLeave: closeSheet });
  const onClose = () => guard.close(closeSheet);
  const save = useMutation({
    mutationFn: () => api(`/api/decks/${encodeURIComponent(deck.id)}`, { method: "PATCH", json: { description: descriptionToSave(text) } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deck"] });
      closeSheet();
    },
  });
  const left = DESCRIPTION_MAX - [...text].length;
  return (
    <Dialog title="About this deck" onClose={onClose}>
      <form className="deck-settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>
          Description
          <textarea className="deck-about-text" value={text} onChange={(e) => setText(e.target.value)} rows={8} aria-describedby={hint} placeholder="What the deck does, how it wins, what to watch for." />
        </label>
        <p id={hint} className="small deck-about-who">
          <b>Shown to anyone who can see this deck.</b> {whoSees(deck.visibility)}
        </p>
        <p className={`small ${left < 0 ? "deck-about-over" : "dim"}`}>
          Plain text: links and formatting show as typed. {left < 0 ? `${count(-left)} too many characters.` : `${count(left)} characters left.`}
        </p>
        <ErrorText error={save.error} />
        <div className="deck-settings-actions">
          <button className="primary" disabled={save.isPending || left < 0}>{save.isPending ? "Saving…" : "Save"}</button>
          <button type="button" className="quiet" onClick={onClose}>Cancel</button>
        </div>
      </form>
      <UnsavedPrompt guard={guard} what="what you wrote about this deck" />
    </Dialog>
  );
}
