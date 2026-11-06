import { swapCard, swapCardPages, swapCards, type SwapCard } from "@yama/core/plan";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import "./swapcards.css";

/** The page box for the cards: three 2.5 inch columns and three 3.5 inch rows fit only inside 0.25 inch margins. */
const PAGE_RULE = "@page { size: letter; margin: 0.25in; }";

/**
 * `/decks/plan/swap-cards`: card-sized bracket swap cards to keep in each deck box, one 2.5 x 3.5
 * inch card per deck, nine to a US-letter page with cut lines. `?deck=<key>` shows one deck's card.
 * The same cards commander-decks prints (mtg-bracket-swap-cards.html). On screen each card keeps its
 * proportions at a readable size, so what fits on screen fits on paper.
 */
export function SwapCardsPage() {
  const { view } = usePlanOutlet();
  const [params] = useSearchParams();
  const deckKey = params.get("deck");
  const deck = deckKey ? view.deck(deckKey) : undefined;
  const all = useMemo(() => swapCards(view.b), [view.b]);
  const one = useMemo(() => (deck ? swapCard(deck, view.b.game_changers?.names ?? []) : null), [deck, view.b.game_changers]);
  const cards = deckKey ? (one ? [one] : []) : all;
  const guide = view.b.head?.guide_version;
  const sheet = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState<string[]>([]);

  // Another page's print rule (the swap sheet's wider margins) would push the third row onto a
  // second page. A rule added last wins, so add ours while this page is open.
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.swapCards = "";
    style.textContent = PAGE_RULE;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // A card whose text runs past its bottom edge is cut off on paper too: say which.
  useLayoutEffect(() => {
    const root = sheet.current;
    if (!root) return;
    const check = () => {
      const long = [...root.querySelectorAll<HTMLElement>(".sc-card")].filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => el.dataset.deck ?? "");
      setOverflowing((old) => (old.join("\n") === long.join("\n") ? old : long));
    };
    check();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(root);
    // The cards are a fixed size, so a web font that loads late and wraps more text doesn't resize
    // anything: check again when fonts finish loading.
    const fonts = root.ownerDocument.fonts;
    let live = true;
    void fonts?.ready.then(() => live && check());
    fonts?.addEventListener("loadingdone", check);
    return () => {
      live = false;
      observer?.disconnect();
      fonts?.removeEventListener("loadingdone", check);
    };
  }, [cards]);

  const title = deckKey ? `${deck?.name ?? "Deck"} swap card` : "Swap cards";
  return (
    <div className="swap-cards">
      <div className="sc-controls">
        <PlansHead title={title} />
        <p><Link to={`/decks/builds${deck ? `?planKey=${encodeURIComponent(deck.key)}` : ""}`}>Pick any two lists of a deck and print double-sided swap cards</Link></p>
        <p className="small">
          {deckKey ? "A card for the deck box" : "A card for each deck box"}: which cards to swap to change bracket. Each card is 2.5 by 3.5 inches,
          nine to a US-letter page. Print at actual size (100%, no fit to page) with headers and footers off, then cut on the dashed lines.
        </p>
        <div className="row">
          <button className="primary" disabled={!cards.length} onClick={() => window.print()}>Print</button>
          {deckKey && deck && <Link to={`/decks/plans/${encodeURIComponent(deck.key)}?tab=brackets`}>Back to {deck.name}</Link>}
          {deckKey && all.length > 1 && <Link to="/decks/plan/swap-cards">All decks' swap cards</Link>}
        </div>
        {overflowing.length > 0 && (
          <p className="error" role="alert">
            {overflowing.length === 1 ? `${overflowing[0]}'s card is` : `${overflowing.join(", ")}: these cards are`} too long for 3.5 inches; the bottom is cut off on paper.
          </p>
        )}
        {!cards.length && (
          <p className="empty">
            {deckKey && !deck ? `There's no plan deck called "${deckKey}" in your plans.` : deckKey ? "This plan has no bracket swaps." : "None of your plan decks has bracket swaps yet."}
          </p>
        )}
      </div>
      {cards.length > 0 && (
        <div className="sc-sheet" ref={sheet}>
          {swapCardPages(cards).map((page, i) => (
            <div key={i} className="sc-page">
              {page.map((c) => <SwapCardView key={c.key} card={c} guide={guide} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CardName({ name, gc }: { name: string; gc: boolean }) {
  // A no-break space keeps GC with the name's last word, never alone on a line.
  return <>{name}{gc && <>{"\u00a0"}<abbr className="sc-gc" title="Game Changer">GC</abbr></>}</>;
}

/** One deck's card, laid out like commander-decks' swapcards.py. */
export function SwapCardView({ card, guide }: { card: SwapCard; guide?: number | null }) {
  return (
    <article className="sc-card" data-deck={card.name} aria-label={`${card.name} swap card`}>
      <h2 className="sc-title">{card.name}</h2>
      <p className="sc-cmdr">{card.commander}</p>
      <p className="sc-box">In the box: Bracket {card.box}. Going up, do the swaps in reverse.</p>
      {card.steps.map((s) => (
        <section key={s.to}>
          <h3 className="sc-h">Bracket {s.from} → {s.to}</h3>
          <table>
            <thead>
              <tr><th scope="col">Out</th><th aria-hidden="true" /><th scope="col">In</th></tr>
            </thead>
            <tbody>
              {s.swaps.map((w, i) => (
                <tr key={i}>
                  <td><CardName name={w.out} gc={w.outGc} /></td>
                  <td className="sc-arrow" aria-hidden="true">→</td>
                  <td><CardName name={w.in} gc={w.inGc} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {!card.steps.length && <p className="sc-s">No bracket swaps.</p>}
      {card.extras.length > 0 && (
        <section>
          <h3 className="sc-h">Bracket 4 extras (not in any build)</h3>
          <p className="sc-s">{card.extras.map((x, i) => <span key={x.name}>{i > 0 && ", "}<CardName name={x.name} gc={x.gc} /></span>)}</p>
        </section>
      )}
      <p className="sc-foot">GC = Game Changer.{guide != null ? ` Guide v${guide}.` : ""}</p>
    </article>
  );
}
