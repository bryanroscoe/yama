import type { ConfigurationRef, DeckView } from "../api";
import { configurationLabel } from "./buildCatalog";

/** A configuration's name as the deck page shows it: its label, else Main for the main deck. */
export function listLabel(c: ConfigurationRef, main: boolean): string {
  return configurationLabel(c.configuration, c.name, main);
}

/**
 * Which list is in the real deck, and the other lists that can go in (Bryan, 2026-10-28: "There
 * should be the one that's currently implemented, and then there should be an easy way to swap
 * back to other versions of the deck"). The main deck's current list is the one in the box, and
 * plans read their installed swaps from it. Null for a deck with no configurations.
 */
export function deckLists(deck: Pick<DeckView, "id" | "parent_id" | "configurations">): { main: ConfigurationRef; here: "main" | "other"; others: ConfigurationRef[] } | null {
  if (deck.configurations.length < 2) return null;
  const main = deck.configurations.find((c) => c.id === (deck.parent_id ?? deck.id)) ?? deck.configurations[0]!;
  return { main, here: deck.id === main.id ? "main" : "other", others: deck.configurations.filter((c) => c.id !== main.id) };
}
