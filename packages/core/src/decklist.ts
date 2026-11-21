// Deck list helpers shared by the Decks pages and the planner: type groups and list text.

/** Type groups in display order. The first matching test wins, so an artifact creature is a creature. */
export const GROUPS: [string, (t: string) => boolean][] = [
  ["Creatures", (t) => t.includes("Creature")],
  ["Planeswalkers", (t) => t.includes("Planeswalker")],
  ["Instants", (t) => t.includes("Instant")],
  ["Sorceries", (t) => t.includes("Sorcery")],
  ["Artifacts", (t) => t.includes("Artifact")],
  ["Enchantments", (t) => t.includes("Enchantment")],
  ["Battles", (t) => t.includes("Battle")],
  ["Lands", (t) => t.includes("Land")],
];

/** Every group a list can show, in order. */
export const GROUP_ORDER: string[] = ["Commander", ...GROUPS.map(([g]) => g), "Other", "Sideboard"];

/** The board of a list's Considering section (a maybeboard): cards thought about, not in the deck. */
export const MAYBE = "maybe";

/**
 * The group a card shows under. Lands that are also creatures (Dryad Arbor) read as lands; the
 * front face decides for double-faced cards. An unknown type (a card Yama doesn't know yet) is "Other".
 */
export function groupOf(board: string, typeLine: string | null | undefined): string {
  if (board === "commander") return "Commander";
  if (board === "side") return "Sideboard";
  const t = (typeLine ?? "").split(" // ")[0]!;
  if (t.includes("Land")) return "Lands";
  return GROUPS.find(([, test]) => test(t))?.[0] ?? "Other";
}

export interface ListLine {
  qty: number;
  name: string;
  board: string;
}

/**
 * What one line of a list is: a section heading, a card, or nothing to read (blank, a comment).
 * A heading says whether it names the main deck itself (`deck`: Deck, Main, Mainboard, Maindeck)
 * and not a group of it (Creatures, Lands). A card says where its count is written (`counted`:
 * before the name, after it, or nowhere: a bare name is one copy).
 */
type ReadLine =
  | { kind: "header"; board: string; deck: boolean }
  | { kind: "card"; qty: number; name: string; counted: "before" | "after" | null }
  | { kind: "skip" };

/** Where a card's name ends in the rest of its line: at a set code, a foil mark or a tag, or the line's end. */
function nameEnd(rest: string): number {
  const marks = [" (", " *", " #"].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  return marks.length ? Math.min(...marks) : rest.length;
}

