import { Link } from "react-router";

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

type BackLinkProps = { to: string; className?: string } & (
  | { inline: true; onArt?: never; text: string; label?: string }
  | { inline?: false; onArt?: boolean; text: string; label?: string }
  | { inline?: false; onArt?: boolean; text?: undefined; label: string }
);

/**
 * The way back to the page above this one. `text` is the place itself ("Decks", "Play
 * online"), shown beside the chevron; `label` is the link's name for a screen reader, "Back to"
 * and the place, and is worked out from `text` when it isn't given. Say it yourself only to
 * name the place better than the words on screen do, and keep those words in it.
 *
 * - by default a round 44 px button, for a page's top row; with `text`, laptops show the words;
 * - `onArt` sits it in the corner of an art header, on a dark chip;
 * - `inline` is a line of dim words with the chevron, for a page with no top row: it needs `text`.
 */
export function BackLink({ to, label, text, onArt = false, inline = false, className }: BackLinkProps) {
  const names = inline ? ["back-inline", className] : ["area-back", text && "has-text", onArt && "on-art", className];
  return (
    <Link to={to} className={names.filter(Boolean).join(" ")} aria-label={label ?? `Back to ${text}`}>
      <Chevron />
      {text && <span className={inline ? undefined : "area-back-text"}>{text}</span>}
    </Link>
  );
}
