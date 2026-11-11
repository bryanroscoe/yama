// Dice, a coin and a random player, from the table menu. Nothing here goes in the game's log:
// "Roll for first" in the menu is the one roll that's recorded.

import type { PlayerState } from "@yama/core";
import { useState } from "react";
import { Segmented, DialogHead } from "../components/ui";

const DICE = [4, 6, 8, 10, 12, 20] as const;

/** A fair whole number from 1 to `n`, from the browser's random source. */
export function roll(n: number, random: (max: number) => number = cryptoBelow): number {
  return random(n) + 1;
}

/** 0 to max - 1 with no modulo bias: draws again above the largest multiple of max. */
function cryptoBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const r = new Uint32Array(1);
  do crypto.getRandomValues(r);
  while (r[0]! >= limit);
  return r[0]! % max;
}

type Result = { title: string; value: string; detail?: string; n: number };

export function DiceSheet({ players, onDone }: { players: PlayerState[]; onDone: () => void }) {
  const [result, setResultState] = useState<Result | null>(null);
  // Each roll gets its own number, so the same value rolled twice still replays the pop.
  const setResult = (r: Omit<Result, "n">) => setResultState((old) => ({ ...r, n: (old?.n ?? 0) + 1 }));
  const [count, setCount] = useState(1);
  const [sides, setSides] = useState("100");
  const alive = players.filter((p) => !p.eliminated);
  const dice = (n: number) => {
    const rolls = Array.from({ length: count }, () => roll(n));
    const total = rolls.reduce((a, b) => a + b, 0);
    setResult({ title: `${count > 1 ? count : ""}d${n}`, value: String(total), detail: count > 1 ? rolls.join(" + ") : undefined });
  };
  const custom = Number.parseInt(sides, 10);
  return (
    <div className="stack dice-sheet">
      <DialogHead onClose={onDone}>Dice and coin</DialogHead>
      <div className="dice-result" role="status" aria-live="polite">
        {result ? (
          <>
            <span className="dice-title">{result.title}</span>
            <span key={result.n} className="dice-value art-big num">{result.value}</span>
            {result.detail && <span className="small dim">{result.detail}</span>}
          </>
        ) : (
          <span className="dim">Pick a die</span>
        )}
      </div>
      <div className="dice-grid">
        {DICE.map((n) => (
          <button key={n} onClick={() => dice(n)} aria-label={`Roll ${count > 1 ? `${count} ` : "a "}d${n}`}>d{n}</button>
        ))}
      </div>
      <Segmented as="span" label="How many dice" value={count} onChange={setCount} options={[1, 2, 3].map((c) => [c, `${c} ${c === 1 ? "die" : "dice"}`] as const)} />
      <div className="row dice-row">
        <label className="dice-custom">
          <span aria-hidden="true">d</span>
          <input aria-label="Sides on a custom die" inputMode="numeric" value={sides} onChange={(e) => setSides(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </label>
        <button disabled={!(custom >= 2)} onClick={() => dice(custom)}>Roll</button>
      </div>
      <div className="row">
        <button onClick={() => setResult({ title: "Coin", value: roll(2) === 1 ? "Heads" : "Tails" })}>Flip a coin</button>
        {alive.length > 1 && (
          <button onClick={() => setResult({ title: "Random player", value: alive[roll(alive.length) - 1]!.name })}>Pick a random player</button>
        )}
      </div>
    </div>
  );
}
