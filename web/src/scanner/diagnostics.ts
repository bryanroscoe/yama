// Scanner diagnostics (Bryan, 15 Nov 2026, and the scanner consult's first item: a replayable
// record of what the scanner saw). With "Scanner diagnostics" on in Scan settings (per device,
// off by default, owner-only: separate from Save scan photos, which are shared), each card the
// scanner struggled with is kept:
//   - the card's bottom strip at the camera's full resolution, both collector corners, warped
//     upright (`STRIP`): what a replay reads (a 640 px photo puts the collector line at ~7 px);
//   - a 640 px photo of the card;
//   - every frame's reads per crop, with its sharpness, glare, the card's height in pixels and the
//     evidence after it; the art's top matches and scores; the title reads; the candidate printings;
//   - the camera (name, delivered size, zoom, torch, settings and capabilities) and the text reader;
//   - how it ended: what was chosen, and how.
// Kept when: the printing list was used, Wrong card, Wrong printing, a read that gave up, the
// close-up took over, a title overruled the art, or the card took over 3 s to find (with what
// each frame read while looking, kept with no card when it was never found; since 17 Nov 2026).
// Best effort: a record that can't be sent is dropped. Server: server/src/scan_diagnostics.rs. Replay: eval/real.test.ts.
//
// Since 20 Nov 2026 a struggle record also keeps the set symbol's area at full resolution
// (`symbol`, `SYMBOL`), and every card the scanner settles, struggled with or not, sends a small
// timing record with no images (`TimingRecord`, server/src/scan_timings.rs): how long it took to
// name the card and by which rule, then how its printing was settled and how long that took.

import { accountSignal, api } from "../api";
import type { LockRule } from "./fuse";
import { CARD_SIDE, cardOf, STRIP_MAX, stripOf, SYMBOL_MAX, symbolOf, type Shot } from "./crops";
import type { Gray, Quad, RgbaImage } from "./types";

// The crops' geometry lives in crops.ts (no API, so the scan photo worker can use it too).
export { cardOf, STRIP, stripOf, stripQuad, stripSize, SYMBOL, symbolOf, symbolSize } from "./crops";

/** On this device, "1" when Scanner diagnostics is on. Off by default. */
export const DIAGNOSTICS_KEY = "yama.scan.diagnostics";
/** Frames written down per record, and the longest text kept per read. */
const MAX_FRAMES = 120;
const MAX_TEXT = 200;

export function diagnosticsOn(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Moves on each time the switch is turned off: a record started before (even one already being
 * encoded and sent, no longer the card in hand) is never sent, though the switch is on again.
 */
let generation = 0;
/** Records on their way: "Delete them" waits for their answers before it deletes. */
const sending = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  sending.add(p);
  p.then(
    () => sending.delete(p),
    () => sending.delete(p),
  );
  return p;
}

