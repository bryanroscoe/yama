// Scanning a physical deck (DeckScanPage, server/src/deck_scan.rs): the cards scanned so far,
// one entry per physical card, kept on the device until the scan is saved as a new version.

/** One physical card scanned (or typed). */
export interface ScannedCard {
  key: string;
  name: string;
  /** When it was added, for newest-first lists. */
  at: number;
  /** Typed or fixed by hand, not read by the camera. */
  typed?: boolean;
}

export interface ScanDraft {
  v: 1;
  deckId: string;
  cards: ScannedCard[];
  /** The commander's names: the deck's own to start with, changeable on the page. */
  commanders: string[];
}

/** One card name and its scanned copies, as the page lists them. */
export interface CardGroup {
  name: string;
  keys: string[];
  count: number;
  commander: boolean;
  /** More copies than Commander allows of a card that isn't a basic land. */
  duplicate: boolean;
  last: number;
}

/** One line sent to the server. */
export interface ScanLine {
  name: string;
  qty: number;
  commander: boolean;
}

export const DECK_SIZE = 100;

const BASICS = new Set([
  "plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest",
]);
export const isBasic = (name: string) => BASICS.has(name.trim().toLowerCase());

/** Same card: names equal in any case, or one is the other's front face ("A" and "A // B"). */
export function sameCard(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.split(" // ")[0] === y || y.split(" // ")[0] === x;
}

export const newDraft = (deckId: string, commanders: string[]): ScanDraft => ({ v: 1, deckId, cards: [], commanders });

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function addCard<D extends ScanDraft>(d: D, name: string, opts: { typed?: boolean; at?: number; key?: string } = {}): D {
  const card: ScannedCard = { key: opts.key ?? newKey(), name, at: opts.at ?? Date.now(), ...(opts.typed ? { typed: true } : {}) };
  return { ...d, cards: [...d.cards, card] };
}

export const removeCard = <D extends ScanDraft>(d: D, key: string): D => ({ ...d, cards: d.cards.filter((c) => c.key !== key) });

/** A misread card: the same physical card under the right name. */
export const fixCard = <D extends ScanDraft>(d: D, key: string, name: string): D => ({
  ...d,
  cards: d.cards.map((c) => (c.key === key ? { ...c, name, typed: true } : c)),
});

export function toggleCommander(d: ScanDraft, name: string): ScanDraft {
  const on = d.commanders.some((c) => sameCard(c, name));
  return { ...d, commanders: on ? d.commanders.filter((c) => !sameCard(c, name)) : [...d.commanders, name] };
}

const isCommander = (d: ScanDraft, name: string) => d.commanders.some((c) => sameCard(c, name));

/** The scanned cards by name, the most recently scanned first. */
export function groups(d: ScanDraft): CardGroup[] {
  const by = new Map<string, CardGroup>();
  for (const c of d.cards) {
    const id = c.name.toLowerCase();
    const g = by.get(id) ?? { name: c.name, keys: [], count: 0, commander: isCommander(d, c.name), duplicate: false, last: 0 };
    g.keys.push(c.key);
    g.count += 1;
    g.last = Math.max(g.last, c.at);
    by.set(id, g);
  }
  const out = [...by.values()];
  for (const g of out) g.duplicate = g.count > 1 && !isBasic(g.name);
  return out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

/** What's sent to the server: one line per card, the commander marked. */
export const scanLines = (d: ScanDraft): ScanLine[] =>
  groups(d)
    .map((g) => ({ name: g.name, qty: g.count, commander: g.commander }))
    .sort((a, b) => Number(b.commander) - Number(a.commander) || a.name.localeCompare(b.name));

/** How far the scan has got: cards scanned, and commanders not scanned yet. */
export function progress(d: ScanDraft): { count: number; left: number; missingCommanders: string[]; duplicates: number } {
  const count = d.cards.length;
  const all = groups(d);
  return {
    count,
    left: Math.max(0, DECK_SIZE - count),
    missingCommanders: d.commanders.filter((c) => !d.cards.some((x) => sameCard(x.name, c))),
    duplicates: all.filter((g) => g.duplicate).length,
  };
}

// ── kept on the device ─────────────────────────────────────────────────────

const KEY = (deckId: string) => `yama.deckScan.${deckId}`;

// localStorage isn't there outside a browser (tests, server rendering) and can refuse writes
// (private browsing, a full disk): the scan still works, it just isn't kept on a reload.
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** A scan in progress for this deck, if one was left unfinished on this device. */
export function loadDraft(deckId: string, storage: Pick<Storage, "getItem"> | null = local()): ScanDraft | null {
  try {
    const raw = storage?.getItem(KEY(deckId));
    if (!raw) return null;
    const d = JSON.parse(raw) as ScanDraft;
    if (d?.v !== 1 || d.deckId !== deckId || !Array.isArray(d.cards) || !Array.isArray(d.commanders)) return null;
    return d;
  } catch {
    return null;
  }
}

export function storeDraft(d: ScanDraft, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (d.cards.length === 0) storage?.removeItem(KEY(d.deckId));
    else storage?.setItem(KEY(d.deckId), JSON.stringify(d));
  } catch {
    // Not kept; see local().
  }
}

/** A setting kept on this device ("1"/"0"), or the default when storage isn't there. */
export function deviceFlag(key: string, fallback: boolean, storage: Pick<Storage, "getItem"> | null = local()): boolean {
  try {
    const v = storage?.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function setDeviceFlag(key: string, on: boolean, storage: Pick<Storage, "setItem"> | null = local()): void {
  try {
    storage?.setItem(key, on ? "1" : "0");
  } catch {
    // Not kept; see local().
  }
}

export function clearDraft(deckId: string, storage: Pick<Storage, "removeItem"> | null = local()): void {
  try {
    storage?.removeItem(KEY(deckId));
  } catch {
    // Not kept; see local().
  }
}

// ── the server's answers ───────────────────────────────────────────────────

export interface ScanChange {
  oracle_id: string;
  name: string;
  before: number;
  after: number;
}

export interface ScanCheck {
  cards: { oracle_id: string; name: string; qty: number; board: "commander" | "main" | "side" }[];
  unknown: string[];
  based_on: string | null;
  added: ScanChange[];
  removed: ScanChange[];
  unchanged: ScanChange[];
  commanders_before: string[];
  commanders_after: string[];
  commander_changed: boolean;
  same: boolean;
  kept_sideboard: number;
  validation: { ok: boolean; total: number; color_identity: string; errors: string[]; warnings: string[]; prerelease?: string[] };
}

export interface ScanSaved {
  version_id: string | null;
  changed: boolean;
  current: boolean;
}

/** "2 Forest" for the copies going in, out or staying. */
export function changeText(c: ScanChange, side: "in" | "out" | "same"): string {
  const n = side === "in" ? c.after - c.before : side === "out" ? c.before - c.after : Math.min(c.before, c.after);
  return n > 1 ? `${n} ${c.name}` : c.name;
}

export const copies = (list: ScanChange[], side: "in" | "out" | "same") =>
  list.reduce((n, c) => n + (side === "in" ? c.after - c.before : side === "out" ? c.before - c.after : Math.min(c.before, c.after)), 0);
