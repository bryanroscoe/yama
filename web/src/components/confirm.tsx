import { useEffect, useState, type ReactNode } from "react";
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

let host: ((pending: Pending) => void) | null = null;
let next = 1;

function open(question: Question, notice: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (host) return host({ id: next++, question, notice, done: resolve });
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
  const [queue, setQueue] = useState<Pending[]>([]);
  useEffect(() => {
    host = (pending) => setQueue((q) => [...q, pending]);
    return () => {
      host = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (yes: boolean) => {
    current.done(yes);
    setQueue((q) => q.filter((p) => p.id !== current.id));
  };
  return (
    // Above every sheet and overlay a question can be asked over (sheets are 41, the scanner 60 to 80).
    <div style={{ position: "fixed", inset: 0, zIndex: QUESTION_LAYER }}>
      <ConfirmDialog key={current.id} question={current.question} notice={current.notice} onAnswer={answer} />
    </div>
  );
}

/** One question as a centered alert dialog. Most code calls `ask` instead of drawing this. */
export function ConfirmDialog({ question, notice = false, onAnswer }: { question: Question; notice?: boolean; onAnswer: (yes: boolean) => void }) {
  const { title, body, confirm, danger = false } = question;
  return (
    <Dialog label={title} alert centered className="confirm-dialog" onClose={() => onAnswer(notice)}>
      <DialogHead close={false}>{title}</DialogHead>
      {body && <p className="confirm-body">{body}</p>}
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
