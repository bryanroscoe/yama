// Scan photos (Bryan, 2026-11-06): with "Save scan photos" on, the part of the frame around a card
// the scanner named is kept in the person's account with what they said it was, so the scanner
// can be measured on, and trained with, real photos. Since 15 Nov 2026 the switch is on by default
// and the photos it saves are shared with Yama's developer (Bryan: "I want them to send it to
// me"); the switch says so. Server: server/src/scan_samples.rs.
//
// Since 20 Nov 2026 each photo also keeps full-resolution crops of the card, warped upright from
// its corners (photoCut.ts): the set symbol's area and the collector strip, and since 22 Nov 2026
// the whole card. Only the card; made once per photo kept, never per frame.
//
// Every card the scanner names (22 Nov 2026; Bryan: "so we can have a better corpus of training
// photos"): one `ScanPhoto` per card placed in view. Filed, corrected or marked wrong, it's kept
// with that label as before; let go without filing (Skip, Scan next, leaving the scanner), it's
// kept as `unconfirmed` with the scanner's guess, its scores and the rule that named it. A later
// answer about the same card relabels the photo kept rather than keeping a second.
//
// Best effort and off the scan's path: the cutting runs in a worker (photo.worker.ts), the upload
// in the background, nothing waits on either, and a photo that can't be made or sent is dropped.
// Nothing is kept or relabelled while the switch is off.

import { count } from "@yama/core";
import { accountSignal, api } from "../api";
import type { Shot } from "./crops";
import { thumbLikeness } from "./gate";
import { cardThumb } from "./gateFrame";
import { cutPhoto, type Cut, type CutReply, type CutRequest } from "./photoCut";

export { cardOutline, cropsOf, encodePhoto as encodeShot, type Crop } from "./photoCut";
export type { Shot } from "./crops";

/**
 * On this device, "0" when the person turned Save scan photos off. On by default (Bryan, 15 Nov
 * 2026: the kept photos are the evidence the scanner's misread work needs); a device that turned
 * it off keeps it off.
 */
export const SAVE_PHOTOS_KEY = "yama.scan.savePhotos";

/** The switch as set on this page: wins over storage, so turning it off holds even if storage can't be written. */
let chosen: boolean | null = null;

export function savingPhotos(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(SAVE_PHOTOS_KEY) !== "0";
  } catch {
    // Without storage the choice can't be remembered, so a switch turned off couldn't stay off.
    return false;
  }
}

export function setSavingPhotos(on: boolean) {
  chosen = on;
  try {
    localStorage.setItem(SAVE_PHOTOS_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** What a kept photo says happened to its card. */
export type SampleKind = "added" | "corrected" | "wrong" | "unconfirmed";

/** One of the art's best matches, as the scanner saw them. */
export interface ArtScore {
  name: string;
  set?: string;
  number?: string;
  score: number;
}

/** What the scanner knew when it named the card: kept with the photo whatever label it ends with. */
export interface PhotoFacts {
  /** The camera: the browser's, the Android app's own, or a still photo. */
  source?: "browser" | "native" | "photo";
  /** The collection (the printing matters) or a deck or box scan (only the card). */
  mode?: "printing" | "identity";
  /** The rule that named the card (fuse.ts `LockRule`, a close-up of the title, or a typed name). */
  rule?: string;
  /** The art's lead over the next different card, and its best matches. */
  lead?: number;
  scores?: ArtScore[];
  camera?: string;
  /** The art model's embed graph that ran (`ArtRecognizer.embed`), or "none" reading text only; the server records the model by it. */
  embed?: string;
  /** The option each of the scanner's slots ran (models.ts): art, look, text and lock. */
  models?: Record<string, string>;
}

/** What the person said (or, for a card let go, didn't), with what the scanner said. */
export interface SampleLabel {
  kind: SampleKind;
  label_scryfall_id?: string;
  label_name?: string;
  guess_name?: string;
  guess_scryfall_id?: string;
  guess_illustration_id?: string;
  method?: string;
  score?: number;
}

/** Moves on with each "Delete them": a photo begun before it is never sent. */
let photoGen = 0;
/** Photo uploads on their way: "Delete them" waits for their answers before it deletes. */
const sending = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  sending.add(p);
  p.then(
    () => sending.delete(p),
    () => sending.delete(p),
  );
  return p;
}

/** How long a photo waits on the worker before the page cuts it itself. */
const CUT_WAIT_MS = 20_000;
/** The scan photo worker: undefined until first asked, null where there's none to be had. */
let worker: Worker | null | undefined;
let asked = 0;
const waiting = new Map<number, { resolve: (cut: Cut | null) => void; reject: (e: Error) => void }>();

function photoWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return (worker = null);
    const w = new Worker(new URL("./photo.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CutReply>) => {
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error != null) p?.reject(new Error(e.data.error));
      else p?.resolve(e.data.cut ?? null);
    };
    // A worker that won't run (a build without it, a browser that refuses): the page cuts from now on.
    w.onerror = (e) => {
      e.preventDefault?.();
      worker = null;
      w.terminate();
      for (const p of waiting.values()) p.reject(new Error("The scan photo worker stopped"));
      waiting.clear();
    };
    return (worker = w);
  } catch {
    return (worker = null);
  }
}

