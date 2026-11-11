// Delete a deck or one configuration of it (More, then Delete deck / Delete configuration on a
// deck's page). The server's delete is an archive: the deck leaves your decks and its share link
// stops working, and games already played keep their record (server/src/decks.rs, delete).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, type DeckView } from "../api";
import { ErrorText, Dialog } from "../components/ui";
import { configurationLabel } from "./buildCatalog";

export interface DeleteWording {
  /** "Delete deck" or "Delete configuration": the button and the sheet's heading. */
  action: string;
  /** What goes, in a sentence. */
  what: string;
  /** For a main deck with configurations: their labels, for the choice to delete them too. */
  configurations: string[];
  /** Where to go after: the main deck after a configuration, else the deck list. */
  after: string;
}

export function deleteWording(deck: Pick<DeckView, "id" | "name" | "parent_id" | "configuration" | "configurations">): DeleteWording {
  if (deck.parent_id) {
    const main = deck.configurations.find((c) => c.id === deck.parent_id)?.name ?? deck.configurations[0]?.name ?? "its main deck";
    return {
      action: "Delete configuration",
      what: `The ${configurationLabel(deck.configuration, deck.name)} configuration of ${main} leaves your decks. ${main} and its other configurations stay.`,
      configurations: [],
      after: `/decks/${deck.parent_id}`,
    };
  }
  const others = deck.configurations.filter((c) => c.id !== deck.id);
  return {
    action: "Delete deck",
    what: `${deck.name} leaves your decks.`,
    configurations: others.map((c) => configurationLabel(c.configuration, c.name)),
    after: "/decks",
  };
}

export function DeleteDeck({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const w = deleteWording(deck);
  const many = w.configurations.length;
  // The less destructive choice comes first; deleting the configurations too is one tap away.
  const [withConfigurations, setWithConfigurations] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/api/decks/${deck.id}${withConfigurations ? "?configurations=true" : ""}`, { method: "DELETE" }),
    onSuccess: () => {
      // The main deck's switcher (often cached already) drops the deleted configuration at once.
      if (deck.parent_id)
        qc.setQueryData<DeckView>(["deck", deck.parent_id], (prev) => prev && { ...prev, configurations: prev.configurations.filter((c) => c.id !== deck.id) });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck"] });
      onClose();
      navigate(w.after);
    },
  });
  const label = withConfigurations && many ? `Delete deck and ${many === 1 ? "its configuration" : `${many} configurations`}` : w.action;
  return (
    <Dialog title={w.action} onClose={onClose}>
      <form className="stack deck-delete-sheet" onSubmit={(e) => { e.preventDefault(); remove.mutate(); }}>
        <p>{w.what} Its share link stops working, and you can't undo this from Yama. Games you've played with it keep their record.</p>
        {many > 0 && (
          <fieldset className="deck-delete-choice">
            <legend>Its {many === 1 ? "configuration" : `${many} configurations`}: {w.configurations.join(", ")}</legend>
            <label>
              <input type="radio" name="configurations" checked={!withConfigurations} onChange={() => setWithConfigurations(false)} />
              Keep {many === 1 ? "it as a deck of its own" : "them as decks of their own"}
            </label>
            <label>
              <input type="radio" name="configurations" checked={withConfigurations} onChange={() => setWithConfigurations(true)} />
              Delete {many === 1 ? "it" : "them"} too
            </label>
          </fieldset>
        )}
        <ErrorText error={remove.error} />
        <div className="row">
          <button className="deck-danger" disabled={remove.isPending}>{remove.isPending ? "Deleting…" : label}</button>
          <button type="button" className="outline" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
