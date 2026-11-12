import { useState, type ReactNode } from "react";

/**
 * A small picture of a card or its art crop from Scryfall, beside the card's or the player's
 * name. It loads at run time (never stored), lazily unless `eager`, and is never filtered,
 * blurred or faded. With the name beside it the picture is decoration (`alt=""`); give `name`
 * when the picture is the only thing that says which card it is. No picture, or one that
 * fails to load, draws `fallback` (nothing by default): pass the placeholder there, not in a
 * `src ? … : …` around the component, which would miss a picture that fails. The view that
 * shows an art crop credits the artist. A full card is `CardImage`; an art tile is `Crop` or
 * `ArtPanel`.
 */
export function CardThumb({ src, name, className, title, eager = false, fallback = null }: { src: string | null | undefined; name?: string; className?: string; title?: string; eager?: boolean; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return fallback;
  return <img className={className} src={src} alt={name ?? ""} title={title} loading={eager ? "eager" : "lazy"} decoding="async" crossOrigin="anonymous" draggable={false} onError={() => setFailed(src)} />;
}
