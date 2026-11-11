// Paying mana by hand on the board (design/screens/GPay, GPayPhone and GCast; the server's
// play/src/pay.rs). The decision's `payment` lists every source you can use now; a click taps one
// (or opens its menu when it can make more than one thing), a click on one you tapped by hand
// untaps it where the engine allows (only sources that just make mana), and the main button pays
// the rest. Pure, so it's tested; Board.tsx and PaymentPanel.tsx draw it.

import type { Act, ManaChoiceView, ManaPenalty, ManaSourceView, PaymentView, TapMana } from "./types";

/** "Tap mana for me" (GPay's rail): the three ways casting pays, in the design's words. */
export const TAP_MANA: { id: TapMana; label: string }[] = [
  { id: "ask", label: "Auto, but ask before sacrificing" },
  { id: "auto", label: "Always auto" },
  { id: "manual", label: "I'll tap" },
];

/** ["C", "C"] reads "{C}{C}"; "any" reads "any color". */
export function manaText(mana: string[]): string {
  if (mana.length === 1 && mana[0] === "any") return "any color";
  return mana.map((m) => (m === "any" ? "any color" : `{${m}}`)).join("");
}

/** What a source costs beyond the tap, in words. */
export function penaltyText(p: ManaPenalty): string {
  switch (p.kind) {
    case "damage":
      return p.amount !== undefined ? `${p.amount} damage to you` : "Damage to you";
    case "life":
      return p.amount !== undefined ? `Pay ${p.amount} life` : "Pay life";
    case "sacrifice":
      return "Sacrificed";
    default:
      return "Can't be undone";
  }
}

/** The source behind any card of a pile (a stack of Treasures is one tile). */
export function sourceIn(p: PaymentView, ids: number[]): ManaSourceView | undefined {
  for (const id of ids) {
    const s = p.sources.find((x) => x.id === id && x.choices.length > 0);
    if (s) return s;
  }
  return undefined;
}

export type SourceClick = { does: "tap" | "untap"; act: Act } | { does: "menu"; source: ManaSourceView };

/**
 * What clicking a tile does while paying: tap the source (its one choice), open its menu (it can
 * make more than one thing: Command Tower, a painland), or untap one you tapped by hand. A pile
 * uses its next source first, then gives back its last tapped one.
 */
export function sourceClick(p: PaymentView, ids: number[]): SourceClick | null {
  const s = sourceIn(p, ids);
  if (s) {
    if (s.choices.length === 1) return { does: "tap", act: { kind: "tap_mana", source: s.id, choice: s.choices[0]!.key } };
    return { does: "menu", source: s };
  }
  const back = [...ids].reverse().find((id) => p.untap.includes(id));
  if (back !== undefined) return { does: "untap", act: { kind: "untap_mana", source: back } };
  return null;
}

/** A choice from a source's menu as the answer it sends. */
export function choiceAct(source: ManaSourceView, c: ManaChoiceView): Act {
  return { kind: "tap_mana", source: source.id, choice: c.key };
}

/** The short chip under a source's tile (GPay): what it makes, or that it's tapped. */
export function sourceChip(p: PaymentView, ids: number[]): { text: string; tapped: boolean } | null {
  const s = sourceIn(p, ids);
  if (s) {
    const makes = [...new Set(s.choices.map((c) => (c.mana.length === 1 && c.mana[0] === "any" ? "Any" : c.mana.join(""))))];
    // One way to use it: what it makes and what it costs. Several: what they make (the menu
    // that opens says what each costs).
    if (makes.length > 1) return { text: makes.join("/"), tapped: false };
    const p = s.choices[0]?.penalty;
    const text = makes[0] + (p?.kind === "sacrifice" ? ", sacrifice" : p ? `, ${penaltyText(p).replace(" to you", "").toLowerCase()}` : "");
    return { text, tapped: false };
  }
  if (ids.some((id) => p.untap.includes(id))) return { text: "Tapped", tapped: true };
  if (ids.some((id) => p.kept.some((k) => k.id === id))) return { text: "Tapped, final", tapped: true };
  // Tapped for this payment where the engine doesn't offer to untap it (a rock's mana ability, a
  // creature tapped for convoke: cancelling the spell gives that one back).
  if (ids.some((id) => p.pool.some((m) => m.source === id))) return { text: "Tapped", tapped: true };
  return null;
}

