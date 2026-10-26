// Deck statistics for the deck page: mana curve, average mana value, land count, and colored
// pips against the lands that make each color. Commander and main deck count; the sideboard
// doesn't.

export type DeckBoard = "commander" | "main" | "side";
export type Color = "W" | "U" | "B" | "R" | "G";
export const COLORS: Color[] = ["W", "U", "B", "R", "G"];

export interface StatCard {
  name: string;
  qty: number;
  board: DeckBoard;
  /** Mana value; null when the card isn't in the card data. */
  cmc: number | null;
  typeLine: string | null;
  manaCost: string | null;
  /** Colors of mana the card makes ("WUBRGC" letters); "" for none; null when not loaded. */
  producedMana: string | null;
  oracleText?: string | null;
}

export interface CurveBucket {
  /** 0-6, and 7 for "7 or more". */
  mv: number;
  creatures: number;
  others: number;
}

export interface ColorStat {
  color: Color;
  /** Colored mana symbols in the costs of the commander and main deck (per copy). Only colors
   *  with pips are listed: lands like Command Tower make every color, which says nothing here. */
  pips: number;
  /** Lands (and land faces) that can make this color, per copy. null while any land in the deck
   *  has no mana data yet: it could make this color, so a number would be a guess. */
  sources: number | null;
}

export interface DeckStats {
  /** Copies in the commander and main deck. */
  cards: number;
  lands: number;
  nonlands: number;
  /** Average mana value over every card, lands as 0. null with no cards. */
  averageMv: number | null;
  /** Average over nonland cards only. */
  averageMvNonland: number | null;
  curve: CurveBucket[];
  colors: ColorStat[];
  /** Lands whose mana isn't in the card data yet. While there are any, sources aren't counted. */
  landsWithoutManaData: string[];
  /** Lands (cards with a land face) whose mana is known. */
  landsWithManaData: number;
  /** Cards missing from the card data, left out of everything above but the count. */
  unknownCards: string[];
}

const front = (s: string | null | undefined) => (s ?? "").split(" // ")[0]!;
const faces = (s: string | null | undefined) => (s ?? "").split(" // ");

export function isLand(c: Pick<StatCard, "typeLine">): boolean {
  return front(c.typeLine).includes("Land");
}

function hasLandFace(c: StatCard): boolean {
  return faces(c.typeLine).some((t) => t.includes("Land"));
}

function isCreature(c: StatCard): boolean {
  return front(c.typeLine).includes("Creature");
}

/**
 * Colored pips in a mana cost (front face of a multi-face card). Hybrid symbols count for each of
 * their colors ({W/U} is a white pip and a blue pip), as do Phyrexian ({G/P}) and twobrid ({2/R}).
 */
export function pipsOf(cost: string | null | undefined): Record<Color, number> {
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const [, sym] of front(cost).matchAll(/\{([^}]+)\}/g)) {
    for (const part of new Set(sym!.toUpperCase().split("/"))) {
      if ((COLORS as string[]).includes(part)) out[part as Color] += 1;
    }
  }
  return out;
}

const BASIC_TYPES: [string, Color][] = [["Plains", "W"], ["Island", "U"], ["Swamp", "B"], ["Mountain", "R"], ["Forest", "G"]];

/**
 * Colors a land can make. Scryfall's produced_mana covers lands that tap for mana. Lands that
 * fetch instead (Evolving Wilds, Wooded Foothills) make none themselves; they count for the land
 * types they name, and "a basic land card" counts for the basics this deck runs.
 */
function landColors(c: StatCard, deckBasics: Set<Color>, fetchTargets: Map<string, Set<Color>>): Set<Color> | null {
  if (c.producedMana == null) return null;
  const made = new Set([...c.producedMana].filter((x): x is Color => (COLORS as string[]).includes(x)));
  if (made.size > 0) return made;
  const text = c.oracleText ?? "";
  if (/search your library for/i.test(text)) {
    for (const [type] of BASIC_TYPES) {
      if (new RegExp(`\\b${type}\\b`).test(text)) for (const color of fetchTargets.get(type) ?? []) made.add(color);
    }
    if (/basic land card/i.test(text)) for (const color of deckBasics) made.add(color);
  }
  return made;
}

export function deckStats(all: StatCard[]): DeckStats {
  const cards = all.filter((c) => c.board !== "side" && c.qty > 0);
  const known = cards.filter((c) => c.typeLine != null && c.cmc != null);
  const unknownCards = cards.filter((c) => c.typeLine == null || c.cmc == null).map((c) => c.name);

  const curve: CurveBucket[] = Array.from({ length: 8 }, (_, mv) => ({ mv, creatures: 0, others: 0 }));
  let lands = 0;
  let nonlands = 0;
  let mvTotal = 0;
  const pips: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of known) {
    if (isLand(c)) {
      lands += c.qty;
      continue;
    }
    nonlands += c.qty;
    mvTotal += c.cmc! * c.qty;
    const bucket = curve[Math.min(7, Math.max(0, Math.floor(c.cmc!)))]!;
    if (isCreature(c)) bucket.creatures += c.qty;
    else bucket.others += c.qty;
    const p = pipsOf(c.manaCost);
    for (const color of COLORS) pips[color] += p[color] * c.qty;
  }

  const deckBasics = new Set<Color>();
  const fetchTargets = new Map<string, Set<Color>>();
  for (const c of known) {
    // A land back face isn't a land in the library and can't be fetched as one.
    if (!isLand(c)) continue;
    for (const [type, color] of BASIC_TYPES) {
      if (!front(c.typeLine).includes(type)) continue;
      if (front(c.typeLine).includes("Basic")) deckBasics.add(color);
      const targetColors = fetchTargets.get(type) ?? new Set<Color>();
      for (const made of c.producedMana ?? "") if ((COLORS as string[]).includes(made)) targetColors.add(made as Color);
      fetchTargets.set(type, targetColors);
    }
  }
  const sources: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const landsWithoutManaData: string[] = [];
  let landsWithManaData = 0;
  for (const c of known.filter(hasLandFace)) {
    const colors = landColors(c, deckBasics, fetchTargets);
    if (colors == null) {
      landsWithoutManaData.push(c.name);
      continue;
    }
    landsWithManaData += 1;
    for (const color of colors) sources[color] += c.qty;
  }
  // A land without data could make any color, so no count is safe until every land has it.
  const counted = landsWithoutManaData.length === 0;

  const colors: ColorStat[] = COLORS.filter((c) => pips[c] > 0).map((color) => ({
    color,
    pips: pips[color],
    sources: counted ? sources[color] : null,
  }));
  const total = lands + nonlands;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    cards: cards.reduce((a, c) => a + c.qty, 0),
    lands,
    nonlands,
    averageMv: total ? round(mvTotal / total) : null,
    averageMvNonland: nonlands ? round(mvTotal / nonlands) : null,
    curve,
    colors,
    landsWithoutManaData,
    landsWithManaData,
    unknownCards,
  };
}
