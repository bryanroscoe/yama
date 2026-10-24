// What happened in a game, in words (GLog, GZones' captions, GKnockout, GGameOver; the review's
// build plan section 11). The server sends each viewer only the events they may know
// (play/src/feed.rs); this file writes them as plain sentences and sorts them for the log's
// filters. Only facts: no summaries, no advice (Bryan's decision 3, 2026-10-23).

import { counterName } from "./Tiles";
import { shortName } from "./text";
import type { CardView, Came, Happening, Hit, Out, PlayerView, Seen, View, Why } from "./types";

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

/** Names counted: "Spirit ×2, Terra". */
function counted(names: string[]): string[] {
  const n = new Map<string, number>();
  for (const x of names) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name));
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** "your", "Sam's": whose something is. */
function whose(seat: number, n: Names): string {
  return seat === n.you ? "your" : `${n.Who(seat)}'s`;
}

/** The subject of a sentence: "You", "Sam". */
const subject = (seat: number, n: Names) => n.Who(seat);

/** A player or card something was done to. */
function hitText(h: Hit, n: Names): string {
  return h.kind === "player" ? (h.seat === n.you ? "you" : n.Who(h.seat)) : cardName(h.card);
}

const ZONE: Record<string, string> = {
  library: "a library",
  hand: "a hand",
  battlefield: "the battlefield",
  graveyard: "a graveyard",
  stack: "the stack",
  exile: "exile",
  command: "the command zone",
};

/** Where a card was, said from its owner's side: "your graveyard", "Sam's hand", "exile". */
function zoneOf(zone: string | undefined, owner: number, n: Names): string {
  if (!zone) return "nowhere";
  if (zone === "library" || zone === "hand" || zone === "graveyard") return `${whose(owner, n)} ${zone}`;
  return ZONE[zone] ?? zone;
}

/**
 * One happening as a sentence, or null when it makes no line of its own (a turn, which heads its
 * group; a spell going to the graveyard as it resolves, which its cast line already covers).
 */
export function lineText(h: Happening, n: Names): string | null {
  switch (h.kind) {
    case "turn":
      return null;
    case "cast":
      return `${subject(h.seat, n)} cast ${cardName(h.card)}.`;
    case "land":
      return `${subject(h.seat, n)} played ${cardName(h.card)}.`;
    case "activated":
      return `${subject(h.seat, n)} activated an ability of ${cardName(h.card)}.`;
    case "moved":
      return movedText(h, n);
    case "damage": {
      const life = h.life ? `, ${h.life[0]} → ${h.life[1]}` : "";
      return `${cardName(h.source)} dealt ${h.amount} ${h.combat ? "combat " : ""}damage to ${hitText(h.to, n)}${life}.`;
    }
    case "life": {
      const before = h.total === undefined ? null : h.total - h.delta;
      const change = h.delta < 0 ? `lost ${-h.delta} life` : `gained ${h.delta} life`;
      return `${subject(h.seat, n)} ${change}${before === null ? "" : `, ${before} → ${h.total}`}.`;
    }
    case "poison":
      return h.delta > 0
        ? `${subject(h.seat, n)} got ${h.delta} poison ${plural(h.delta, "counter")}.`
        : `${subject(h.seat, n)} lost ${-h.delta} poison ${plural(-h.delta, "counter")}.`;
    case "attack": {
      // One sentence per player or permanent attacked.
      const by = new Map<string, { at: Hit; names: string[] }>();
      for (const a of h.attacks) {
        const key = a.at.kind === "player" ? `p${a.at.seat}` : `c${a.at.card.id ?? cardName(a.at.card)}`;
        const g = by.get(key) ?? { at: a.at, names: [] };
        g.names.push(cardName(a.card));
        by.set(key, g);
      }
      return [...by.values()].map((g) => `${list(counted(g.names))} attacked ${hitText(g.at, n)}.`).join(" ");
    }
    case "block":
      return h.blocks.map(([b, a]) => `${cardName(b)} blocked ${cardName(a)}.`).join(" ");
    case "token": {
      const name = cardName(h.card);
      return h.count === 1 ? `${subject(h.seat, n)} created ${article(name)} ${name} token.` : `${subject(h.seat, n)} created ${h.count} ${name} tokens.`;
    }
    case "counters": {
      const k = counterName(h.counter);
      const m = Math.abs(h.delta);
      return h.delta > 0 ? `${cardName(h.card)} got ${m} ${k} ${plural(m, "counter")}.` : `${cardName(h.card)} lost ${m} ${k} ${plural(m, "counter")}.`;
    }
    case "control":
      return `${subject(h.to, n)} gained control of ${cardName(h.card)}.`;
    case "transformed":
      return `${cardName(h.card)} transformed.`;
    case "revealed":
      return `${subject(h.seat, n)} revealed ${list(h.cards.map(cardName))}.`;
    case "looked":
      return `${subject(h.seat, n)} looked at ${list(h.cards.map(cardName))}${h.whose !== undefined && h.whose !== h.seat ? `, from ${whose(h.whose, n)} cards` : ""}.`;
    case "drew":
      return h.cards.length
        ? `${subject(h.seat, n)} drew ${list(h.cards.map(cardName))}.`
        : `${subject(h.seat, n)} drew ${h.count === 1 ? "a card" : `${h.count} cards`}.`;
    case "automatic":
      // What Yama did for an answer it remembers itself ("paid {1} for Ben's Rhystic Study").
      if (h.did) return `Yama ${h.did}, as you asked.`;
      return `Yama answered ${h.accept ? "yes" : "no"} for ${h.name}, as you asked.`;
    case "out":
      return `${subject(h.seat, n)} ${h.seat === n.you ? "are" : "is"} out.`;
    case "over":
      return h.winner === undefined ? "The game is a draw." : `${subject(h.winner, n)} won.`;
  }
}

