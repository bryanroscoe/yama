// Simulation confidence on the page: whether the simulator can judge a deck at all, from
// commander-decks' analysis (each rating's `confidence`). "sim unreliable" (--bad, used sparingly)
// means real games disagree strongly or a known engine gap breaks the deck's plan, so its numbers
// say little; "sim doubtful" (--warn) is a lesser warning. Decks with no known problem get nothing.

import { useState, type ReactNode } from "react";
import { Details, Sheet } from "../components/ui";
import type { Confidence, ConfidenceLevel } from "./api";
import { confidenceMark, confidenceSentence, sentence } from "./logic";
import "./lab.css";

/**
 * The marker beside a deck's name. Its reasons show on hover (laptops) and in a sheet on a tap
 * (phones, keyboards), with the run's method folded under Details. Nothing for "ok".
 */
export function ConfidenceMark({ confidence, name, method }: { confidence: Confidence | null | undefined; name: string; method?: string | null }) {
  const [open, setOpen] = useState(false);
  const mark = confidenceMark(confidence);
  if (!confidence || !mark) return null;
  return (
    <>
      <button
        type="button"
        className={`conf-mark ${confidence.level}`}
        title={confidence.reasons.length ? confidence.reasons.map(sentence).join("\n") : undefined}
        aria-haspopup="dialog"
        aria-label={`${sentence(mark)}: why, for ${name}`}
        onClick={() => setOpen(true)}
      >
        {mark}
      </button>
      {open && (
        <Sheet label={`${sentence(mark)}: ${name}`} onClose={() => setOpen(false)}>
          <div className="stack conf-sheet">
            <div className="sheet-head">
              <h2>{sentence(mark)}</h2>
              <button className="quiet" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <p className="conf-sheet-deck">{name}</p>
            <p>{confidenceSentence(confidence.level)}</p>
            <Reasons reasons={confidence.reasons} />
            <p className="lab-note">
              {confidence.level === "unreliable" ? "Real games are the better guide for this deck. " : ""}
              The simulation plays AI against AI, and some decks need plays its AI doesn't make.
            </p>
            {method && (
              <Details label="How it's decided">
                <p>{method}</p>
              </Details>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <>
      <h3 className="conf-why">Why</h3>
      <ul className="conf-reasons">
        {reasons.map((r) => (
          <li key={r}>{sentence(r)}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * One line beside a verdict or a result: the marker (tap it for the reasons), then the plain
 * sentence about that verdict or run. Nothing for "ok".
 */
export function ConfidenceLine({
  confidence,
  name,
  about = "verdict",
  method,
  children,
}: {
  confidence: Confidence | null | undefined;
  name: string;
  about?: "numbers" | "verdict" | "run";
  method?: string | null;
  /** Replaces the plain sentence. */
  children?: ReactNode;
}) {
  if (!confidence || confidence.level === "ok") return null;
  return (
    <p className={`conf-line ${confidence.level}`}>
      <ConfidenceMark confidence={confidence} name={name} method={method} /> <span>{children ?? confidenceSentence(confidence.level, about)}</span>
    </p>
  );
}

/**
 * A note above simulated numbers for a deck the simulator can't judge (or may misjudge): the
 * plain sentence, then the reasons (folded under "Why" with `fold`), then anything else.
 */
export function ConfidenceNote({
  level,
  lead,
  reasons,
  fold = false,
  children,
}: {
  level: ConfidenceLevel;
  /** The sentence to lead with; defaults to the one about "these numbers". */
  lead?: ReactNode;
  reasons: string[];
  fold?: boolean;
  children?: ReactNode;
}) {
  if (level === "ok") return null;
  return (
    <div className={`conf-note ${level}`} role="note">
      <p className="conf-note-lead">
        <span className={`conf-mark ${level}`}>sim {level}</span> <b>{lead ?? confidenceSentence(level)}</b>
      </p>
      {reasons.length > 0 &&
        (fold ? (
          <Details label="Why">
            <ul className="conf-reasons">
              {reasons.map((r) => (
                <li key={r}>{sentence(r)}</li>
              ))}
            </ul>
          </Details>
        ) : (
          <ul className="conf-reasons">
            {reasons.map((r) => (
              <li key={r}>{sentence(r)}</li>
            ))}
          </ul>
        ))}
      {children}
    </div>
  );
}
