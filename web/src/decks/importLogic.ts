// The import screen's model: what the server read (POST /api/decks/import/preview), the fixes the
// person makes (pick a suggestion, leave a card out, choose the commander), the checks shown
// before saving, and what gets saved.

import type { Board, DeckCard, MaybeCard } from "../api";

export interface ImportCardInfo {
  oracle_id: string;
  name: string;
  type_line: string;
  mana_cost: string | null;
  cmc: number;
  color_identity: string;
  image_small: string | null;
  image_normal: string | null;
  artist: string | null;
  can_be_commander: boolean;
  /** A basic land, or a card a deck may run any number of. */
  any_number: boolean;
  partner: boolean;
}

export interface ImportCard extends ImportCardInfo {
  qty: number;
  board: Board;
  maybe: boolean;
  set_code: string | null;
  collector_number: string | null;
  finish: string | null;
  print_found: boolean | null;
  print_image: string | null;
  written_as: string | null;
  /** The source marked this copy as a proxy (a CSV's Proxy column, an Archidekt category). */
  proxy?: boolean;
}

export interface UnknownLine {
  name: string;
  qty: number;
  board: Board;
  maybe: boolean;
  set_code: string | null;
  collector_number: string | null;
  finish: string | null;
  suggestions: ImportCardInfo[];
}

export interface PreviewDeck {
  name: string | null;
  cards: ImportCard[];
  unknown: UnknownLine[];
  commander_marked: boolean;
  commander_guessed: boolean;
}

export interface ImportPreview {
  format: string | null;
  format_label: string | null;
  link: { site: string; site_name: string; url: string; fetched: boolean; message: string | null } | null;
  decks: PreviewDeck[];
  skipped: string[];
}

/** A deck being imported: the server's reading plus the person's fixes. */
export interface Draft {
  name: string;
  cards: ImportCard[];
  unknown: UnknownLine[];
  commanderMarked: boolean;
  commanderGuessed: boolean;
}

/** A new draft. With no name in the source or the file, the deck is named after its commander. */
export function draftFrom(d: PreviewDeck, fallbackName = ""): Draft {
  const leaders = d.cards.filter((c) => c.board === "commander").map((c) => c.name.split(",")[0]!.trim());
  return {
    name: d.name?.trim() || fallbackName || leaders.join(" and "),
    cards: d.cards,
    unknown: d.unknown,
    commanderMarked: d.commander_marked,
    commanderGuessed: d.commander_guessed,
  };
}

/** Use a suggestion for an unknown line: it becomes a card (merged if already there). */
export function fixUnknown(draft: Draft, index: number, pick: ImportCardInfo): Draft {
  const u = draft.unknown[index];
  if (!u) return draft;
  const unknown = draft.unknown.filter((_, i) => i !== index);
  const card: ImportCard = {
    ...pick,
    qty: u.qty,
    board: u.board,
    maybe: u.maybe,
    // The source's printing was for the name it wrote; keep it only as a hint (the server checks it on save).
    set_code: u.set_code,
    collector_number: u.collector_number,
    finish: u.finish,
    print_found: null,
    print_image: null,
    written_as: u.name,
  };
  const at = draft.cards.findIndex((c) => c.oracle_id === card.oracle_id && c.board === card.board && c.maybe === card.maybe);
  const cards = at >= 0 ? draft.cards.map((c, i) => (i === at ? { ...c, qty: c.qty + card.qty } : c)) : [...draft.cards, card];
  return { ...draft, unknown, cards };
}

export function dropUnknown(draft: Draft, index: number): Draft {
  return { ...draft, unknown: draft.unknown.filter((_, i) => i !== index) };
}

