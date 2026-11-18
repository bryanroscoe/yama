// Card from art and title together: the first step of one scorer for the card (Bryan, 15 Nov 2026,
// from the scanner consult). Until now the art decided alone once it scored 0.82, or 0.62 on two
// frames, and a card scoring 0.50 to 0.62 showed "Hold still" for as long as it was held. Now
// the title is read too whenever the art isn't sure (under 0.82) or two different cards score
// about the same, and a clear title decides: it settles the card when the art also has it among
// its matches, and vetoes the art when it names a card the art doesn't, which is then taken by
// its title. An unclear title changes nothing. Thresholds are first guesses [inferred].

import type { NameIndex } from "./fuzzy";

/** Art at or above this, with no close rival, is sure enough not to read the title. */
export const ART_SURE = 0.82;
/** Two different cards within this of each other are a close call. */
export const ART_CLOSE = 0.03;
/** Art matches below this aren't counted as the art "having" a card. */
export const ART_FLOOR = 0.5;
/** A title read is clear at this name-match score, this far ahead of the next name. */
export const TITLE_CLEAR = 0.85;
export const TITLE_MARGIN = 0.08;
/**
 * A title read short of clear still settles the card when it names one of the art's own matches:
 * two weak reads that agree (Bryan, 17 Nov 2026: deck checks sat on "Hold still" with right cards
 * scoring 0.64 to 0.70 by art and titles read just short of clear). [inferred]
 */
export const TITLE_AGREES = 0.7;
export const AGREE_MARGIN = 0.04;

/**
 * Art that clearly leads every other card decides without the title, like ART_SURE (Bryan, 18 Nov
 * 2026: the scanners got "stuck about 50% of the time"). Measured on 124 of his real scan photos
 * (scan_samples, bundle gallery-20261106T183001884398Z, the phone's scores reproduced offline):
 * the right card scores a median 0.78 there (0.97 on the synthetic eval), so only 36% reach
 * ART_SURE, and below it the title was read on every frame and a fair match waited for its
 * untitled frames. The lead (best match minus the best match of a different card; other printings
 * and illustrations of the same card aren't rivals) tells right from wrong where the score can't:
 * every wrong best match had a lead under 0.06, the foil Westvale Abbey filed as Wei Night Raiders
 * at 0.658 among them. At LEAD_FLOOR and LEAD_MARGIN, on one frame: 84.7% of the photos lock, none
 * wrongly; with each photo's card hidden from the art (a card the bundle lacks), the best wrong
 * card scored a median 0.584 (max 0.726) with a median lead of 0.018 (max 0.102), and 0 of 124
 * would lock. Looser rules locked more and went wrong: 0.62 and 0.08 locked 2 of the 124 unknown
 * cards, 0.60 and 0.05 one known card wrongly. The live camera also asks for LEAD_FRAMES frames in
 * a row. One person's single session of successful scans, so biased toward easier cards. Not with
 * the set lock on sets whose art the index mostly lacks: a card from the same set can lead there
 * for one it doesn't know (review, 18 Nov 2026), so the title is read as before.
 */
export const LEAD_FLOOR = 0.65;
export const LEAD_MARGIN = 0.1;

export interface ArtCandidate {
  name: string;
  score: number;
}

/** A title read matched against card names: the best name (its full name), its score and its lead over the next. */
export interface TitleRead {
  name: string;
  score: number;
  margin: number;
}

export type Fused<M> = { kind: "art"; match: M } | { kind: "title"; name: string } | { kind: "none" };

const faces = (name: string) => name.toLowerCase().split(" // ");
const sameCard = (artName: string, title: string) => {
  const t = title.toLowerCase();
  return artName.toLowerCase() === t || faces(artName).includes(t) || faces(title).some((f) => faces(artName).includes(f));
};

const lowest = (matches: readonly ArtCandidate[]) => matches.reduce((low, m) => Math.min(low, m.score), Infinity);

/**
 * How far `top` scores above the best match of a different card (other printings and illustrations
 * of the same card aren't rivals). The art search lists only its best few artworks (5), and a card
 * with many illustrations (a basic land) can fill the list: every artwork not listed scores at
 * most `unlisted`, the lowest score the search listed, so that is the rival when no other card is
 * listed. It defaults to the lowest score in `matches`; with the set lock's pool merged in (which
 * can list artworks below the search's own cutoff), pass the search's.
 */
