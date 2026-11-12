import { useQueries } from "@tanstack/react-query";
import { api, type SearchResult } from "../api";
import { cardSearchPath } from "../guest";

/** A search returns at most this many cards, and its query at most 1,000 characters
 *  (server/src/cards/mod.rs), so names are looked up in batches that fit both. */
const PER_BATCH = 50;
const MAX_QUERY = 950;

const term = (name: string) => `!"${name.replace(/"/g, "")}"`;

/** Names split into searches of `!"A" or !"B" ...` that each fit one page and one query. */
export function pictureBatches(names: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const name of names) {
    const add = term(name).length + (current.length ? 4 : 0);
    if (current.length && (current.length >= PER_BATCH || length + add > MAX_QUERY)) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(name);
    length += term(name).length + (current.length > 1 ? 4 : 0);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The card a name means: its whole name, or one face of a multi-face card. */
function matches(card: SearchResult["cards"][number], name: string) {
  const want = name.toLowerCase();
  const full = card.name.toLowerCase();
  return full === want || full.split(" // ").includes(want);
}

/**
 * Card pictures (Scryfall's normal image, loaded at runtime, never stored) by card name, for a
 * list of cards such as a deck's swaps. A few names share each search, so a long list stays well
 * inside the search rate limit. A name Yama can't find simply has no entry.
 */
export function useCardPictures(names: (string | null | undefined)[]): Map<string, string> {
  const unique = [...new Set(names.filter((n): n is string => !!n))].sort();
  const batches = pictureBatches(unique);
  const results = useQueries({
    queries: batches.map((batch) => ({
      queryKey: ["card-pictures", batch],
      queryFn: async () => (await api<SearchResult>(cardSearchPath(batch.map(term).join(" or ")))).cards,
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
  });
  const found = new Map<string, string>();
  batches.forEach((batch, i) => {
    const cards = results[i]?.data ?? [];
    for (const name of batch) {
      const image = cards.find((c) => matches(c, name))?.image_normal;
      if (image) found.set(name, image);
    }
  });
  return found;
}
