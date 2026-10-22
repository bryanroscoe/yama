import { identityKeys, MANA } from "@yama/core";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  return <img className={className} src={src} alt={name} loading="lazy" decoding="async" />;
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
            <img src={largeOf(src)} alt={name} decoding="async" />
            <button type="button" className="outline" autoFocus onClick={() => setOpen(false)}>
              Close
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </>
  );
}

/**
 * A collapsed "Details" disclosure for the facts behind a plain sentence: file names, content
 * hashes, commits and the full rule discussion. Visible copy stays one or two plain sentences.
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
  return <p className="error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}
