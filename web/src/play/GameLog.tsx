// The game log (design/screens/GLog; the review's build plan section 11). A list of what happened,
// grouped by turn, from the events the server sent this viewer (play/src/feed.rs). Filters: since
// your last turn (a factual list, never a summary), about you, spells, combat, the whole game.
// An answer Yama gave for you from memory is tagged Automatic, with Turn off.

import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogHead } from "../components/ui";
import { aboutMe, LOG_FILTERS, lineCard, logRows, type LogFilter, type Names } from "./feed";
import { answerOf } from "./turns";
import type { Act, CardMeta, Happening, LogLine, TurnsView } from "./types";

export function GameLog(props: {
  events: Happening[] | undefined;
  /** Older servers' log lines, when there are no events. */
  lines: LogLine[];
  names: Names;
  meta: Record<string, CardMeta>;
  tone: (seat: number) => string | undefined;
  art: (seat: number) => string | null;
  turns: TurnsView | undefined;
  connected: boolean;
  onPref: (a: Act) => void;
  onClose: () => void;
  /** Older servers' "Player 3" in log text, named. */
  named: (text: string) => string;
}) {
  const { events, names, meta } = props;
  const [filter, setFilter] = useState<LogFilter>(names.you === null ? "all" : "since");
  const rows = events ? logRows(events, filter, names) : [];
  // The newest lines are at the bottom: open there, and there again when the filter changes.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current?.closest(".sheet");
    if (el) el.scrollTop = el.scrollHeight;
  }, [filter]);
  return (
    <Dialog label="Game log" onClose={props.onClose}>
      <div className="glog">
        {/* The title and filters stay put while the lines scroll under them. */}
        <div className="glog-top">
          <DialogHead>Game log</DialogHead>
          {events && (
            <div className="glog-filters" role="group" aria-label="Show">
              {LOG_FILTERS.filter((f) => names.you !== null || f.id === "all" || f.id === "spells" || f.id === "combat").map((f) => (
                <Button key={f.id} className={`glog-filter${filter === f.id ? " on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        {events ? (
          <>
            <ol className="glog-list" ref={list}>
              {rows.map((r) =>
                r.head ? (
                  <li key={`h${r.head.seat}-${r.head.turn}-${rows.indexOf(r)}`} className="glog-head" style={props.tone(r.head.seat) ? ({ ["--seat" as string]: `var(--${props.tone(r.head.seat)})` } as React.CSSProperties) : undefined}>
                    <span className="seat-dot" aria-hidden="true" />
                    {r.head.seat === names.you ? "You" : names.Who(r.head.seat)}, turn {r.head.turn}
                  </li>
                ) : (
                  <Row key={r.item!.seq} h={r.item!} text={r.text!} {...props} />
                ),
              )}
              {!rows.length && <li className="dim glog-empty">{filter === "since" ? "Nothing yet since your last turn." : "Nothing to show yet."}</li>}
            </ol>
            <p className="small dim glog-foot">
              Card art from Scryfall, © Wizards of the Coast.{events.length >= 300 ? " The log keeps the most recent lines." : ""}
            </p>
          </>
        ) : (
          // An older server: its log lines as they come.
          <ol className="pb-log">
            {[...props.lines].reverse().map((l, i) => (
              <li key={i}>
                <span className="dim small num">T{l.turn}</span> {props.named(l.text)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Dialog>
  );
}

function Row({ h, text, names, meta, art, turns, connected, onPref }: { h: Happening; text: string } & Parameters<typeof GameLog>[0]) {
  const name = lineCard(h);
  // The card a line is about; for a line about a player (a draw, life, a knockout), their art.
  const seat = "seat" in h ? h.seat : h.kind === "over" ? h.winner : undefined;
  const img = (name && meta[name]?.art) || (seat !== undefined ? art(seat) : null);
  const mine = aboutMe(h, names.you);
  // An answer Yama gave for you from memory (GLog): turn it off from here.
  const auto = h.kind === "automatic";
  const answer = auto ? answerOf({ turn: h.turn, text, auto: h.answer }, turns) : null;
  return (
    <li className={`glog-row${auto ? " auto" : ""}`}>
      {img ? <img src={img} alt="" /> : <span className="glog-blank" aria-hidden="true" />}
      <span>
        {text}
        {auto &&
          (answer ? (
            <>
              {" "}
              <Button className="link" onClick={() => onPref(answer.forget)} disabled={!connected}>
                Turn off
              </Button>
            </>
          ) : (
            <span className="dim small"> Turned off</span>
          ))}
      </span>
      {auto ? <span className="log-tag">Automatic</span> : mine ? <span className="log-tag you">You</span> : <span />}
    </li>
  );
}
