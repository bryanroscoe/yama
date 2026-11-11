// Add cards (Edit the list): search Yama's cards and put one in the list, or take it out, with
// one press. The list stays text: a press changes a line of it (addToList, removeFromList), so
// typing, pasting and searching all edit the same thing and the unsaved-changes guard sees them.
import { useQuery } from "@tanstack/react-query";
import { addToList, countInList, identityName, removeFromList } from "@yama/core";
import { useEffect, useId, useState } from "react";
import { api, type SearchResult } from "../api";
import { CardImage, ErrorText, Loading, ManaCost } from "../components/ui";
import { identityQuery } from "../lab/logic";
import { offlineSearch } from "../offline/cards";
import { anyNumber, fitFor, inListText, moreText, ownedText, type Hit } from "./cardFit";

/** How many results show: the most played that match. */
const SHOWN = 12;

const isNetworkError = (e: unknown) => e instanceof TypeError || !navigator.onLine;

export function AddCards({ text, onChange, identity, disabled = false }: {
  /** The list as it stands in the box. */
  text: string;
  /** The list with a card added or removed. */
  onChange: (next: string) => void;
  /** The deck's color identity, or null with no commander chosen. */
  identity: string | null;
  /** While another list is loading into the box. */
  disabled?: boolean;
}) {
  const heading = useId();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const within = fits ? identityQuery(identity) : "";
  const query = q ? `${q} ${within}`.trim() : "";
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
  const add = (c: Hit) => {
    onChange(addToList(text, c.name));
    setSaid(`Added ${c.name} to the list.`);
  };
  const remove = (c: Hit) => {
    onChange(removeFromList(text, c.name));
    setSaid(`Took ${c.name} out of the list.`);
  };

  return (
    <section className="edit-list-add" aria-labelledby={heading}>
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
      <ErrorText error={results.error} retry={() => void results.refetch()} />
      {query && results.isPending && <Loading small>Searching…</Loading>}
      {query && results.data && (
        <>
          <ul className="edit-list-hits" aria-label="Search results" aria-busy={results.isFetching}>
            {hits.map((c) => {
              const copies = countInList(text, c.name);
              const fit = fitFor(c, identity);
              const owned = ownedText(c);
              return (
                <li key={c.oracle_id}>
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
                  <span className="edit-list-hit-actions">
                    {copies > 0 && <span className="small edit-list-hit-in">{inListText(copies)}</span>}
                    {copies > 0 && (
                      <button type="button" disabled={disabled} onClick={() => remove(c)} aria-label={`Take ${c.name} out of the list`}>
                        Remove
                      </button>
                    )}
                    {(copies === 0 || anyNumber(c)) && (
                      <button type="button" className={copies === 0 ? "primary" : undefined} disabled={disabled} onClick={() => add(c)} aria-label={copies ? `Add another ${c.name}` : `Add ${c.name} to the list`}>
                        {copies ? "Add another" : "Add"}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {hits.length === 0 && <p className="small dim edit-list-add-note">No cards match{within ? " in the commander's colors" : ""}.</p>}
          {moreText(results.data.total, hits.length) && <p className="small dim edit-list-add-note">{moreText(results.data.total, hits.length)}</p>}
        </>
      )}
      <p className="visually-hidden" role="status">{said}</p>
    </section>
  );
}
