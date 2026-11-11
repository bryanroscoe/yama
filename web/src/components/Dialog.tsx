import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Button } from "./Button";

// One modal layer for the whole app: Dialog, and anything else that covers the page (the full
// screen picker, the card zoom) through useModalLayer. A layer:
//   - moves focus in when it opens and back to what opened it when it closes;
//   - keeps Tab inside it and makes everything else on the page inert;
//   - stops the page scrolling under it;
//   - answers Escape only when it is the top layer, after anything open inside it (a menu, a
//     card preview) has had its turn.

/** Open layers, bottom to top. */
const layers: HTMLElement[] = [];
let lockedOverflow: string | null = null;
let lockedPadding = "";
/** What the open layers made inert. Anything inert for its own reasons isn't here, and is left alone. */
let madeInert: HTMLElement[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** The controls Tab can land on. Where the browser can say (not in jsdom), what CSS hides is left out: focusing it would do nothing and strand Tab. */
function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.closest("[inert], [hidden]") &&
      // Inside a closed disclosure only its summary can take focus.
      (el.tagName === "SUMMARY" || !el.closest("details:not([open])")) &&
      (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true })),
  );
}

/** Whether `b` comes after `a` in the page, and isn't inside it. */
function follows(a: Node, b: Node | null): boolean {
  return !!b && (a.compareDocumentPosition(b) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) === Node.DOCUMENT_POSITION_FOLLOWING;
}

/** Everything outside `layer`: the siblings of it and of each of its ancestors, up to the body. */
function outside(layer: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node: HTMLElement = layer; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling !== node && sibling instanceof HTMLElement) found.push(sibling);
    }
  }
  return found;
}

/**
 * Only the top layer, and what holds it, stay reachable: Tab, a switch control or a screen reader
 * can't get to the page or to a layer underneath (aria-modal alone doesn't keep focus in). Worked
 * out afresh whenever a layer opens or closes, so layers can be siblings and close in any order.
 */
function syncInert(): void {
  for (const el of madeInert) el.inert = false;
  madeInert = [];
  const top = layers[layers.length - 1];
  if (!top) return;
  for (const el of outside(top)) {
    if (el.inert) continue;
    el.inert = true;
    madeInert.push(el);
  }
}

// Where focus goes back to for a layer opened from inside an element that will be gone when the
// layer closes: a menu's items go when one is chosen, so the menu's own button stands in.
const returnsTo = new WeakMap<Element, HTMLElement>();

/** A layer opened from inside `from` returns focus to `to` when it closes. */
export function returnFocusTo(from: Element, to: HTMLElement): void {
  returnsTo.set(from, to);
}

/**
 * What a layer opening now gives focus back to: what has it, or its stand-in. The search for a
 * stand-in stops at the nearest open layer: a control in a dialog that itself sits inside a
 * menu's items stays put when the layer it opened closes, so focus goes back to that control.
 */
function openerOf(active: Element | null): Element | null {
  for (let el = active; el; el = el.parentElement) {
    const to = returnsTo.get(el);
    if (to) return to;
    if (layers.includes(el as HTMLElement)) break;
  }
  return active;
}

/**
 * Makes `root` a modal layer while it is mounted. `focusFirst` is what takes focus on opening
 * (a heading, so no keyboard comes up on a phone) unless a field inside asked for it with
 * autoFocus; without it the layer itself takes focus. Spread what it returns on the layer's
 * root element: its Escape handler runs after the handlers of anything inside the layer.
 */
