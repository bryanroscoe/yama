// The Decks list's tools: search by name or commander, a folder, colors, a bracket and the sort
// (deckIndex.ts has the rules). Plain fields; the choices live in the address.
import { MANA, plural } from "@yama/core";
import { useState } from "react";
import { BRACKETS } from "../components/Bracket";
import { Button, Field, Pips, Segmented } from "../components/ui";
import { NO_FOLDER, SORTS, isFiltered, shownText, type DeckFilter, type DeckSort } from "./deckIndex";

const COLORS = ["W", "U", "B", "R", "G"] as const;

/** The change that takes every filter off and leaves the sort. */
export const CLEARED: Partial<DeckFilter> = { q: "", folder: null, colors: "", bracket: "" };

export function DeckIndexTools({ filter, onChange, folders, hasUnfiled, shown, total }: {
  filter: DeckFilter;
  /** What changed. `typing`: a keystroke in the search, which shouldn't add a step to Back. */
  onChange: (change: Partial<DeckFilter>, typing?: boolean) => void;
  /** Every folder in use. */
  folders: string[];
  /** Some deck is in no folder, so "No folder" is worth offering. */
  hasUnfiled: boolean;
  shown: number;
  total: number;
}) {
  const toggle = (k: string) => {
    const on = filter.colors.includes(k) ? filter.colors.replace(k, "") : filter.colors + k;
    onChange({ colors: COLORS.filter((c) => on.includes(c)).join("") });
  };
  // A folder the address names that no deck is in any more (its last deck moved, an old link)
  // still shows as the choice, so the list never reads "All folders" while it is filtered.
  const stale = filter.folder !== null && filter.folder !== NO_FOLDER && !folders.includes(filter.folder) ? filter.folder : null;
  // A phone shows the search and one button; the rest opens from it, so the decks start on the
  // first screen. It starts open when the address already filters or sorts, so nothing that
  // narrows the list is out of sight. A laptop always shows everything (decks.css).
  const [more, setMore] = useState(() => filter.folder !== null || !!filter.colors || !!filter.bracket || filter.sort !== "name");
  return (
    <div className={`deck-index-tools${more ? " is-open" : ""}`} role="search" aria-label="Find a deck">
      <div className="deck-index-top">
        <input
          type="search"
          className="deck-index-search"
          value={filter.q}
          onChange={(e) => onChange({ q: e.target.value }, true)}
          placeholder={`Search ${plural(total, "deck")} by name or commander`}
          aria-label="Search decks by name or commander"
          maxLength={100}
        />
        <Button className="phone-only deck-index-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Hide filters" : "Filter and sort"}
        </Button>
      </div>
      <div className="deck-index-fields">
        {(folders.length > 0 || filter.folder !== null) && (
          <Field label="Folder">
            <select
              value={filter.folder === null ? "" : filter.folder}
              onChange={(e) => onChange({ folder: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">All folders</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              {stale && <option value={stale}>{stale}</option>}
              {(hasUnfiled || filter.folder === NO_FOLDER) && <option value={NO_FOLDER}>No folder</option>}
            </select>
          </Field>
        )}
        <div className="deck-index-colors" role="group" aria-label="Colors the deck includes">
          <span className="deck-index-label" aria-hidden="true">Colors</span>
          <span className="deck-index-pips">
            {COLORS.map((k) => (
              <Button key={k} aria-pressed={filter.colors.includes(k)} aria-label={MANA[k].name} title={MANA[k].name} onClick={() => toggle(k)}>
                <Pips identity={k} label={false} />
              </Button>
            ))}
          </span>
        </div>
        <Field label="Bracket">
          <select value={filter.bracket} onChange={(e) => onChange({ bracket: e.target.value })}>
            <option value="">Any</option>
            {BRACKETS.map((b) => <option key={b.value} value={String(b.value)}>{b.value}, {b.name}</option>)}
            <option value="none">None declared</option>
          </select>
        </Field>
        <div className="deck-index-sort">
          <span className="deck-index-label" id="deck-index-sort">Sort by</span>
          <Segmented<DeckSort> compact labelledBy="deck-index-sort" value={filter.sort} onChange={(sort) => onChange({ sort })} options={SORTS} />
        </div>
      </div>
      {/* Always here, so a screen reader hears the count when a filter first narrows the list. */}
      <p className="small deck-index-count">
        <span role="status">{isFiltered(filter) ? shownText(shown, total) : ""}</span>
        {isFiltered(filter) && <Button variant="quiet" onClick={() => onChange(CLEARED)}>Clear filters</Button>}
      </p>
    </div>
  );
}
