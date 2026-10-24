// Turn controls on the online board (play/src/turns.rs; design/screens/GPriority, GButtons and
// GSettings): the ways to pass and their keys, what a pass mode's chip says, the main button's
// partner in each state, saved stops in the server's shape, and the settings lists. No React
// here, so it's tested.

import { STEPS, type StopMap } from "./model";
import type { AnswerView, LogLine, PassMode, ServerStops, TurnsView, View } from "./types";

/** One line of GPriority's menu. `id` is a pass mode, or one of the menu's other entries. */
export interface PassChoice {
  id: PassMode | "once" | "resolve_all" | "full";
  label: string;
  /** The key that does it, as the menu shows it. */
  key: string | null;
  hint: string;
  /** Full control is on. */
  on?: boolean;
  disabled?: boolean;
}

/**
 * The ways to pass right now (GPriority). Pass once needs your priority; Resolve all needs your
 * priority and something on the stack. Shift+Enter ends your turn on your own turn and passes the
 * rest of the turn on someone else's.
 */
export function passChoices(o: { yourTurn: boolean; yourPriority: boolean; stack: number; fullControl: boolean }): PassChoice[] {
  const out: PassChoice[] = [
    { id: "once", label: "Pass once", key: "Space", hint: "Let the next player act.", disabled: !o.yourPriority },
    { id: "until", label: "Pass until something happens", key: "Enter", hint: "Stops for spells, triggers and your own stops, this turn." },
    o.yourTurn
      ? { id: "end", label: "End turn", key: "Shift Enter", hint: "Passes the rest of your turn. Someone else's spell still stops you." }
      : { id: "turn", label: "Pass the rest of this turn", key: "Shift Enter", hint: "Stops only for blockers and your stops." },
    { id: "mine", label: "Pass to my turn", key: "P", hint: "Through everyone else's turns. Spells still stop you." },
  ];
  if (o.yourPriority && o.stack > 0) {
    out.push({ id: "resolve_all", label: "Resolve all", key: null, hint: "Ask everyone to let the whole stack resolve. Each can agree or keep priority." });
  }
  out.push({ id: "full", label: "Full control", key: "F", hint: "Stop at every chance to act, even with nothing to do.", on: o.fullControl });
  return out;
}

/** What a keydown asks for: a way to pass (Enter, Shift+Enter, P) or full control (F), or nothing. */
export function passKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, yourTurn: boolean): PassMode | "full" | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Enter") return e.shiftKey ? (yourTurn ? "end" : "turn") : "until";
  if (e.shiftKey) return null;
  if (e.key === "p" || e.key === "P") return "mine";
  if (e.key === "f" || e.key === "F") return "full";
  return null;
}

/** The chip while a pass mode is on (GPriority). */
export function modeChip(mode: PassMode): string {
  switch (mode) {
    case "until":
      return "Passing until something happens";
    case "turn":
      return "Passing the rest of this turn";
    case "end":
      return "Ending your turn";
    case "mine":
      return "Passing to your turn";
  }
}

/** The smaller button beside the main one: what it says and does. */
export interface Partner {
  label: string;
  does: "end" | "mine" | "menu" | "hold" | "unhold";
  /** A toggle that's on (Hold priority). */
  pressed?: boolean;
}

/**
 * The main button's partner while you hold priority (GButtons): with something on the stack, the
 * menu ("More ways to pass", where Resolve all is); in your first main phase, End turn (your
 * second main phase and end step already say End turn on the main button); on someone else's
 * turn, Pass to my turn; otherwise the menu.
 */
export function priorityPartner(view: Pick<View, "stack" | "active" | "phase">, you: number | null): Partner | null {
  if (view.stack.length) return { label: "More ways to pass", does: "menu" };
  if (view.active !== you) return { label: "Pass to my turn", does: "mine" };
  if (view.phase === "PreCombatMain") return { label: "End turn", does: "end" };
  if (view.phase === "PostCombatMain" || view.phase === "End" || view.phase === "Cleanup") return null;
  return { label: "More ways to pass", does: "menu" };
}

/**
 * The partner while you wait for someone else (GButtons): with your own spell or ability on the
 * stack, Hold priority (Yama passed for you; holding stops you the next time priority comes back
 * while it's there); on someone else's turn, Pass to my turn, unless a way to pass is already on.
 */
export function waitingPartner(view: Pick<View, "stack" | "active" | "over">, you: number | null, turns: TurnsView | undefined): Partner | null {
  if (you === null || view.over || !turns) return null;
  if (view.stack.some((s) => s.controller === you)) {
    return turns.hold ? { label: "Holding priority", does: "unhold", pressed: true } : { label: "Hold priority", does: "hold", pressed: false };
  }
  if (view.active !== you && !turns.passing && !view.stack.length) return { label: "Pass to my turn", does: "mine" };
  return null;
}

/** Saved stops from the server's shape, as the ladder reads them; null keeps the usual stops. */
export function stopMapOf(s: ServerStops | null | undefined): StopMap | null {
  if (!s) return null;
  const map: StopMap = {};
  for (const step of STEPS) {
    map[step.label] = { mine: step.phases.some((p) => s.own.includes(p)), opp: step.phases.some((p) => s.others.includes(p)) };
  }
  return map;
}

/** The answer a log line says Yama gave, while it can still be turned off (GLog). */
export function answerOf(line: LogLine, turns: TurnsView | undefined): AnswerView | null {
  if (!line.auto || !turns) return null;
  return turns.answers.find((a) => a.id === line.auto) ?? null;
}

/** Who remembers an answer, in GSettings' words. */
export function answerBy(a: AnswerView): string {
  // Yama's own (play/src/remember.rs): an unless-cost, the command zone.
  if (a.kind === "yama") return "Yama answers for you";
  if (a.kind === "replacement") return "Remembered by the engine whenever these effects meet";
  return a.scope === "copies" ? "Remembered by the engine for every copy of this card" : "Remembered by the engine for this card";
}

/** Hand order: `id` moved one place left or right (GSettings' arrows). Unchanged at an end. */
export function shift(order: number[], id: number, by: -1 | 1): number[] {
  const i = order.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = order.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Hand order: the card at `from` moved to `to` (dragging). */
export function moved(order: number[], from: number, to: number): number[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = order.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

/** GSettings' sections, in order. */
export type SettingsSection = "yields" | "answers" | "hand" | "pay" | "concede";

/** The rail (or the sheet's buttons) while the settings are open: Close, Done, or Concede with Cancel. */
export function settingsButtons(section: SettingsSection): { title: string; body: string; primary: string; secondary: string | null } {
  if (section === "concede") return { title: "Concede?", body: "You leave the game. This can't be undone.", primary: "Concede", secondary: "Cancel" };
  if (section === "hand") return { title: "Hand order", body: "Only you see the order.", primary: "Done", secondary: null };
  return { title: "Game settings", body: "Changes apply at once.", primary: "Close", secondary: null };
}