export function useModalLayer(root: RefObject<HTMLElement | null>, onClose: () => void, focusFirst?: RefObject<HTMLElement | null>): { onKeyDown: (e: ReactKeyboardEvent) => void } {
  const close = useRef(onClose);
  close.current = onClose;
  // Read while rendering: by the time effects run, an autoFocus field inside has taken focus.
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document === "undefined" ? null : openerOf(document.activeElement);

  useEffect(() => {
    const layer = root.current;
    if (!layer) return;
    // A layer drawn inside another sits above it, whichever of the two set itself up first.
    const under = layers.findIndex((other) => layer.contains(other));
    if (under < 0) layers.push(layer);
    else layers.splice(under, 0, layer);
    const top = () => layers[layers.length - 1] === layer;

    syncInert();

    // The page under it stays put.
    if (lockedOverflow === null) {
      // Where the scrollbar takes room (Windows, or macOS set to always show it), hiding it would
      // shift the page sideways under the scrim: pad the body by its width while locked.
      const bar = window.innerWidth - document.documentElement.clientWidth;
      lockedPadding = document.body.style.paddingRight;
      if (bar > 0) document.body.style.paddingRight = `calc(${getComputedStyle(document.body).paddingRight || "0px"} + ${bar}px)`;
      lockedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    if (!layer.contains(document.activeElement)) (focusFirst?.current ?? layer).focus({ preventScroll: true });

    const shut = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    const onWindowKey = (e: KeyboardEvent) => {
      if (!top()) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || active === document.documentElement;
      // Focus fell out of the layer (what held it went away): Escape still closes it.
      if (e.key === "Escape" && lost && !e.defaultPrevented) return shut(e);
      if (e.key !== "Tab") return;
      // Focus in something drawn over the layer from outside it (a floating menu): leave Tab to it.
      if (!lost && active && !layer.contains(active)) return;
      const stops = focusable(layer);
      const first = stops[0];
      const last = stops[stops.length - 1];
      const go = (to: HTMLElement) => {
        e.preventDefault();
        to.focus();
      };
      if (!first || !last) go(layer);
      // Focus fell out, or sits on the layer itself: Tab enters the controls.
      else if (lost || active === layer) go(e.shiftKey ? last : first);
      // From the last control round to the first, and back the other way. The heading takes
      // focus on opening but isn't a stop: Shift+Tab from it (before the first) goes to the last.
      else if (e.shiftKey && (active === first || !follows(first, active))) go(last);
      else if (!e.shiftKey && (active === last || follows(last, active))) go(first);
    };
    window.addEventListener("keydown", onWindowKey, true);

    return () => {
      window.removeEventListener("keydown", onWindowKey, true);
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      syncInert();
      if (layers.length === 0 && lockedOverflow !== null) {
        document.body.style.overflow = lockedOverflow;
        document.body.style.paddingRight = lockedPadding;
        lockedOverflow = null;
      }
      // Back to what opened it, unless focus has already gone somewhere on purpose.
      const active = document.activeElement;
      const from = opener.current;
      if (from instanceof HTMLElement && from.isConnected && (!active || active === document.body || layer.contains(active))) from.focus({ preventScroll: true });
    };
    // The layer is set up once, for as long as it is mounted.
  }, []);

  return {
    // Escape from inside the layer reaches it after a menu, a preview or a search box inside
    // has had its turn (they mark it handled), and goes no further: not to a layer under this
    // one, nor to the page's own shortcuts.
    onKeyDown(e) {
      if (e.key !== "Escape" || e.defaultPrevented || layers[layers.length - 1] !== root.current) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    },
  };
}

/** How many modal layers are open (for tests). */
export const openLayers = () => layers.length;

/** The enclosing Dialog's onClose, for a DialogHead drawn by the dialog's content. */
const DialogClose = createContext<(() => void) | null>(null);

/**
 * A dialog's first line: its heading, and Close at the end of the row. Dialog draws one itself
 * when given a `title`; content that changes its own heading (an editor with steps inside one
 * dialog) draws this instead. Close closes the dialog unless `onClose` says where it goes
 * (back a step); `close={false}` leaves the button out for a question with its own answers.
 */
export function DialogHead({ children, onClose, close = true, id, headingRef }: { children: ReactNode; onClose?: () => void; close?: boolean; id?: string; headingRef?: Ref<HTMLHeadingElement> }) {
  const closeDialog = useContext(DialogClose);
  const shut = onClose ?? closeDialog;
  return (
    <div className="sheet-head dialog-head">
      <h2 id={id} ref={headingRef} tabIndex={-1}>
        {children}
      </h2>
      {close && shut && (
        <Button variant="quiet" className="dialog-close" onClick={shut}>
          Close
        </Button>
      )}
    </div>
  );
}

/**
 * The app's dialog: a drawer from the bottom on phones and laptops alike, or with `centered` a
 * short question in the middle of the screen, where everyone round a table phone can see it.
 *
 * Give it a `title` and it draws the heading with a Close button beside it; the heading names
 * the dialog. A dialog that draws its own first line (art across the top, a question with its
 * own buttons) passes `label` instead. Escape, the scrim and Close all call `onClose`.
 */
export function Dialog({
  title,
  label,
  onClose,
  children,
  centered = false,
  className,
  alert = false,
  describedBy,
}: (
  | {
      /** The visible heading, with Close beside it. It names the dialog, unless `label` does. */
      title: ReactNode;
      /** The name when the heading isn't plain words (a card preview button), or says less than the name should. */
      label?: string;
    }
  | {
      title?: undefined;
      /** The dialog's name when it draws its own first line. A dialog always has a name. */
      label: string;
    }
) & {
  onClose: () => void;
  children: ReactNode;
  centered?: boolean;
  className?: string;
  /** A question that interrupts (a confirmation): announced at once as an alert dialog. */
  alert?: boolean;
  /** The id of the sentence that says what the dialog is about, read out after its name. */
  describedBy?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(root, onClose, title != null ? heading : panel);
  const titled = title != null && !label;
  return (
    <div className="dialog-layer" ref={root} {...layer}>
      <div className="scrim" onClick={onClose} />
      <div
        ref={panel}
        className={["sheet", centered && "sheet-centered", className].filter(Boolean).join(" ")}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={titled ? `${id}-title` : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <DialogClose.Provider value={onClose}>
          {title != null && (
            <DialogHead id={`${id}-title`} headingRef={heading}>
              {title}
            </DialogHead>
          )}
          {children}
        </DialogClose.Provider>
      </div>
    </div>
  );
}
