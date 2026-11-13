import { useEffect, useRef, useState } from "react";
import { liveStock } from "./api";
import { emptyLive, mergeLive, type LiveState } from "./live-stock";

/** Between asks: while cart cards are being rechecked, while cards wait for a read, and once all are read. */
const HURRYING_MS = 5_000, READING_MS = 30_000, SETTLED_MS = 10 * 60_000;

/**
 * Store stock Yama keeps fresh in the background for these cards. Asking is what keeps them
 * being reread, so the page asks again while it is open: often while cards wait for a read,
 * rarely once every card is read. `hurry` names the cards in the carts, read first.
 */
export function useLiveStock(owner: string, cards: string[], hurry: string[]): { state: LiveState; error: unknown; /** The first answer has arrived: which stores are reread is known. */ loaded: boolean } {
  const [state, setState] = useState<LiveState>(emptyLive);
  const [error, setError] = useState<unknown>(null);
  const since = useRef<string | null>(null);
  const cardsKey = cards.join("\n"), hurryKey = hurry.join("\n");
  // Another list or account: nothing held carries over.
  useEffect(() => { since.current = null; setState(emptyLive); setError(null); }, [owner, cardsKey]);
  useEffect(() => {
    if (!cardsKey) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const next = await liveStock({ cards: cardsKey.split("\n"), hurry: hurryKey ? hurryKey.split("\n") : [], since: since.current });
        if (stopped) return;
        since.current = next.at;
        setState(held => mergeLive(held, next));
        setError(null);
        // No store Yama reads this way: nothing will change.
        if (!next.stores.length) return;
        // A card whose last read failed is retried on the server's own schedule.
        const hurrying = next.stores.some(s => s.hurrying > 0), reading = next.stores.some(s => s.fresh + s.failed < s.wanted);
        timer = setTimeout(ask, hurrying ? HURRYING_MS : reading ? READING_MS : SETTLED_MS);
      } catch (e) {
        if (stopped) return;
        setError(e);
        timer = setTimeout(ask, READING_MS * 2);
      }
    };
    // A moment's pause, so a run of cart changes asks once.
    timer = setTimeout(ask, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [owner, cardsKey, hurryKey]);
  return { state, error, loaded: state.at != null };
}
