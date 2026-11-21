// Settling the printing from the collector line by weight of evidence (Bryan, 15 Nov 2026, from
// the scanner consult: "accumulate evidence instead of three in a row"). Each candidate printing
// says what its collector line should show: number (with any promo suffix), set code, rarity
// letter, language. Every read of every crop is scored against that, with OCR's lookalikes
// (0/O, 1/I/L, 5/S, 8/B…) counting as near misses, and the scores are summed over frames. So one
// stray frame no longer resets anything, and a set code read in one frame adds up with a number
// read in another. The printing is settled when its evidence is well ahead of every other
// printing's (posterior and margin) and both its fields were read; otherwise the picker asks.
//
// Two traps it guards against (the consult's risks): a card from The List prints its original
// set code and number, so it and the original read the same; and a promo suffix (107p, 107s) is
// easily dropped by OCR. When the leader has such a twin, the set code and number are no proof:
// it's left to the picker, unless the leader's own suffix was read.
//
// The weights and thresholds below are first guesses [inferred], to be tuned on real reads.

import type { Printing } from "../api";
import { LANGS } from "./parse";

/** What a printing's collector line should show, upper case. */
export interface Expected {
  id: string;
  /** Set code as printed (The List: the original set's code). */
  set: string;
  /** Number as printed, leading zeros dropped, with its suffix ("107P"). */
  number: string;
  /** The number without its suffix ("107"). */
  base: string;
  /** Has a letter suffix (a promo or variant: 107p, 107s). */
  suffix: boolean;
  /** A reprint that prints another printing's set and number (The List). */
  list: boolean;
  /**
   * Its printed line isn't known: a reprint set that prints the original card's set and number
   * without saying which (Mystery Booster). It can look like any other candidate.
   */
  unknownLine: boolean;
  rarity: string | null;
  lang: string;
  /** Frames from 2014's M15 on print the set code; older ones print only the number. */
  printsSet: boolean;
}

/** Per-field weights of one frame's evidence. */
export const WEIGHTS = { number: 1.5, set: 1, rarity: 0.25, lang: 0.25 };
/**
 * Settling: the leader's summed evidence at least MIN_TOTAL, MARGIN ahead of the next printing,
 * its share of the posterior (softmax at TEMPERATURE) at least POSTERIOR, and each field it prints
 * read at least FIELD_MIN in some frame. One clean read of set and number (1.5 + 1 plus language)
 * meets these against a printing that shares only its set. A set code alone never does; a number
 * alone does only when no other candidate's number reads like it, read exactly on two frames
 * (numberAlone, since 21 Nov 2026).
 */
export const SETTLE = { minTotal: 2.4, margin: 1.5, posterior: 0.9, temperature: 3, fieldMin: 0.6 };
/** A token read as printed scores 1; one that matches only through OCR lookalikes 0.7; one lookalike-edit away 0.3. */
const EXACT = 1;
const LOOKALIKE = 0.7;
const NEAR = 0.3;
/** A number read without the candidate's suffix ("107" for 107p) still counts, for less. */
const BASE_ONLY = 0.6;

/** The first frame with a set code in the collector line (Magic 2015). */
const M15 = "2014-07-18";

/** Characters OCR mixes up, mapped to one shape. */
const SHAPE: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", T: "1", S: "5", B: "8", Z: "2", G: "6", A: "4", V: "U" };
const shape = (s: string) => [...s].map((c) => SHAPE[c] ?? c).join("");
const stripZeros = (s: string) => s.replace(/^0+(?=.)/, "");

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** How well a read token matches an expected field: 1, 0.7, 0.3 or 0. */
export function tokenMatch(token: string, expected: string, number = false): number {
  const t = number ? stripZeros(token) : token;
  if (t === expected) return EXACT;
  const ts = number ? stripZeros(shape(t)) : shape(t);
  const es = number ? stripZeros(shape(expected)) : shape(expected);
  if (ts === es) return LOOKALIKE;
  if (expected.length >= 3 && Math.abs(ts.length - es.length) <= 1 && editDistance(ts, es) === 1) return NEAR;
  return 0;
}

