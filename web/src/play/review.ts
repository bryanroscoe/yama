// Looking back at what just happened (Bryan, 17 Nov 2026: "things are going by way too fast…
// be nice if I could rewind when I had a timeline or something to go back to"). The pure parts of
// the callout about something done to you (HitCues.tsx) and the step-through timeline
// (WhatHappened.tsx), from the events the server sent this viewer (play/src/feed.rs).

import { lineText, sinceLastTurn, tableTurn, type Names } from "./feed";
import type { Happening, Seen } from "./types";

/**
 * What another player did to you or your cards among the events after `after`: a card of yours
 * that left the battlefield by someone else's hand (destroyed, exiled, returned, sacrificed at their
 * say, or dead from their damage), control taken from you, and damage, life or poison you took from
 * someone else outside combat (combat has its own cues, CombatCues.tsx). `mine` says whether a card
 * on the battlefield is yours, for damage to your creatures.
 */
export function hitsOnYou(events: Happening[], after: number, you: number | null, mine: (id: number) => boolean = () => false): Happening[] {
  if (you === null) return [];
  return events.filter((h) => {
    if (h.seq <= after) return false;
    switch (h.kind) {
      case "moved":
        if (h.owner !== you || h.from !== "battlefield" || h.to === "battlefield" || h.how === "left") return false;
        // A named cause: someone else's. Unnamed: a creature of yours that died on someone else's turn.
        return h.by_seat !== undefined ? h.by_seat !== you : !!h.creature && h.how !== "sacrificed" && h.active !== you;
      case "control":
        return h.from === you && h.to !== you;
      case "damage":
        if (h.combat || h.by === you) return false;
        return h.to.kind === "player" ? h.to.seat === you : h.to.card.id !== undefined && mine(h.to.card.id);
      case "life":
        return h.seat === you && h.delta < 0 && h.active !== you;
      case "poison":
        return h.seat === you && h.delta > 0 && h.active !== you;
      default:
        return false;
    }
  });
}

/** The cards a happening shows, the one that did it first: name and, while it's still on the board, id. */
export function happeningCards(h: Happening): Seen[] {
  const out: Seen[] = [];
  const add = (s: Seen | undefined) => {
    if (s?.name && !out.some((o) => o.name === s.name && o.id === s.id)) out.push(s);
  };
  switch (h.kind) {
    case "moved":
      add(h.by);
      add(h.card);
      break;
    case "control":
      add(h.by);
      add(h.card);
      break;
    case "damage":
      add(h.source);
      if (h.to.kind === "card") add(h.to.card);
      break;
    case "attack":
      for (const a of h.attacks) {
        add(a.card);
        if (a.at.kind === "card") add(a.at.card);
      }
      break;
    case "block":
      for (const [b, a] of h.blocks) {
        add(b);
        add(a);
      }
      break;
    case "cast":
    case "land":
    case "activated":
    case "token":
    case "counters":
    case "transformed":
      add(h.card);
      break;
    case "revealed":
    case "looked":
    case "drew":
      h.cards.forEach(add);
      break;
    default:
      break;
  }
  return out;
}

export interface Step {
  h: Happening;
  text: string;
  /** Whose turn it was and which: "Worf, turn 4". */
  head: string;
}

/**
 * The steps of the timeline, oldest first: every line the log would show since your last turn
 * (everything there is, before your first turn ends), each with its turn's heading.
 */
export function reviewSteps(events: Happening[], n: Names): Step[] {
  const from = sinceLastTurn(events, n.you);
  const out: Step[] = [];
  for (const h of events) {
    if (h.seq < from || h.kind === "turn") continue;
    const text = lineText(h, n);
    if (!text) continue;
    out.push({ h, text, head: `${h.active === n.you ? "Your" : `${n.Who(h.active)}'s`} turn ${tableTurn(n, h.turn)}` });
  }
  return out;
}
