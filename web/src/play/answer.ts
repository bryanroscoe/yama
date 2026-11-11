// The decision widgets' logic for a decision's `pending` (play/src/act.rs): the answer being put
// together (a draft), whether it's ready, the main button's words, and the `act` message it
// becomes. Pure, so it's tested; Decide.tsx draws the widgets (design/README.md, "Generic decision
// widgets") and Board.tsx sends the answer. The confirm is always the main button in the rail or
// dock (Bryan's decision 6, 2026-10-23); Esc puts the draft back as it started.

import type { Act, DecisionOption, Pending, TargetView } from "./types";

/** A remembered "may": ask each time, or have the engine always answer yes, or always no. */
export type Remember = "ask" | "always" | "never";

/** Time travel (GRareRules): a time counter off a card, left as it is, or added. */
export type TimeMove = "remove" | "leave" | "add";

/** What the person has put together so far, by the decision's kind. */
export type Draft =
  /**
   * Picked ids, in the order picked. A scry or surveil keeps here the cards it keeps on top, in
   * order (the first is drawn next); a pairing holds its one partner. `remember` is the
   * replacement widget's "use this order whenever" box.
   */
  | { kind: "pick"; ids: string[]; remember?: boolean }
  /** Ids in display order. For triggers that's "resolves first" down to "resolves last". */
  | { kind: "order"; ids: string[] }
  | { kind: "split"; amounts: Record<string, number> }
  /** `null` until a number is chosen, where the engine has no default (GNumber's "–"). */
  | { kind: "number"; value: number | null }
  | { kind: "text"; value: string }
  | { kind: "yesno"; remember: Remember }
  /** Time travel: what happens to each card's time counters, by option id. */
  | { kind: "time"; moves: Record<string, TimeMove> };

/** Decisions these widgets answer: every decision the server describes with `pending`. */
export function chooserCovers(p: Pending | undefined | null): p is Pending {
  return !!p;
}

/**
 * Choosing targets (GTarget, GTargetsMore): for a spell or ability, any number of them, a copy's
 * new targets, or a new target for a spell on the stack. They're picked on the board, players and
 * the stack included, and each one waits for the main button.
 */
const TARGETING = new Set(["target", "targets", "copy", "retarget"]);
export const isTargeting = (p: Pending | null | undefined): boolean => !!p && TARGETING.has(p.purpose);

/**
 * Tapping your own creatures for crew, saddle or enlist (GCombatMore), and the source to
 * sacrifice for mana (GPay's Treasure prompt): picked on the board, on a phone too.
 */
const TAPPING = new Set(["crew", "saddle", "enlist", "mana_source"]);
export const isTapping = (p: Pending | null | undefined): boolean => !!p && TAPPING.has(p.purpose);

/**
 * A card the engine offers to cast (GCastWays): what cascade, discover or ripple found, or a card
 * with madness or miracle. A yes or no over the card, in a dialog or the dock's sheet.
 */
export const isCastOffer = (p: Pending | null | undefined): boolean => !!p && p.answer === "cast_offer";

/** The engine offers the cast only when it can be paid; otherwise only the no is left. */
export const castable = (p: Pending): boolean => p.options.some((o) => o.eligible);

/** Choosing how a card is cast (GCastWays): an adventurer's half, a modal face, a cost, a way, over or under. */
const FACES = new Set(["choose_adventure_face", "choose_modal_face", "choose_alternative_cast", "choose_casting_variant", "choose_mutate_side"]);
export const isFaceChoice = (p: Pending | null | undefined): boolean => !!p && FACES.has(p.answer);

/**
 * Permanents picked on the board (GPermanents, GCounters): the legend to keep, what a clone
 * copies, equip, the Ring-bearer, empower Jace, populate, explore, a token's host, and
 * proliferate's permanents and players. A phone shows them as tiles in the dock's sheet.
 */
const PERMANENTS = new Set(["legend", "clone", "equip", "ring", "empower", "host", "populate", "explore", "proliferate", "cipher", "ninjutsu"]);
export const isPermanentPick = (p: Pending | null | undefined): boolean => !!p && PERMANENTS.has(p.purpose);

/**
 * Decisions everyone takes part in (GTogether): a vote, splitting piles and choosing one, a
 * villainous choice, coins and dice, a guess, a clash's top or bottom, life totals.
 */
const TOGETHER = new Set(["vote", "piles_split", "piles_choose", "branch", "coin", "die", "guess", "clash", "life"]);
export const isTogether = (p: Pending | null | undefined): boolean => !!p && TOGETHER.has(p.purpose);

/** Choosing a player (GRareRules' "Choosing a player"): the seat picker on art panels. */
export const isSeatPick = (p: Pending | null | undefined): boolean => !!p && (p.answer === "choose_player" || (p.answer === "choose_option" && p.kind === "pick" && ["named_player", "control_recipient"].includes(p.purpose)));

/** Words the engine's options read as (no card): a villainous choice's branches, a guess, life totals. */
export const isWordPick = (p: Pending | null | undefined): boolean => !!p && (p.purpose === "branch" || p.purpose === "guess" || p.purpose === "life");

/** A card going to the top or the bottom of a library: its own (a clash), or its owner's. */
export const isTopOrBottom = (p: Pending | null | undefined): boolean => !!p && p.answer === "choose_top_or_bottom";

/** Cards split between two places (GLibrary): the Cultivate split, manifest dread. */
export const isPlaces = (p: Pending | null | undefined): boolean => !!p && (p.places?.length ?? 0) === 2 && p.kind === "pick";

/** A pile's cards, as a split shows them: pile A is what's picked, pile B the rest (CR 700.3a). */
export function piles(p: Pending, d: Draft): { a: DecisionOption[]; b: DecisionOption[] } {
  if (p.purpose === "piles_choose") {
    const shown = p.shown ?? [];
    return { a: shown.filter((o) => o.group === "a"), b: shown.filter((o) => o.group === "b") };
  }
  const ids = d.kind === "pick" ? d.ids : [];
  return { a: p.options.filter((o) => ids.includes(o.id)), b: p.options.filter((o) => !ids.includes(o.id)) };
}

/**
 * Whether an order may move the entry at `from` to `to`: a dig's rest split by someone else keeps
 * its top and bottom piles (only the order within each changes).
 */
export function canMoveOrder(p: Pending, from: number, to: number): boolean {
  if (!p.fixedSplit || p.topCount === undefined) return true;
  return from < p.topCount === to < p.topCount;
}

/** The permanent a counter option is about: "123", or "123:P1P1" when it has several kinds. */
export const objectOf = (id: string): number => Number(id.split(":")[0]);

/** Crew or saddle: the power the picked creatures add up to, as the engine counts it. */
export function powerOf(p: Pending, d: Draft): number {
  if (d.kind !== "pick") return 0;
  return d.ids.reduce((n, id) => n + (p.options.find((o) => o.id === id)?.power ?? 0), 0);
}

/** Triggers are shown in the order they'll resolve: the reverse of the order they go on the stack. */
const shownReversed = (p: Pending) => p.answer === "order_triggers";

/** A scry or surveil: the picked cards stay on top, in order, and the rest go to the other pile. */
export const isScry = (p: Pending) => p.purpose === "scry" || p.purpose === "surveil";

/** Phyrexian mana (GMana): life paid now, two for each symbol paid with life. */
export function phyrexianLife(p: Pending, d: Draft): number {
  return d.kind === "pick" && p.answer === "pay_phyrexian" ? d.ids.length * 2 : 0;
}

/** Phyrexian mana: what's still paid with mana, printed ("{1}{W}"); empty when nothing is. */
export function phyrexianMana(p: Pending, d: Draft): string {
  const rest = p.rest === "{0}" ? "" : p.rest ?? "";
  const shards = d.kind === "pick" ? p.options.filter((o) => !d.ids.includes(o.id)).map((o) => o.cost ?? "") : [];
  return `${rest}${shards.join("")}`;
}

