// The Decks list (/decks): folders, the search, the color and bracket filters and the sort.
// Everything here works on the list the page already has; the choices live in the address
// (?q=…&folder=…&colors=UG&bracket=3&sort=recent), so Back and a reload keep them.
import { identityKeys } from "@yama/core";
import type { DeckSummary } from "../api";
import { suggestedBracket } from "../components/deckCheck";

export type DeckSort = "name" | "recent" | "record";
export const SORTS: { value: DeckSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recently changed" },
  { value: "record", label: "Record" },
];

/** Stands for "decks in no folder" where a folder name goes. Folder names are trimmed, so none starts with a space. */
export const NO_FOLDER = " none";

export interface DeckFilter {
  /** Typed search: part of a deck's name, a commander or a list's name. */
  q: string;
  /** A folder's name, NO_FOLDER, or null for every deck. */
  folder: string | null;
  /** Colors the deck's identity must include, in WUBRG order ("" for any). */
  colors: string;
  /** "1" to "5", "none" (no bracket declared or suggested), or "" for any. */
  bracket: string;
  sort: DeckSort;
}

type Deck = Pick<DeckSummary, "id" | "name" | "folder" | "commanders" | "color_identity" | "bracket" | "estimate" | "updated_at" | "games" | "wins" | "configuration">;
export interface DeckGroup<T extends Deck = Deck> {
  main: T;
  configurations: T[];
}

/** A deck's folder as shown: trimmed, null when it has none. */
export function folderOf(d: Pick<DeckSummary, "folder">): string | null {
  return d.folder?.trim() || null;
}

/** Every folder in use, A to Z (ignoring case). */
export function foldersOf(decks: Pick<DeckSummary, "folder">[]): string[] {
  const all = new Set(decks.map(folderOf).filter((f): f is string => f !== null));
  return [...all].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** The bracket a deck is filed under: the one its owner declared, else Yama's starting suggestion. */
export function bracketOf(d: Pick<DeckSummary, "bracket" | "estimate">): number | null {
  return d.bracket ?? (d.estimate ? suggestedBracket(d.estimate.tag, d.estimate.bracket) : null);
}

/** The filter the address asks for; anything it doesn't understand is left off. */
export function readFilter(params: URLSearchParams): DeckFilter {
  const sort = params.get("sort");
  const bracket = params.get("bracket") ?? "";
  const colors = (params.get("colors") ?? "").toUpperCase();
  return {
    q: params.get("q") ?? "",
    folder: params.has("folder") ? params.get("folder") || NO_FOLDER : null,
    colors: "WUBRG".split("").filter((k) => colors.includes(k)).join(""),
    bracket: /^[1-5]$/.test(bracket) || bracket === "none" ? bracket : "",
    sort: SORTS.some((s) => s.value === sort) ? (sort as DeckSort) : "name",
  };
}

/** The address for a filter, on top of whatever else it carries. Defaults leave no trace. */
export function writeFilter(params: URLSearchParams, f: DeckFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | null) => (value === null ? next.delete(key) : next.set(key, value));
  set("q", f.q || null);
  set("folder", f.folder === null ? null : f.folder === NO_FOLDER ? "" : f.folder);
  set("colors", f.colors || null);
  set("bracket", f.bracket || null);
  set("sort", f.sort === "name" ? null : f.sort);
  return next;
}

/** Whether anything narrows the list (the sort alone doesn't). */
export function isFiltered(f: DeckFilter): boolean {
  return !!f.q.trim() || f.folder !== null || !!f.colors || !!f.bracket;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function matches(g: DeckGroup, f: DeckFilter): boolean {
  const d = g.main;
  if (f.folder !== null && (folderOf(d) ?? NO_FOLDER) !== f.folder) return false;
  if (f.colors) {
    const identity = identityKeys(d.color_identity).join("");
    if (![...f.colors].every((k) => identity.includes(k))) return false;
  }
  if (f.bracket) {
    const b = bracketOf(d);
    if (f.bracket === "none" ? b !== null : String(b) !== f.bracket) return false;
  }
  const words = fold(f.q).split(/\s+/).filter(Boolean);
  if (words.length) {
    // A deck's own name and commanders, and those of its other lists ("Stock", "Bracket 3").
    const hay = fold([d.name, ...d.commanders, ...g.configurations.flatMap((c) => [c.name, c.configuration ?? "", ...c.commanders])].join("\n"));
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** Wins over games played, or null for a deck that hasn't played. */
function winRate(d: Pick<DeckSummary, "games" | "wins">): number | null {
  return d.games ? (d.wins ?? 0) / d.games : null;
}

const byName = (a: DeckGroup, b: DeckGroup) => a.main.name.localeCompare(b.main.name, "en", { sensitivity: "base" });

/** The newest change to a deck or any of its lists. */
function changed(g: DeckGroup): string {
  return [g.main, ...g.configurations].map((d) => d.updated_at).sort().at(-1) ?? "";
}

/** The decks the filter keeps, in the order asked for. Every sort falls back to the name. */
export function arrangeDecks<T extends Deck>(groups: DeckGroup<T>[], f: DeckFilter): DeckGroup<T>[] {
  const kept = groups.filter((g) => matches(g, f));
  if (f.sort === "recent") return kept.sort((a, b) => changed(b).localeCompare(changed(a)) || byName(a, b));
  if (f.sort === "record") {
    // Best win rate first; between equal rates the deck with more games; unplayed decks last.
    return kept.sort((a, b) => {
      const [x, y] = [winRate(a.main), winRate(b.main)];
      if (x === null || y === null) return Number(x === null) - Number(y === null) || byName(a, b);
      return y - x || (b.main.games ?? 0) - (a.main.games ?? 0) || byName(a, b);
    });
  }
  return kept.sort(byName);
}

/** "3 of 12 decks" while a filter is on. */
export function shownText(shown: number, total: number): string {
  return `${shown} of ${total} ${total === 1 ? "deck" : "decks"}`;
}
