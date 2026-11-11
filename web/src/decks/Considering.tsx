// The Considering list on a deck's page (a maybeboard): cards the owner is thinking about, kept
// with the deck but not in it. They count toward nothing here: not the deck's legality, stats,
// prices or exports. They are changed in Edit the list, under a Considering heading.
import { plural } from "@yama/core";
import { useId } from "react";
import { Link } from "react-router";
import type { MaybeEntry } from "../api";
import { CardImage } from "../components/ui";

/** "You own 2", "Proxy only" or "Not owned". */
export function consideringOwned(c: Pick<MaybeEntry, "owned" | "proxies">): string {
  if (c.owned > 0) return `You own ${c.owned}`;
  return c.proxies > 0 ? "Proxy only" : "Not owned";
}

export function Considering({ cards, deckId, onOpen }: { cards: MaybeEntry[]; deckId: string; onOpen: (oracleId: string) => void }) {
  const heading = useId();
  if (!cards.length) return null;
  const copies = cards.reduce((n, c) => n + c.qty, 0);
  return (
    <section className="deck-considering" aria-labelledby={heading}>
      <h2 id={heading}>
        Considering <span className="dim num">{copies}</span>
      </h2>
      <p className="small dim">
        {plural(copies, "card")} you're thinking about. {copies === 1 ? "It isn't" : "They aren't"} in the deck, so {copies === 1 ? "it doesn't" : "they don't"} count toward its legality, stats, prices or exports.{" "}
        <Link to={`/decks/${deckId}/edit`}>Edit the list</Link> to move a card in or out.
      </p>
      <ul className="deck-considering-cards">
        {cards.map((c) => (
          <li key={c.oracle_id}>
            <button type="button" className="deck-considering-card" onClick={() => onOpen(c.oracle_id)} aria-label={`${c.name}, full card`}>
              <CardImage src={c.card?.image_small} name={c.name} className="deck-considering-thumb" />
              <span className="deck-considering-text">
                <span>{c.qty > 1 ? `${c.qty} ` : ""}{c.name}</span>
                <span className="small dim">{c.card?.type_line ? `${c.card.type_line}. ` : ""}{consideringOwned(c)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
