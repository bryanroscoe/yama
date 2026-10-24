// What happened in a game, and the card reader's facts (GInspector, GZones' captions and
// reveals; the review's build plan section 10). The server sends each viewer only the events they
// may know (play/src/feed.rs). Only facts: no summaries, no advice (Bryan's decision 3, 2026-10-23).

import { counterName } from "./Tiles";
import type { CardView, Came, Happening, Seen, View } from "./types";

/** How the board names seats in sentences. */
export interface Names {
  you: number | null;
  /** "You", a friend's name, the computer's commander: to start a sentence. */
  Who: (seat: number) => string;
}

/** A card as the viewer knows it: its name, or "a card" / "a face-down card". */
export function cardName(s: Seen | undefined): string {
  if (s?.name) return s.name;
  return s?.face_down ? "a face-down card" : "a card";
}

/** "A", "A and B", "A, B and C". */
export function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How a card in a graveyard, exile or the command zone got there, for the zone sheet (GZones). */
export function cameText(c: Came): string {
  const t = `turn ${c.turn}`;
  switch (c.how) {
    case "destroyed":
      return `Destroyed, ${t}`;
    case "sacrificed":
      return `Sacrificed, ${t}`;
    case "discarded":
      return `Discarded, ${t}`;
    case "milled":
      return `Milled, ${t}`;
    case "countered":
      return `Countered, ${t}`;
    case "left":
      return `Left the game with its owner, ${t}`;
  }
  switch (c.from) {
    case "stack":
      return `Cast, ${t}`;
    case "battlefield":
      return `Left the battlefield, ${t}`;
    case "hand":
      return `From a hand, ${t}`;
    case "library":
      return `From a library, ${t}`;
    case "graveyard":
      return `From a graveyard, ${t}`;
    case "exile":
      return `From exile, ${t}`;
    default:
      return `Turn ${c.turn}`;
  }
}

export type Shown = Extract<Happening, { kind: "revealed" | "looked" }>;

/** Reveals (to everyone, or a private look) newer than `after`, for the reveal panel. */
export function revealsAfter(events: Happening[], after: number): Shown[] {
  return events.filter((h): h is Shown => (h.kind === "revealed" || h.kind === "looked") && h.seq > after);
}

/**
 * Reveals newer than `after` in groups: a run of reveals by the same player with nothing else
 * between them (two Goblin Guides attacking reveal two cards) shows as one panel.
 */
export function revealGroups(events: Happening[], after: number): Shown[][] {
  const out: Shown[][] = [];
  let run: Shown[] = [];
  for (const h of events) {
    if (h.seq <= after) continue;
    const shown = h.kind === "revealed" || h.kind === "looked";
    const last = run[run.length - 1];
    if (shown && last && last.kind === h.kind && last.seat === h.seat) {
      run.push(h);
      continue;
    }
    if (run.length) out.push(run);
    run = shown ? [h] : [];
  }
  if (run.length) out.push(run);
  return out;
}

// ── reading a card (GInspector) ───────────────────────────────────────────

/** One face of a card's Oracle text and type line. Two-faced cards come as "front\n//\nback". */
export function faceOf(text: string, typeLine: string, back: boolean): { text: string; type: string; faces: number } {
  const texts = text.split("\n//\n");
  const types = typeLine.split(" // ");
  const i = back && texts.length > 1 ? 1 : 0;
  return { text: texts[i] ?? text, type: types[back && types.length > 1 ? 1 : 0] ?? typeLine, faces: Math.max(texts.length, types.length) };
}

export type InspectorTab = "text" | "now" | "rulings";

/** The inspector's tabs: "On the battlefield" only for a permanent. */
export function inspectorTabs(card: CardView, onField: boolean): { id: InspectorTab; label: string }[] {
  return [
    { id: "text", label: "Card text" },
    ...(onField && card.id >= 0 ? [{ id: "now" as const, label: "On the battlefield" }] : []),
    { id: "rulings", label: "Rulings" },
  ];
}

/** The facts on the inspector's "On the battlefield" tab, as label and value. */
export function inspectorFacts(card: CardView, view: View, n: Names, cardById: Map<number, CardView>, tax: number): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];
  const isCreature = card.power !== null && card.toughness !== null;
  if (isCreature) {
    const base = card.base_power !== undefined || card.base_toughness !== undefined ? `, base ${card.base_power ?? "?"}/${card.base_toughness ?? "?"}` : "";
    rows.push({ k: "Power and toughness", v: `${card.power}/${card.toughness}${base}` });
    rows.push({ k: "Damage this turn", v: `${card.damage}` });
  }
  if (card.loyalty !== null) rows.push({ k: "Loyalty", v: `${card.loyalty}` });
  const counters = Object.entries(card.counters).filter(([k]) => !(card.loyalty !== null && k === "loyalty"));
  rows.push({ k: "Counters", v: counters.length ? counters.map(([k, v]) => `${v} ${counterName(k)}`).join(", ") : "None" });
  const ctrl = card.controller === n.you ? "You" : n.Who(card.controller);
  const owner = card.owner === n.you ? "you" : n.Who(card.owner);
  rows.push({ k: "Controller and owner", v: card.controller === card.owner ? ctrl : `${ctrl} control${card.controller === n.you ? "" : "s"} it; ${owner} own${card.owner === n.you ? "" : "s"} it` });
  if (card.commander) rows.push({ k: "Commander tax", v: tax ? `{${tax}} for the next cast` : "None yet" });
  const on = card.attachments?.map((id) => cardById.get(id)?.name).filter((x): x is string => !!x) ?? [];
  const to = attachedTo(card, cardById, view, n);
  rows.push({ k: "Attached", v: to ? `Attached to ${to}${on.length ? `; ${list(on)} on it` : ""}` : on.length ? list(on) : "Nothing" });
  rows.push({ k: "Tapped", v: card.tapped ? "Tapped" : "Untapped" });
  if (card.entered !== undefined) rows.push({ k: "Entered the battlefield", v: `Turn ${card.entered}${card.sick ? ", summoning sick" : ""}` });
  return rows;
}

/** What an Aura or Equipment is attached to (the engine's `{type, data}` shape). */
function attachedTo(card: CardView, cardById: Map<number, CardView>, view: View, n: Names): string | null {
  const a = card.attached_to as { type?: string; data?: number } | null;
  if (!a || a.data === undefined) return null;
  if (a.type === "Player") return a.data === n.you ? "you" : n.Who(a.data);
  return cardById.get(a.data)?.name ?? view.battlefield.find((c) => c.id === a.data)?.name ?? "a permanent";
}
