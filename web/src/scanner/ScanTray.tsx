// The strip of cards scanned this session (Bryan, 16 Nov 2026: "It's kind of hard to see what card
// you just scanned … I kind of like how Mythic Tools does it. It keeps it out of the scrollable
// thing at the bottom"). Between the camera and the sheet, never scrolled away: each card's
// picture with its price in the finish filed, newest first and largest, a tag for a card that
// sees play in Commander (playable.ts), and the session's total. Tapping a card opens it large,
// to check the printing and fix it (the host's ScannedCard dialog).

import { shortDate, usd } from "@yama/core";
import { Button, CardThumb } from "../components/ui";
import { PLAY_WORD, playTag, usePlayability } from "./playable";
import { priceFor, sessionTotal, worthIt, type RecentCard } from "./price";

const FINISH_SHORT = { nonfoil: null, foil: "Foil", etched: "Etched", proxy: "Proxy" } as const;

/** What a screen reader hears for a tile: the card, its printing, finish, price and state. */
export function tileLabel(c: RecentCard, tag: string | null): string {
  const parts = [c.name];
  if (c.set) parts.push(`${c.set.toUpperCase()}${c.number ? ` ${c.number}` : ""}`);
  if (c.finish !== "nonfoil") parts.push(FINISH_SHORT[c.finish]!);
  if (c.finish !== "proxy") {
    const p = priceFor(c.prices, c.finish);
    parts.push(p == null ? "price unknown" : usd(p));
  }
  if (c.copies > 1) parts.push(`${c.copies} copies`);
  if (tag) parts.push(tag);
  if (c.state === "saving") parts.push("saving");
  if (c.state === "failed") parts.push("not saved");
  return parts.join(", ");
}

/**
 * The strip's total: "12 cards, $41.20", then "market, Nov 14, 2 unpriced": the latest price
 * date among them, and how many had no price (left out, never counted as $0).
 */
export function trayTotal(cards: readonly RecentCard[]): { head: string; note: string | null } {
  const t = sessionTotal(cards);
  const copies = cards.reduce((n, c) => n + c.copies, 0);
  const count = `${copies} ${copies === 1 ? "card" : "cards"}`;
  if (t.priced === 0) return { head: count, note: t.missing ? "no prices" : null };
  const dates = cards.flatMap((c) => (priceFor(c.prices, c.finish) != null && c.prices?.date ? [c.prices.date] : [])).sort();
  const when = shortDate(dates.at(-1) ?? null);
  return { head: `${count}, ${usd(t.total)}`, note: `market${when ? `, ${when}` : ""}${t.missing ? `, ${t.missing} unpriced` : ""}` };
}

export function ScanTray({ cards, worth, onOpen, onReview }: { cards: readonly RecentCard[]; worth: number; onOpen?: (key: string) => void; onReview?: () => void }) {
  const play = usePlayability(cards.map((c) => c.oracleId));
  if (cards.length === 0) return null;
  const failed = cards.filter((c) => c.state === "failed").length;
  const total = trayTotal(cards);
  return (
    <section className="scan-tray" aria-label="Scanned this session">
      <div className="scan-tray-head">
        <span className="scan-tray-total">
          <strong>{total.head}</strong>
          {total.note && <span className="scan-tray-note"> {total.note}</span>}
        </span>
        {failed > 0 && <span className="scan-tray-failed">{failed} not saved</span>}
        {onReview && (
          <Button className="scan-tray-review" size="small" variant="quiet" onClick={onReview}>
            Review all
          </Button>
        )}
      </div>
      <ol className="scan-tray-list">
        {cards.map((c, i) => {
          const price = c.finish === "proxy" ? null : priceFor(c.prices, c.finish);
          const tag = playTag(play.get(c.oracleId ?? ""));
          const word = tag ? PLAY_WORD[tag] : null;
          const cls = ["scan-tile", i === 0 && "is-newest", worthIt(price, worth) && "is-worth", c.state && `is-${c.state}`].filter(Boolean).join(" ");
          const body = (
            <>
              <span className="scan-tile-card">
                <CardThumb src={c.image} eager={i < 6} fallback={<span className="scan-tile-fallback">{c.name}</span>} />
                {c.copies > 1 && <span className="scan-tile-copies">×{c.copies}</span>}
                {c.finish !== "nonfoil" && <span className={`scan-tile-finish is-${c.finish}`}>{FINISH_SHORT[c.finish]}</span>}
                {c.state === "failed" && <span className="scan-tile-alert">Not saved</span>}
                {word && <span className={`scan-tile-tag is-${tag}`}>{tag === "game-changer" ? "GC" : word}</span>}
              </span>
              <span className="scan-tile-price">{c.finish === "proxy" ? "Proxy" : price == null ? "No price" : usd(price)}</span>
            </>
          );
          return (
            <li key={c.key}>
              {onOpen ? (
                <Button className={cls} onClick={() => onOpen(c.key)} aria-label={`${tileLabel(c, word)}. Show it larger`}>
                  {body}
                </Button>
              ) : (
                <span className={cls} role="img" aria-label={tileLabel(c, word)}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