function movedText(h: Extract<Happening, { kind: "moved" }>, n: Names): string | null {
  const card = cardName(h.card);
  const by = h.by ? ` by ${cardName(h.by)}` : "";
  switch (h.how) {
    case "destroyed":
      return `${card} was destroyed${by}.`;
    case "sacrificed":
      return `${card} was sacrificed.`;
    case "discarded":
      return `${subject(h.owner, n)} discarded ${card}.`;
    case "milled":
      return `${subject(h.owner, n)} milled ${card}.`;
    case "countered":
      return `${card} was countered${by}.`;
    case "left":
      return `${card} left the game with its owner.`;
  }
  const from = h.from;
  switch (h.to) {
    case "graveyard":
      // A spell going to the graveyard as it resolves: its cast line said it.
      if (from === "stack") return null;
      if (from === "battlefield") return h.creature ? `${card} died.` : `${card} was put into ${whose(h.owner, n)} graveyard.`;
      return `${card} was put into ${whose(h.owner, n)} graveyard from ${zoneOf(from, h.owner, n)}.`;
    case "exile":
      return `${card} was exiled from ${zoneOf(from, h.owner, n)}.`;
    case "hand":
      return from === "battlefield" ? `${card} returned to ${whose(h.owner, n)} hand.` : `${card} was put into ${whose(h.owner, n)} hand from ${zoneOf(from, h.owner, n)}.`;
    case "library":
      return `${card} was put into ${whose(h.owner, n)} library from ${zoneOf(from, h.owner, n)}.`;
    case "battlefield":
      return from === "graveyard" || from === "exile"
        ? `${card} returned to the battlefield from ${zoneOf(from, h.owner, n)}.`
        : `${card} was put onto the battlefield from ${zoneOf(from, h.owner, n)}.`;
    case "command":
      return `${card} went to the command zone.`;
    default:
      return `${card} moved to ${zoneOf(h.to, h.owner, n)}.`;
  }
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

// ── the log's filters (GLog) ─────────────────────────────────────────────

export type LogFilter = "since" | "me" | "spells" | "combat" | "all";

export const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: "since", label: "Since my last turn" },
  { id: "me", label: "About me" },
  { id: "spells", label: "Spells" },
  { id: "combat", label: "Combat" },
  { id: "all", label: "Whole game" },
];

/** Whether a happening is about `you`: something you did, or something done to you or your cards. */
export function aboutMe(h: Happening, you: number | null): boolean {
  if (you === null) return false;
  switch (h.kind) {
    case "cast":
    case "land":
    case "activated":
    case "life":
    case "poison":
    case "token":
    case "revealed":
    case "looked":
    case "drew":
    case "automatic":
    case "out":
    case "turn":
      return h.seat === you;
    case "moved":
      return h.owner === you;
    case "damage":
      return h.by === you || (h.to.kind === "player" && h.to.seat === you);
    case "attack":
      return h.seat === you || h.attacks.some((a) => a.at.kind === "player" && a.at.seat === you);
    case "block":
      return h.seat === you;
    case "control":
      return h.from === you || h.to === you;
    case "over":
      return h.winner === you;
    default:
      return false;
  }
}

export function inFilter(h: Happening, f: LogFilter, you: number | null): boolean {
  switch (f) {
    case "me":
      return aboutMe(h, you);
    case "spells":
      return h.kind === "cast" || (h.kind === "moved" && h.how === "countered");
    case "combat":
      return h.kind === "attack" || h.kind === "block" || (h.kind === "damage" && !!h.combat);
    default:
      return true;
  }
}

/**
 * Where "Since my last turn" starts: the first turn after your most recent one that's over. On
 * your turn that's after your previous turn, so this turn's own lines are in it. Before your first
 * turn ends, everything.
 */
export function sinceLastTurn(events: Happening[], you: number | null): number {
  const turns = events.filter((h) => h.kind === "turn");
  if (you === null || !turns.length) return 0;
  const current = turns[turns.length - 1]!;
  const mine = turns.filter((t) => t.kind === "turn" && t.seat === you && t.seq !== current.seq);
  const last = mine[mine.length - 1];
  if (!last) return 0;
  const after = turns.find((t) => t.seq > last.seq);
  return after ? after.seq : last.seq;
}

