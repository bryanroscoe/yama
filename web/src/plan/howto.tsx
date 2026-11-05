import { Link } from "react-router";
import { ConnectButton, HowTo } from "../components/HowTo";

/**
 * What each Plans page is for, where what's on it comes from and what to do there (Bryan,
 * 2026-11-04: "If they are mcp only they should say so etc etc, nothin is user freindly"). One
 * place for the copy, so the pages say it the same way. Open when the page has nothing yet.
 */

/** Says plainly that only an assistant connected to Yama makes this. */
export function AssistantOnly({ what }: { what: string }) {
  return (
    <span className="assistant-only">
      <span className="pill quiet">Needs your assistant</span> {what} Yama doesn't make them by itself: an AI assistant you connect to Yama through its MCP connection does.
    </span>
  );
}

export function ReviewHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How Review works"
      open={open}
      steps={[
        <AssistantOnly key="a" what="Proposed changes come from your assistant: in the plans it saves, and as proposals for decks you track." />,
        <>
          <b>Answer on each deck's page</b>: Want, Unsure or Don't want beside each change, with a note for your assistant if you like. Want tells your assistant to add it to the plan;
          the other two keep it out, and your note says why. This page lists the decks with changes waiting.
        </>,
        <>
          <b>Nothing changes your deck</b> until you put a card in. Planned swaps go on to <Link to="/decks/plan/buy">Buy</Link> and <Link to="/decks/plan/prints">Prints</Link>, then
          into the deck.
        </>,
      ]}
      actions={<ConnectButton className="outline" />}
    />
  );
}

export function BuyHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How the buy list works"
      open={open}
      steps={[
        <>
          <b>Cards your tracked plans buy</b>, grouped by the store that has them, with each store's dated price. Cards no store lists go to the bottom, to ask about or print.
        </>,
        <>
          <b>Buy them</b>: where a store has a cart link, Replace cart fills it; otherwise take the list to the counter. A <Link to="/decks/plan/trip">store trip</Link> picks the fewest
          stores for everything.
        </>,
        <>
          <b>Mark bought</b> when you have a card. It leaves the list and waits to go into its deck.
        </>,
      ]}
      actions={
        <>
          <Link className="button outline" to="/decks/plan/trip">Plan a store trip</Link>
          <Link className="button outline" to="/decks/plan/settings#shopping-rules">Your shopping rules</Link>
        </>
      }
    />
  );
}

export function TripHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How a store trip works"
      open={open}
      steps={[
        <>
          <b>Your shopping list</b>: what your tracked plans buy, plus cards and precons you add below under Your list (your assistant can add them too). Use it with or without a plan.
        </>,
        <>
          <b>Check stores</b> reads which of your stores have the cards today. Yama then picks the fewest stores that cover the most cards within your price rule.
        </>,
        <>
          <b>Go</b>: tick the stores you're going to, copy each store's list, and print what no store has.
        </>,
      ]}
      actions={
        <>
          <a className="button outline" href="#trip-list">Add to your list</a>
          <a className="button outline" href="#trip-stock">Check stores</a>
          <a className="button outline" href="#trip-prefs">Your stores</a>
        </>
      }
    />
  );
}

export function PrintsHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How prints work"
      open={open}
      steps={[
        <>
          <b>Cards your tracked plans print</b> as proxies instead of buying: the orders placed, what has arrived and a draft of the next order.
        </>,
        <>
          <b>When prints arrive</b>, the Swap sheet sorts them into decks: each deck's card in, card out and where the cut card goes.
        </>,
        <>
          <b>Proxies are marked as proxies</b> in your collection and stay out of its market value.
        </>,
      ]}
    />
  );
}

export function SparesHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How spares work"
      open={open}
      steps={[
        <>
          <b>Cards your tracked plans take out of decks</b>, and where each goes next: another deck that wants it, the deck's swap bag, or your spares.
        </>,
        <>
          <b>Out now</b> means its replacement is in hand; <b>out when prints arrive</b> means it waits for a print or another deck. Worked out from your plans, not counted in a box.
        </>,
      ]}
    />
  );
}

export function SettingsHowTo() {
  return (
    <p className="small dim plan-settings-lede">
      Connect your assistant so it can read your decks and write plans, set your shopping rules and stores for Buy and Trip, and see what this device keeps offline. Keys are only for
      scripts.
    </p>
  );
}

export function ChangesHowTo({ open }: { open: boolean }) {
  return (
    <HowTo
      title="How suggested changes work"
      open={open}
      steps={[
        <AssistantOnly key="a" what="Suggested changes are edits proposed for your decks, collection, plans or lab runs." />,
        <>
          <b>Each waits here</b> with exactly what it changes. Apply makes the change; Discard drops it. Nothing happens until you choose.
        </>,
      ]}
      actions={<ConnectButton className="outline" />}
    />
  );
}
