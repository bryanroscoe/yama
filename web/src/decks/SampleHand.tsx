// A sample opening hand from a list (the deck page's More menu, and the Check a deck page): deal
// seven, mulligan, put cards on the bottom, draw. Worked out on the device from the list as shown.
import { bottom, draw, expandDeck, newHand, rng, type Goldfish } from "@yama/core";
import { useMemo, useRef, useState } from "react";
import type { DeckEntry } from "../api";
import { ArtPanel } from "../components/ArtPanel";
import { useModalLayer } from "../components/Dialog";
import { Button, CardImage } from "../components/ui";

/** The list a hand is dealt from: its name and its cards with their pictures and types. */
export interface HandDeck {
  name: string;
  cards: Pick<DeckEntry, "oracle_id" | "name" | "qty" | "board" | "card">[];
}

export function SampleHand({ deck, art, artist, onClose }: { deck: HandDeck; art: string | null; artist: string | null; onClose: () => void }) {
  const library = useMemo(() => expandDeck(deck.cards), [deck]);
  const images = useMemo(() => new Map(deck.cards.map((c) => [c.name, c.card?.image_normal ?? null])), [deck]);
  const deal = (mulligans: number) => newHand(library, rng(crypto.getRandomValues(new Uint32Array(1))[0]!), mulligans);
  const [g, setG] = useState<Goldfish>(() => deal(0));
  const root = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const layer = useModalLayer(root, onClose, done);
  const lands = g.hand.filter((c) => deck.cards.find((d) => d.name === c.name)?.card?.type_line.includes("Land")).length;
  return (
    <div ref={root} className="hand-view" role="dialog" aria-modal="true" aria-label="Sample hand" tabIndex={-1} {...layer}>
      <ArtPanel as="header" className="hand-head" art={art} artist={artist} wash="bottom" toGround>
        <span className="hand-title">
          <span className="hand-deck">{deck.name}</span>
          <span className="hand-name">Sample hand</span>
        </span>
        <Button ref={done} variant="primary" className="hand-done" onClick={onClose}>Done</Button>
      </ArtPanel>
      <div className="hand-body">
        <p className="hand-summary" aria-live="polite">
          {g.hand.length} cards, {lands} {lands === 1 ? "land" : "lands"}
          {g.mulligans ? `, mulligan ${g.mulligans}${g.mulligans === 1 ? " (the first is free)" : ""}` : ""}
          {g.drawn ? `, drawn ${g.drawn}` : ""}. {g.library.length} left in the library.
        </p>
        {g.toBottom > 0 && <p className="hand-bottom">Tap {g.toBottom === 1 ? "a card" : `${g.toBottom} cards`} to put on the bottom.</p>}
        <ul className="hand-cards" aria-label="Your hand">
          {g.hand.map((c, i) => (
            <li key={c.id}>
              <Button onClick={() => setG(bottom(g, i))} disabled={g.toBottom === 0} aria-label={g.toBottom ? `Put ${c.name} on the bottom` : c.name}>
                <CardImage src={images.get(c.name)} name={c.name} />
              </Button>
            </li>
          ))}
        </ul>
        <p className="small dim hand-note">First mulligan free. Card images from Scryfall, © Wizards of the Coast.</p>
      </div>
      <div className="hand-bar">
        <Button variant="primary" onClick={() => setG(draw(g))} disabled={g.toBottom > 0 || g.library.length === 0}>Draw</Button>
        <Button onClick={() => setG(deal(g.mulligans + 1))}>Mulligan</Button>
        <Button onClick={() => setG(deal(0))}>New hand</Button>
      </div>
    </div>
  );
}
