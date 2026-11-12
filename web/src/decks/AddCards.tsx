// Add cards (Edit the list): search Yama's cards and put one in the list, or take it out, with
// one press. The list stays text: a press changes a line of it (addToList, removeFromList), so
// typing, pasting and searching all edit the same thing and the unsaved-changes guard sees them.
import { useQuery } from "@tanstack/react-query";
import { addToList, countInList, identityName, MAYBE, removeFromList } from "@yama/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, type SearchResult } from "../api";
import { Button, CardImage, EmptyState, ErrorText, Loading, ManaCost } from "../components/ui";
import { identityQuery } from "../lab/logic";
import { offlineSearch } from "../offline/cards";
import { anyNumber, fitFor, inListText, moreText, ownedText, type Hit } from "./cardFit";

/** Where a copy is taken from, in words. */
const PLACES: Record<string, string> = { main: "the list", side: "the sideboard", [MAYBE]: "Considering" };

/** How many results show: the most played that match. */
const SHOWN = 12;

const isNetworkError = (e: unknown) => e instanceof TypeError || !navigator.onLine;

export function AddCards({ text, onChange, identity, disabled = false, note }: {
  /** The list as it stands in the box. */
  text: string;
  /** The list with a card added or removed. */
  onChange: (next: string) => void;
  /** The deck's color identity, or null with no commander chosen. */
  identity: string | null;
  /** The buttons are off: another list is loading, a save is on its way, or the list can't be edited line by line. */
  disabled?: boolean;
  /** Why the buttons are off, when it needs saying. */
  note?: ReactNode;
}) {
  const heading = useId();
  const root = useRef<HTMLElement>(null);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const within = fits ? identityQuery(identity) : "";
  // In brackets, so an "or" in what was typed can't reach past the color filter.
  const query = q ? (within ? `(${q}) ${within}` : q) : "";
  const results = useQuery({
    queryKey: ["search", query, "edhrec", 1],
    queryFn: async ({ signal }): Promise<SearchResult> => {
      try {
        return await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(query)}&order=edhrec&page=1`, { signal });
      } catch (e) {
        // Without a connection the copy of the card list on this device answers (no ownership).
        if (isNetworkError(e)) return offlineSearch(query, "edhrec", 1);
        throw e;
      }
    },
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
  });
  const hits = ((results.data?.cards ?? []) as Hit[]).slice(0, SHOWN);
  const [said, setSaid] = useState("");
  // A press can take its own button away (Add, on a card a deck holds once). Focus then goes to
  // the button that stands for the card now, instead of being dropped.
  const focusNext = useRef<{ card: string; act: "add" | "remove" | "consider" } | null>(null);
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const row = [...(root.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].find((el) => el.dataset.card === want.card);
    if (row && !row.contains(document.activeElement)) row.querySelector<HTMLElement>(`[data-act="${want.act}"]`)?.focus();
  }, [text]);
  const add = (c: Hit) => {
    // A card being considered moves into the deck: it leaves the Considering list.
    const next = addToList(countInList(text, c.name, MAYBE) > 0 ? removeFromList(text, c.name, MAYBE) : text, c.name);
    onChange(next);
    focusNext.current = { card: c.oracle_id, act: "remove" };
    setSaid(`Added ${c.name}: ${inListText(countInList(next, c.name, "main")).toLowerCase()}.`);
  };
  /** Takes a copy from the main deck, else the sideboard, else the Considering list. Never the commander. */
  const remove = (c: Hit, board: string) => {
    const next = removeFromList(text, c.name, board);
    onChange(next);
    const left = countInList(next, c.name, board);
    focusNext.current = { card: c.oracle_id, act: left ? "remove" : "add" };
    setSaid(left ? `Removed one ${c.name}: ${left} left.` : `Removed ${c.name} from ${PLACES[board] ?? "the list"}.`);
  };
  const consider = (c: Hit) => {
    onChange(addToList(text, c.name, MAYBE));
    focusNext.current = { card: c.oracle_id, act: "remove" };
    setSaid(`Put ${c.name} under Considering.`);
  };

  return (
    <section ref={root} className="edit-list-add" aria-labelledby={heading}>
      <h2 id={heading}>Add cards</h2>
      <form
        role="search"
        className="edit-list-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(typed.trim());
        }}
      >
        <input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Card name, or a search like t:instant o:counter"
          aria-label="Search cards to add"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {identity !== null && (
          <label className="edit-list-add-check">
            <input type="checkbox" checked={fits} onChange={(e) => setFits(e.target.checked)} />
            <span>Only cards in the commander's colors ({identityName(identity)})</span>
          </label>
        )}
      </form>
      {note}
      <ErrorText error={results.error} retry={() => void results.refetch()} />
      {query && results.isPending && <Loading small>Searching…</Loading>}
      {query && results.data && (
        <>
          <ul className="edit-list-hits" aria-label="Search results" aria-busy={results.isFetching}>
            {hits.map((c) => {
              const main = countInList(text, c.name, "main");
              const side = countInList(text, c.name, "side");
              const leads = countInList(text, c.name, "commander") > 0;
              // Considering is kept with the deck but isn't in it.
              const considering = countInList(text, c.name, MAYBE);
              const fit = fitFor(c, identity);
              const owned = ownedText(c);
              const where = leads ? "Your commander" : main ? inListText(main) : side ? "In the sideboard" : considering ? "Considering" : "";
              const from = main > 0 ? "main" : side > 0 ? "side" : MAYBE;
              // The commander is changed in the list itself or with the commander picker, not from here.
              const canRemove = !leads && (main > 0 || side > 0 || considering > 0);
              const canConsider = !leads && main === 0 && side === 0 && considering === 0;
              const canAdd = !leads && (main === 0 || anyNumber(c));
              return (
                <li key={c.oracle_id} data-card={c.oracle_id}>
                  <CardImage src={c.image_small} name={c.name} className="edit-list-hit-thumb" />
                  <span className="edit-list-hit-text">
                    <span className="edit-list-hit-name">
                      <b>{c.name}</b> <ManaCost cost={c.mana_cost} />
                    </span>
                    <span className="small dim">{c.type_line}</span>
                    <span className="small">
                      {fit.text && <span className={fit.ok ? "dim" : "edit-list-hit-warn"}>{fit.text}. </span>}
                      {owned && <span className={c.owned ? "edit-list-hit-own" : "dim"}>{owned}.</span>}
                    </span>
                  </span>
                  {/* Remove, Consider and Add keep their own places, so a second press never lands on another. */}
                  <span className="edit-list-hit-actions">
                    <span className="small edit-list-hit-in">{where}</span>
                    <span className="edit-list-hit-slot">
                      {canRemove && (
                        <Button data-act="remove" disabled={disabled} onClick={() => remove(c, from)} aria-label={`Remove ${c.name} from ${PLACES[from]}`}>
                          Remove
                        </Button>
                      )}
                    </span>
                    <span className="edit-list-hit-slot">
                      {canConsider && (
                        <Button data-act="consider" disabled={disabled} onClick={() => consider(c)} aria-label={`Consider ${c.name}: keep it with the deck, not in it`}>
                          Consider
                        </Button>
                      )}
                    </span>
                    <span className="edit-list-hit-slot">
                      {canAdd && (
                        <Button data-act="add" className={main === 0 ? "primary" : undefined} disabled={disabled} onClick={() => add(c)} aria-label={main ? `Add another ${c.name}` : `Add ${c.name} to the list`}>
                          {main ? "Add another" : "Add"}
                        </Button>
                      )}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {hits.length === 0 && <EmptyState variant="compact">No cards match{within ? " in the commander's colors" : ""}.</EmptyState>}
          {moreText(results.data.total, hits.length) && <p className="small dim edit-list-add-note">{moreText(results.data.total, hits.length)}</p>}
        </>
      )}
      <p className="visually-hidden" role="status">{said}</p>
    </section>
  );
}
