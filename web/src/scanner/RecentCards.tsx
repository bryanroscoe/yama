// "Recent", at the bottom of the scanner's sheet (Bryan, 15 Nov 2026: show what each card is
// worth). The last card filed in full (name, set and number, finish, price and its date), the few
// before it smaller, and the session's total of known prices, saying how many had none.

import { cardLine, priceDateLine, sessionTotal, totalLine, type RecentCard } from "./price";

/** Older cards shown under the last one. */
const OLDER = 4;

export function RecentCards({ cards }: { cards: readonly RecentCard[] }) {
  const [last, ...older] = cards;
  if (!last) return null;
  const when = priceDateLine(last);
  const total = totalLine(sessionTotal(cards));
  return (
    <section className="scan-recent" aria-label="Recently added">
      <p className="scan-recent-last">
        <span className="dim">Last added: </span>
        <strong>{cardLine(last)}</strong>
        {when && <span className="dim">, {when}</span>}
      </p>
      {older.length > 0 && (
        <ul className="scan-recent-older">
          {older.slice(0, OLDER).map((c) => {
            // Every price shown says where it's from and when (AGENTS.md, prices).
            const at = priceDateLine(c);
            return (
              <li key={c.key}>
                {cardLine(c)}
                {at && <span className="dim">, {at}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {total && <p className="scan-note">{total}.</p>}
    </section>
  );
}
