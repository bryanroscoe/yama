// Buy this deck: store links for the cards still to get, or the whole list (buyList.ts).
import { plural, shortDate, usd } from "@yama/core";
import { useId, useState } from "react";
import type { DeckEntry } from "../api";
import { ButtonLink, CopyButton, Segmented } from "../components/ui";
import { buyList, type BuyWhat } from "./buyList";

export function BuyDeck({ cards }: { cards: DeckEntry[] }) {
  const heading = useId();
  const need = buyList(cards, "need");
  const all = buyList(cards, "all");
  const [picked, setPicked] = useState<BuyWhat | null>(null);
  if (!all.copies) return null;
  // The cards still to get first; a deck with nothing left to get offers its whole list.
  const what: BuyWhat = need.copies ? picked ?? "need" : "all";
  const list = what === "need" ? need : all;
  const dates = list.newest ? `${list.oldest && list.oldest !== list.newest ? `${shortDate(list.oldest)} to ` : ""}${shortDate(list.newest)}` : null;
  return (
    <section className="buy-deck" aria-labelledby={heading}>
      <h2 id={heading}>Buy this deck</h2>
      {need.copies > 0 ? (
        <Segmented
          className="buy-deck-what"
          label="Cards to buy"
          value={what}
          onChange={setPicked}
          options={[["need", `Cards you still need (${need.copies})`], ["all", `The whole list (${all.copies})`]]}
        />
      ) : (
        <p>You have a copy or a proxy of every card that isn't a basic land. The links carry the whole list.</p>
      )}
      <p>
        <b className="num">{usd(list.usd)}</b> for {plural(list.copies, "card")} at market prices
        <span className="dim">
          {list.unpriced > 0 ? `, ${plural(list.unpriced, "card")} without a price` : ""}
          {dates ? `. TCGplayer market via Scryfall, ${dates}` : ""}
          {what === "need" ? ". Basic lands left out." : "."}
        </span>
      </p>
      <p className="buy-deck-links">
        {list.tcgplayer && (
          <ButtonLink variant="outline" href={list.tcgplayer} target="_blank" rel="noreferrer">
            Open in TCGplayer Mass Entry
          </ButtonLink>
        )}
        {list.cardKingdom && (
          <ButtonLink variant="outline" href={list.cardKingdom} target="_blank" rel="noreferrer">
            Open in Card Kingdom's deck builder
          </ButtonLink>
        )}
        <CopyButton text={list.paste} label="Copy the list" variant="outline" />
      </p>
      {(!list.tcgplayer || !list.cardKingdom) && (
        <p className="small dim">This list is too long for a link. Copy it, then paste it into TCGplayer's Mass Entry or Card Kingdom's deck builder.</p>
      )}
      <p className="small dim">
        Each link opens the store's own page with the card names filled in. The store picks the printings and sets its own prices and stock, so its total can differ from the market prices here. Yama earns nothing from these links.
      </p>
    </section>
  );
}
