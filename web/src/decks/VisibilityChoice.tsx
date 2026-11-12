import { useQuery } from "@tanstack/react-query";
import { api, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ErrorText, Segmented } from "../components/ui";

/** The save step's order and names (Public, Link only, Private). */
export const SAVE_CHOICES: readonly (readonly [Visibility, string])[] = [
  ["public", "Public"],
  ["link", "Link only"],
  ["private", "Private"],
];

/** What decides where an account's public deck shows. */
export interface PublicReach {
  /**
   * The account's public decks are listed publicly (`Sharing.public_listed_at`): every account
   * made since public-by-default, and older ones once their owner has answered the question.
   * Without it a public deck is on the profile only.
   */
  listed: boolean;
  /** The account has a handle, so it has a profile. Without one a public deck is reachable by its link only. */
  handle: boolean;
}

export const reachOf = (s: Pick<Sharing, "public_listed_at" | "handle">): PublicReach => ({ listed: !!s.public_listed_at, handle: !!s.handle });

/**
 * What each choice means for a deck, in one line. For Public it says the most the deck can be
 * seen: Browse and search engines are named as what can happen, not as done, and only for an
 * account whose public decks are listed; the profile only for an account that has a handle.
 */
export function visibilityMeans(v: Visibility, reach: PublicReach): string {
  switch (v) {
    case "public": {
      const beyond = reach.listed ? ", and can be listed in Browse and found by search engines" : "";
      return reach.handle
        ? `Anyone can see the list. It is on your profile${beyond}.`
        : `Anyone with the link can see the list. Once you pick a handle it is on your profile${beyond}.`;
    }
    case "link":
      return "Anyone with the link can see the list. It isn't listed anywhere.";
    default:
      return "Only you can see it.";
  }
}

type Setting = Pick<Sharing, "new_deck_visibility" | "public_listed_at" | "handle">;

/**
 * For a place that makes decks without the save step's choice (an import of many decks): what
 * they start as and what that means, from the account's sharing settings.
 */
export function newDecksStartAs(sharing: Setting): string {
  const label = SAVE_CHOICES.find(([v]) => v === sharing.new_deck_visibility)?.[1] ?? "Private";
  return `New decks come in as ${label}. ${visibilityMeans(sharing.new_deck_visibility, reachOf(sharing))} That is your setting for new decks: change it in Sharing settings first, or from each deck's Share button afterwards.`;
}

/** What a deck saved without the save step's choice starts as, for someone signed in (their setting) or not yet (a new account's). */
export function savedAsLine(sharing: Setting | null): string {
  if (!sharing)
    return "A deck you save starts as Public on a new account: anyone with its link can see it, and once you pick a handle it is on your profile and can be listed in Browse and found by search engines. On an account you already have it starts as that account's setting. The deck's Share button changes it.";
  const label = SAVE_CHOICES.find(([v]) => v === sharing.new_deck_visibility)?.[1] ?? "Private";
  return `It is saved as ${label}, your setting for new decks. ${visibilityMeans(sharing.new_deck_visibility, reachOf(sharing))} The deck's Share button changes it.`;
}

/**
 * The account's setting for new decks: where a save step's choice starts (Check a deck), and
 * what a page that saves a deck without that choice says first. `ready` is false while a signed-in account's setting hasn't loaded: such a page holds
 * its save until then, so a deck is never made before the page has said who can see it.
 */
export function useNewDeckSetting() {
  const me = useMe();
  const userId = me.data?.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: !!userId });
  return { signedIn: !!userId, setting: userId ? (sharing.data ?? null) : null, ready: userId ? !!sharing.data : !me.isPending, error: sharing.error, retry: () => void sharing.refetch() };
}

/** That line under a save button that has no choice of its own (a copy of a precon), or why it can't be said yet. */
export function SavedAsNote({ state }: { state: ReturnType<typeof useNewDeckSetting> }) {
  if (state.error) return <ErrorText error={state.error} retry={state.retry} />;
  if (!state.ready) return null;
  return <p className="small dim">{savedAsLine(state.setting)}</p>;
}

/**
 * Who can see a deck being saved: Public, Link only or Private. The choice is sent with the save
 * and becomes what the account's next decks start as, so it is asked once and then remembered.
 */
export function VisibilityChoice({ value, onChange, disabled, reach }: { value: Visibility; onChange: (v: Visibility) => void; disabled?: boolean; reach: PublicReach }) {
  return (
    <div className="visibility-choice">
      <span className="visibility-choice-label" id="visibility-choice-label">Who can see it</span>
      <Segmented labelledBy="visibility-choice-label" value={value} onChange={onChange} options={SAVE_CHOICES} disabled={disabled} />
      <span className="small dim" role="note">
        {visibilityMeans(value, reach)} Yama remembers this for your next deck; you can change a deck any time from its Share button.
      </span>
    </div>
  );
}
