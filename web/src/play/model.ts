// Pure helpers for the online board: steps and stops, seat order, stacking permanents, land
// summaries, combat summaries and what the primary button says. No React here, so it's tested.

import type { AttackAt, CardMeta, CardView, Decision, OptionView, PlayerView, View } from "./types";

// ── steps and stops ────────────────────────────────────────────────────────

/** The turn's steps as the board shows them. Untap and cleanup fold into their neighbours. */
export const STEPS: { label: string; phases: string[]; name: string }[] = [
  { label: "Upkeep", phases: ["Untap", "Upkeep"], name: "upkeep" },
  { label: "Draw", phases: ["Draw"], name: "draw step" },
  { label: "Main 1", phases: ["PreCombatMain"], name: "main phase" },
  { label: "Combat", phases: ["BeginCombat"], name: "beginning of combat" },
  { label: "Attackers", phases: ["DeclareAttackers"], name: "attackers step" },
  { label: "Blockers", phases: ["DeclareBlockers"], name: "blockers step" },
  { label: "Damage", phases: ["CombatDamage", "FirstStrikeDamage", "EndCombat"], name: "combat damage step" },
  { label: "Main 2", phases: ["PostCombatMain"], name: "second main phase" },
  { label: "End", phases: ["End", "Cleanup"], name: "end step" },
];

export function stepIndex(phase: string): number {
  return STEPS.findIndex((s) => s.phases.includes(phase));
}

export function stepName(phase: string): string {
  return STEPS[stepIndex(phase)]?.name ?? phase;
}

export interface Stops {
  mine: boolean;
  opp: boolean;
}

/** Your stops by step label ("Main 1"), on your turns and on opponents' turns. */
export type StopMap = Record<string, Stops>;

/**
 * The server's default smart stops (play/src/lib.rs, should_auto_pass): your main phases, and
 * an opponent's end step when you could cast something. Declaring attackers and blockers is a
 * decision, not a priority stop: it always waits for you. Anything on the stack you could
 * answer always stops.
 */
export const DEFAULT_STOPS: StopMap = {
  "Main 1": { mine: true, opp: false },
  "Main 2": { mine: true, opp: false },
  End: { mine: false, opp: true },
};

export function stopsAt(label: string, stops: StopMap | null, fullControl: boolean): Stops {
  if (fullControl) return { mine: true, opp: true };
  return (stops ?? DEFAULT_STOPS)[label] ?? { mine: false, opp: false };
}

export function sameStops(a: StopMap, b: StopMap): boolean {
  return STEPS.every((s) => {
    const x = a[s.label] ?? { mine: false, opp: false };
    const y = b[s.label] ?? { mine: false, opp: false };
    return x.mine === y.mine && x.opp === y.opp;
  });
}

/** Your stops as the server takes them: engine phase names on your turns and on others'. */
export function stopsMessage(stops: StopMap | null): { own: string[]; others: string[] } | null {
  if (!stops || sameStops(stops, DEFAULT_STOPS)) return null;
  const own: string[] = [];
  const others: string[] = [];
  for (const s of STEPS) {
    const st = stops[s.label];
    // Untap and cleanup give no priority; they ride along with their step's label.
    const phases = s.phases.filter((p) => p !== "Untap" && p !== "Cleanup");
    if (st?.mine) own.push(...phases);
    if (st?.opp) others.push(...phases);
  }
  return { own, others };
}

