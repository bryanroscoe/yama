// What makes a printing special, in plain words, and the finishes a copy of it can be.
//
// Scryfall marks special printings with promo types ("surgefoil", "serialized"), frame effects
// ("showcase", "extendedart"), a border color and full art; the server stores them as Scryfall
// sends them (migration 0093) and the collection CSV names them with the same table in Rust
// (server/src/cards/treatment.rs): keep the two in step. A special foil is its own printing,
// with its own collector number, so "Surge foil, MSC 40" says which card it is.

/** A printing's Scryfall treatment fields. Absent: not known (or none). */
export interface Treated {
  promo_types?: string[] | null;
  frame_effects?: string[] | null;
  border_color?: string | null;
  full_art?: boolean | null;
}

/**
 * Scryfall promo types that are a kind of foil. They only describe a foil copy: a regular copy
 * of a printing that also comes in surge foil isn't a surge foil.
 */
export const FOIL_KINDS: Readonly<Record<string, string>> = {
  surgefoil: "Surge foil",
  galaxyfoil: "Galaxy foil",
  textured: "Textured foil",
  doublerainbow: "Double rainbow",
  halofoil: "Halo foil",
  stepandcompleat: "Step-and-compleat",
  oilslick: "Oil slick",
  confettifoil: "Confetti foil",
  raisedfoil: "Raised foil",
  gilded: "Gilded foil",
  fracturefoil: "Fracture foil",
  rainbowfoil: "Rainbow foil",
  manafoil: "Mana foil",
  neonink: "Neon ink",
  chocobotrackfoil: "Chocobo track foil",
  silverfoil: "Silver foil",
  ripplefoil: "Ripple foil",
  dragonscalefoil: "Dragon scale foil",
  singularityfoil: "Singularity foil",
  cosmicfoil: "Cosmic foil",
  firstplacefoil: "First place foil",
};

/** Promo types that describe every copy of the printing. */
const ALWAYS: Readonly<Record<string, string>> = { serialized: "Serialized" };

/**
 * "Surge foil, Showcase": what sets a printing apart, for a copy in `finish` (nonfoil, foil,
 * etched), or for the printing itself without one. Null for an ordinary printing, and before the
 * import that reads these fields has run. Promo types Yama has no words for are left out, never
 * shown raw.
 */
export function treatmentLabel(p: Treated, finish?: string | null): string | null {
  const promos = p.promo_types ?? [];
  const frames = p.frame_effects ?? [];
  const words: string[] = [];
  // The table's order, whatever order Scryfall lists them in (the Rust labeler does the same).
  if (finish !== "nonfoil") for (const [id, words_] of Object.entries(FOIL_KINDS)) if (promos.includes(id)) words.push(words_);
  for (const [id, words_] of Object.entries(ALWAYS)) if (promos.includes(id)) words.push(words_);
  if (frames.includes("showcase")) words.push("Showcase");
  if (frames.includes("extendedart")) words.push("Extended art");
  if (p.border_color === "borderless") words.push("Borderless");
  if (p.full_art) words.push("Full art");
  return words.length ? words.join(", ") : null;
}

/** A finish in words, capitalised for a control: "Regular", "Foil", "Etched", "Proxy". */
export function finishName(finish: string): string {
  return finish === "nonfoil" ? "Regular" : finish === "etched" ? "Etched" : finish === "foil" ? "Foil" : finish === "proxy" ? "Proxy" : finish;
}

/**
 * "Surge foil, MSC 40", "Showcase, CMM 410, etched", "CMM 410": a printing for a line, with the
 * copy's finish when it isn't regular (left out when the special words already say foil) and the
 * language when it isn't English.
 */
export function printingLabel(p: Treated & { set_code: string; collector_number: string; lang?: string | null }, finish?: string | null): string {
  const special = treatmentLabel(p, finish);
  const bits: string[] = [];
  if (special) bits.push(special);
  bits.push(`${p.set_code.toUpperCase()} ${p.collector_number}`);
  if (finish && finish !== "nonfoil" && !(finish === "foil" && special && /\bfoil\b/i.test(special))) bits.push(finish);
  if (p.lang && p.lang !== "en") bits.push(p.lang);
  return bits.join(", ");
}

/**
 * A copy's printing and finish in words, for a line that already names the set: "Surge foil",
 * "Showcase, etched", "regular". The finish is left out when the special words already say foil.
 */
export function copyWords(p: Treated, finish: string): string {
  const special = treatmentLabel(p, finish);
  const word = finish === "nonfoil" ? "regular" : finish;
  if (!special) return word;
  return finish === "foil" && /\bfoil\b/i.test(special) ? special : `${special}, ${word}`;
}

const ORDER = ["nonfoil", "foil", "etched"];

/** The finishes a printing comes in, in Yama's order. Unknown (none listed): all three. */
export function finishesOf(p: { finishes?: string[] | null } | null | undefined): string[] {
  const listed = (p?.finishes ?? []).filter((f) => ORDER.includes(f));
  return listed.length ? ORDER.filter((f) => listed.includes(f)) : [...ORDER];
}

/**
 * The finish to file a copy of this printing in: its only finish when it has one; else the
 * finish chosen last (`wanted`), if it comes that way; else regular, if it comes that way; else
 * its first.
 */
export function pickFinish(p: { finishes?: string[] | null } | null | undefined, wanted: string): string {
  const offered = finishesOf(p);
  if (offered.length === 1) return offered[0]!;
  if (offered.includes(wanted)) return wanted;
  return offered.includes("nonfoil") ? "nonfoil" : offered[0]!;
}

/** A printing's market price for a finish (TCGplayer via Scryfall). Missing stays null, never 0. */
export function finishPrice(p: { usd: number | null; usd_foil: number | null; usd_etched?: number | null }, finish: string): number | null {
  return finish === "foil" ? p.usd_foil : finish === "etched" ? (p.usd_etched ?? null) : p.usd;
}