/** Make exactly these cards the commanders (others that were commanders go to the main deck). */
export function setCommanders(draft: Draft, oracleIds: string[]): Draft {
  const want = new Set(oracleIds);
  const cards = draft.cards.map((c) => {
    if (want.has(c.oracle_id)) return { ...c, board: "commander" as Board, maybe: false, qty: 1 };
    if (c.board === "commander") return { ...c, board: "main" as Board };
    return c;
  });
  return { ...draft, cards, commanderGuessed: false, commanderMarked: oracleIds.length > 0 };
}

export function commanders(draft: Draft): ImportCard[] {
  return draft.cards.filter((c) => c.board === "commander");
}

/** Cards that could lead the deck (shown in the "Who's the commander?" picker). */
export function commanderChoices(draft: Draft): ImportCard[] {
  return draft.cards.filter((c) => c.can_be_commander && !c.maybe);
}

const WUBRG = "WUBRG";

export function identityOf(cards: { color_identity: string }[]): string {
  const all = cards.map((c) => c.color_identity).join("");
  return [...WUBRG].filter((c) => all.includes(c)).join("");
}

export interface Checks {
  /** Commander and main deck together. */
  total: number;
  sideboard: number;
  /** Cards on the Considering list (a maybeboard): kept with the deck, not in it. */
  considering: number;
  identity: string;
  offIdentity: ImportCard[];
  duplicates: ImportCard[];
  /** Problems to fix or accept, in plain words, worst first. */
  problems: string[];
  ready: boolean;
}

/** What the preview says about the deck as it stands. */
export function checks(draft: Draft): Checks {
  const inDeck = draft.cards.filter((c) => c.board !== "side");
  const total = inDeck.reduce((n, c) => n + c.qty, 0);
  const sideboard = draft.cards.filter((c) => c.board === "side" && !c.maybe).reduce((n, c) => n + c.qty, 0);
  const considering = draft.cards.filter((c) => c.maybe).reduce((n, c) => n + c.qty, 0);
  const cmdrs = commanders(draft);
  const identity = identityOf(cmdrs);
  const offIdentity = cmdrs.length ? inDeck.filter((c) => [...c.color_identity].some((x) => !identity.includes(x))) : [];
  const counts = new Map<string, number>();
  for (const c of inDeck) counts.set(c.oracle_id, (counts.get(c.oracle_id) ?? 0) + c.qty);
  const duplicates = inDeck.filter((c, i) => !c.any_number && (counts.get(c.oracle_id) ?? 0) > 1 && inDeck.findIndex((x) => x.oracle_id === c.oracle_id) === i);
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Give the deck a name.");
  if (draft.unknown.length) problems.push(`${draft.unknown.length} ${draft.unknown.length === 1 ? "line didn't" : "lines didn't"} match a card. Pick the right card or leave ${draft.unknown.length === 1 ? "it" : "them"} out.`);
  if (!cmdrs.length) problems.push("Choose the commander.");
  if (cmdrs.length > 2) problems.push(`${cmdrs.length} commanders: a deck has one, or two partners.`);
  if (total !== 100 && total > 0) problems.push(`${total} cards with the commander${total < 100 ? `: ${100 - total} short of 100` : `: ${total - 100} over 100`}.`);
  if (offIdentity.length) problems.push(`${offIdentity.length} ${offIdentity.length === 1 ? "card is" : "cards are"} outside the commander's colors: ${offIdentity.slice(0, 4).map((c) => c.name).join(", ")}${offIdentity.length > 4 ? "…" : ""}.`);
  if (duplicates.length) problems.push(`More than one copy of ${duplicates.slice(0, 4).map((c) => c.name).join(", ")}${duplicates.length > 4 ? "…" : ""}.`);
  // Count, colours and copies are worth a warning, not a block: people import decks in progress.
  const ready = !!draft.name.trim() && draft.unknown.length === 0 && inDeck.length > 0;
  return { total, sideboard, considering, identity, offIdentity, duplicates, problems, ready };
}

/** A printing kept with a deck (server: deck_import::DeckPrint). A proxy with no printing named
 *  has an empty set code. */
