import { useState, type CSSProperties, type ReactNode } from "react";
import "./art-panel.css";

/** Where the text sits on the art decides the wash (design/tokens.md, "The art panel"). */
export type Wash = "center" | "bottom" | "left";

/** "Art: Name, © Wizards of the Coast". Every art crop carries it somewhere in the same view. */
export function artCredit(artist: string | null | undefined): string {
  return artist ? `Art: ${artist}, © Wizards of the Coast` : "Art © Wizards of the Coast";
}

/** One credit line for several art crops: "Art by A, B and C. ™ & © Wizards of the Coast." */
export function artCredits(artists: (string | null | undefined)[]): string {
  const names = [...new Set(artists.filter((a): a is string => !!a))];
  if (!names.length) return "Art ™ & © Wizards of the Coast.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Art by ${list}. ™ & © Wizards of the Coast.`;
}

/**
 * Commander art behind a player or a deck: Scryfall's art crop, loaded at runtime, cover-fitted.
 * The image is never filtered (no blur, fade or color change); all darkening comes from the wash,
 * a separate layer on top of it. Put small text on `.art-chip`; big numbers take `.art-big`.
 *
 * - No art yet: a raised block.
 * - `empty` (an open seat, no commander picked): a dashed outline instead.
 * - `credit={false}` when the caller shows the credit elsewhere in the same view.
 * - `toGround` ends the bottom wash in the page color (or `--art-fade`, for a hero on a sheet).
 * - `as="span"` for a panel inside a button; its body is then a span too.
 */
export function ArtPanel({
  art,
  artist,
  wash,
  empty = false,
  credit = true,
  toGround = false,
  as: Tag = "div",
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
  as?: "div" | "span" | "li" | "header" | "section";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = art && failed !== art ? art : null;
  const kind = shown ? "art-has" : empty ? "art-empty" : "art-none";
  const Body = Tag === "span" ? "span" : "div";
  return (
    <Tag className={`art-panel wash-${wash} ${kind}${toGround ? " to-ground" : ""}${Tag === "header" ? " art-scene" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {shown && (
        <>
          <img className="art-img" src={shown} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(shown)} />
          <span className="art-wash" aria-hidden="true" />
        </>
      )}
      <Body className="art-body">{children}</Body>
      {shown && credit && <span className="art-credit">{artCredit(artist)}</span>}
    </Tag>
  );
}
