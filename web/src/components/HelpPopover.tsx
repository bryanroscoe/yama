// One small "?" per section (design/tokens.md, "No micro copy"): the explanation a heading would
// otherwise carry as hint lines opens in a popover beside it. Escape, a press outside or the
// button again closes it; focus goes back to the button.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./helpPopover.css";

/** The popover's edge sits this far left of its button, and keeps this margin from the screen's edge. */
const LEAD = 8;
const MARGIN = 16;

/**
 * The popover's width, and where its left edge goes relative to its button, so it stays on screen:
 * a "?" far to the right moves its popover left until it fits. Worked out from the button before
 * the popover is drawn: on a phone, a popover laid out past the screen's edge even for a moment
 * widens the page for good (the Cards help made a 390 px screen 474 px wide), so it's never laid
 * out there. `page` is the page's width without a scrollbar (the root's clientWidth); the width
 * is set from it too, since the stylesheet's `100vw` counts a scrollbar the page doesn't have
 * room behind.
 */
export function popoverPlace(buttonLeft: number, page: number): { left: number; width: number } {
  const width = Math.min(380, page - 2 * MARGIN);
  const over = buttonLeft - LEAD + width - (page - MARGIN);
  return { left: -LEAD - Math.max(0, over), width };
}

export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; width?: number }>({ left: -LEAD });
  const toggle = () => {
    if (!open && button.current) setPlace(popoverPlace(button.current.getBoundingClientRect().left, document.documentElement.clientWidth));
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <span className="help-pop" ref={root}>
      <button ref={button} type="button" className="help-pop-button" aria-label={`Help: ${label}`} aria-expanded={open} aria-controls={id} onClick={toggle}>
        ?
      </button>
      {open && (
        <div id={id} role="note" className="help-pop-body" style={place}>
          {children}
        </div>
      )}
    </span>
  );
}
