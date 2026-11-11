// The Decks list's tools: search by name or commander, a folder, colors, a bracket and the sort
// (deckIndex.ts has the rules). Plain fields; the choices live in the address.
import { MANA } from "@yama/core";
import { BRACKETS } from "../components/Bracket";
import { Pips } from "../components/ui";
import { NO_FOLDER, SORTS, isFiltered, shownText, type DeckFilter, type DeckSort } from "./deckIndex";

const COLORS = ["W", "U", "B", "R", "G"] as const;

export function DeckIndexTools({ filter, onChange, folders, hasUnfiled, shown, total }: {
  filter: DeckFilter;
  /** `typing`: a keystroke in the search, which shouldn't add a step to Back. */
  onChange: (next: DeckFilter, typing?: boolean) => void;
  /** Every folder in use. */
  folders: string[];
  /** Some deck is in no folder, so "No folder" is worth offering. */
  hasUnfiled: boolean;
  shown: number;
  total: number;
}) {
  const toggle = (k: string) => {
    const on = filter.colors.includes(k) ? filter.colors.replace(k, "") : filter.colors + k;
    onChange({ ...filter, colors: COLORS.filter((c) => on.includes(c)).join("") });
  };
  return (
    <div className="deck-index-tools" role="search" aria-label="Find a deck">
      <input
        type="search"
        className="deck-index-search"
        value={filter.q}
        onChange={(e) => onChange({ ...filter, q: e.target.value }, true)}
        placeholder={`Search ${total} decks by name or commander`}
        aria-label="Search decks by name or commander"
        maxLength={100}
      />
      <div className="deck-index-fields">
        {folders.length > 0 && (
          <label>
            Folder
            <select
              value={filter.folder === null ? "" : filter.folder}
              onChange={(e) => onChange({ ...filter, folder: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">All folders</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              {hasUnfiled && <option value={NO_FOLDER}>No folder</option>}
            </select>
          </label>
        )}
        <div className="deck-index-colors" role="group" aria-label="Colors the deck includes">
          <span className="deck-index-label" aria-hidden="true">Colors</span>
          <span className="deck-index-pips">
            {COLORS.map((k) => (
              <button key={k} type="button" aria-pressed={filter.colors.includes(k)} aria-label={MANA[k].name} title={MANA[k].name} onClick={() => toggle(k)}>
                <Pips identity={k} label={false} />
              </button>
            ))}
          </span>
        </div>
        <label>
          Bracket
          <select value={filter.bracket} onChange={(e) => onChange({ ...filter, bracket: e.target.value })}>
            <option value="">Any bracket</option>
            {BRACKETS.map((b) => <option key={b.value} value={String(b.value)}>{b.value}, {b.name}</option>)}
            <option value="none">No bracket yet</option>
          </select>
        </label>
        <label>
          Sort by
          <select value={filter.sort} onChange={(e) => onChange({ ...filter, sort: e.target.value as DeckSort })}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {isFiltered(filter) && (
        <p className="small deck-index-count" role="status">
          <span>{shownText(shown, total)}</span>
          <button type="button" className="quiet" onClick={() => onChange({ ...filter, q: "", folder: null, colors: "", bracket: "" })}>Clear filters</button>
        </p>
      )}
    </div>
  );
}
