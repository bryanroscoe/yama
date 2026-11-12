import { useQueries } from "@tanstack/react-query";
import { api, type SearchResult } from "../api";
import { cardSearchPath } from "../guest";

/** A card's art crop (loaded from Scryfall at runtime, never stored), who painted it, and the
 *  whole card's picture for a thumbnail. */
export interface CardArt {
  art: string | null;
  artist: string | null;
  image?: string | null;
}

async function lookup(name: string): Promise<CardArt | null> {
  const find = async (n: string) => (await api<SearchResult>(cardSearchPath(`!"${n}"`))).cards[0] ?? null;
  let card = await find(name);
  // Partner pairs arrive as "A and B". Some single cards have "and" in their names, so the whole
  // name goes first; only if that finds nothing is it read as a pair.
  if (!card && name.includes(" and ")) card = await find(name.split(" and ")[0]!);
  return card?.image_art_crop ? { art: card.image_art_crop, artist: card.artist, image: card.image_normal } : null;
}

/**
 * Art crops by card name, looked up once per name and kept for the session. A name that can't
 * be found, or any lookup while offline, simply has no entry, so callers fall back to their
 * no-art look.
 */
export function useCardArt(names: (string | null | undefined)[]): Map<string, CardArt> {
  const unique = [...new Set(names.filter((n): n is string => !!n))];
  const results = useQueries({
    queries: unique.map((name) => ({
      queryKey: ["card-art", name],
      queryFn: () => lookup(name),
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
  });
  const found = new Map<string, CardArt>();
  unique.forEach((name, i) => {
    const art = results[i]?.data;
    if (art) found.set(name, art);
  });
  return found;
}
