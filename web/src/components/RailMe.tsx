import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Link } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { useOutbox, useRejected, useSyncStatus } from "../table/store";
import { artCredit } from "./ArtPanel";

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

/** The foot of the laptop rail: your commander's art (or your initials) and the sync status. */
export function RailMe() {
  const me = useMe();
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled: !!me.data });
  const sync = useSyncLine();
  if (!me.data) return null;
  const name = me.data.display_name || me.data.email;
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const deck = decks.data?.find((d) => d.commander_image);
  return (
    <div className="rail-foot">
      <Link to="/group" className="rail-me" title="Your account and playgroup">
        <span className="avatar">{deck ? <img src={deck.commander_image!} alt="" /> : initials}</span>
        <span className="rail-me-text">
          <span className="rail-me-name">{name}</span>
          <span className={`sync${sync.waiting ? " waiting" : ""}`}>{sync.text}</span>
        </span>
      </Link>
      {deck && <p className="rail-credit">{artCredit(deck.commander_artist)}</p>}
    </div>
  );
}
