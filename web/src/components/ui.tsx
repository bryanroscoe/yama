import { identityKeys, MANA } from "@yama/core";
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../api";
import { useModalLayer } from "./Dialog";

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
  if (!src) return <CardImage src={src} name={name} className={className} />;
  return (
    <>
      <button type="button" className="card-zoom-open" onClick={() => setOpen(true)} aria-label={`Show ${name} larger`}>
        <CardImage src={src} name={name} className={className} />
      </button>
      {open && <CardZoom src={src} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The card at full size over everything, as a modal layer of its own. */
function CardZoom({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(root, onClose);
  return createPortal(
    <div ref={root} className="card-zoom" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} onClick={onClose} {...layer}>
      <img src={largeOf(src)} alt={name} decoding="async" crossOrigin="anonymous" />
      <button type="button" className="outline" autoFocus onClick={onClose}>
        Close
      </button>
    </div>,
    document.body,
  );
}

export { Dialog, DialogHead } from "./Dialog";

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

export interface Segment<T> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** A longer name for a short label ("3" is "3, Upgraded"): the tooltip and the accessible name. */
  title?: string;
}

/**
 * A pill track for choosing one of two to five views or values of the same thing. Each segment
 * is a button with `aria-pressed`, in a labelled group: one model for every segmented control.
 * Options are `{ value, label }` or `[value, label]`. `value` may match none (nothing pressed).
 * Name the group with `label`, or `labelledBy` when its label is already on the page.
 */
export function Segmented<T extends string | number | boolean | null>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  className,
  disabled = false,
  compact = false,
  as: Tag = "div",
  segmentProps,
}: {
  label?: string;
  labelledBy?: string;
  value: T | undefined;
  options: readonly (Segment<T> | readonly [T, ReactNode])[];
  onChange: (value: T) => void;
  className?: string;
  /** Every segment off, while a save is on its way. */
  disabled?: boolean;
  /** The smaller track for a toolbar: 13 px labels, tighter padding. */
  compact?: boolean;
  as?: "div" | "span";
  /** Extra attributes for every segment (a picker keeping its field focused, say). */
  segmentProps?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, "tabIndex" | "onPointerDown">;
}) {
  return (
    <Tag className={cx("segmented", compact && "is-compact", className)} role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map((o) => {
        const s: Segment<T> = "value" in o ? o : { value: o[0], label: o[1] };
        return (
          // The type is part of the key: null and a value spelled "null" are different segments.
          <button key={`${typeof s.value}:${s.value}`} type="button" {...segmentProps} title={s.title} aria-label={s.title} aria-pressed={s.value === value} disabled={disabled || s.disabled} onClick={() => onChange(s.value)}>
            {s.label}
          </button>
        );
      })}
    </Tag>
  );
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
