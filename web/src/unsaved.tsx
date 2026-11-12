// Unsaved work asks before it's lost (project review, 11 Nov 2026: nothing in the app warned
// before a typed list, an import or a sheet's edits were dropped). One hook for every page and
// sheet that holds typed, unsaved content:
//
//   const guard = useUnsavedChanges(dirty);
//   ...
//   <UnsavedPrompt guard={guard} />
//
// While `dirty`, leaving the page inside the app (a link, Back, a redirect) stops and asks, and
// closing or reloading the tab gets the browser's own warning. A sheet passes its close through
// `guard.close(onClose)`. After a save, call `guard.allow()` before navigating away.
//
// Several guards can be on screen at once (a sheet's over its page's): leaving asks if any of
// them holds unsaved work. The router only consults the blocker registered last, so each
// guard's blocker answers for all of them.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBlocker } from "react-router";
import { Dialog, DialogHead } from "./components/Dialog";
import { Button } from "./components/ui";

export interface UnsavedGuard {
  /** A way out is waiting for the person's answer. */
  asking: boolean;
  /** Keep editing: the navigation or close that asked is dropped. */
  stay: () => void;
  /** Leave without saving: the navigation or close that asked goes ahead. */
  leave: () => void;
  /** A sheet's close: at once when nothing is unsaved, otherwise after asking. */
  close: (close: () => void) => void;
  /** The work is saved, or dropped on purpose: what follows leaves without asking. */
  allow: () => void;
}

/** Whether leaving now would lose something: unsaved work that hasn't just been saved. */
export function losesWork({ dirty, allowed }: { dirty: boolean; allowed: boolean }): boolean {
  return dirty && !allowed;
}

/** Every guard on screen: leaving loses work if any of them would. */
export function losesAnyWork(guards: Iterable<{ dirty: boolean; allowed: boolean }>): boolean {
  for (const g of guards) if (losesWork(g)) return true;
  return false;
}

const guards = new Set<{ dirty: boolean; allowed: boolean }>();

/** The browser's "Leave site?" warning. Its wording is the browser's; a page can only ask for it. */
export function warnBeforeUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">) {
  event.preventDefault();
  // Chrome before 119 and Safari show the warning only when this is set.
  event.returnValue = "";
}

/**
 * What a sheet's close does: closes straight away with nothing unsaved; otherwise keeps the close
 * for the person's answer. Asking twice (Escape reaches every open layer) keeps the first.
 */
export function closeOrAsk<T>({ dirty, allowed, waiting }: { dirty: boolean; allowed: boolean; waiting: T | null }, close: T): { run: T | null; waiting: T | null } {
  if (!losesWork({ dirty, allowed })) return { run: close, waiting: null };
  return { run: null, waiting: waiting ?? close };
}

/**
 * `onLeave` runs when the person chooses to leave through a navigation this guard stopped: a sheet
 * passes its close, so its edits really are dropped even when the page under it stays mounted at
 * the new address.
 */
export function useUnsavedChanges(dirty: boolean, { onLeave }: { onLeave?: () => void } = {}): UnsavedGuard {
  const state = useRef({ dirty, allowed: false });
  state.current.dirty = dirty;
  // Clean again (saved, reset or cleared): the next edit is guarded afresh.
  if (!dirty) state.current.allowed = false;
  useEffect(() => {
    const own = state.current;
    guards.add(own);
    return () => void guards.delete(own);
  }, []);
  const losesNow = () => losesWork(state.current) || losesAnyWork(guards);
  /** Where focus was when the question came up, to put it back on Keep editing. */
  const focusBefore = useRef<Element | null>(null);
  const blocker = useBlocker(
    useCallback(() => {
      const stop = losesNow();
      if (stop) focusBefore.current = document.activeElement;
      return stop;
      // losesNow reads refs only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  /** A sheet's close, kept while the question is up. */
  const waiting = useRef<(() => void) | null>(null);
  const [askingClose, setAskingClose] = useState(false);

  // Saved while the question was up: nothing left to lose, so the question goes.
  useEffect(() => {
    if (blocker.state === "blocked" && !losesNow()) blocker.reset();
    // losesNow reads refs; it runs again whenever this guard's own work changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      if (losesNow()) warnBeforeUnload(e);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const settle = () => {
    waiting.current = null;
    setAskingClose(false);
  };
  return {
    asking: blocker.state === "blocked" || askingClose,
    stay: () => {
      if (blocker.state === "blocked") blocker.reset();
      settle();
      // Back to the field the person was in.
      (focusBefore.current as HTMLElement | null)?.focus?.();
      focusBefore.current = null;
    },
    leave: () => {
      const close = waiting.current;
      settle();
      if (blocker.state === "blocked") {
        blocker.proceed();
        onLeave?.();
      } else close?.();
    },
    close: (close) => {
      const next = closeOrAsk({ ...state.current, waiting: waiting.current }, close);
      if (next.waiting && !waiting.current) focusBefore.current = document.activeElement;
      waiting.current = next.waiting;
      setAskingClose(next.waiting !== null);
      next.run?.();
    },
    allow: () => {
      state.current.allowed = true;
    },
  };
}

/** Above every sheet and overlay it can be asked over (sheets are 41, the scanner 60 to 80). */
const PROMPT_LAYER = 90;

/**
 * The question itself, over whatever is open. `what` names the work in the page's own words
 * ("your changes to this list"). Escape and the scrim keep editing: the safe answer. Tab stays
 * within its two buttons (components/Dialog.tsx); Keep editing puts focus back where it was (the
 * hook's `stay`).
 */
export function UnsavedPrompt({ guard, what = "your changes" }: { guard: UnsavedGuard; what?: string }) {
  const { asking, stay } = guard;
  if (!asking) return null;
  // The shared Dialog is the top modal layer while it is up: its Escape answers this question
  // only (not the sheet underneath), and Tab stays within its two buttons.
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: PROMPT_LAYER }}>
      <Dialog label="Leave without saving?" alert centered onClose={stay}>
        <div className="stack">
          <DialogHead close={false}>Leave without saving?</DialogHead>
          <p>If you leave now, {what} will be lost.</p>
          <div className="row">
            <Button variant="primary" autoFocus onClick={stay}>Keep editing</Button>
            <Button onClick={guard.leave}>Leave without saving</Button>
          </div>
        </div>
      </Dialog>
    </div>,
    document.body,
  );
}
