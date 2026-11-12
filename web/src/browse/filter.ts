// The Browse page's filters, kept in the address (`/decks/browse?q=…&colors=…`), and the same
// filters as the listing API takes them (server/src/sharing/browse.rs).

export interface BrowseFilter {
  /** Part of a deck's or a commander's name. */
  q: string;
  /** Part of a commander's name. */
  commander: string;
  /** Colors the deck includes, in WUBRG order; "C" alone is colorless. */
  colors: string;
  /** The declared bracket, "1" to "5"; "" is any. */
  bracket: string;
  /** "": any deck. "any": started from some precon. Otherwise one precon's id. */
  precon: string;
  /** From 0. */
  page: number;
}

export const NO_FILTER: BrowseFilter = { q: "", commander: "", colors: "", bracket: "", precon: "", page: 0 };

const COLOR_ORDER = "WUBRG";

/** "bu" as "UB"; "C" stays "C"; letters that aren't colors are dropped. */
export function colorsOf(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === "C") return "C";
  return [...COLOR_ORDER].filter((c) => upper.includes(c)).join("");
}

/** Turn a color on or off. Colorless stands alone: picking it clears the colors, and a color clears it. */
export function toggleColor(colors: string, key: string): string {
  if (key === "C") return colors === "C" ? "" : "C";
  const base = colors === "C" ? "" : colors;
  return colorsOf(base.includes(key) ? base.replace(key, "") : base + key);
}

export function readFilter(params: URLSearchParams): BrowseFilter {
  const bracket = params.get("bracket") ?? "";
  const page = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q: params.get("q") ?? "",
    commander: params.get("commander") ?? "",
    colors: colorsOf(params.get("colors") ?? ""),
    bracket: /^[1-5]$/.test(bracket) ? bracket : "",
    precon: (params.get("precon") ?? "").trim(),
    // The address counts pages from 1, as the pager says them.
    page: Number.isFinite(page) && page > 1 ? page - 1 : 0,
  };
}

/** The address for a filter: only what is set, so a plain `/decks/browse` stays plain. */
export function writeFilter(filter: BrowseFilter): URLSearchParams {
  const out = new URLSearchParams();
  if (filter.q.trim()) out.set("q", filter.q);
  if (filter.commander.trim()) out.set("commander", filter.commander);
  if (filter.colors) out.set("colors", filter.colors);
  if (filter.bracket) out.set("bracket", filter.bracket);
  if (filter.precon) out.set("precon", filter.precon);
  if (filter.page > 0) out.set("page", String(filter.page + 1));
  return out;
}

/** The listing API's query for a filter (its pages count from 0). */
export function apiQuery(filter: BrowseFilter): string {
  const out = new URLSearchParams();
  if (filter.q.trim()) out.set("q", filter.q.trim());
  if (filter.commander.trim()) out.set("commander", filter.commander.trim());
  if (filter.colors) out.set("colors", filter.colors);
  if (filter.bracket) out.set("bracket", filter.bracket);
  if (filter.precon) out.set("precon", filter.precon);
  if (filter.page > 0) out.set("page", String(filter.page));
  const text = out.toString();
  return text ? `?${text}` : "";
}

export function isFiltered(filter: BrowseFilter): boolean {
  return !!(filter.q.trim() || filter.commander.trim() || filter.colors || filter.bracket || filter.precon);
}
