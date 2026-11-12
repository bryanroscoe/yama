// Shared searchable fields and the full-screen touch picker, originally built for Table.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pips } from "./ui";
import { pickerPlacement } from "./pickerPlacement";
import "./gamePicker.css";
import { useModalLayer } from "./Dialog";
import { Button } from "./Button";
import { CardThumb } from "./CardThumb";

/** One selectable item, with optional commander art, colors and supporting text. */
export interface Option<T> {
  key: string;
  value: T;
  label: string;
  sub?: string;
  /** An art crop or avatar drawn at the row's start. */
  art?: string | null;
  identity?: string;
}

/**
 * A text field with a list of matches under it. `onText` gets every keystroke; `onPick` a chosen
 * option. The list opens while the field has focus and there's something to show.
 */
export function Combobox<T>({
  label,
  text,
  onText,
  options,
  onPick,
  placeholder,
  loading = false,
  empty,
  trailing,
  autoFocus = false,
  footer,
  onLeave,
  onOpen,
  toggle,
  head,
}: {
  label: string;
  text: string;
  onText: (t: string) => void;
  options: Option<T>[];
  onPick: (v: T) => void;
  placeholder?: string;
  loading?: boolean;
  /** Shown in the open list when nothing matches. */
  empty?: ReactNode;
  trailing?: ReactNode;
  autoFocus?: boolean;
  /** A last line in the open list (the art credit for the crops shown). */
  footer?: ReactNode;
  /** Focus left the field (to resolve text that was typed but never picked). */
  onLeave?: () => void;
  /** The list opened without typing: on focus, the arrow key or the toggle. */
  onOpen?: () => void;
  /** A button at the field's end that opens the whole list, as a dropdown does; its label. */
  toggle?: string;
  /** A first line in the open list (filters for what it shows). */
  head?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLLabelElement>(null);
  const [listStyle, setListStyle] = useState<CSSProperties>();
  useEffect(() => setActive(0), [options.length, text]);
  // Close when focus or a tap lands anywhere else (another field, the sheet behind).
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("focusin", away);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("focusin", away);
      document.removeEventListener("pointerdown", away);
    };
  }, [open]);
  const pick = (o: Option<T>) => {
    onPick(o.value);
    setOpen(false);
  };
  // With filters at its head, the list stays open to say what a filter found nothing for.
  const showList = open && (options.length > 0 || (!!empty && (text.trim().length > 0 || !!head)) || loading);
  // A narrow seat can open a readable list over its neighbours. Keep it inside the viewport.
  useLayoutEffect(() => {
    if (!showList) return;
    const place = () => {
      if (!input.current) return;
      const r = input.current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      // A Table editor can live inside a scrolling sheet. Its clipping edges count too.
      const clip = { top: 0, bottom: window.innerHeight };
      for (let parent = input.current.parentElement; parent; parent = parent.parentElement) {
        if (!/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(parent).overflowY)) continue;
        const box = parent.getBoundingClientRect();
        clip.top = Math.max(clip.top, box.top + parent.clientTop);
        clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight);
      }
      if (r.bottom <= clip.top || r.top >= clip.bottom) { setOpen(false); return; }
      const p = pickerPlacement(r, { width: window.innerWidth, height: window.innerHeight }, clip);
      const next: CSSProperties = { width: p.width, left: p.left, right: "auto", maxHeight: p.maxHeight,
        top: p.opensAbove ? "auto" : "calc(100% + 4px)", bottom: p.opensAbove ? "calc(100% + 4px)" : "auto" };
      setListStyle((prev) => prev && prev.width === next.width && prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom && prev.maxHeight === next.maxHeight ? prev : next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [showList]);
  const openList = () => {
    onOpen?.();
    setOpen(true);
  };
  return (
    <label className="combo" ref={root}>
      <span id={`${id}-label`} className="field-label">{label}</span>
      <span className={toggle ? "combo-wrap has-toggle" : "combo-wrap"}>
        <input
          ref={input}
          role="combobox"
          aria-labelledby={`${id}-label`}
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && options[active] ? `${id}-${active}` : undefined}
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onFocus={openList}
          onClick={() => { if (!open) openList(); }}
          // Let a tap on an option land before the list closes.
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150);
            onLeave?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openList();
              setActive((a) => Math.max(0, Math.min(a + 1, options.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && showList) {
              // An empty search must not submit an enclosing Join game form.
              e.preventDefault();
              if (options[active]) pick(options[active]);
            } else if (e.key === "Escape") {
              // Handled here while the list is open: the dialog this sits in stays.
              if (showList) e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {trailing}
        {toggle && (
          <Button
            className="combo-toggle"
            aria-label={toggle}
            aria-expanded={showList}
            tabIndex={-1}
            // Keep the field focused, so the list stays open under the pointer.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              if (showList) return setOpen(false);
              input.current?.focus();
              openList();
            }}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        )}
        {showList && (
          <ul className="combo-list" style={listStyle} role="listbox" id={`${id}-list`} aria-label={label}>
            {head && <li className="combo-head" role="presentation">{head}</li>}
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className="combo-option"
                onPointerDown={(e) => e.preventDefault()}
                onClick={(e) => { e.preventDefault(); pick(o); }}
                onMouseEnter={() => setActive(i)}
              >
                {o.art !== undefined && <CardThumb className="combo-art" src={o.art} eager fallback={<span className="combo-art combo-art-none" />} />}
                <span className="combo-text">
                  <span className="combo-label">{o.label}</span>
                  {o.sub && <span className="combo-sub">{o.sub}</span>}
                </span>
                {o.identity !== undefined && <Pips identity={o.identity} label={false} />}
              </li>
            ))}
            {options.length === 0 && <li className="combo-empty">{loading ? "Searching…" : empty}</li>}
            {options.length > 0 && footer && <li className="combo-foot" aria-hidden="true">{footer}</li>}
          </ul>
        )}
      </span>
    </label>
  );
}