export function setDiagnosticsOn(on: boolean) {
  if (!on) generation += 1;
  try {
    localStorage.setItem(DIAGNOSTICS_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** Why a record is kept. */
/** "slow-printing": the scanner settled the printing itself, but SLOW_PRINTING_MS or more after the card was named. */
/** "reported": the person sent the card in hand themselves ("Send this scan", Bryan, 23 Nov 2026), switch on or off. */
export type Reason = "picked" | "wrong-card" | "wrong-printing" | "hold-gave-up" | "closeup" | "title-overruled" | "slow-find" | "slow-printing" | "reported";
/** "reported": sent by the person while the card was still in hand ("Send this scan"); how it ended comes in a later record, if any. */
export type Outcome = "filed" | "picked" | "wrong" | "skipped" | "left" | "reported";
/** The longest note the person may add to a scan they send. */
export const MAX_NOTE = 500;

/** A card in view and the image it's in. */
export type { Shot } from "./crops";

/** One frame (or still) of the card read: what each crop read, how readable it was, and what the evidence said after it. */
export interface FrameNote {
  /** ms since the record started. */
  t: number;
  /** "later": read for a provisional row (card first, printing after), from the frames it was named in or still lay in. */
  source: "first" | "hold" | "still" | "closeup" | "later";
  /** Each crop's text, in readCollectorLines' order: edges, detector (when snapping moved the corners), wide, right. */
  reads: string[];
  sharpness?: number;
  clipped?: number;
  /** Too blurred or washed out to read (quality.ts). */
  skipped?: boolean;
  /** The card's height in the frame, in pixels. */
  cardPx?: number;
  zoom?: number;
  verdict?: unknown;
  /** The first read: ms from the card being named to its first crop going to the reader. */
  wait?: number;
  /** Each crop's read, ms from being handed to the reader to its answer, in `reads`' order. */
  ocrMs?: number[];
  /** The engine's own part of each (ML Kit says; the rest is the crossing and waiting its turn). */
  engineMs?: number[];
  /** Hold and read: finding the card in the frame (ms), and cutting it from the camera's full frame. */
  locateMs?: number;
  cutMs?: number;
}

/** Each crop's time, rounded, as a frame note keeps it (`ocrMs`, and `engineMs` where the engine says). */
export function cropTimesNote(times: readonly { ms: number; engineMs?: number }[]): Pick<FrameNote, "ocrMs" | "engineMs"> {
  if (times.length === 0) return {};
  const engine = times.every((t) => t.engineMs != null);
  return { ocrMs: times.map((t) => Math.round(t.ms)), ...(engine ? { engineMs: times.map((t) => Math.round(t.engineMs!)) } : {}) };
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** A Gray or RGBA image as a JPEG no longer than `side`, base64. Null where canvases can't encode. */
export async function encodeJpeg(img: RgbaImage | Gray, side: number, quality = 0.88): Promise<{ data: string; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  const { width, height } = img;
  const grey = img.data.length === width * height;
  const rgba = grey ? new Uint8ClampedArray(width * height * 4) : new Uint8ClampedArray(img.data);
  if (grey) {
    for (let i = 0; i < width * height; i += 1) {
      const v = img.data[i]!;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  const k = Math.min(1, side / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  source.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), width: w, height: h };
}

/**
 * One card's record: started when a card is found (only while diagnostics are on), filled in as
 * its printing is read, and sent when the card is done with, if anything about it was a struggle
 * (`reasons`). Carried along when the person says it's another card or another printing.
 */
export class ScanRecord {
  readonly started = Date.now();
  readonly reasons = new Set<Reason>();
  readonly frames: FrameNote[] = [];
  private dropped = 0;
  /** Everything else: the card as found, its art matches, title reads, options, attempts, the end. */
  readonly facts: Record<string, unknown> = {};
  private readonly attempts: unknown[] = [];
  camera: Record<string, unknown> | null = null;
  engine: string | null = null;
  /** The art model's embed graph running when the record started (`ArtRecognizer.embed`), or "none". */
  embed: string | null = null;
  /** The option each slot ran when the record started (models.ts): art, look, text and lock. */
  models: Record<string, string> | null = null;
  cardName: string | null = null;
  private card: RgbaImage | null = null;
  private strip: RgbaImage | null = null;
  private symbol: RgbaImage | null = null;
  private stripLast: RgbaImage | null = null;
  private sent = false;
  private cancelled = false;
  /**
   * The account signed in when the record started: it stops if the account changes, so a record
   * kept for one account is never sent under another's sign-in (api.ts, `abortRequests`).
   */
  private readonly account: AbortSignal;
  /** The switch's generation when the record started (`setDiagnosticsOn`). */
  private readonly generation: number;

  constructor(account: AbortSignal = accountSignal(), gen: number = generation) {
    this.account = account;
    this.generation = gen;
  }

  get isSent() {
    return this.sent;
  }

  /** Scanner diagnostics were turned off while it was kept: it keeps nothing and is never sent. */
  get isCancelled() {
    return this.cancelled;
  }

  /** ms since the record started (the time frame notes are given in). */
  since(): number {
    return Date.now() - this.started;
  }

  /**
   * Scanner diagnostics were turned off: this record keeps nothing more and is never sent. Its
   * continuations (`continued`) are the same record, so they aren't sent either.
   */
  cancel() {
    this.cancelled = true;
    this.card = null;
    this.strip = null;
    this.symbol = null;
    this.stripLast = null;
    this.frames.length = 0;
  }

  /**
   * Whether it may still be sent: not cancelled, the same account signed in, "Delete them" not
   * pressed since it started, and the switch on and not turned off since; or, for a scan the person
   * sent themselves (`asked`, "Send this scan"), their tap in place of the switch.
   */
  private allowed(asked = false): boolean {
    return !this.cancelled && !this.account.aborted && this.generation === generation && (asked || diagnosticsOn());
  }

  /**
   * After it was sent: a new record for what happens next to the same card (Wrong printing after
   * filing), starting from what was known. Before, this one.
   */
  continued(): ScanRecord {
    if (!this.sent || this.cancelled) return this;
    const r = new ScanRecord(this.account, this.generation);
    Object.assign(r.facts, this.facts);
    r.camera = this.camera;
    r.engine = this.engine;
    r.embed = this.embed;
    r.models = this.models;
    r.cardName = this.cardName;
    r.card = this.card;
    r.strip = this.strip;
    r.symbol = this.symbol;
    r.stripLast = this.stripLast;
    r.frames.push(...this.frames);
    return r;
  }

  /** The card as first found: its photo, full-resolution strip and set symbol. */
  setShot(shot: Shot | null | undefined) {
    if (!shot || this.card || this.cancelled) return;
    this.card = cardOf(shot);
    this.strip = stripOf(shot);
    this.symbol = symbolOf(shot);
  }

  /** The latest frame read while the card was held: its strip, kept as "strip-last". */
  latestShot(shot: Shot) {
    if (this.cancelled) return;
    this.stripLast = stripOf(shot);
  }

  frame(f: Omit<FrameNote, "t">) {
    if (this.cancelled) return;
    if (this.frames.length >= MAX_FRAMES) {
      this.dropped += 1;
      return;
    }
    this.frames.push({ ...f, t: Date.now() - this.started, reads: f.reads.map(clip) });
  }

  /** How an attempt at reading the held card ended (heldRead.ts's summary). */
  attempt(summary: unknown) {
    this.attempts.push({ at: Date.now() - this.started, ...(summary as object) });
  }

  note(key: string, value: unknown) {
    this.facts[key] = value;
  }

  /** The JSON sent as `detail`. */
  detail(outcome: Outcome): Record<string, unknown> {
    return { reasons: [...this.reasons], outcome, ms: Date.now() - this.started, ...this.facts, attempts: this.attempts, frames: this.frames, framesDropped: this.dropped || undefined };
  }

  /**
   * Send it, once, if it has a reason to be kept and may still be sent (checked again after the
   * images are encoded, which takes a moment). Never throws. `asked`: the person tapped "Send this
   * scan", which sends it with Scanner diagnostics off too.
   */
  async send(outcome: Outcome, asked = false): Promise<boolean> {
    if (this.sent || this.reasons.size === 0 || !this.allowed(asked)) return false;
    this.sent = true;
    try {
      const images: { name: string; image: string; width: number; height: number }[] = [];
      const add = async (name: string, img: RgbaImage | null, side: number) => {
        if (!img) return;
        const enc = await encodeJpeg(img, side);
        if (enc) images.push({ name, image: enc.data, width: enc.width, height: enc.height });
      };
      await add("strip", this.strip, STRIP_MAX);
      await add("symbol", this.symbol, SYMBOL_MAX);
      await add("strip-last", this.stripLast, STRIP_MAX);
      await add("card", this.card, CARD_SIDE);
      if (!this.allowed(asked)) return false;
      await track(
        api("/api/scan/diagnostics", {
          method: "POST",
          signal: this.account,
          json: { outcome, card_name: this.cardName ?? undefined, engine: this.engine ?? undefined, camera: this.camera ?? undefined, detail: this.detail(outcome), images, embed: this.embed ?? undefined, models: this.models ?? undefined },
        }),
      );
      return true;
    } catch (e) {
      console.warn("Couldn't keep the scanner diagnostic", e);
      return false;
    }
  }
}

/** The rule that named a card: the art (sure, leads, twice), a title read, the card's text, the title close-up, or a typed name. */
export type SettleRule = LockRule | "closeup" | "typed";
/**
 * How a printing was settled: the only one (or the only one in the locked sets), the collector
 * line, the printing look when it's sure (the look option that settles, look.ts `lookSettles`), the
 * only one left with the border read (border.ts), the dearest of a tie by price (price.ts
 * `priceTie`, opt-in), a pick, or a correction.
 */
export type PrintingWay = "only" | "set" | "collector" | "look" | "border" | "price" | "picked" | "corrected";

/** What was known when a card was named, for its timing record. */
export interface Named {
  rule: SettleRule;
  /** "printing": the collection, where the printing is settled too; "identity": deck and box scans. */
  mode: "printing" | "identity";
  photo?: boolean;
  /** ms from the card appearing in view to the card being named, on the live camera. */
  ms?: number;
  /** Frames read in that time. */
  frames?: number;
  /**
   * The art's top match on the frame that named the card (the in-set one with the set lock): its
   * score, and its lead over the next different card. A title or text read can name another of
   * the art's matches.
   */
  top?: number;
  lead?: number;
  /** The camera's delivered resolution, "2160×3840". */
  camera?: string;
  /** The art model that ran (`ArtRecognizer.embed`), or "none". */
  embed?: string;
  /** The option each slot ran (models.ts): art, look, text and lock. */
  models?: Record<string, string>;
}

/** When the card in view appeared and the frames read since, for its timing record. */
export interface Appeared {
  at: number;
  frames: number;
  /** The card it is, once a frame named one surely enough. */
  card?: string;
  /** Another card leading instead, since when, and for how many frames in a row. */
  other?: { card: string; at: number; frames: number };
}

/** Frames in a row another card must lead before the time starts again for it (one is a lookalike's noise). */
export const CARD_CHANGE_FRAMES = 2;

/**
 * One more frame of the card in view (`card`: what the frame named surely enough, or null): the
 * time starts on the first frame, and starts again, from the first of them, when another card
 * leads CARD_CHANGE_FRAMES frames in a row (Codex review of #171: a card swapped for another with
 * no empty frame between counted the first one's reads).
 */
export function stepAppeared(a: Appeared | null, card: string | null, at: number, same: (x: string, y: string) => boolean): Appeared {
  const cur: Appeared = a ?? { at, frames: 0 };
  if (card) {
    if (!cur.card) cur.card = card;
    else if (same(cur.card, card)) cur.other = undefined;
    else if (cur.other && same(cur.other.card, card)) {
      cur.other.frames += 1;
      if (cur.other.frames >= CARD_CHANGE_FRAMES) return { at: cur.other.at, frames: cur.other.frames, card };
    } else cur.other = { card, at, frames: 1 };
  }
  cur.frames += 1;
  return cur;
}

const round3 = (n: number | undefined) => (n == null || !Number.isFinite(n) ? undefined : Math.round(n * 1000) / 1000);

/**
 * Every card the scanner settles, with Scanner diagnostics on (Bryan, 20 Nov 2026: the struggle
 * records can't say how fast ordinary scans settle): a small record with no images, made when
 * the card is named, given its printing as that's settled, and sent once when the card is done
 * with. The same account and switch rules as ScanRecord. Server: server/src/scan_timings.rs.
 */
export class TimingRecord {
  private readonly named = Date.now();
  private printing: { how: PrintingWay; ms: number } | null = null;
  private sent = false;
  /** Small facts beside the fixed fields (filed by itself, the card corrected). */
  readonly detail: Record<string, unknown> = {};
  private readonly account: AbortSignal;
  private readonly generation: number;

  constructor(
    readonly what: Named,
    account: AbortSignal = accountSignal(),
    gen: number = generation,
  ) {
    this.account = account;
    this.generation = gen;
  }

  get isSent() {
    return this.sent;
  }

  get printedAs(): PrintingWay | null {
    return this.printing?.how ?? null;
  }

  /** ms from the card being named to its printing being settled, once it is. */
  get printedMs(): number | null {
    return this.printing?.ms ?? null;
  }

  /** ms since the card was named. */
  since(): number {
    return Date.now() - this.named;
  }

  /**
   * The printing was settled: the first way counts, unless it was then corrected, and the first
   * correction's time stands (Codex review of #171: Add after a retry settled it would otherwise
   * count the wait for the tap).
   */
  printed(how: PrintingWay) {
    if (this.printing && (how !== "corrected" || this.printing.how === "corrected")) return;
    this.printing = { how, ms: Date.now() - this.named };
  }

  /**
   * The card's row appeared (`detail.row_ms`, from the card being named): at once with card first,
   * printing after; else when its printing settled and it was filed. Once.
   */
  rowShown() {
    if (this.detail.row_ms === undefined) this.detail.row_ms = Date.now() - this.named;
  }

  /**
   * Wrong card: the person named another card. The record stays this card's (how it was named,
   * how long it took), marked so; a printing settled for the wrong card no longer counts.
   */
  cardCorrected(): this {
    this.detail.card_corrected = true;
    this.printing = null;
    return this;
  }

  /**
   * Wrong printing before filing: the printing the scanner settled was rejected. It no longer
   * counts as settled (Codex review of #171: a retry given up on would send it as a success);
   * the way it was settled is kept as `printing_rejected`, and a pick then counts as corrected.
   */
  printingRejected(): this {
    if (this.printing) this.detail.printing_rejected = this.printing.how;
    this.printing = null;
    return this;
  }

  /**
   * Wrong printing after the card was filed and its record sent: a new record for the
   * correction, marked so (the summary counts it apart rather than as a second card).
   */
  afterFiling(): TimingRecord {
    if (!this.sent) return this;
    const r = new TimingRecord(this.what, this.account, this.generation);
    Object.assign(r.detail, this.detail, { after_filing: true }, this.printing ? { printing_rejected: this.printing.how } : {});
    return r;
  }

  private allowed(): boolean {
    return !this.account.aborted && this.generation === generation && diagnosticsOn();
  }

  /** The JSON sent. */
  body(outcome: Outcome): Record<string, unknown> {
    const w = this.what;
    return {
      outcome,
      rule: w.rule,
      mode: w.mode,
      photo: !!w.photo,
      ms: w.ms != null ? Math.round(w.ms) : undefined,
      frames: w.frames,
      top: round3(w.top),
      lead: round3(w.lead),
      printing: this.printing?.how,
      printing_ms: this.printing?.ms,
      camera: w.camera,
      embed: w.embed,
      models: w.models,
      detail: this.detail,
    };
  }

  /** Send it, once, if it may still be sent. Never throws. */
  async send(outcome: Outcome): Promise<boolean> {
    if (this.sent || !this.allowed()) return false;
    this.sent = true;
    try {
      await track(api("/api/scan/diagnostics/timings", { method: "POST", signal: this.account, json: this.body(outcome) }));
      return true;
    } catch (e) {
      console.warn("Couldn't keep the scanner timing", e);
      return false;
    }
  }
}

export interface DiagnosticsSummary {
  count: number;
  bytes: number;
  keep: number;
  /** Timing records kept beside the struggle records (deleted with them). */
  timings?: number;
}

export const diagnosticsSummary = () => api<DiagnosticsSummary>("/api/scan/diagnostics?limit=1");
/**
 * "Delete them": like turning the switch off, no record begun before is sent (the card in hand's
 * included), and those already on their way are answered first, so none arrives after the
 * deletion (the server also refuses one that began before it).
 */
export async function deleteDiagnostics(): Promise<{ deleted: number; timings?: number }> {
  generation += 1;
  await Promise.allSettled([...sending]);
  return api<{ deleted: number; timings?: number }>("/api/scan/diagnostics", { method: "DELETE" });
}