/**
 * Reprint sets whose cards print the original printing's set code and number (The List's numbers
 * say which: "MOM-214"; Mystery Booster's don't) [inferred from the review of 15 Nov 2026].
 */
export const PRINTS_ORIGINAL = new Set(["plst", "plist", "mb1", "fmb1", "mb2"]);

/** A printing as evidence.ts reads it. `parent_set_code`, when the API gives it, ties a promo set to its set. */
export type PrintingLine = Pick<Printing, "scryfall_id" | "set_code" | "collector_number" | "rarity" | "lang" | "released_at"> & { parent_set_code?: string | null };

export function expectedOf(p: PrintingLine): Expected {
  // The List: "MOM-214" is MOM 214 as printed on the card.
  const list = /^([A-Za-z0-9]{2,5})-([A-Za-z0-9★]+)$/.exec(p.collector_number);
  // A set's promos ("psoi" for SOI, "pwoe" for WOE: prerelease, promo pack) print the set's own
  // code; so does any set whose parent is the set, when the API says so.
  const promoOf = /^p([a-z0-9]{3})$/i.exec(p.set_code);
  const parent = p.parent_set_code && /^p/i.test(p.set_code) ? p.parent_set_code : null;
  const set = (list ? list[1]! : parent ? parent : promoOf ? promoOf[1]! : p.set_code).toUpperCase();
  const unknownLine = !list && PRINTS_ORIGINAL.has(p.set_code.toLowerCase());
  const raw = (list ? list[2]! : p.collector_number).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const number = stripZeros(raw);
  const base = number.replace(/[A-Z]+$/, "") || number;
  return {
    id: p.scryfall_id,
    set,
    number,
    base,
    suffix: base !== number,
    list: !!list,
    unknownLine,
    rarity: p.rarity ? p.rarity[0]!.toUpperCase() : null,
    lang: p.lang,
    printsSet: !p.released_at || p.released_at >= M15,
  };
}

/**
 * Whether another of these printings shows the same set code and number as `id` (The List's
 * reprint of it, or a suffix variant): then reading that set and number proves nothing.
 */
export function hasTwin(printings: readonly PrintingLine[], id: string): boolean {
  const all = printings.map(expectedOf);
  const me = all.find((e) => e.id === id);
  return !!me && all.some((e) => e.id !== id && (e.unknownLine || (e.set === me.set && e.base === me.base)));
}

/**
 * A "number/total" counts as a collector number only when the total is a plausible set size: at
 * least 20 and at least the number ("281/297", "030/280"). The total itself is dropped. Anything
 * else with a slash is power and toughness ("9/7" on a two-faced card's back) and is dropped whole.
 */
export function withoutTotals(text: string): string {
  return text.replace(/(\d{1,4})\s*\/\s*(\d{1,4})/g, (_, n: string, t: string) => (Number(t) >= 20 && Number(t) >= Number(n) ? n : " "));
}

/** Language codes a set code can be glued to ("MOMEEN", "MOMENJRYAN": the bullet, or the artist's brush, read as a letter). */
const GLUED_LANG = new RegExp(
  `^([A-Z0-9]{3,5}?)[EO]?(${Object.keys(LANGS)
    .sort((a, b) => b.length - a.length)
    .join("|")})`,
);

/**
 * The upper-case letter and digit runs of one read ("0145 C", "WOC • EN"), totals and P/T taken
 * out, and a zero-padded number split by a stray space ("02 86", "0 286": Bryan, 21 Nov 2026, "it
 * struggles with the spaces") read whole too, after the runs as read. Only a zero-padded one, as
 * printed since 2015: two plain numbers side by side are more often power and toughness read
 * without the slash ("2 2"). A merged number has no letters, so its parts can't prove the set code.
 *
 * Set codes split or glued by OCR ("M 19", "MOMEENJRYAN": the bullet or the artist's brush read as
 * a letter) are not read here, as proof: built from runs that may be something else (the rarity
 * letter and the number, an artist's name), they could prove a set code nobody read (Codex reviews
 * of #180). They only hold a settle back (printedSets, FieldScores.setAgainst); a card whose set
 * code is lost that way settles on its number when that's enough (numberAlone).
 */
