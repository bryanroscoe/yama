// Collection, Wish list (`/collection/wishlist`): the cards and sealed products you want to get,
// for every account (Bryan, 12 Nov 2026: the Collection tab holds the wish list). It is the same
// list, kept in the same place, as "Your list" on the Workshop's store trip, which plans stops
// around it; this page is the list alone, so nobody needs Advanced on to reach their own wishes.
import { Link } from "react-router";
import { useAdvanced } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { PlanLayout, usePlanOutlet } from "./PlanLayout";
import { MyList } from "./Trip";

/** The plan bundle the list lives in, loaded under the wish list's own title. */
export function WishListLayout() {
  return <PlanLayout title="Wish list" />;
}

export function WishListPage() {
  const { view, userId } = usePlanOutlet();
  const advanced = useAdvanced();
  return (
    <>
      <AreaHead title="Wish list" index />
      <p className="dim plans-lede">
        Cards and sealed products you want to get. If you show what you're looking for on your profile, friends see these there.
      </p>
      <MyList view={view} userId={userId} />
      {advanced && (
        <p>
          <Link to="/decks/plans/get/trip">Plan a store trip</Link> around this list and your plans' buys.
        </p>
      )}
    </>
  );
}
