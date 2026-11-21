// The import screen's model: what the server read (POST /api/decks/import/preview), the fixes the
// person makes (pick a suggestion, leave a card out, choose the commander), the checks shown
// before saving, and what gets saved.

import { plural } from "@yama/core";
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
  /** Plain Partner, which pairs with any other card that has it (not "Partner with", a Background or a named kind). */
  partner_any?: boolean;
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

/** A deck's name when nobody gave it one: its commanders' short names ("Thrasios and Tymna the Weaver"). */
function leaderName(cards: ImportCard[]): string {
  return cards.filter((c) => c.board === "commander").map((c) => c.name.split(",")[0]!.trim()).join(" and ");
}

/**
 * The server guesses one commander for a list with no Commander heading: its first card. When
 * that card has plain Partner and the next line is another single card that has it too, the list
 * opens with a pair, so both lead (still a guess the person can change). Only plain Partner:
 * "Partner with" a named card, a Background and the named kinds pair only with their own, and
 * the page can't tell which goes with which.
 */
function withGuessedPartner(d: PreviewDeck): ImportCard[] {
  if (d.commander_marked || !d.commander_guessed) return d.cards;
  const leaders = d.cards.filter((c) => c.board === "commander");
  const first = leaders[0];
  if (leaders.length !== 1 || !first?.partner_any) return d.cards;
  const at = d.cards.indexOf(first) + 1;
  const next = d.cards[at];
  if (!next || next.board !== "main" || next.maybe || next.qty !== 1 || !next.can_be_commander || !next.partner_any) return d.cards;
  return d.cards.map((c, i) => (i === at ? { ...c, board: "commander" as Board } : c));
}

/** A new draft. With no name in the source or the file, the deck is named after its commander. */
export function draftFrom(d: PreviewDeck, fallbackName = ""): Draft {
  const cards = withGuessedPartner(d);
  return {
    name: d.name?.trim() || fallbackName || leaderName(cards),
    cards,
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
  // A deck with no name yet is named after its commander, as it would have been had the
  // commander's line been spelt right.
  const name = !draft.name.trim() && card.board === "commander" ? leaderName(cards) : draft.name;
  return { ...draft, name, unknown, cards };
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
  return { ...draft, name: draft.name.trim() ? draft.name : leaderName(cards), cards, commanderGuessed: false, commanderMarked: oracleIds.length > 0 };
}

/**
 * What the person fixed in a reading, kept while the list is read again (every change to the
 * text makes a new reading): the card picked for a line that matched none (null: leave it out),
 * by the name as written; the commanders picked; and the name typed.
 */
export interface Fixes {
  lines: Map<string, ImportCardInfo | null>;
  commanders: string[] | null;
  /**
   * The commanders the list itself named when `commanders` were picked over them (null: it named
   * none, Yama guessed). While the list still names those, the pick stands; once it names others,
   * the person has written a new answer and the pick is forgotten (`pickStands`).
   */
  pickedOver?: string[] | null;
  name: string | null;
}

export const noFixes = (): Fixes => ({ lines: new Map(), commanders: null, pickedOver: null, name: null });

/** How a written name is looked up among the fixes: as typed, whatever its case. */
export const fixKey = (written: string) => written.trim().toLowerCase();

/** A reading with the answers to its unmatched lines made again. */
function withLineFixes(draft: Draft, fixes: Fixes): Draft {
  let out = draft;
  // From the end, so taking a line out doesn't move the ones still to check.
  for (let i = draft.unknown.length - 1; i >= 0; i--) {
    const key = fixKey(draft.unknown[i]!.name);
    if (!fixes.lines.has(key)) continue;
    const pick = fixes.lines.get(key);
    out = pick ? fixUnknown(out, i, pick) : dropUnknown(out, i);
  }
  return out;
}

/**
 * The commanders a reading names itself (a Commander heading, a site's commander mark), with the
 * answers to its unmatched lines made; null when it names none and any commander is a guess.
 * `reading` is the list as read, before a commander pick is made on it.
 */
export function namedCommanders(reading: Draft, fixes: Fixes): string[] | null {
  if (!reading.commanderMarked) return null;
  return commanders(withLineFixes(reading, fixes)).map((c) => c.oracle_id);
}

const sameCards = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Whether the remembered commander pick still speaks for a new reading. It does while the list
 * names no commander, names the picked ones, or names the ones it named when the pick was made
 * (the pick was made over them). A list that now names different commanders was changed by hand
 * since: what the person wrote wins.
 */
export function pickStands(reading: Draft, fixes: Fixes): boolean {
  const picked = fixes.commanders;
  if (!picked?.length) return false;
  const named = namedCommanders(reading, fixes);
  return named === null || sameCards(named, picked) || (!!fixes.pickedOver && sameCards(named, fixes.pickedOver));
}

/** A new reading with the person's earlier fixes made again, wherever they still apply. */
export function applyFixes(draft: Draft, fixes: Fixes): Draft {
  let out = withLineFixes(draft, fixes);
  const picked = fixes.commanders;
  if (picked && pickStands(draft, fixes) && picked.every((id) => out.cards.some((c) => c.oracle_id === id && !c.maybe))) out = setCommanders(out, picked);
  if (fixes.name !== null) out = { ...out, name: fixes.name };
  return out;
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
  if (total !== 100 && total > 0) problems.push(`${plural(total, "card")} with the commander${total < 100 ? `: ${100 - total} short of 100` : `: ${total - 100} over 100`}.`);
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
 *  printings to keep. The server's `deck_import::read_list` merges cards and printings the same
 *  way for `import-decks`, but still files a maybeboard's cards in the sideboard. */
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
