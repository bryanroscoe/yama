// Camera scanner. Hold a card anywhere in view: the art recognizer (recognizer.ts, in a worker)
// finds it, outlines it and names it from its artwork, usually within a frame or two. The
// printing comes from the printings that share that art: settled when there's only one, read
// from the collector line when there are several, and otherwise picked by the person. Nothing
// is filed under a guessed printing.
//
// When the recognition bundle isn't available (the server is still downloading it, or an old
// browser), or a card's art isn't in it (new sets, battles), the scanner reads text instead
// (pipeline.ts), with the engine ocrEngine.ts picks.
//
// Needs a secure context for the camera (https or localhost). "Use a photo" works anywhere.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { api, type Printing } from "../api";
import { loadArtRecognizer, NO_ART_MODEL, RECOGNIZER_SHORT_SIDE, scanBundleInfo, type ArtRecognizer, type LoadState, type LookDone } from "./artClient";
import { lookBest, lookCandidates, lookLead, lookOrder, lookSettles, withoutMisread, type LookScores } from "./look";
import { GATE_LOCK, modelsOf, onModelsChange, running, runningAll, saveModel, savedModels, usesLead, type DeviceCan, type ModelChoices, type ModelSlot, type ModelsInfo, type Running } from "./models";
import { ModelsSetting } from "./ModelsSetting";
import { NameIndex } from "./fuzzy";
import { normaliseName } from "./parse";
import { applyH, rectQuad, squareToQuad } from "./image";
import { deleteDiagnostics, diagnosticsOn, diagnosticsSummary, setDiagnosticsOn, ScanRecord, stepAppeared, TimingRecord, type Appeared, type DiagnosticsSummary, type Outcome, type PrintingWay, type Reason, type SettleRule } from "./diagnostics";
import type { StripQuality } from "./quality";
import { readCloseup, readCollectorLines, readTitles, scanFrame, SURE } from "./pipeline";
import { artHoldFrame, AWAY_FRAMES, hold, holdRead, type ArtHold, type Hold } from "./hold";
import { NameEntry } from "./NameEntry";
import { CollectorPeek } from "./peek";
import { filedFinish, priceFor, pricesOf, worthIt, type RecentCard, type ScanFinish } from "./price";
import { ScanTray } from "./ScanTray";
import { PLAY_WORD, playTag, usePlayability } from "./playable";
import { holdSound } from "../sound";
import { filedSound, playScanSound, setSoundsOn, setWorthThreshold, soundsOn, unlockSound, worthThreshold, type ScanSound } from "./sounds";
import { choosePrinting, printingOptions, type Choice } from "./printings";
import type { ArtMatch, Recognition } from "./recognizer";
import { deleteSamples, keepSample, sampleSummary, savingPhotos, setSavingPhotos, type SampleLabel, type SampleSummary, type Shot } from "./samples";
import { SetLockPicker } from "./SetLockPicker";
import { treatmentOf } from "./session";
import { artInSets, inLockedSets, KNOWN_ART, knownArtShare, leadCounts, POOL_MARGIN, judgeLocked, lockedNames, lockedSet, poolKeys, readTitleFirst, savedLock, saveLock, suggestLock, type LockedSet } from "./setlock";
import { CameraControls, cameraInfo, digitalRegion, useCameraControls, type CameraInfo } from "./camera";
import { saysCardBack } from "./cardBack";
import { CardOutline } from "./CardOutline";
import { ask60, askUsualRate, fps60On, FrameRateMeter, setFps60, watchFrameRate } from "./frameRate";
import { OutlineTracker } from "./outline";
import { GATE_DEFAULTS, Motion, PlacementGate } from "./gate";
import { BACK_KEY, GATE_PASS_MS, GATE_SAYS, gateStatus, type GateFrame, type GateRead } from "./gateLoop";
import { defaultCamera, nameCameras, resolveSaved, saveCamera, savedCamera, type NamedCamera } from "./cameras";
import { browserCameraSource, draw, sourceLabel, type CameraSource, type SourceInfo } from "./cameraSource";
import { nativeCameraAvailable, openNativeCamera, saveNativeCamera, savedNativeCamera, type NativeCamera } from "./nativeCamera";
import { NativeCameraSetting } from "./NativeCameraSetting";
import { AUTO_MAX, AutoZoom, LENS_SWITCH, maySwitchLens } from "./zoomPolicy";
import { cardHeight, tooFar } from "./closer";
import { createServerCatalog } from "./serverCatalog";
import { availableEngines, createScannerOcr, ENGINE_LABEL, engineOrder, plannedEngine, type OcrChoice, type ScannerOcr } from "./ocrEngine";
import { HeldRead, type HeldVerdict } from "./heldRead";
import { Evidence, progressLine, proofOf } from "./evidence";
import { artDecides, artHas, artLead, fuseTitle, LeadRun, leads, needsTitle, titleRead, type Fused, type LockRule } from "./fuse";
import { worthReading } from "./quality";
import { pickHeldQuad, sameHeldCard } from "./heldCard";
import { VersionLine } from "../version";
import { ScanSettings, SettingsIcon, usePinchZoom, useSheetDrag } from "./sheet";
import type { OcrEngine, Quad, RgbaImage, ScanCandidate, ScanCatalog, ScanResult } from "./types";
import "./scanner.css";
import { copyWords, shortDate, treatmentLabel, usd } from "@yama/core";
import { Button, CardThumb, ErrorText, Field } from "../components/ui";
import { HelpPopover } from "../components/HelpPopover";
import { MoreMenu } from "../components/MoreMenu";

export interface ScannerViewProps {
  /**
   * Called when the person confirms a card (`auto`: Keep adding added it). Without it the scanner
   * only shows what it found. A promise says whether the card was saved, so Keep adding only
   * says "Added" once it was.
   */
  onAccept?: (card: ScanCandidate, copies: number, auto: boolean) => void | Promise<boolean>;
  /**
   * Take back a card `onAccept` just saved (the same object it was given): the "Undo" on the
   * camera's "Added …" chip. Without it the chip offers none.
   */
  onUndo?: (card: ScanCandidate) => Promise<void>;
  /**
   * Change the printing of a card `onAccept` already saved (`filed`, the same object it was given)
   * to `to`, updating that copy rather than adding another: "Wrong printing" after filing. The
   * host says what is filed now: "kept" when the copy already was `to`'s printing. The object `to`
   * then stands for the copy (a later Undo or correction is given it). A rejection means the host
   * couldn't confirm the change (it may still finish it: its Added list shows that copy). Without
   * it, Wrong printing is offered only before filing.
   */
  onCorrect?: (filed: ScanCandidate, to: ScanCandidate) => Promise<"changed" | "kept">;
  /** For reading text: defaults to the server lookup plus the offline card names. */
  catalog?: ScanCatalog;
  /** For reading text: defaults to `createScannerOcr` (ML Kit in the app, PaddleOCR in the browser, else tesseract.js). */
  ocr?: OcrEngine;
  onClose?: () => void;
  /** Copies added since the scanner opened, for the "Added 3 so far" chip. */
  addedCount?: number;
  /** Makes the "Added 3 so far" chip a button, to review and fix what was added. */
  onShowAdded?: () => void;
  /** Cards added whose save failed (kept for review, to try again). */
  unsavedCount?: number;
  /**
   * Keep adding: a card whose printing the scanner settled itself (the only one, or read from the
   * collector line) is added at once, one copy, and scanning goes on. Anything less still waits.
   * With `identityOnly`, any card the camera found is added unless it might be another card.
   */
  autoAdd?: boolean;
  /**
   * The close-up step: when the whole-card view can't settle the printing (or the name of a card
   * whose art isn't known), ask for the camera close to the corner (or the name). Off for a camera
   * that can't be moved (a stand or a card feeder): the printing is then picked by tap, and the
   * close-up only runs when asked for. Default on.
   */
  closeups?: boolean;
  /** Stop reading the camera (something is shown over the scanner). */
  paused?: boolean;
  /** The last few cards added, newest first. */
  recent?: string[];
  /**
   * The finish chosen last (nonfoil, foil, etched, or proxy, which has no price). The found card
   * shows the finish its printing would be added in (`pickFinish`: its only one, else this, else
   * regular) and that finish's price.
   */
  finish?: ScanFinish;
  /** Told the printing the found card is settled on (null while none), so the host can offer its finishes. */
  onPrinting?: (p: Printing | null) => void;
  /**
   * The cards filed this session, newest first, with their pictures and prices (Collection): shown
   * in the strip between the camera and the sheet (ScanTray.tsx), with the session's total. Hosts
   * without prices give `recent` (names) instead.
   */
  recentCards?: RecentCard[];
  /**
   * The `recentCards` key of the entry a card given to `onAccept` (or `onCorrect`'s `to`) went
   * into. The receipt's Undo and Wrong printing stand beside the newest tile only when it is that
   * card's entry: two entries of the same printing (a "+1 copy" still saving) look alike by name.
   * Without it the scanner compares name, set and number.
   */
  entryOf?: (card: ScanCandidate) => string | undefined;
  /** Open one card of the strip large, by its key (the host's ScannedCard). Without it the tiles are pictures only. */
  onOpenCard?: (key: string) => void;
  /** The scanner's own sounds (sounds.ts), as well as vibration. Default on; off where the host plays its own (the deck check). */
  sounds?: boolean;
  /** Choices shown in the panel (finish, where to put the card). */
  controls?: ReactNode;
  /**
   * Choices that rarely change (finish, where cards go, Keep adding, Close-ups): in Scan settings,
   * opened from the gear on the camera (Bryan, 16 Nov 2026: "move a lot of the options into a
   * little settings pane"), with `settingsSummary` on the sheet as a button that opens them too.
   */
  settings?: ReactNode;
  /** The settings' current values in a few words ("Regular, into Binder 2"), shown on the sheet. */
  settingsSummary?: string;
  /** The accept button's words. */
  acceptLabel?: string;
  /** Context for the recognized card, shown immediately without accepting or adding it. */
  renderResult?: (card: ScanCandidate) => ReactNode;
  /** Only the card's identity matters: no printing, price or picker. */
  identityOnly?: boolean;
  /** One card, once (a rescan of a card already filed): no Copies choice. */
  single?: boolean;
  /** Shown over the camera view, under the top buttons (the deck check's verdict). A function is
   * given the card found and waiting to be accepted, else null, so the overlay never shows an
   * older card while a new one waits, and told when the scanner is reading another card (not the
   * one just filed), so the host can take an older card's word down. */
  overlay?: ReactNode | ((pending: ScanCandidate | null, scanner: { another: boolean }) => ReactNode);
  /** The word for what accepting does, in the camera's chips: "Added" unless set ("Checked"). */
  addedWord?: string;
  /** Buzz on a find, an add or a needed tap (where the browser can). Default on. */
  haptics?: boolean;
  /**
   * Offer the set lock: scan only some sets' art and file their printings (setlock.ts). Default on
   * unless only the card's identity matters.
   */
  setLock?: boolean;
}

type Phase = "loading" | "scanning" | "found" | "no-camera";

/** What was found, and how far settling its printing has got. */
interface Found {
  name: string;
  method: ScanCandidate["method"];
  confidence: number;
  /** The art match, when the card was recognised by its artwork. */
  art?: ArtMatch;
  /** Other cards it might be, for "Not this card?". */
  others: ArtMatch[];
  /** Printings to choose from; null while loading. */
  options: Printing[] | null;
  /** Printings sharing the art that the set lock left out of `options`: the collector line's number alone is checked against them too (evidence.ts). */
  lockedOut?: Printing[];
  /** How many of `options`, at the top, the collector line's reads put there (printings.ts, `Choice.readFirst`). */
  readFirst?: number;
  sameArt: boolean;
  chosen: Printing | null;
  /**
   * How the printing was settled. "set": the only printing of it in the locked sets; "look": the
   * printing look, sure of it (the look option that settles when sure, look.ts `lookSettles`).
   */
  how: "only" | "set" | "collector" | "look" | "picked" | null;
  /** Locked to sets, and none of this card's printings (of this art) is in them: ask. */
  outside?: boolean;
  /** The person said it's from another set: the lock doesn't apply to this card. */
  unlocked?: boolean;
  /** The printing the scanner settled by itself, before any change by the person. */
  settledId?: string;
  /** A printing the text reader already read from the collector line, for settling it again. */
  known?: Known;
  /** The part of the frame around the card, for Save scan photos. */
  shot?: Shot | null;
  /** What the scanner first said, when the person corrected it (Wrong card). */
  guess?: Pick<SampleLabel, "guess_name" | "guess_scryfall_id" | "guess_illustration_id" | "method" | "score">;
  /** The scanner settled the printing itself, with proof (not a guess, not a tap). */
  sure?: boolean;
  /** Found by its art and a clear title read naming the same card (fuse.ts): lookalike art
   * doesn't make it a guess. */
  titled?: boolean;
  /** Found by art that leads every other card by LEAD_MARGIN (fuse.ts): lookalike art further
   * behind doesn't make it a guess either. */
  leads?: boolean;
  /**
   * The printing the scanner settled and the person said was wrong ("Wrong printing"): marked
   * "Read as" in the list, and never filed again by itself.
   */
  misread?: Printing;
  /** Correcting a card already filed: the card `onAccept` was given. Filing then changes that copy. */
  correcting?: ScanCandidate;
  /** Scanner diagnostics (diagnostics.ts): this card's record, when they're on. Carried through Wrong card and Wrong printing. */
  rec?: ScanRecord;
  /** Scanner diagnostics' timing record for this card (diagnostics.ts, `TimingRecord`): every card settled, when they're on. */
  timing?: TimingRecord;
  /** The person asked to see the other printings. */
  picking: boolean;
  /** Reading the collector line to tell printings apart. */
  reading?: boolean;
  /** What OCR read, when it read anything. */
  raw?: string;
  ms?: number;
  error?: string;
}

/**
 * A printing the text reader already read from the collector line (a card found by its text): its
 * set and number, and the line's text, which proves the printing only through evidence.ts.
 */
interface Known {
  set?: string;
  number?: string;
  text?: string;
}

/** Resolves once the video has a frame to read (or after a few seconds, whatever it has). */
function firstFrame(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (v.readyState >= 2 && v.videoWidth > 0) return resolve();
    const done = () => {
      v.removeEventListener("loadeddata", done);
      clearTimeout(timer);
      resolve();
    };
    v.addEventListener("loadeddata", done);
    const timer = setTimeout(done, 3000);
  });
}

/** A promise that gives up after `ms` (review of #145: a camera's still capture could hang for good). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** How long a still photo may take before it's given up. */
const STILL_TIMEOUT_MS = 2000;
/** Frames read without settling before one still photo is tried (ImageCapture.takePhoto). */
const STILL_AFTER = 5;
/** Lock at this art score on one frame, or at LOCK_TWICE on two agreeing frames. */
const LOCK_ONCE = 0.82;
const LOCK_TWICE = 0.62;
/**
 * A fairly sure art match (LOCK_TWICE on two frames) decides only after this many frames in a row
 * whose title couldn't be read: the title has to have had its chance [inferred].
 */
const UNTITLED_FRAMES = 4;
/** Below this the art is probably not in the bundle; after a few such frames, read text instead. */
const ART_UNKNOWN = 0.5;
/**
 * A whole-card text read at least this sure, naming a card the art doesn't have, keeps the art
 * from deciding (handleText's own two-frame bar). A weaker one is noise: it used to hold the art
 * and the close-up back for as long as the card was held (Bryan, 17 Nov 2026: stuck on "Hold
 * still"). [inferred]
 */
const TEXT_VETO = 0.6;
/** A card that takes longer than this to find is kept by Scanner diagnostics ("slow-find"). */
const SLOW_FIND_MS = 3000;
/** Frames written down while looking for one card. */
const SEEK_FRAMES = 60;
/** Slow-find records kept per scanner session (the server keeps 200 records per account). */
const SLOW_KEPT = 25;
/** For reading text: extra frame kept around the on-screen guide, and the longest side read. */
const MARGIN = 0.12;
const MAX_SIDE = 1500;
const CARD_ASPECT = 88 / 63;
const PICKER_FIRST = 24;
/** How long "Added …" stays on the camera when it offers Undo. */
const UNDO_MS = 6000;

/** What was just added, on the camera's chip. `card` (the object `onAccept` was given) once saved, for Undo. */
interface JustAdded {
  text: string;
  card?: ScanCandidate;
  label?: string;
  /** The card as found and the printing filed, for "Wrong printing" after filing (when the host can correct it). */
  found?: Found;
  printing?: Printing | null;
  /** Undo is under way: the chip stays until it's done. */
  busy?: boolean;
  /** Say `text` even beside the card itself (with the strip): "Kept …" is news, "Added …" isn't. */
  say?: boolean;
}
/** What the scanner says while it simply waits for a card: once the strip has cards, the camera keeps quiet. */
/** A text reader started for a choice changed since (Scan settings): the next read starts the new one. */
const TEXT_SWITCHED = "The text reader was switched";
/** How long a text reader replaced in Scan settings keeps going, so the reads it has under way finish. */
const OCR_RETIRE_MS = 10_000;

/** The text slot's choice for the next reader started, with the readers the server offers. */
const textChoice = (slots: Record<ModelSlot, Running>, info: ModelsInfo | null): OcrChoice => ({
  engine: (slots.text.option?.id ?? "auto") as OcrChoice["engine"],
  allowed: info?.text.options.map((o) => o.id),
});

const WAITING: string = GATE_SAYS.waiting;
const NEXT: string = GATE_SAYS.next;
/** The card in view is face down (cardBack.ts). */
export const CARD_BACK: string = GATE_SAYS.back;
/** A card other than the one just filed is in view and being read. */
const READING: string = GATE_SAYS.reading;
/**
 * While reading a held card: how far below the best match in view the held card's art may score.
 * With the set lock, as far as judgeLocked lets an in-set match trail the best one anywhere.
 */
const SAME_CARD_MARGIN = 0.02;

const sameCard = (a: ScanCandidate | undefined, b: ScanCandidate | undefined) => !!a && !!b && a.name === b.name && a.set === b.set && a.number === b.number;

/** The whole source with its short side at RECOGNIZER_SHORT_SIDE (never enlarged), and the scale used. */
function small(source: CanvasImageSource, width: number, height: number, canvas: HTMLCanvasElement): { image: RgbaImage; k: number } {
  const k = Math.min(1, RECOGNIZER_SHORT_SIDE / Math.min(width, height));
  return { image: draw(source, 0, 0, width, height, width * k, height * k, canvas), k };
}

/** A region of the source with its short side at RECOGNIZER_SHORT_SIDE (never enlarged), and the scale used. */
function smallRegion(source: CanvasImageSource, r: { x: number; y: number; w: number; h: number }, canvas: HTMLCanvasElement): { image: RgbaImage; k: number } {
  const k = Math.min(1, RECOGNIZER_SHORT_SIDE / Math.min(r.w, r.h));
  return { image: draw(source, r.x, r.y, r.w, r.h, r.w * k, r.h * k, canvas), k };
}

/** The part of the source around a card quad (source pixels), at full resolution, and the quad within it. */
/**
 * The longest side a card is cut at for reading its title when only the card matters (a deck scan
 * or check): the title is read at NAME_DENSITY anyway, and a 2400 px cut (the collector line's) was
 * most of each frame's time on a phone (Bryan, 17 Nov 2026: "crazy laggy"). [inferred]
 */
const IDENTITY_SIDE = 1200;

function around(source: CanvasImageSource, width: number, height: number, quad: Quad, canvas: HTMLCanvasElement, maxSide = 2400): { image: RgbaImage; quad: Quad } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const pad = 0.08 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  const k = Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0));
  const image = draw(source, x0, y0, x1 - x0, y1 - y0, (x1 - x0) * k, (y1 - y0) * k, canvas);
  return { image, quad: quad.map(([x, y]) => [(x - x0) * k, (y - y0) * k]) as Quad };
}

/** Where an on-screen element sits in video pixels (the video is object-fit: cover), clipped to the frame. */
function boxInVideo(v: HTMLVideoElement, el: HTMLElement, margin = 0): { sx: number; sy: number; sw: number; sh: number; gx: number; gy: number; gw: number; gh: number } {
  const vb = v.getBoundingClientRect();
  const gb = el.getBoundingClientRect();
  const s = Math.max(vb.width / v.videoWidth, vb.height / v.videoHeight);
  const ox = vb.left + (vb.width - v.videoWidth * s) / 2;
  const oy = vb.top + (vb.height - v.videoHeight * s) / 2;
  const gx = (gb.left - ox) / s;
  const gy = (gb.top - oy) / s;
  const gw = gb.width / s;
  const gh = gb.height / s;
  const sx = Math.max(0, gx - gw * margin);
  const sy = Math.max(0, gy - gh * margin);
  return { sx, sy, sw: Math.min(v.videoWidth, gx + gw * (1 + margin)) - sx, sh: Math.min(v.videoHeight, gy + gh * (1 + margin)) - sy, gx, gy, gw, gh };
}

/** Height a close-up box is read at: the densities scanFrame samples the two lines at. */
const CLOSEUP_HEIGHT = { collector: 200, title: 110 } as const;
/** Failed text reads of an unknown card before asking for a close-up of its name. */
const TITLE_AFTER = 2;

const scaleQuad = (q: Quad, k: number) => q.map(([x, y]) => [x * k, y * k]) as Quad;
/** The same corners, read a quarter turn on: for cards printed sideways (battles), whose art the detector takes as the top. */
const quarterTurns = (q: Quad): Quad[] => [q, [q[1], q[2], q[3], q[0]], [q[3], q[0], q[1], q[2]]];

