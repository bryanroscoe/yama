import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";
import { Dialog, DialogHead } from "./Dialog";

// The app's own "are you sure?" and "this went wrong", in place of the browser's confirm() and
// alert(): the same look as every other dialog, a button that says what it does, and no
// browser chrome naming the site. `ask` and `tell` can be called from anywhere (a click
// handler, a mutation, a plain module); <ConfirmHost />, mounted once at the root, draws them.

export interface Question {
  /** The question, or what happened: one short sentence. */
  title: string;
  /** The consequence, in one short line (design/tokens.md, rule 5). */
  body?: ReactNode;
  /** What the confirming button does, as a verb: "Delete run". */
  confirm: string;
  /** A destructive action: the button is --bad, and Cancel takes focus first. */
  danger?: boolean;
}

interface Pending {
  id: number;
  question: Question;
  /** No Cancel: something to read and dismiss. */
  notice: boolean;
  done: (answer: boolean) => void;
}

/** With the unsaved-work question (web/src/unsaved.tsx), the top of the page's layers. */
const QUESTION_LAYER = 90;

// The questions waiting for an answer live here, not in the host's state, so they outlast a host
// that re-mounts (StrictMode runs its effect twice) and are settled if it goes away for good.
let queue: Pending[] = [];
let hosts = 0;
let next = 1;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function settle(pending: Pending, answer: boolean): void {
  queue = queue.filter((p) => p !== pending);
  pending.done(answer);
  changed();
}

function open(question: Question, notice: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (hosts > 0) {
      queue = [...queue, { id: next++, question, notice, done: resolve }];
      return changed();
    }
    // Nothing is mounted to draw it (a page outside the app shell): the browser's own.
    if (typeof window === "undefined") return resolve(false);
    const text = typeof question.body === "string" ? `${question.title} ${question.body}` : question.title;
    if (notice) {
      window.alert(text);
      resolve(true);
    } else resolve(window.confirm(text));
  });
}

/** Asks before doing something that can't be undone. Resolves true for the confirming button, false for Cancel, Escape or the scrim. */
export const ask = (question: Question): Promise<boolean> => open(question, false);

/** Says something the person has to see (an export that failed). Resolves when they dismiss it. */
export const tell = (notice: { title: string; body?: ReactNode }): Promise<void> => open({ ...notice, confirm: "OK" }, true).then(() => undefined);

/** Draws the questions `ask` and `tell` raise, one at a time. Mount it once, at the root. */
export function ConfirmHost() {
  const waiting = useSyncExternalStore(subscribe, () => queue, () => queue);
  useEffect(() => {
    hosts += 1;
    // Back (the browser's, or Android's) leaves the page a question was about: it is answered no
    // rather than left over the next page, where yes would still act on the old one.
    const left = () => {
      for (const p of queue) settle(p, p.notice);
    };
    window.addEventListener("popstate", left);
    return () => {
      window.removeEventListener("popstate", left);
      hosts -= 1;
      // Gone for good (not StrictMode's replay, which mounts again at once): nobody can answer
      // what is still waiting, so it is answered no, and a notice counts as read.
      queueMicrotask(() => {
        if (hosts === 0) for (const p of queue) settle(p, p.notice);
      });
    };
  }, []);
  const current = waiting[0];
  if (!current) return null;
  return (
    // Above every sheet and overlay a question can be asked over (sheets are 41, the scanner 60 to 80).
    <div style={{ position: "fixed", inset: 0, zIndex: QUESTION_LAYER }}>
      <ConfirmDialog key={current.id} question={current.question} notice={current.notice} onAnswer={(yes) => settle(current, yes)} />
    </div>
  );
}

/** One question as a centered alert dialog. Most code calls `ask` instead of drawing this. */
export function ConfirmDialog({ question, notice = false, onAnswer }: { question: Question; notice?: boolean; onAnswer: (yes: boolean) => void }) {
  const { title, body, confirm, danger = false } = question;
  const about = useId();
  return (
    // The consequence is read out with the question, as the browser's own box read it.
    <Dialog label={title} alert centered className="confirm-dialog" describedBy={body ? about : undefined} onClose={() => onAnswer(notice)}>
      <DialogHead close={false}>{title}</DialogHead>
      {body && <p id={about}>{body}</p>}
      <div className="dialog-actions">
        {!notice && (
          // The safe answer takes focus first when the other one destroys something.
          <button type="button" className="outline" autoFocus={danger} onClick={() => onAnswer(false)}>
            Cancel
          </button>
        )}
        <button type="button" className={danger ? "danger" : "primary"} autoFocus={!danger} onClick={() => onAnswer(true)}>
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}
