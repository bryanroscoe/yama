// The plain chooser's logic for a decision's `pending` (play/src/act.rs): the answer being put
// together (a draft), whether it's ready, the main button's words, and the `act` message it
// becomes. Pure, so it's tested; Chooser.tsx draws it and Board.tsx sends it. The confirm is
// always the main button in the rail or dock (Bryan's decision 6, 2026-10-23).

import type { Act, Pending, TargetView } from "./types";

/** What the person has put together so far, by the decision's kind. */
export type Draft =
  | { kind: "pick"; ids: string[] }
  /** Ids in display order. For triggers that's "resolves first" down to "resolves last". */
  | { kind: "order"; ids: string[] }
  | { kind: "split"; amounts: Record<string, number> }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "yesno" };

/** Decisions this chooser answers. Targets keep the board's own targeting; pairing has no `act` yet. */
export function chooserCovers(p: Pending | undefined | null): p is Pending {
  return !!p && p.purpose !== "target" && p.kind !== "pair";
}

/** Triggers are shown in the order they'll resolve: the reverse of the order they go on the stack. */
const shownReversed = (p: Pending) => p.answer === "order_triggers";

/** A fresh draft: the engine's default answer where it has one. */
export function initialDraft(p: Pending): Draft {
  const d = p.defaultAnswer;
  switch (p.kind) {
    case "pick":
      return { kind: "pick", ids: Array.isArray(d) ? d.slice(0, p.max) : [] };
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
      return { kind: "number", value: typeof d === "number" ? d : p.min };
    case "text":
      return { kind: "text", value: "" };
    default:
      return { kind: "yesno" };
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
  if (p.repeat) return d.ids.length < p.max ? { kind: "pick", ids: [...d.ids, id] } : d;
  if (d.ids.includes(id)) return { kind: "pick", ids: d.ids.filter((x) => x !== id) };
  const ids = d.ids.length >= p.max ? d.ids.slice(1) : d.ids;
  return p.max === 0 ? d : { kind: "pick", ids: [...ids, id] };
}

/** Move the option at `i` up (-1) or down (+1). */
export function move(d: Draft, i: number, by: -1 | 1): Draft {
  if (d.kind !== "order") return d;
  const j = i + by;
  if (j < 0 || j >= d.ids.length) return d;
  const ids = d.ids.slice();
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return { kind: "order", ids };
}

/** Add `by` to an option's share of a split, kept between 0 and what's left. */
export function adjust(p: Pending, d: Draft, id: string, by: number): Draft {
  if (d.kind !== "split") return d;
  const cur = d.amounts[id] ?? 0;
  const next = Math.max(0, Math.min(cur + by, cur + left(p, d)));
  return { kind: "split", amounts: { ...d.amounts, [id]: next } };
}

/** What a split still has to give out. */
export function left(p: Pending, d: Draft): number {
  if (d.kind !== "split") return 0;
  return (p.total ?? 0) - Object.values(d.amounts).reduce((a, b) => a + b, 0);
}

export function setNumber(p: Pending, value: number): Draft {
  return { kind: "number", value: Math.max(p.min, Math.min(p.max, Math.round(value))) };
}

/** Whether the main button may send the draft. */
export function ready(p: Pending, d: Draft): boolean {
  switch (d.kind) {
    case "pick":
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
      return d.value >= p.min && d.value <= p.max;
    case "text":
      return d.value.trim() !== "" && (!!p.freeEntry || p.options.some((o) => o.id === d.value));
    default:
      return true;
  }
}

const target = (id: string): TargetView => (id.startsWith("p") ? { kind: "player", seat: Number(id.slice(1)) } : { kind: "object", id: Number(id) });

/** The `act` message for a draft; `yes` answers a yes-or-no decision. */
export function toAct(p: Pending, d: Draft, yes = true): Act | null {
  switch (p.answer) {
    case "select_cards":
      return d.kind === "pick" ? { kind: "select_cards", cards: d.ids.map(Number) } : null;
    case "select_modes":
      return d.kind === "pick" ? { kind: "select_modes", indices: d.ids.map(Number) } : null;
    case "choose_replacement":
      if (p.kind === "yesno") return { kind: "choose_replacement", index: yes ? 0 : 1 };
      return d.kind === "pick" && d.ids[0] !== undefined ? { kind: "choose_replacement", index: Number(d.ids[0]) } : null;
    case "choose_target":
      return d.kind === "pick" ? { kind: "choose_target", target: d.ids[0] === undefined ? null : target(d.ids[0]) } : null;
    case "order_triggers": {
      if (d.kind !== "order") return null;
      const ids = shownReversed(p) ? d.ids.slice().reverse() : d.ids;
      return { kind: "order_triggers", order: ids.map(Number) };
    }
    case "choose_x":
      return d.kind === "number" ? { kind: "choose_x", value: d.value } : null;
    case "choose_option":
      if (d.kind === "number") return { kind: "choose_option", choice: String(d.value) };
      return d.kind === "text" ? { kind: "choose_option", choice: d.value.trim() } : null;
    case "pay_unless_cost":
      return { kind: "pay_unless_cost", pay: yes };
    case "decide_optional_effect":
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
  }
}

/** "Draw a card?" as the yes button: "Yes, draw a card". Long questions just say "Yes". */
function yesFor(p: Pending): string {
  if (p.yesLabel && p.yesLabel !== "Yes") return p.yesLabel;
  const q = p.prompt.replace(/\?$/, "");
  return q.length && q.length <= 32 ? `Yes, ${q[0]!.toLowerCase()}${q.slice(1)}` : "Yes";
}

/** The main and second buttons' words for a decision (design/screens/GButtons). */
export function buttons(p: Pending, d: Draft, opts: { canCancel: boolean; spell: boolean }): { primary: string; secondary: string | null; secondaryDoes: "no" | "cancel" | "clear" | "none" | "reset" | null } {
  switch (d.kind) {
    case "yesno":
      return { primary: yesFor(p), secondary: p.noLabel ?? "No", secondaryDoes: "no" };
    case "pick": {
      const n = d.ids.length;
      const primary = p.purpose === "scry" || p.purpose === "surveil" ? "Done" : `Done (${n}/${p.max})`;
      if (opts.canCancel) return { primary, secondary: "Cancel", secondaryDoes: "cancel" };
      if (p.purpose === "search" && p.min === 0) return { primary, secondary: "Find nothing", secondaryDoes: "none" };
      return { primary, secondary: n ? "Clear" : null, secondaryDoes: n ? "clear" : null };
    }
    case "order":
      return { primary: "Done", secondary: changed(p, d) ? "Default order" : null, secondaryDoes: changed(p, d) ? "reset" : null };
    case "split":
      return { primary: "Done", secondary: changed(p, d) ? "Default split" : null, secondaryDoes: changed(p, d) ? "reset" : null };
    case "number": {
      const primary = p.answer === "choose_x" ? (opts.spell ? `Cast for X = ${d.value}` : `X = ${d.value}`) : `Choose ${d.value}`;
      return opts.canCancel ? { primary, secondary: "Cancel", secondaryDoes: "cancel" } : { primary, secondary: null, secondaryDoes: null };
    }
    case "text":
      return { primary: d.value.trim() ? `Choose ${d.value.trim()}` : "Choose", secondary: opts.canCancel ? "Cancel" : null, secondaryDoes: opts.canCancel ? "cancel" : null };
  }
}

/** "1 of up to 2 chosen", "2 of 3 chosen", "0 left". */
export function counter(p: Pending, d: Draft): string {
  if (d.kind === "pick") {
    if (p.purpose === "scry" || p.purpose === "surveil") return `${d.ids.length} kept on top`;
    return p.upTo || p.min !== p.max ? `${d.ids.length} of up to ${p.max} chosen` : `${d.ids.length} of ${p.max} chosen`;
  }
  if (d.kind === "split") return `${left(p, d)} left`;
  if (d.kind === "order") return `${d.ids.length} in order`;
  return "";
}

/** Picks can be made on the board when every option is a card in your hand or on the battlefield. */
export function onBoard(p: Pending): boolean {
  return p.kind === "pick" && p.answer === "select_cards" && p.options.length > 0 && p.options.every((o) => o.zone === "hand" || o.zone === "battlefield");
}
