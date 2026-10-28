// The Cards page's release calendar: upcoming sets from Scryfall, a watch per set, and the
// Commander precons of watched sets once MTGJSON has their lists.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type CalendarRun, type CalendarSet, type CalendarView, type DeckSummary, type PreconSummary } from "../api";
import { useMe } from "../auth";
import { isNetworkError } from "../cardDetail";
import { day } from "./Rulings";
import { Details, ErrorText } from "./ui";
import {
  daysBetween,
  headlined,
  hostOf,
  isExtra,
  localToday,
  preconMade,
  previewLine,
  publishedLine,
  releaseLine,
  setTypeLabel,
  watchedPrecons,
  type PreconGroup,
} from "./calendar";
import "./calendar.css";

export function useCalendar() {
  const today = localToday();
  return useQuery({
    queryKey: ["calendar", today],
    queryFn: () => api<CalendarView>(`/api/calendar?today=${today}`),
    staleTime: 10 * 60_000,
    retry: (n, e) => !isNetworkError(e) && n < 2,
  });
}

/** "checked 19 Oct 2026" in the reader's own date. */
function checked(run: CalendarRun): string | null {
  if (!run.checked_at) return null;
  return new Date(run.checked_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Release calendar and precon watch, for the Cards page with no search. Quiet when offline. */
export function ReleaseCalendar() {
  const calendar = useCalendar();
  const groups = calendar.data ? watchedPrecons(calendar.data.upcoming) : [];
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled: groups.length > 0 });
  if (calendar.error && isNetworkError(calendar.error)) return null;
  if (calendar.error) return <ErrorText error={calendar.error} />;
  if (!calendar.data) return null;
  const view = calendar.data;
  // Wait for the reader's decks before placing precons, so a set doesn't jump from the top to
  // the bottom once they arrive.
  const placed = groups.length > 0 && !decks.isPending;
  const names = decks.data?.map((d) => d.name) ?? [];
  const top = placed ? groups.filter((g) => headlined(g, view.today, names)) : [];
  const past = placed ? groups.filter((g) => !headlined(g, view.today, names)) : [];
  return (
    <>
      {top.map((g) => (
        <PreconsOut key={g.code} group={g} today={view.today} names={names} />
      ))}
      <UpcomingSets view={view} />
      {past.map((g) => (
        <PastPrecons key={g.code} group={g} names={names} />
      ))}
    </>
  );
}

function PreconsOut({ group: g, today, names }: { group: PreconGroup; today: string; names: string[] }) {
  const ahead = g.released ? daysBetween(today, g.released) : null;
  return (
    <section className="precons-out" aria-labelledby={`out-${g.code}`}>
      <h2 id={`out-${g.code}`}>{g.setName} precons are out</h2>
      <p className="precons-out-sub">
        {publishedLine(g.precons.length)}
        {ahead != null && ahead > 0 ? `, ${ahead === 1 ? "a day" : `${ahead} days`} before release` : ""}. Start a deck from a stock list, then
        change it as you upgrade.
      </p>
      <PreconRows precons={g.precons} names={names} />
      <PreconSource precons={g.precons} />
    </section>
  );
}

/** A watched set's precons once they no longer lead the page: folded away below the calendar. */
function PastPrecons({ group: g, names }: { group: PreconGroup; names: string[] }) {
  return (
    <details className="precons-past">
      <summary>
        <span className="precons-past-title">{g.setName} precons</span>
        <span className="cal-note">
          {g.precons.length === 1 ? "1 deck" : `${g.precons.length} decks`}
          {g.released ? `, out since ${day(g.released)}` : ""}
        </span>
      </summary>
      <div className="precons-past-body">
        <PreconRows precons={g.precons} names={names} />
        <PreconSource precons={g.precons} />
      </div>
    </details>
  );
}

const startLink = (fileName: string) => `/decks/import?precon=${encodeURIComponent(fileName)}`;

