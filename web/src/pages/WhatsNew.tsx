import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { NEWS, SEEN_KEY, noticeLine, unseen } from "../whatsNew";
import "../components/calendar.css";
import { fmtDate } from "@yama/core";
import { Button, ButtonLink } from "../components/ui";

const SEEN_EVENT = "yama-news-seen";

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(SEEN_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SEEN_EVENT, onChange);
  };
}

function markSeen() {
  const newest = NEWS[0]?.id;
  if (!newest) return;
  try {
    localStorage.setItem(SEEN_KEY, newest);
  } catch {
    /* private mode: the notice just shows again next time */
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

function useSeen() {
  return useSyncExternalStore(subscribe, readSeen, () => null);
}

/** A line above every page while there's news newer than this device's first visit or last look. */
export function NewsNotice() {
  const seen = useSeen();
  const { pathname } = useLocation();
  const line = noticeLine(NEWS, seen);
  // A first visit: what's listed today is this device's starting point, recorded without a notice.
  useEffect(() => {
    if (seen === null) markSeen();
  }, [seen]);
  if (!line || pathname === "/new") return null;
  return (
    <aside className="news-notice" aria-label="What's new">
      <p>{line}</p>
      <span className="row">
        <ButtonLink to="/new">See what's new</ButtonLink>
        <Button variant="quiet" onClick={markSeen}>Dismiss</Button>
      </span>
    </aside>
  );
}

export function WhatsNewPage() {
  // What this device had seen before opening the page, so the new entries stay marked after
  // the page records that they've been seen.
  const [before] = useState(readSeen);
  const freshIds = new Set(unseen(NEWS, before).map((e) => e.id));
  useEffect(() => {
    markSeen();
  }, []);
  return (
    <main className="page">
      <div className="page-head">
        <h1>What's new</h1>
      </div>
      <div className="whats-new">
        {NEWS.map((e) => (
          <article key={e.id} aria-labelledby={`news-${e.id}`}>
            <h2 id={`news-${e.id}`}>
              {e.title}
              {freshIds.has(e.id) && before !== null && <span className="news-new">New</span>}
            </h2>
            <p className="news-date">{fmtDate(e.date)}</p>
            <ul>
              {e.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {e.link && (
              <p style={{ margin: 0 }}>
                {e.link.to.startsWith("/precons") || e.link.to.startsWith("/docs/") ? <a href={e.link.to}>{e.link.label}</a> : <Link to={e.link.to}>{e.link.label}</Link>}
              </p>
            )}
          </article>
        ))}
        <footer>
          <p>
            Yama is free, unofficial fan software. Personal data stays private to each account. It isn't affiliated with, endorsed by, or sponsored by Wizards of the
            Coast.
          </p>
          <p>
            Card data and images come from <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>, precon lists from{" "}
            <a href="https://mtgjson.com" target="_blank" rel="noreferrer">MTGJSON</a>, and bracket estimates and combos from{" "}
            <a href="https://commanderspellbook.com" target="_blank" rel="noreferrer">Commander Spellbook</a>.
          </p>
        </footer>
      </div>
    </main>
  );
}
