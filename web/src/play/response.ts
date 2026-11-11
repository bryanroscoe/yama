import type { StackItem } from "./types";

/** Selecting Swat's target is different from choosing new targets for that spell. */
export function targetChangeWarning(oracle: string | null | undefined, selected: string[], stack: StackItem[]): string | null {
  if (!/(?:choose new targets|change the target)/i.test(oracle ?? "")) return null;
  const spell = stack.find((s) => s.id !== undefined && selected.includes(String(s.id)))
    ?? stack.find((s) => s.source !== undefined && selected.includes(String(s.source)));
  if (!spell || spell.targets === undefined || spell.targets.length) return null;
  return `${spell.name} has no targets to change. Its controller will still resolve it normally.`;
}
