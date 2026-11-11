// Deck settings, "Name, box and ownership" (deck page SPEC section 4; DeckControls row 7): facts
// about the deck only. The bracket lives on the bracket panel, the cards on Edit the list, Delete
// in More.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Container, type DeckSummary, type DeckView } from "../api";
import { SearchPicker } from "../components/SearchPicker";
import { ErrorText, Dialog, Segmented } from "../components/ui";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import "./deck-settings.css";

type Ownership = "owned" | "planned" | "";
const OWNERSHIP: { value: Ownership; label: string }[] = [
  { value: "owned", label: "Owned" },
  { value: "planned", label: "Planned" },
  { value: "", label: "Not recorded" },
];

/** The PATCH body for the sheet's choices: only what can change, and nothing a configuration can't hold. */
export function settingsPatch(deck: Pick<DeckView, "parent_id" | "configurations">, s: { name: string; ownership: Ownership; container: string; parent: string | null; list: string }) {
  // A deck with lists of its own stays a main deck.
  const hasLists = deck.configurations.length > 1 && !deck.parent_id;
  const parent = hasLists ? null : s.parent;
  return {
    name: s.name.trim(),
    container_id: s.container || null,
    // Ownership belongs to a main deck.
    ...(!parent ? { acquisition_status: s.ownership || null } : {}),
    ...(hasLists ? {} : { parent_id: parent }),
    // A list of another deck has its own name ("Stock"); a list made its own deck drops it.
    ...(parent ? { configuration: s.list.trim() || null } : deck.parent_id ? { configuration: null } : {}),
  };
}

/** Whether the sheet's choices differ from the deck's: closing then asks first. */
export function settingsChanged(deck: Pick<DeckView, "name" | "acquisition_status" | "container_id" | "parent_id" | "configuration">, s: { name: string; ownership: Ownership; container: string; parent: string | null; list: string }): boolean {
  return s.name !== deck.name || s.ownership !== (deck.acquisition_status ?? "") || s.container !== (deck.container_id ?? "") || s.parent !== deck.parent_id || s.list !== (deck.configuration ?? "");
}

export function DeckSettings({ deck, onClose: closeSheet }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }) });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const [name, setName] = useState(deck.name);
  const [ownership, setOwnership] = useState<Ownership>(deck.acquisition_status ?? "");
  const [container, setContainer] = useState(deck.container_id ?? "");
  const [parent, setParent] = useState<string | null>(deck.parent_id);
  const [list, setList] = useState(deck.configuration ?? "");
  const [picking, setPicking] = useState<"box" | "parent" | null>(null);
  const hasLists = deck.configurations.length > 1 && !deck.parent_id;
  const mains = (decks.data ?? []).filter((x) => !x.parent_id && x.id !== deck.id);
  const boxName = containers.data?.find((c) => c.id === container)?.name ?? (container ? "A box" : "None");
  const parentName = mains.find((m) => m.id === parent)?.name ?? (parent ? deck.configurations[0]?.name ?? "Another deck" : null);

  // Closing (Close, Cancel, Escape, a tap outside) or leaving the page with changes asks first.
  const guard = useUnsavedChanges(settingsChanged(deck, { name, ownership, container, parent, list }), { onLeave: closeSheet });
  const onClose = () => guard.close(closeSheet);

  const save = useMutation({
    mutationFn: () => api(`/api/decks/${encodeURIComponent(deck.id)}`, { method: "PATCH", json: settingsPatch(deck, { name, ownership, container, parent, list }) }),
    onSuccess: () => {
      // Every deck in its group lists the group.
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      closeSheet();
    },
  });

  if (picking) {
    const box = picking === "box";
    return (
      // Close, Escape and the scrim go back to the settings, not out of them.
      <Dialog title={box ? "Deck box" : "A list of"} onClose={() => setPicking(null)}>
        <div className="deck-settings">
          <ErrorText error={box ? containers.error : decks.error} />
          {box ? (
            <SearchPicker
              label="Boxes"
              options={[{ id: "", label: "None" }, ...(containers.data ?? []).map((c) => ({ id: c.id, label: c.name, detail: c.kind }))]}
              current={container}
              onPick={(id) => { setContainer(id); setPicking(null); }}
            />
          ) : (
            <SearchPicker
              label="Decks"
              options={mains.map((m) => ({ id: m.id, label: m.name }))}
              current={parent}
              onPick={(id) => { setParent(id); setPicking(null); }}
            />
          )}
        </div>
        <UnsavedPrompt guard={guard} what="your changes to this deck" />
      </Dialog>
    );
  }

  return (
    <Dialog title="Name, box and ownership" onClose={onClose}>
      <form className="deck-settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </label>
        {!parent && (
          <div className="deck-settings-field">
            <span className="deck-settings-label" id="own-label">This deck is</span>
            <Segmented className="deck-settings-own" labelledBy="own-label" value={ownership} onChange={setOwnership} options={OWNERSHIP} />
          </div>
        )}
        <div className="deck-settings-field">
          <span className="deck-settings-label" id="box-label">Deck box</span>
          <button type="button" className="deck-settings-pick" aria-labelledby="box-label box-value" onClick={() => setPicking("box")}>
            <span id="box-value">{containers.isPending && container ? "…" : boxName}</span>
            <span className="dim">Change</span>
          </button>
        </div>
        <fieldset className="deck-settings-field deck-settings-kind" disabled={hasLists}>
          <legend className="deck-settings-label">Show it</legend>
          <label>
            <input type="radio" name="deck-kind" checked={!parent} onChange={() => setParent(null)} />
            As its own deck
          </label>
          <label>
            <input type="radio" name="deck-kind" checked={!!parent} onChange={() => setPicking("parent")} />
            As a list of another deck
          </label>
          {parent && (
            <button type="button" className="deck-settings-pick" onClick={() => setPicking("parent")}>
              <span>{parentName}</span>
              <span className="dim">Change</span>
            </button>
          )}
        </fieldset>
        {parent && (
          <label>
            Name of the list
            <input value={list} onChange={(e) => setList(e.target.value)} maxLength={60} />
          </label>
        )}
        <ErrorText error={save.error} />
        <div className="deck-settings-actions">
          <button className="primary" disabled={save.isPending || !name.trim()}>{save.isPending ? "Saving…" : "Save"}</button>
          <button type="button" className="quiet" onClick={onClose}>Cancel</button>
        </div>
      </form>
      <UnsavedPrompt guard={guard} what="your changes to this deck" />
    </Dialog>
  );
}
