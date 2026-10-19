// Release calendar wording, kept apart from the components so it can be tested.

import type { CalendarSet, PreconSummary } from "../api";

/** The reader's local date as YYYY-MM-DD (the server's "today" is UTC). */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "13 Nov 2026, in 25 days", "…, out today", "Out since 13 Nov 2026". `fmt` formats a date;
 *  `midSentence` starts the words Yama adds in lower case (never the formatted date). */
export function releaseLine(released: string | null, today: string, fmt: (d: string) => string, midSentence = false): string {
  if (!released) return midSentence ? "release date not announced" : "Release date not announced";
  const d = daysBetween(today, released);
  if (d < 0) return `${midSentence ? "out" : "Out"} since ${fmt(released)}`;
  if (d === 0) return `${fmt(released)}, out today`;
  if (d === 1) return `${fmt(released)}, tomorrow`;
  return `${fmt(released)}, in ${d} days`;
}

/** How far previews have got: Scryfall's card count, against the printed size when it says. */
export function previewLine(set: Pick<CalendarSet, "card_count" | "printed_size">, out: boolean): string {
  const n = set.card_count;
  if (n === 0) return "No cards on Scryfall yet";
  const cards = `${n.toLocaleString()} ${n === 1 ? "card" : "cards"}`;
  if (set.printed_size && set.printed_size > n) return `${cards} of ${set.printed_size.toLocaleString()} on Scryfall`;
  return out ? `${cards} on Scryfall` : `${cards} on Scryfall so far`;
}

const TYPES: Record<string, string> = {
  expansion: "Expansion",
  core: "Core set",
  masters: "Masters set",
  commander: "Commander decks",
  draft_innovation: "Draft set",
  funny: "Un-set",
  starter: "Starter set",
  box: "Boxed set",
  duel_deck: "Duel decks",
  from_the_vault: "From the Vault",
  spellbook: "Spellbook",
  premium_deck: "Premium deck",
  planechase: "Planechase",
  archenemy: "Archenemy",
  arsenal: "Commander collection",
  alchemy: "Alchemy (digital)",
  masterpiece: "Masterpieces",
  memorabilia: "Memorabilia",
  minigame: "Minigames",
  promo: "Promos",
  token: "Tokens",
  treasure_chest: "Treasure chest (digital)",
  vanguard: "Vanguard",
};

export function setTypeLabel(type: string): string {
  const known = TYPES[type];
  if (known) return known;
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Small companion sets hidden until asked for: tokens, promos, one-card bonus sheets, digital sets. */
const EXTRA_TYPES = new Set(["token", "promo", "memorabilia", "masterpiece", "minigame", "treasure_chest", "alchemy"]);

export function isExtra(set: Pick<CalendarSet, "set_type" | "digital" | "watched" | "precons">): boolean {
  // Watching Star Trek doesn't bring its token and bonus sheets out; watching one itself does.
  if (set.watched || set.precons.length > 0) return false;
  return set.digital || EXTRA_TYPES.has(set.set_type);
}

export interface PreconGroup {
  /** The set the decks belong to (MTGJSON's code, lowercase). */
  code: string;
  setName: string;
  released: string | null;
  precons: PreconSummary[];
}

/** Precons whose lists are out, from sets the reader watches (directly or through the set
 *  above), once each and grouped by the set they're in. */
export function watchedPrecons(sets: CalendarSet[]): PreconGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, PreconGroup>();
  for (const s of sets) {
    if (!s.watched && !s.parent_watched) continue;
    for (const p of s.precons) {
      if (seen.has(p.file_name)) continue;
      seen.add(p.file_name);
      const home = sets.find((x) => x.code === p.set_code);
      const g = groups.get(p.set_code) ?? {
        code: p.set_code,
        setName: home?.name ?? p.set_code.toUpperCase(),
        released: home?.released_at ?? p.release_date,
        precons: [],
      };
      g.precons.push(p);
      groups.set(p.set_code, g);
    }
  }
  return [...groups.values()];
}

/** "Federation Fleet" already made into a deck, by name (case and spacing ignored). */
export function hasDeckNamed(deckNames: string[], name: string): boolean {
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return deckNames.some((d) => key(d) === key(name));
}

/** A deck made from this precon or from its Collector's Edition, by name. */
export function preconMade(deckNames: string[], p: Pick<PreconSummary, "name" | "variants">): boolean {
  return hasDeckNamed(deckNames, p.name) || p.variants.some((v) => hasDeckNamed(deckNames, v.name));
}

/** How long after release a watched set's precons stay at the top of the Cards page. */
export const PRECONS_HEADLINE_DAYS = 28;

/** Whether a watched set's precons still lead the Cards page: before release, and after it
 *  until the reader has a deck for every one or four weeks have passed. Then they fold away
 *  below the calendar, and the watch stays. */
export function headlined(g: Pick<PreconGroup, "released" | "precons">, today: string, deckNames: string[]): boolean {
  if (!g.released) return true;
  const since = daysBetween(g.released, today);
  if (since < 0) return true;
  if (since > PRECONS_HEADLINE_DAYS) return false;
  return !g.precons.every((p) => preconMade(deckNames, p));
}

/** "Lists for 4 decks are published", counting decks (a Collector's Edition sits under its deck). */
export function publishedLine(decks: number): string {
  return decks === 1 ? "The list for one deck is published" : `Lists for ${decks} decks are published`;
}

/** "magic.wizards.com" from a source link, or null if it isn't a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