/** A fresh draft: the engine's default answer where it has one. */
export function initialDraft(p: Pending): Draft {
  const d = p.defaultAnswer;
  // Time travel starts with every card left as it is (GRareRules).
  if (p.answer === "time_travel") return { kind: "time", moves: Object.fromEntries(p.options.filter((o) => o.eligible).map((o) => [o.id, "leave" as TimeMove])) };
  // A shortcut's response starts at accepting it (no stopping place).
  if (p.answer === "respond_to_shortcut" && p.kind === "number") return { kind: "number", value: null };
  switch (p.kind) {
    case "pick":
    case "pair":
      if (Array.isArray(d)) return { kind: "pick", ids: d.slice(0, p.max) };
      // A scry starts with every card still on top, as it was (GScry).
      return { kind: "pick", ids: isScry(p) ? p.options.filter((o) => o.eligible).map((o) => o.id) : [] };
    case "order": {
      const ids = Array.isArray(d) && d.length === p.options.length ? d.slice() : p.options.map((o) => o.id);
      return { kind: "order", ids: shownReversed(p) ? ids.reverse() : ids };
    }
    case "split": {
      const amounts: Record<string, number> = {};
      for (const o of p.options) amounts[o.id] = d && typeof d === "object" && !Array.isArray(d) ? d[o.id] ?? 0 : 0;
      return { kind: "split", amounts };
    }
    case "number":
      // X starts at the least it can be; a chosen number ("between 1 and 10") starts unchosen.
      return { kind: "number", value: typeof d === "number" ? d : p.answer === "choose_x" ? p.min : null };
    case "text":
      return { kind: "text", value: "" };
    default:
      return { kind: "yesno", remember: "ask" };
  }
}

/** Whether the draft differs from a fresh one, so Esc and Reset have something to undo. */
export function changed(p: Pending, d: Draft): boolean {
  return JSON.stringify(d) !== JSON.stringify(initialDraft(p));
}

/**
 * Pick or unpick an option. At the most you may pick, picking another one drops the first
 * picked (one-of choices simply switch).
 */
export function togglePick(p: Pending, d: Draft, id: string): Draft {
  if (d.kind !== "pick") return d;
  const o = p.options.find((x) => x.id === id);
  if (!o?.eligible) return d;
  // A mode that may repeat is added again rather than removed; Esc or Clear take them back.
  if (p.repeat) return d.ids.length < p.max ? { ...d, ids: [...d.ids, id] } : d;
  if (d.ids.includes(id)) return { ...d, ids: d.ids.filter((x) => x !== id) };
  const ids = d.ids.length >= p.max ? d.ids.slice(1) : d.ids;
  return p.max === 0 ? d : { ...d, ids: [...ids, id] };
}

/** Move the entry at `i` one place earlier (-1) or later (+1): an order, or a scry's top pile. */
export function move(d: Draft, i: number, by: -1 | 1): Draft {
  return moveTo(d, i, i + by);
}

/** Move the entry at `from` to `to` (a drag), keeping the others in their order. */
export function moveTo(d: Draft, from: number, to: number): Draft {
  if (d.kind !== "order" && d.kind !== "pick") return d;
  if (from === to || from < 0 || to < 0 || from >= d.ids.length || to >= d.ids.length) return d;
  const ids = d.ids.slice();
  const [it] = ids.splice(from, 1);
  ids.splice(to, 0, it!);
  return { ...d, ids };
}

/** A scry or surveil: keep a card on top (it goes under the ones already kept) or send it away. */
export function keepOnTop(p: Pending, d: Draft, id: string, top: boolean): Draft {
  if (d.kind !== "pick" || !p.options.some((o) => o.id === id && o.eligible)) return d;
  if (top && d.ids.includes(id)) return d;
  const rest = d.ids.filter((x) => x !== id);
  return { ...d, ids: top ? [...rest, id] : rest };
}

/**
 * How many more an option of a split may take: what's left of the total, its own cap (the
 * counters of its kind it has), and when counters move, what's left of its kind among every
 * permanent they go onto.
 */
export function room(p: Pending, d: Draft, id: string): number {
  if (d.kind !== "split") return 0;
  const o = p.options.find((x) => x.id === id);
  const cur = d.amounts[id] ?? 0;
  let r = left(p, d);
  if (o?.cap !== undefined) r = Math.min(r, o.cap - cur);
  if (o?.cap !== undefined && o.group !== undefined && p.answer === "move_counters") {
    const used = p.options.filter((x) => x.group === o.group).reduce((a, x) => a + (d.amounts[x.id] ?? 0), 0);
    r = Math.min(r, o.cap - used);
  }
  return Math.max(0, r);
}

/** Add `by` to an option's share of a split, kept between its minimum and what it has room for. */
export function adjust(p: Pending, d: Draft, id: string, by: number): Draft {
  if (d.kind !== "split") return d;
  const cur = d.amounts[id] ?? 0;
  const floor = Math.min(cur, p.perOptionMin ?? 0);
  const next = Math.max(floor, Math.min(cur + by, cur + room(p, d, id)));
  return { kind: "split", amounts: { ...d.amounts, [id]: next } };
}

/** Everything still to give out goes to this option (GDamage's "Rest here"). */
export function restHere(p: Pending, d: Draft, id: string): Draft {
  return adjust(p, d, id, left(p, d));
}

/** What a split still has to give out. */
export function left(p: Pending, d: Draft): number {
  if (d.kind !== "split") return 0;
  return (p.total ?? 0) - Object.values(d.amounts).reduce((a, b) => a + b, 0);
}

/** Damage that kills it: the engine's lethal amount, else its toughness less the damage on it. */
export function lethalOf(o: DecisionOption, damage = 0): number | undefined {
  if (o.lethal !== undefined) return o.lethal;
  if (o.toughness === undefined || o.zone === "player") return undefined;
  return Math.max(0, o.toughness - damage);
}

/**
 * The hint beside a share of damage: "Dies" once it's lethal, else how much it takes. Only damage
 * has one; counters and life don't.
 */
export function splitTag(p: Pending, o: DecisionOption, n: number, damage = 0): { text: string; dies: boolean } | null {
  if (p.unit !== "damage") return null;
  const lethal = lethalOf(o, damage);
  if (lethal !== undefined && n >= lethal && n > 0) return { text: "Dies", dies: true };
  return { text: n ? `${n} damage` : "No damage", dies: false };
}

export function setNumber(p: Pending, value: number): Draft {
  return { kind: "number", value: Math.max(p.min, Math.min(p.max, Math.round(value))) };
}

/** One step up or down; the first step from "unchosen" lands on the least it can be. */
export function stepNumber(p: Pending, d: Draft, by: -1 | 1): Draft {
  if (d.kind !== "number") return d;
  return d.value === null ? setNumber(p, p.min) : setNumber(p, d.value + by);
}

/**
 * A digit typed while choosing a number: it extends the number when that stays in range
 * ("1" then "0" is 10), else starts a new one, else is ignored.
 */
export function typeDigit(p: Pending, d: Draft, digit: number): Draft {
  if (d.kind !== "number") return d;
  const inRange = (n: number) => n >= p.min && n <= p.max;
  const joined = d.value === null || d.value === 0 ? digit : d.value * 10 + digit;
  if (inRange(joined)) return { kind: "number", value: joined };
  if (inRange(digit)) return { kind: "number", value: digit };
  return d;
}

/** Numbers small enough to show every one as a key (GNumber); larger ranges get a stepper and Max. */
export function keypad(p: Pending): number[] | null {
  if (p.answer === "choose_x" || p.max - p.min > 19) return null;
  return Array.from({ length: p.max - p.min + 1 }, (_, i) => p.min + i);
}

