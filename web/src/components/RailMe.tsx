import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { api, type DeckSummary } from "../api";
import { signInPath, useMe } from "../auth";
import { useOutbox, useRejected, useSyncStatus } from "../table/store";
import { artCredit } from "./ArtPanel";
import { ButtonLink } from "./Button";
import { CardThumb } from "./CardThumb";

const subscribeOnline = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/** Whether finished games on this device have all reached Yama. */
function useSyncLine(): { text: string; waiting: boolean } {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const sync = useSyncStatus();
  const outbox = useOutbox();
  const rejected = useRejected();
  if (!online) return { text: outbox.length ? `Offline, ${outbox.length} to upload` : "Offline", waiting: true };
  if (sync.syncing) return { text: "Saving to Yama…", waiting: true };
  if (outbox.length) return { text: `${outbox.length} ${outbox.length === 1 ? "game" : "games"} to upload`, waiting: true };
  if (sync.error) return { text: "Not saved yet", waiting: true };
  if (rejected.length) return { text: `${rejected.length} kept on this device`, waiting: true };
  return { text: "Up to date", waiting: false };
}

/** "PR" for Pat Rivers: what the avatar shows without commander art. */
function initialsOf(name: string): string {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The foot of the laptop rail: you. Your commander's art (or your initials) and the sync status,
 *  opening the You page; signed out, the way in. `current` on the You pages. */
export function RailMe({ current = false }: { current?: boolean }) {
  const me = useMe();
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }), enabled: !!me.data });
  const sync = useSyncLine();
  const { pathname, search } = useLocation();
  if (!me.data) {
    // Signed out, the rail's foot is the way in; the sign-in page comes back here afterwards.
    return (
      <div className="rail-foot">
        <ButtonLink to={signInPath(pathname + search)} className="rail-signin">Sign in</ButtonLink>
      </div>
    );
  }
  const name = me.data.display_name || me.data.email;
  const deck = decks.data?.find((d) => d.commander_image);
  return (
    <div className="rail-foot">
      <Link to="/profile" className={`rail-me${current ? " active" : ""}`} aria-current={current ? (pathname === "/profile" ? "page" : "true") : undefined} title="You: your profile, sharing and settings">
        <span className="avatar"><CardThumb src={deck?.commander_image} eager fallback={initialsOf(name)} /></span>
        <span className="rail-me-text">
          <span className="rail-me-name">{name}</span>
          <span className={`sync${sync.waiting ? " waiting" : ""}`}>{sync.text}</span>
        </span>
      </Link>
      {deck && <p className="rail-credit">{artCredit(deck.commander_artist)}</p>}
    </div>
  );
}

/** You in the phone's top bar: your initials, opening the You page; signed out, the way in. (No
 *  art here: there is no room beside it for the artist's credit.) */
export function TopBarMe({ current = false }: { current?: boolean }) {
  const me = useMe();
  const { pathname, search } = useLocation();
  if (!me.data) return <ButtonLink size="small" to={signInPath(pathname + search)} className="topbar-signin">Sign in</ButtonLink>;
  return (
    <Link to="/profile" className={`topbar-you${current ? " active" : ""}`} aria-label="You" aria-current={current ? (pathname === "/profile" ? "page" : "true") : undefined}>
      <span className="avatar">{initialsOf(me.data.display_name || me.data.email)}</span>
    </Link>
  );
}