export interface SavedPrint {
  oracle_id: string;
  set_code: string;
  collector_number: string | null;
  finish: string;
  proxy: boolean;
}

/** The deck routes' body: cards (merged by card and board), the Considering list (the source's
 *  maybeboard, merged by card: it is saved with the deck, never as part of its cards) and the
 *  printings to keep. The server's `deck_import::read_list` does the same for `import-decks`. */
export function toSave(draft: Draft): { cards: DeckCard[]; prints: SavedPrint[]; maybe: MaybeCard[] } {
  const cards: DeckCard[] = [];
  const maybe: MaybeCard[] = [];
  for (const c of draft.cards) {
    if (c.maybe) {
      const hit = maybe.find((x) => x.oracle_id === c.oracle_id);
      if (hit) hit.qty += c.qty;
      else maybe.push({ oracle_id: c.oracle_id, name: c.name, qty: c.qty });
      continue;
    }
    const hit = cards.find((x) => x.oracle_id === c.oracle_id && x.board === c.board);
    if (hit) hit.qty += c.qty;
    else cards.push({ oracle_id: c.oracle_id, name: c.name, qty: c.qty, board: c.board });
  }
  const prints = new Map<string, SavedPrint>();
  for (const c of draft.cards) {
    // A printing is kept for a card in the deck, not for a line that is only being considered.
    if (c.maybe) continue;
    if (prints.has(c.oracle_id)) continue;
    const named = !!c.set_code && c.print_found !== false;
    if (!named && !c.proxy) continue;
    prints.set(c.oracle_id, {
      oracle_id: c.oracle_id,
      set_code: named ? c.set_code! : "",
      collector_number: named ? c.collector_number : null,
      finish: c.finish ?? "nonfoil",
      proxy: !!c.proxy,
    });
  }
  return { cards, prints: [...prints.values()], maybe };
}

export interface DiffLine {
  name: string;
  qty: number;
  board: Board;
}

/** What a new version adds and takes out, against the deck's current cards. */
export function diff(current: DeckCard[], next: DeckCard[]): { added: DiffLine[]; removed: DiffLine[] } {
  const key = (c: DeckCard) => `${c.board}|${c.oracle_id}`;
  const before = new Map<string, DeckCard>();
  for (const c of current) before.set(key(c), { ...c, qty: (before.get(key(c))?.qty ?? 0) + c.qty });
  const after = new Map<string, DeckCard>();
  for (const c of next) after.set(key(c), { ...c, qty: (after.get(key(c))?.qty ?? 0) + c.qty });
  const added: DiffLine[] = [];
  const removed: DiffLine[] = [];
  for (const [k, c] of after) {
    const was = before.get(k)?.qty ?? 0;
    if (c.qty > was) added.push({ name: c.name, qty: c.qty - was, board: c.board });
  }
  for (const [k, c] of before) {
    const now = after.get(k)?.qty ?? 0;
    if (c.qty > now) removed.push({ name: c.name, qty: c.qty - now, board: c.board });
  }
  const order = (a: DiffLine, b: DiffLine) => a.name.localeCompare(b.name);
  return { added: added.sort(order), removed: removed.sort(order) };
}

/** Text a share or a link brought in, as the paste box should hold it. */
export function sharedText(params: URLSearchParams): string {
  const text = params.get("text")?.trim() ?? "";
  const url = params.get("url")?.trim() ?? "";
  if (url && !text.includes(url)) return text ? `${text}\n${url}` : url;
  return text;
}

/** A short line about a card's printing: "C21 263, foil". */
export function printLine(c: { set_code: string | null; collector_number: string | null; finish: string | null; proxy?: boolean }): string {
  const parts = [
    c.set_code ? `${c.set_code.toUpperCase()}${c.collector_number ? ` ${c.collector_number}` : ""}` : "",
    c.finish && c.finish !== "nonfoil" ? c.finish : "",
    c.proxy ? "proxy" : "",
  ].filter(Boolean);
  return parts.join(", ");
}
