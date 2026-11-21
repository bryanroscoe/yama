import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SearchResult } from "../api";
import { useDebounced } from "../useDebounced";
import { moveSuggestion, nameBeingTyped, nameQuery, suggestionsFor } from "./cardQuery";

/** Names offered at once: enough to find a card, few enough to fit above a phone's keyboard. */
const SUGGESTIONS = 8;

function SearchIcon() {
  return (
    <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </svg>
  );
}

/**
 * The Cards page's search box. While the box holds plain words it offers card names that start
 * with or contain them (GET /api/cards/autocomplete, a moment after typing stops): Down and Up
 * move through them, Enter or a tap picks one, Escape puts them away. Once the box holds search
 * syntax, nothing is offered.
 *
 * `guest`: the name lookup needs an account, so someone signed out gets their names from the
 * guest card search instead (most played first). That search is limited per address and shared
 * with the searches themselves, so it waits for a longer pause and a third letter.
 */
export function CardSearchBox({ value, onChange, onPick, suggest, guest = false }: { value: string; onChange: (v: string) => void; onPick: (name: string) => void; suggest: boolean; guest?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = nameBeingTyped(value);
  const term = useDebounced(typed ?? "", guest ? 350 : 180);
  const names = useQuery({
    queryKey: ["card-names", term.toLowerCase(), guest],
    queryFn: async ({ signal }) =>
      guest
        ? (await api<SearchResult>(`/api/guest/cards/search?q=${encodeURIComponent(nameQuery(term))}&order=edhrec&page=1`, { signal })).cards.map((c) => c.name)
        : api<string[]>(`/api/cards/autocomplete?q=${encodeURIComponent(term)}`, { signal }),
    enabled: suggest && term.length >= (guest ? 3 : 2),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Only names fetched for what the box holds now: while typing runs ahead of the lookup, the
  // names for the earlier letters aren't offered (Down and Enter could open a card nobody typed).
  // Offline, or the lookup failed: no names, and the search still works as typed.
  const list = open && suggestionsFor(typed, term) ? (names.data ?? []).slice(0, SUGGESTIONS) : [];
  const showing = list.length > 0;
  const pick = (name: string) => {
    setOpen(false);
    setActive(-1);
    onPick(name);
  };
  return (
    <div className="cards-box">
      <label className="visually-hidden" htmlFor="cards-search-input">Search cards</label>
      <SearchIcon />
      <input
        id="cards-search-input"
        type="search"
        role="combobox"
        aria-expanded={showing}
        aria-controls="cards-suggest"
        aria-autocomplete="list"
        aria-activedescendant={showing && active >= 0 ? `cards-suggest-${active}` : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive(moveSuggestion(Math.min(active, list.length - 1), list.length, e.key === "ArrowDown" ? 1 : -1));
          } else if (e.key === "Enter" && active >= 0 && list[active]) {
            // Enter with nothing chosen searches for what was typed (the form's submit).
            e.preventDefault();
            pick(list[active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            setActive(-1);
          } else if (e.key === "Enter") {
            setOpen(false);
          }
        }}
        placeholder="Search for a card by name"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {showing && (
        <ul id="cards-suggest" className="cards-suggest" role="listbox" aria-label="Card names">
          {list.map((name, i) => (
            // The pointer goes down before the box would lose focus: keep it, so the tap lands.
            <li key={name} id={`cards-suggest-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(name)}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
