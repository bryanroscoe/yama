// A picker that searches (design/tokens.md, Density rule 8: six or more choices, or anything
// searched): a search field over a list of choices. The page puts it in a sheet, or swaps it in for
// the form it belongs to.
import { useState } from "react";
import "./search-picker.css";
import { Button } from "./Button";

export interface PickerOption {
  id: string;
  label: string;
  /** Where it comes from or what it is, short. */
  detail?: string;
}

/** The choices whose label or detail hold every word typed, in their order. */
export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = `${o.label} ${o.detail ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The search shows past eight choices; fewer fit at a glance. */
export const SEARCH_FROM = 9;

export function SearchPicker({ label, options, current, onPick }: { label: string; options: PickerOption[]; current?: string | null; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = filterOptions(options, query);
  return (
    <div className="search-picker">
      {options.length >= SEARCH_FROM && (
        <input type="search" className="search-picker-field" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      )}
      {shown.length > 0 ? (
        <ul className="search-picker-list" aria-label={label}>
          {shown.map((o) => (
            <li key={o.id}>
              <Button className="search-picker-item" aria-current={o.id === current ? "true" : undefined} onClick={() => onPick(o.id)}>
                <b>{o.label}</b>
                {o.detail && <span className="small dim">{o.detail}</span>}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim search-picker-none">{options.length ? "Nothing matches." : "Nothing to choose yet."}</p>
      )}
    </div>
  );
}