/** "{W} from Plains", "2 {C} from Sol Ring": the pool, same mana from the same card together. */
export function poolText(p: PaymentView): string[] {
  const groups: { key: string; mana: string; name: string; n: number; convoke: boolean }[] = [];
  for (const m of p.pool) {
    const key = `${m.mana}|${m.source ?? m.name}|${m.convoke ? 1 : 0}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.n += 1;
    else groups.push({ key, mana: m.mana, name: m.name, n: 1, convoke: !!m.convoke });
  }
  return groups.map((g) => {
    const what = `${g.n > 1 ? `${g.n} ` : ""}{${g.mana}}`;
    return g.convoke ? `${what} for ${g.name}` : `${what} from ${g.name}`;
  });
}

/** Every symbol of the cost is covered by the pool (the engine settles it when you pay). */
export const paidInFull = (p: PaymentView) => p.pips.length > 0 && p.pips.every((x) => x.paid);

/** Mana in the pool beyond what the cost needs. */
export const extraMana = (p: PaymentView) => Math.max(0, p.pool.length - p.pips.length);

/** "W, 1 of 3 generic paid" for screen readers. */
export function pipsLabel(p: PaymentView): string {
  const generic = p.pips.filter((x) => x.symbol === "1");
  const coloured = p.pips.filter((x) => x.symbol !== "1");
  const parts = coloured.map((x) => `{${x.symbol}} ${x.paid ? "paid" : "not paid"}`);
  if (generic.length) parts.push(`${generic.filter((x) => x.paid).length} of ${generic.length} generic paid`);
  return `Cost ${p.cost}: ${parts.join(", ")}`;
}

/**
 * What stays if you cancel, in red (GPay after batch 1): a painland's damage, a sacrificed
 * Treasure. The engine can't give these back, so the board never says it will.
 */
export function keptNote(p: PaymentView): string | null {
  if (!p.kept.length) return null;
  const lines = p.kept.map((k) => {
    switch (k.penalty.kind) {
      case "damage":
        return `${k.name}'s ${k.penalty.amount ?? ""} damage to you stays.`.replace("  ", " ");
      case "life":
        return `The life paid for ${k.name} stays paid.`;
      case "sacrifice":
        return `${k.name} is gone.`;
      default:
        return `${k.name}'s tap can't be undone.`;
    }
  });
  return `${lines.join(" ")} Canceling won't undo ${p.kept.length > 1 ? "these" : "this"}.`;
}

/** The line under the payment's title. */
export function paymentStatus(p: PaymentView, phone: boolean): string {
  if (paidInFull(p)) {
    const extra = extraMana(p);
    return extra ? `Paid, with ${extra} extra in your pool until the step ends.` : "Paid in full.";
  }
  if (!p.sources.length && !p.untap.length) return "No source of yours can help pay now.";
  return phone
    ? "Tap an amber source to use it. Tap it again to untap it."
    : "Click an amber land or rock to tap it. Click a tapped one to untap it.";
}

/** The rail's title: "Pay {3}{W} for Akroma's Will", or a mana ability's own cost. */
export function paymentTitle(p: PaymentView): string {
  if (p.payingFor && p.cost) return `Pay ${p.cost} for ${p.payingFor.name}`;
  if (p.payingFor) return `Paying for ${p.payingFor.name}`;
  return "Pay for the mana ability";
}

/**
 * The main button and its partner while paying: "Pay the rest" until the pool covers the cost,
 * then "Cast <spell>" (or "Activate <card>"); Cancel backs out. Both of the main button's words
 * send the engine's pass, which pays whatever is left.
 */
export function paymentButtons(p: PaymentView): { primary: string | null; secondary: string | null } {
  const name = p.payingFor?.name;
  const done = paidInFull(p) && name ? `${p.payingFor!.ability ? "Activate" : "Cast"} ${name}` : null;
  return {
    primary: p.payRest ? done ?? "Pay the rest" : null,
    secondary: p.cancel ? "Cancel" : null,
  };
}

/**
 * The auto-tap preview (GCast's "Will tap"): one question per card and board, asked a moment
 * after the pointer settles, and asked again only if no answer came within a second (the server
 * drops questions that come too fast). Remembers the answers for the board they were asked on.
 */
export class PreviewCache {
  private answers = new Map<number, number[]>();
  private asked = new Map<number, number>();
  private revision: number | null = null;

  private on(revision: number) {
    if (revision !== this.revision) {
      this.revision = revision;
      this.answers.clear();
      this.asked.clear();
    }
  }

  /** The sources for `object` on board `revision`, if known. */
  get(revision: number, object: number): number[] | undefined {
    return revision === this.revision ? this.answers.get(object) : undefined;
  }

  /** Whether to ask about `object` now; asking is noted. `now` is in milliseconds. */
  shouldAsk(revision: number, object: number, now: number): boolean {
    this.on(revision);
    if (this.answers.has(object)) return false;
    const at = this.asked.get(object);
    if (at !== undefined && now - at < 1000) return false;
    this.asked.set(object, now);
    return true;
  }

  put(revision: number, object: number, sources: number[]): void {
    this.on(revision);
    this.answers.set(object, sources);
  }
}
