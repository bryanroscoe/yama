import type { Visibility } from "../api";
import { Segmented } from "../components/ui";

/** The save step's order and names (Public, Link only, Private). */
export const SAVE_CHOICES: readonly (readonly [Visibility, string])[] = [
  ["public", "Public"],
  ["link", "Link only"],
  ["private", "Private"],
];

/** What each choice means for the deck being saved, in one line. */
export function visibilityMeans(v: Visibility): string {
  switch (v) {
    case "public":
      return "Anyone with the link can see the list, and it is listed on your profile.";
    case "link":
      return "Only people you send the link to can see the list. It isn't listed anywhere.";
    default:
      return "Only you can see it.";
  }
}

/**
 * Who can see a deck being saved: Public, Link only or Private. The choice is sent with the save
 * and becomes what the account's next decks start as, so it is asked once and then remembered.
 */
export function VisibilityChoice({ value, onChange, disabled }: { value: Visibility; onChange: (v: Visibility) => void; disabled?: boolean }) {
  return (
    <div className="visibility-choice">
      <span className="visibility-choice-label" id="visibility-choice-label">Who can see it</span>
      <Segmented labelledBy="visibility-choice-label" value={value} onChange={onChange} options={SAVE_CHOICES} disabled={disabled} />
      <span className="small dim" role="note">
        {visibilityMeans(value)} Yama remembers this for your next deck; you can change a deck any time from its Share button.
      </span>
    </div>
  );
}