export function artLead(matches: readonly ArtCandidate[], top: ArtCandidate | undefined = matches[0], unlisted = lowest(matches)): number {
  if (!top) return 0;
  let rival = unlisted;
  for (const m of matches) if (!sameCard(m.name, top.name) && m.score > rival) rival = m.score;
  return top.score - rival;
}

/** Whether a match with this score and lead (artLead) leads every other card: it settles which card without the title. */
export const leads = (score: number, lead: number) => score >= LEAD_FLOOR && lead >= LEAD_MARGIN;

/**
 * Whether to read the title for these art matches (best first): not for a sure match (ART_SURE)
 * without a close rival, nor for one that leads every other card. `unlisted` as for artLead.
 */
export function needsTitle(matches: readonly ArtCandidate[], unlisted?: number): boolean {
  const [top, ...rest] = matches;
  if (!top) return false;
  if (top.score < ART_SURE) return !leads(top.score, artLead(matches, top, unlisted));
  const rival = rest.find((m) => !sameCard(m.name, top.name));
  return !!rival && top.score - rival.score < ART_CLOSE;
}

/** Frames in a row the same card must lead before the live camera takes it (a still photo has one). */
export const LEAD_FRAMES = 2;

/** Which rule decided the card: the art alone (sure, leads, twice: see ScannerView), a title read, or the card's text. */
export type LockRule = "sure" | "leads" | "twice" | "title" | "text";

/**
 * Frames in a row one card has led every other card, frame by frame. By card, not artwork: with
 * the set lock the best match can swap between the card's in-set and outside artworks, and a run
 * that started again on each swap would wait for ever with no title read.
 */
export class LeadRun {
  private card: string | null = null;
  private frames = 0;
  /** This frame's leading card (its name), or null when no card leads: the frames in a row it has led. */
  step(leader: string | null): number {
    this.frames = leader === null ? 0 : this.card !== null && sameCard(this.card, leader) ? this.frames + 1 : 1;
    this.card = leader;
    return this.frames;
  }
}

/**
 * When the title isn't needed (needsTitle false): whether the art decides on this frame, and by
 * which rule. A sure match (ART_SURE) at once; one that only leads after `frames` frames in a row.
 */
export function artDecides(score: number, run: number, frames = LEAD_FRAMES): "sure" | "leads" | null {
  if (score >= ART_SURE) return "sure";
  return run >= frames ? "leads" : null;
}

export const clearTitle = (t: TitleRead | null): t is TitleRead => !!t && t.score >= TITLE_CLEAR && t.margin >= TITLE_MARGIN;

/** The art match (at least ART_FLOOR) that names this card, if any. */
export function artHas<M extends ArtCandidate>(matches: readonly M[], name: string): M | undefined {
  return matches.find((m) => m.score >= ART_FLOOR && sameCard(m.name, name));
}

/**
 * The card from the art matches (best first) and a title read: the art match the title names
 * (when the title is clear, or, with `agree`, fairly clear: TITLE_AGREES), the title's card when a
 * clear title names a card the art doesn't have, or nothing.
 */
export function fuseTitle<M extends ArtCandidate>(matches: readonly M[], title: TitleRead | null, opts: { agree?: boolean } = {}): Fused<M> {
  if (!title) return { kind: "none" };
  const match = artHas(matches, title.name);
  if (title.score >= TITLE_CLEAR && title.margin >= TITLE_MARGIN) return match ? { kind: "art", match } : { kind: "title", name: title.name };
  return opts.agree && match && title.score >= TITLE_AGREES && title.margin >= AGREE_MARGIN ? { kind: "art", match } : { kind: "none" };
}

/**
 * The best of a few title reads, matched against every card name: the full name of the card it
 * names (a face read, "Westvale Abbey", is the two-faced card), its score and its lead.
 */
export function titleRead(texts: readonly string[], reader: { names: Pick<NameIndex, "match">; catalog: { fullName?(name: string): string } }): TitleRead | null {
  let best: TitleRead | null = null;
  for (const t of texts) {
    if (!t.trim()) continue;
    const [a, b] = reader.names.match(t, 2);
    if (!a) continue;
    const r = { name: reader.catalog.fullName?.(a.name) ?? a.name, score: a.score, margin: a.score - (b?.score ?? 0) };
    if (!best || r.score > best.score) best = r;
  }
  return best;
}
