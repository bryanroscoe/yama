// Commander art behind each life panel: a per-device choice, on unless someone turns it off.

import { useSyncExternalStore } from "react";
import type { PlayerSetup } from "@yama/core";

const KEY = "yama.table.art";
let showArt = typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
const listeners = new Set<() => void>();

export function useShowArt(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => showArt,
  );
}

export function setShowArt(on: boolean) {
  showArt = on;
  localStorage.setItem(KEY, on ? "on" : "off");
  for (const l of listeners) l();
}

/**
 * The art to draw for a player, or null. Only Scryfall's own image host (the setup travels to
 * guest phones, so nothing else gets loaded), and only with the artist known, because Scryfall
 * asks for the artist's credit wherever an art crop is shown.
 */
export function panelArt(p: Pick<PlayerSetup, "art" | "artist">): string | null {
  if (!p.art || !p.artist) return null;
  return /^https:\/\/cards\.scryfall\.io\//.test(p.art) ? p.art : null;
}

export const getShowArt = () => showArt;
export function subscribeShowArt(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
