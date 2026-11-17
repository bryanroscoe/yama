// The game log (design/screens/GLog; the review's build plan section 11). A list of what happened,
// grouped by turn, from the events the server sent this viewer (play/src/feed.rs). Filters: since
// your last turn (a factual list, never a summary), about you, spells, combat, the whole game.
// An answer Yama gave for you from memory is tagged Automatic, with Turn off.

import { useEffect, useRef, useState } from "react";
import { SymbolText } from "../components/ManaSymbols";
import { Button, Dialog, DialogHead } from "../components/ui";
import { aboutMe, LOG_FILTERS, lineCard, list, logRows, type LogFilter, type Names } from "./feed";
import { happeningCards } from "./review";
import { answerOf } from "./turns";
import type { Act, CardMeta, Happening, LogLine, Seen, TurnsView } from "./types";

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
  /** Read a card the log shows, as on the board. */
  onRead?: (name: string, id?: number) => void;
  /** Step through what happened since your last turn (WhatHappened.tsx). */
  onReview?: () => void;
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
          {props.onReview && (
            <Button className="glog-review" variant="outline" size="small" onClick={props.onReview}>
              Step through what happened
            </Button>
          )}
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
              Card art from Scryfall, © Wizards of the Coast{artists(rows, meta)}.{events.length >= 300 ? " The log keeps the most recent lines." : ""}
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

/** The artists of the card art the log's lines show: ", art by A, B and C". */
function artists(rows: ReturnType<typeof logRows>, meta: Record<string, CardMeta>): string {
  const names = new Set<string>();
  for (const r of rows) {
    if (!r.item) continue;
    for (const c of thumbsOf(r.item, meta)) {
      const a = meta[c.name!]?.artist;
      if (a) names.add(a);
    }
  }
  return names.size ? `; art by ${list([...names])}` : "";
}

/**
 * The cards a line shows with art, the one that did it first: Vindicate, then Kinsbaile Cavalier
 * for "Worf's Vindicate destroyed your Kinsbaile Cavalier". Two at most; a line that names no card
 * with art shows the card it's mostly about, if any.
 */
function thumbsOf(h: Happening, meta: Record<string, CardMeta>): Seen[] {
  const two = h.kind === "moved" || h.kind === "control" || h.kind === "damage" ? happeningCards(h).filter((c) => c.name && meta[c.name]?.art).slice(0, 2) : [];
  if (two.length) return two;
  const name = lineCard(h);
  return name && meta[name]?.art ? [{ name, id: h.kind === "moved" ? h.card.id : undefined }] : [];
}

function Row({ h, text, names, meta, art, turns, connected, onPref, onRead }: { h: Happening; text: string } & Parameters<typeof GameLog>[0]) {
  // The cards a line is about, readable like any card on the board; for a line about a player
  // (a draw, life, a knockout), their art.
  const cards = thumbsOf(h, meta);
  const seat = "seat" in h ? h.seat : h.kind === "over" ? h.winner : undefined;
  const seatArt = !cards.length && seat !== undefined ? art(seat) : null;
  const mine = aboutMe(h, names.you);
  // An answer Yama gave for you from memory (GLog): turn it off from here.
  const auto = h.kind === "automatic";
  const answer = auto ? answerOf({ turn: h.turn, text, auto: h.answer }, turns) : null;
  return (
    <li className={`glog-row${auto ? " auto" : ""}`}>
      <span className="glog-thumbs">
        {cards.map((c) =>
          onRead ? (
            <Button key={`${c.name}-${c.id ?? ""}`} className="glog-thumb" onClick={() => onRead(c.name!, c.id)} onContextMenu={(e) => (e.preventDefault(), onRead(c.name!, c.id))} aria-label={`Read ${c.name}`}>
              <img src={meta[c.name!]!.art!} alt="" />
            </Button>
          ) : (
            <img key={c.name} src={meta[c.name!]!.art!} alt="" />
          ),
        )}
        {seatArt && <img src={seatArt} alt="" />}
        {!cards.length && !seatArt && <span className="glog-blank" aria-hidden="true" />}
      </span>
      <span>
        <SymbolText text={text} />
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
