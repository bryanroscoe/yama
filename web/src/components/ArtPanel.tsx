import { useState, type CSSProperties, type ReactNode } from "react";
import "./art-panel.css";

/** Where the text sits on the art decides the wash (design/tokens.md, "The art panel"). */
export type Wash = "center" | "bottom" | "left";

/** "Art: Name, © Wizards of the Coast". Every art crop carries it somewhere in the same view. */
export function artCredit(artist: string | null | undefined): string {
  return artist ? `Art: ${artist}, © Wizards of the Coast` : "Art © Wizards of the Coast";
}

/**
 * Commander art behind a player or a deck: Scryfall's art crop, loaded at runtime, cover-fitted.
 * The image is never filtered (no blur, fade or color change); all darkening comes from the wash,
 * a separate layer on top of it. Put small text on `.art-chip`; big numbers take `.art-big`.
 *
 * - No art yet: a raised block.
 * - `empty` (an open seat, no commander picked): a dashed outline instead.
 * - `credit={false}` when the caller shows the credit elsewhere in the same view.
 * - `toGround` ends the bottom wash in the page color, for a hero that sits on the page.
 */
export function ArtPanel({
  art,
  artist,
  wash,
  empty = false,
  credit = true,
  toGround = false,
  className,
  style,
  children,
}: {
  art: string | null | undefined;
  artist?: string | null;
  wash: Wash;
  empty?: boolean;
  credit?: boolean;
  toGround?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = art && failed !== art ? art : null;
  const kind = shown ? "art-has" : empty ? "art-empty" : "art-none";
  return (
    <div className={`art-panel wash-${wash} ${kind}${toGround ? " to-ground" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {shown && (
        <>
          <img className="art-img" src={shown} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(shown)} />
          <div className="art-wash" aria-hidden="true" />
        </>
      )}
      <div className="art-body">{children}</div>
      {shown && credit && <span className="art-credit">{artCredit(artist)}</span>}
    </div>
  );
}
