// An estimate on the older 1-10 power-level scale, for players who still talk in it. The
// starting bracket suggestion sets a two-point band (2: 3-5, 3: 5-7, 4: 7-9) and the deck's
// efficiency moves it inside the band: cheap mana, cheap card draw, cheap interaction, tutors,
// a low curve, Game Changers, two-card combos, and mass land denial or extra turns. Every factor
// has a cap and a weight, and the weights add up to the band's width, so one kind of card can't
// carry the whole score. It's Yama's own heuristic from the card list, not an official scale
// or a measure of how the deck plays.

import { isLand, type StatCard } from "./deckStats";

/** Signals from the bracket check (Commander Spellbook), with the cards behind them. */
export interface PowerSignals {
  /** The starting bracket suggestion. Only 2-4 get a score: Yama never suggests 1 or 5. */
  bracket: number | null;
  gameChangers: string[];
  /** Spellbook's definite two-card combos, one "A + B" label each. */
  twoCardCombos: string[];
  massLandDenial: string[];
  extraTurns: string[];
}

export type PowerFactorKey = "mana" | "draw" | "interaction" | "tutors" | "curve" | "gameChangers" | "combos" | "denial";

export interface PowerFactor {
  key: PowerFactorKey;
  label: string;
  /** What counts, in a sentence. */
  rule: string;
  /** Copies counted (the curve factor: the nonland average mana value). */
  count: number;
  /** The count at which the factor gives its full weight. */
  cap: number;
  /** Share of the band, 0-1; the weights add up to 1. */
  weight: number;
  /** Points added to the score, from 0 to weight times the band's width. */
  points: number;
  cards: string[];
}

export interface PowerEstimate {
  /** 1 decimal. */
  score: number;
  bracket: number;
  band: [number, number];
  factors: PowerFactor[];
  /** Cards missing from the card data, which the card-text factors can't count. */
  unknownCards: string[];
}

export const POWER_BANDS: Record<number, [number, number]> = { 2: [3, 5], 3: [5, 7], 4: [7, 9] };

/** At or below this nonland average the curve factor is full; at or above the flat end, zero. */
const CURVE_FULL = 2.5;
const CURVE_FLAT = 4;

const CHEAP = 2;
const BASIC_OR_LAND = /\b(?:land|plains|island|swamp|mountain|forest|wastes)\b/i;
const NONLAND_TYPE = /\b(?:creature|artifact|enchantment|instant|sorcery|planeswalker|battle|equipment|aura)\b/i;

