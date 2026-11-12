import { useQuery } from "@tanstack/react-query";
import { api, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { Segmented } from "../components/ui";

/** The save step's order and names (Public, Link only, Private). */
export const SAVE_CHOICES: readonly (readonly [Visibility, string])[] = [
  ["public", "Public"],
  ["link", "Link only"],
  ["private", "Private"],
];

/**
 * What each choice means for the deck being saved, in one line. `listed` is whether the account's
 * public decks are listed publicly (`Sharing.public_listed_at`): every account made since
 * public-by-default, and older ones once their owner has answered the question. Without it a
 * public deck is on the profile only.
 */
export function visibilityMeans(v: Visibility, listed: boolean): string {
  switch (v) {
    case "public":
      return listed
        ? "Anyone can see the list. It is on your profile, listed in Browse and open to search engines."
        : "Anyone with the link can see the list, and it is listed on your profile.";
    case "link":
      return "Anyone with the link can see the list. It isn't listed anywhere.";
    default:
      return "Only you can see it.";
  }
}

/**
 * For a place that makes decks without the save step's choice (an import of many decks): what
 * they start as and what that means, from the account's sharing settings.
 */
export function newDecksStartAs(sharing: Pick<Sharing, "new_deck_visibility" | "public_listed_at">): string {
  const label = SAVE_CHOICES.find(([v]) => v === sharing.new_deck_visibility)?.[1] ?? "Private";
  return `New decks come in as ${label}. ${visibilityMeans(sharing.new_deck_visibility, !!sharing.public_listed_at)} That is your setting for new decks: change it in Sharing settings first, or from each deck's Share button afterwards.`;
}

/** What a deck saved without the save step's choice starts as, for someone signed in (their setting) or not yet (a new account's). */
export function savedAsLine(sharing: Pick<Sharing, "new_deck_visibility" | "public_listed_at"> | null): string {
  if (!sharing) return "A deck you save starts as Public on a new account: anyone can see it, and once you pick a handle it is on your profile, listed in Browse and open to search engines. On an account you already have it starts as that account's setting. The deck's Share button changes it.";
  const label = SAVE_CHOICES.find(([v]) => v === sharing.new_deck_visibility)?.[1] ?? "Private";
  return `It is saved as ${label}, your setting for new decks. ${visibilityMeans(sharing.new_deck_visibility, !!sharing.public_listed_at)} The deck's Share button changes it.`;
}

/** That line under a save button that has no choice of its own (Check a deck). Signed in, it waits for the account's setting. */
export function SavedAsNote() {
  const me = useMe();
  const userId = me.data?.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: !!userId });
  if (userId ? !sharing.data : me.isPending) return null;
  return <p className="small dim">{savedAsLine(userId ? sharing.data! : null)}</p>;
}

/**
 * Who can see a deck being saved: Public, Link only or Private. The choice is sent with the save
 * and becomes what the account's next decks start as, so it is asked once and then remembered.
 */
export function VisibilityChoice({ value, onChange, disabled, listed }: { value: Visibility; onChange: (v: Visibility) => void; disabled?: boolean; listed: boolean }) {
  return (
    <div className="visibility-choice">
      <span className="visibility-choice-label" id="visibility-choice-label">Who can see it</span>
      <Segmented labelledBy="visibility-choice-label" value={value} onChange={onChange} options={SAVE_CHOICES} disabled={disabled} />
      <span className="small dim" role="note">
        {visibilityMeans(value, listed)} Yama remembers this for your next deck; you can change a deck any time from its Share button.
      </span>
    </div>
  );
}