/**
 * The photo and its crops, cut in the worker. Only where there's no worker to be had (no Worker or
 * OffscreenCanvas, or it won't load) are they cut on the page, as before 22 Nov 2026, and then only
 * for a card the person answered about (`onPage`): a card merely let go isn't worth making the
 * scanner wait. A worker that fails or stalls on a photo drops it rather than cut it on the page.
 */
async function cut(shot: Shot, onPage: boolean): Promise<Cut | null> {
  const w = photoWorker();
  if (w) {
    try {
      const id = (asked += 1);
      const done = new Promise<Cut | null>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        // A worker that never answers doesn't hold the photo for ever: the page cuts it instead.
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error("The scan photo worker took too long"));
        }, CUT_WAIT_MS);
      });
      // A copy of the pixels: the shot stays the scanner's, which may read it again.
      w.postMessage({ id, shot: { image: { width: shot.image.width, height: shot.image.height, data: shot.image.data }, quad: shot.quad } } satisfies CutRequest);
      return await done;
    } catch (e) {
      console.warn("The scan photo worker couldn't cut the photo", e);
      return null;
    }
  }
  return onPage ? cutPhoto(shot) : null;
}

/** A moment for the page to react to what just happened (a card filed, the next card) first. */
const soon = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** When a photo began: the account signed in and the "Delete them" generation then. */
export interface PhotoBegun {
  account: AbortSignal;
  gen: number;
}

export const photoBegun = (): PhotoBegun => ({ account: accountSignal(), gen: photoGen });

/**
 * Keep a photo with its label, if the person has Save scan photos on: the server's id once kept,
 * or null when it wasn't. A photo begun before a "Delete them", or under an account since signed
 * out, is never sent. Never throws.
 */
export async function keepSample(shot: Shot | null | undefined, label: SampleLabel & PhotoFacts, begun: PhotoBegun = photoBegun()): Promise<string | null> {
  if (!shot || !savingPhotos()) return null;
  const { account, gen } = begun;
  if (account.aborted || gen !== photoGen) return null;
  try {
    await soon();
    const made = await cut(shot, label.kind !== "unconfirmed");
    if (!made) return null;
    // Turned off, signed out, or deleted ("Delete them") while it was cut: nothing is sent.
    if (!savingPhotos() || account.aborted || gen !== photoGen) return null;
    // `shared`: this scanner tells the person, next to the switch, that saved photos are shared
    // with Yama's developer (server/src/scan_samples.rs keeps older photos out of that).
    const res = await track(api<{ id: string }>("/api/scan/samples", { method: "POST", signal: account, json: { ...label, ...made, shared: true } }));
    return gen === photoGen ? res.id : null;
  } catch (e) {
    console.warn("Couldn't keep the scan photo", e);
    return null;
  }
}

/** Change a kept photo's label (scan_samples.rs, `relabel`). Never throws. */
async function relabelSample(id: string, label: Pick<SampleLabel, "kind" | "label_scryfall_id" | "label_name">): Promise<void> {
  if (!savingPhotos()) return;
  const account = accountSignal();
  try {
    await track(api(`/api/scan/samples/${encodeURIComponent(id)}`, { method: "PATCH", signal: account, json: label }));
  } catch (e) {
    console.warn("Couldn't relabel the scan photo", e);
  }
}

const saidOf = (kind: SampleKind, l: Pick<SampleLabel, "label_scryfall_id" | "label_name">) => JSON.stringify([kind, l.label_scryfall_id ?? null, l.label_name ?? null]);

/**
 * The photo of one card placed in view (Bryan, 22 Nov 2026: one photo per card, never per frame).
 * The first label keeps it; a later answer relabels it; letting it go unanswered keeps it as
 * `unconfirmed`. Never waits, never throws.
 */
export class ScanPhoto {
  /** The server's id once kept (null: not kept); null before the first label. */
  private kept: Promise<string | null> | null = null;
  /** The label sent last, so the same answer isn't sent twice, and its kind. */
  private said: string | null = null;
  private kind: SampleKind | null = null;
  /** Label changes, one after another, each after the photo is kept. */
  private chain: Promise<void> = Promise.resolve();
  /** When the card was named: a "Delete them" or a sign-out since stops the photo. */
  private readonly begun = photoBegun();

