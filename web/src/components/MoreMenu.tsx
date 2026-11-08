// A page's More: the actions that don't get a button of their own (design/tokens.md, "Density,
// actions and page structure", rule 2; design/system/components/ActionBar). It floats: a popover
// under the button with a mouse or trackpad on a laptop, a bottom sheet on a phone. It never
// expands inline and never pushes the page down.
import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./ui";

const POPOVER = "(pointer: fine) and (min-width: 900px)";

function useMatches(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const change = () => setOn(m.matches);
    change();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, [query]);
  return on;
}

/** A hairline between groups of actions in a More menu. */
export function MenuSeparator() {
  return <hr className="more-menu-sep" />;
}

/**
 * The More button and its floating menu. Children are the actions (buttons and links); choosing one
 * closes the menu. Separate groups with `MenuSeparator`; the destructive action goes last.
 */
export function MoreMenu({ children, label = "More", className = "" }: { children: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const popover = useMatches(POPOVER);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The popover sits on the page root, placed under the button, so a panel that clips its content
  // (an art hero) never cuts it off.
  const [place, setPlace] = useState<CSSProperties>({});
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // The popover closes on Escape, a press outside it, a scroll or a resize; the sheet has its own
  // scrim and Escape.
  useEffect(() => {
    if (!open || !popover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !pop.current?.contains(t)) close(false);
    };
    // A scroll inside the menu (a long one on a short screen) keeps it open.
    const onMove = (e: Event) => {
      if (e.target instanceof Node && pop.current?.contains(e.target)) return;
      close(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, popover]);
  // Keyboard users land on the first action (the popover sits at the end of the page).
  useEffect(() => {
    if (open && popover) pop.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, [open, popover]);
  // Under the button, or above it when there's more room there; a menu taller than the room
  // scrolls inside.
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) {
      const right = Math.max(8, window.innerWidth - r.right);
      const below = window.innerHeight - r.bottom - 14;
      const above = r.top - 14;
      setPlace(
        below >= 360 || below >= above
          ? { top: r.bottom + 6, right, maxHeight: below }
          : { bottom: window.innerHeight - r.top + 6, right, maxHeight: above },
      );
    }
    setOpen((o) => !o);
  };
  // Tabbing out of the popover closes it.
  const onLeave = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !pop.current?.contains(to) && !wrap.current?.contains(to)) setOpen(false);
  };

  // Choosing an action closes the menu (the action may open its own sheet).
  const onPick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) setOpen(false);
  };
  const items = (
    <div id={id} className="more-menu-items" onClick={onPick}>
      {children}
    </div>
  );
  return (
    <div className="more-menu" ref={wrap}>
      <button ref={button} type="button" className={className} aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        {label}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        popover &&
        createPortal(
          <div ref={pop} className="more-menu-pop" style={place} onBlur={onLeave}>
            {items}
          </div>,
          document.body,
        )}
      {open && !popover && (
        <Sheet label={label} onClose={() => close(true)}>
          <div className="more-menu-sheet">{items}</div>
        </Sheet>
      )}
    </div>
  );
}