/** Read a card's text at a known quad, upright and turned. The most confident read wins. */
async function readAt(image: RgbaImage, quad: Quad, reader: { ocr: OcrEngine; catalog: ScanCatalog; names: NameIndex }, turns: Quad[] = quarterTurns(quad)): Promise<ScanResult> {
  let best: ScanResult | null = null;
  for (const q of turns) {
    const r = await scanFrame(image, { ...reader, guide: q, tryUpsideDown: true });
    if (!best || (r.candidates[0]?.confidence ?? 0) > (best.candidates[0]?.confidence ?? 0)) best = r;
    if ((best.candidates[0]?.confidence ?? 0) >= SURE) break;
  }
  return best!;
}

/**
 * Whether two card names are the same card: the same name, or a face in common ("Westvale Abbey",
 * or the back face "Ormendahl, Profane Prince", and "Westvale Abbey // Ormendahl, Profane Prince":
 * the art index can match either face's illustration).
 */
export function sameCardName(a: string, b: string): boolean {
  const faces = (n: string) => n.split(" // ").map(normaliseName);
  const [fa, fb] = [faces(a), faces(b)];
  return normaliseName(a) === normaliseName(b) || fa.some((f) => fb.includes(f));
}

/**
 * The name the title-and-art decision would file the card under, when that's the card just filed
 * by its name and still held (`blockedName`): it isn't filed again.
 */
export function fusedHeld(fused: Fused<{ name: string }>, heldName: string | undefined): boolean {
  if (!heldName || fused.kind === "none") return false;
  return sameCardName(fused.kind === "art" ? fused.match.name : fused.name, heldName);
}

/** The candidate printings, as a replay needs them (bounded). */
const optionsNote = (printings: Printing[]) =>
  printings.slice(0, 300).map((p) => ({ id: p.scryfall_id, name: p.name, set: p.set_code, number: p.collector_number, rarity: p.rarity, lang: p.lang, released_at: p.released_at }));

/** A strip's sharpness and glare, rounded, for a frame note. */
const qualityNote = (q: StripQuality | null) => (q ? { sharpness: Math.round(q.sharpness), clipped: Math.round(q.clipped * 1000) / 1000 } : {});

/** A card's record with one more reason it's kept (a fresh one when the record was already sent). */
function withReason(rec: ScanRecord | undefined, reason: Reason): ScanRecord | undefined {
  const r = rec?.continued();
  r?.reasons.add(reason);
  return r;
}

/** What the scanner said, for a kept photo. */
const guessOf = (f: Found): NonNullable<Found["guess"]> => ({
  guess_name: f.name,
  // Only a printing the scanner settled itself; a tap isn't the scanner's guess.
  guess_scryfall_id: f.settledId,
  guess_illustration_id: f.art?.illustrationId ?? undefined,
  method: f.method,
  score: f.confidence,
});

/** The lowest and highest market price among printings, for a card whose printing isn't settled. */
export function priceRange(printings: Printing[], finish: ScanFinish): { low: number; high: number; date: string | null } | null {
  if (finish === "proxy") return null;
  const english = printings.filter((p) => p.lang === "en");
  let low = Infinity;
  let high = -Infinity;
  let date: string | null = null;
  for (const p of english.length ? english : printings) {
    const v = priceFor(pricesOf(p), filedFinish(p.finishes, finish));
    if (v == null) continue;
    low = Math.min(low, v);
    high = Math.max(high, v);
    if (p.price_date && (!date || p.price_date > date)) date = p.price_date;
  }
  return low === Infinity ? null : { low, high, date };
}

const candidateOf = (f: Found, p: Printing | null): ScanCandidate => ({
  name: p?.name ?? f.name,
  set: p?.set_code,
  number: p?.collector_number,
  lang: p?.lang,
  scryfall_id: p?.scryfall_id,
  oracle_id: p?.oracle_id,
  image: p?.image_normal,
  thumb: p?.image_small,
  finishes: p?.finishes,
  treatment: p ? treatmentOf(p) : undefined,
  confidence: f.confidence,
  method: f.method,
  prices: p ? pricesOf(p) : undefined,
});