const TOUCH = "(pointer: coarse)";
const subscribeTouch = (change: () => void) => {
  const m = window.matchMedia?.(TOUCH);
  m?.addEventListener("change", change);
  return () => m?.removeEventListener("change", change);
};
/** A touch screen, where a list to browse opens as its own page and the keyboard waits for the search box. */
export function useTouch(): boolean {
  return useSyncExternalStore(subscribeTouch, () => !!window.matchMedia?.(TOUCH).matches, () => false);
}

/**
 * On a touch screen, a field that opens a list to browse (Bryan, 4 Nov 2026: scroll the list
 * first, and bring up the search only when the search box is tapped). It looks like the field;
 * tapping it opens a full-screen picker.
 */
export function PickerField({ label, text, placeholder, trailing, onOpen }: {
  label: string;
  text: string;
  placeholder?: string;
  trailing?: ReactNode;
  onOpen: () => void;
}) {
  const id = useId();
  return (
    <div className="picker-field">
      <span id={id} className="field-label">{label}</span>
      <span className="combo-wrap has-toggle">
        <Button className={text ? "combo-field" : "combo-field is-empty"} aria-haspopup="dialog" aria-labelledby={id} aria-describedby={`${id}-v`} onClick={onOpen}>
          <span id={`${id}-v`} className="combo-field-text">{text || placeholder}</span>
        </Button>
        {trailing}
        <span className="combo-toggle" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </div>
  );
}

/**
 * The full-screen list a PickerField opens: the whole list to scroll, a search box above it that
 * filters as you type (the keyboard comes up only when it's tapped), and Close. Nothing changes
 * until an option is picked.
 */
export function PickerSheet<T>({ label, query, onQuery, options, onPick, onClose, placeholder, loading = false, empty, footer, extra }: {
  label: string;
  query: string;
  onQuery: (t: string) => void;
  options: Option<T>[];
  onPick: (v: T) => void;
  onClose: () => void;
  placeholder?: string;
  loading?: boolean;
  /** Shown when nothing is listed. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** A line under the search box (another way out, such as no deck at all). */
  extra?: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // A modal layer (components/Dialog.tsx): focus goes to the heading, so no keyboard comes up,
  // and back to whatever opened it; the seat editor under it is inert; Escape closes this
  // picker only.
  const layer = useModalLayer(root, onClose, heading);
  // A new search starts at the top of its matches.
  // (A block body: newer browsers' scrollTo returns a promise, which mustn't become a cleanup.)
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [query]);
  return createPortal(
    <div ref={root} className="picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} {...layer}>
      <div className="picker-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{label}</h2>
        <Button variant="quiet" onClick={onClose}>Close</Button>
      </div>
      <input
        type="search"
        className="picker-search"
        aria-label={`Search ${label.toLowerCase()}`}
        aria-controls={`${id}-list`}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onQuery(e.target.value)}
        // Enter takes the first match, and puts the keyboard away otherwise.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (query.trim() && options[0]) onPick(options[0].value);
          else e.currentTarget.blur();
        }}
      />
      {extra}
      <ul ref={list} className="picker-list" id={`${id}-list`} aria-label={label}>
        {options.map((o) => (
          <li key={o.key}>
            <Button className="combo-option picker-option" onClick={() => onPick(o.value)}>
              {o.art !== undefined && <CardThumb className="combo-art" src={o.art} fallback={<span className="combo-art combo-art-none" />} />}
              <span className="combo-text">
                <span className="combo-label">{o.label}</span>
                {o.sub && <span className="combo-sub">{o.sub}</span>}
              </span>
              {o.identity !== undefined && <Pips identity={o.identity} label={false} />}
            </Button>
          </li>
        ))}
        {options.length === 0 && <li className="combo-empty">{loading ? "Searching…" : empty}</li>}
        {options.length > 0 && footer && <li className="combo-foot" aria-hidden="true">{footer}</li>}
      </ul>
    </div>,
    document.body,
  );
}

