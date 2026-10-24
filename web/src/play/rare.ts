// The rarer cards and rules on the board (GRareCards, GRareRules; play/src/rare.rs): the
// ninjutsu pick the board puts together from the engine's options, the act a special action
// sends, the dungeon room map's layout, time travel's steps and what a face-down card shows. Pure,
// so it's tested; Decide.tsx and Board.tsx draw them.

import type { TimeMove } from "./answer";
import type { Act, CardView, DungeonMap, OptionView, Pending } from "./types";

/**
 * The act a special action option sends (the engine's own option, matched by the server):
 * turning a card face up, foretelling, putting your companion into your hand, Serum Powder.
 * Ninjutsu isn't sent from its option: the board first asks which attacker (`ninjutsuPick`).
 */
export function specialAct(o: OptionView): Act | null {
  switch (o.kind) {
    case "face_up":
      return o.object === null ? null : { kind: "turn_face_up", object: o.object };
    case "foretell":
      return o.object === null ? null : { kind: "foretell", object: o.object };
    case "companion":
      return { kind: "companion_to_hand" };
    case "serum_powder":
      return o.object === null ? null : { kind: "use_serum_powder", object: o.object };
    default:
      return null;
  }
}

/**
 * Options as the rail lists them: a ninja's options (one per attacker it could return) are one
 * button, "Ninjutsu {1}{U}", which starts the pick on the board (GRareCards).
 */
export function collapseNinjutsu(os: OptionView[]): OptionView[] {
  const seen = new Set<number>();
  const out: OptionView[] = [];
  for (const o of os) {
    if (o.kind !== "ninjutsu") {
      out.push(o);
      continue;
    }
    if (o.object === null || seen.has(o.object)) continue;
    seen.add(o.object);
    out.push({ ...o, label: o.cost ? `Ninjutsu ${o.cost}` : "Ninjutsu" });
  }
  return out;
}

/**
 * Ninjutsu's pick (GRareCards): your attacking creatures on the board, amber where the engine
 * lets the ninja return them (unblocked), with the ninja as the card asking. Answered with
 * `act` "ninjutsu" by the main button. `null` when the card has no ninjutsu option.
 */
export function ninjutsuPick(card: number, options: OptionView[], battlefield: CardView[], hand: CardView[], you: number): Pending | null {
  const mine = options.filter((o) => o.kind === "ninjutsu" && o.object === card);
  if (!mine.length) return null;
  const returnable = new Set(mine.map((o) => (o.target?.kind === "object" ? o.target.id : -1)));
  // In your hand (or, for commander ninjutsu, the command zone).
  const ninja = hand.find((c) => c.id === card) ?? battlefield.find((c) => c.id === card);
  const cost = mine[0]!.cost;
  const attackers = battlefield.filter((c) => c.controller === you && c.attacking);
  return {
    kind: "pick",
    answer: "ninjutsu",
    purpose: "ninjutsu",
    prompt: cost ? `Ninjutsu ${cost}: choose an unblocked attacker to return to your hand` : "Ninjutsu: choose an unblocked attacker to return to your hand",
    source: { id: card, name: ninja?.name ?? "Ninjutsu", controller: you },
    // A face-down attacker is named for you by what it is (only its controller picks here).
    options: attackers.map((c) => ({ id: String(c.id), name: c.face_down ? (c.under ? `Face-down ${c.under}` : "Face-down card") : c.name, zone: "battlefield", controller: c.controller, eligible: returnable.has(c.id), toughness: c.toughness ?? undefined })),
    min: 1,
    max: 1,
    upTo: false,
    zone: "battlefield",
    cost,
  };
}

/** What a face-down card says on its tile (GRareCards): "Face down", then what it is for its controller, else "No name". */
export function faceDownWords(c: CardView): { head: string; name: string } {
  return { head: "Face down", name: c.under ?? "No name" };
}

/** A room's place in the map's box: its spot on the dungeon card (thousandths), scaled. */
export function roomSpot(map: DungeonMap, index: number, width: number, height: number): { x: number; y: number } {
  const r = map.rooms.find((x) => x.index === index);
  if (!r) return { x: 0, y: 0 };
  // The engine's spots span the card; rooms sit between about 15% and 95% of its height.
  const ys = map.rooms.map((x) => x.y);
  const xs = map.rooms.map((x) => x.x);
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const fx = x1 > x0 ? (r.x - x0) / (x1 - x0) : 0.5;
  const fy = y1 > y0 ? (r.y - y0) / (y1 - y0) : 0.5;
  return { x: fx * width, y: fy * height };
}

/** Where the marker can go from the room it's on (CR 309.5a): the engine's own edges. */
export function reachable(map: DungeonMap): Set<number> {
  const cur = map.rooms.find((r) => r.index === map.current);
  return new Set(cur?.next ?? []);
}

/** A card's time counters now, from its counters in words ("time"). */
export function timeCounters(counters: [string, number][] | undefined): number {
  return counters?.find(([k]) => k === "time")?.[1] ?? 0;
}

/** The time counters after a move. */
export function timeAfter(now: number, move: TimeMove): number {
  return move === "remove" ? Math.max(0, now - 1) : move === "add" ? now + 1 : now;
}

/** The moves time travel offers now: removing comes first, so only "add" is left in the add step (CR 701.56a). */
export function timeChoices(step: "remove" | "add" | undefined): TimeMove[] {
  return step === "add" ? ["leave", "add"] : ["remove", "leave", "add"];
}

/** A shortcut's count in words: "20 times", "until a player loses". */
export function shortcutCount(count: number | undefined): string {
  return count === undefined ? "until a player loses" : count === 1 ? "once" : `${count} times`;
}

/** Stepping a shortcut's stopping place (GRareRules): `null` is accepting the whole count. Down from accepting is the last place before the end; up from it stays. */
export function stepStop(value: number | null, by: -1 | 1, min: number, max: number): number | null {
  if (value === null) return by < 0 ? max : null;
  const next = value + by;
  if (next > max) return null;
  return Math.max(min, next);
}