/** Whether the main button may send the draft. */
export function ready(p: Pending, d: Draft): boolean {
  switch (d.kind) {
    case "pick":
      if (isScry(p) || p.answer === "pay_phyrexian" || p.purpose === "face_down") return true;
      if (p.need !== undefined && powerOf(p, d) < p.need) return false;
      return d.ids.length >= p.min && d.ids.length <= p.max;
    case "order":
      return d.ids.length === p.options.length;
    case "split": {
      // Counters that move or come off as an effect resolves: any number up to the total.
      if (p.upTo) return left(p, d) >= 0;
      if (left(p, d) !== 0) return false;
      // Each target of a divided spell gets at least its minimum (CR 601.2d).
      const min = p.perOptionMin ?? 0;
      return p.options.every((o) => (d.amounts[o.id] ?? 0) >= min);
    }
    case "number":
      // Accepting a shortcut is no number at all.
      if (p.answer === "respond_to_shortcut") return d.value === null || (d.value >= p.min && d.value <= p.max);
      return d.value !== null && d.value >= p.min && d.value <= p.max;
    case "time":
      return true;
    case "text":
      return d.value.trim() !== "" && (!!p.freeEntry || p.options.some((o) => o.id === d.value));
    default:
      return true;
  }
}

const target = (id: string): TargetView => (id.startsWith("p") ? { kind: "player", seat: Number(id.slice(1)) } : { kind: "object", id: Number(id) });

/** The replacement widget can remember only an order it knows in full: two effects, one picked first. */
export function canRememberOrder(p: Pending): boolean {
  return p.answer === "choose_replacement" && p.kind === "pick" && p.remember === "engine" && p.options.length === 2;
}

/** The empty answer: "Find nothing", "Return none", "Don't pair", "No target", "Don't enlist". */
export function noneAct(p: Pending): Act | null {
  if (p.answer === "declare_companion") return { kind: "declare_companion", name: null };
  if (p.answer === "cipher_encode") return { kind: "cipher_encode", creature: null };
  if (p.answer === "select_cards" && p.min === 0) return { kind: "select_cards", cards: [] };
  if (p.answer === "choose_pair" && p.min === 0) return { kind: "choose_pair", partner: null };
  if (p.answer === "choose_target" && p.min === 0) return { kind: "choose_target", target: null };
  if (p.answer === "choose_enlist") return { kind: "choose_enlist", target: null };
  return null;
}

/** The `act` message for a draft; `yes` answers a yes-or-no decision. */
export function toAct(p: Pending, d: Draft, yes = true): Act | null {
  // Yama remembers this answer for you (remember.rs): an unless-cost, the command zone.
  if (d.kind === "yesno" && p.remember === "yama" && d.remember !== "ask") return { kind: "remember_answer", accept: d.remember === "always" };
  const remember = d.kind === "yesno" && p.remember === "engine" ? d.remember : "ask";
  // A morph: cast face down (the main button) or face up (the second); only face up when {3} can't be paid.
  if (p.purpose === "face_down") return { kind: "choose_alternative_cast", alternative: yes && !!p.options.find((o) => o.id === "alternative")?.eligible };
  const rare = rareAct(p, d, yes);
  if (rare !== undefined) return rare;
  switch (p.answer) {
    case "select_cards":
      return d.kind === "pick" || d.kind === "order" ? { kind: "select_cards", cards: d.ids.map(Number) } : null;
    case "select_modes":
      return d.kind === "pick" ? { kind: "select_modes", indices: d.ids.map(Number) } : null;
    case "choose_replacement":
      if (p.kind === "yesno") {
        if (remember !== "ask") return { kind: "choose_replacement_and_remember", choice: { type: "optional", index: remember === "always" ? 0 : 1 } };
        return { kind: "choose_replacement", index: yes ? 0 : 1 };
      }
      if (d.kind !== "pick" || d.ids[0] === undefined) return null;
      if (d.remember && canRememberOrder(p)) {
        const first = Number(d.ids[0]);
        return { kind: "choose_replacement_and_remember", choice: { type: "order", order: [first, ...p.options.map((o) => Number(o.id)).filter((i) => i !== first)] } };
      }
      return { kind: "choose_replacement", index: Number(d.ids[0]) };
    case "choose_target":
      return d.kind === "pick" ? { kind: "choose_target", target: d.ids[0] === undefined ? null : target(d.ids[0]) } : null;
    case "order_triggers": {
      if (d.kind !== "order") return null;
      const ids = shownReversed(p) ? d.ids.slice().reverse() : d.ids;
      return { kind: "order_triggers", order: ids.map(Number) };
    }
    case "choose_x":
      return d.kind === "number" && d.value !== null ? { kind: "choose_x", value: d.value } : null;
    case "choose_option":
      if (d.kind === "number") return d.value === null ? null : { kind: "choose_option", choice: String(d.value) };
      // A vote for a word or a guess: the word picked.
      if (d.kind === "pick") return d.ids[0] === undefined ? null : { kind: "choose_option", choice: d.ids[0] };
      return d.kind === "text" ? { kind: "choose_option", choice: d.value.trim() } : null;
    case "pay_unless_cost":
      return { kind: "pay_unless_cost", pay: yes };
    case "decide_optional_effect":
      // Every copy of the card where the engine allows it, else this one.
      if (remember !== "ask") return { kind: "decide_optional_effect_and_remember", accept: remember === "always", ...(p.rememberSameCard ? { same_card: true } : {}) };
      return { kind: "decide_optional_effect", accept: yes };
    case "assign_combat_damage": {
      if (d.kind !== "split") return null;
      const blockers = p.options.filter((o) => o.zone !== "player");
      const toPlayer = p.options.filter((o) => o.zone === "player").reduce((a, o) => a + (d.amounts[o.id] ?? 0), 0);
      return {
        kind: "assign_combat_damage",
        assignments: blockers.map((o) => [Number(o.id), d.amounts[o.id] ?? 0] as [number, number]),
        trample: toPlayer,
        controller: 0,
      };
    }
    case "distribute_among":
      return d.kind === "split"
        ? { kind: "distribute_among", distribution: p.options.filter((o) => (d.amounts[o.id] ?? 0) > 0).map((o) => [target(o.id), d.amounts[o.id]!] as [TargetView, number]) }
        : null;
    case "choose_pair":
      return d.kind === "pick" ? { kind: "choose_pair", partner: d.ids[0] === undefined ? null : Number(d.ids[0]) } : null;
    case "retarget_spell":
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "retarget_spell", new_targets: [target(d.ids[0])] } : null;
    case "pay_combat_tax":
      return { kind: "pay_combat_tax", accept: yes };
    case "choose_exert":
      return { kind: "choose_exert", exert: yes };
    case "choose_enlist":
      return d.kind === "pick" ? { kind: "choose_enlist", target: d.ids[0] === undefined ? null : Number(d.ids[0]) } : null;
    case "crew_vehicle":
      return d.kind === "pick" && p.source ? { kind: "crew_vehicle", vehicle: p.source.id, creatures: d.ids.map(Number) } : null;
    case "saddle_mount":
      return d.kind === "pick" && p.source ? { kind: "saddle_mount", mount: p.source.id, creatures: d.ids.map(Number) } : null;
    case "tap_mana":
      // The Treasure prompt's yes: sacrifice the picked source for mana. "Keep it" is keep_mana.
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "tap_mana", source: Number(d.ids[0]) } : null;
    case "choose_mana_color":
      if (d.kind === "split") {
        // Several mana: one letter per mana, by colour.
        const mana = p.options.flatMap((o) => Array.from({ length: d.amounts[o.id] ?? 0 }, () => o.id));
        return { kind: "choose_mana_color", mana, combination: true };
      }
      if (d.kind !== "pick" || d.ids[0] === undefined) return null;
      return p.purpose === "combo" ? { kind: "choose_mana_color", mana: d.ids[0].split(""), combination: true } : { kind: "choose_mana_color", mana: [d.ids[0]] };
    case "pay_mana_ability_mana":
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "pay_mana_ability_mana", mana: d.ids[0].split("") } : null;
    case "pay_phyrexian":
      return d.kind === "pick" ? { kind: "pay_phyrexian", life: p.options.map((o) => d.ids.includes(o.id)) } : null;
    case "decide_optional_cost":
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "decide_optional_cost", pay: d.ids[0] === "pay" } : null;
    case "choose_cost_branch":
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "choose_cost_branch", index: Number(d.ids[0]) } : null;
    // Ways to cast, permanents and counters (play/src/ways.rs).
    case "cast_offer":
      return { kind: "cast_offer", cast: yes && castable(p) };
    // Everyone takes part, choosing a player, and learn (play/src/together.rs, library.rs).
    case "submit_pile_partition":
      return d.kind === "pick" ? { kind: "submit_pile_partition", pile_a: d.ids.map(Number) } : null;
    case "select_coin_flips":
      return d.kind === "pick" ? { kind: "select_coin_flips", keep: d.ids.map(Number) } : null;
    case "select_die_rolls":
      return d.kind === "pick" ? { kind: "select_die_rolls", ignore: d.ids.map(Number) } : null;
    case "learn":
      return d.kind === "pick" ? { kind: "learn", discard: d.ids[0] === undefined ? null : Number(d.ids[0]) } : null;
  }
  if (d.kind === "split") {
    const given = p.options.filter((o) => (d.amounts[o.id] ?? 0) > 0);
    switch (p.answer) {
      case "move_counters":
        return { kind: "move_counters", moves: given.map((o) => ({ on: objectOf(o.id), counter: o.group ?? "", count: d.amounts[o.id]! })) };
      case "remove_counters":
        return { kind: "remove_counters", counters: given.map((o) => ({ counter: o.group ?? o.id, count: d.amounts[o.id]! })) };
      case "remove_counter_cost":
        return { kind: "remove_counter_cost", counters: given.map((o) => ({ on: objectOf(o.id), counter: o.group ?? "", count: d.amounts[o.id]! })) };
    }
    return null;
  }
  if (d.kind !== "pick") return null;
  if (p.answer === "select_targets") return { kind: "select_targets", targets: d.ids.map(target) };
  const id = d.ids[0];
  if (id === undefined) return null;
  switch (p.answer) {
    case "choose_adventure_face":
      return { kind: "choose_adventure_face", creature: id === "creature" };
    case "choose_modal_face":
      return { kind: "choose_modal_face", back_face: id === "back" };
    case "choose_alternative_cast":
      return { kind: "choose_alternative_cast", alternative: id === "alternative" };
    case "choose_casting_variant":
      return { kind: "choose_casting_variant", index: Number(id) };
    case "choose_mutate_side":
      return { kind: "choose_mutate_side", top: id === "top" };
    case "choose_legend":
      return { kind: "choose_legend", keep: Number(id) };
    case "choose_ring_bearer":
      return { kind: "choose_ring_bearer", target: Number(id) };
    case "equip":
      return p.source ? { kind: "equip", equipment: p.source.id, target: Number(id) } : null;
    case "submit_vote_candidate":
      return { kind: "submit_vote_candidate", candidate: Number(id) };
    case "choose_pile":
      return { kind: "choose_pile", pile: id === "b" ? "b" : "a" };
    case "choose_branch":
      return { kind: "choose_branch", index: Number(id) };
    case "choose_top_or_bottom":
      return { kind: "choose_top_or_bottom", top: id === "top" };
    case "redistribute_life":
      return { kind: "redistribute_life", option: Number(id) };
    case "choose_player":
      return { kind: "choose_player", seat: Number(id.slice(1)) };
  }
  return null;
}