const MAKES_MANA = /\badds? (?:\{|(?:one|two|three|x|an amount of) mana\b)/i;
/** "Target", or the optional "up to one target". */
const T = String.raw`(?:up to (?:one|two|three|x) )?target`;
const INTERACTION = new RegExp(
  [
    String.raw`\bcounter ${T}\b`,
    String.raw`\bdestroy ${T}\b`,
    String.raw`\bexile ${T} (?!card from|cards from)`,
    String.raw`\breturn ${T} (?:[^.]*?) to (?:its|their) owner'?s'? hands?\b`,
    String.raw`\bdeals? (?:\d+|x) damage to (?:any target|${T} (?:creature|planeswalker|player|opponent|attacking|blocking))`,
    String.raw`\bput ${T} (?:[^.]*?) (?:into|on (?:the )?(?:top|bottom) of) (?:its|their) owner'?s'? library`,
    String.raw`\btarget (?:[^.]*?)\bgets? -(?:\d+|x)\/-(?:\d+|x)`,
    String.raw`\bfights? ${T}\b`,
    String.raw`\b(?:target (?:player|opponent)|each opponent) sacrifices\b`,
  ].join("|"),
  "i",
);
/** Targets limited to your own things (Ephemerate, Cloudshift) make a blink, not interaction;
 *  a sentence counts while one target isn't yours (Prey Upon). */
const OWN_TARGET = /\btarget (?:[^.]*?)\byou (?:control|own)\b/gi;
function onlyOwnTargets(sentence: string): boolean {
  const targets = (sentence.match(/\btarget\b/gi) ?? []).length;
  return targets > 0 && (sentence.match(OWN_TARGET) ?? []).length >= targets;
}

const faceText = (c: StatCard) => c.oracleText ?? "";
/** The card data joins a multi-face card's rules text with a "//" line. The mana value is the
 *  front face's, so the cheap factors read only the front face: an Adventure's draw costs more. */
const frontText = (c: StatCard) => faceText(c).split(/\n\/\/\n/)[0]!;
const hasLandBack = (c: StatCard) => (c.typeLine ?? "").split(" // ").slice(1).some((t) => t.includes("Land"));

/** A rock, dork or ritual, or a spell that puts a land onto the battlefield. */
export function isCheapMana(c: StatCard): boolean {
  if (c.cmc == null || c.cmc > CHEAP || isLand(c)) return false;
  const text = frontText(c);
  if (/search your library for [^.]*\b(?:land|plains|island|swamp|mountain|forest)s? cards?\b[^.]*onto the battlefield/i.test(text)) return true;
  // Produced mana covers every face, so a spell with a land back (Malakir Rebirth) would count
  // for its land; then only the front face's own mana counts.
  // While produced mana isn't loaded, the rules text says whether the card makes mana.
  if (hasLandBack(c) || c.producedMana == null) return MAKES_MANA.test(text);
  return !!c.producedMana;
}

export function isCheapDraw(c: StatCard): boolean {
  if (c.cmc == null || c.cmc > CHEAP || isLand(c)) return false;
  // "Whenever an opponent draws a card" (Orcish Bowmasters) isn't this deck drawing.
  return /(?<!opponent )\bdraws? (?:a|an|one|two|three|four|five|x|that many) (?:additional )?cards?\b|(?<!opponent )\bdraws? cards? equal\b/i.test(frontText(c));
}

/** Removal (destroy, exile, damage, -N/-N, fight, edict, tuck), a counterspell or a bounce,
 *  at two mana or less. */
export function isCheapInteraction(c: StatCard): boolean {
  if (c.cmc == null || c.cmc > CHEAP || isLand(c)) return false;
  return frontText(c).split(/[.\n]/).some((sentence) => INTERACTION.test(sentence) && !onlyOwnTargets(sentence));
}

/** Finds a card other than a land from the library. */
export function isTutor(c: StatCard): boolean {
  if (isLand(c)) return false;
  for (const [, what] of faceText(c).matchAll(/search(?:es)? (?:your|their) (?:library|graveyard and\/or library|library and\/or graveyard) for ([^.]*?)\bcards?\b/gi)) {
    // "A creature or land card" can still find a nonland card.
    if (!BASIC_OR_LAND.test(what!) || NONLAND_TYPE.test(what!)) return true;
  }
  return false;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function powerEstimate(all: StatCard[], signals: PowerSignals): PowerEstimate | null {
  const band = signals.bracket == null ? undefined : POWER_BANDS[signals.bracket];
  if (!band) return null;
  const width = band[1] - band[0];
  const cards = all.filter((c) => c.board !== "side" && c.qty > 0);
  const known = cards.filter((c) => c.typeLine != null && c.cmc != null);
  const unknownCards = cards.filter((c) => c.typeLine == null || c.cmc == null).map((c) => c.name);

  const counted = (test: (c: StatCard) => boolean) => {
    const hits = known.filter(test);
    return { count: hits.reduce((n, c) => n + c.qty, 0), cards: hits.map((c) => c.name) };
  };
  const factor = (key: PowerFactorKey, label: string, rule: string, cap: number, weight: number, hit: { count: number; cards: string[] }): PowerFactor => ({
    key, label, rule, cap, weight, count: hit.count, cards: hit.cards,
    points: (Math.min(hit.count, cap) / cap) * weight * width,
  });

  const nonland = known.filter((c) => !isLand(c));
  const nonlandCopies = nonland.reduce((n, c) => n + c.qty, 0);
  const averageMv = nonlandCopies ? nonland.reduce((n, c) => n + c.cmc! * c.qty, 0) / nonlandCopies : null;
  const curveShare = averageMv == null ? 0 : Math.min(1, Math.max(0, (CURVE_FLAT - averageMv) / (CURVE_FLAT - CURVE_FULL)));
  const curveWeight = 0.15;

  const factors: PowerFactor[] = [
    factor("mana", "Cheap mana", "Rocks, dorks, rituals and land ramp at two mana or less", 8, 0.15, counted(isCheapMana)),
    factor("draw", "Cheap card draw", "Nonland cards at two mana or less that draw cards", 8, 0.1, counted(isCheapDraw)),
    factor("interaction", "Cheap interaction", "Targeted removal, counterspells and bounce at two mana or less", 8, 0.15, counted(isCheapInteraction)),
    factor("tutors", "Tutors", "Cards that search the library for something other than a land", 4, 0.1, counted(isTutor)),
    {
      key: "curve", label: "Low curve", rule: `Nonland average mana value: full at ${CURVE_FULL} or less, nothing at ${CURVE_FLAT} or more`,
      count: averageMv == null ? 0 : Math.round(averageMv * 100) / 100, cap: CURVE_FULL, weight: curveWeight,
      points: curveShare * curveWeight * width, cards: [],
    },
    factor("gameChangers", "Game Changers", "Cards on the official Game Changer list", 4, 0.15, { count: signals.gameChangers.length, cards: signals.gameChangers }),
    factor("combos", "Two-card combos", "Commander Spellbook's definite two-card combos", 2, 0.15, { count: signals.twoCardCombos.length, cards: signals.twoCardCombos }),
    factor("denial", "Mass land denial and extra turns", "Cards Commander Spellbook flags for either", 2, 0.05, {
      count: signals.massLandDenial.length + signals.extraTurns.length,
      cards: [...signals.massLandDenial, ...signals.extraTurns],
    }),
  ];
  const score = band[0] + factors.reduce((n, f) => n + f.points, 0);
  return { score: round1(Math.min(band[1], score)), bracket: signals.bracket!, band, factors, unknownCards };
}
