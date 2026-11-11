// End-of-game questions, shared by the table's finish sheet and Log a game. Every one is
// optional: skipping leaves it unrecorded, never a default.

import { NOTE_MAX, WIN_CONDITIONS, type FunRating, type WinCondition } from "@yama/core";
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

/** One player's knockout as a form holds it: when (if anyone remembers) and who did it. */
export interface KnockoutAnswer {
  seat: number;
  /** The turn they went out on, or null if nobody remembers. */
  turn: number | null;
  /** The seat that knocked them out, or null if nobody said. */
  by: number | null;
}

/**
 * Who was knocked out, on which turn and by whom, for a game logged afterwards (the table asks
 * as it happens). Tick a player to say they went out; the turn and who did it are each optional,
 * and feed first out, last out and rivalries only when given.
 */
export function KnockoutPicker({ seats, winner, value, onChange }: { seats: CaptureSeat[]; winner: number | null; value: KnockoutAnswer[]; onChange: (v: KnockoutAnswer[]) => void }) {
  const losers = seats.filter((s) => s.seat !== winner);
  if (losers.length === 0) return null;
  const of = (seat: number) => value.find((k) => k.seat === seat);
  const set = (seat: number, next: KnockoutAnswer | null) => onChange([...value.filter((k) => k.seat !== seat), ...(next ? [next] : [])]);
  return (
    <Question title="Who was knocked out?">
      <div>
        {losers.map((s) => {
          const k = of(s.seat);
          return (
            <div key={s.seat} className="knock-row">
              <label className="check-row">
                <input type="checkbox" checked={!!k} onChange={(e) => set(s.seat, e.target.checked ? { seat: s.seat, turn: null, by: null } : null)} />
                {s.name}
              </label>
              {k && (
                <div className="knock-fields">
                  <label>
                    On turn
                    <input
                      inputMode="numeric"
                      maxLength={4}
                      value={k.turn ?? ""}
                      aria-label={`Turn ${s.name} went out on`}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, "");
                        set(s.seat, { ...k, turn: digits ? Number(digits) : null });
                      }}
                    />
                  </label>
                  <label>
                    By
                    <select value={k.by ?? ""} aria-label={`Who knocked ${s.name} out`} onChange={(e) => set(s.seat, { ...k, by: e.target.value === "" ? null : Number(e.target.value) })}>
                      <option value="">Don't remember</option>
                      {seats.filter((o) => o.seat !== s.seat).map((o) => <option key={o.seat} value={o.seat}>{o.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Question>
  );
}

/** Anything to remember about the game. Kept with it, shown on its page and in exports. */
export function NotePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Question title="Notes">
      <textarea
        className="capture-note"
        rows={2}
        maxLength={NOTE_MAX}
        value={value}
        aria-label="Notes about this game"
        placeholder="A new deck's first game, a rule you looked up, who left early…"
        onChange={(e) => onChange(e.target.value)}
      />
    </Question>
  );
}