/**
 * The `act` for the rarer cards and rules (play/src/rare.rs; GRareCards, GRareRules), or
 * `undefined` for any other decision.
 */
function rareAct(p: Pending, d: Draft, yes: boolean): Act | null | undefined {
  const id = d.kind === "pick" ? d.ids[0] : undefined;
  switch (p.answer) {
    case "declare_companion":
      return d.kind === "pick" ? { kind: "declare_companion", name: id ?? null } : null;
    case "cipher_encode":
      return d.kind === "pick" ? { kind: "cipher_encode", creature: id === undefined ? null : Number(id) } : null;
    case "choose_meld_pair": {
      const [source, partner] = (id ?? "").split(":").map(Number);
      return source !== undefined && partner !== undefined && id ? { kind: "choose_meld_pair", source, partner } : null;
    }
    case "choose_entry_attack_target":
      return id === undefined ? null : { kind: "choose_entry_attack_target", target: target(id) };
    case "choose_dungeon":
      return id === undefined ? null : { kind: "choose_dungeon", dungeon: id };
    case "choose_dungeon_room":
      return id === undefined ? null : { kind: "choose_dungeon_room", room: Number(id) };
    case "time_travel": {
      if (d.kind !== "time") return null;
      const with_ = (m: TimeMove) => Object.entries(d.moves).filter(([, v]) => v === m).map(([k]) => target(k));
      return { kind: "time_travel", remove: with_("remove"), add: with_("add") };
    }
    case "propose_shortcut":
      // The pre-cast shortcut is a yes or no; a loop's count is one of the engine's.
      if (p.kind === "yesno") return yes ? { kind: "propose_shortcut", count: null } : { kind: "decline_shortcut" };
      return id === undefined ? null : { kind: "propose_shortcut", count: id === "lethal" ? null : Number(id) };
    case "respond_to_shortcut":
      if (d.kind === "number") return { kind: "respond_to_shortcut", stop_at: d.value };
      return id === undefined ? null : { kind: "respond_to_shortcut", stop_at: id === "accept" ? null : Number(id) };
    case "ninjutsu":
      return id === undefined || !p.source ? null : { kind: "ninjutsu", card: p.source.id, attacker: Number(id) };
  }
  return undefined;
}

/**
 * The buttons for the rarer cards and rules (GRareCards, GRareRules): "Cast face down for {3}",
 * "Reveal Jegantha", "Meld into Brisela", "Encode on Éowyn", "Venture into Lost Mine of
 * Phandelver", "Go to Goblin Lair", "Propose: repeat 20 times", "Pay {1}{U}, return Soldier". The
 * second button is left `undefined` where Cancel (when there is one) belongs.
 */
function rareButtons(p: Pending, d: Draft, who?: (seat: number) => string): { primary: string; secondary?: string | null; secondaryDoes?: SecondaryDoes | null } | null {
  if (d.kind !== "pick") return null;
  const o = p.options.find((x) => x.id === d.ids[0]);
  const name = o?.name ?? "";
  const none = { secondary: null, secondaryDoes: null };
  switch (p.purpose) {
    case "face_down": {
      const down = p.options.find((x) => x.id === "alternative");
      const up = p.options.find((x) => x.id === "normal");
      if (!down?.eligible) return { primary: `Cast face up for ${up?.cost ?? ""}`, ...none };
      return { primary: `Cast face down for ${down.cost ?? ""}`, ...(up?.eligible ? { secondary: `Cast face up for ${up.cost ?? ""}`, secondaryDoes: "no" as const } : none) };
    }
    case "companion":
      return { primary: o ? `Reveal ${name}` : "Choose a companion", secondary: "No companion", secondaryDoes: "none" };
    case "meld":
      return { primary: o ? `Meld into ${o.text ?? name}` : "Choose a pair", ...none };
    case "entry_attack":
      return { primary: o ? `Attack ${o.zone === "player" && o.controller !== undefined && who ? who(o.controller) : name}` : "Choose what it attacks", ...none };
    case "cipher":
      return { primary: o ? `Encode on ${name}` : "Choose a creature", secondary: "Don't encode", secondaryDoes: "none" };
    case "dungeon":
      return { primary: o ? `Venture into ${name}` : "Choose a dungeon", ...none };
    case "dungeon_room":
      return { primary: o ? `Go to ${name}` : "Choose a room", ...none };
    case "shortcut":
      return {
        primary: !o ? "Choose how many times" : o.id === "lethal" ? "Propose: repeat until a player loses" : `Propose: repeat ${o.id} times`,
        secondary: "Keep playing it out",
        secondaryDoes: "decline",
      };
    case "precast_response":
      return { primary: !o ? "Choose" : o.id === "accept" ? "Accept the shortcut" : "Stop it there", ...none };
    case "ninjutsu":
      return { primary: !o ? "Choose an attacker" : p.cost ? `Pay ${p.cost}, return ${name}` : `Return ${name}`, secondary: "Cancel", secondaryDoes: "back" };
  }
  return null;
}