/** One line of a list, as server/src/decks.rs::parse_list reads it. */
function readLine(raw: string): ReadLine {
  const line = raw.trim();
  if (!line) return { kind: "skip" };
  const header = line.replace(/^(?:\/\/)+/, "").replace(/^#+/, "").trim().replace(/:+$/, "").toLowerCase().split(/[ (]/)[0] ?? "";
  if (["commander", "commanders"].includes(header)) return { kind: "header", board: "commander", deck: false };
  if (["deck", "main", "mainboard", "maindeck"].includes(header)) return { kind: "header", board: "main", deck: true };
  if (["creatures", "lands", "spells"].includes(header)) return { kind: "header", board: "main", deck: false };
  if (["sideboard", "side"].includes(header)) return { kind: "header", board: "side", deck: false };
  if (["maybeboard", "maybe", "considering"].includes(header)) return { kind: "header", board: MAYBE, deck: false };
  if (line.startsWith("//") || line.startsWith("#")) return { kind: "skip" };
  const match = line.match(/^([+-]?\d+)[xX]* (.*)$/);
  const rest = match?.[2] ?? line;
  const written = rest.slice(0, nameEnd(rest)).trim();
  // "Rampant Growth x1": the count after the name, on a line that didn't lead with one. It counts
  // only straight after the name: in "Sol Ring (C21) x2" and "Forest *F* x2" the x2 isn't one.
  const after = match ? null : written.match(TRAILING_COUNT);
  const qty = match ? Number(match[1]) : after ? Number(after[2]) : 1;
  const name = after ? after[1]!.trim() : written;
  if (!name || !Number.isSafeInteger(qty) || qty <= 0) return { kind: "skip" };
  return { kind: "card", qty, name, counted: match ? "before" : after ? "after" : null };
}

/** A name with its count after it: "Forest x12". */
const TRAILING_COUNT = /^(.*) [xX](\d+)$/;

/**
 * Reads a list's lines in order and says which board each is on, as `parse_list` has it: a
 * heading starts its board, and a blank line after the Commander heading's cards ends that
 * section (a hand-typed list often has no Deck heading; without this every card under the
 * commander led the deck too). A list that names its main deck further down (a Deck heading) says
 * itself where the commanders end, so there the blank line ends nothing: two partners with a
 * blank line between them both lead. `lines` is the whole list; the reader is then given each of
 * them, first to last.
 */
function boardReader(lines: string[]): (raw: string) => { line: ReadLine; board: string; fell: boolean } {
  // The last line that names the main deck: no blank line before it ends the Commander section.
  let lastDeck = -1;
  lines.forEach((raw, i) => {
    const line = readLine(raw);
    if (line.kind === "header" && line.deck) lastDeck = i;
  });
  let at = -1;
  let board = "main";
  let commanders = 0;
  // Whether the main deck was reached by the blank line after a commander, not by a heading.
  let fell = false;
  return (raw) => {
    at += 1;
    const line = readLine(raw);
    if (line.kind === "header") {
      board = line.board;
      fell = false;
      if (board === "commander") commanders = 0;
    } else if (line.kind === "card") {
      if (board === "commander") commanders += 1;
    } else if (!raw.trim() && board === "commander" && commanders > 0 && at > lastDeck) {
      board = "main";
      fell = true;
    }
    return { line, board, fell };
  };
}

/**
 * Import-name normalization as server/src/decks.rs::parse_list does it, with one difference: lines
 * under a Considering or Maybeboard heading have the board "maybe" here (they aren't in the
 * deck), where `parse_list` files them in the sideboard. No card lookup.
 */
export function parseDeckList(text: string): ListLine[] {
  const out: ListLine[] = [];
  const lines = text.split(/\r?\n/);
  const read = boardReader(lines);
  for (const raw of lines) {
    const { line, board } = read(raw);
    if (line.kind === "card") out.push({ qty: line.qty, name: line.name, board });
  }
  return out;
}

/** Whether a list has a Considering (or Maybeboard) section at all, even an empty one. */
export function hasConsidering(text: string): boolean {
  return text.split(/\r?\n/).some((raw) => {
    const line = readLine(raw);
    return line.kind === "header" && line.board === MAYBE;
  });
}

// ── editing a list as text ─────────────────────────────────────────────────
//
// The deck editor's list is text (Edit the list). Adding or removing a card from the card search
// changes that text and nothing else: one line gains or loses a copy, every other line stays as
// typed (set codes, foil marks, comments, blank lines, line endings), so the text stays the
// source of truth.
//
// These read a list the way `parseDeckList` does. The editor's list is read by the server's
// import preview, which knows more dialects (other sites' tags, files, lists split by a blank
// line), so the editor only offers these edits on a text both read the same way
// (web/src/decks/listReading.ts).

/** The text's own line ending, so an edit doesn't rewrite every line of a file that uses CRLF. */
function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Whether a line written as `written` names the card `name`: the same name, or its front face. */
function names(written: string, name: string): boolean {
  const w = written.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  return w === n || (n.includes(" // ") && w === n.split(" // ")[0]) || (w.includes(" // ") && w.split(" // ")[0] === n);
}

/** Copies of `name` the list holds: on `board`, or anywhere when no board is given. */
export function countInList(text: string, name: string, board?: string): number {
  return parseDeckList(text)
    .filter((l) => names(l.name, name) && (board === undefined || l.board === board))
    .reduce((n, l) => n + l.qty, 0);
}

/**
 * A card's line with its count changed by `by`, or null when no copies are left. The count
 * changes where `readLine` read it, so the edit is always one the list is then read with;
 * everything else on the line stays.
 */
function recount(raw: string, line: Extract<ReadLine, { kind: "card" }>, by: number): string | null {
  const next = line.qty + by;
  if (next <= 0) return null;
  const indent = raw.match(/^\s*/)![0];
  const body = raw.slice(indent.length);
  if (line.counted === "before") {
    const counted = body.match(/^[+-]?\d+([xX]*) (.*)$/s);
    if (counted) return `${indent}${next}${counted[1]} ${counted[2]}`;
  }
  if (line.counted === "after") {
    // The count after the name ("Forest x12 (FDN) 280"): the last word before the printing.
    const end = nameEnd(body);
    const after = body.slice(0, end).match(/^(.*) ([xX])\d+(\s*)$/s);
    if (after) return `${indent}${after[1]} ${after[2]}${next}${after[3]}${body.slice(end)}`;
  }
  // A bare name is one copy. An "x2" further along the line (after a set code or a foil mark)
  // was never its count, and stays as written.
  return `${indent}${next} ${body.trimEnd()}`;
}

const HEADINGS: Record<string, string> = { commander: "Commander", main: "Deck", side: "Sideboard", [MAYBE]: "Considering" };

/**
 * The list with one more copy of `name` on `board` (the main deck unless said). A line already
 * naming the card there gains a copy; otherwise a new `1 Name` line goes after that board's last
 * card (under its heading when it has none yet, with a new heading when the list has no such
 * section).
 */
export function addToList(text: string, name: string, board = "main"): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  const read = boardReader(lines);
  let at = "main";
  // The list ended on the blank line after its commander: the deck's first card needs its heading.
  let afterCommander = false;
  /** Index of the last line belonging to `board`: a card, or failing that its heading. */
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const { line, board: on, fell } = read(lines[i]!);
    at = on;
    afterCommander = fell;
    if (line.kind === "header") {
      if (at === board) last = i;
    } else if (line.kind === "card" && at === board) {
      if (names(line.name, name)) {
        lines[i] = recount(lines[i]!, line, 1)!;
        return lines.join(nl);
      }
      last = i;
    }
  }
  const row = `1 ${name}`;
  if (last >= 0) {
    lines.splice(last + 1, 0, row);
    return lines.join(nl);
  }
  const body = text.replace(/\s+$/, "");
  if (!body) return board === "main" ? row : `${HEADINGS[board] ?? "Deck"}${nl}${row}`;
  // The list ends as it did: with a line break if it had one.
  const end = /\n\s*$/.test(text) ? nl : "";
  // No line of that board yet. A list that ends in the main deck with no heading just takes the line.
  if (board === "main" && at === "main" && !afterCommander) return `${body}${nl}${row}${end}`;
  return `${body}${nl}${nl}${HEADINGS[board] ?? "Deck"}${nl}${row}${end}`;
}