export const tokens = (text: string) => {
  const clean = withoutTotals(text).toUpperCase();
  const read = clean.split(/[^A-Z0-9]+/).filter(Boolean);
  const extra: string[] = [];
  for (const line of clean.split(/\n+/)) {
    const runs = line.split(/[^A-Z0-9]+/).filter(Boolean);
    for (let i = 0; i + 1 < runs.length; i += 1) {
      const [a, b] = [runs[i]!, runs[i + 1]!];
      if (/^0\d*$/.test(a) && /^\d+[A-Z]?$/.test(b) && a.length + b.length >= 3 && a.length + b.length <= 5) extra.push(a + b);
    }
  }
  return [...read, ...extra.filter((t) => !read.includes(t))];
};

/**
 * What a line of the read may show where the set code is printed, before the language: the run
 * before it ("QRS • EN"), the two short runs before it read as one ("QR S • EN"), and a set code
 * glued to its language at the line's start ("QRSENJRYAN"). Only for holding a settle back when the
 * line may name a set code that isn't a printing's (FieldScores.setAgainst), never as proof: an
 * artist's name can look like one ("DOMENICO").
 */
export function printedSets(line: string): string[] {
  const runs = line.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 1 < runs.length; i += 1) {
    if (!(runs[i + 1]! in LANGS)) continue;
    const a = runs[i]!;
    const b = i > 0 ? runs[i - 1]! : null;
    if (b && b.length <= 2 && a.length <= 2 && b.length + a.length >= 3 && !(b in LANGS)) out.push(b + a);
    else out.push(a);
  }
  const first = runs[0];
  const glued = first && first.length >= 5 ? GLUED_LANG.exec(first) : null;
  if (glued) out.push(glued[1]!);
  return out.filter((t) => looksLikeSet(t) && /[A-Z]/.test(t));
}

/** Rarity letters printed next to the number, sometimes read glued to it ("0286M", "030U"). */
const RARITY_LETTERS = new Set(["C", "U", "R", "M", "S", "L", "T"]);

export interface FieldScores {
  number: number;
  set: number;
  rarity: number;
  lang: number;
  /** The number was read with this printing's own suffix. */
  suffixRead: boolean;
  /** The number, or the set code, was read exactly as printed (not only through lookalikes). */
  exactNumber: boolean;
  exactSet: boolean;
  /**
   * The number was read exactly in the printed form, at least three characters ("0022", "022",
   * "286"): what lets the number settle a printing by itself. A bare "22" is as likely power and
   * toughness glued together.
   */
  printedNumber: boolean;
  /** A set code was read where it's printed, before the language ("XYZ • EN"), and it isn't this printing's, even through lookalikes. */
  setAgainst: boolean;
}

/** Characters OCR reads for digits. A number is digits, or digits and these, with at most a suffix letter at the end. */
const NUMBERLIKE = /^[0-9ODQILTSBZGAU]*[A-Z]?$/;
/** Whether a token can be a collector number: at least one real digit, and otherwise digit lookalikes ("O14S", "281S"). */
export const looksLikeNumber = (t: string) => /\d/.test(t) && NUMBERLIKE.test(t);
/** Whether a token can be a set code: two to five characters with a letter in it ("W0C", "M19"). */
export const looksLikeSet = (t: string) => t.length >= 2 && t.length <= 5 && /[A-Z]/.test(t);

/**
 * One frame's evidence for one printing: the best each field was read, over the frame's crops.
 * A token counts for one field only: the number comes from a token that looks like a number, the
 * set code from one that looks like a set code, and never the same token for both ("SLD" is not
 * SLD #510's number through lookalikes).
 */
