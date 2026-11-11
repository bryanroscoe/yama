import { identityKeys, MANA } from "@yama/core";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../api";

export function Pips({ identity, label = true }: { identity: string; label?: boolean }) {
  const keys = identityKeys(identity);
  return (
    <span className="pips" role={label ? "img" : undefined} aria-label={label ? keys.map((k) => MANA[k].name).join(", ") : undefined}>
      {keys.map((k) => (
        <span key={k} className="pip" style={{ background: MANA[k].fill }} />
      ))}
    </span>
  );
}

/** "{2}{G/U}" → "2 G/U" in the display face. Real mana symbols are Wizards' art; we don't ship them. */
export function ManaCost({ cost }: { cost: string | null }) {
  if (!cost) return null;
  const text = cost.replace(/\{([^}]+)\}/g, " $1").replace(/\s\/\/\s/g, " // ").trim();
  return <span className="mana-cost" aria-label={`mana cost ${cost}`}>{text}</span>;
}

export function CardImage({ src, name, className = "card-img" }: { src: string | null | undefined; name: string; className?: string }) {
  if (!src) return <div className="card-fallback">{name}</div>;
  return <img className={className} src={src} alt={name} loading="lazy" decoding="async" crossOrigin="anonymous" />;
}

/** Scryfall's large image for a small or normal one, so the zoomed card's text is readable. */
function largeOf(src: string): string {
  return src.replace(/\/(small|normal)\//, "/large/");
}

/** A card image you can tap to see it full size (Escape, a tap or Close puts it back). */
export function ZoomableCard({ src, name, className = "card-img" }: { src: string | null | undefined; name: string; className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!src) return <CardImage src={src} name={name} className={className} />;
  return (
    <>
      <button type="button" className="card-zoom-open" onClick={() => setOpen(true)} aria-label={`Show ${name} larger`}>
        <CardImage src={src} name={name} className={className} />
      </button>
      {open &&
        createPortal(
          <div className="card-zoom" role="dialog" aria-modal="true" aria-label={name} onClick={() => setOpen(false)}>
            <img src={largeOf(src)} alt={name} decoding="async" crossOrigin="anonymous" />
            <button type="button" className="outline" autoFocus onClick={() => setOpen(false)}>
              Close
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A drawer from the bottom on phones and a side panel on laptops. `centered` puts a short
 * question in the middle of the screen instead, where everyone round a table phone can see it.
 */
export function Sheet({ onClose, children, label, centered = false }: { onClose: () => void; children: ReactNode; label: string; centered?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={centered ? "sheet sheet-centered" : "sheet"} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </>
  );
}

/**
 * Optional explanation behind a concise, descriptive disclosure. Native details
 * works with touch, keyboard and assistive technology without a hover dependency.
 */
export function Details({ children, label = "Details", className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <details className={`details-fold${className ? ` ${className}` : ""}`}>
      <summary>{label}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error" role="alert">{errorMessage(error)}</p>;
}

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * Something is on its way. Say what when the page knows ("Loading the deck…"); a screen reader
 * hears it once, politely. `page` is for a page with nothing else to draw yet, `padded` for a
 * line outside any page padding (an overlay still starting). `quiet` leaves the announcement
 * out: for a line inside a region that is already live, or one drawn again for every row.
 */
export function Loading({ children = "Loading…", small = false, page = false, padded = false, quiet = false, className }: { children?: ReactNode; small?: boolean; page?: boolean; padded?: boolean; quiet?: boolean; className?: string }) {
  const line = (
    <p className={cx("loading", "dim", small && "small", padded && "is-padded", className)} role={quiet ? undefined : "status"}>
      {children}
    </p>
  );
  return page ? <main className="page">{line}</main> : line;
}

/**
 * Nothing here yet: one sentence, with the way to add the first thing when there is one.
 * `boxed` is a dashed slot where the content will go, `panel` a surface card, `compact` a line
 * inside a list or a small panel.
 */
export function EmptyState({ children, title, action, variant = "plain", className }: { children?: ReactNode; title?: ReactNode; action?: ReactNode; variant?: "plain" | "boxed" | "panel" | "compact"; className?: string }) {
  const names = cx("empty", variant !== "plain" && `is-${variant}`, className);
  if (!title && !action) return <p className={names}>{children}</p>;
  return (
    <div className={cx(names, "has-parts")}>
      {title && <h2>{title}</h2>}
      {children && <p>{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