/** Known optional searches whose engine description can include an earlier, mandatory effect. */
export function yesNoPresentation(p: Pending): { question: string; detail: string; yes: string; no: string } | null {
  if (p.kind !== "yesno" || p.answer !== "decide_optional_effect" || p.purpose !== "may") return null;
  const text = p.prompt.replace(/\s+/g, " ").trim();
  // Match the complete instruction, not a card name or an arbitrary "may" inside Oracle text.
  const path = /^Exile target creature\. Its controller may search their library for a basic land card, put (?:that card|it) onto the battlefield tapped, then shuffle[.?]?$/i.test(text);
  const search = /^Search your library for a basic land card, put (?:that card|it) onto the battlefield tapped, then shuffle\?$/i.test(text);
  if (!path && !search) return null;
  return {
    question: "Search your library for a basic land?",
    detail: path
      ? "Only the basic land search is optional. A land you find enters tapped; you then shuffle. Skipping the search does not cancel the exile."
      : "You may find a basic land, put it onto the battlefield tapped, then shuffle.",
    yes: "Search for a basic land",
    no: "Skip search",
  };
}

/** A one-sentence question ("Draw a card?") as words for buttons ("draw a card"), else null. */
function shortQuestion(p: Pending): string | null {
  const q = p.prompt.trim();
  if (!q.endsWith("?") || q.length > 33 || q.slice(0, -1).includes("?") || q.includes(". ")) return null;
  const words = q.slice(0, -1);
  return `${words[0]!.toLowerCase()}${words.slice(1)}`;
}

/** The first word of a one-sentence question, which says what it asks you to do ("search"). */
function questionVerb(p: Pending): string | null {
  const q = (yesNoPresentation(p)?.question ?? p.prompt).trim();
  if (!q.endsWith("?") || q.slice(0, -1).includes("?") || q.includes(". ")) return null;
  const first = q.split(/[\s,]/)[0] ?? "";
  return /^[A-Za-z]+$/.test(first) ? first.toLowerCase() : null;
}

/**
 * The yes and no buttons' words (GButtons, GYesNo): a short question is the yes button itself
 * ("Yes, draw a card" and "No"); a longer one is named by what it asks ("Search" and "Don't
 * search"); anything else is "Yes" and "No". An engine's own labels ("Pay {2}") win.
 */
export function yesNoLabels(p: Pending): { yes: string; no: string } {
  if (p.yesLabel && p.yesLabel !== "Yes") return { yes: p.yesLabel, no: p.noLabel ?? "No" };
  const presentation = yesNoPresentation(p);
  if (presentation) return { yes: presentation.yes, no: presentation.no };
  const q = shortQuestion(p);
  if (q) return { yes: `Yes, ${q}`, no: "No" };
  const verb = questionVerb(p);
  if (verb) return { yes: `${verb[0]!.toUpperCase()}${verb.slice(1)}`, no: `Don't ${verb}` };
  return { yes: "Yes", no: p.noLabel ?? "No" };
}

export function yesFor(p: Pending): string {
  return yesNoLabels(p).yes;
}

/**
 * The remember control's three answers (GYesNo): "Ask each time", then always or never doing
 * what the question asks, in its own first word ("Always search", "Never search").
 */
export function rememberLabels(p: Pending): Record<Remember, string> {
  // Yama's own (remember.rs, GChoices): "Always pay", "Never pay"; the command zone.
  if (p.remember === "yama" && p.purpose === "pay") return { ask: "Ask each time", always: "Always pay", never: "Never pay" };
  if (p.remember === "yama" && p.purpose === "commander_zone") return { ask: "Ask each time", always: "Always command zone", never: "Never command zone" };
  const verb = questionVerb(p);
  return { ask: "Ask each time", always: verb ? `Always ${verb}` : "Always yes", never: verb ? `Never ${verb}` : "Always no" };
}

/** The word on a pick's main button: "Discard (1/2)", "Done (1/2)", "Choose (1/2)". */
export function pickVerb(p: Pending): string {
  switch (p.purpose) {
    case "discard":
      return "Discard";
    case "search":
    case "bottom":
      return "Done";
    default: {
      // Ward names its cost after "Ward:" ("Ward: discard a card").
      const words = p.prompt.replace(/^Ward: /, "").split(" ");
      const first = words[0] ?? "";
      const verb = first ? `${first[0]!.toUpperCase()}${first.slice(1)}` : "";
      return ["Discard", "Sacrifice", "Return", "Exile", "Destroy", "Tap", "Untap", "Reveal"].includes(verb) ? verb : "Choose";
    }
  }
}

const optionName = (p: Pending, id: string | undefined) => p.options.find((o) => o.id === id)?.name ?? "";

export type SecondaryDoes = "no" | "cancel" | "clear" | "none" | "reset" | "ask" | "all-top" | "all" | "keep-rest" | "keep-mana" | "swap" | "decline" | "accept" | "back";

