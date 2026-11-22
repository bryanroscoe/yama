// Card first, printing after (docs/plans/scanner-match-cardvision.md, item 22; an option in Scan
// settings). A card named before its printing is settled becomes a provisional row at once and the
// scanner goes on to the next card; the printing is worked out after, from what the scanner kept of
// the card (the collector line of the frame it was named in and of the frames while it still lay
// there, the printing look, its border colour, the set lock), and the row updates itself.
//
// The row is provisional until its printing settles: it's on screen and in the session, and it's
// saved to the collection only then (the collection can't hold a row without a printing). A row
// the scanner couldn't settle waits for the person to pick its printing. The scanner's rule stays:
// nothing is filed under a printing that no rule the person can see settled, and every settle can
// be undone (Undo, Wrong printing, the Added list).
//
// The scanner drives the work (it has the camera, the text reader and the recognizer); the host
// shows the row and saves it (Collection.tsx). Both watch this object.

import type { Printing } from "../api";
import type { ScanCandidate } from "./types";

/** How a provisional row's printing was settled: the scanner's rules, or the person's pick. */
export type LaterWay = "only" | "set" | "collector" | "look" | "border" | "price" | "picked";

/** Where a provisional row is: being worked out, waiting for a pick, settled, or taken back out. */
export type LaterPhase = "finding" | "pick" | "settled" | "dropped";

export interface LaterState {
  phase: LaterPhase;
  /** The printings it may be (the set lock's, when on), once loaded; for the pick. */
  options: Printing[] | null;
  /** The printing settled, and how. */
  chosen: Printing | null;
  how: LaterWay | null;
  /** The card as filed once settled (`onAccept`'s card), else null. */
  filed: ScanCandidate | null;
  /** Why it waits for a pick, when it does ("Not in WOC", "Couldn't read the corner"). */
  why?: string;
}

let next = 0;

export class Provisional {
  /** This row's own id. */
  readonly key = `later-${Date.now().toString(36)}-${(next++).toString(36)}`;
  /** When it was made, for the timing record. */
  readonly at = Date.now();
  private now: LaterState = { phase: "finding", options: null, chosen: null, how: null, filed: null };
  private readonly watchers = new Set<(s: LaterState) => void>();

  /**
   * `card`: the card as named (no printing). `make` turns a printing into the card filed (the
   * scanner's own candidate, so its photo label and Undo follow). `copies` and `auto` as for
   * `onAccept`.
   */
  constructor(
    readonly card: ScanCandidate,
    readonly copies: number,
    readonly auto: boolean,
    private readonly make: (p: Printing, how: LaterWay) => ScanCandidate,
  ) {}

  get state(): LaterState {
    return this.now;
  }

  /** Still being worked out (the scanner's work counts only then). */
  get finding(): boolean {
    return this.now.phase === "finding";
  }

  /** Neither settled nor taken back out: a printing can still be chosen. */
  get open(): boolean {
    return this.now.phase === "finding" || this.now.phase === "pick";
  }

  /** Told of every change; returns the way to stop. */
  watch(fn: (s: LaterState) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private set(patch: Partial<LaterState>) {
    this.now = { ...this.now, ...patch };
    // One watcher failing (the scanner's records) mustn't keep another (the page that saves it) from hearing.
    for (const fn of [...this.watchers]) {
      try {
        fn(this.now);
      } catch (e) {
        console.error("A provisional row's watcher failed", e);
      }
    }
  }

  /** The printings it may be. */
  offer(options: Printing[]) {
    if (this.open) this.set({ options });
  }

  /**
   * Settle the printing (the first settle wins; nothing after the row is settled or dropped).
   * Returns whether it took.
   */
  settle(p: Printing, how: LaterWay): boolean {
    if (!this.open) return false;
    this.set({ phase: "settled", chosen: p, how, filed: this.make(p, how), why: undefined });
    return true;
  }

  /** The scanner is done trying: the person picks (said with `why`). */
  giveUp(why?: string) {
    if (this.finding) this.set({ phase: "pick", why });
  }

  /** The person picked the printing (the row's own picker). */
  pick(p: Printing): boolean {
    return this.settle(p, "picked");
  }

  /** Taken back out before it was saved (Undo, Remove): nothing reaches the collection. */
  drop() {
    if (this.open) this.set({ phase: "dropped" });
  }
}

/** What the row says while its printing isn't settled. */
export function laterLabel(s: Pick<LaterState, "phase" | "why">): string {
  if (s.phase === "finding") return "Finding the printing";
  if (s.phase === "pick") return s.why ? `Pick the printing: ${s.why.replace(/\.$/, "")}` : "Pick the printing";
  return "";
}