/** "Also stops on your blockers step" for the rail, or null when the stops are the defaults. */
export function stopsSummary(stops: StopMap | null): string | null {
  if (!stops || sameStops(stops, DEFAULT_STOPS)) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const s of STEPS) {
    const st = stops[s.label] ?? { mine: false, opp: false };
    const d = DEFAULT_STOPS[s.label] ?? { mine: false, opp: false };
    if (st.mine && !d.mine) added.push(`your ${s.name}`);
    if (st.opp && !d.opp) added.push(`opponents' ${s.name}`);
    if (!st.mine && d.mine) removed.push(`your ${s.name}`);
    if (!st.opp && d.opp) removed.push(`opponents' ${s.name}`);
  }
  const list = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more` : xs.join(" and "));
  if (added.length && !removed.length) return `Also stops on ${list(added)}`;
  if (removed.length && !added.length) return `Skips ${list(removed)}`;
  return "Your own stops";
}

export function stopText({ mine, opp }: Stops): string {
  if (mine && opp) return "Stops on every turn.";
  if (mine) return "Stops on your turns.";
  if (opp) return "Stops on opponents' turns.";
  return "Passes unless something is on the stack.";
}

// ── seats ──────────────────────────────────────────────────────────────────

/**
 * Opponents in turn order after the bottom seat, as on MTGO: the next player on the left, then
 * across, then the previous player on the right. Seats pass to the next number (phase's normal
 * turn order).
 */
export function turnOrder(players: PlayerView[], bottom: number): PlayerView[] {
  const n = players.length;
  return players.filter((p) => p.seat !== bottom).sort((a, b) => ((a.seat - bottom + n) % n) - ((b.seat - bottom + n) % n));
}

// ── permanents ─────────────────────────────────────────────────────────────

/** One or more identical permanents shown as one tile with a ×N badge. */
export interface Pile {
  key: string;
  card: CardView;
  ids: number[];
}

export const isLand = (c: CardView) => c.types.includes("Land") && !c.types.includes("Creature");
export const isCreature = (c: CardView) => c.types.includes("Creature");

/** The object an attachment is attached to, from the engine's serialized target. */
export function attachedTo(c: CardView): number | null {
  const a = c.attached_to;
  if (typeof a === "number") return a;
  if (a && typeof a === "object") {
    for (const v of Object.values(a as Record<string, unknown>)) if (typeof v === "number") return v;
  }
  return null;
}

/**
 * Stack identical permanents (PP-14): same name, tapped or not, P/T, loyalty, damage, counters,
 * summoning sickness, combat role and commander. Permanents with something attached, and the
 * attachments themselves, never stack. Tapped and untapped copies are separate piles, so the
 * turned art shows which are tapped.
 */
export function stackPermanents(cards: CardView[]): Pile[] {
  const hosts = new Set(cards.map(attachedTo).filter((h): h is number => h !== null));
  const piles = new Map<string, Pile>();
  for (const c of cards) {
    const alone = hosts.has(c.id) || attachedTo(c) !== null || c.commander || c.name === "Face-down card";
    const key = alone
      ? `id:${c.id}`
      : [
          c.name,
          c.tapped ? "T" : "",
          c.power ?? "",
          c.toughness ?? "",
          c.loyalty ?? "",
          c.damage,
          JSON.stringify(c.counters),
          c.sick ? "S" : "",
          c.attacking ? `A${c.attacks ?? ""}` : "",
          c.blocking ? "B" : "",
        ].join("|");
    const p = piles.get(key);
    if (p) p.ids.push(c.id);
    else piles.set(key, { key, card: c, ids: [c.id] });
  }
  return [...piles.values()];
}

/**
 * A side of the battlefield in rows (PP-12): creatures, then lands, then everything else
 * (planeswalkers first). Order inside a row is stable: lands by name with tapped copies after
 * untapped ones, the rest by when they arrived (object id), so nothing jumps when it taps.
 */
export function rows(cards: CardView[]): { creatures: Pile[]; lands: Pile[]; others: Pile[] } {
  const piles = stackPermanents(cards);
  const first = (p: Pile) => Math.min(...p.ids);
  const creatures = piles.filter((p) => isCreature(p.card)).sort((a, b) => first(a) - first(b));
  const lands = piles
    .filter((p) => isLand(p.card))
    .sort((a, b) => a.card.name.localeCompare(b.card.name) || Number(a.card.tapped) - Number(b.card.tapped) || first(a) - first(b));
  const walker = (p: Pile) => (p.card.types.includes("Planeswalker") || p.card.types.includes("Battle") ? 0 : 1);
  const others = piles
    .filter((p) => !isCreature(p.card) && !isLand(p.card))
    .sort((a, b) => walker(a) - walker(b) || first(a) - first(b));
  return { creatures, lands, others };
}

// ── mana ───────────────────────────────────────────────────────────────────

const BASIC: Record<string, string> = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };

/**
 * The colors a land can make, read from its type line and rules text: "W", "UB", "*" for any
 * color, or "C". Display only (the engine decides what a land really taps for).
 */
export function landColors(name: string, meta: CardMeta | undefined): string {
  if (!meta) return BASIC[name] ?? "C";
  const text = meta.oracle_text ?? "";
  if (/mana of any (one )?color|any color in your commander/i.test(text)) return "*";
  const found = new Set<string>();
  for (const [type, key] of Object.entries(BASIC)) if (new RegExp(`\\b${type}\\b`).test(meta.type_line)) found.add(key);
  for (const clause of text.split(/\n/).filter((l) => /\badd\b/i.test(l))) {
    for (const m of clause.matchAll(/\{([WUBRG])\}/g)) found.add(m[1]!);
  }
  const keys = "WUBRG".split("").filter((k) => found.has(k)).join("");
  return keys || "C";
}

/** Untapped lands by the colors they make, plus the totals: "3 W, 2 R untapped, 8 lands". */
export function landSummary(lands: CardView[], meta: Record<string, CardMeta>): { groups: { colors: string; count: number }[]; untapped: number; total: number } {
  const counts = new Map<string, number>();
  let untapped = 0;
  for (const c of lands) {
    if (c.tapped) continue;
    untapped++;
    const colors = landColors(c.name, meta[c.name]);
    counts.set(colors, (counts.get(colors) ?? 0) + 1);
  }
  const order = (k: string) => (k === "*" ? 9 : k === "C" ? 10 : k.length > 1 ? 5 + "WUBRG".indexOf(k[0]!) / 10 : "WUBRG".indexOf(k));
  const groups = [...counts.entries()].map(([colors, count]) => ({ colors, count })).sort((a, b) => order(a.colors) - order(b.colors));
  return { groups, untapped, total: lands.length };
}

// ── combat ─────────────────────────────────────────────────────────────────

export interface CombatLine {
  attacker: number;
  defender: number;
  creatures: number;
  power: number;
}

/** Who is attacking whom right now, from the attacking creatures on the battlefield. */
export function combatLines(battlefield: CardView[]): CombatLine[] {
  const lines = new Map<string, CombatLine>();
  for (const c of battlefield) {
    if (!c.attacking || c.attacks === undefined) continue;
    const key = `${c.controller}>${c.attacks}`;
    const l = lines.get(key) ?? { attacker: c.controller, defender: c.attacks, creatures: 0, power: 0 };
    l.creatures++;
    l.power += Math.max(0, c.power ?? 0);
    lines.set(key, l);
  }
  return [...lines.values()];
}

export function combatText(l: CombatLine, name: (seat: number) => string, you: number | null): string {
  const what = `${l.creatures} ${l.creatures === 1 ? "creature" : "creatures"}, ${l.power} power`;
  if (l.attacker === you) return `Attacking ${name(l.defender)} with ${what}`;
  if (l.defender === you) return `${name(l.attacker)} attacks you with ${what}`;
  return `${name(l.attacker)} attacks ${name(l.defender)} with ${what}`;
}

export function sameTarget(a: AttackAt, b: AttackAt): boolean {
  return a.kind === b.kind && (a.kind === "player" ? a.seat === (b as { seat: number }).seat : a.id === (b as { id: number }).id);
}

// ── decisions ──────────────────────────────────────────────────────────────

/** The engine passes for you when passing is all you could do; don't flash that choice. */
export function realDecision(d: Decision | null): Decision | null {
  if (!d) return null;
  if (d.options.length === 1 && d.options[0]!.label.startsWith("Pass") && !d.attack && !d.block) return null;
  return d;
}

export const isPass = (o: OptionView) => o.label.startsWith("Pass");

/** Identical labels (two Forests) collapse to one button. */
export function dedupe(os: OptionView[]): OptionView[] {
  return os.filter((o, i, all) => all.findIndex((x) => x.label === o.label) === i);
}

/**
 * What the big button says while you hold priority (PP-32): "Resolve" with something on the
 * stack, "To combat" in your first main phase when a creature could attack, "End turn" late in
 * your turn, "Pass" on someone else's turn, otherwise "Next".
 */
export function passLabel(view: View, you: number | null): string {
  if (view.stack.length > 0) return "Resolve";
  if (view.active !== you) return "Pass";
  if (view.phase === "PreCombatMain") {
    const ready = view.battlefield.some((c) => c.controller === you && isCreature(c) && !c.tapped && !c.sick);
    return ready ? "To combat" : "Next";
  }
  if (view.phase === "PostCombatMain" || view.phase === "End" || view.phase === "Cleanup") return "End turn";
  return "Next";
}

/** "Priority" means nothing to a player; say whose step it is, or what to respond to. */
export function decisionTitle(d: Decision, view: View, you: number | null, name: (seat: number) => string, promptText: (p: string) => string): string {
  if (d.attack) return "Declare attackers";
  if (d.block) return "Declare blockers";
  if (!d.prompt.startsWith("Priority")) return promptText(d.prompt);
  const top = view.stack[view.stack.length - 1];
  if (top) return top.controller === you ? `Your ${top.name} is on the stack` : `Respond to ${top.name}`;
  const step = stepName(view.phase);
  return view.active === you ? `Your ${step}` : `${name(view.active)}'s ${step}`;
}

/** The hover preview's size on a laptop (a card at 300 px wide). */
export const PREVIEW_W = 300;
export const PREVIEW_H = Math.round(300 * (88 / 63));

/**
 * Where the hover preview goes: right beside the card it shows. Cards low on the screen (the hand)
 * get it above them; others to the right, or to the left when there's no room. Always inside the
 * window, with a small margin.
 */
export function previewPlace(
  r: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  vw: number,
  vh: number,
  w = PREVIEW_W,
  h = PREVIEW_H,
): { left: number; top: number } {
  const gap = 12;
  const margin = 8;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const centredX = clamp(r.left + r.width / 2 - w / 2, margin, vw - w - margin);
  const centredY = clamp(r.top + r.height / 2 - h / 2, margin, vh - h - margin);
  if (r.top > vh * 0.6 && r.top - gap - h >= margin) return { left: centredX, top: r.top - gap - h };
  if (r.right + gap + w <= vw - margin) return { left: r.right + gap, top: centredY };
  if (r.left - gap - w >= margin) return { left: r.left - gap - w, top: centredY };
  if (r.top - gap - h >= margin) return { left: centredX, top: r.top - gap - h };
  return { left: centredX, top: clamp(r.bottom + gap, margin, vh - h - margin) };
}
