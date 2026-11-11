// Whether the card search may edit the list's text line by line (Edit the list, Add cards).
//
// The box is read by the server's import preview, which knows many dialects: other sites' tags
// ("[Maybeboard{noDeck}]", "*CMDR*", "[C21#263] Sol Ring"), CSV and JSON files, and lists whose
// sideboard or commander follows a blank line. The search's Add and Remove edit one line with a
// much simpler reader (packages/core `addToList`, `removeFromList`, `countInList`). So they are
// offered only while both readers agree about the text, card for card and board for board.
// When they don't, the editor offers to rewrite the list in Yama's own format, from the server's
// reading, and the search works from there.
import { MAYBE, parseDeckList } from "@yama/core";
import type { Draft, ImportCard, UnknownLine } from "./importLogic";

const fold = (s: string) => s.trim().toLowerCase();

/** The board a card of the server's reading is on, as the text's headings name boards. */
function boardOf(c: Pick<ImportCard, "board" | "maybe">): string {
  // A maybeboard line is under the Considering heading, whatever board the preview files it on.
  return c.maybe ? MAYBE : c.board;
}

/** Whether `parseDeckList` reads `text` as the same cards, on the same boards, as the preview did. */
export function sameReading(text: string, draft: Pick<Draft, "cards" | "unknown">): boolean {
  // What the server read, per board and card: its copies, and the names a line may write it by.
  const want = new Map<string, { board: string; qty: number; names: Set<string> }>();
  const put = (key: string, board: string, qty: number, names: (string | null | undefined)[]) => {
    const w = want.get(key) ?? { board, qty: 0, names: new Set<string>() };
    w.qty += qty;
    for (const n of names) if (n) w.names.add(fold(n));
    want.set(key, w);
  };
  for (const c of draft.cards) put(`${boardOf(c)}\0${c.oracle_id}`, boardOf(c), c.qty, [c.name, c.name.split(" // ")[0], c.written_as]);
  for (const u of draft.unknown) put(`${boardOf(u)}\0?${fold(u.name)}`, boardOf(u), u.qty, [u.name]);
  const got = new Map<string, number>();
  for (const l of parseDeckList(text)) {
    const name = fold(l.name);
    const hit = [...want].find(([, w]) => w.board === l.board && w.names.has(name));
    if (!hit) return false;
    got.set(hit[0], (got.get(hit[0]) ?? 0) + l.qty);
  }
  return [...want].every(([key, w]) => got.get(key) === w.qty);
}

function printing(c: Pick<ImportCard, "set_code" | "collector_number" | "finish" | "print_found">): string {
  if (!c.set_code || c.print_found === false) return "";
  const mark = c.finish === "foil" ? " *F*" : c.finish === "etched" ? " *E*" : "";
  return ` (${c.set_code.toUpperCase()})${c.collector_number ? ` ${c.collector_number}` : ""}${mark}`;
}

/**
 * The server's reading written out in Yama's own format: Commander, Deck, Sideboard and
 * Considering headings and `N Name (SET) 123 *F*` lines, keeping each printing the source named and every line that
 * matched no card. Comments and other sites' tags are not kept.
 */
export function tidyText(draft: Pick<Draft, "cards" | "unknown">): string {
  const section = (title: string, board: string) => {
    const rows = [
      ...draft.cards.filter((c) => boardOf(c) === board).map((c) => `${c.qty} ${c.name}${printing(c)}`),
      ...draft.unknown.filter((u: UnknownLine) => boardOf(u) === board).map((u) => `${u.qty} ${u.name}`),
    ];
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side"), ...section("Considering", MAYBE)].join("\n").trim();
}
