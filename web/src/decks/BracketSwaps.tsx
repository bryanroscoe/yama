// "Play it at" a lower bracket (deck page SPEC 0b and section 1): the List picker offers the list in
// the box at each bracket the plan has a swap bag for. Picking one shows the swaps as pairs (the
// card going in, then the card it replaces), Print swap cards, and marks the cards going out in
// the list. Nothing is saved: the box keeps its list.
import type { Bag, Bracket } from "@yama/core/plan";
import { Link } from "react-router";
import { SwapPair } from "../plan/parts";
import "../plan/plans.css";

/** The brackets the plan has a bag for, highest first, each with its swaps from the box (bags are cumulative). */
export function bracketSwaps(bracket: Bracket | null | undefined): { bracket: number; swaps: Bag[] }[] {
  const keys = Object.keys(bracket?.bags ?? {})
    .map(Number)
    .filter((k) => Number.isInteger(k) && k >= 1 && k <= 5 && k < (bracket?.box ?? bracket?.target ?? 4))
    .sort((a, b) => b - a);
  const out: { bracket: number; swaps: Bag[] }[] = [];
  let so: Bag[] = [];
  for (const k of keys) {
    const own = bracket!.bags![String(k)] ?? [];
    so = [...so, ...own];
    // An empty bag adds no step: that bracket would be the one above under another name.
    if (own.length) out.push({ bracket: k, swaps: so });
  }
  return out;
}

/** The bracket the box is kept at: the plan's own box bracket, else its target. */
export function boxBracket(bracket: Bracket | null | undefined): number | null {
  return bracket?.box ?? bracket?.target ?? null;
}

export function SwapPanel({
  at,
  swaps,
  view,
  printHref,
  backHref,
}: {
  at: number;
  swaps: Bag[];
  view: Parameters<typeof SwapPair>[0]["view"];
  printHref: string;
  backHref: string;
}) {
  return (
    <section className="deck-swap-panel" aria-labelledby="deck-swap-head">
      <div className="deck-swap-head">
        <h2 id="deck-swap-head">
          For Bracket {at}, swap {swaps.length} {swaps.length === 1 ? "card" : "cards"}
        </h2>
        <span className="deck-swap-actions">
          <Link className="button" to={printHref}>Print swap cards</Link>
          <Link className="button quiet" to={backHref}>Back to the box</Link>
        </span>
      </div>
      <ul className="deck-swap-pairs">
        {swaps.map((s) => (
          <li key={`${s.in}>${s.out}`}>
            <SwapPair cardIn={s.in} cardOut={s.out} view={view} />
            <span className="deck-swap-text">
              <b>{s.in}</b>
              <span>replaces {s.out}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
