// The decision widgets' logic for a decision's `pending` (play/src/act.rs): the answer being put
// together (a draft), whether it's ready, the main button's words, and the `act` message it
// becomes. Pure, so it's tested; Decide.tsx draws the widgets (design/README.md, "Generic decision
// widgets") and Board.tsx sends the answer. The confirm is always the main button in the rail or
// dock (Bryan's decision 6, 2026-10-23); Esc puts the draft back as it started.

import type { Act, DecisionOption, Pending, TargetView } from "./types";

/** A remembered "may": ask each time, or have the engine always answer yes, or always no. */
export type Remember = "ask" | "always" | "never";

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
  | { kind: "yesno"; remember: Remember };

/** Decisions these widgets answer. Targets keep the board's own targeting. */
export function chooserCovers(p: Pending | undefined | null): p is Pending {
  return !!p && p.purpose !== "target";
}

/** Triggers are shown in the order they'll resolve: the reverse of the order they go on the stack. */
const shownReversed = (p: Pending) => p.answer === "order_triggers";

/** A scry or surveil: the picked cards stay on top, in order, and the rest go to the other pile. */
export const isScry = (p: Pending) => p.purpose === "scry" || p.purpose === "surveil";

/** A fresh draft: the engine's default answer where it has one. */
export function initialDraft(p: Pending): Draft {
  const d = p.defaultAnswer;
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

/** Add `by` to an option's share of a split, kept between its minimum and what's left. */
export function adjust(p: Pending, d: Draft, id: string, by: number): Draft {
  if (d.kind !== "split") return d;
  const cur = d.amounts[id] ?? 0;
  const floor = Math.min(cur, p.perOptionMin ?? 0);
  const next = Math.max(floor, Math.min(cur + by, cur + left(p, d)));
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
      if (isScry(p)) return true;
      return d.ids.length >= p.min && d.ids.length <= p.max;
    case "order":
      return d.ids.length === p.options.length;
    case "split": {
      if (left(p, d) !== 0) return false;
      // Each target of a divided spell gets at least its minimum (CR 601.2d).
      const min = p.perOptionMin ?? 0;
      return p.options.every((o) => (d.amounts[o.id] ?? 0) >= min);
    }
    case "number":
      return d.value !== null && d.value >= p.min && d.value <= p.max;
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

/** The empty answer: "Find nothing", "Return none", "Don't pair". */
export function noneAct(p: Pending): Act | null {
  if (p.answer === "select_cards" && p.min === 0) return { kind: "select_cards", cards: [] };
  if (p.answer === "choose_pair" && p.min === 0) return { kind: "choose_pair", partner: null };
  return null;
}

/** The `act` message for a draft; `yes` answers a yes-or-no decision. */
export function toAct(p: Pending, d: Draft, yes = true): Act | null {
  const remember = d.kind === "yesno" && p.remember === "engine" ? d.remember : "ask";
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
  }
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
  const q = p.prompt.trim();
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
      const first = p.prompt.split(" ")[0] ?? "";
      return ["Sacrifice", "Return", "Exile", "Destroy", "Tap", "Untap", "Reveal"].includes(first) ? first : "Choose";
    }
  }
}

const optionName = (p: Pending, id: string | undefined) => p.options.find((o) => o.id === id)?.name ?? "";

export type SecondaryDoes = "no" | "cancel" | "clear" | "none" | "reset" | "ask" | "all-top";

/** The main and second buttons' words for a decision (design/screens/GButtons and each widget's board). */
export function buttons(p: Pending, d: Draft, opts: { canCancel: boolean; spell: boolean }): { primary: string; secondary: string | null; secondaryDoes: SecondaryDoes | null } {
  const cancel = opts.canCancel ? ({ secondary: "Cancel", secondaryDoes: "cancel" } as const) : null;
  const none = { secondary: null, secondaryDoes: null };
  switch (d.kind) {
    case "yesno": {
      // Remembering: the main button gives that answer from now on; the second goes back to asking.
      if (d.remember !== "ask" && p.remember === "engine") return { primary: rememberLabels(p)[d.remember], secondary: "Ask each time", secondaryDoes: "ask" };
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
      return { primary: rest > 0 ? `${rest} left to assign` : "Done", ...(cancel ?? none) };
    }
    case "number": {
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

/** "1 of up to 2 chosen", "2 of 3 chosen", "0 left", "2 on top". */
export function counter(p: Pending, d: Draft): string {
  if (d.kind === "pick") {
    const n = d.ids.length;
    if (isScry(p)) return `${n} on top`;
    if (p.answer === "select_modes" && p.min !== p.max) return `${n} of ${p.max - p.min === 1 ? `${p.min} or ${p.max}` : `up to ${p.max}`} chosen`;
    return p.upTo || p.min !== p.max ? `${n} of up to ${p.max} chosen` : `${n} of ${p.max} chosen`;
  }
  if (d.kind === "split") return `${left(p, d)} left`;
  if (d.kind === "order") return p.answer === "order_triggers" ? `${d.ids.length} triggers` : `${d.ids.length} cards`;
  if (d.kind === "text") return `${d.value.trim() ? 1 : 0} of 1 chosen`;
  return "";
}

/** Where an entry of an order ends up, in words (GOrder, GTriggers). */
export function orderTag(p: Pending, i: number, n: number): string {
  if (p.answer === "order_triggers") return i === 0 ? "Resolves first" : i === n - 1 ? "Resolves last" : "Then";
  if (p.destination === "top") return i === 0 ? "On top: drawn next" : "Under it";
  return i === n - 1 ? "Very bottom" : i === 0 ? "Highest of these" : "Then";
}

/** Picks can be made on the board when every option is a card in your hand or on the battlefield. */
export function onBoard(p: Pending): boolean {
  return (
    (p.kind === "pick" || p.kind === "pair") &&
    (p.answer === "select_cards" || p.answer === "choose_pair") &&
    !isScry(p) &&
    p.options.length > 0 &&
    p.options.every((o) => o.zone === "hand" || o.zone === "battlefield")
  );
}

/**
 * Where a decision is answered: a yes or no in a strip over the live board; on a phone, the
 * dock's sheet; on a laptop, picks of cards in your hand or on the battlefield on the board
 * itself, a split on its targets when each can carry a stepper, and the rest in a dialog over
 * the table.
 */
export type Stage = "strip" | "board" | "steppers" | "dialog" | "sheet";

export function stageOf(p: Pending, wide: boolean, splitOnBoard: boolean): Stage {
  if (p.kind === "yesno") return "strip";
  if (!wide) return "sheet";
  if (onBoard(p)) return "board";
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
