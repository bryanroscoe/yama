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

/** What one line of a list is: a section heading, a card, or nothing to read (blank, a comment). */
type ReadLine = { kind: "header"; board: string } | { kind: "card"; qty: number; name: string } | { kind: "skip" };

/** One line of a list, as server/src/decks.rs::parse_list reads it. */
function readLine(raw: string): ReadLine {
  const line = raw.trim();
  if (!line) return { kind: "skip" };
  const header = line.replace(/^(?:\/\/)+/, "").replace(/^#+/, "").trim().replace(/:+$/, "").toLowerCase().split(/[ (]/)[0] ?? "";
  if (["commander", "commanders"].includes(header)) return { kind: "header", board: "commander" };
  if (["deck", "main", "mainboard", "maindeck", "creatures", "lands", "spells"].includes(header)) return { kind: "header", board: "main" };
  if (["sideboard", "side", "maybeboard", "considering"].includes(header)) return { kind: "header", board: "side" };
  if (line.startsWith("//") || line.startsWith("#")) return { kind: "skip" };
  const match = line.match(/^([+-]?\d+)[xX]* (.*)$/);
  const qty = match ? Number(match[1]) : 1;
  const name = (match?.[2] ?? line).split(" (")[0]!.split(" *")[0]!.split(" #")[0]!.trim();
  return name && Number.isSafeInteger(qty) && qty > 0 ? { kind: "card", qty, name } : { kind: "skip" };
}

/** Import-name normalization matching server/src/decks.rs::parse_list. No card lookup. */
export function parseDeckList(text: string): ListLine[] {
  const out: ListLine[] = [];
  let board = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = readLine(raw);
    if (line.kind === "header") board = line.board;
    else if (line.kind === "card") out.push({ qty: line.qty, name: line.name, board });
  }
  return out;
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

/** The line with its count changed by `by`, or null when no copies are left. Everything after the count stays. */
function recount(raw: string, qty: number, by: number): string | null {
  const next = qty + by;
  if (next <= 0) return null;
  const counted = raw.match(/^(\s*)[+-]?\d+([xX]*) (.*)$/);
  if (counted) return `${counted[1]}${next}${counted[2]} ${counted[3]}`;
  // A bare name is one copy.
  const indent = raw.match(/^\s*/)![0];
  return `${indent}${next} ${raw.trim()}`;
}

const HEADINGS: Record<string, string> = { commander: "Commander", main: "Deck", side: "Sideboard" };

/**
 * The list with one more copy of `name` on `board` (the main deck unless said). A line already
 * naming the card there gains a copy; otherwise a new `1 Name` line goes after that board's last
 * card (under its heading when it has none yet, with a new heading when the list has no such
 * section).
 */
export function addToList(text: string, name: string, board = "main"): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  let at = "main";
  /** Index of the last line belonging to `board`: a card, or failing that its heading. */
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = readLine(lines[i]!);
    if (line.kind === "header") {
      at = line.board;
      if (at === board) last = i;
    } else if (line.kind === "card" && at === board) {
      if (names(line.name, name)) {
        lines[i] = recount(lines[i]!, line.qty, 1)!;
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
  if (board === "main" && at === "main") return `${body}${nl}${row}${end}`;
  return `${body}${nl}${nl}${HEADINGS[board] ?? "Deck"}${nl}${row}${end}`;
}

/**
 * The list with one copy of `name` fewer: from the main deck first, then the sideboard, then the
 * commander (or only from `board` when given). A line left with no copies is dropped. The text
 * comes back unchanged when the list doesn't hold the card.
 */
export function removeFromList(text: string, name: string, board?: string): string {
  const lines = text.split(/\r?\n/);
  let at = "main";
  const found: { index: number; board: string; qty: number }[] = [];
  lines.forEach((raw, index) => {
    const line = readLine(raw);
    if (line.kind === "header") at = line.board;
    else if (line.kind === "card" && names(line.name, name) && (board === undefined || at === board)) found.push({ index, board: at, qty: line.qty });
  });
  const order = ["main", "side", "commander"];
  // The last matching line of the first board that has one.
  const hit = found.sort((a, b) => order.indexOf(a.board) - order.indexOf(b.board) || b.index - a.index)[0];
  if (!hit) return text;
  const next = recount(lines[hit.index]!, hit.qty, -1);
  if (next === null) lines.splice(hit.index, 1);
  else lines[hit.index] = next;
  return lines.join(eol(text));
}

/** "Commander", "Deck" and "Sideboard" sections of `N Name` lines, in the order given. */
export function listText(cards: ListLine[]): string {
  const section = (title: string, board: string) => {
    const rows = cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`);
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side")].join("\n").trim();
}