/** The main and second buttons' words for a decision (design/screens/GButtons and each widget's board). */
export function buttons(
  p: Pending,
  d: Draft,
  opts: { canCancel: boolean; spell: boolean; /** A seat as the board names it ("Sam", a computer's short commander name). */ who?: (seat: number) => string },
): { primary: string; secondary: string | null; secondaryDoes: SecondaryDoes | null } {
  const cancel = opts.canCancel ? ({ secondary: "Cancel", secondaryDoes: "cancel" } as const) : null;
  const none = { secondary: null, secondaryDoes: null };
  switch (d.kind) {
    case "yesno": {
      // A cast offer the engine can't pay for: only its no is left, on the main button.
      if (isCastOffer(p) && !castable(p)) return { primary: p.noLabel ?? "No", secondary: null, secondaryDoes: null };
      // Remembering: the main button gives that answer from now on; the second goes back to asking.
      if (d.remember !== "ask" && (p.remember === "engine" || p.remember === "yama")) return { primary: rememberLabels(p)[d.remember], secondary: "Ask each time", secondaryDoes: "ask" };
      const words = yesNoLabels(p);
      return { primary: words.yes, secondary: words.no, secondaryDoes: "no" };
    }
    case "pick": {
      const n = d.ids.length;
      if (isScry(p)) {
        const away = p.options.length - n;
        return { primary: "Done", secondary: away ? "All on top" : null, secondaryDoes: away ? "all-top" : null };
      }
      if (p.answer === "select_modes") {
        return { primary: n ? "Next" : "Choose a mode", ...(cancel ?? (n ? { secondary: "Clear", secondaryDoes: "clear" as const } : none)) };
      }
      if (p.answer === "choose_replacement") {
        return { primary: n ? `${optionName(p, d.ids[0])} first` : "Choose which applies first", ...none };
      }
      if (p.answer === "choose_pair") {
        return { primary: n ? `Pair with ${optionName(p, d.ids[0])}` : "Choose a creature", ...(p.min === 0 ? { secondary: "Don't pair", secondaryDoes: "none" as const } : none) };
      }
      const rare = rareButtons(p, d, opts.who);
      if (rare) return { ...rare, ...(rare.secondary === undefined ? (cancel ?? none) : {}) } as ReturnType<typeof buttons>;
      const together = togetherButtons(p, d, changed(p, d), opts.who);
      if (together) return { ...together, ...(together.secondary === undefined ? (cancel ?? none) : {}) } as ReturnType<typeof buttons>;
      const ways = waysButtons(p, d);
      if (ways) return { ...ways, ...(ways.secondary === undefined ? (cancel ?? none) : {}) } as ReturnType<typeof buttons>;
      const paying = payButtons(p, d);
      if (paying) return { ...paying, ...(paying.secondary === undefined ? (cancel ?? none) : {}) } as ReturnType<typeof buttons>;
      const picks = targetButtons(p, d, opts.spell);
      if (picks) return { ...picks, ...(picks.secondary === undefined ? (cancel ?? none) : {}) } as ReturnType<typeof buttons>;
      // A search that may find nothing says so on its own button (GSearch); Done waits for a card.
      if (p.purpose === "search" && p.min === 0) {
        return { primary: n ? `Done (${n}/${p.max})` : "Choose a card", secondary: "Find nothing", secondaryDoes: "none" };
      }
      const verb = pickVerb(p);
      const primary = n === 0 && p.min === 0 ? `${verb} none` : `${verb} (${n}/${p.max})`;
      if (cancel) return { primary, ...cancel };
      return { primary, ...(n ? { secondary: p.purpose === "bottom" ? "Clear picks" : "Clear", secondaryDoes: "clear" as const } : none) };
    }
    case "order": {
      const moved = changed(p, d);
      return { primary: "Done", ...(moved ? { secondary: p.answer === "order_triggers" ? "Default order" : "Reset order", secondaryDoes: "reset" as const } : none) };
    }
    case "split": {
      const rest = left(p, d);
      // Counters (GCounters): how many move or come off; a cost names what's still to remove.
      if (p.answer === "move_counters" || p.answer === "remove_counters") {
        const n = (p.total ?? 0) - rest;
        const verb = p.answer === "move_counters" ? "Move" : "Remove";
        return { primary: n ? `${verb} ${n}` : `${verb} none`, ...(cancel ?? (n ? { secondary: "Reset", secondaryDoes: "reset" as const } : none)) };
      }
      if (p.answer === "remove_counter_cost") return { primary: rest > 0 ? `${rest} left to remove` : `Remove ${p.total ?? 0}`, ...(cancel ?? none) };
      if (p.unit === "mana") {
        const mana = p.options.flatMap((o) => Array.from({ length: d.amounts[o.id] ?? 0 }, () => `{${o.id}}`)).join("");
        return { primary: rest > 0 ? `${rest} left to choose` : `Add ${mana}`, ...(cancel ?? none) };
      }
      return { primary: rest > 0 ? `${rest} left to assign` : "Done", ...(cancel ?? none) };
    }
    case "time": {
      const moved = changed(p, d);
      return { primary: "Done", ...(moved ? { secondary: "Leave all", secondaryDoes: "reset" as const } : none) };
    }
    case "number": {
      // A shortcut: accept it whole, or stop it early (GRareRules).
      if (p.answer === "respond_to_shortcut") {
        const all = p.total !== undefined ? `Accept ${p.total}` : "Accept";
        if (d.value === null) return { primary: all, secondary: null, secondaryDoes: null };
        return { primary: `Shorten to ${d.value}`, secondary: p.total !== undefined ? `Accept ${p.total} instead` : "Accept instead", secondaryDoes: "accept" };
      }
      if (p.answer === "choose_x") {
        const x = d.value ?? p.min;
        return { primary: opts.spell ? `Cast for X = ${x}` : `X = ${x}`, ...(cancel ?? none) };
      }
      return { primary: d.value === null ? "Choose a number" : `Choose ${d.value}`, ...(cancel ?? none) };
    }
    case "text": {
      const v = d.value.trim();
      const named = p.choiceType === "card name";
      return { primary: v ? `${named ? "Name" : "Choose"} ${v}` : `Choose a ${p.choiceType ?? "word"}`, ...(cancel ?? none) };
    }
  }
}

/** A seat picker's main button, by what the player is chosen for: "Give the gift to Sam", "Clash with Jules". */
function playerButton(p: Pending, name: string): string {
  switch (p.purpose) {
    case "control_recipient":
      return `Give ${p.source?.name ?? "control"} to ${name}`;
    case "named_player":
      return `Choose ${name}`;
    case "gift":
      return `Give the gift to ${name}`;
    case "clash_opponent":
      return `Clash with ${name}`;
    case "pile_opponent":
      return `${name} separates them`;
    case "entry_controller":
      return `It enters under ${name}`;
    case "announcer":
      return `${name} chooses the target`;
    default:
      return `${name} chooses`;
  }
}

/**
 * The buttons for decisions everyone takes part in, choosing a player and the library (GTogether,
 * GRareRules, GLibrary): "Vote for Éowyn", "Done: 2 and 3", "Take pile A (1)", "Keep heads",
 * "Ignore the 4", "Give the gift to Sam", "Put it on the bottom", "Put Forest onto the battlefield
 * tapped". The second button is left `undefined` where Cancel (when there is one) belongs.
 */
function togetherButtons(p: Pending, d: Draft, moved: boolean, who?: (seat: number) => string): { primary: string; secondary?: string | null; secondaryDoes?: SecondaryDoes | null } | null {
  if (d.kind !== "pick") return null;
  const n = d.ids.length;
  const o = p.options.find((x) => x.id === d.ids[0]);
  const name = o?.name ?? "";
  const none = { secondary: null, secondaryDoes: null };
  switch (p.purpose) {
    case "vote":
      return { primary: o ? `Vote for ${name}` : "Choose what to vote for", ...none };
    case "piles_split": {
      const { a, b } = piles(p, d);
      return { primary: `Done: ${a.length} and ${b.length}`, ...(moved ? { secondary: "Reset", secondaryDoes: "reset" as const } : none) };
    }
    case "piles_choose": {
      const { a, b } = piles(p, d);
      return { primary: !o ? "Choose a pile" : `Take pile ${o.id.toUpperCase()} (${o.id === "a" ? a.length : b.length})`, ...none };
    }
    case "branch":
      return { primary: o ? "Choose this one" : "Choose one", ...none };
    case "coin":
      return { primary: p.max > 1 ? `Keep (${n}/${p.max})` : o ? `Keep ${name.toLowerCase()}` : "Choose a coin", ...none };
    case "die":
      return { primary: p.max > 1 ? `Ignore (${n}/${p.max})` : o ? `Ignore the ${name}` : "Choose a roll", ...none };
    case "guess":
      return { primary: o ? `Guess ${name}` : "Make a guess", ...none };
    case "life":
      return { primary: o ? "Use these life totals" : "Choose one", ...none };
    case "clash":
    case "top_or_bottom":
      return { primary: o ? `Put it on the ${o.id}` : "Choose top or bottom", ...none };
    case "partition": {
      // Every card has a place from the start (GLibrary's "Both placed"): Done sends it.
      const swap = p.options.length === 2 && p.max === 1 && n === 1;
      if (p.max > 1 || !o) return { primary: n === p.max ? "Done" : `Done (${n}/${p.max})`, ...none };
      return { primary: "Done", ...(swap ? { secondary: "Swap them", secondaryDoes: "swap" as const } : none) };
    }
    case "manifest":
      return { primary: o ? `Manifest ${name}` : "Choose a card", ...none };
    case "learn":
      return { primary: o ? `Discard ${name}, then draw` : "Don't discard", ...none };
    case "reveal":
      return { primary: o ? `Reveal ${name}` : p.min === 0 ? "Don't reveal" : "Choose a card", ...none };
  }
  if (isSeatPick(p)) return { primary: o ? playerButton(p, who && o.controller !== undefined ? who(o.controller) : name) : p.choiceType === "opponent" ? "Choose an opponent" : "Choose a player" };
  return null;
}

/**
 * The buttons for ways to cast, permanents and proliferate (GCastWays, GPermanents, GCounters):
 * "Cast Stomp", "Overload for {6}{U}", "Put Vulpikeet on top", "Keep Isamaru", "Aragorn bears the
 * Ring", "Copy Grizzly Bears", "Put 2 on this Jace", "Proliferate (3)". The second button is left
 * `undefined` where Cancel (when there is one) belongs.
 */
