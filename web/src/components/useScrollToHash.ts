import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * Scrolls to the address's `#anchor` once it's on the page, once per visit. React Router doesn't,
 * and a page that draws a section after its data loads has no anchor to jump to when it opens:
 * Review's links to a deck's proposals (`#proposed`) and a plan's changes (`#changes-head`).
 */
export function useScrollToHash(ready = true): void {
  const { hash, key } = useLocation();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !hash || done.current === key) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    done.current = key;
    el.scrollIntoView({ block: "start" });
  });
}