export function scoreFrame(e: Expected, reads: readonly string[]): FieldScores {
  const s: FieldScores = { number: 0, set: 0, rarity: 0, lang: 0, suffixRead: false, exactNumber: false, exactSet: false, printedNumber: false, setAgainst: false };
  const toks = reads.flatMap(tokens);
  /** The token as this printing's number: its own rarity letter, glued on, taken off ("0286M" for a mythic 286). */
  const asNumber = (t: string) => (!e.suffix && e.rarity && RARITY_LETTERS.has(e.rarity) && t.length > 1 && t.endsWith(e.rarity) && /\d$/.test(t.slice(0, -1)) ? t.slice(0, -1) : t);
  const numberOf = (raw: string) => {
    if (!looksLikeNumber(raw)) return 0;
    const t = asNumber(raw);
    const n = tokenMatch(t, e.number, true);
    if (n === 0 && e.suffix) return BASE_ONLY * tokenMatch(t, e.base, true);
    return n;
  };
  const setOf = (t: string) => (looksLikeSet(t) ? tokenMatch(t, e.set) : 0);
  const nums = toks.map(numberOf);
  const sets = toks.map(setOf);
  // The best pair of different tokens (or one field alone).
  let best = { n: -1, s: -1, score: 0 };
  for (let i = -1; i < toks.length; i += 1)
    for (let j = -1; j < toks.length; j += 1) {
      if (i >= 0 && i === j) continue;
      const score = WEIGHTS.number * (i >= 0 ? nums[i]! : 0) + WEIGHTS.set * (j >= 0 ? sets[j]! : 0);
      if (score > best.score) best = { n: i, s: j, score };
    }
  if (best.n >= 0) {
    s.number = nums[best.n]!;
    const t = stripZeros(asNumber(toks[best.n]!));
    s.exactNumber = t === e.number || (!e.suffix && t === e.base);
    s.suffixRead = e.suffix && t === e.number;
    s.printedNumber = s.exactNumber && asNumber(toks[best.n]!).length >= 3;
  }
  if (best.s >= 0) {
    s.set = sets[best.s]!;
    s.exactSet = toks[best.s] === e.set;
  }
  for (const t of toks) {
    if (t.length === 1 && e.rarity && t === e.rarity) s.rarity = 1;
    if (LANGS[t] === e.lang) s.lang = 1;
  }
  // A set code read where it's printed that isn't this printing's, even through lookalikes, split
  // or glued as tokens() reads it (Codex reviews of #180).
  for (const line of reads.flatMap((r) => r.split(/\n+/))) if (printedSets(line).some((t) => tokenMatch(t, e.set) === 0)) s.setAgainst = true;
  return s;
}

interface Tally {
  e: Expected;
  total: number;
  /** The best each field was read in any frame. */
  number: number;
  set: number;
  suffixRead: boolean;
  exactNumber: boolean;
  exactSet: boolean;
  /** Frames that read the number exactly in its printed form (FieldScores.printedNumber). */
  exactNumberFrames: number;
  /** A frame read a set code where it's printed that isn't this printing's. */
  setAgainst: boolean;
}

/**
 * Whether a printing's number, by itself, tells it from every other candidate (Bryan, 21 Nov 2026:
 * "even though it sees the number, like the 286, if that's enough to know for a particular card,
 * we're good"): no other printing's number reads the same through OCR's lookalikes, or one edit
 * away from it (a dropped or misread digit: 86 for 286, 287 for 286). A promo's suffix doesn't
 * count: 139s is the same number as 139 here, and the twin guard decides between them.
 */
export function numberAlone(all: readonly Expected[], me: Expected): boolean {
  // Mystery Booster prints another printing's number: its own number read is a misread.
  if (me.unknownLine) return false;
  const mine = stripZeros(shape(me.base));
  return all.every((o) => {
    if (o.id === me.id) return true;
    if (o.unknownLine) return false;
    const theirs = stripZeros(shape(o.base));
    return theirs !== mine && editDistance(theirs, mine) > 1;
  });
}

