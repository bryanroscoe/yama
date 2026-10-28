import type { DeckSummary } from "../api";

/** Main decks with their configurations, in list order. A configuration whose main deck isn't
 *  in the list (archived) shows as a main deck. */
export function groupConfigurations<T extends Pick<DeckSummary, "id" | "parent_id" | "configuration">>(decks: T[]): { main: T; configurations: T[] }[] {
  const ids = new Set(decks.map((d) => d.id));
  const groups = decks.filter((d) => !d.parent_id || !ids.has(d.parent_id)).map((main) => ({ main, configurations: [] as T[] }));
  const byId = new Map(groups.map((g) => [g.main.id, g]));
  for (const d of decks) {
    if (d.parent_id && ids.has(d.parent_id)) byId.get(d.parent_id)?.configurations.push(d);
  }
  for (const g of groups) g.configurations.sort((a, b) => (a.configuration ?? "").localeCompare(b.configuration ?? ""));
  return groups;
}