/**
 * The list with one copy of `name` fewer: from the main deck first, then the sideboard, then the
 * Considering list, then the commander (or only from `board` when given). A line left with no copies is dropped. The text
 * comes back unchanged when the list doesn't hold the card.
 */
export function removeFromList(text: string, name: string, board?: string): string {
  const lines = text.split(/\r?\n/);
  const read = boardReader(lines);
  const found: { index: number; board: string; line: Extract<ReadLine, { kind: "card" }> }[] = [];
  lines.forEach((raw, index) => {
    const { line, board: at } = read(raw);
    if (line.kind === "card" && names(line.name, name) && (board === undefined || at === board)) found.push({ index, board: at, line });
  });
  const order = ["main", "side", MAYBE, "commander"];
  // The last matching line of the first board that has one.
  const hit = found.sort((a, b) => order.indexOf(a.board) - order.indexOf(b.board) || b.index - a.index)[0];
  if (!hit) return text;
  const next = recount(lines[hit.index]!, hit.line, -1);
  if (next === null) lines.splice(hit.index, 1);
  else lines[hit.index] = next;
  return lines.join(eol(text));
}

/** "Commander", "Deck", "Sideboard" and "Considering" sections of `N Name` lines, in the order given. */
export function listText(cards: ListLine[]): string {
  const section = (title: string, board: string) => {
    const rows = cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`);
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side"), ...section("Considering", MAYBE)].join("\n").trim();
}