function PreconRows({ precons, names }: { precons: PreconSummary[]; names: string[] }) {
  return (
    <ul className="precons-out-list">
      {precons.map((p) => {
        const made = preconMade(names, p);
        return (
          <li key={p.file_name}>
            <span className="precon-text">
              <span className="precon-name">{p.name}</span>
              {p.commanders?.length ? <span className="precon-meta">Led by {p.commanders.join(" and ")}</span> : null}
              {!made &&
                p.variants.map((v) => (
                  <span key={v.file_name} className="precon-meta">
                    Collector&rsquo;s Edition: <Link to={startLink(v.file_name)} aria-label={`Start a deck from ${v.name}`}>start from its list</Link>
                  </span>
                ))}
            </span>
            {made ? (
              <Link to="/decks" className="precon-made">In your decks</Link>
            ) : (
              <Link to={startLink(p.file_name)} className="button" aria-label={`Start a deck from ${p.name}`}>Start a deck</Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PreconSource({ precons }: { precons: PreconSummary[] }) {
  const source = precons.find((p) => p.source_url)?.source_url ?? null;
  return (
    <p className="cal-note">
      Lists from <a href="https://mtgjson.com" target="_blank" rel="noreferrer">MTGJSON</a>
      {source && hostOf(source) && (
        <>
          , which took them from{" "}
          <a href={source} target="_blank" rel="noreferrer">{hostOf(source)}</a>
        </>
      )}
      .
    </p>
  );
}

function UpcomingSets({ view }: { view: CalendarView }) {
  const me = useMe();
  const [all, setAll] = useState(false);
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (s: CalendarSet) => api(`/api/calendar/watch/${s.code}`, { method: s.watched ? "DELETE" : "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar"] }),
  });
  const extras = view.upcoming.filter(isExtra);
  const shown = all ? view.upcoming : view.upcoming.filter((s) => !isExtra(s));
  const setsChecked = checked(view.sets);
  const preconsChecked = checked(view.precons);

  return (
    <section className="upcoming" aria-labelledby="upcoming-h">
      <div className="upcoming-head">
        <h2 id="upcoming-h">Upcoming sets</h2>
        {setsChecked && <span className="cal-note">From Scryfall, checked {setsChecked}</span>}
      </div>
      {!view.sets.checked_at && (
        <p className="cal-note">
          Yama hasn't read Scryfall's set list yet.
          {view.auto_refresh
            ? " It checks once a day; the first check runs soon after the server starts."
            : me.data?.is_admin
              ? " This server doesn't check by itself: set YAMA_AUTO_IMPORT=1, or run yama-server import-calendar."
              : " Ask whoever runs this server to turn on the daily check."}
        </p>
      )}
      {view.sets.error && <p className="cal-note cal-warn">The last check failed: {view.sets.error}</p>}
      {view.sets.checked_at && shown.length === 0 && <p className="cal-note">No sets announced past today.</p>}
      {shown.length > 0 && (
        <ul className="upcoming-list">
          {shown.map((s) => {
            const out = s.released_at != null && s.released_at < view.today;
            const under = s.parent_set_code && view.upcoming.some((x) => x.code === s.parent_set_code);
            return (
              <li key={s.code} className={under ? "upcoming-set is-child" : "upcoming-set"}>
                <div className="upcoming-text">
                  {s.scryfall_uri ? (
                    <a className="upcoming-name" href={s.scryfall_uri} target="_blank" rel="noreferrer">{s.name}</a>
                  ) : (
                    <span className="upcoming-name">{s.name}</span>
                  )}
                  <span className="upcoming-meta">
                    {setTypeLabel(s.set_type)}, {releaseLine(s.released_at, view.today, day, true)}
                  </span>
                  <span className="upcoming-meta">{previewLine(s, out)}</span>
                  {s.printed_size != null && s.printed_size > s.card_count && (
                    <span className="upcoming-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round((100 * s.card_count) / s.printed_size)}%` }} />
                    </span>
                  )}
                  {s.precons.length > 0 && (
                    <span className="upcoming-meta upcoming-precons">
                      {s.precons.length === 1 ? "1 precon list is out" : `${s.precons.length} precon lists are out`}
                    </span>
                  )}
                </div>
                {s.parent_watched && !s.watched ? (
                  <span className="upcoming-via">Watched with {s.parent_name ?? s.parent_set_code}</span>
                ) : (
                  <button
                    className={s.watched ? "watch is-on" : "watch"}
                    aria-pressed={s.watched}
                    aria-label={`Watch ${s.name}`}
                    disabled={toggle.isPending && toggle.variables?.code === s.code}
                    onClick={() => toggle.mutate(s)}
                  >
                    {s.watched ? "Watching" : "Watch"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={toggle.error} />
      {extras.length > 0 && (
        <button className="quiet small" onClick={() => setAll((a) => !a)}>
          {all ? "Hide tokens, promos and other extras" : `Show ${extras.length} more: tokens, promos and other extras`}
        </button>
      )}
      <p className="cal-note">
        {preconsChecked
          ? `MTGJSON precon lists, checked ${preconsChecked}.`
          : "MTGJSON precon lists not checked yet."}
        {view.precons.error && " Its last check failed."}
      </p>
      <Details label="About release tracking">
        <p>Watch a set to see its Commander precons here once MTGJSON publishes their lists.</p>
      </Details>
    </section>
  );
}
