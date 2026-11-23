// Test scan's text reading test (Bryan, 23 Nov 2026: "We should have a text reading test button ...
// so I can test it in test mode. It should be like 'read the text on every card'"). With it on, every
// card the art names in test scan also has its title and collector line read from the view it was
// named in, whatever the art settled, and the reads are judged here against the card the art named
// and its printings: whether the title names it, and which printing the set code and number point to.
// Pure: no camera, reader or API here.

import { Evidence, type PrintingLine } from "./evidence";
import { nameAgreement } from "./pipeline";

/** A title read this close to the card's name (nameAgreement) names it. */
export const TITLE_NAMES = 0.8;

/** One card's text read, judged. */
export interface TextTest {
  /** The card the art named. */
  name: string;
  /** The title crop's read closest to the name, or the first that read anything ("" for none). */
  title: string;
  /** The title names the card (TITLE_NAMES). */
  titleOk: boolean;
  /** The collector line's reads, joined ("" for none). */
  line: string;
  /** The set code and number the line was read as, "FRA 122", or null when it read neither. */
  read: string | null;
  /** The line proves one printing (evidence.ts's rules, as the scanner settles them). */
  settled: boolean;
  /** It read the set code and number, but another printing prints the same (a promo, The List). */
  twin: boolean;
  /** ms the reads took. */
  ms: number;
}

export function judgeText(name: string, titles: readonly string[], reads: readonly string[], printings: readonly PrintingLine[], ms: number): TextTest {
  let title = titles.find((t) => t.trim()) ?? "";
  let best = 0;
  for (const t of titles) {
    const a = nameAgreement(name, t);
    if (a > best) {
      best = a;
      title = t;
    }
  }
  const line = reads.filter((r) => r.trim()).join(" / ");
  let read: string | null = null;
  let settled = false;
  let twin = false;
  if (printings.length > 0 && line) {
    const ev = new Evidence(printings);
    ev.add(reads);
    const v = ev.verdict();
    if (v.kind === "settled") {
      const p = printings.find((x) => x.scryfall_id === v.id);
      settled = true;
      read = p ? `${p.set_code.toUpperCase()} ${p.collector_number}` : null;
    } else if (v.setRead || v.numberRead) {
      read = `${v.setRead ?? "?"} ${v.numberRead ?? "?"}`;
      twin = v.twin;
    }
  }
  return { name, title: title.trim(), titleOk: best >= TITLE_NAMES, line, read, settled, twin, ms: Math.round(ms) };
}

/** The tests so far in a line: "Name read on 5 of 7 cards; set and number on 3 (2 with a twin)." */
export function textTestSummary(tests: readonly TextTest[]): string {
  const n = tests.length;
  if (n === 0) return "No cards read yet.";
  const names = tests.filter((t) => t.titleOk).length;
  const lines = tests.filter((t) => t.settled || t.twin).length;
  const twins = tests.filter((t) => t.twin).length;
  return `Name read on ${names} of ${n} ${n === 1 ? "card" : "cards"}; set and number on ${lines}${twins ? ` (${twins} with a twin printing)` : ""}.`;
}
