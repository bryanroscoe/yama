// Small pieces the Decks tab's pages share: a card's art crop as a landscape tile, and a win-rate
// interval bar with the 25% line (design/tokens.md, "Prices and simulation numbers").

import { useState } from "react";
import "./deck-area.css";

/**
 * A card's Scryfall art crop, loaded at runtime and never filtered. No art: a raised block; no
 * card at all (an empty slot): a dashed outline. The view showing it credits the artist.
 */
export function Crop({ src, size = "", empty = false, alt = "" }: { src: string | null | undefined; size?: "" | "sm" | "md" | "lg"; empty?: boolean; alt?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const cls = `crop${size ? ` crop-${size}` : ""}`;
  if (!src || failed === src) return <span className={`${cls}${empty ? " crop-empty" : ""}`} aria-hidden={alt ? undefined : true} role={alt ? "img" : undefined} aria-label={alt || undefined} />;
  return <img className={cls} src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />;
}

/**
 * A win rate with its interval on a 0..`max` axis, a `--warn` line at 25% (an even share of a
 * 4-player pod), and `few` drawing the interval fainter when there are too few games to trust.
 * `label` is the accessible name and the hover text.
 */
export function WinBar({ value, lo, hi, max, few = false, label }: { value: number | null | undefined; lo?: number | null; hi?: number | null; max: number; few?: boolean; label: string }) {
  const at = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(2)}%`;
  return (
    <span className={`wbar${few ? " few" : ""}`} role="img" aria-label={label} title={label}>
      <span className="wbar-ref" style={{ left: at(0.25) }} />
      {lo != null && hi != null && <span className="wbar-range" style={{ left: at(lo), width: `${(Math.max(0, Math.min(hi, max) - Math.max(lo, 0)) / max * 100).toFixed(2)}%` }} />}
      {value != null && <span className="wbar-dot" style={{ left: at(value) }} />}
    </span>
  );
}

/** An axis ceiling for win-rate bars: the largest upper bound, rounded up to a tenth, at least `min`. */
export function winCeiling(values: (number | null | undefined)[], min = 0.6): number {
  const top = Math.max(min, ...values.filter((v): v is number => v != null && Number.isFinite(v)));
  return Math.min(1, Math.ceil(top * 10) / 10);
}