  constructor(
    readonly shot: Shot,
    readonly facts: PhotoFacts,
  ) {}

  /** Whether a label has been given (the photo kept or on its way). */
  get labelled(): boolean {
    return this.kept !== null;
  }

  /** The person's answer about the card: keeps the photo the first time, relabels it after. */
  label(label: SampleLabel): void {
    if (!savingPhotos()) return;
    if (this.kept === null) {
      this.kind = label.kind;
      this.said = saidOf(label.kind, label);
      this.kept = keepSample(this.shot, { ...this.facts, ...label }, this.begun);
      return;
    }
    // An answer never goes back to "unconfirmed". A photo whose card was called wrong, or
    // corrected, and is then filed as read again is a correction of what the scanner first said
    // (the guess kept with it).
    if (label.kind === "unconfirmed") return;
    const kind = label.kind === "added" && (this.kind === "wrong" || this.kind === "corrected") ? "corrected" : label.kind;
    const said = saidOf(kind, label);
    // The same answer isn't sent again.
    if (said === this.said) return;
    this.kind = kind;
    this.said = said;
    const kept = this.kept;
    const answer = { kind, label_scryfall_id: label.label_scryfall_id, label_name: label.label_name };
    this.chain = this.chain.then(async () => {
      const id = await kept;
      if (id) await relabelSample(id, answer);
    });
  }

  /** The card was let go without an answer: kept as `unconfirmed` with the scanner's guess, unless already kept. */
  letGo(guess: Omit<SampleLabel, "kind" | "label_scryfall_id" | "label_name">): void {
    if (this.kept === null) this.label({ ...guess, kind: "unconfirmed" });
  }

  /** For tests: the id once kept, after every label change sent. */
  async settled(): Promise<string | null> {
    const id = await (this.kept ?? Promise.resolve(null));
    await this.chain;
    return id;
  }
}

/**
 * Whether two views show the same card lying in the same place (a card called wrong, read again
 * where it lies), not another card laid there: their cards' thumbnails alike, either way up, as the
 * placement gate tells a card nudged from a card swapped (gate.ts, `sameThumb`).
 */
export function sameCardView(a: Shot, b: Shot): boolean {
  const ta = cardThumb(a.image, a.quad);
  const tb = cardThumb(b.image, b.quad);
  return Math.max(thumbLikeness(ta, tb), thumbLikeness(ta, Uint8Array.from(tb).reverse())) >= SAME_VIEW;
}

/** The likeness the placement gate takes for the same card (gate.ts, DEFAULTS.sameThumb). */
const SAME_VIEW = 0.85;

/** How a set of photos is made up (scan_samples.rs, `stats`): one count of photos and bytes. */
export interface SampleCount {
  name: string;
  photos: number;
  bytes: number;
}

export interface SampleSummary {
  count: number;
  bytes: number;
  crop_bytes?: number;
  total_bytes?: number;
  keep: number;
  keep_bytes?: number;
  kinds?: SampleCount[];
  sources?: SampleCount[];
  crops?: SampleCount[];
  with_every_crop?: number;
  relabelled?: number;
}

export const sampleSummary = () => api<SampleSummary>("/api/scan/samples");

/** What each kind is called in Scan settings. */
const KIND_WORDS: Record<string, string> = { unconfirmed: "skipped", added: "added", corrected: "corrected", wrong: "marked wrong" };

/** Scan settings' line for the photos kept: "1,234 saved, 312 MB: 800 skipped, 400 added, 34 corrected." */
export function photosLine(s: SampleSummary): string {
  const bytes = s.total_bytes ?? s.bytes + (s.crop_bytes ?? 0);
  const size = bytes >= 1024 * 1024 ? `${count(Math.round(bytes / (1024 * 1024)))} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  const kinds = (s.kinds ?? []).filter((k) => k.photos > 0).map((k) => `${count(k.photos)} ${KIND_WORDS[k.name] ?? k.name}`);
  return `${count(s.count)} saved, ${size}${kinds.length ? `: ${kinds.join(", ")}` : ""}.`;
}
/**
 * "Delete them": no photo begun before is sent, and those already on their way are answered
 * first, so none arrives after the deletion (the server also refuses one that began before it).
 */
export async function deleteSamples(): Promise<{ deleted: number }> {
  photoGen += 1;
  await Promise.allSettled([...sending]);
  return api<{ deleted: number }>("/api/scan/samples", { method: "DELETE" });
}