function waysButtons(p: Pending, d: Draft): { primary: string; secondary?: string | null; secondaryDoes?: SecondaryDoes | null } | null {
  if (d.kind !== "pick") return null;
  const n = d.ids.length;
  const o = p.options.find((x) => x.id === d.ids[0]);
  const name = o?.name ?? "";
  switch (p.answer) {
    case "choose_adventure_face":
      return { primary: o ? `Cast ${name}` : "Choose a half" };
    case "choose_modal_face":
      return { primary: o ? `Cast ${name}` : "Choose a face" };
    case "choose_alternative_cast":
      return { primary: !o ? "Choose a cost" : o.id === "normal" ? `Cast for ${o.cost ?? ""}` : `${name} for ${o.cost ?? ""}` };
    case "choose_casting_variant":
      return { primary: !o ? "Choose how to cast it" : o.cost ? `${name} for ${o.cost}` : name };
    case "choose_mutate_side":
      return { primary: !o ? "Choose top or bottom" : o.id === "top" ? `Put ${name} on top` : "Put it underneath" };
    case "choose_legend":
      return { primary: o ? `Keep ${name}` : "Choose one to keep" };
    case "choose_ring_bearer":
      return { primary: o ? `${name} bears the Ring` : "Choose a creature" };
    case "equip":
      return { primary: o ? `Equip ${name}` : "Choose a creature" };
    case "select_targets":
      return { primary: n ? `Proliferate (${n})` : "Proliferate nothing", secondary: n ? "Clear" : null, secondaryDoes: n ? "clear" : null };
  }
  switch (p.purpose) {
    case "clone":
    case "populate":
      return { primary: o ? `Copy ${name}` : "Choose one to copy" };
    case "empower":
      return { primary: o ? `Put ${p.total ?? 0} on this Jace` : "Choose a Jace" };
    case "explore":
      return { primary: o ? `${name} explores` : "Choose one" };
    case "host":
      return { primary: o ? `Choose ${name}` : "Choose one" };
  }
  return null;
}

/**
 * The buttons while paying (GPay, GMana, GCosts): "Sacrifice it" and "Keep it" for a Treasure,
 * "Add {R}" for a colour, "Pay 2 life, then {1}" for Phyrexian mana, "Kick it" or "Don't kick",
 * "Discard Glacial Fortress" for a cost. The second button is left `undefined` where Cancel (when
 * there is one) belongs.
 */
function payButtons(p: Pending, d: Draft): { primary: string; secondary?: string | null; secondaryDoes?: SecondaryDoes | null } | null {
  if (d.kind !== "pick") return null;
  const n = d.ids.length;
  const name = optionName(p, d.ids[0]);
  switch (p.answer) {
    case "tap_mana": {
      const one = p.options.filter((o) => o.eligible).length === 1;
      return { primary: n ? (one ? "Sacrifice it" : `Sacrifice ${name}`) : "Choose what to sacrifice", secondary: one ? "Keep it" : "Keep them", secondaryDoes: "keep-mana" };
    }
    case "choose_mana_color":
      return { primary: n ? `Add ${p.purpose === "combo" ? name : `{${d.ids[0]}}`}` : "Choose a color" };
    case "pay_mana_ability_mana":
      return { primary: n ? name : "Choose how to pay" };
    case "pay_phyrexian": {
      const life = phyrexianLife(p, d);
      const mana = phyrexianMana(p, d);
      const primary = life ? `Pay ${life} life${mana ? `, then ${mana}` : ""}` : mana ? `Pay ${mana}` : "Pay";
      return { primary };
    }
    case "decide_optional_cost": {
      const pick = d.ids[0];
      if (pick === undefined) return { primary: "Choose" };
      if (p.purpose === "kicker") {
        if (name === "Kicked") return { primary: "Kick it" };
        if (name === "Not kicked") return { primary: "Don't kick" };
      }
      return { primary: name };
    }
    case "choose_cost_branch":
      return { primary: n ? `Pay: ${name}` : "Choose a cost" };
  }
  // One card or permanent as a cost: the button names it (GCosts, "Discard Glacial Fortress").
  if ((p.purpose === "cost" || p.purpose === "ward") && p.max === 1 && p.answer === "select_cards") {
    const verb = pickVerb(p);
    return { primary: n ? `${verb} ${name}` : verb === "Choose" ? "Choose" : `Choose what to ${verb.toLowerCase()}` };
  }
  return null;
}

/**
 * The main and second buttons for targets and for tapping creatures (GTarget, GTargetsMore,
 * GCombatMore): "Cast it" once a spell's last target is picked, "Next target" before that, "Keep
 * Éowyn" or "Change to Adeline" for a copy or a spell on the stack, "Crew (2 tapped)". The second
 * button is left `undefined` where Cancel (when there is one) belongs.
 */
function targetButtons(p: Pending, d: Draft, spell: boolean): { primary: string; secondary?: string | null; secondaryDoes?: SecondaryDoes | null } | null {
  if (d.kind !== "pick") return null;
  const n = d.ids.length;
  const name = optionName(p, d.ids[0]);
  switch (p.purpose) {
    case "target": {
      const last = !p.slot || p.slot[0] === p.slot[1] - 1;
      if (!n) return { primary: p.min === 0 ? "No target" : `Done (0/${p.max})` };
      return { primary: !last ? "Next target" : spell ? "Cast it" : "Done" };
    }
    case "targets": {
      const able = Math.min(p.max, p.options.filter((o) => o.eligible).length);
      const primary = n ? `Done, ${n} ${n === 1 ? "target" : "targets"}` : p.min === 0 ? "No targets" : `Done (0/${p.max})`;
      if (n < able && p.max > 1) return { primary, secondary: "Choose all", secondaryDoes: "all" };
      return { primary, ...(n ? { secondary: "Clear", secondaryDoes: "clear" as const } : {}) };
    }
    case "copy":
    case "retarget": {
      const copy = p.purpose === "copy";
      const primary = !n ? (p.min === 0 ? "No target" : "Choose a target") : d.ids[0] === p.current ? `${copy ? "Keep" : "Leave it on"} ${name}` : `${copy ? "Copy targets" : "Change to"} ${name}`;
      const back = p.current !== undefined && d.ids[0] !== p.current && p.options.some((o) => o.id === p.current && o.eligible);
      if (back) return { primary, secondary: `Back to ${optionName(p, p.current)}`, secondaryDoes: "reset" };
      if (copy && p.keepRest && p.slot) return { primary, secondary: "Keep all targets", secondaryDoes: "keep-rest" };
      return { primary, secondary: null, secondaryDoes: null };
    }
    case "enlist":
      return { primary: n ? `Enlist ${name}` : "Choose a creature", secondary: "Don't enlist", secondaryDoes: "none" };
    case "crew":
    case "saddle": {
      const got = powerOf(p, d);
      const need = p.need ?? 0;
      const verb = p.purpose === "crew" ? "Crew" : "Saddle";
      return { primary: n && got >= need ? `${verb} (${n} tapped)` : `${got} of ${need} power` };
    }
    default:
      return null;
  }
}