export function ScannerView({
  onAccept,
  onUndo,
  onCorrect,
  catalog: catalogProp,
  ocr: ocrProp,
  onClose,
  addedCount = 0,
  onShowAdded,
  unsavedCount = 0,
  autoAdd = false,
  closeups = true,
  paused: pausedProp = false,
  recent = [],
  finish = "nonfoil",
  recentCards,
  entryOf,
  onOpenCard,
  sounds: soundsProp = true,
  onPrinting,
  controls,
  settings,
  settingsSummary,
  acceptLabel = "Add",
  renderResult,
  identityOnly = false,
  single = false,
  overlay,
  addedWord = "Added",
  haptics = true,
  setLock: lockOffered = !identityOnly,
}: ScannerViewProps) {
  // Read through a ref, so callbacks made in an earlier render follow a change (a Mute switch).
  const hapticsRef = useRef(haptics);
  hapticsRef.current = haptics;
  const buzz = (pattern: number | number[]) => {
    if (hapticsRef.current) navigator.vibrate?.(pattern);
  };
  // Sounds (sounds.ts): the host's say, then the switch in Scan settings (per device, on by default).
  const [soundsSwitch, setSoundsSwitch] = useState(soundsOn);
  const [worth, setWorth] = useState(worthThreshold);
  const soundRef = useRef(false);
  soundRef.current = soundsProp && soundsSwitch;
  const sound = (kind: ScanSound) => {
    if (soundRef.current) playScanSound(kind);
  };
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  /** The part of the panel that needs a tap, when scanning can't go on by itself. */
  const tapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const artRef = useRef<ArtRecognizer | null>(null);
  const textRef = useRef<Promise<{ ocr: OcrEngine; catalog: ScanCatalog; names: NameIndex }> | null>(null);
  const ownedOcr = useRef<ScannerOcr | null>(null);
  const last = useRef<{ index: number; card?: ScanCandidate; at: number } | undefined>(undefined);
  /**
   * The last title read, for the two-frame rule on text. Apart from `last` (the art's), which
   * every art frame replaces: a title read between two art frames would otherwise never be seen
   * again, and two agreeing reads at 0.9 would never lock (review of #143).
   */
  const lastText = useRef<{ card: ScanCandidate; at: number } | undefined>(undefined);
  /** The art just accepted: not found again until the card leaves or another one shows. */
  const blocked = useRef<ArtHold | null>(null);
  /** Frames in a row the detector saw no card, for ending a text hold. */
  const noCard = useRef(0);
  /** The same for a card found by its text (no art match); see hold.ts. The detector seeing no card also ends it. */
  const blockedName = useRef<Hold | null>(null);
  /**
   * The name of the card filed last, until the view is clear of cards: a card found by its art
   * and title again under that name isn't filed by itself (the art hold can let go on one blurry
   * frame while the card is still there; review of 17 Nov 2026).
   */
  const filedName = useRef<string | null>(null);
  /** With Scanner diagnostics on: when the scanner started looking at the card now in view, and what each frame read. */
  const seek = useRef<{ rec: ScanRecord; started: number; frames: Record<string, unknown>[] } | null>(null);
  /** The read loop handed the card to the title close-up: the look goes on there (Codex review of #165). */
  const lookGoesOn = useRef(false);
  /** Records kept for a slow find this session: a cap, so they don't push every other kind out. */
  const slowKept = useRef(0);
  /**
   * With Scanner diagnostics on: when the card now in view first appeared, and the frames read
   * since, for its timing record. Kept only while diagnostics are on, so it costs nothing per
   * frame otherwise.
   */
  const appeared = useRef<Appeared | null>(null);
  /**
   * With Scanner diagnostics on: the art model and slot choices a frame was read with, taken
   * before it's read (Codex review of #171: a model switched mid-frame would label the old
   * model's result as the new one's).
   */
  const frameModel = useRef<{ embed: string; models: Record<string, string> } | null>(null);
  const foundSeq = useRef(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState(WAITING);
  const [found, setFound] = useState<Found | null>(null);
  /** The outline over each card the finder sees (outline.ts), drawn by CardOutline. */
  const [outlines] = useState(() => new OutlineTracker());
  /** The placement gate (gate.ts): kept across the read loop's restarts, so a card read stays read. */
  const [gate] = useState(() => new PlacementGate<GateFrame>());
  /** Frames a second the camera actually delivers (frameRate.ts), for Scanner diagnostics. */
  const [fpsMeter] = useState(() => new FrameRateMeter());
  const [error, setError] = useState<string | null>(null);
  /** "art": recognising artwork. "text": reading text only. null: still starting. */
  const [mode, setMode] = useState<"art" | "text" | null>(null);
  const [loadState, setLoadState] = useState<LoadState | null>(null);
  const [copies, setCopies] = useState(1);
  /** The close-up step: the person holds the camera close to the collector line or the title. */
  const [closeup, setCloseup] = useState<"collector" | "title" | null>(null);
  const [closeupRead, setCloseupRead] = useState("");
  /** The first read's evidence for a card, picked up (once) by the hold-and-read loop that follows it. */
  const firstEvidence = useRef<{ seq: number; ev: Evidence } | null>(null);
  /**
   * Every collector-line evidence gathered for the found card (by its `foundSeq`): the text
   * reader's, the first read, hold and read, the close-up. Settling by look never goes against any
   * of it (evidence.ts, `pointsAway`).
   */
  const cardReads = useRef<{ seq: number; evs: Evidence[] } | null>(null);
  const noteReads = (seq: number, ev: Evidence) => {
    if (cardReads.current?.seq !== seq) cardReads.current = { seq, evs: [] };
    if (!cardReads.current.evs.includes(ev)) cardReads.current.evs.push(ev);
  };
  /** Whether the collector line has read, for this card, something that points to a printing other than `id`. */
  const readsOther = (seq: number, id: string) => cardReads.current?.seq === seq && cardReads.current.evs.some((ev) => ev.pointsAway(id));
  /** What the hold-and-read loop has read so far, for the sheet ("Read the set code (WOC), not the number yet"). */
  const [readProgress, setReadProgress] = useState<string | null>(null);
  /** Bumped to start a new, full attempt at reading the held card's printing (Keep reading, Wrong printing). */
  const [holdRun, setHoldRun] = useState(0);
  /** The last attempt at reading the held card ended without settling it (Keep reading is offered). */
  const [gaveUp, setGaveUp] = useState(false);
  /** Reading the printing from whole-card frames while the card is held (heldRead.ts). */
  const [holding, setHolding] = useState(false);
  /** The text reader in use, once started (ocrEngine.ts); shown in Scan settings. */
  const [ocrName, setOcrName] = useState<ScannerOcr["engine"] | null>(null);
  const closeRef = useRef<HTMLDivElement>(null);
  const foundRef = useRef<Found | null>(null);
  foundRef.current = found;
  /** What the camera actually delivers, e.g. "3840×2160". */
  const [camera, setCamera] = useState<string | null>(null);
  const cameraLabel = useRef(camera);
  cameraLabel.current = camera;
  /** The cameras on this device, named (cameras.ts); empty until the camera is allowed (labels are blank before). */
  const [cameras, setCameras] = useState<NamedCamera[]>([]);
  /** The camera chosen to open: a device id, or null for the browser's back camera. */
  const [cameraId, setCameraId] = useState<string | null>(() => savedCamera()?.id ?? null);
  /** What the camera in use delivers and can do (camera.tsx), kept for the diagnostics to come. */
  const [cameraNow, setCameraNow] = useState<CameraInfo | null>(null);
  /** A photo is being read: the camera loop waits, so the two can't both report a card. */
  const [photoBusy, setPhotoBusy] = useState(false);
  /** The camera is running (a close-up needs it). */
  const [live, setLive] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** What was just added (by Add, a tapped printing or Keep adding), shown on the camera for a moment, with Undo once saved. */
  const [justAdded, setJustAdded] = useState<JustAdded | null>(null);
  // For a moment after each add the camera says so, where the eye already is (design review,
  // 16 Nov 2026: with the strip, the add itself had gone quiet).
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!justAdded?.card || justAdded.say || justAdded.busy) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1200);
    return () => window.clearTimeout(t);
  }, [justAdded]);
  /**
   * The card just filed, while the scanner holds it back as the same card (hold.ts): "Scan anyway"
   * files one more copy of it (Bryan, 15 Nov 2026: real duplicates, two of a card from two orders).
   */
  /** The card just filed, still held: what "Scan anyway" files again, under the settings it was filed with. */
  const [dupe, setDupe] = useState<{ found: Found; printing: Printing | null; label: string; settings: string } | null>(null);
  /** "Scan anyway" is saving: one press, one copy, even on a double tap. */
  const dupeBusy = useRef(false);
  const [dupeSaving, setDupeSaving] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  /** The latest view of the held card, from the hold-and-read loop, for "From your card". */
  const [liveShot, setLiveShot] = useState<Shot | null>(null);
  /** Wrong card was tapped: the other cards it might be, a name box, or just scan again. */
  const [wrongOpen, setWrongOpen] = useState(false);
  const cam = useCameraControls();
  /**
   * The app's own camera (nativeCamera.ts): the option on this device, why it didn't open this
   * time (the browser's camera is used instead), and the camera while it's the one open.
   */
  const [nativeOpt, setNativeOpt] = useState(savedNativeCamera);
  const [nativeFailed, setNativeFailed] = useState<string | null>(null);
  const useNative = nativeOpt.on && !nativeFailed && nativeCameraAvailable();
  const nativeCam = useRef<NativeCamera | null>(null);
  const browserCam = useRef<CameraSource | null>(null);
  /** The camera frames are read from (cameraSource.ts): the app's own while it's open, else the browser's video. */
  const camSrc = (): CameraSource => nativeCam.current ?? (browserCam.current ??= browserCameraSource(() => videoRef.current));
  /** Scan settings are open over the scanner: it stops reading, as for anything else shown over it. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const paused = pausedProp || settingsOpen;
  // The scanner's models (models.ts): what each slot can run, from the server's bundle info, and
  // this device's choices, which take effect at once (Bryan, 20 Nov 2026: switch models on the
  // fly when things break).
  const [modelsInfo, setModelsInfo] = useState<ModelsInfo | null>(null);
  const [modelChoices, setModelChoices] = useState<ModelChoices>(savedModels);
  useEffect(() => onModelsChange(() => setModelChoices(savedModels())), []);
  const deviceCan = useMemo<DeviceCan>(() => ({ text: availableEngines() }), []);
  const slots = useMemo(() => runningAll(modelsInfo ?? modelsOf(null), modelChoices, deviceCan), [modelsInfo, modelChoices, deviceCan]);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  /** The art model the recognizer runs (its option id), once it's loaded. */
  const [artNow, setArtNow] = useState<string | null>(null);
  /** The card finder the recognizer runs (its option id), once it's loaded. */
  const [detectorNow, setDetectorNow] = useState<string | null>(null);
  /** Bumped by each recognizer loaded, so the art switch below follows the one now running. */
  const [artGen, setArtGen] = useState(0);
  /** The look model the recognizer has loaded (its option id), "off" for none. */
  const [lookNow, setLookNow] = useState("off");
  /** A model switch under way, or one that failed, by slot, for Scan settings. */
  const [modelNotes, setModelNotes] = useState<Partial<Record<ModelSlot, string>>>({});
  /** The lock rule in force (models.ts): "lead", or "sure" for sure scores only. */
  const leadRule = () => usesLead(slotsRef.current.lock.option?.id);
  /** Whether the placement gate decides when a card is read (the lock option "lead-gate"; gate.ts). */
  const gateOn = () => slotsRef.current.lock.option?.id === GATE_LOCK;
  /** The option each slot runs now, for kept photos and diagnostics. */
  const modelsNow = (): Record<string, string> => {
    const now = slotsRef.current;
    return { detector: artRef.current?.detector ?? NO_ART_MODEL, art: artRef.current?.art ?? NO_ART_MODEL, look: artRef.current?.look ?? "off", text: now.text.option?.id ?? "auto", lock: now.lock.option?.id ?? "lead" };
  };
  // Audio is paused once no scanner (or deck check) is open, rather than left running (sound.ts).
  useEffect(() => holdSound(), []);
  const camRef = useRef(cam);
  camRef.current = cam;
  // Scanner diagnostics (diagnostics.ts): the switch, and what the scanning loop knew when it found a card.
  const [diag, setDiag] = useState(diagnosticsOn);
  const diagRef = useRef(diag);
  diagRef.current = diag;
  const scanCtx = useRef<Record<string, unknown> | null>(null);
  const cameraNowRef = useRef<Record<string, unknown> | null>(null);
  const ocrNameRef = useRef<string | null>(null);
  /** A record for a card just found, when diagnostics are on (or the one carried from the card before). */
  const newRecord = (carry?: ScanRecord): ScanRecord | undefined => {
    // The looking that led to this card ends here, and so does what the frame knew: it's this
    // card's whether or not anything is kept, so it can't label a later one (Codex review of #171).
    const looked = seek.current;
    seek.current = null;
    const ctx = scanCtx.current;
    scanCtx.current = null;
    if (carry) return carry;
    if (!diagRef.current) return undefined;
    // Started with the look: the account and the switch as they were then (diagnostics.ts).
    const rec = looked?.rec ?? baseRecord();
    if (looked && Date.now() - looked.started >= SLOW_FIND_MS && slowKept.current < SLOW_KEPT) {
      slowKept.current += 1;
      rec.reasons.add("slow-find");
      rec.note("seek", { ms: Date.now() - looked.started, frames: looked.frames });
    }
    if (ctx) {
      rec.note("scan", ctx);
      if (ctx.overruled) rec.reasons.add("title-overruled");
    }
    return rec;
  };
  /**
   * A timing record for a card just named (with diagnostics on), or the one carried from the card
   * before (Wrong card). `fallback` is the rule when the frame didn't say (a text read, the title
   * close-up); `top`, the art's score for the card when the frame didn't give its top match. Before
   * `newRecord`, which takes the frame's note.
   */
  const newTiming = (carry: TimingRecord | undefined, fallback: SettleRule, top?: number): TimingRecord | undefined => {
    const seen = appeared.current;
    appeared.current = null;
    const fm = frameModel.current;
    frameModel.current = null;
    if (carry) return carry;
    if (!diagRef.current) return undefined;
    const ctx = scanCtx.current as { lock?: SettleRule; photo?: boolean; lead?: number; top?: number } | null;
    const photo = !!ctx?.photo;
    const rule = fallback === "typed" ? "typed" : (ctx?.lock ?? fallback);
    // Timed on the live camera only: not a photo, nor a name the person typed.
    const timed = !photo && rule !== "typed";
    const timing = new TimingRecord({
      rule,
      mode: identityOnly ? "identity" : "printing",
      photo,
      ms: seen && timed ? Date.now() - seen.at : undefined,
      frames: photo ? 1 : timed ? seen?.frames : undefined,
      top: ctx?.top ?? top,
      lead: ctx?.lead,
      camera: cameraLabel.current ?? undefined,
      embed: fm?.embed ?? artRef.current?.embed ?? NO_ART_MODEL,
      models: fm?.models ?? modelsNow(),
    });
    // What the camera delivered just now, and whether the lens was pinned (frameRate.ts, cameraFocus.ts).
    const fps = fpsMeter.fps();
    if (fps != null) timing.detail.fps = fps;
    if (camRef.current.focus != null) timing.detail.focus_pinned = camRef.current.focus;
    // With the placement gate: which try named the card (gate.ts).
    if (gateOn() && timed && gate.attempts > 0) timing.detail.gate_attempts = gate.attempts;
    return timing;
  };
  /** A fresh record with the camera and text reader in use. */
  const baseRecord = () => {
    const rec = new ScanRecord();
    const c = camRef.current;
    rec.camera = { ...(cameraNowRef.current ?? {}), zoom: c.zoom, torch: c.torch, digital: c.digital, focusPinned: c.focus ?? undefined, fps: fpsMeter.fps() ?? undefined };
    rec.engine = ocrNameRef.current;
    rec.embed = artRef.current?.embed ?? NO_ART_MODEL;
    rec.models = modelsNow();
    return rec;
  };
  /**
   * One frame read while looking for a card not yet found (with Scanner diagnostics on): what the
   * art said, filled in with the title and text reads as they come. Null when diagnostics are off.
   */
  const seekFrame = (note: Record<string, unknown>): Record<string, unknown> | null => {
    if (!diagRef.current) return null;
    seek.current ??= { rec: baseRecord(), started: Date.now(), frames: [] };
    if (seek.current.frames.length >= SEEK_FRAMES) return null;
    const frame = { t: Date.now() - seek.current.started, ...note };
    seek.current.frames.push(frame);
    return frame;
  };
  /**
   * The card being looked for left the view (or the scanner closed) without being found: a long
   * look is kept as a record with no card ("slow-find", outcome "left"), so the stall can be seen.
   */
  const endSeek = () => {
    const looked = seek.current;
    seek.current = null;
    if (!looked || !diagRef.current || Date.now() - looked.started < SLOW_FIND_MS || slowKept.current >= SLOW_KEPT) return;
    slowKept.current += 1;
    const rec = looked.rec;
    rec.reasons.add("slow-find");
    rec.note("seek", { ms: Date.now() - looked.started, frames: looked.frames });
    void rec.send("left");
  };
  /** The card is done with: send its record, if it was kept for anything, and its timing record. */
  const endRecord = (outcome: Outcome, f: Found | null | undefined = foundRef.current) => {
    if (f?.rec) void f.rec.send(outcome);
    if (f?.timing) void f.timing.send(outcome);
  };
  cameraNowRef.current = cameraNow as Record<string, unknown> | null;
  ocrNameRef.current = ocrName;
  // Closing the scanner with a card still in hand ends its record ("left").
  useEffect(
    () => () => {
      endRecord("left");
      endSeek();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  /**
   * The loops reading the camera (scanning, hold and read, the close-up): each registers how to
   * stop it, and a camera switch stops them all at once, synchronously, so nothing from the old
   * camera is used after it (review of #145).
   */
  const readers = useRef(new Set<() => void>());
  /** Bumped by every camera switch: work begun before it checks this after each await (`settle`). */
  const camGen = useRef(0);
  const haltReaders = () => {
    camGen.current += 1;
    for (const halt of readers.current) halt();
    firstEvidence.current = null;
    // A first read of the collector line under way is dropped; the held card is read again on the new camera.
    setFound((cur) => (cur?.reading ? { ...cur, reading: false } : cur));
  };
  /** Auto-zoom (zoomPolicy.ts), for a camera that zooms itself. */
  const autoZoomRef = useRef<AutoZoom | null>(null);
  useEffect(() => {
    autoZoomRef.current = cam.caps.zoom ? new AutoZoom(cam.caps.zoom) : null;
  }, [cam.caps.zoom]);
  /** The collector line's letters are too small to read where the card is (closer.ts). */
  const [far, setFar] = useState(false);
  /**
   * Each frame's card, in video pixels (null when none): the "Move closer" hint, and auto-zoom's
   * step toward the card filling the view (the view the camera box shows, at the camera's zoom).
   */
  const seeCard = (quad: Quad | null, v: HTMLVideoElement) => {
    // By the card's size in the camera's full frame (the app's own camera hands frames over smaller).
    const full = camSrc().fullScale();
    setFar(!!quad && tooFar(full === 1 ? quad : (quad.map(([x, y]) => [x * full, y * full]) as Quad)));
    const az = autoZoomRef.current;
    const c = camRef.current;
    if (!az || c.userZoomed()) return;
    const box = v.closest(".scan-camera")?.getBoundingClientRect();
    const k = box && box.width > 0 && box.height > 0 ? Math.max(box.width / v.videoWidth, box.height / v.videoHeight) : 1;
    const visibleH = box && box.height > 0 ? Math.min(v.videoHeight, box.height / k) : v.videoHeight;
    const z = az.frame(quad ? cardHeight(quad) / visibleH : null, c.zoom, performance.now());
    if (z != null) c.autoZoom(z);
  };
  /** What the host files a card with (finish, where it goes), as far as the scanner is told. */
  const fileSettings = `${finish ?? ""}|${settingsSummary ?? ""}`;
  const digitalRef = useRef(1);
  digitalRef.current = cam.digital;

  // The set lock: the sets chosen (kept on this device), their artworks for the recognizer, and
  // their card names for reading text.
  const [lockCodes, setLockCodes] = useState<string[]>(() => (lockOffered ? savedLock() : []));
  const [lock, setLockSets] = useState<LockedSet[]>([]);
  const [lockLoading, setLockLoading] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  /** Sets of the printings filed this scan, newest first, for suggesting a lock. */
  const [filedSets, setFiledSets] = useState<string[]>([]);
  const [suggestDismissed, setSuggestDismissed] = useState<string | null>(null);
  const filedSetNames = useRef(new Map<string, string>());
  const lockRef = useRef<{ codes: Set<string>; names: NameIndex | null; inSets: (m: ArtMatch) => boolean; label: string } | null>(null);
  /** Share of the locked sets' artworks the art index knows (setlock.ts, knownArtShare); 1 unlocked. */
  const poolShare = useRef(1);
  /**
   * Whether `poolShare` is measured for the lock in force: false while its pool is still being set
   * (until then it reads 1), when a lead mustn't count (leadCounts; Codex review of #166).
   */
  const poolReady = useRef(true);
  /** Bumped by each pool request: an older one's answer is dropped. */
  const poolGen = useRef(0);
  /** The locked sets' known share for deciding by a lead: none while it isn't measured yet. */
  const leadShare = () => (poolReady.current ? poolShare.current : 0);
  useEffect(() => {
    if (!lockOffered) return;
    let live = true;
    saveLock(lockCodes);
    if (lockCodes.length === 0) {
      setLockSets([]);
      setLockError(null);
      return;
    }
    setLockLoading(true);
    setLockError(null);
    Promise.all(lockCodes.map((c) => lockedSet(c))).then(
      (sets) => {
        if (!live) return;
        setLockSets(sets);
        setLockError(null);
        setLockLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setLockError(e instanceof Error ? e.message : String(e));
        setLockLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [lockCodes, lockOffered]);
  // On only once the sets loaded are exactly the sets chosen (not an earlier choice still loaded).
  const lockOn = lockOffered && lock.length > 0 && !lockError && lock.length === lockCodes.length && lock.every((l, i) => l.code === lockCodes[i]);
  const lockLabel = lock.map((s) => s.code.toUpperCase()).join(", ");
  useEffect(() => {
    if (!lockOn) {
      lockRef.current = null;
      return;
    }
    const keys = poolKeys(lock);
    lockRef.current = { codes: new Set(lock.map((s) => s.code)), names: new NameIndex(lockedNames(lock)), inSets: artInSets(keys), label: lock.map((s) => s.name).join(" or ") };
  }, [lock, lockOn]);
  useEffect(() => {
    if (!justAdded || justAdded.busy) return;
    const t = setTimeout(() => setJustAdded(null), justAdded.card ? UNDO_MS : 2500);
    return () => clearTimeout(t);
  }, [justAdded]);

  const ocrRef = useRef<Promise<OcrEngine> | null>(null);
  /** The text slot's choice (models.ts), for the next reader started, and the server's text readers on offer. */
  const ocrChoice = useRef<OcrChoice>({});
  ocrChoice.current = textChoice(slots, modelsInfo);
  /** The readers to try in order for the choice the running reader was started with (or will be). */
  const textKey = engineOrder(ocrChoice.current).join(",");
  const textStartedFor = useRef(textKey);
  /** The card names to read against, kept when the text reader is switched. */
  const catalogRef = useRef<Promise<{ catalog: ScanCatalog; names: NameIndex }> | null>(null);
  /** False once the scanner closes: work finishing after that must clean up after itself. */
  const alive = useRef(true);
  /** Bumped when the scanner closes or remounts: an OCR engine started before then isn't kept. */
  const ocrSession = useRef(0);
  /** The text reader (ML Kit in the Android app, PaddleOCR or Tesseract in the browser; ocrEngine.ts), started on first use. */
  const ocrEngine = useCallback(() => {
    // Tesseract's files are served by the app (scripts/copy-ocr.mjs), so it works offline and loads
    // nothing from a CDN. The folder and tesseract's own saved copy of the model are named by the
    // engine's version, so a new engine is fetched rather than an old copy kept.
    const ocr = `/ocr/${import.meta.env.VITE_OCR_VERSION}`;
    const session = ocrSession.current;
    ocrRef.current ??= ocrProp
      ? Promise.resolve(ocrProp)
      : createScannerOcr({ workerPath: `${ocr}/worker.min.js`, corePath: `${ocr}/core`, langPath: `${ocr}/lang`, cachePath: `ocr-${import.meta.env.VITE_OCR_VERSION}` }, ocrChoice.current).then((o) => {
          if (!alive.current || ocrSession.current !== session) {
            void o.terminate();
            throw new Error(alive.current ? TEXT_SWITCHED : "The scanner is closed");
          }
          setOcrName(o.engine);
          return (ownedOcr.current = o);
        });
    const started = ocrRef.current;
    started.catch(() => {
      if (ocrRef.current === started) ocrRef.current = null;
    });
    return started;
  }, [ocrProp]);
  /** The text reader (OCR plus every card name), started on first use. */
  const textReader = useCallback(() => {
    textRef.current ??= (async () => {
      catalogRef.current ??= (async () => {
        const catalog = catalogProp ?? (await createServerCatalog({ setCodes: await api<string[]>("/api/sets").catch(() => undefined) }));
        return { catalog, names: new NameIndex(catalog.names()) };
      })();
      const known = catalogRef.current;
      known.catch(() => {
        if (catalogRef.current === known) catalogRef.current = null;
      });
      return { ocr: await ocrEngine(), ...(await known) };
    })();
    textRef.current.catch(() => (textRef.current = null));
    return textRef.current;
  }, [catalogProp, ocrEngine]);

  // The art recognizer, once per mount; the text reader when there's no recognizer.
  useEffect(() => {
    let cancelled = false;
    let art: ArtRecognizer | null = null;
    alive.current = true;
    (async () => {
      try {
        // What the slots can run first, so the recognizer starts with the art model chosen here.
        const info = await scanBundleInfo().catch((e: unknown) => {
          console.warn("The scanner's bundle info is unavailable", e);
          return null;
        });
        if (cancelled) return;
        const models = modelsOf(info);
        setModelsInfo(models);
        // The text slot as the server lists it, before any reader starts (a withdrawn one isn't
        // started and then stopped when the render with these models comes).
        ocrChoice.current = textChoice(runningAll(models, savedModels(), deviceCan), models);
        textStartedFor.current = engineOrder(ocrChoice.current).join(",");
        const chosen = savedModels();
        art = await loadArtRecognizer((s) => !cancelled && setLoadState(s), { info, art: running(models, "art", chosen.art, deviceCan).option, detector: running(models, "detector", chosen.detector, deviceCan).option });
      } catch (e) {
        console.warn("Card recognizer unavailable", e);
      }
      if (cancelled) return art?.dispose();
      artRef.current = art;
      setArtNow(art?.art ?? null);
      setDetectorNow(art?.detector ?? null);
      setArtGen((g) => g + 1);
      setLoadState(null);
      if (art) setMode("art");
      else {
        // A reader switched while it started (Scan settings) starts again as the one now chosen.
        for (let tries = 0; ; tries += 1) {
          try {
            await textReader();
            if (!cancelled) setMode("text");
            break;
          } catch (e) {
            if (cancelled) break;
            if (tries < 2 && e instanceof Error && e.message === TEXT_SWITCHED) continue;
            setError(e instanceof Error ? e.message : String(e));
            break;
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      ocrSession.current += 1;
      artRef.current = null;
      art?.dispose();
      void ownedOcr.current?.terminate();
      ownedOcr.current = null;
      ocrRef.current = null;
      textRef.current = null;
      catalogRef.current = null;
    };
    // deviceCan never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textReader]);

  // Another art model chosen in Scan settings: the recognizer swaps its embed graph, keeping
  // everything else (and the scan) as it is. Asked for every change, even back to the one running:
  // switches run one after another (artClient.ts), so the last one asked for is the one that runs.
  const artWant = slots.art.option;
  useEffect(() => {
    const art = artRef.current;
    if (mode !== "art" || !art || !artWant?.file) return;
    let live = true;
    if (art.art !== artWant.id) setModelNotes((n) => ({ ...n, art: `Loading ${artWant.label}…` }));
    art.useArt(artWant).then(
      () => {
        if (!live) return;
        setArtNow(art.art);
        setModelNotes((n) => ({ ...n, art: undefined }));
        // Scores from the model before don't compare with this one's: start the card afresh.
        art.reset();
        last.current = undefined;
      },
      (e: unknown) => {
        if (!live) return;
        console.warn("Couldn't switch the art model", e);
        setModelNotes((n) => ({ ...n, art: `Couldn't load ${artWant.label} (${e instanceof Error ? e.message : String(e)}), so the one before still runs.` }));
      },
    );
    return () => {
      live = false;
    };
    // By the option chosen, not the object (slots is rebuilt on every change); and each recognizer
    // loaded (artGen), which starts with the choice read when its load began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, artGen, artWant?.id, artWant?.file]);

  // The look model chosen (models.ts), loaded into the art worker beside the art model; none where
  // only the card matters (no printing to choose), and none for "Off".
  const lookWant = slots.look.option;
  useEffect(() => {
    const art = artRef.current;
    if (mode !== "art" || !art) return;
    const want = !identityOnly && lookWant?.file ? lookWant : null;
    let live = true;
    if ((want?.id ?? "off") !== art.look) setModelNotes((n) => ({ ...n, look: want ? `Loading ${want.label}…` : undefined }));
    art.useLook(want).then(
      () => {
        if (!live) return;
        setLookNow(art.look);
        setModelNotes((n) => ({ ...n, look: undefined }));
      },
      (e: unknown) => {
        if (!live) return;
        console.warn("Couldn't load the look model", e);
        setLookNow(art.look);
        setModelNotes((n) => ({ ...n, look: `Couldn't load ${want?.label ?? "it"} (${e instanceof Error ? e.message : String(e)}), so printings are listed newest first.` }));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, artGen, lookWant?.id, lookWant?.file, identityOnly]);

  // Another card finder chosen in Scan settings: swapped the same way (the recognizer starts with the
  // one chosen when it loaded).
  const detectorWant = slots.detector.option;
  useEffect(() => {
    const art = artRef.current;
    if (mode !== "art" || !art || !detectorWant?.file) return;
    let live = true;
    if (art.detector !== detectorWant.id) setModelNotes((n) => ({ ...n, detector: `Loading ${detectorWant.label}…` }));
    art.useDetector(detectorWant).then(
      () => {
        if (!live) return;
        setDetectorNow(art.detector);
        setModelNotes((n) => ({ ...n, detector: undefined }));
        art.reset();
      },
      (e: unknown) => {
        if (!live) return;
        console.warn("Couldn't switch the card finder", e);
        setModelNotes((n) => ({ ...n, detector: `Couldn't load ${detectorWant.label} (${e instanceof Error ? e.message : String(e)}), so the one before still runs.` }));
      },
    );
    return () => {
      live = false;
    };
    // As for the art model above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, artGen, detectorWant?.id, detectorWant?.file]);

  // Another text reader chosen (or one withdrawn): the next read starts the new one, and the one
  // running is stopped once the reads it has under way are done (OCR_RETIRE_MS), so a collector
  // line being read isn't cut short. The card names stay loaded.
  useEffect(() => {
    if (textStartedFor.current === textKey) return;
    textStartedFor.current = textKey;
    if (ocrProp || !ocrRef.current) return;
    const old = ownedOcr.current;
    ownedOcr.current = null;
    ocrRef.current = null;
    textRef.current = null;
    // A reader still starting for the old choice is stopped as it arrives (ocrEngine).
    ocrSession.current += 1;
    setOcrName(null);
    if (old) setTimeout(() => void old.terminate(), OCR_RETIRE_MS);
  }, [textKey, ocrProp]);

  // A new zoom moves everything in the recognizer's frame: drop the card it was tracking.
  useEffect(() => {
    artRef.current?.reset();
  }, [cam.digital]);

  // The locked sets' artworks, for the recognizer to match as well.
  useEffect(() => {
    const art = artRef.current;
    if (mode !== "art" || !art) return;
    const keys = lockOn ? poolKeys(lock) : null;
    const gen = ++poolGen.current;
    poolShare.current = 1;
    poolReady.current = !keys;
    void art.setPool(keys).then((n) => {
      if (gen !== poolGen.current) return;
      if (keys) poolShare.current = knownArtShare(n, keys);
      poolReady.current = true;
    });
  }, [mode, lock, lockOn]);

  // Camera: the one chosen in Scan settings, else the main back camera (cameras.ts), else the
  // browser's back camera. The list of cameras is only named once the camera is allowed.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let stopFps = () => undefined as void;
    if (useNative) {
      // The app's own camera: its frames arrive in the canvas that stands where the video does.
      const el = videoRef.current as unknown as HTMLCanvasElement | null;
      if (!el) return;
      const told = (info: SourceInfo) => {
        if (stopped) return;
        setCameraNow(info);
        setCamera(sourceLabel(info));
      };
      // The same sizes the browser's camera is asked for, below.
      const size = identityOnly ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
      const native = openNativeCamera(el, { lens: nativeOpt.lens, fps: nativeOpt.fps, ...size, torchLevel: nativeOpt.torchLevel }, { onInfo: told });
      nativeCam.current = native;
      native.ready.then(
        (info) => {
          if (stopped) return;
          cam.attach(native.track());
          console.info("Scanner camera", info);
          told(info);
          setCameras([]);
          setLive(true);
          setPhase((p) => (p === "loading" ? "scanning" : p));
        },
        (e: unknown) => {
          // It won't open here: the camera as before, and Scan settings say why.
          if (!stopped) setNativeFailed(e instanceof Error ? e.message : "it didn't open");
        },
      );
      return () => {
        stopped = true;
        haltReaders();
        setLive(false);
        cam.attach(null);
        native.close();
        if (nativeCam.current === native) nativeCam.current = null;
      };
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("no-camera");
      setError("This browser can't open the camera here (it needs https). Use a photo instead.");
      return;
    }
    // As sharp as the camera allows: the collector line is tiny. Frames are scaled down for
    // recognition anyway; only the crops read as text use the full resolution. When only the card
    // matters nothing reads the collector line, and a 4K stream only slows the phone: 1080p.
    const size = identityOnly ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 3840 }, height: { ideal: 2160 } };
    /** Ask for a camera, unless this effect is already done with; a stream that arrives too late is stopped. */
    const open = async (id: string | null): Promise<MediaStream | null> => {
      if (stopped) return null;
      const s = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id }, ...size } : { facingMode: { ideal: "environment" }, ...size }, audio: false });
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      return s;
    };
    void (async () => {
      try {
        let s: MediaStream | null;
        try {
          s = await open(cameraId);
        } catch (e) {
          // A camera chosen before that won't open (its id may have changed): the back camera for
          // now. The choice is kept: its label may find it again below, under its new id.
          if (!cameraId || stopped) throw e;
          s = await open(null);
        }
        if (!s) return;
        stream = s;
        const track = s.getVideoTracks()[0];
        cam.attach(track ?? null);
        if (track) {
          const info = cameraInfo(track);
          // For checking a phone by hand (and the diagnostics to come): what it delivers and can do.
          console.info("Scanner camera", info, track.getCapabilities?.());
          setCameraNow(info);
          if (info.width && info.height) setCamera(`${info.width}×${info.height}`);
          // Now the cameras have names: list them, and open the best one for close cards if this isn't it.
          const devices = (await navigator.mediaDevices.enumerateDevices?.().catch(() => [])) ?? [];
          if (stopped) return;
          const named = nameCameras(devices.filter((d) => d.kind === "videoinput").map((d) => ({ deviceId: d.deviceId, label: d.label })));
          setCameras(named);
          const saved = resolveSaved(named, savedCamera());
          if (saved.save !== "keep") saveCamera(saved.save);
          const want = saved.camera ?? defaultCamera(named);
          const current = (track.getSettings?.().deviceId as string | undefined) ?? null;
          if (want && current && want.deviceId !== current && want.deviceId !== cameraId) {
            setCameraId(want.deviceId);
            return;
          }
        }
        // 60 frames a second where this camera gives it at the size it's already delivering (frameRate.ts).
        // After the focus set on attach, and before any later flashlight or zoom (camera.tsx, `exclusive`).
        if (track && fps60On() && (await cam.exclusive(track, () => ask60(track))) === "sixty") {
          if (stopped) return;
          setCameraNow(cameraInfo(track));
        }
        const v = videoRef.current;
        if (!v || stopped) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        // Nothing reads until the camera delivers frames.
        await firstFrame(v);
        if (stopped) return;
        stopFps = watchFrameRate(v, fpsMeter);
        setLive(true);
        setPhase((p) => (p === "loading" ? "scanning" : p));
      } catch (e) {
        if (stopped) return;
        setPhase("no-camera");
        setError(e instanceof Error ? `No camera: ${e.message}` : "No camera");
      }
    })();
    return () => {
      stopped = true;
      // Every loop reading this camera stops now, before any result from it is used, and what an
      // attempt had read is dropped (review of #145): a switch starts reading afresh.
      haltReaders();
      gate.reset();
      stopFps();
      setLive(false);
      const v = videoRef.current;
      if (v && stream && v.srcObject === stream) v.srcObject = null;
      cam.attach(null);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // cam.attach and haltReaders are stable for this purpose. The app's camera reopens for a new
    // lens or capture rate; its flashlight strength changes as it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, useNative, nativeOpt.lens, nativeOpt.fps]);

  /** The look at the found card's printings under way (look.ts): stopped when the card is done with or its printing chosen. */
  const lookRun = useRef<{ seq: number; stop: AbortController } | null>(null);
  const stopLook = () => {
    lookRun.current?.stop.abort();
    lookRun.current = null;
  };
  /**
   * The printing look's scores for the found card (look.ts), by its `foundSeq`: kept apart from
   * `found`, whose changes restart the hold-and-read loop (review of #172). `complete` once every
   * printing it could compare is scored and the look wasn't stopped: only then does it order the
   * list, once, so a printing doesn't move under a finger. `option`: the look option that ran it
   * (models.ts), which may settle the printing when it's sure.
   */
  const [look, setLook] = useState<{ seq: number; scores: LookScores; complete: boolean; option?: string } | null>(null);
  /** The found card (its seq) whose list was touched before the look finished: its order stays. */
  const [lookTouched, setLookTouched] = useState<number | null>(null);
  /**
   * Each card's finished look, by the card's shot (the view it was found in, carried through every
   * copy of its `Found`, and held weakly): Wrong printing after filing reopens a card whose frames
   * are gone (Codex review of #172), so it reuses its own look. Never another copy's.
   */
  const lookDone = useRef(new WeakMap<object, LookScores>());
  /**
   * Compare the printings that share the found card's art with what the camera saw (the look slot,
   * models.ts), a few at a time. Its scores and timings go in the card's diagnostics record as they
   * come. A ref, so `settle` (memoised) calls the latest.
   */
  const startLook = useRef<(seq: number, f: Found, printings: Printing[]) => void>(() => undefined);
  startLook.current = (seq, f, printings) => {
    stopLook();
    const art = artRef.current;
    if (!art || art.look === "off" || identityOnly || !f.art) return;
    const candidates = lookCandidates(printings, f.art.id.endsWith("-1"));
    if (candidates.length < 2) return;
    const stop = new AbortController();
    lookRun.current = { seq, stop };
    const model = art.look;
    const scores: LookScores = {};
    const note = (done: Partial<LookDone> & { error?: string; stopped?: boolean }) =>
      f.rec?.note("look", {
        ...done,
        model,
        options: printings.map((p) => ({ id: p.scryfall_id, set: p.set_code, number: p.collector_number, score: scores[p.scryfall_id] === undefined ? null : Math.round(scores[p.scryfall_id]! * 1000) / 1000 })),
      });
    art.lookAt(
      f.art.index,
      candidates,
      (id, score) => {
        // Another card since: this look is done with.
        if (foundSeq.current !== seq) return stop.abort();
        scores[id] = score;
        // Written as it comes, so a record sent before the look ends has what it had.
        note({ stopped: true });
      },
      stop.signal,
    ).then(
      (done) => {
        const complete = !stop.signal.aborted && done.scored >= 2;
        // The closest printing's lead over the next once every printing is scored: what settling
        // by look goes on, recorded whichever option ran, so the default's scans measure it too.
        const lead = complete ? lookLead(printings, scores) : null;
        note({ ...done, stopped: !complete, ...(lead ? { lead: Math.round(lead.lead * 1000) / 1000 } : {}) });
        if (lead && f.timing) f.timing.detail.look_lead = Math.round(lead.lead * 1000) / 1000;
        if (complete && f.shot) lookDone.current.set(f.shot, { ...scores });
        if (foundSeq.current === seq) setLook({ seq, scores: { ...scores }, complete, option: model });
      },
      (e: unknown) => {
        note({ error: e instanceof Error ? e.message : String(e) });
        if (lookRun.current?.seq === seq) setLookNow(art.look);
      },
    );
  };
  // The look ends with its card, or once the printing is chosen (settled, or tapped).
  const lookEnds = !found || !!found.chosen;
  useEffect(() => {
    if (lookEnds) stopLook();
  }, [lookEnds]);
  useEffect(() => () => stopLook(), []);

  /** The found card (its seq) whose finished look has been weighed for settling by look: once each. */
  const lookWeighed = useRef<number | null>(null);
  // Settling by look (the look option that settles when sure, opt-in; docs/scanner.md, "Settling by
  // look"): once the look has compared every printing in the list and the closest leads the next by
  // LOOK_SETTLE_LEAD, that printing is settled as a collector-line read would settle it ("Wrong
  // printing" offered, Keep adding files it), and the collector line stops reading. Never against
  // anything the collector line has read pointing to another printing, so not while its first read
  // is under way; never once the person said the scanner's printing was wrong; not while they're
  // saying it's another card or the scanner is paused (it's weighed when that ends); never once
  // they've touched the list (they're choosing). A printing the collector line settled first stays
  // its. The rule is weighed under every look option, for the records (what it would have done
  // under the default too); only the option running now that settles, on the model the look ran
  // on, acts on it (a switch takes effect at once: Codex review of #178).
  useEffect(() => {
    const f = found;
    if (identityOnly || !look?.complete || look.seq !== foundSeq.current || lookWeighed.current === look.seq) return;
    if (!f || phase !== "found" || f.chosen || f.reading || f.misread || f.correcting || f.outside || !f.options || f.options.length < 2 || wrongOpen || paused) return;
    lookWeighed.current = look.seq;
    const seq = look.seq;
    const got = lookSettles(f.options, look.scores, (id) => readsOther(seq, id));
    const lead = got.lead == null ? null : Math.round(got.lead * 1000) / 1000;
    const optionOf = (id: string | undefined) => (id ? modelsInfo?.look.options.find((o) => o.id === id) : undefined);
    const now = optionOf(lookNow);
    const ran = optionOf(look.option);
    const acts = !!now?.settles && !!ran?.file && ran.file === now.file;
    // The timing record: the look option whose rule this was, and what the rule said on the raw lead.
    if (f.timing) {
      f.timing.detail.look_option = lookNow;
      f.timing.detail.look_sure = got.settled;
    }
    const why = !got.settled ? got.why : !acts ? "option" : lookTouched === seq ? "touched" : null;
    if (why || !got.settled) {
      f.rec?.note("lookSettle", { settled: false, option: lookNow, why, lead });
      return;
    }
    const id = got.id;
    setFound((cur) => {
      const hit = cur?.options?.find((p) => p.scryfall_id === id);
      // The card changed in between (a read settled it, Wrong printing): weighed again with it.
      if (!cur || !hit || foundSeq.current !== seq || cur.chosen || cur.reading || cur.misread || cur.correcting) {
        lookWeighed.current = null;
        return cur;
      }
      cur.rec?.note("lookSettle", { settled: true, option: lookNow, id: hit.scryfall_id, set: hit.set_code, number: hit.collector_number, lead });
      return { ...cur, chosen: hit, how: "look", sure: true, settledId: hit.scryfall_id, picking: false };
    });
    setCloseup((c) => (c === "collector" ? null : c));
    buzz(30);
    // buzz and readsOther read refs; the rest is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look, found, phase, wrongOpen, paused, identityOnly, lookNow, lookTouched, modelsInfo]);

  /** Settle the printing of what was found (not needed when only the card's identity matters). */
  const settle = useCallback(
    async (seq: number, f: Found, query: { art?: string | null; id?: string; name?: string }, read?: { image: RgbaImage; quad: Quad } | null, known?: Known) => {
      const update = (patch: Partial<Found>) => {
        if (foundSeq.current === seq) setFound((cur) => (cur ? { ...cur, ...patch } : cur));
      };
      // What the camera saw (the read, a text read's line) counts only while it's the same camera
      // (review of #145): after a switch the printings still load, but nothing read before it
      // chooses one or carries on as evidence, and the held card is read again on the new camera.
      const gen = camGen.current;
      const sameCamera = () => camGen.current === gen;
      try {
        let opts = await printingOptions(query);
        // Locked to sets: choose among the printings in them. None there: ask (outside).
        const lockNow = f.unlocked ? null : lockRef.current;
        let bySet = false;
        let lockedOut: Printing[] = [];
        if (lockNow) {
          const inSets = inLockedSets(opts.printings, lockNow.codes);
          // A name typed by the person is what they say it is: no need to ask about the set.
          const typed = f.method === "name" && f.confidence === 1;
          if (inSets.length === 0 && !typed) {
            update({ options: opts.printings, sameArt: opts.sameArt, outside: true, chosen: null, how: null, sure: false, reading: false });
            return;
          }
          if (inSets.length > 0) {
            lockedOut = opts.printings.filter((p) => !inSets.includes(p));
            opts = { sameArt: opts.sameArt, printings: inSets };
            bySet = true;
          }
        }
        let choice: Choice = choosePrinting(opts);
        // The candidates, for a replay of what was read (eval/real.test.ts).
        f.rec?.note("options", optionsNote(opts.printings));
        // Read from the collector line by the text reader already. Proof only as evidence.ts would
        // settle it (a field read exactly, the twin guards), never from the reader's confidence;
        // otherwise its printing goes first in the list and the held card is read on, with that
        // read as the first frame.
        if (!choice.chosen && known?.set && known.number) {
          const hit = opts.printings.find((p) => p.set_code === known.set && p.collector_number === known.number);
          const { proven, ev } = proofOf(opts.printings, known.text ?? "", lockedOut);
          noteReads(seq, ev);
          f.rec?.frame({ source: "first", reads: [known.text ?? ""], verdict: ev.verdict() });
          if (sameCamera() && hit && proven === hit.scryfall_id) choice = { chosen: hit, how: "collector", options: [hit, ...choice.options.filter((p) => p !== hit)], readFirst: 1, certain: true };
          else {
            if (hit) choice = { ...choice, options: [hit, ...choice.options.filter((p) => p !== hit)], readFirst: 1 };
            if (sameCamera()) firstEvidence.current = { seq, ev };
          }
        }
        const how: Found["how"] = bySet && choice.how === "only" ? "set" : choice.how;
        const reading = !choice.chosen && !!read && sameCamera();
        const sure = choice.how === "only" || !!choice.certain;
        update({ options: choice.options, lockedOut, readFirst: choice.readFirst ?? 0, sameArt: opts.sameArt, outside: false, chosen: choice.chosen, how, sure, settledId: sure ? choice.chosen?.scryfall_id : undefined, reading });
        // Several printings share the art and none is settled: the look compares them (look.ts),
        // alongside the collector line's read, to order the list should a tap be needed.
        if (!choice.chosen && opts.sameArt) startLook.current(seq, f, opts.printings);
        if (!reading) return;
        // Several printings share the art: read the collector line to tell them apart, trying a
        // few cuts of the corner until one settles it.
        // The crops' reads are one frame of evidence (evidence.ts); it carries on into hold and read.
        const ev = new Evidence(opts.printings, lockedOut);
        noteReads(seq, ev);
        const reads: string[] = [];
        let quality: StripQuality | null = null;
        for await (const text of readCollectorLines(read!.image, read!.quad, await ocrEngine(), { gate: (q) => ((quality = q), true) })) {
          if (foundSeq.current !== seq || !sameCamera()) break;
          reads.push(text);
        }
        if (foundSeq.current !== seq) return;
        if (!sameCamera()) {
          update({ reading: false });
          return;
        }
        ev.add(reads);
        const v = ev.verdict();
        const raw = reads.join("\n");
        f.rec?.frame({ source: "first", reads, ...qualityNote(quality), cardPx: Math.round(cardHeight(read!.quad)), verdict: v });
        if (v.kind === "settled") {
          const hit = opts.printings.find((p) => p.scryfall_id === v.id)!;
          update({ options: [hit, ...choice.options.filter((p) => p !== hit)], readFirst: 1, chosen: hit, how: "collector", sure: true, settledId: hit.scryfall_id, raw, reading: false });
          return;
        }
        firstEvidence.current = { seq, ev };
        // Not settled: the best guesses go first in the picker, and the held card is read on.
        const guessed = choosePrinting(opts, raw);
        update({ options: guessed.options, readFirst: guessed.readFirst ?? 0, chosen: null, how: null, sure: false, raw, reading: false });
      } catch (e) {
        update({ options: [], reading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [ocrEngine],
  );

  /** Show a card recognised by its art. `read` is a sharp view of it for the collector line. */
  const showArt = useCallback(
    (r: Recognition, top: ArtMatch, read: { image: RgbaImage; quad: Quad } | null, carry: Pick<Found, "shot" | "guess" | "unlocked" | "rec" | "timing" | "titled" | "leads"> = {}) => {
      stopLook();
      const seq = ++foundSeq.current;
      const timing = newTiming(carry.timing, "sure", top.score);
      const rec = newRecord(carry.rec);
      rec?.setShot(read);
      if (rec) {
        rec.cardName = top.name;
        rec.note("found", { method: "art", art: top.name, set: top.set, number: top.number, score: top.score, matches: [...r.matches, ...(r.pool ?? [])].slice(0, 8).map((m) => ({ name: m.name, set: m.set, number: m.number, score: Math.round(m.score * 1000) / 1000 })) });
      }
      const f: Found = {
        shot: read,
        ...carry,
        rec,
        timing,
        name: top.name,
        method: "art",
        confidence: top.score,
        art: top,
        // Every other match, including the best anywhere when the set lock chose an in-set one.
        others: lookalikes([...r.matches, ...(r.pool ?? [])], top),
        options: null,
        sameArt: true,
        chosen: null,
        how: null,
        picking: false,
        ms: r.timings.totalMs,
      };
      setFound(f);
      setShowAll(false);
      setWrongOpen(false);
      setCopies(1);
      setPhase("found");
      buzz(30);
      if (!identityOnly) void settle(seq, f, { art: top.illustrationId, id: top.id }, read);
    },
    [identityOnly, settle],
  );

  /** Show a card read as text. */
  const showText = useCallback(
    (res: ScanResult, shot: Shot | null = null) => {
      const best = res.candidates[0]!;
      const seq = ++foundSeq.current;
      const timing = newTiming(undefined, "text");
      const rec = newRecord();
      rec?.setShot(shot);
      if (rec) {
        rec.cardName = best.name;
        rec.note("found", { method: best.method, confidence: best.confidence, collector: res.raw.collector, title: res.raw.name });
      }
      // What the text reader read from the collector line: settle() weighs it as evidence (the
      // reader's confidence is about the card, not proof of the printing).
      const f: Found = {
        rec,
        timing,
        shot,
        known: { set: best.set, number: best.number, text: res.raw.collector },
        name: best.name,
        method: best.method,
        confidence: best.confidence,
        others: [],
        options: null,
        sameArt: false,
        chosen: null,
        how: null,
        picking: false,
        raw: `${res.raw.collector}\n${res.raw.name}`,
        ms: res.timings.totalMs,
      };
      setFound(f);
      setShowAll(false);
      setWrongOpen(false);
      setCopies(1);
      setPhase("found");
      buzz(30);
      if (!identityOnly) void settle(seq, f, { name: best.name }, null, f.known);
    },
    [identityOnly, settle],
  );

  /** A text read: lock on the same card twice, or once when it's certain. */
  const handleText = useCallback(
    /** `emptyFrees`: no card detector (text-only mode), so empty reads can end a hold (hold.ts). */
    (res: ScanResult, single: boolean, emptyFrees = false, shot: Shot | null = null) => {
      const best = res.candidates[0];
      const held = blockedName.current;
      // A photo is a deliberate read: no hold.
      if (single) blockedName.current = null;
      else if (held) {
        if (holdRead(held, best, Date.now(), emptyFrees) === "held") {
          if (best?.name === held.name) {
            // The card just filed, still in view: not a new card appearing (the timing record).
            appeared.current = null;
            setStatus(NEXT);
          }
          // Another card seen while held counts toward locking on it once the hold ends.
          else if (best) lastText.current = { card: best, at: Date.now() };
          return false;
        }
        blockedName.current = null;
        if (!blocked.current) setDupe(null);
      }
      if (!best) return false;
      const seen = lastText.current && Date.now() - lastText.current.at < 2500 ? lastText.current.card : undefined;
      const lock = single || best.confidence >= 0.95 || (best.confidence >= 0.6 && sameCard(best, seen));
      lastText.current = { card: best, at: Date.now() };
      if (lock) showText(res, shot);
      else setStatus(READING);
      return lock;
    },
    [showText],
  );

  // Read loop: one frame at a time.
  useEffect(() => {
    if (phase !== "scanning" || !mode || !live || closeup || photoBusy || paused || lockOpen) return;
    let stop = false;
    let failedReads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A camera switch stops this at once (haltReaders).
    const halt = () => {
      stop = true;
      clearTimeout(timer);
    };
    readers.current.add(halt);
    let unknownFrames = 0;
    let textFrame = 0;
    /** Text-only reads in a row that found nothing, for the timing record. */
    let emptyReads = 0;
    /** Frames in a row this art match's title couldn't be read (see UNTITLED_FRAMES). */
    let untitled = 0;
    /** Frames in a row one card has led every other card (fuse.ts, LEAD_FRAMES). */
    const leadRun = new LeadRun();
    setStatus(mode === "art" ? WAITING : "Line the card up with the frame");
    const next = (ms: number) => {
      if (!stop) timer = setTimeout(tick, ms);
    };
    /** The read the gate asked for on this frame, to be answered when the frame is done (gate.ts). */
    let gateRead: GateRead | null = null;
    const tick = async () => {
      const seq = foundSeq.current;
      gateRead = null;
      await frame();
      const asked = gateRead as GateRead | null;
      gateRead = null;
      if (!asked) return;
      // Named (a card was found, or it's the card already held), or not: the gate then asks again,
      // up to its five tries. A frame cut short by a pause doesn't count.
      if (foundSeq.current !== seq || asked.held) gate.named(asked.key, performance.now(), asked.placement);
      else if (stop) gate.dropped(asked.placement);
      else gate.missed(performance.now(), asked.placement);
    };
    const frame = async () => {
      if (stop) return;
      const v = videoRef.current;
      const art = artRef.current;
      if (!v || v.videoWidth === 0 || document.visibilityState !== "visible") {
        // Time away (a hidden tab) isn't time spent finding the card.
        appeared.current = null;
        return next(200);
      }
      canvasRef.current ??= document.createElement("canvas");
      hiCanvasRef.current ??= document.createElement("canvas");
      try {
        if (mode === "art" && art) {
          // When this frame was taken, before it's read: a card first seen on it appeared then
          // (the timing record; Codex review of #171: stamped after recognition, a one-frame
          // settle measured nothing of its own read).
          const frameAt = Date.now();
          if (diagRef.current) frameModel.current = { embed: art.embed, models: modelsNow() };
          // A digital zoom gives the recognizer the middle of the frame, at more of its pixels.
          const box = v.closest(".scan-camera")?.getBoundingClientRect();
          const zone = digitalRegion(v.videoWidth, v.videoHeight, digitalRef.current, box);
          const { image, k } = smallRegion(v, zone, canvasRef.current);
          let toVideo = (q: Quad) => q.map(([x, y]) => [x / k + zone.x, y / k + zone.y]) as Quad;
          // The outline follows the card finder, which answers before the art is matched.
          const outlined = (q: Quad | null) => {
            if (!stop) outlines.see(q ? [toVideo(q)] : [], { w: v.videoWidth, h: v.videoHeight });
          };
          const gated = gateOn();
          let r: Recognition;
          if (gated) {
            // The placement gate (gate.ts): every frame goes to the card finder alone; the art is
            // matched only when the gate says the card has come to rest, on the sharpest frame of
            // its stay, and not again while it lies there.
            const seen = await art.locate(image);
            if (stop) return;
            outlined(seen.quad);
            seeCard(seen.quad ? toVideo(seen.quad) : null, v);
            const at = performance.now();
            const d = gate.observe({ at, cards: seen.quad ? [{ quad: seen.quad, sharpness: seen.sharpness, thumb: seen.thumb, frame: { image: seen.image, toVideo } }] : [] });
            if (d.kind !== "read") {
              // The view has been empty long enough: the card just filed has gone, as without the gate.
              if (d.kind === "none" && d.since == null) {
                blocked.current = null;
                blockedName.current = null;
                filedName.current = null;
                endSeek();
                appeared.current = null;
              }
              if (d.kind === "none") {
                last.current = undefined;
                lastText.current = undefined;
              }
              const holding = !!blocked.current || !!blockedName.current;
              if (!holding) setDupe(null);
              setStatus(gateStatus(d, holding));
              return next(d.kind === "none" ? 60 : GATE_PASS_MS);
            }
            const kept = d.frame!;
            gateRead = { placement: d.placement, key: "", held: false };
            toVideo = kept.toVideo;
            // Diagnostics' timing record: the card appeared when the gate first saw it, not at this read.
            if (diagRef.current && !appeared.current && d.since != null) appeared.current = { at: Date.now() - (at - d.since), frames: 0 };
            r = await art.identify(kept.image, undefined, d.quad);
            if (stop) return;
          } else {
            r = await art.identify(image, outlined);
            if (stop) return;
            outlined(r.quad);
            seeCard(r.quad ? toVideo(r.quad) : null, v);
          }
          // What this frame knew is for a card found from this frame only.
          scanCtx.current = null;
          // Locked to sets: go on the best match among their art while it's about as good as the
          // best anywhere; otherwise on the best anywhere, which settling then shows as outside.
          const locked = lockRef.current;
          const judged = locked && r.quad ? judgeLocked(r.matches, r.pool, locked.inSets, ART_UNKNOWN) : null;
          const top = judged && judged.kind !== "none" ? judged.match : r.matches[0];
          // The card just added stays held until it has clearly gone (hold.ts): one missed
          // detection while it's still in view, or on its way out, would add it again.
          // The held card still counts as seen when any match names it (with the set lock, the
          // top match can flip between an in-set and an outside one while the card sits there).
          const heldIndex = blocked.current?.index;
          const stillHeld = r.quad && heldIndex != null ? [...r.matches, ...(r.pool ?? [])].find((m) => m.index === heldIndex && m.score >= ART_UNKNOWN) : undefined;
          if (blocked.current && artHoldFrame(blocked.current, r.quad ? (stillHeld ?? top ?? null) : null, ART_UNKNOWN, LOCK_TWICE) === "free") blocked.current = null;
          if (gateRead && top) gateRead.key = top.name;
          if (!r.quad || !top) {
            if (++noCard.current >= AWAY_FRAMES) {
              blockedName.current = null;
              filedName.current = null;
              endSeek();
              appeared.current = null;
            }
            if (!blocked.current && !blockedName.current) setDupe(null);
            last.current = undefined;
            lastText.current = undefined;
            unknownFrames = 0;
            leadRun.step(null);
            setStatus(blocked.current || blockedName.current ? NEXT : WAITING);
            return next(60);
          }
          noCard.current = 0;
          if (!blocked.current && !blockedName.current) setDupe(null);
          if (blocked.current) {
            // With the gate: the card just added, seen again, is latched; a read that didn't show
            // it (a weak match) is a miss, tried again, and the hold ends by its own rule (hold.ts).
            if (gateRead) gateRead.held = !!stillHeld;
            setStatus(NEXT);
            return next(60);
          }
          const prev = last.current && last.current.index === top.index && Date.now() - last.current.at < 1500;
          last.current = { index: top.index, at: Date.now() };
          const ranked = [...r.matches, ...(r.pool ?? [])].sort((a, b) => b.score - a.score);
          // Locked to sets the art index only partly knows (a set newer than the bundle), and this
          // match isn't one of theirs: its art says nothing about which card this is.
          const artUnknown = !!locked && judged?.kind !== "in-set" && poolShare.current < KNOWN_ART;
          const side = identityOnly ? IDENTITY_SIDE : undefined;
          // The view of the card kept with it: none where only the card matters and photos aren't saved.
          const keepsView = !(identityOnly && !savingPhotos());
          const read = (at: { image: RgbaImage; quad: Quad }) => (keepsView ? at : null);
          // A card just filed by its name stays held (hold.ts): its art mustn't file it again, by
          // art, by a title read or by the two-frame fallback below.
          const heldName = blockedName.current?.name;
          const isHeld = (name: string) => !!heldName && sameCardName(name, heldName);
          // (With the gate: also a card named again within 3 s that never left the view, gate.ts.)
          if (isHeld(top.name) || (gated && gate.suppresses(top.name, performance.now()))) {
            if (gateRead) gateRead.held = true;
            leadRun.step(null);
            setStatus(NEXT);
            return next(60);
          }
          // Face down (cardBack.ts), and the art doesn't know it either. A card the art knows fairly
          // well is never called a back. Its title and text are still read below, as for any card
          // the art doesn't know (a front that only looks like a back has a name to read); what
          // changes is what's said meanwhile, and that no close-up is asked of a back.
          const faceDown = saysCardBack(r.back, top.score, LOCK_TWICE);
          // Diagnostics' timing record: the card in view appeared on this frame, or one more frame
          // read (and another card taking its place starts it again).
          if (diagRef.current && !faceDown) appeared.current = stepAppeared(appeared.current, top.score >= ART_UNKNOWN ? top.name : null, frameAt, sameCardName);
          // Art that leads every other card (fuse.ts: at least LEAD_FLOOR, LEAD_MARGIN ahead) settles
          // which card without the title, like a sure match, once the same card has led
          // LEAD_FRAMES frames in a row (Bryan, 18 Nov 2026: stuck about half the time; right cards
          // score a median 0.78 on real photos). Never when its art is unknown, or locked to sets
          // whose art the index mostly lacks, nor while a card filed by its name is held. The
          // search lists its best 5 artworks: anything unlisted scores at most the 5th.
          const unlisted = r.matches[r.matches.length - 1]?.score;
          const lead = artLead(ranked, top, unlisted);
          const leadOn = leadRule();
          const leading = leadOn && !artUnknown && leadCounts({ locked: !!locked, share: leadShare() }) && !blockedName.current && leads(top.score, lead);
          // (With the gate too: a lead settles on its second read in a row, 50 ms after the first.)
          const leadFrames = leadRun.step(leading ? top.name : null);
          // A strong match decides by art, unless another card scores close to it. Otherwise the
          // title is read first (Bryan, 15 Nov 2026: no Star Trek card scanned; their art isn't in
          // the bundle, so lookalikes scored 0.5 to 0.8 and the scanner named them, or waited on
          // "Hold still" for ever).
          // For a diagnostic record of the card found next (diagnostics.ts): what the art said.
          const artNote = {
            art: ranked.slice(0, 5).map((m) => ({ name: m.name, set: m.set, number: m.number, score: Math.round(m.score * 1000) / 1000 })),
            // The match the lead is for (the in-set one with the set lock).
            top: Math.round(top.score * 1000) / 1000,
            lead: Math.round(lead * 1000) / 1000,
            cardPx: Math.round(cardHeight(toVideo(r.quad)) * camSrc().fullScale()),
          };
          // Which rule settled the card, for its record (diagnostics.ts).
          const lockBy = (how: LockRule) => {
            scanCtx.current = { ...(scanCtx.current ?? artNote), lock: how };
          };
          // Only the card matters (a deck scan or check): art that looks like another card would
          // wait for a tap, so read the title too, and a clear one lets Keep going count it. Art
          // that leads has no lookalike close enough to need it.
          const rivalled = identityOnly && !leading && lookalikes(ranked, top).length > 0;
          const readFirst = readTitleFirst({ score: top.score, lockOnce: LOCK_ONCE, locked: !!locked, inSet: judged?.kind === "in-set", share: poolShare.current, leads: leading }) || needsTitle(ranked, unlisted, { lead: leadOn });
          if (!readFirst && !rivalled) {
            unknownFrames = 0;
            const by = artDecides(top.score, leadFrames);
            // It leads on its first frame: one more, with no title read between.
            if (!by) {
              setStatus(READING);
              seekFrame({ art: artNote.art.slice(0, 3), lead: artNote.lead, cardPx: artNote.cardPx });
              return next(30);
            }
            const view = keepsView ? await camSrc().around(toVideo(r.quad), hiCanvasRef.current, side) : null;
            if (stop) return;
            lockBy(by);
            showArt(r, top, view, { leads: leading });
            return;
          }
          // Not while a card filed by its name is held: it may be that card, still in view.
          if (!blockedName.current) setStatus(faceDown ? CARD_BACK : READING);
          // (A back lying in view isn't a card the scanner is slow to find.)
          const seen = blockedName.current || faceDown ? null : seekFrame({ art: artNote.art.slice(0, 3), lead: artNote.lead, cardPx: artNote.cardPx });
          // A match that is at least fair is read on every frame; a card the art index plainly
          // doesn't know (a battle, a weak match) after a few frames, as before.
          if (top.score >= ART_UNKNOWN || artUnknown || gated || ++unknownFrames >= 3) {
            unknownFrames = 0;
            const full = await textReader();
            if (stop) return;
            // Locked: read the name against the locked sets' cards only (new cards the art index
            // doesn't know yet are usually in the set being scanned).
            const reader = lockRef.current?.names ? { ...full, names: lockRef.current.names } : full;
            const quad = toVideo(r.quad);
            const hi = await camSrc().around(quad, hiCanvasRef.current, side);
            if (stop) return;
            // The card from title and art together (fuse.ts): a clear title settles the card when
            // the art has it among its matches, and overrules the art when it doesn't. Matches from
            // art the index doesn't know for the locked sets count for nothing.
            const titles = await readTitles(hi.image, hi.quad, reader.ocr);
            if (stop) return;
            const title = titleRead(titles, reader);
            // A fairly clear title agreeing with the art only where just the card matters (in the
            // collection a lookalike with one printing would be filed by itself), and not while a
            // card filed by its name is held (one read mustn't file a lookalike of it).
            const fused = fuseTitle(artUnknown ? [] : ranked, title, { agree: identityOnly && !blockedName.current });
            // The title overruled the art: it named a card other than the art's best match.
            scanCtx.current = { ...artNote, titles, title, fused: fused.kind, artUnknown, overruled: fused.kind === "title" && !!top && !sameCardName(top.name, fused.name) };
            if (seen) Object.assign(seen, { titles, title, fused: fused.kind });
            // The card just filed, by its art or its title: still held. Not a new card appearing.
            if (fusedHeld(fused, heldName)) {
              if (gateRead) gateRead.held = true;
              appeared.current = null;
              setStatus(NEXT);
              return next(60);
            }
            if (fused.kind === "art") {
              lockBy("title");
              showArt(r, fused.match, read(hi), { titled: true });
              return;
            }
            if (fused.kind === "title") {
              lockBy("title");
              fromName(fused.name, "name", { shot: hi });
              return;
            }
            // Art sure on its own, read only for its lookalikes: no clear title leaves it as it
            // was, found by its art and waiting for a tap.
            if (rivalled && !readFirst) {
              lockBy("sure");
              showArt(r, top, read(hi));
              return;
            }
            // No clear title upright: the whole card's text, one orientation per attempt (sideways
            // battles, upside down), so the camera stays responsive.
            const res = await readAt(hi.image, hi.quad, reader, [quarterTurns(hi.quad)[textFrame++ % 3]!]);
            if (stop) return;
            const said = res.candidates[0];
            if (seen) seen.text = said ? { name: said.name, confidence: Math.round(said.confidence * 1000) / 1000 } : null;
            // The card's text names one of the art's matches, fairly surely: the two agree. Only where
            // just the card matters, and not while a card filed by its name is held (as above).
            const agreed = identityOnly && said && said.confidence >= TEXT_VETO && !artUnknown && !blockedName.current ? artHas(ranked, said.name) : undefined;
            if (agreed) {
              lockBy("text");
              showArt(r, agreed, read(hi), { titled: true });
              return;
            }
            if (handleText(res, false, false, hi)) return;
            // Face down, and nothing on it read as a card: that's all there is to say.
            if (faceDown) {
              // (With the gate: read once, and said for as long as it lies there.)
              if (gateRead) Object.assign(gateRead, { key: BACK_KEY, held: true });
              appeared.current = null;
              // (Not over "Ready for the next card" while a card filed by its name is held.)
              if (!blockedName.current) setStatus(CARD_BACK);
              return next(60);
            }
            // Where only the card matters a weak read is noise; elsewhere any read still holds the
            // art back, as before (the collection files a printing the art settles by itself).
            const vetoed = !!said && (!identityOnly || said.confidence >= TEXT_VETO);
            // No title at all. Art sure on its own (0.82) still decides. Fairly sure on two frames
            // (0.62) only once the title has had its chance (Bryan's phone, 15 Nov 2026: right cards
            // scored 0.64 to 0.70, and a foil Westvale Abbey locked as Wei Night Raiders at 0.658 on
            // two frames with its title plainly readable): UNTITLED_FRAMES frames of this match whose
            // title couldn't be read. Never when its art is unknown, nor while a card filed by its
            // name is held.
            untitled = prev ? untitled + 1 : 1;
            if (!prev) failedReads = 0;
            const artLocks = top.score >= LOCK_ONCE || (top.score >= LOCK_TWICE && prev && untitled >= UNTITLED_FRAMES);
            if (!stop && artLocks && !artUnknown && !vetoed && !blockedName.current) {
              lockBy(top.score >= LOCK_ONCE ? "sure" : "twice");
              showArt(r, top, read(hi));
              return;
            }
            // Still nothing: ask for a close-up of the name.
            // (Not while the card just added is held: that would read it again.)
            // Where only the card matters, a fair match (LOCK_TWICE) gets its UNTITLED_FRAMES first.
            const artWaits = identityOnly && top.score >= LOCK_TWICE && !artUnknown && untitled < UNTITLED_FRAMES;
            // (With the gate there's no close-up asked here: five tries, then "No match, move the card".)
            if (!stop && closeups && !gated && !vetoed && !blockedName.current && ++failedReads >= TITLE_AFTER && !artWaits) {
              lookGoesOn.current = true;
              setCloseup("title");
              return;
            }
          }
          return next(30);
        }
        // Text only: read the part of the frame around the on-screen guide. What a frame knew is
        // for a card found from that frame only, as above.
        scanCtx.current = null;
        const g = guideRef.current;
        const reader = await textReader();
        if (stop || !g) return next(200);
        const { sx, sy, sw, sh, gx, gy, gw, gh } = boxInVideo(v, g, MARGIN);
        // From the camera's full frame, never enlarged (the app's own camera hands `v` over smaller).
        const k = Math.min(camSrc().fullScale(), MAX_SIDE / Math.max(sw, sh));
        const image = await camSrc().region({ x: sx, y: sy, w: sw, h: sh }, sw * k, sh * k, canvasRef.current);
        if (stop) return;
        const upright: Quad = rectQuad((gx - sx) * k, (gy - sy) * k, gw * k, gh * k);
        // Alternate upright and upside-down reads across frames rather than both in one frame.
        const flip = textFrame++ % 2 === 1;
        const guide: Quad = flip ? [upright[2], upright[3], upright[0], upright[1]] : upright;
        const frameAt = Date.now();
        if (diagRef.current) frameModel.current = { embed: NO_ART_MODEL, models: modelsNow() };
        const res = await scanFrame(image, { ...reader, guide, tryUpsideDown: false });
        // Diagnostics' timing record: with no detector, the card appeared when text was first read
        // (not the card just filed, still held by its name), and has gone after AWAY_FRAMES reads
        // of nothing.
        if (diagRef.current) {
          const said = res.candidates[0];
          emptyReads = said ? 0 : emptyReads + 1;
          const held = !!said && !!blockedName.current && sameCardName(said.name, blockedName.current.name);
          if (held || emptyReads >= AWAY_FRAMES) appeared.current = null;
          else if (said) appeared.current = stepAppeared(appeared.current, said.confidence >= TEXT_VETO ? said.name : null, frameAt, sameCardName);
        }
        if (!stop && handleText(res, false, true, { image, quad: res.quad })) return;
        if (!stop && !res.candidates[0]) setStatus("Line the card up with the frame");
        next(250);
      } catch (err) {
        if (stop) return;
        setStatus(err instanceof Error ? err.message : String(err));
        next(500);
      }
    };
    void tick();
    return () => {
      readers.current.delete(halt);
      stop = true;
      clearTimeout(timer);
      // The look ends with the loop (a pause, the set picker), or is the found card's. Into the
      // title close-up it goes on: the card it names gets the record, or the next loop ends it.
      if (lookGoesOn.current) lookGoesOn.current = false;
      else {
        endSeek();
        // A pause isn't time spent finding the card: its time starts again with the loop.
        appeared.current = null;
      }
    };
  }, [phase, mode, live, closeup, photoBusy, paused, lockOpen, identityOnly, closeups, showArt, handleText, textReader]);

  const fromPhoto = async (file: File) => {
    setStatus("Reading the photo");
    setPhotoBusy(true);
    // Anything shown meanwhile (a typed name, Not this) makes this photo's answer stale.
    const start = foundSeq.current;
    const current = () => foundSeq.current === start && alive.current;
    // Released in `finally` whatever happens (closing twice does nothing).
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(file);
      canvasRef.current ??= document.createElement("canvas");
      hiCanvasRef.current ??= document.createElement("canvas");
      const art = artRef.current;
      // The models this photo is read with, for its timing record.
      if (diagRef.current) frameModel.current = { embed: art?.embed ?? NO_ART_MODEL, models: modelsNow() };
      if (art) {
        // A photo is another view: the camera's frames kept for the look aren't of it.
        art.reset({ frames: true });
        const { image, k } = small(bmp, bmp.width, bmp.height, canvasRef.current);
        const r = await art.identify(image);
        const locked = lockRef.current;
        const judged = locked && r.quad ? judgeLocked(r.matches, r.pool, locked.inSets, ART_UNKNOWN) : null;
        const top = judged && judged.kind !== "none" ? judged.match : r.matches[0];
        // The same decision as the camera: a sure, unrivalled art match decides; otherwise the
        // title is read and settles or overrules the art (fuse.ts). A lone fair match (0.62) used
        // to decide here, so a foil Westvale Abbey photo was Wei Night Raiders at 0.658 (review
        // of #138). With a set lock whose art is mostly unknown, only its own matches count.
        if (r.quad && top && top.score >= LOCK_TWICE) {
          const artUnknown = !!locked && judged?.kind !== "in-set" && poolShare.current < KNOWN_ART;
          const ranked = artUnknown ? [] : [...r.matches, ...(r.pool ?? [])].sort((a, b) => b.score - a.score);
          const hi = around(bmp, bmp.width, bmp.height, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
          const read = identityOnly && !savingPhotos() ? null : hi;
          // Art that leads every other card (fuse.ts) decides too, on the photo's one frame.
          const unlisted = r.matches[r.matches.length - 1]?.score;
          const lead = artLead(ranked, top, unlisted);
          const leadOn = leadRule();
          const leading = leadOn && !artUnknown && leadCounts({ locked: !!locked, share: leadShare() }) && leads(top.score, lead);
          const photoCtx = (lock: LockRule) => ({ photo: true, top: Math.round(top.score * 1000) / 1000, lead: Math.round(lead * 1000) / 1000, lock });
          if (!artUnknown && (top.score >= LOCK_ONCE || leading) && !needsTitle(ranked, unlisted, { lead: leadOn })) {
            bmp.close();
            if (current()) {
              scanCtx.current = photoCtx(artDecides(top.score, 1, 1) ?? "sure");
              showArt(r, top, read, { leads: leading });
            }
            return;
          }
          const reader = await textReader();
          const fused = fuseTitle(ranked, titleRead(await readTitles(hi.image, hi.quad, reader.ocr), reader));
          if (fused.kind === "art") {
            bmp.close();
            if (current()) {
              scanCtx.current = photoCtx("title");
              showArt(r, fused.match, read);
            }
            return;
          }
          if (fused.kind === "title") {
            bmp.close();
            if (current()) {
              scanCtx.current = photoCtx("title");
              fromName(fused.name, "name", { shot: hi });
            }
            return;
          }
          // No clear title: read the rest of the card's text below, as for unknown art.
        }
        // A card whose art isn't known: read its text where the recognizer found it.
        if (r.quad) {
          const reader = await textReader();
          const hi = around(bmp, bmp.width, bmp.height, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
          const res = await readAt(hi.image, hi.quad, reader);
          if ((res.candidates[0]?.confidence ?? 0) >= SURE) {
            bmp.close();
            if (current()) {
              scanCtx.current = { photo: true, lock: "text" };
              if (!handleText(res, true, false, hi)) scanCtx.current = null;
            }
            return;
          }
        }
      }
      const reader = await textReader();
      const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const image = draw(bmp, 0, 0, bmp.width, bmp.height, bmp.width * k, bmp.height * k, canvasRef.current);
      bmp.close();
      // A photo cropped to the card (a scan, a screenshot) is the card: try that first, as is.
      // Otherwise assume the card is centred; try a few sizes and let the edge finder correct each.
      let res: ScanResult | null = null;
      const cropped = Math.abs(image.height / image.width - CARD_ASPECT) < 0.06;
      const tries = [...(cropped ? [{ fill: 1, refine: false }] : []), { fill: 0.9, refine: true }, { fill: 0.78, refine: true }, { fill: 0.65, refine: true }];
      for (const { fill, refine } of tries) {
        const h = Math.min(image.height * fill, image.width * fill * CARD_ASPECT);
        const w = h / CARD_ASPECT;
        const r = await scanFrame(image, { ...reader, guide: rectQuad((image.width - w) / 2, (image.height - h) / 2, w, h), refine });
        if (!res || (r.candidates[0]?.confidence ?? 0) > (res.candidates[0]?.confidence ?? 0)) res = r;
        if ((res.candidates[0]?.confidence ?? 0) >= SURE) break;
      }
      if (!current()) return;
      scanCtx.current = { photo: true, lock: "text" };
      if (!res || !handleText(res, true, false, { image, quad: res.quad })) {
        // Nothing found: the photo's note mustn't label the next card.
        scanCtx.current = null;
        setStatus("Couldn't read that photo. Fill the photo with the card, or type the name.");
      }
    } catch (err) {
      if (current()) setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      bmp?.close();
      setPhotoBusy(false);
    }
  };

  /** A card typed by name: straight to its printings. */
  const fromName = (name: string, how: "typed" | "name" = "typed", carry: Pick<Found, "shot" | "guess" | "rec" | "timing"> = {}) => {
    stopLook();
    const seq = ++foundSeq.current;
    // A title read names the card ("title", from the frame), or the title close-up does.
    const timing = newTiming(carry.timing, how === "typed" ? "typed" : "closeup");
    const rec = newRecord(carry.rec);
    rec?.setShot(carry.shot);
    if (rec) {
      rec.cardName = name;
      rec.note(carry.rec ? "renamed" : "found", { method: how === "typed" ? "typed" : "title", name });
    }
    const f: Found = { name, method: "name", confidence: how === "typed" ? 1 : 0.9, others: [], options: null, sameArt: false, chosen: null, how: null, picking: false, ...carry, rec, timing };
    setFound(f);
    setShowAll(false);
    setWrongOpen(false);
    setCopies(1);
    setPhase("found");
    if (!identityOnly) void settle(seq, f, { name });
  };

  /** Back to scanning. The card just shown isn't found again until it leaves the view. */
  const again = (held: Found | null = found) => {
    // A card let go without filing (Skip, Scan next): its record ends here, unless already sent.
    endRecord("skipped", foundRef.current);
    stopLook();
    foundSeq.current += 1;
    setReadProgress(null);
    setWrongOpen(false);
    setDupe(null);
    blocked.current = held?.art ? { index: held.art.index, away: 0 } : null;
    // Nothing held (Scan it again): the gate reads the card lying there once more.
    if (!held) gate.unlatch();
    noCard.current = 0;
    blockedName.current = held && !held.art ? hold(held.name, Date.now()) : null;
    last.current = undefined;
    lastText.current = undefined;
    setFound(null);
    outlines.clear();
    setCloseup(null);
    artRef.current?.reset();
    setStatus(mode === "text" ? "Line the card up with the frame" : WAITING);
    setPhase(videoRef.current?.srcObject ? "scanning" : "no-camera");
  };

  /** Switch to another card the art might be. */
  const pickOther = (m: ArtMatch) => {
    if (!found?.art) return;
    showArt({ quad: null, upright: 1, matches: [m, found.art, ...found.others.filter((o) => o !== m)], timings: { detectMs: 0, embedMs: 0, totalMs: found.ms ?? 0 } }, m, identityOnly ? null : (found.shot ?? null), {
      shot: found.shot,
      guess: found.guess ?? guessOf(found),
      unlocked: found.unlocked,
      rec: withReason(found.rec, "wrong-card"),
      timing: found.timing?.cardCorrected(),
    });
  };

  /** Keep the photo of this card, if Save scan photos is on, with what the person said it was. */
  const keep = (f: Found, kind: SampleLabel["kind"], label?: ScanCandidate) => {
    if (!f.shot) return;
    void keepSample(f.shot, {
      ...(f.guess ?? guessOf(f)),
      kind: sampleKind(f, kind, label),
      label_name: label?.name,
      label_scryfall_id: label?.scryfall_id,
      camera: camera ?? undefined,
      embed: artRef.current?.embed ?? NO_ART_MODEL,
      models: modelsNow(),
    });
  };

  /** Wrong card, with nothing more said: keep the photo as a miss and scan again. */
  const wrongAgain = () => {
    if (found) keep(found, "wrong");
    found?.rec?.reasons.add("wrong-card");
    endRecord("wrong");
    again();
  };

  /** Not in the locked sets, but the person says it's this card from another set. */
  const fromAnotherSet = () => {
    if (!found) return;
    const f: Found = { ...found, outside: false, unlocked: true, options: null };
    const seq = ++foundSeq.current;
    setFound(f);
    void settle(seq, f, f.art ? { art: f.art.illustrationId, id: f.art.id } : { name: f.name }, f.method === "art" ? (f.shot ?? null) : null, f.known);
  };

  // Several printings fit and the first read of the collector line didn't settle it: keep reading
  // the line from whole-card frames while the card is held (below), whether it was found by its
  // art, read from its text or typed by name (Bryan, 15 Nov 2026), and only then, with close-ups
  // on, ask for the close-up box. Without close-ups, the picker asks.
  const unsettled = live && phase === "found" && !identityOnly && !!found?.options && found.options.length > 1 && !found.chosen && !found.reading && !found.outside;
  // Not while "Wrong card" is open: the person is saying it isn't this card.
  const readWhileHeld = unsettled && !closeup && !paused && !wrongOpen;
  /** The card being read. A new card, any change to it, or a retry (holdRun) starts a fresh attempt. */
  const heldFound = readWhileHeld ? found : null;
  // Turning close-ups off ends one in progress.
  useEffect(() => {
    if (!closeups) setCloseup(null);
  }, [closeups]);
  useEffect(() => {
    if (phase !== "found" && closeup === "collector") setCloseup(null);
    if (phase === "found" && closeup === "title") setCloseup(null);
  }, [phase, closeup]);
  // A new card hasn't been given up on.
  useEffect(() => {
    if (phase !== "found") setGaveUp(false);
  }, [phase]);

  // Hold and read (Bryan, 15 Nov 2026): find the card again in each new frame and read its
  // collector line at the camera's full resolution, until a read proves the printing or AGREE
  // frames agree (heldRead.ts), within time budgets. The person needn't move the card. A card
  // found by its art is found again by its art: it must stay the best match in view. Any other
  // card is found by where it is: the detector's outline (the card's, even when its art isn't
  // known), which may drift but not jump (heldCard.ts); with no recognizer, the on-screen guide.
  // Only this card's printings are read against, so another card can't settle it.
  useEffect(() => {
    const start = heldFound;
    if (!start?.options) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A camera switch stops this at once (haltReaders).
    const halt = () => {
      stop = true;
      clearTimeout(timer);
    };
    readers.current.add(halt);
    const clock = () => performance.now();
    const held = new HeldRead(closeups, clock());
    // The first read's evidence carries on into the first attempt; a retry starts afresh.
    const first = firstEvidence.current;
    firstEvidence.current = null;
    const ev = first && first.seq === foundSeq.current ? first.ev : new Evidence(start.options, start.lockedOut);
    noteReads(foundSeq.current, ev);
    setReadProgress(null);
    const heldArt = start.art?.index ?? null;
    /** Where the card was last seen, in video pixels (not by art). */
    let lastQuad: Quad | null = null;
    setHolding(true);
    setGaveUp(false);
    const next = (ms: number) => {
      if (!stop) timer = setTimeout(tick, ms);
    };
    const done = (gaveUpNow = false) => {
      stop = true;
      setHolding(false);
      if (gaveUpNow) setGaveUp(true);
    };
    const settleOn = (c: Choice, text: string) => {
      const chosenNow = c.chosen!;
      start.rec?.attempt({ ...held.summary(), ended: "settled", chosen: chosenNow.scryfall_id });
      done();
      setFound((cur) => (cur && cur === start ? { ...cur, chosen: chosenNow, how: "collector", sure: true, settledId: chosenNow.scryfall_id, options: c.options, readFirst: 1, raw: text } : cur));
      buzz(30);
    };
    /** The card's quad in video pixels this frame, or null when it isn't seen (or another card is). */
    /**
     * The card in a camera frame (`video`) or a still photo of it: its quad in that image's
     * pixels, or null when it isn't seen there (or another card is).
     */
    const locate = async (src: CanvasImageSource, w: number, h: number, video: HTMLVideoElement | null): Promise<Quad | null> => {
      const art = artRef.current;
      canvasRef.current ??= document.createElement("canvas");
      if (art) {
        const box = video?.closest(".scan-camera")?.getBoundingClientRect();
        const zone = video ? digitalRegion(w, h, digitalRef.current, box) : { x: 0, y: 0, w, h };
        const { image, k } = smallRegion(src, zone, canvasRef.current);
        const r = await art.identify(image);
        if (!r.quad) return null;
        const quad = r.quad.map(([x, y]) => [x / k + zone.x, y / k + zone.y]) as Quad;
        const all = [...r.matches, ...(r.pool ?? [])];
        if (heldArt != null) {
          // The held card must still be the best match in view (or as good as it): another card that
          // only looks a bit like it would have its collector line read against this card's printings.
          const heldScore = Math.max(-1, ...all.filter((m) => m.index === heldArt).map((m) => m.score));
          const bestScore = Math.max(-1, ...all.map((m) => m.score));
          return heldScore >= ART_UNKNOWN && heldScore >= bestScore - (lockRef.current ? POOL_MARGIN : SAME_CARD_MARGIN) ? quad : null;
        }
        // Not known by its art: a card clearly recognised as another card isn't this one.
        const top = all.reduce<ArtMatch | null>((b, m) => (!b || m.score > b.score ? m : b), null);
        if (top && top.score >= LOCK_ONCE && top.name !== start.name && !start.name.split(" // ").includes(top.name)) return null;
        const picked = pickHeldQuad([quad], w, h);
        // From frame to frame it may drift, not jump (a still is in its own pixels).
        if (!picked || (video && lastQuad && !sameHeldCard(lastQuad, picked))) return null;
        return picked;
      }
      // No recognizer: the card is where the on-screen guide is, as when reading text.
      const g = guideRef.current;
      if (!g || !video) return null;
      const { gx, gy, gw, gh } = boxInVideo(video, g, 0);
      return rectQuad(gx, gy, gw, gh);
    };
    /** Read one image of the card into the evidence; true when that settled it. */
    const readInto = async (src: CanvasImageSource, w: number, h: number, quad: Quad, f: Found, source: "hold" | "still" = "hold"): Promise<"settled" | "read" | "blurred"> => {
      // A still is cut from itself; a camera frame, by the camera (at its full resolution).
      const read = source === "still" ? around(src, w, h, quad, hiCanvasRef.current!) : await camSrc().around(quad, hiCanvasRef.current!);
      if (stop) return "read";
      setLiveShot(read);
      f.rec?.latestShot(read);
      const ocr = await ocrEngine();
      // A blurred or washed-out strip is skipped before the reader sees it (quality.ts).
      let sharp = true;
      let quality: StripQuality | null = null;
      const reads: string[] = [];
      for await (const text of readCollectorLines(read.image, read.quad, ocr, { gate: (q) => ((quality = q), (sharp = worthReading(q))) })) {
        if (stop) return "read";
        reads.push(text);
      }
      const note = { source, ...qualityNote(quality), cardPx: Math.round(cardHeight(quad) * (source === "still" ? 1 : camSrc().fullScale())), zoom: camRef.current.zoom };
      if (!sharp) {
        f.rec?.frame({ ...note, reads: [], skipped: true });
        return "blurred";
      }
      // Finished after the attempt ended (a still, or a camera switch): it counts for nothing.
      if (stop) return "read";
      // Every read adds to the evidence (evidence.ts): settled on weight, not on a run.
      ev.add(reads);
      const weighed = ev.verdict();
      f.rec?.frame({ ...note, reads, verdict: weighed });
      if (weighed.kind === "settled") {
        const c = choosePrinting({ sameArt: f.sameArt, printings: f.options! }, reads.join("\n"));
        const hit = f.options!.find((p) => p.scryfall_id === weighed.id)!;
        settleOn({ chosen: hit, how: "collector", options: [hit, ...c.options.filter((p) => p !== hit)], certain: true }, reads.join("\n"));
        return "settled";
      }
      setReadProgress(progressLine(weighed, f.options!.length));
      return "read";
    };
    /**
     * One still photo when the reads stall (the scanner consult): a camera still can be sharper
     * and larger than a video frame. Only where the browser has ImageCapture.takePhoto (Chrome on
     * Android; the app's web view may not [inferred]), only with the art recognizer to find the
     * card in it, and once per attempt.
     */
    let stillTaken = false;
    const tryStill = async (f: Found): Promise<boolean> => {
      // The app's own camera has no still to take (its reads are already cut from the full frame).
      if (stillTaken || !artRef.current || nativeCam.current) return false;
      const track = cam.track();
      const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
      if (!IC || !track) return false;
      stillTaken = true;
      let bmp: ImageBitmap | null = null;
      try {
        // A camera that never answers mustn't hold anything up (review of #145).
        bmp = await createImageBitmap(await withTimeout(new IC(track).takePhoto(), STILL_TIMEOUT_MS));
        if (stop) return false;
        const quad = await locate(bmp, bmp.width, bmp.height, null);
        if (!quad || stop) return false;
        return (await readInto(bmp, bmp.width, bmp.height, quad, f, "still")) === "settled";
      } catch (e) {
        console.info("No still from the camera", e);
        return false;
      } finally {
        bmp?.close();
      }
    };
    let focused = false;
    const holdMotion = new Motion();
    /** What every verdict does, from a frame, a skipped frame or a miss alike. */
    const act = (verdict: HeldVerdict, wait: number) => {
      switch (verdict) {
        case "closeup":
          // Diagnostics: the close-up took over from reading the whole card.
          start.rec?.reasons.add("closeup");
          start.rec?.attempt(held.summary());
          done();
          setCloseup("collector");
          return;
        case "stop":
          start.rec?.reasons.add("hold-gave-up");
          start.rec?.attempt(held.summary());
          return done(true);
        default:
          return next(wait);
      }
    };
    const tick = async () => {
      if (stop) return;
      // The outer cap, whatever happened on the frames (HeldRead.capped).
      const capped = held.capped(clock());
      if (capped) return act(capped, 0);
      const v = videoRef.current;
      const f = foundRef.current;
      if (f !== start || !f?.options) return done();
      if (!v || v.videoWidth === 0 || document.visibilityState !== "visible") return next(200);
      try {
        hiCanvasRef.current ??= document.createElement("canvas");
        const quad = await locate(v, v.videoWidth, v.videoHeight, v);
        if (stop) return;
        seeCard(quad, v);
        let verdict: HeldVerdict;
        if (!quad) verdict = held.missed(clock());
        else {
          lastQuad = quad;
          // Focus on the collector corner, once, where the browser lets it point focus.
          if (!focused) {
            focused = true;
            const [x, y] = applyH(squareToQuad(quad), 0.25, 0.95);
            cam.focusAt(x / v.videoWidth, y / v.videoHeight);
          }
          // With the placement gate, the collector line is read only while the card is at rest
          // (gate.ts, `Motion`): a frame of a moving card counts as skipped, like a blurred one.
          const speed = gateOn() ? holdMotion.speed(performance.now(), quad) : 0;
          const got = speed == null || speed > GATE_DEFAULTS.stillSpeed ? "blurred" : await readInto(v, v.videoWidth, v.videoHeight, quad, f);
          // (A read that took a while leaves nothing recent to measure from: `Motion` then goes by
          // whether the card is where it was.)
          if (got === "settled" || stop) return;
          verdict = got === "blurred" ? held.skipped(clock()) : held.frame(clock());
          // Stalled (several frames read, not settled): one still photo, read the same way, alongside
          // the frames (never holding them up); a still that settles it ends the attempt.
          if (verdict === "again" && held.summary().frames >= STILL_AFTER) void tryStill(f);
        }
        return act(verdict, 60);
      } catch (e) {
        // A failed read: a few in a row (or the card gone long enough) end the attempt, and the
        // picker and Keep reading take over.
        console.warn("Reading the held card failed", e);
        return act(held.missed(clock(), true), 500);
      }
    };
    void tick();
    return () => {
      readers.current.delete(halt);
      stop = true;
      clearTimeout(timer);
      setHolding(false);
      setLiveShot(null);
    };
    // buzz and the setters are stable for this purpose; the loop reads the card through foundRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldFound, holdRun, closeups, ocrEngine]);

  // The close-up loop: read the box as text until it settles the printing or the name.
  useEffect(() => {
    if (!closeup || paused || !live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A camera switch stops this at once (haltReaders).
    const halt = () => {
      stop = true;
      clearTimeout(timer);
    };
    readers.current.add(halt);
    let previous: string | null = null;
    /** The close-up's own evidence for the printing (evidence.ts), from its first frame. */
    let closeEv: { options: Printing[]; ev: Evidence } | null = null;
    setCloseupRead("");
    setReadProgress(null);
    const next = (ms: number) => {
      if (!stop) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      const v = videoRef.current;
      const box = closeRef.current;
      if (stop) return;
      if (!v || !box || v.videoWidth === 0 || document.visibilityState !== "visible") return next(200);
      try {
        hiCanvasRef.current ??= document.createElement("canvas");
        const { sx, sy, sw, sh } = boxInVideo(v, box);
        if (sw < 8 || sh < 8) return next(200);
        const h = CLOSEUP_HEIGHT[closeup];
        const image = await camSrc().region({ x: sx, y: sy, w: sw, h: sh }, (sw * h) / sh, h, hiCanvasRef.current);
        if (stop) return;
        const text = await readCloseup(image, closeup, await ocrEngine());
        if (stop) return;
        setCloseupRead(text.replace(/\s+/g, " ").trim());
        if (closeup === "collector") {
          const f = foundRef.current;
          if (!f?.options) return next(200);
          // Weighed as the held card's reads are: set code and number adding up across frames, and
          // never proof against a twin (The List, a promo suffix).
          if (closeEv?.options !== f.options) closeEv = { options: f.options, ev: new Evidence(f.options, f.lockedOut) };
          noteReads(foundSeq.current, closeEv.ev);
          closeEv.ev.add([text]);
          const weighed = closeEv.ev.verdict();
          f.rec?.frame({ source: "closeup", reads: [text], verdict: weighed });
          if (weighed.kind === "settled") {
            const chosenNow = f.options.find((p) => p.scryfall_id === weighed.id)!;
            const c = choosePrinting({ sameArt: f.sameArt, printings: f.options }, text);
            setFound((cur) => (cur && cur === f ? { ...cur, chosen: chosenNow, how: "collector", sure: true, settledId: chosenNow.scryfall_id, options: [chosenNow, ...c.options.filter((p) => p !== chosenNow)], readFirst: 1, raw: text } : cur));
            setCloseup(null);
            buzz(30);
            return;
          }
          setReadProgress(progressLine(weighed, f.options.length));
        } else {
          const { names, catalog } = await textReader();
          if (stop) return;
          const [top, second] = names.match(text, 2);
          if (top && top.score >= 0.8 && top.score - (second?.score ?? 0) >= 0.05) {
            const name = catalog.fullName?.(top.name) ?? top.name;
            if (top.score >= 0.95 || previous === name) {
              setCloseup(null);
              fromName(name, "name");
              return;
            }
            previous = name;
          } else previous = null;
        }
        next(120);
      } catch (e) {
        if (!stop) setCloseupRead(e instanceof Error ? e.message : String(e));
        next(500);
      }
    };
    void tick();
    return () => {
      readers.current.delete(halt);
      stop = true;
      clearTimeout(timer);
    };
    // fromName is a plain function of this render; the loop only needs the latest at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeup, paused, live, ocrEngine, textReader]);

  const chosen = found?.chosen ?? null;
  // The host offers the chosen printing's finishes (a surge-foil-only printing: Foil alone).
  const onPrintingRef = useRef(onPrinting);
  onPrintingRef.current = onPrinting;
  useEffect(() => {
    onPrintingRef.current?.(chosen);
    // Diagnostics' timing record: the scanner settled the printing (the only one, read, or by look), now.
    const f = foundRef.current;
    if (chosen && f?.timing && f.chosen === chosen && !identityOnly && (f.how === "only" || f.how === "set" || f.how === "collector" || f.how === "look")) f.timing.printed(f.misread ? "corrected" : f.how);
  }, [chosen, identityOnly]);
  const ready = identityOnly || !!chosen;
  // When the next step is a tap, not the camera, say so on the camera view, buzz, and bring it into view.
  const tapNeeded: string | null =
    phase !== "found" || !found || closeup || holding
      ? null
      : found.outside
        ? `Not in ${lockLabel}: another set?`
        : (!chosen || found.picking) && !found.reading && !!found.options && found.options.length > 1
          ? "Tap your printing"
          : null;
  useEffect(() => {
    if (!tapNeeded) return;
    buzz([20, 60, 20]);
    sound("needs-you");
    tapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tapNeeded]);
  /**
   * File the card: Add, a tapped printing (Bryan, 15 Nov 2026: tapping a printing is the
   * confirmation) or Keep adding. Keeps its scan photo, hands it to `onAccept` and goes on to the
   * next card; "Added …" shows on the camera once it's saved, with Undo where the host offers it.
   */
  const file = (f: Found, c: Printing | null, n: number, auto: boolean): Promise<unknown> | undefined => {
    if (!onAccept) return;
    const label = c ? `${c.name} (${c.set_code.toUpperCase()} ${c.collector_number})` : f.name;
    const card = candidateOf(f, c);
    keep(f, "added", card);
    // Diagnostics' timing record: how the printing was settled, and whether Keep adding filed it.
    if (f.timing) {
      if (!identityOnly && c) f.timing.printed(printingWay(f, c));
      f.timing.detail.auto = auto;
      // Whether the look's closest printing is the one filed (the first filing only): with the
      // lead it had (`look_lead`), what settling by look would have done, whichever option ran.
      const lookScores = look?.complete && look.seq === foundSeq.current ? look.scores : undefined;
      if (!identityOnly && c && lookScores && f.timing.detail.look_top_filed === undefined) f.timing.detail.look_top_filed = lookBest(lookScores) === c.scryfall_id;
    }
    // Diagnostics: how the card ended, and its record goes (when it was kept for anything).
    f.rec?.note("final", { id: c?.scryfall_id, set: c?.set_code, number: c?.collector_number, how: f.how, sure: !!f.sure, correcting: !!f.correcting, misread: f.misread?.scryfall_id });
    endRecord(f.how === "picked" ? "picked" : "filed", f);
    // Wrong printing after filing: change the copy already filed, never add another.
    if (f.correcting) {
      const from = f.correcting;
      again(f);
      // Still held: Scan anyway is one more of the printing it is now, with the same settings.
      const held = (printing: Printing | null, text: string) => {
        // A new copy, not another correction.
        if (!single) setDupe({ found: { ...f, chosen: printing, correcting: undefined, misread: undefined }, printing, label: text, settings: fileSettings });
      };
      if (!onCorrect || !c) return;
      // The host says what is filed now; the scanner assumes nothing about it.
      setJustAdded({ text: `Changing it to ${label}…`, busy: true });
      return onCorrect(from, card).then(
        (now) => {
          buzz(40);
          held(c, label);
          setJustAdded({ text: now === "kept" ? `Kept ${label}` : `Changed to ${label}`, card, label, found: f, printing: c, say: now === "kept" });
        },
        (e: unknown) => {
          // Not confirmed: the host may still be sending the change (its Added list has that copy,
          // and tries it again). Which printing is filed isn't known here, so no Undo, Wrong
          // printing or Scan anyway on it.
          setJustAdded({ text: `Couldn't confirm the change to ${label}: ${e instanceof Error ? e.message : String(e)}. The Added list shows that card.` });
        },
      );
    }
    if (c) {
      filedSetNames.current.set(c.set_code, c.set_name);
      setFiledSets((s) => [c.set_code, ...s].slice(0, 10));
    }
    filedName.current = f.name;
    const saved = onAccept(card, n, auto);
    // The card stays in the session list either way (a failed save can be tried again there), so
    // scanning goes on; "Added" waits for the save.
    again(f);
    // While the camera still holds this card it isn't found again; "Scan anyway" files another.
    if (!single) setDupe({ found: f, printing: c, label, settings: fileSettings });
    // With the strip, the card's tile opens it with Try again; otherwise the Added chip does.
    const failed = () => setJustAdded({ text: `Couldn't save ${label}. Tap ${recentCards?.length ? "it below" : addedWord} to try again` });
    return Promise.resolve(saved).then((ok) => {
      if (ok === false) return failed();
      buzz(40);
      // A brighter sound for a card worth the threshold (its market price in the finish filed).
      sound(filedSound(identityOnly ? null : priceFor(card.prices, filedFinish(card.finishes, finish)), worth));
      const at = identityOnly ? null : priceFor(card.prices, filedFinish(card.finishes, finish));
      setJustAdded({ text: `${addedWord} ${label}${at != null ? `, ${usd(at)}` : ""}`, card: onUndo || onCorrect ? card : undefined, label, found: f, printing: c });
    }, failed);
  };
  /** The scanner settled this printing itself (read, by look, or the only one), and so could have it wrong. */
  const settledByScanner = (f: Found) => !identityOnly && !!f.chosen && (f.how === "collector" || f.how === "look" || f.how === "only" || f.how === "set");
  /**
   * Wrong printing (Bryan, 15 Nov 2026): the card is right, the printing isn't. The list opens with
   * the misread marked "Read as", and the printing is read again from the held card, a fresh
   * attempt; tapping one files it. With `filed`, the card was already filed: the choice then
   * changes that copy. A scan photo is kept as a correction of the misread.
   */
  const wrongPrinting = (f: Found, misread: Printing, filed?: ScanCandidate) => {
    // After filing the card's timing record has gone: the correction gets one of its own, marked so.
    const timing = filed ? f.timing?.afterFiling() : f.timing?.printingRejected();
    const base: Found = { ...f, guess: f.guess ?? guessOf(f), misread, correcting: filed, chosen: null, how: null, sure: false, picking: false, error: undefined, rec: withReason(f.rec, "wrong-printing"), timing };
    base.rec?.note("misread", { id: misread.scryfall_id, set: misread.set_code, number: misread.collector_number, how: f.how });
    setJustAdded(null);
    setWrongOpen(false);
    setCloseup(null);
    setPhase("found");
    // Read from the list it came from, unless that was only this printing (or only the locked
    // sets'): then every printing of the card.
    if (f.options && f.options.length > 1 && f.how !== "set") {
      const seq = ++foundSeq.current;
      // The printing just said to be wrong isn't kept first, and the look compares the list again.
      const again: Found = { ...base, readFirst: 0 };
      setFound(again);
      setHoldRun((n) => n + 1);
      // This card's own look, if it finished (after filing its frames are gone); else look again.
      const had = f.shot ? lookDone.current.get(f.shot) : undefined;
      // (A printing said to be wrong is never settled again by look: `misread`.)
      if (had && f.options.every((p) => had[p.scryfall_id] !== undefined || !p.image_normal)) setLook({ seq, scores: had, complete: true, option: artRef.current?.look });
      else if (again.sameArt) startLook.current(seq, again, f.options);
      return;
    }
    const seq = ++foundSeq.current;
    const wide: Found = { ...base, options: null, unlocked: true };
    setFound(wide);
    void settle(seq, wide, { name: f.name }, null);
  };
  const undo = (j: JustAdded) => {
    if (!j.card || !onUndo) return;
    const taking: JustAdded = { text: `Taking out ${j.label}…`, busy: true };
    setJustAdded(taking);
    onUndo(j.card).then(
      // Only if the chip is still this Undo's: a card filed meanwhile shows its own "Added" with
      // its own Undo, which this must not take away. A failure is always shown.
      () => setJustAdded((cur) => (cur === taking ? { text: `Took out ${j.label}` } : cur)),
      (e: unknown) => setJustAdded({ text: `Couldn't take out ${j.label}: ${e instanceof Error ? e.message : String(e)}` }),
    );
  };
  /** One more copy of the card just filed, same printing and finish, by the same path as Add. */
  const scanAnyway = () => {
    if (!dupe || dupeBusy.current || dupe.settings !== fileSettings) return;
    dupeBusy.current = true;
    setDupeSaving(true);
    void Promise.resolve(file(dupe.found, dupe.printing, 1, false)).finally(() => {
      dupeBusy.current = false;
      setDupeSaving(false);
    });
  };
  // A changed finish or destination isn't "the same again": the offer goes rather than file a
  // copy the person didn't scan (the host files with its current settings).
  useEffect(() => {
    setDupe((d) => (d && d.settings !== fileSettings ? null : d));
  }, [fileSettings]);
  /**
   * Whether Keep adding files this card by itself. Not a card counted on the strength of a title
   * read, or of its art's lead over lookalikes, under the name filed last while the view hasn't
   * been clear since: it may be that card still in view.
   */
  const autoFiles = (f: Found) => {
    if (!identityOnly) return addsItself(f);
    const vouched = f.titled || (f.leads && f.others.length > 0);
    return addsByIdentity(f) && !(vouched && !!filedName.current && sameCardName(f.name, filedName.current));
  };
  useEffect(() => {
    // A printing the person said was misread, or a correction, waits for a tap.
    if (!autoAdd || !onAccept || paused || phase !== "found" || !found || found.misread || found.correcting || !autoFiles(found)) return;
    file(found, identityOnly ? null : found.chosen!, 1, true);
    // file() is a plain function of this render; only these decide whether to add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdd, onAccept, paused, identityOnly, phase, found]);
  const cameraRef = useRef<HTMLDivElement>(null);
  usePinchZoom(cameraRef, cam.zoom, cam.zoomTo);
  const panelRef = useRef<HTMLDivElement>(null);
  const sheet = useSheetDrag(panelRef);
  // A hidden sheet comes back whenever the person has something to do in it: a card found that
  // Keep adding won't file by itself, or the set picker opened.
  const { setHidden: showSheet } = sheet;
  const filesItself = !!found && autoAdd && !!onAccept && !found.misread && !found.correcting && autoFiles(found);
  const needsSheet = (phase === "found" && !!found && !filesItself) || lockOpen;
  useEffect(() => {
    if (needsSheet) showSheet(false);
  }, [needsSheet, showSheet]);
  const settingsBox = settingsOpen && (
    <ScanSettings onClose={() => setSettingsOpen(false)}>
      {settings}
      {nativeCameraAvailable() && (
        <NativeCameraSetting
          option={nativeOpt}
          onChange={(o) => {
            saveNativeCamera(o);
            setNativeOpt(o);
            setNativeFailed(null);
          }}
          info={useNative ? (cameraNow as SourceInfo | null) : null}
          camera={useNative ? nativeCam.current : null}
          failed={nativeOpt.on ? nativeFailed : null}
        />
      )}
      <CameraSetting
        cameras={cameras}
        current={cameraNow}
        fps={fpsMeter.fps()}
        onFps60={(on) => {
          setFps60(on);
          const t = cam.track();
          if (t) void cam.exclusive(t, async () => void (await (on ? ask60(t) : askUsualRate(t)))).then(() => cam.track() === t && setCameraNow(cameraInfo(t)));
        }}
        chosen={cameraId}
        onChoose={(c) => {
          saveCamera({ id: c.deviceId, label: c.label });
          setCameraId(c.deviceId);
        }}
      />
      <SavePhotosSwitch />
      <DiagnosticsSwitch
        on={diag}
        onChange={(on) => {
          setDiagnosticsOn(on);
          setDiag(on);
          // Off means off now: the card in hand keeps nothing more and sends nothing.
          if (!on) {
            foundRef.current?.rec?.cancel();
            seek.current?.rec.cancel();
            seek.current = null;
          }
          // Either way the card in view is timed afresh (its timing record never goes once off).
          appeared.current = null;
        }}
      />
      {soundsProp && (
        <SoundsSetting
          on={soundsSwitch}
          worth={worth}
          prices={!identityOnly}
          onChange={(on) => {
            setSoundsOn(on);
            setSoundsSwitch(on);
            // This tap is the gesture that lets sound play.
            if (on) unlockSound();
          }}
          onWorth={(v) => {
            setWorthThreshold(v);
            setWorth(v);
          }}
        />
      )}
      {modelsInfo && (
        <ModelsSetting
          info={modelsInfo}
          slots={slots}
          can={deviceCan}
          notes={modelNotes}
          runs={{
            detector: mode === "art" ? `Running ${modelsInfo.detector.options.find((o) => o.id === detectorNow)?.label ?? detectorNow ?? "nothing yet"}.` : undefined,
            art: mode === "art" ? `Running ${modelsInfo.art.options.find((o) => o.id === artNow)?.label ?? artNow ?? "nothing yet"}.` : mode === "text" ? "Card recognition isn't running." : undefined,
            text: ocrName ? `Running ${ENGINE_LABEL[ocrName]}.` : undefined,
            look: mode === "art" ? `Running ${modelsInfo.look.options.find((o) => o.id === lookNow)?.label ?? lookNow}.` : undefined,
          }}
          hide={identityOnly ? ["look"] : []}
          onChoose={(slot, id) => saveModel(slot, id)}
        />
      )}
      {mode === "text" && <p className="scan-note">Card recognition isn't available right now, so the scanner reads the card's text: line the card up with the frame.</p>}
      <p className="scan-note">Reads text with {ENGINE_LABEL[ocrName ?? plannedEngine(ocrChoice.current)]}{ocrName ? "" : " (starts with the first read)"}.</p>
      <VersionLine className="scan-note" />
    </ScanSettings>
  );
  // What cards are filed as, on the sheet: a tap opens Scan settings.
  const filing = settingsSummary ? (
    <Button className="scan-filing" onClick={() => setSettingsOpen(true)} aria-label={`Filing as ${settingsSummary}. Change`}>
      <span className="scan-filing-what">{settingsSummary}</span>
      <svg className="scan-filing-change" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </Button>
  ) : null;
  const chosenFinish = chosen ? filedFinish(chosen.finishes, finish) : finish;
  const price = chosen ? priceFor(pricesOf(chosen), chosenFinish) : null;
  const isFound = phase === "found" && !!found;
  // Whether the card found sees play in Commander (playable.ts), from its printing's oracle id.
  const foundOracle = isFound ? (chosen?.oracle_id ?? found?.options?.[0]?.oracle_id) : undefined;
  const foundTag = playTag(usePlayability([foundOracle]).get(foundOracle ?? ""));
  const options = found?.options ?? null;
  // The list as shown: the collector line's matches first, then the printing look's order (look.ts),
  // with its best guess marked once two are scored.
  const lookNowScores = look && look.complete && look.seq === foundSeq.current && lookTouched !== look.seq ? look.scores : undefined;
  // The printing said to be wrong (Wrong printing) goes last and is never the look's guess.
  const misreadId = found?.misread?.scryfall_id;
  const listed = options && withoutMisread(lookOrder(options, found?.readFirst ?? 0, lookNowScores), misreadId);
  const lookGuess = lookBest(lookNowScores && misreadId ? Object.fromEntries(Object.entries(lookNowScores).filter(([id]) => id !== misreadId)) : lookNowScores);
  // The latest frame of the held card, else the one it was found in.
  const peekShot = liveShot ?? found?.shot ?? null;
  // "Read the collector number up close", in the found card's More.
  const upClose = live && !identityOnly && !closeup && !chosen && !!found && !found.outside && !!options && options.length > 1 && !found.reading;
  const showPicker = !identityOnly && !!found && !found.outside && !!options && options.length > 1 && !found.reading && (found.picking || !chosen);
  // Add stands beside Copies once the printing is settled, or while one is still being found.
  const addable = !!found && (ready || (!showPicker && !found.outside && !(options && options.length === 0)));
  const copiesOffered = !!found && !identityOnly && !single && !found.correcting;
  const range = !identityOnly && found && !chosen && options && options.length > 1 ? priceRange(options, finish) : null;
  const suggested = lockOffered && !lockOpen && lockCodes.length === 0 ? suggestLock(filedSets, new Set(lockCodes)) : null;
  const suggestedName = suggested ? (filedSetNames.current.get(suggested) ?? suggested.toUpperCase()) : null;
  // With the strip, what just happened is said there, beside the card (ScanTray's head), and the
  // camera's chip says only what the scanner is doing now (Bryan, 16 Nov 2026: the options popped up
  // in your face, not what happened). Without it (deck and swap scans) the chip says both, as before.
  const moreItems =
    isFound && found
      ? [
          !wrongOpen && (
            <Button key="wrong" onClick={() => setWrongOpen(true)}>
              Wrong card
            </Button>
          ),
          settledByScanner(found) && !found.picking ? (
            <Button key="printing" onClick={() => wrongPrinting(found, chosen!, found.correcting)}>
              Wrong printing
            </Button>
          ) : (
            !identityOnly &&
            chosen &&
            options &&
            options.length > 1 &&
            !found.picking && (
              <Button key="printing" onClick={() => setFound({ ...found, picking: true })}>
                Change printing ({options.length})
              </Button>
            )
          ),
          upClose && (
            <Button key="closeup" onClick={() => setCloseup("collector")}>
              Read the collector number up close
            </Button>
          ),
          // Choosing sets is for the cards to come, so it's here too, not only when idle (review).
          lockOffered && lockCodes.length === 0 && (
            <Button key="lock" onClick={() => setLockOpen(true)}>
              Scan only some sets
            </Button>
          ),
        ].filter(Boolean)
      : [];
  const newest = recentCards?.[0];
  const receipt = !!newest;
  // The receipt's buttons act on `justAdded.card`, so they stand beside the newest card only when it
  // is that card: a second card filed inside the Undo window (or saved out of order) is named there
  // without them, rather than with an Undo that would take out the other one (review, 16 Nov 2026).
  const jc = justAdded?.card;
  const sameAsNewest =
    !!jc && !!newest && (entryOf ? entryOf(jc) === newest.key : jc.name === newest.name && (jc.set ?? "") === (newest.set ?? "") && (jc.number ?? "") === (newest.number ?? ""));
  const undoable = !!jc && !justAdded!.busy && sameAsNewest && (!!onUndo || (!!onCorrect && !!justAdded!.printing));
  const dupeHere = !!dupe && !!onAccept && !!newest && dupe.found.name === newest.name;
  // Wrong printing beside Undo only when the scanner read the printing itself: one you tapped is
  // rarely wrong, and the card's own sheet (tap it in the strip) has Wrong printing anyway.
  const readByScanner = !!justAdded?.found && (justAdded.found.how === "collector" || justAdded.found.how === "look" || justAdded.found.how === "set");
  const receiptActions =
    receipt && undoable ? (
      <>
        {onUndo && (
          <Button className="scan-act" onClick={() => undo(justAdded!)}>
            Undo
          </Button>
        )}
        {onCorrect && readByScanner && justAdded!.found && justAdded!.printing && (
          <Button className="scan-act" onClick={() => wrongPrinting({ ...justAdded!.found!, chosen: justAdded!.printing! }, justAdded!.printing!, justAdded!.card)}>
            Wrong printing
          </Button>
        )}
      </>
    ) : null;
  // "Scan anyway", in the picture (Bryan, 16 Nov 2026): the card just added is still in view, so
  // the camera says so, with +1 copy for when you really have another.
  const stillInView = receipt && dupeHere && !isFound && !lockOpen && !closeup;
  // How many of it in a row: "3 added" beside +1 copy, so a stack of four can be counted.
  let inARow = 0;
  for (const c of recentCards ?? []) {
    if (!newest || c.name !== newest.name || c.set !== newest.set || c.number !== newest.number) break;
    inARow += c.copies;
  }
  const flashing = receipt && flash && sameAsNewest && !isFound && !lockOpen && !closeup;
  const flashPrice = flashing && newest && !identityOnly ? priceFor(newest.prices, newest.finish) : null;
  // Once the strip has cards, waiting for one is known: the chip only speaks when it has news.
  const idleStatus = mode === "art" && (status === WAITING || status === NEXT);
  // Said in the head in place of the card's name: an event with no card (Took out …, Couldn't …),
  // news about the card ("Kept …"), or an add the newest entry isn't (its save came back late).
  const receiptEvent = receipt && justAdded && (!jc || justAdded.say || !sameAsNewest) ? justAdded.text : null;
  // For screen readers, every add and event, said once in the strip's always-there status line.
  const receiptAnnounce = receipt && justAdded ? justAdded.text : "";
  const loadingText =
    loadState?.kind === "downloading"
      ? `Getting card recognition ready (${Math.round(loadState.loaded / 1e6)} of ${Math.round(loadState.total / 1e6)} MB, once)`
      : loadState?.kind === "preparing"
        ? "Getting card recognition ready"
        : "Getting the scanner ready";

  return (
    // Any tap in the scanner lets sound play from then on (browsers and the app's web view start audio silent).
    <div className={`scan${needsSheet ? " is-deciding" : ""}`} onPointerDown={soundsProp && soundsSwitch ? () => void unlockSound() : undefined}>
      <div ref={cameraRef} className="scan-camera">
        <div className="scan-zoom" style={cam.digital > 1 ? { transform: `scale(${cam.digital})` } : undefined}>
          {useNative ? (
            // The app's own camera: its preview is drawn behind the page, and this canvas (not
            // painted) holds the frames the scanner reads, where the video would be.
            <canvas ref={videoRef as unknown as Ref<HTMLCanvasElement>} className="scan-video is-native" aria-hidden="true" />
          ) : (
            <video ref={videoRef} className="scan-video" playsInline muted autoPlay aria-hidden="true" />
          )}
          <CardOutline tracker={outlines} show={phase === "scanning" && mode === "art" && live && !closeup && !photoBusy && !paused && !lockOpen} />
        </div>
        <div className="scan-frame" aria-hidden="true">
          {closeup ? (
            <div ref={closeRef} className={`scan-closeup is-${closeup}`} />
          ) : (
            <div ref={guideRef} className={`scan-guide${mode === "art" ? " is-hint" : ""}${phase === "found" ? " is-locked" : ""}`} />
          )}
        </div>
        {onClose && (
          <Button className="scan-close" onClick={onClose} aria-label="Close the scanner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </Button>
        )}
        <Button className="scan-gear" onClick={() => setSettingsOpen(true)} aria-label="Scan settings" aria-haspopup="dialog">
          <SettingsIcon />
        </Button>
        {addedCount > 0 &&
          !recentCards?.length &&
          (onShowAdded ? (
            <Button className="scan-count" onClick={onShowAdded}>
              {addedWord} {addedCount}
              {unsavedCount > 0 ? `, ${unsavedCount} not saved` : ""}: review
            </Button>
          ) : (
            <span className="scan-count">{addedWord} {addedCount} so far</span>
          ))}
        {/* Scanning only some sets is a mode worth seeing while it's on; choosing it is under More. */}
        {lockOffered && (lockCodes.length > 0 || lockOpen) && (
          <Button className={`scan-lock${lockOn ? " is-on" : ""}`} onClick={() => setLockOpen((o) => !o)} aria-expanded={lockOpen}>
            {lockCodes.length === 0 ? "Any set" : lockOn ? `Only ${lockLabel}` : lockError ? "Set lock failed" : "Getting the set…"}
          </Button>
        )}
        <CameraControls c={cam} live={live} />
        {typeof overlay === "function" ? overlay(isFound && found ? candidateOf(found, chosen) : null, { another: phase === "scanning" && (status === READING || closeup === "title") }) : overlay}
        {(stillInView || flashing) && !tapNeeded ? (
          <div className={`scan-chip has-action${flashing ? " found" : ""}`}>
            <span>
              {flashing ? (
                <>
                  <svg className="scan-chip-tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                  {flashPrice != null ? `Added, ${usd(flashPrice)}` : "Added"}
                </>
              ) : inARow > 1 ? (
                `${inARow} added`
              ) : (
                "Still in view"
              )}
            </span>
            {stillInView && (
              <Button className="scan-chip-action" onClick={scanAnyway} disabled={dupeSaving} aria-label={`Scan anyway: add another ${dupe!.label}`}>
                {dupeSaving ? "Adding…" : "+1 copy"}
              </Button>
            )}
          </div>
        ) : receipt && !tapNeeded && !isFound && !lockOpen && idleStatus ? null : !receipt && !tapNeeded && !isFound && !lockOpen && justAdded?.card && (onUndo || (onCorrect && justAdded.printing)) ? (
          <div className="scan-chip found has-action">
            <span role="status">{justAdded.text}</span>
            {onUndo && (
              <Button className="scan-chip-action" onClick={() => undo(justAdded)}>
                Undo
              </Button>
            )}
            {onCorrect && justAdded.found && justAdded.printing && (
              <Button className="scan-chip-action" onClick={() => wrongPrinting({ ...justAdded.found!, chosen: justAdded.printing! }, justAdded.printing!, justAdded.card)}>
                Wrong printing
              </Button>
            )}
          </div>
        ) : (
        <span className={`scan-chip${tapNeeded ? " is-tap" : isFound ? " found" : justAdded && !receipt ? " found" : ""}`} role="status">
          {tapNeeded ??
            (isFound && found?.outside
              ? `Not in ${lockLabel}`
              : isFound && (closeup === "collector" || holding)
                ? holding
                  ? far
                    ? "Move closer, so the set code and number can be read"
                    : "Found it. Hold still for the printing"
                  : "Found it. Now the printing"
                : isFound
                  ? "Found it"
                  : lockOpen
                    ? "Choose the sets"
                    : ((receipt ? null : justAdded?.text) ?? (mode ? status : loadingText)))}
        </span>
        )}
      </div>

      {recentCards && recentCards.length > 0 && <ScanTray cards={recentCards} worth={identityOnly ? Infinity : worth} onOpen={onOpenCard} onReview={onShowAdded} event={receiptEvent} actions={receiptActions} announce={receiptAnnounce} />}
      <div ref={panelRef} className={`scan-panel${sheet.hidden ? " is-hidden" : ""}`} aria-live="polite">
        {/* "Use a photo" in More opens this: it stays mounted when the menu closes. */}
        <input
          ref={photoInput}
          className="scan-photo-input"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (file) void fromPhoto(file);
          }}
        />
        <Button
          className="scan-handle"
          aria-label={sheet.hidden ? "Show the panel" : "Hide the panel to see the whole camera"}
          aria-expanded={!sheet.hidden}
          {...sheet.handle}
        >
          <span aria-hidden="true" />
        </Button>
        {!isFound && closeup === "title" && (
          <div className="scan-step">
            <p>
              <strong>Can't tell which card this is.</strong> Hold the phone close to the card's name, so the name fills the box.
            </p>
            {closeupRead && <p className="scan-note">Reading: {closeupRead}</p>}
            <div className="scan-other-ways">
              <Button onClick={() => setCloseup(null)}>Back to scanning</Button>
              <NameEntry onPick={(n) => fromName(n)} />
            </div>
            {/* The Close-ups switch among them: a fixed camera can't do this step. */}
            {controls}
          </div>
        )}
        {lockOpen && (
          <SetLockPicker
            codes={lockCodes}
            loading={lockLoading}
            onChange={(codes) => setLockCodes(codes)}
            onClose={() => setLockOpen(false)}
          />
        )}
        {!isFound && closeup !== "title" && !lockOpen && (
          <>
            {dupe && onAccept && !dupeHere && (
              <div className="scan-step scan-dupe">
                <p>
                  <strong>{dupe.label} is still in view.</strong> The scanner waits for a different card. Got another copy of it?
                </p>
                <div className="scan-other-ways">
                  <Button variant="primary" onClick={scanAnyway} disabled={dupeSaving}>
                    {dupeSaving ? "Adding…" : "Scan anyway"}
                  </Button>
                </div>
              </div>
            )}
            <ErrorText error={error} />
            {lockError && <p className="error">Couldn't lock to {lockCodes.map((c) => c.toUpperCase()).join(", ")}: {lockError}</p>}
            {suggested && suggestedName && suggestDismissed !== suggested && (
              <div className="scan-suggest">
                <p>
                  All <strong>{suggestedName}</strong> lately
                </p>
                <HelpPopover label="scanning one set">Scanning only that set files its printings without reading the corner of each card.</HelpPopover>
                <Button className="scan-act" onClick={() => setLockCodes([suggested])}>
                  Only {suggested.toUpperCase()}
                </Button>
                <Button className="scan-act is-quiet" onClick={() => setSuggestDismissed(suggested)} aria-label="No thanks">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </Button>
              </div>
            )}
            {controls}
            {/* The name box stays last: its suggestions open upward, over the sheet. */}
            {filing}
            <div className="scan-other-ways">
              <NameEntry onPick={(n) => fromName(n)} />
              {/* Ways in used now and then, not on every card (Bryan, 15 Nov 2026: declutter). */}
              <MoreMenu label="More" title="More ways to scan" className="scan-more">
                <Button onClick={() => photoInput.current?.click()}>Use a photo</Button>
                {live && phase === "scanning" && <Button onClick={() => setCloseup("title")}>Read the name up close</Button>}
                {lockOffered && lockCodes.length === 0 && <Button onClick={() => setLockOpen(true)}>Scan only some sets</Button>}
              </MoreMenu>
            </div>
            {!recentCards && recent.length > 0 && <p className="scan-note">Recent: {recent.slice(0, 3).join(", ")}.</p>}
          </>
        )}
        {isFound && found && !lockOpen && (
          <>
            {/* What was found, in one compact block: the card, then its price (Bryan, 16 Nov 2026:
                what happened first, the options out of the way). */}
            <div className="scan-result">
              <CardThumb className="scan-thumb" src={chosen?.image_normal} name={chosen?.name} eager fallback={<div className="scan-thumb card-fallback" aria-hidden="true" />} />
              <div className="scan-info">
                <h3>
                  {found.name}
                  {foundTag && <span className={`scan-play-tag is-${foundTag}`}>{PLAY_WORD[foundTag]}</span>}
                  {/* How it was found: behind a "?", kept but out of the way (Bryan, 16 Nov 2026). */}
                  <HelpPopover label="how it was found">{explain(found, identityOnly, lock.map((l) => l.name).join(" or "))}</HelpPopover>
                </h3>
                {!identityOnly && chosen && (
                  <span className="dim">
                    {`${chosen.set_name} #${chosen.collector_number}`}
                    {chosen.lang !== "en" ? `, ${chosen.lang}` : ""}
                    {`, ${chosenFinish === "proxy" ? "proxy" : copyWords(chosen, chosenFinish)}`}
                  </span>
                )}
                {!identityOnly && chosen && finish !== "proxy" && (
                  <span className={`scan-price${worthIt(price, worth) ? " is-worth" : ""}`}>
                    <strong>{usd(price)}</strong>
                    {price != null && <span className="dim"> market, {shortDate(chosen.price_date) ?? "date unknown"}</span>}
                  </span>
                )}
                {/* With the printings showing, each carries its own price: here, only where they're from. */}
                {range && (showPicker ? (
                  <span className="dim">market, {shortDate(range.date) ?? "date unknown"}</span>
                ) : (
                  <span className="scan-price">
                    <strong>{range.low === range.high ? usd(range.low) : `${usd(range.low)} to ${usd(range.high)}`}</strong>
                    <span className="dim"> market, by printing, {shortDate(range.date) ?? "date unknown"}</span>
                  </span>
                ))}
              </div>
            </div>
            {found.outside && (
              <div ref={tapRef} className="scan-step is-tap" role="alert">
                <p>
                  <strong>
                    {found.name} isn't in {lock.map((l) => l.name).join(" or ") || "the sets you chose"}.
                  </strong>{" "}
                  Is it a card from another set?
                </p>
                <div className="scan-other-ways">
                  <Button variant="primary" onClick={fromAnotherSet}>
                    Yes, another set
                  </Button>
                  <Button onClick={() => setWrongOpen(true)}>Wrong card</Button>
                </div>
              </div>
            )}
            {closeup === "collector" && options && (
              <div className="scan-step">
                <p>
                  <strong>Step 2: the printing.</strong> Hold the phone close to the card's bottom-left corner, so the set code and number fill the box. Or tap the printing below.
                </p>
                {/* What the reader made of it, not the raw text, which changes with every stray space
                    (Bryan, 21 Nov 2026); the raw text only with Scanner diagnostics on. */}
                {readProgress && <p className="scan-note">{readProgress}.</p>}
                {diag && closeupRead && <p className="scan-note dim">Raw: {closeupRead}</p>}
                <div className="scan-other-ways">
                  <Button onClick={() => setCloseup(null)}>Back to reading the whole card</Button>
                </div>
              </div>
            )}
            {showPicker && options && (!chosen || found.picking) && !closeup && (
              <div ref={tapRef} className="scan-pick">
                {peekShot && <CollectorPeek shot={peekShot} />}
                <p className="scan-pick-say">
                  {holding ? (
                    <>
                      <strong>Reading the printing</strong>
                      {readProgress && <span className="dim"> {readProgress}</span>}
                    </>
                  ) : null}
                </p>
                {/* A fresh, full attempt at reading it from the held card: after one gave up, or for a typed name. */}
                {!holding && live && !chosen && !wrongOpen && (
                  <Button className="scan-act" onClick={() => setHoldRun((n) => n + 1)}>
                    {gaveUp ? "Keep reading" : "Read printing"}
                  </Button>
                )}
              </div>
            )}
            {showPicker && listed && (
              <div
                className="scan-printings"
                role="listbox"
                aria-label="Printings"
                // Touched (or reached by keyboard) before the look finished: it won't reorder the
                // list under the person.
                onPointerDown={() => {
                  if (!lookNowScores && lookTouched !== foundSeq.current) setLookTouched(foundSeq.current);
                }}
                onFocusCapture={() => {
                  if (!lookNowScores && lookTouched !== foundSeq.current) setLookTouched(foundSeq.current);
                }}
              >
                {(showAll ? listed : listed.slice(0, PICKER_FIRST)).map((p) => (
                  <Button
                    key={p.scryfall_id}
                    role="option"
                    aria-selected={p === chosen}
                    title={`${p.set_name} #${p.collector_number}${p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}${treatmentLabel(p) ? `, ${treatmentLabel(p)}` : ""}${p.scryfall_id === lookGuess ? ", looks closest" : ""}`}
                    className={`scan-printing${p === chosen ? " is-chosen" : ""}${p.scryfall_id === lookGuess ? " is-look" : ""}`}
                    onClick={() => {
                      setCloseup(null);
                      // Diagnostics: the printing came from the list, not the card.
                      if (options.length > 1) found.rec?.reasons.add("picked");
                      const picked: Found = { ...found, chosen: p, how: "picked", sure: false, picking: false };
                      // Tapping the printing is the confirmation (Bryan, 15 Nov 2026): it's filed at
                      // once, with Undo beside it in the strip (or Wrong card before tapping) as the way back.
                      if (onAccept && !identityOnly) file(picked, p, copies, false);
                      else setFound(picked);
                    }}
                  >
                    <CardThumb src={p.image_small} fallback={<span className="card-fallback" aria-hidden="true" />} />
                    {/* The number first, as it's what tells printings apart on the card's corner, then
                        the set code and year (Bryan, 21 Nov 2026: "I always find it hard to know what
                        is the number that matters"). */}
                    <span className="scan-printing-set">
                      <span className="scan-printing-number">#{p.collector_number}</span>
                      <span className="scan-printing-code">
                        {p.set_code.toUpperCase()}
                        {p.released_at ? ` ${p.released_at.slice(0, 4)}` : ""}
                      </span>
                    </span>
                    {p.scryfall_id === lookGuess && <span className="scan-printing-look">Looks closest</span>}
                    {found.misread?.scryfall_id === p.scryfall_id && <span className="scan-misread">{found.correcting ? "Added as this" : "Read as this"}</span>}
                    {/* What you choose by, visible: the printing's own price and what's special about it.
                        The set's name is in its label (design review, 16 Nov 2026). */}
                    {identityOnly ? (
                      <span className="dim">{p.set_name}</span>
                    ) : (
                      <span className="scan-printing-what">
                        {usd(priceFor(pricesOf(p), filedFinish(p.finishes, finish)))}
                        {(treatmentLabel(p) || p.lang !== "en") && <span className="dim"> {[treatmentLabel(p), p.lang !== "en" ? p.lang : null].filter(Boolean).join(", ")}</span>}
                      </span>
                    )}
                    {!identityOnly && <span className="visually-hidden">{`, ${p.set_name}${p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}`}</span>}
                  </Button>
                ))}
                {!showAll && listed.length > PICKER_FIRST && (
                  <Button className="scan-printing scan-printing-more" onClick={() => setShowAll(true)}>
                    All {listed.length}
                  </Button>
                )}
              </div>
            )}
            <ErrorText error={found.error} />
            {renderResult?.(candidateOf(found, chosen))}
            {controls}
            {wrongOpen && (
              <div className="scan-step scan-wrong">
                <p>
                  <strong>Which card is it?</strong>
                  {found.others.length > 0 ? " It might be one of these, or type its name." : " Type its name, or scan it again."}
                </p>
                {found.others.length > 0 && (
                  <div className="scan-other-ways">
                    {found.others.map((m) => (
                      <Button key={m.index} onClick={() => pickOther(m)}>
                        {m.name}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="scan-other-ways">
                  <NameEntry onPick={(n) => fromName(n, "typed", { shot: found.shot, guess: found.guess ?? guessOf(found), rec: withReason(found.rec, "wrong-card"), timing: found.timing?.cardCorrected() })} />
                  <Button onClick={wrongAgain}>Scan it again</Button>
                </div>
              </div>
            )}
            {/* The decision, on one row; everything lesser on one quiet row under it. */}
            <div className="scan-buttons">
              {/* No Add while the printings are there to tap (a tap files it), or when there's no
                  printing to add. Copies stays, so 2–10 can be chosen before the tap (Codex review). */}
              {onAccept && (addable || (showPicker && copiesOffered)) && (
                <div className="scan-accept">
                  {copiesOffered && (
                    <Field className="scan-copies" label="Copies">
                      <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {addable && (
                    <Button variant="primary" disabled={!ready} onClick={() => file(found, chosen, copies, false)}>
                      {!ready ? "Finding the printing…" : found.correcting ? "Change to this printing" : acceptLabel}
                    </Button>
                  )}
                </div>
              )}
              <Button className="scan-skip" onClick={() => again()}>
                {found.correcting ? "Keep it as it was" : onAccept ? "Skip" : "Scan next"}
              </Button>
              {/* Everything lesser, one tap away: the wrong card, the wrong printing, a close-up. With
                  nothing in it (Wrong card already open, a deck check), there's no More. */}
              {moreItems.length > 0 && (
                <MoreMenu label="More" title="If it's wrong" className="scan-more" variant="quiet">
                  {moreItems}
                </MoreMenu>
              )}
            </div>
            {!recentCards && recent.length > 0 && <p className="scan-note">Recent: {recent.slice(0, 3).join(", ")}.</p>}
            {/* What the scanner saw: for checking a scan, so only with Scanner diagnostics on. */}
            {diag && (
              <details className="small dim">
                <summary>What the scanner saw</summary>
                <pre className="scan-raw">
                  {[
                    found.art ? `Art: ${found.art.name} (${found.art.set.toUpperCase()} ${found.art.number}), score ${found.art.score.toFixed(2)}` : null,
                    found.raw ? `Read: ${found.raw}` : null,
                    found.ms != null ? `${Math.round(found.ms)} ms` : null,
                    camera ? `Camera: ${camera}` : null,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
      {settingsBox}
    </div>
  );
}

/**
 * How the printing filed was settled, for the timing record (diagnostics.ts): a correction when
 * the person said the scanner's printing was wrong or filed another than it settled; otherwise how
 * the scanner settled it (the only one, the locked sets' only one, the collector line, the look
 * when sure), or a pick.
 */
export function printingWay(f: Pick<Found, "how" | "misread" | "settledId">, filed: Pick<Printing, "scryfall_id">): PrintingWay {
  if (f.misread || (f.settledId && f.settledId !== filed.scryfall_id)) return "corrected";
  return f.how === "only" || f.how === "set" || f.how === "collector" || f.how === "look" ? f.how : "picked";
}

/**
 * What a kept scan photo says the person did: "added" as the scanner had it, or "corrected" when
 * they named another card (Wrong card) or printing (Wrong printing, or a printing other than the
 * one the scanner settled), whose `guess` then keeps what the scanner said.
 */
export function sampleKind(f: { settledId?: string; guess?: unknown }, kind: SampleLabel["kind"], label?: Pick<ScanCandidate, "scryfall_id">): SampleLabel["kind"] {
  const changedPrinting = !!f.settledId && !!label?.scryfall_id && label.scryfall_id !== f.settledId;
  return kind === "added" && (f.guess || changedPrinting) ? "corrected" : kind;
}

/**
 * Keep adding adds a card by itself only when the camera found it and the scanner proved the
 * printing (the only one, or read from the collector line). A typed name, or a printing guessed or
 * tapped, waits for Add.
 */
export function addsItself(f: Pick<Found, "sure" | "chosen" | "method" | "confidence">): boolean {
  const typed = f.method === "name" && f.confidence === 1;
  return !!f.sure && !!f.chosen && !typed;
}

/**
 * Keep adding when only the card matters (scanning a deck): a card the camera found by its art is
 * added by itself unless the art looks like another card too and neither a clear title read nor a
 * clear lead over every other card (fuse.ts, 18 Nov 2026) settled it (Bryan, 17 Nov 2026: right
 * cards score 0.64 to 0.70 on his phone, so nearly every card had a lookalike and Keep going
 * stopped on each); one read as text only when the read was sure. A typed name, or a less certain
 * read, waits for Add.
 */
export function addsByIdentity(f: Pick<Found, "method" | "confidence" | "others" | "titled" | "leads">): boolean {
  const typed = f.method === "name" && f.confidence === 1;
  if (typed) return false;
  return f.method === "art" ? f.others.length === 0 || !!f.titled || !!f.leads : f.confidence >= SURE;
}

/** Other cards whose art scores near the top match's (within 0.2), one per name, for "Not this card?". */
export function lookalikes<M extends Pick<ArtMatch, "index" | "name" | "score">>(matches: readonly M[], top: M): M[] {
  return matches.filter((m, i, all) => m.index !== top.index && m.name !== top.name && m.score >= top.score - 0.2 && all.findIndex((x) => x.name === m.name) === i);
}

function explain(f: Found, identityOnly: boolean, lockName = ""): string {
  const by = f.method === "art" ? "Recognized by its art" : f.method === "name" ? (f.confidence === 1 ? "Typed by name" : "Read from the card's name") : "Read from the collector number";
  if (identityOnly) return `${by}. Check the card name.`;
  if (f.outside) return `${by}.`;
  if (f.options === null) return `${by}. Finding the printing…`;
  if (f.reading) return `${by}. ${f.options.length} printings share this art; reading the collector number…`;
  switch (f.how) {
    case "only":
      return f.sameArt ? `${by}. It's the only printing with this art.` : `${by}. It's the card's only printing.`;
    case "set":
      return `${by}. It's the only printing of it in ${lockName || "the sets you chose"}.`;
    case "collector":
      return f.method === "art" ? `${by}; the collector number picked the printing.` : `${by}.`;
    case "look":
      return `${by}. It looks most like this printing, well ahead of the other ${f.options.length - 1} with this art.`;
    case "picked":
      return f.options.length > 1 ? `${by}. You picked the printing; it wasn't read from the card.` : `${by}. You picked the printing.`;
    default:
      if (f.options.length === 0) return `${by}. Yama's card data has no printing of it.`;
      return f.sameArt ? `${by}. ${f.options.length} printings share this art: pick yours.` : `${by}. Pick the printing.`;
  }
}

/** Save scan photos (samples.ts): on unless turned off, per device. */
function SavePhotosSwitch() {
  const [on, setOn] = useState(savingPhotos);
  const [summary, setSummary] = useState<SampleSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    sampleSummary().then(
      (s) => live && setSummary(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on]);
  return (
    <div className="scan-keep">
      <input
        id="scan-save-photos"
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setSavingPhotos(e.target.checked);
          setOn(e.target.checked);
        }}
      />
      <span>
        <label htmlFor="scan-save-photos">
          <strong>Save scan photos.</strong> Keep a small photo of each card you add or correct, with what it was and two close-ups of the card from the camera (its set symbol and its bottom edge), and share them with Yama's developer to test and improve the scanner. Only the card is kept, not the rest of the camera's view, and it's shown to no one else. On unless you turn it off; turning it off stops it.
        </label>{" "}
        {on && summary && summary.count > 0 && (
          <>
            {summary.count} saved.{" "}
            <Button
              className="scan-alt"
              onClick={() =>
                deleteSamples().then(
                  (r) => {
                    setSummary({ ...summary, count: 0, bytes: 0 });
                    setNote(`Deleted ${r.deleted}.`);
                  },
                  (e: unknown) => setNote(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Delete them
            </Button>
          </>
        )}
        {note && <span className="dim"> {note}</span>}
      </span>
    </div>
  );
}

/**
 * Scanner diagnostics (diagnostics.ts): off by default, per device, and kept for this account only
 * (not shared, unlike scan photos); how many are kept, and "Delete them".
 */
function DiagnosticsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    diagnosticsSummary().then(
      (s) => live && setSummary(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on]);
  return (
    <div className="scan-keep">
      <input id="scan-diagnostics" type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <label htmlFor="scan-diagnostics">
          <strong>Scanner diagnostics.</strong> When the scanner struggles with a card (you pick the printing, say it's the wrong card or printing, or it gives up), keep what it saw: the card's bottom edge and set symbol at the camera's full resolution, a small photo, everything it read and the camera's settings. For every card it settles, keep how long that took and how, with no pictures. Kept in your account only, for checking and improving the scanner; not shared. On this device.
        </label>{" "}
        {summary && (summary.count > 0 || (summary.timings ?? 0) > 0) && (
          <>
            {summary.count} kept{summary.timings ? `, and ${summary.timings} timings` : ""}.{" "}
            <Button
              className="scan-alt"
              onClick={() =>
                deleteDiagnostics().then(
                  (r) => {
                    setSummary({ ...summary, count: 0, bytes: 0, timings: 0 });
                    setNote(`Deleted ${r.deleted}${r.timings ? `, and ${r.timings} timings` : ""}.`);
                  },
                  (e: unknown) => setNote(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Delete them
            </Button>
          </>
        )}
        {note && <span className="dim"> {note}</span>}
      </span>
    </div>
  );
}

/** Sounds (sounds.ts): on by default, per device; and the price that makes the brighter sound. */
function SoundsSetting({ on, worth, prices, onChange, onWorth }: { on: boolean; worth: number; prices: boolean; onChange: (on: boolean) => void; onWorth: (v: number) => void }) {
  const [text, setText] = useState(String(worth));
  return (
    <div className="scan-keep">
      <input id="scan-sounds" type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <label htmlFor="scan-sounds">
          <strong>Sounds.</strong> A chime when a card is added{prices ? ", a brighter one when it's worth the amount below or more" : ""}, and a low tone when the scanner needs you. On this device; the phone's silent mode doesn't turn them off, this does.
        </label>
        {on && prices && (
          <label className="scan-worth">
            <span className="dim">Brighter sound at $</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const v = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 0) onWorth(v);
              }}
            />
            <span className="dim"> or more, by the card's market price in the finish added</span>
          </label>
        )}
      </span>
    </div>
  );
}

/**
 * Which camera (cameras.ts): a choice only where there's more than one, and a line saying which is
 * in use and what it delivers. On a phone whose one back camera switches lens as it zooms, a note
 * that zooming far may switch to a lens that can't focus close.
 */
function CameraSetting({
  cameras,
  current,
  fps,
  onFps60,
  chosen,
  onChoose,
}: {
  cameras: NamedCamera[];
  current: CameraInfo | null;
  /** Frames a second the camera delivers now, measured (frameRate.ts). */
  fps: number | null;
  onFps60: (on: boolean) => void;
  chosen: string | null;
  onChoose: (c: NamedCamera) => void;
}) {
  const [sixty, setSixty] = useState(fps60On);
  const inUse = cameras.find((c) => !!current?.deviceId && c.deviceId === current.deviceId) ?? cameras.find((c) => c.label && c.label === current?.label) ?? cameras.find((c) => c.deviceId === chosen) ?? null;
  const zoom = current?.zoomRange;
  const parts = [
    inUse?.name ?? current?.label ?? null,
    current?.width && current.height ? `${current.width} × ${current.height}` : null,
    zoom ? `zoom ${fmtZoom(zoom[0])} to ${fmtZoom(zoom[1])}` : null,
    fps != null ? `${Math.round(fps)} frames a second` : null,
  ].filter(Boolean);
  return (
    <div className="scan-camera-setting">
      {cameras.length > 1 && (
        <Field label="Camera">
          <select
            value={inUse?.deviceId ?? ""}
            onChange={(e) => {
              const c = cameras.find((x) => x.deviceId === e.target.value);
              if (c) onChoose(c);
            }}
          >
            {!inUse && <option value="">Back camera</option>}
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {parts.length > 0 && <p className="scan-note">Camera in use: {parts.join(", ")}.</p>}
      {(current?.maxFrameRate ?? 0) >= 59 && (
        <div className="scan-keep">
          <input
            id="scan-fps60"
            type="checkbox"
            checked={sixty}
            onChange={(e) => {
              setSixty(e.target.checked);
              onFps60(e.target.checked);
            }}
          />
          <span>
            <label htmlFor="scan-fps60">
              <strong>Ask the camera for 60 frames a second.</strong> Less blur on a card that's still moving. Only where the camera keeps its resolution; a dim room may look grainier. On this device.
            </label>
          </span>
        </div>
      )}
      {zoom && maySwitchLens({ min: zoom[0], max: zoom[1] }) && (
        <p className="scan-note">Zooming in past about {LENS_SWITCH}× may switch to the telephoto lens, which can't focus on a card this close. The scanner's own zoom stops at {AUTO_MAX}×.</p>
      )}
    </div>
  );
}

const fmtZoom = (z: number) => `${Number.isInteger(z) ? z : z.toFixed(1)}×`;

