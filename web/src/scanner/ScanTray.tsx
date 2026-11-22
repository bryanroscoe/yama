// The strip of cards scanned this session (Bryan, 16 Nov 2026: "It's kind of hard to see what card
// you just scanned … I kind of like how Mythic Tools does it. It keeps it out of the scrollable
// thing at the bottom"). Between the camera and the sheet, never scrolled away: each card's
// picture with its price in the finish filed, newest first and largest, a tag for a card that
// sees play in Commander (playable.ts), and the session's total. Tapping a card opens it large,
// to check the printing and fix it (the host's ScannedCard dialog).

import { shortDate, usd } from "@yama/core";
import { useEffect, useRef, type ReactNode } from "react";
import { ActionBar, Button, CardThumb } from "../components/ui";
import { PLAY_WORD, playTag, usePlayability } from "./playable";
import { priceFor, sessionTotal, unsettledTile, worthIt, type RecentCard } from "./price";

const FINISH_SHORT = { nonfoil: null, foil: "Foil", etched: "Etched", proxy: "Proxy" } as const;

/** What a screen reader hears for a tile: the card, its printing, finish, price and state. */
export function tileLabel(c: RecentCard, tag: string | null): string {
  const parts = [c.name];
  if (c.set) parts.push(`${c.set.toUpperCase()}${c.number ? ` ${c.number}` : ""}`);
  if (c.finish !== "nonfoil") parts.push(FINISH_SHORT[c.finish]!);
  if (c.state === "finding") parts.push("finding the printing, not saved yet");
  else if (c.state === "pick") parts.push("pick the printing, not saved yet");
  else if (c.finish !== "proxy") {
    const p = priceFor(c.prices, c.finish);
    parts.push(p == null ? "price unknown" : usd(p));
  }
  if (c.byPrice) parts.push("printing by price");
  if (c.copies > 1) parts.push(`${c.copies} copies`);
  if (tag) parts.push(tag);
  if (c.state === "saving") parts.push("saving");
  if (c.state === "failed") parts.push("not saved");
  if (c.state === "change-failed") parts.push("change not saved");
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
  // Card first, printing after: cards whose printing isn't settled have no price yet, said apart.
  const waiting = cards.reduce((n, c) => n + (unsettledTile(c) ? c.copies : 0), 0);
  const wait = waiting ? `${waiting} without a printing yet` : null;
  if (t.priced === 0) return { head: count, note: [t.missing ? "no prices" : null, wait].filter(Boolean).join(", ") || null };
  const priced = cards.filter((c) => priceFor(c.prices, c.finish) != null);
  const dates = priced.flatMap((c) => (c.prices?.date ? [c.prices.date] : [])).sort();
  // Priced copies whose price has no date: counted in the total, and said (review of #152).
  const undated = priced.reduce((n, c) => n + (c.prices?.date ? 0 : c.copies), 0);
  const first = shortDate(dates[0] ?? null);
  const last = shortDate(dates.at(-1) ?? null);
  // Every price says when: one date, the span when they differ, or that it isn't known.
  const when = !last ? "date unknown" : `${first && first !== last ? `${first} to ${last}` : last}${undated ? `, ${undated} undated` : ""}`;
  return { head: `${count}, ${usd(t.total)}`, note: `market, ${when}${t.missing ? `, ${t.missing} unpriced` : ""}${wait ? `, ${wait}` : ""}` };
}

/**
 * The strip's head is the receipt for what just happened (Bryan, 16 Nov 2026: the options popped
 * up in your face rather than what happened): the card just added, named, with what can be done
 * about it right now (`actions`: Undo, Wrong printing, Add another) beside it, or `event` (Took
 * out …, Couldn't save …) in its place for a moment. The camera's chip says only what the scanner
 * is doing now.
 */