/** "1 of up to 2 chosen", "2 of 3 chosen", "0 left", "2 on top". */
export function counter(p: Pending, d: Draft): string {
  if (d.kind === "pick") {
    const n = d.ids.length;
    if (isScry(p)) return `${n} on top`;
    if (p.purpose === "target") return `${(p.picked?.length ?? 0) + n} of ${p.slot?.[1] ?? p.max}`;
    if (p.purpose === "targets") return p.min === 0 && p.max >= p.options.length ? `${n} chosen, any number` : `${n} of up to ${p.max} chosen`;
    if (p.purpose === "copy" || p.purpose === "retarget") return p.slot ? `Target ${p.slot[0] + 1} of ${p.slot[1]}` : "Target 1 of 1";
    if (p.need !== undefined) return `${powerOf(p, d)} of ${p.need} power`;
    if (p.purpose === "proliferate") return `${n} chosen`;
    if (p.purpose === "vote") return n ? "Voted" : (p.total ?? 1) === 1 ? "1 vote to cast" : `${p.total} votes to cast`;
    if (p.purpose === "piles_split") return `${n} and ${p.options.length - n}`;
    if (p.purpose === "partition" && p.options.length === 2 && p.max === 1) return n ? "Both placed" : "0 of 1 chosen";
    if (["companion", "meld", "dungeon", "shortcut", "precast_response", "entry_attack"].includes(p.purpose)) return "";
    if (isFaceChoice(p)) return "";
    if (p.answer === "pay_phyrexian") return n ? `${n} with life` : "All with mana";
    if (p.answer === "decide_optional_cost" || p.answer === "choose_cost_branch" || p.answer === "choose_mana_color" || p.answer === "pay_mana_ability_mana" || p.answer === "tap_mana") return "";
    if (p.answer === "select_modes" && p.min !== p.max) return `${n} of ${p.max - p.min === 1 ? `${p.min} or ${p.max}` : `up to ${p.max}`} chosen`;
    return p.upTo || p.min !== p.max ? `${n} of up to ${p.max} chosen` : `${n} of ${p.max} chosen`;
  }
  if (d.kind === "split") {
    if (p.answer === "remove_counter_cost") return left(p, d) ? `${left(p, d)} left to remove` : "0 left";
    if (p.upTo) return `${(p.total ?? 0) - left(p, d)} of ${p.total ?? 0}`;
    return `${left(p, d)} left`;
  }
  if (d.kind === "order") return p.answer === "order_triggers" ? `${d.ids.length} triggers` : `${d.ids.length} cards`;
  if (d.kind === "text") return `${d.value.trim() ? 1 : 0} of 1 chosen`;
  if (d.kind === "time") {
    const all = Object.values(d.moves);
    return `${all.filter((m) => m !== "leave").length} of ${all.length} changed`;
  }
  return "";
}

/** Where an entry of an order ends up, in words (GOrder, GTriggers). */
export function orderTag(p: Pending, i: number, n: number): string {
  if (p.answer === "order_triggers") return i === 0 ? "Resolves first" : i === n - 1 ? "Resolves last" : "Then";
  // A dig's rest split between the top and the bottom (Telling Time).
  if (p.topCount !== undefined) {
    if (i < p.topCount) return i === 0 ? "On top: drawn next" : "On top, under it";
    return i === n - 1 ? "Very bottom" : i === p.topCount ? "Bottom: highest" : "Bottom: then";
  }
  if (p.destination === "top") return i === 0 ? "On top: drawn next" : "Under it";
  return i === n - 1 ? "Very bottom" : i === 0 ? "Highest of these" : "Then";
}

const BOARD_ANSWERS = new Set([
  "select_cards",
  "choose_pair",
  "choose_target",
  "retarget_spell",
  "choose_enlist",
  "crew_vehicle",
  "saddle_mount",
  "tap_mana",
  "choose_legend",
  "choose_ring_bearer",
  "equip",
  "select_targets",
  "learn",
  // The rarer cards and rules: a cipher's creature, ninjutsu's attacker, an entering attacker's target.
  "cipher_encode",
  "ninjutsu",
  "choose_entry_attack_target",
]);

/**
 * Picks can be made on the board when every option is a card in your hand or on the battlefield;
 * targets also when they're players or spells on the stack (each has a pane, portrait or stack row).
 */
export function onBoard(p: Pending): boolean {
  if ((p.kind !== "pick" && p.kind !== "pair") || !BOARD_ANSWERS.has(p.answer) || isScry(p) || !p.options.length) return false;
  // Proliferate also picks players, by their panes and portrait.
  const zones = isTargeting(p) || p.answer === "select_targets" || p.answer === "choose_entry_attack_target" ? ["battlefield", "player", "stack"] : ["hand", "battlefield"];
  return p.options.every((o) => zones.includes(o.zone ?? ""));
}

/**
 * Where a decision is answered: a yes or no in a strip over the live board; on a phone, the
 * dock's sheet; on a laptop, picks of cards in your hand or on the battlefield on the board
 * itself, a split on its targets when each can carry a stepper, and the rest in a dialog over
 * the table.
 */
export type Stage = "strip" | "board" | "steppers" | "dialog" | "sheet";

export function stageOf(p: Pending, wide: boolean, splitOnBoard: boolean): Stage {
  // A card offered to cast is shown whole, with what cascade went through (GCastWays).
  // What a reveal-until found is shown whole, with the cards it went past (GLibrary).
  if (isCastOffer(p) || p.purpose === "kept") return wide ? "dialog" : "sheet";
  if (p.kind === "yesno") return "strip";
  // Targets and creatures to tap are chosen on the board on a phone too (GTargetPhone).
  if (onBoard(p) && (wide || isTargeting(p) || isTapping(p))) return "board";
  if (!wide) return "sheet";
  if (p.kind === "split" && splitOnBoard) return "steppers";
  return "dialog";
}

/**
 * Names for a name widget, best first: in a fixed list, the ones matching what's typed; for a
 * card name, cards in play that match, then Yama's card names (`found`). Within each, names that
 * start with what's typed come first.
 */
export function nameMatches(query: string, fixed: string[] | null, inPlay: string[], found: string[]): { name: string; inPlay: boolean }[] {
  const q = query.trim().toLowerCase();
  const hit = (n: string) => !q || n.toLowerCase().includes(q);
  const starts = (n: string) => (q && n.toLowerCase().startsWith(q) ? 0 : 1);
  const play = new Set(inPlay);
  const pool = fixed ?? [...inPlay, ...found];
  const seen = new Set<string>();
  const out: { name: string; inPlay: boolean; at: number }[] = [];
  pool.forEach((name, at) => {
    if (seen.has(name) || !hit(name)) return;
    seen.add(name);
    out.push({ name, inPlay: play.has(name), at });
  });
  out.sort((a, b) => Number(b.inPlay) - Number(a.inPlay) || starts(a.name) - starts(b.name) || a.at - b.at);
  return out.map(({ name, inPlay: p }) => ({ name, inPlay: p }));
}

/**
 * The line under a permanent while it's picked (GPermanents, GCounters): "Keep" and,
 * on the other legends, "To graveyard" in red (CR 704.5j); the Ring-bearer now and the one
 * chosen; a Jace token's loyalty and what it will be; the counters proliferate adds to; and what a
 * clone is copying. `null` where nothing is said.
 */
export function pickTag(p: Pending, d: Draft, id: string, roomy = false): { text: string; tone: "plain" | "dim" | "bad" } | null {
  if (d.kind !== "pick") return null;
  const o = p.options.find((x) => x.id === id);
  if (!o) return null;
  const on = d.ids.includes(id);
  switch (p.purpose) {
    case "legend":
      if (on) return { text: "Keep", tone: "plain" };
      return d.ids.length && o.eligible ? { text: "To graveyard", tone: "bad" } : null;
    case "ring":
      if (on) return { text: "Ring-bearer", tone: "plain" };
      return id === p.current ? { text: "Ring-bearer now", tone: "dim" } : null;
    case "clone":
      return on ? { text: "Copying", tone: "plain" } : null;
    case "empower": {
      const n = o.counters?.find(([k]) => k === "loyalty")?.[1] ?? 0;
      // Short enough for a planeswalker's small tile on the board, whose badge already shows its
      // loyalty; a phone's tiles have room for the word.
      const after = `${n} → ${n + (p.total ?? 0)}`;
      return { text: on ? (roomy ? `Loyalty ${after}` : after) : `Loyalty ${n}`, tone: on ? "plain" : "dim" };
    }
    case "ninjutsu":
      // Only unblocked attackers can be returned (GRareCards).
      if (on) return { text: "Returns to hand", tone: "plain" };
      return o.eligible ? null : { text: "Blocked", tone: "dim" };
    case "cipher":
      return on ? { text: "Encoded", tone: "plain" } : null;
    case "proliferate": {
      const all = o.counters ?? [];
      if (!all.length) return null;
      // Each kind already there gets one more (CR 701.34a).
      const text = all.map(([k, n]) => (on ? `${k} ×${n} → ×${n + 1}` : `${k} ×${n}`)).join(", ");
      return { text, tone: on ? "plain" : "dim" };
    }
  }
  return null;
}
