// "What just happened": a timeline of everything since your last turn that you can step back
// through, one happening at a time, with the cards involved (readable, like any card on the
// board) and, for an attack, a block or damage, its arrows drawn again on the board behind
// (CombatCues' pinned cue). It sits beside the board rather than over it, and the live game goes on
// underneath. Rewind, where the game allows it, is one button away. The plan for a fuller replay
// that rebuilds earlier boards is docs/plans/play-replay.md.

import { useEffect, useRef, useState } from "react";
import { SymbolText } from "../components/ManaSymbols";
import { Button } from "../components/ui";
import type { Names } from "./feed";
import { happeningCards, reviewSteps } from "./review";
import type { CardMeta, Happening } from "./types";

export function WhatHappened({ events, names, meta, at, onStep, onRead, onClose, rewind }: {
  events: Happening[];
  names: Names;
  meta: Record<string, CardMeta>;
  /** The happening to open at (a callout's); the newest when left out. */
  at?: number | null;
  /** The step being looked at, for its arrows on the board. */
  onStep: (h: Happening | null) => void;
  onRead: (name: string, id?: number) => void;
  onClose: () => void;
  /** Rewind or Go back, when this game has one now. */
  rewind?: { label: string; run: () => void; disabled: boolean } | null;
}) {
  const steps = reviewSteps(events, names);
  // The step looked at, by its happening's number, so new happenings arriving meanwhile don't move
  // it; `null` follows the newest.
  const [seq, setSeq] = useState<number | null>(() => (at == null ? null : steps.find((s) => s.h.seq >= at)?.h.seq ?? null));
  const found = seq === null ? -1 : steps.findIndex((s) => s.h.seq === seq);
  const i = found >= 0 ? found : steps.length - 1;
  const step = steps[i];
  const setI = (f: (k: number) => number) => setSeq(steps[Math.max(0, Math.min(steps.length - 1, f(i)))]?.h.seq ?? null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    onStep(step?.h ?? null);
    list.current?.querySelector<HTMLElement>("[aria-current='step']")?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.h.seq]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Not while typing, in a dialog (the card reader opened from here closes on its own Escape)
      // or with a modifier; and the board's own keys don't also act on it.
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (t?.closest("input, textarea, select, [contenteditable], .sheet, [role=dialog]") || document.querySelector("[role=dialog]")) return;
      if (e.key !== "Escape" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setI((k) => k - 1);
      else if (e.key === "ArrowRight") setI((k) => k + 1);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const cards = step ? happeningCards(step.h).filter((c) => c.name && meta[c.name]?.image) : [];
  return (
    <aside className="wh" aria-label="What just happened">
      <header className="wh-top">
        <h2>What just happened</h2>
        <Button variant="quiet" size="small" onClick={onClose}>Close</Button>
      </header>
      {!step ? (
        <p className="dim">Nothing yet since your last turn.</p>
      ) : (
        <>
          <p className="wh-head dim">{step.head}</p>
          <p className="wh-text" role="status" aria-live="polite"><SymbolText text={step.text} /></p>
          {cards.length > 0 && (
            <div className="wh-cards">
              {cards.slice(0, 3).map((c) => (
                <Button key={`${c.name}-${c.id ?? ""}`} className="wh-card" onClick={() => onRead(c.name!, c.id)} aria-label={`Read ${c.name}`}>
                  <img src={meta[c.name!]!.image!} alt={c.name} />
                </Button>
              ))}
            </div>
          )}
          <div className="wh-nav">
            <Button variant="outline" size="small" disabled={i <= 0} onClick={() => setI((k) => k - 1)}>Earlier</Button>
            <span className="dim small num">{i + 1} of {steps.length}</span>
            <Button variant="outline" size="small" disabled={i >= steps.length - 1} onClick={() => setI((k) => k + 1)}>Later</Button>
          </div>
          <ol className="wh-list" ref={list}>
            {steps.map((s, k) => (
              <li key={s.h.seq}>
                <Button aria-current={k === i ? "step" : undefined} onClick={() => setSeq(s.h.seq)}>
                  {(k === 0 || steps[k - 1]!.head !== s.head) && <span className="wh-list-head">{s.head}</span>}
                  <SymbolText text={s.text} />
                </Button>
              </li>
            ))}
          </ol>
        </>
      )}
      {rewind && (
        <p className="wh-rewind small dim">
          Want it back?{" "}
          <Button className="link" disabled={rewind.disabled} onClick={rewind.run}>{rewind.label}</Button>
        </p>
      )}
    </aside>
  );
}