export interface LogRow {
  /** A turn's heading: whose turn it was. */
  head?: { seat: number; turn: number };
  item?: Happening;
  text?: string;
}

/** The log's rows for one filter, oldest first: a heading for each turn (whose it was, from each
 * line's own turn, so lines from before the first turn the log holds still get one), then its
 * lines. A heading shows only when one of its lines does. */
export function logRows(events: Happening[], f: LogFilter, n: Names): LogRow[] {
  const from = f === "since" ? sinceLastTurn(events, n.you) : 0;
  const out: LogRow[] = [];
  let shown: string | null = null;
  for (const h of events) {
    if (h.seq < from || h.kind === "turn") continue;
    if (!inFilter(h, f, n.you)) continue;
    const text = lineText(h, n);
    if (!text) continue;
    const key = `${h.turn}:${h.active}`;
    if (key !== shown) {
      out.push({ head: { seat: h.active, turn: h.turn } });
      shown = key;
    }
    out.push({ item: h, text });
  }
  return out;
}

/** The card a line is mostly about, for its art. */
export function lineCard(h: Happening): string | undefined {
  switch (h.kind) {
    case "cast":
    case "land":
    case "activated":
    case "moved":
    case "token":
    case "counters":
    case "control":
    case "transformed":
      return h.card.name;
    case "damage":
      return h.source.name;
    case "attack":
      return h.attacks[0]?.card.name;
    case "block":
      return h.blocks[0]?.[0].name;
    case "revealed":
    case "looked":
    case "drew":
      return h.cards[0]?.name;
    case "automatic":
      return h.name;
    default:
      return undefined;
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

// ── knockouts and the end (GKnockout, GRareRules, GGameOver) ──────────────

/** A knockout's cause in words: "21 commander damage from your Éowyn", "at 0 life". Empty when
 * nothing on the board says. */
export function whyText(w: Why, n: Names): string {
  switch (w.kind) {
    case "conceded":
      return "conceded";
    case "commander":
      return `${w.damage} commander damage from ${w.seat === n.you ? "your" : `${n.Who(w.seat)}'s`} ${shortName(w.name)}`;
    case "poison":
      return `${w.count} poison counters`;
    case "life":
      return `at ${w.life} life`;
    case "library":
      return "drew from an empty library";
    case "unknown":
      return "";
  }
}

/** "Out on turn 9: 21 commander damage from your Éowyn", "Conceded on turn 7". */
export function outText(o: Out, n: Names): string {
  if (o.why.kind === "conceded") return `Conceded on turn ${o.turn}`;
  const why = whyText(o.why, n);
  return why ? `Out on turn ${o.turn}: ${why}` : `Out on turn ${o.turn}`;
}

/** Said beside a cause Yama read from the board rather than the engine stating it. */
export const INFERRED = "Cause worked out by Yama from the board";

export interface Standing {
  seat: number;
  /** "1", "=1", "4"; empty while they're still playing. */
  place: string;
  how: string;
  life: number;
  out?: Out;
}

/**
 * Places: the winner first, then everyone by when they went out, the last out highest. Players
 * who went out together share a place ("=1" when two players lose at once and the game is drawn).
 * While the game goes on, players still in have no place.
 */
export function standings(players: PlayerView[], outs: Out[], winner: number | null, over: boolean, n: Names): Standing[] {
  const batches = [...new Set(outs.map((o) => o.batch))].sort((a, b) => a - b);
  let remaining = players.length;
  const place = new Map<number, string>();
  for (const b of batches) {
    const group = outs.filter((o) => o.batch === b);
    const p = remaining - group.length + 1;
    for (const o of group) place.set(o.seat, group.length > 1 ? `=${p}` : `${p}`);
    remaining -= group.length;
  }
  const rows = players.map((pl): Standing => {
    const out = outs.find((o) => o.seat === pl.seat);
    if (out) return { seat: pl.seat, place: place.get(pl.seat) ?? "", how: outText(out, n), life: out.life, out };
    if (over && winner === pl.seat) return { seat: pl.seat, place: "1", how: "Winner", life: pl.life };
    return { seat: pl.seat, place: over ? `${remaining}` : "", how: over ? "" : `Playing, ${pl.life} life`, life: pl.life };
  });
  const rank = (s: Standing) => (s.place ? Number(s.place.replace("=", "")) : 0);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/** The last player out before the end, with their cause: "Jules, at 0 life". */
export function lastOut(outs: Out[], n: Names): string | null {
  const o = outs[outs.length - 1];
  if (!o) return null;
  if (o.why.kind === "conceded") return `${n.Who(o.seat)}, by conceding`;
  const why = whyText(o.why, n);
  return why ? `${n.Who(o.seat)}, ${why}` : n.Who(o.seat);
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
