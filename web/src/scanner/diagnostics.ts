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
import { warpRegionRgba, type CardRegion } from "./image";
import type { Gray, Quad, RgbaImage } from "./types";

/** On this device, "1" when Scanner diagnostics is on. Off by default. */
export const DIAGNOSTICS_KEY = "yama.scan.diagnostics";
/** The card's bottom edge, corner to corner: both collector areas, with room for a card cut high. */
export const STRIP: CardRegion = { x0: 0, y0: 0.86, x1: 1, y1: 1 };
/** The longest side of the card photo kept. */
const CARD_SIDE = 640;
/** The whole card, corner to corner: the photo kept is the card alone, never the frame around it. */
const WHOLE: CardRegion = { x0: 0, y0: 0, x1: 1, y1: 1 };
/** A strip is never drawn wider than this (a card nearly filling a 4K frame). */
const STRIP_MAX = 2400;
/**
 * The set symbol's area: the type line's right end, with room for a card cut a little off (card
 * y 0.50 to 0.63, x 0.70 to 1). What a printing model looks at (docs/plans/scanner-models.md).
 */
export const SYMBOL: CardRegion = { x0: 0.7, y0: 0.5, x1: 1, y1: 0.63 };
/** A symbol crop is never drawn wider than this. */
const SYMBOL_MAX = 800;
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

export function setDiagnosticsOn(on: boolean) {
  if (!on) generation += 1;
  try {
    localStorage.setItem(DIAGNOSTICS_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** Why a record is kept. */
export type Reason = "picked" | "wrong-card" | "wrong-printing" | "hold-gave-up" | "closeup" | "title-overruled" | "slow-find";
export type Outcome = "filed" | "picked" | "wrong" | "skipped" | "left";

/** A card in view and the image it's in. */
export interface Shot {
  image: RgbaImage;
  quad: Quad;
}

/** One frame (or still) of the card read: what each crop read, how readable it was, and what the evidence said after it. */
export interface FrameNote {
  /** ms since the record started. */
  t: number;
  source: "first" | "hold" | "still" | "closeup";
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
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** Pixels across the strip at the card's own resolution (never enlarged), and its height. */
export function stripSize(quad: Quad): { width: number; height: number } {
  const cardW = Math.max(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
  const width = Math.max(64, Math.min(STRIP_MAX, Math.round(cardW * (STRIP.x1 - STRIP.x0))));
  const height = Math.max(8, Math.round((width * ((STRIP.y1 - STRIP.y0) * 88)) / ((STRIP.x1 - STRIP.x0) * 63)));
  return { width, height };
}

/** The card's bottom strip, warped upright at the card's own resolution in the frame. */
export function stripOf(shot: Shot): RgbaImage {
  const { width, height } = stripSize(shot.quad);
  return warpRegionRgba(shot.image, shot.quad, STRIP, width, height);
}

/** Pixels across the set symbol's area at the card's own resolution (never enlarged, at most SYMBOL_MAX), and its height. */
export function symbolSize(quad: Quad): { width: number; height: number } {
  const cardW = Math.max(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
  const width = Math.max(32, Math.min(SYMBOL_MAX, Math.round(cardW * (SYMBOL.x1 - SYMBOL.x0))));
  const height = Math.max(8, Math.round((width * ((SYMBOL.y1 - SYMBOL.y0) * 88)) / ((SYMBOL.x1 - SYMBOL.x0) * 63)));
  return { width, height };
}

/** The set symbol's area, warped upright at the card's own resolution in the frame: only the card. */
export function symbolOf(shot: Shot): RgbaImage {
  const { width, height } = symbolSize(shot.quad);
  return warpRegionRgba(shot.image, shot.quad, SYMBOL, width, height);
}

/**
 * The card alone, warped upright, at most CARD_SIDE tall (never enlarged): nothing of the camera
 * frame or photo around it, which may show the room, a hand or other cards.
 */
export function cardOf(shot: Shot): RgbaImage {
  const q = shot.quad;
  const cardH = Math.max(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]));
  const height = Math.max(8, Math.min(CARD_SIDE, Math.round(cardH)));
  const width = Math.max(6, Math.round((height * 63) / 88));
  return warpRegionRgba(shot.image, shot.quad, WHOLE, width, height);
}

/**
 * The card's corners in a strip image's pixels (top above the image): reading the strip with
 * readCollectorLines as if it were the whole card cuts the same corners. For replay.
 */
export function stripQuad(width: number, height: number): Quad {
  const cardH = height / (STRIP.y1 - STRIP.y0);
  const top = height - cardH * STRIP.y1;
  return [
    [0, top],
    [width, top],
    [width, top + cardH],
    [0, top + cardH],
  ];
}

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

  /** Whether it may still be sent: not cancelled, the switch on and not turned off since it started, the same account signed in. */
  private allowed(): boolean {
    return !this.cancelled && !this.account.aborted && this.generation === generation && diagnosticsOn();
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
   * images are encoded, which takes a moment). Never throws.
   */
  async send(outcome: Outcome): Promise<boolean> {
    if (this.sent || this.reasons.size === 0 || !this.allowed()) return false;
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
      if (!this.allowed()) return false;
      await api("/api/scan/diagnostics", {
        method: "POST",
        signal: this.account,
        json: { outcome, card_name: this.cardName ?? undefined, engine: this.engine ?? undefined, camera: this.camera ?? undefined, detail: this.detail(outcome), images, embed: this.embed ?? undefined },
      });
      return true;
    } catch (e) {
      console.warn("Couldn't keep the scanner diagnostic", e);
      return false;
    }
  }
}

/** The rule that named a card: the art (sure, leads, twice), a title read, the card's text, the title close-up, or a typed name. */
export type SettleRule = LockRule | "closeup" | "typed";
/** How a printing was settled: the only one (or the only one in the locked sets), the collector line, a pick, or a correction. */
export type PrintingWay = "only" | "set" | "collector" | "picked" | "corrected";

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
  /** The art's score for the card named, and its lead over the next different card. */
  top?: number;
  lead?: number;
  /** The camera's delivered resolution, "2160×3840". */
  camera?: string;
  /** The art model that ran (`ArtRecognizer.embed`), or "none". */
  embed?: string;
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

  /** The printing was settled: the first way counts, unless it was then corrected. */
  printed(how: PrintingWay) {
    if (this.printing && how !== "corrected") return;
    this.printing = { how, ms: Date.now() - this.named };
  }

  /**
   * Wrong printing after the card was filed and its record sent: a new record for the
   * correction, marked so (the summary counts it apart rather than as a second card).
   */
  afterFiling(): TimingRecord {
    if (!this.sent) return this;
    const r = new TimingRecord(this.what, this.account, this.generation);
    Object.assign(r.detail, this.detail, { after_filing: true });
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
      detail: this.detail,
    };
  }

  /** Send it, once, if it may still be sent. Never throws. */
  async send(outcome: Outcome): Promise<boolean> {
    if (this.sent || !this.allowed()) return false;
    this.sent = true;
    try {
      await api("/api/scan/diagnostics/timings", { method: "POST", signal: this.account, json: this.body(outcome) });
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
export const deleteDiagnostics = () => api<{ deleted: number; timings?: number }>("/api/scan/diagnostics", { method: "DELETE" });
