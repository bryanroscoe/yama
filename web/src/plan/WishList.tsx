// Collection, Wish list (`/collection/wishlist`): the cards and sealed products you want to get,
// for every account (Bryan, 12 Nov 2026: the Collection tab holds the wish list). It is the same
// list, kept in the same place, as "Your list" on the Workshop's store trip, which plans stops
// around it; this page is the list alone, so nobody needs Advanced on to reach their own wishes.
import { useQuery } from "@tanstack/react-query";
import { plural } from "@yama/core";
import { Link } from "react-router";
import { api, publicOrigin, type Sharing, type TradeCompare } from "../api";
import { useAdvanced, useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { PlanLayout, usePlanOutlet } from "./PlanLayout";
import { MyList } from "./Trip";
import "./wishlist.css";

/** The plan bundle the list lives in, loaded under the wish list's own title. */
export function WishListLayout() {
  return <PlanLayout title="Wish list" />;
}

/**
 * What friends see of the list. Sharing it publishes more than the rows on this page: the public
 * page lists these cards together with the real cards the account's decks and plans still need.
 * `listed` is how many cards that page has in all, when known.
 */
export function sharedText(cards: number, listed: number | null): string {
  const mine = cards === 0 ? "" : cards === 1 ? "this card" : `these ${cards}`;
  const others = listed == null ? null : Math.max(0, listed - cards);
  if (others == null) return `Friends see ${mine ? `${mine} and ` : ""}the cards your decks and plans still need.`;
  if (others === 0) return mine ? `Friends see ${mine}.` : "Nothing is on it yet.";
  return `Friends see ${mine ? `${mine} plus ` : ""}the ${plural(others, "card")} your decks and plans still need.`;
}

/** Whether the wish list is on the public profile, what is on that page, and where to change it. */
function Shared({ cards }: { cards: number }) {
  const me = useMe().data;
  const enabled = !!me && !me.viewing;
  const sharing = useQuery({ queryKey: ["sharing", me?.id], queryFn: () => api<Sharing>("/api/me/sharing"), enabled });
  const s = enabled ? sharing.data : undefined;
  const on = !!s?.handle && s.wants_public;
  // How many cards the public page lists: the account's side of a comparison with itself.
  const own = useQuery({
    queryKey: ["sharing-compare", me?.id, s?.handle],
    queryFn: ({ signal }) => api<TradeCompare>(`/api/sharing/compare/${encodeURIComponent(s!.handle!)}`, { signal }),
    enabled: enabled && on,
    retry: false,
  });
  if (!s) return null;
  if (!on) {
    return (
      <p className="dim wish-shared">
        Shared: off. Only you see this list. To show it to friends, {s.handle ? "" : "choose a handle and "}turn on sharing your wish list in <Link to="/sharing#sharing">Sharing settings</Link>.
      </p>
    );
  }
  return (
    <p className="wish-shared">
      Shared: on. {sharedText(cards, own.data ? own.data.your_wants : null)}{" "}
      <a href={`${publicOrigin()}/u/${encodeURIComponent(s.handle!)}/wants`} target="_blank" rel="noreferrer">Open the public page</a>
    </p>
  );
}

export function WishListPage() {
  const { view, userId } = usePlanOutlet();
  const advanced = useAdvanced();
  // The cards on the list, each counted once: sealed products aren't on the public page.
  const cards = new Set((view.b.shopping_wants ?? []).filter((w) => w.kind === "card").map((w) => w.name.toLowerCase())).size;
  return (
    <>
      <AreaHead title="Wish list" index />
      <p className="dim plans-lede">Cards and sealed products you want to get.</p>
      <Shared cards={cards} />
      <MyList view={view} userId={userId} />
      {advanced && (
        <p>
          <Link to="/decks/plans/get/trip">Plan a store trip</Link> around this list and your plans' buys.
        </p>
      )}
    </>
  );
}
