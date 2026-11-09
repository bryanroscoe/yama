// One small "?" per section (design/tokens.md, "No micro copy"): the explanation a heading would
// otherwise carry as hint lines opens in a popover beside it. Escape, a press outside or the
// button again closes it; focus goes back to the button.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./helpPopover.css";

export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // Kept on screen: a "?" far to the right moves its popover left until it fits.
  useLayoutEffect(() => {
    if (!open || !body.current) {
      setShift(0);
      return;
    }
    const over = body.current.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
    setShift(over > 0 ? over : 0);
  }, [open]);
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
      <button ref={button} type="button" className="help-pop-button" aria-label={`Help: ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <div id={id} ref={body} role="note" className="help-pop-body" style={shift ? { transform: `translateX(${-shift}px)` } : undefined}>
          {children}
        </div>
      )}
    </span>
  );
}
