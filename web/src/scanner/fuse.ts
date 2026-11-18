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

/** Whether to read the title for these art matches (best first). */
export function needsTitle(matches: readonly ArtCandidate[]): boolean {
  const [top, ...rest] = matches;
  if (!top) return false;
  if (top.score < ART_SURE) return true;
  const rival = rest.find((m) => !sameCard(m.name, top.name));
  return !!rival && top.score - rival.score < ART_CLOSE;
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