/** Frames of the number read exactly before it settles a printing by itself (one frame can be a misread). */
export const NUMBER_ALONE_FRAMES = 2;

export type Verdict =
  /** `alone`: settled on its number alone, with the set code unread (numberAlone). */
  | { kind: "settled"; id: string; margin: number; posterior: number; alone?: boolean }
  | { kind: "unsure"; leader: string | null; setRead: string | null; numberRead: string | null; twin: boolean; frames: number };

/** Evidence for one card's printings over one attempt (first read, hold and read, or the close-up). */
export class Evidence {
  private readonly tallies: Tally[];
  /** Printings sharing the art that aren't candidates (left out by the set lock): numberAlone checks against them too. */
  private readonly beside: Expected[];
  private frames = 0;

  /**
   * `beside`: the printings sharing the card's art that the candidates leave out (the set lock's
   * others). The card may be one of them, so the number alone settles a candidate only when no
   * printing among them has a number like it either (Codex reviews of #180).
   */
  constructor(printings: readonly PrintingLine[], beside: readonly PrintingLine[] = []) {
    this.tallies = printings.map((p) => ({ e: expectedOf(p), total: 0, number: 0, set: 0, suffixRead: false, exactNumber: false, exactSet: false, exactNumberFrames: 0, setAgainst: false }));
    const ids = new Set(printings.map((p) => p.scryfall_id));
    this.beside = beside.filter((p) => !ids.has(p.scryfall_id)).map(expectedOf);
  }

  /** Add one frame: the text read from each of its crops. */
  add(reads: readonly string[]) {
    if (!reads.some((r) => r.trim())) return;
    this.frames += 1;
    for (const t of this.tallies) {
      const s = scoreFrame(t.e, reads);
      t.total += WEIGHTS.number * s.number + WEIGHTS.set * s.set + WEIGHTS.rarity * s.rarity + WEIGHTS.lang * s.lang;
      t.number = Math.max(t.number, s.number);
      t.set = Math.max(t.set, s.set);
      t.suffixRead ||= s.suffixRead;
      t.exactNumber ||= s.exactNumber;
      t.exactSet ||= s.exactSet;
      if (s.printedNumber) t.exactNumberFrames += 1;
      t.setAgainst ||= s.setAgainst;
    }
  }

  /**
   * Printings whose line can't be told from the leader's by its set and number: The List's, a
   * promo set's suffix variant, or one whose line could be anything (Mystery Booster).
   */
  private twins(lead: Tally): Tally[] {
    return this.tallies.filter((t) => t !== lead && (t.e.unknownLine || (t.e.set === lead.e.set && t.e.base === lead.e.base)));
  }

  /**
   * Whether what has been read so far points to a printing other than `id` (settling by look, which
   * never settles against it; look.ts `lookSettles`): another printing's set code or number read
   * exactly as printed where `id`'s differs, or the evidence settled on another. Lookalike-only
   * reads point nowhere. Nothing read, nothing pointed to.
   */
  pointsAway(id: string): boolean {
    if (this.frames === 0) return false;
    const me = this.tallies.find((t) => t.e.id === id);
    // Read against other printings than these: it can't vouch for this one.
    if (!me) return true;
    const v = this.verdict();
    if (v.kind === "settled" && v.id !== id) return true;
    return this.tallies.some((t) => t !== me && ((t.exactSet && t.e.set !== me.e.set) || (t.exactNumber && t.e.number !== me.e.number)));
  }