export function ScanTray({
  cards,
  worth,
  onOpen,
  onReview,
  onClear,
  event,
  actions,
  announce = "",
}: {
  cards: readonly RecentCard[];
  worth: number;
  onOpen?: (key: string) => void;
  onReview?: () => void;
  /** Clear the list (the host's, or test scan's): a quiet button beside Review all. */
  onClear?: () => void;
  event?: string | null;
  actions?: ReactNode;
  announce?: string;
}) {
  const play = usePlayability(cards.map((c) => c.oracleId));
  const list = useRef<HTMLOListElement>(null);
  const newestKey = cards[0]?.key;
  // A card just added lands at the start of the strip: bring the start back into view, or a strip
  // scrolled along hides the card the receipt above names.
  useEffect(() => {
    const el = list.current;
    if (el && el.scrollLeft !== 0) el.scrollTo?.({ left: 0, behavior: "smooth" });
  }, [newestKey]);
  if (cards.length === 0) return null;
  // Anything to try again: an add, or a change to one.
  const failed = cards.filter((c) => c.state === "failed" || c.state === "change-failed").length;
  const total = trayTotal(cards);
  const last = cards[0]!;
  return (
    <section className="scan-tray" aria-label="Scanned this session">
      <div className="scan-tray-head">
        {/* Always there, so a screen reader hears each add and event as its text changes. */}
        <p className="visually-hidden" role="status">
          {announce}
        </p>
        {/* What just happened, and what can be done about it now. */}
        <div className="scan-tray-row">
          {event ? (
            <p className="scan-tray-last is-event">{event}</p>
          ) : (
            // The card just added, named: a 72 px picture alone doesn't say it was the right one.
            <p className="scan-tray-last">
              <strong>{last.name}</strong>
              {last.set && <span className="scan-tray-note"> {last.set.toUpperCase()}{last.number ? ` #${last.number}` : ""}</span>}
              {unsettledTile(last) && <span className="scan-tray-note"> {last.state === "pick" ? "pick the printing" : "finding the printing"}</span>}
              {last.byPrice && <span className="scan-tray-note"> by price</span>}
            </p>
          )}
          {actions && (
            <ActionBar align="end" className="scan-tray-do">
              {actions}
            </ActionBar>
          )}
        </div>
        <div className="scan-tray-row">
          <p className="scan-tray-total">
            {total.head}
            {total.note && <span className="scan-tray-note"> {total.note}</span>}
          </p>
          <span className="scan-tray-buttons">
            {onClear && (
              <Button className="scan-tray-clear" size="small" variant="quiet" onClick={onClear}>
                Clear
              </Button>
            )}
            {onReview ? (
              <Button className={`scan-tray-review${failed ? " is-failed" : ""}`} size="small" variant="outline" onClick={onReview}>
                {failed ? `${failed} to try again` : "Review all"}
              </Button>
            ) : (
              failed > 0 && <span className="scan-tray-failed">{failed} not saved</span>
            )}
          </span>
        </div>
      </div>
      <ol ref={list} className="scan-tray-list">
        {cards.map((c, i) => {
          const price = c.finish === "proxy" || unsettledTile(c) ? null : priceFor(c.prices, c.finish);
          const tag = playTag(play.get(c.oracleId ?? ""));
          const word = tag ? PLAY_WORD[tag] : null;
          const cls = ["scan-tile", i === 0 && "is-newest", worthIt(price, worth) && "is-worth", c.state && `is-${c.state === "change-failed" ? "failed" : c.state}`].filter(Boolean).join(" ");
          // What goes where the price does: the state that matters more than a price.
          const under =
            c.state === "failed" ? "Unsaved" : c.state === "finding" ? "Finding…" : c.state === "pick" ? "Pick printing" : c.finish === "proxy" ? "Proxy" : price == null ? "No price" : usd(price);
          const body = (
            <>
              <span className="scan-tile-card">
                <CardThumb src={c.image} eager={i < 6} fallback={<span className="scan-tile-fallback">{c.name}</span>} />
                {c.copies > 1 && <span className="scan-tile-copies">×{c.copies}</span>}
                {c.finish !== "nonfoil" && <span className={`scan-tile-finish is-${c.finish}`}>{FINISH_SHORT[c.finish]}</span>}
                {/* The tag on the card just added; an older card's is in its own sheet (tap it), so the
                    strip stays quiet (Bryan, 16 Nov 2026: too busy). */}
                {word && i === 0 && c.state !== "failed" && <span className={`scan-tile-tag is-${tag}`}>{tag === "game-changer" ? "GC" : word}</span>}
              </span>
              {/* A failed save says so where the price goes: the red ring alone is easy to miss. So
                  does a card whose printing isn't settled (card first): it isn't saved yet. */}
              <span className={`scan-tile-price${c.state === "failed" ? " is-failed" : unsettledTile(c) ? ` is-${c.state}` : price == null ? " is-none" : ""}`}>
                {under}
              </span>
              {c.byPrice && <span className="scan-tile-by">By price</span>}
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
