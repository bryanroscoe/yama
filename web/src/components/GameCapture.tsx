// End-of-game questions, shared by the table's finish sheet and Log a game. Every one is
// optional: skipping leaves it unrecorded, never a default.

import { WIN_CONDITIONS, type FunRating, type WinCondition } from "@yama/core";
import { useState } from "react";
import "./stats.css";

export interface CaptureSeat {
  seat: number;
  name: string;
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="question">
      <p>
        {title} <span className="optional">(optional)</span>
      </p>
      {children}
    </div>
  );
}

/** Pick one, or tap again to clear. */
function Chips<T extends string | number>({ options, value, onChange, label }: { options: { key: T; label: string }[]; value: T | null; onChange: (v: T | null) => void; label: string }) {
  return (
    <div className="choices" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" className="choice" aria-pressed={value === o.key} onClick={() => onChange(value === o.key ? null : o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function WinConditionPicker({ value, onChange, winner }: { value: WinCondition | null; onChange: (v: WinCondition | null) => void; winner?: string }) {
  return (
    <Question title={winner ? `How did ${winner} win?` : "How was it won?"}>
      <Chips options={WIN_CONDITIONS.map((w) => ({ key: w.key, label: w.label }))} value={value} onChange={onChange} label="Win condition" />
    </Question>
  );
}

/**
 * Who took the first turn. "Don't remember" says so out loud and leaves it unrecorded, like
 * skipping: the turn order stats only count games that know.
 */
export function FirstPlayerPicker({ seats, value, onChange }: { seats: CaptureSeat[]; value: number | null; onChange: (seat: number | null) => void }) {
  const [forgot, setForgot] = useState(false);
  const pick = (seat: number | null) => {
    setForgot(false);
    onChange(seat);
  };
  return (
    <Question title="Who went first?">
      <Chips options={seats.map((s) => ({ key: s.seat, label: s.name }))} value={forgot ? null : value} onChange={pick} label="First player" />
      <button
        type="button"
        className="choice choice-unknown"
        aria-pressed={forgot && value === null}
        onClick={() => {
          setForgot(!forgot || value !== null);
          onChange(null);
        }}
      >
        Don't remember
      </button>
    </Question>
  );
}

/** Each player's fun, 1 to 5. Tapping the chosen number again clears it. */
export function FunPicker({ seats, value, onChange }: { seats: CaptureSeat[]; value: FunRating[]; onChange: (v: FunRating[]) => void }) {
  const rating = (seat: number) => value.find((r) => r.seat === seat)?.rating ?? null;
  const set = (seat: number, n: number | null) => onChange([...value.filter((r) => r.seat !== seat), ...(n === null ? [] : [{ seat, rating: n }])]);
  return (
    <Question title="How fun was it, 1 to 5?">
      <div>
        {seats.map((s) => (
          <div key={s.seat} className="fun-row">
            <span>{s.name}</span>
            <div className="fun-scale" role="group" aria-label={`Fun for ${s.name}`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" aria-pressed={rating(s.seat) === n} aria-label={`${n} of 5`} onClick={() => set(s.seat, rating(s.seat) === n ? null : n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Question>
  );
}