  verdict(): Verdict {
    const ranked = [...this.tallies].sort((a, b) => b.total - a.total);
    const lead = ranked[0];
    if (!lead || lead.total <= 0) return { kind: "unsure", leader: null, setRead: null, numberRead: null, twin: false, frames: this.frames };
    const second = ranked[1]?.total ?? 0;
    const margin = lead.total - second;
    const k = SETTLE.temperature;
    const sum = ranked.reduce((n, t) => n + Math.exp(k * (t.total - lead.total)), 0);
    const posterior = 1 / sum;
    const numberOk = lead.number >= SETTLE.fieldMin;
    // The number alone is enough when no other candidate's number could be read as it, it was read
    // exactly in its printed form on two frames, nothing read names another printing's set code
    // (even through lookalikes) or its number exactly, and no set code read where it's printed
    // contradicts the leader's (a card from a set not among the candidates). Otherwise it's left
    // to the set code, as before.
    const alone =
      lead.e.printsSet &&
      lead.exactNumberFrames >= NUMBER_ALONE_FRAMES &&
      numberAlone([...this.tallies.map((t) => t.e), ...this.beside], lead.e) &&
      !lead.setAgainst &&
      !this.tallies.some((t) => t !== lead && ((t.set >= LOOKALIKE && t.e.set !== lead.e.set) || (t.exactNumber && t.e.base !== lead.e.base)));
    const setOk = !lead.e.printsSet || lead.set >= SETTLE.fieldMin || alone;
    // Settling needs a field read exactly as printed, and the other at least through lookalikes:
    // lookalike-only reads ("O14S W0C") order the picker and show progress, and never settle.
    const exactOk = lead.e.printsSet ? alone || ((lead.exactNumber || lead.exactSet) && lead.number >= LOOKALIKE && lead.set >= LOOKALIKE) : lead.exactNumber;
    const twins = this.twins(lead);
    // A twin: proof only when what tells them apart was read exactly: the leader's own suffix
    // (and no List twin prints the same suffixed number). A Mystery Booster twin could be any of
    // them, unless the leader is one and its own code was read.
    const twinBlocks =
      twins.length > 0 &&
      !(lead.e.suffix && lead.suffixRead && !twins.some((t) => t.e.unknownLine || t.e.number === lead.e.number)) &&
      !(lead.e.unknownLine && lead.exactSet);
    if (lead.total >= SETTLE.minTotal && margin >= SETTLE.margin && posterior >= SETTLE.posterior && numberOk && setOk && exactOk && !twinBlocks)
      return { kind: "settled", id: lead.e.id, margin, posterior, ...(alone && lead.set < SETTLE.fieldMin ? { alone: true } : {}) };
    return {
      kind: "unsure",
      leader: lead.e.id,
      setRead: lead.e.printsSet && lead.set >= SETTLE.fieldMin ? lead.e.set : null,
      numberRead: numberOk ? lead.e.number : null,
      twin: numberOk && setOk && twinBlocks,
      frames: this.frames,
    };
  }
}

/**
 * A collector line read some other way (a card found by its text: `decide()` in pipeline.ts) weighed
 * as one frame of evidence: the printing it proves, if any, under the same rules as hold and read
 * (one field exact, the other at least a lookalike, the twin guards). A confident title with a
 * lookalike-only line ("O14S W0C • EN" under "Arcane Signet": 0.97 from decide) proves nothing.
 * The evidence carries on into hold and read.
 */
export function proofOf(printings: readonly PrintingLine[], text: string, beside: readonly PrintingLine[] = []): { proven: string | null; ev: Evidence } {
  const ev = new Evidence(printings, beside);
  ev.add([text]);
  const v = ev.verdict();
  return { proven: v.kind === "settled" ? v.id : null, ev };
}

/** What the sheet says while the printing is being read. */
export function progressLine(v: Verdict, printings: number): string {
  if (v.kind === "settled") return "Read the set code and number";
  if (v.twin) return "Read the set code and number, but another printing shows the same (The List, or a promo)";
  if (v.setRead && v.numberRead) return `Read ${v.setRead} ${v.numberRead}; checking it against the other ${printings - 1} printings`;
  if (v.setRead) return `Read the set code (${v.setRead}), not the number yet`;
  if (v.numberRead) return `Read the number (${v.numberRead}), not the set code yet`;
  return "Reading the set code and number";
}
