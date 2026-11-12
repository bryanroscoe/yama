import { identityKeys, MANA } from "@yama/core";
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../api";
import { Button } from "./Button";
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

export { ManaCost, ManaSymbol, OracleText, SymbolText } from "./ManaSymbols";

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
      <Button className="card-zoom-open" onClick={() => setOpen(true)} aria-label={`Show ${name} larger`}>
        <CardImage src={src} name={name} className={className} />
      </Button>
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
      <Button variant="outline" autoFocus onClick={onClose}>
        Close
      </Button>
    </div>,
    document.body,
  );
}

export { Dialog, DialogHead } from "./Dialog";
export { CopyButton } from "./CopyButton";
export { ActionBar } from "./ActionBar";
export { BackLink } from "./BackLink";
export { CardThumb } from "./CardThumb";
export { PageHeader } from "./PageHeader";
export { Pager, ShowMore } from "./Pager";
export { CheckRow, Field } from "./Field";
export { StatusPill, Tag, toneOf, type Tone } from "./StatusPill";
export { Button, ButtonLink, type ButtonLook, type ButtonVariant } from "./Button";

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

/**
 * What went wrong, in words, announced at once. `error` is whatever was thrown, or the message
 * itself; nothing is drawn for no error. With `retry`, Try again sits on the same line: give it
 * wherever asking again can work (a page or a panel that failed to load).
 */
export function ErrorText({ error, retry, small = false }: { error: unknown; retry?: () => void; small?: boolean }) {
  if (!error) return null;
  return (
    <p className={cx("error", small && "small")} role="alert">
      {errorMessage(error)}
      {retry && (
        <Button variant="quiet" size="small" onClick={retry}>
          Try again
        </Button>
      )}
    </p>
  );
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
          <Button key={`${typeof s.value}:${s.value}`} {...segmentProps} title={s.title} aria-label={s.title} aria-pressed={s.value === value} disabled={disabled || s.disabled} onClick={() => onChange(s.value)}>
            {s.label}
          </Button>
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
