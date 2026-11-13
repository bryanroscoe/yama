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

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Printing } from "../api";
import { loadArtRecognizer, RECOGNIZER_SHORT_SIDE, type ArtRecognizer, type LoadState } from "./artClient";
import { NameIndex } from "./fuzzy";
import { rectQuad } from "./image";
import { readCloseup, readCollectorLines, scanFrame, SURE } from "./pipeline";
import { artHoldFrame, AWAY_FRAMES, hold, holdRead, type ArtHold, type Hold } from "./hold";
import { NameEntry } from "./NameEntry";
import { choosePrinting, printingOptions, type Choice } from "./printings";
import type { ArtMatch, Recognition } from "./recognizer";
import { deleteSamples, keepSample, sampleSummary, savingPhotos, setSavingPhotos, type SampleLabel, type SampleSummary, type Shot } from "./samples";
import { SetLockPicker } from "./SetLockPicker";
import { artInSets, inLockedSets, judgeLocked, lockedNames, lockedSet, poolKeys, savedLock, saveLock, suggestLock, type LockedSet } from "./setlock";
import { CameraControls, digitalRegion, useCameraControls } from "./camera";
import { createServerCatalog } from "./serverCatalog";
import { createScannerOcr, type ScannerOcr } from "./ocrEngine";
import type { OcrEngine, Quad, RgbaImage, ScanCandidate, ScanCatalog, ScanResult } from "./types";
import "./scanner.css";
import { shortDate, usd } from "@yama/core";
import { Button, CardThumb, ErrorText, Field } from "../components/ui";

export interface ScannerViewProps {
  /**
   * Called when the person confirms a card (`auto`: Keep adding added it). Without it the scanner
   * only shows what it found. A promise says whether the card was saved, so Keep adding only
   * says "Added" once it was.
   */
  onAccept?: (card: ScanCandidate, copies: number, auto: boolean) => void | Promise<boolean>;
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
  /** The finish being added, so the found card shows that finish's price. */
  finish?: "nonfoil" | "foil";
  /** Choices shown in the panel (finish, where to put the card). */
  controls?: ReactNode;
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
   * older card while a new one waits. */
  overlay?: ReactNode | ((pending: ScanCandidate | null) => ReactNode);
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
  sameArt: boolean;
  chosen: Printing | null;
  /** "set": the only printing of it in the locked sets. */
  how: "only" | "set" | "collector" | "picked" | null;
  /** Locked to sets, and none of this card's printings (of this art) is in them: ask. */
  outside?: boolean;
  /** The person said it's from another set: the lock doesn't apply to this card. */
  unlocked?: boolean;
  /** The printing the scanner settled by itself, before any change by the person. */
  settledId?: string;
  /** A printing the text reader already read from the collector line, for settling it again. */
  known?: { set?: string; number?: string; proven?: boolean };
  /** The part of the frame around the card, for Save scan photos. */
  shot?: Shot | null;
  /** What the scanner first said, when the person corrected it (Wrong card). */
  guess?: Pick<SampleLabel, "guess_name" | "guess_scryfall_id" | "guess_illustration_id" | "method" | "score">;
  /** The scanner settled the printing itself, with proof (not a guess, not a tap). */
  sure?: boolean;
  /** The person asked to see the other printings. */
  picking: boolean;
  /** Reading the collector line to tell printings apart. */
  reading?: boolean;
  /** What OCR read, when it read anything. */
  raw?: string;
  ms?: number;
  error?: string;
}

/** Lock at this art score on one frame, or at LOCK_TWICE on two agreeing frames. */
const LOCK_ONCE = 0.82;
const LOCK_TWICE = 0.62;
/** Below this the art is probably not in the bundle; after a few such frames, read text instead. */
const ART_UNKNOWN = 0.5;
/** For reading text: extra frame kept around the on-screen guide, and the longest side read. */
const MARGIN = 0.12;
const MAX_SIDE = 1500;
const CARD_ASPECT = 88 / 63;
const PICKER_FIRST = 24;

const sameCard = (a: ScanCandidate | undefined, b: ScanCandidate | undefined) => !!a && !!b && a.name === b.name && a.set === b.set && a.number === b.number;

function draw(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number, canvas: HTMLCanvasElement): RgbaImage {
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

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
function around(source: CanvasImageSource, width: number, height: number, quad: Quad, canvas: HTMLCanvasElement): { image: RgbaImage; quad: Quad } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const pad = 0.08 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  const k = Math.min(1, 2400 / Math.max(x1 - x0, y1 - y0));
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
export function priceRange(printings: Printing[], finish: "nonfoil" | "foil"): { low: number; high: number; date: string | null } | null {
  const english = printings.filter((p) => p.lang === "en");
  let low = Infinity;
  let high = -Infinity;
  let date: string | null = null;
  for (const p of english.length ? english : printings) {
    const v = finish === "foil" ? p.usd_foil : p.usd;
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
  image: p?.image_normal,
  thumb: p?.image_small,
  confidence: f.confidence,
  method: f.method,
});

export function ScannerView({
  onAccept,
  catalog: catalogProp,
  ocr: ocrProp,
  onClose,
  addedCount = 0,
  onShowAdded,
  unsavedCount = 0,
  autoAdd = false,
  closeups = true,
  paused = false,
  recent = [],
  finish = "nonfoil",
  controls,
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
  /** The art just accepted: not found again until the card leaves or another one shows. */
  const blocked = useRef<ArtHold | null>(null);
  /** Frames in a row the detector saw no card, for ending a text hold. */
  const noCard = useRef(0);
  /** The same for a card found by its text (no art match); see hold.ts. The detector seeing no card also ends it. */
  const blockedName = useRef<Hold | null>(null);
  const foundSeq = useRef(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("Hold a card in view");
  const [found, setFound] = useState<Found | null>(null);
  const [outline, setOutline] = useState<{ quad: Quad; w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "art": recognising artwork. "text": reading text only. null: still starting. */
  const [mode, setMode] = useState<"art" | "text" | null>(null);
  const [loadState, setLoadState] = useState<LoadState | null>(null);
  const [copies, setCopies] = useState(1);
  /** The close-up step: the person holds the camera close to the collector line or the title. */
  const [closeup, setCloseup] = useState<"collector" | "title" | null>(null);
  const [closeupRead, setCloseupRead] = useState("");
  const closeRef = useRef<HTMLDivElement>(null);
  const foundRef = useRef<Found | null>(null);
  foundRef.current = found;
  /** What the camera actually delivers, e.g. "3840×2160". */
  const [camera, setCamera] = useState<string | null>(null);
  /** A photo is being read: the camera loop waits, so the two can't both report a card. */
  const [photoBusy, setPhotoBusy] = useState(false);
  /** The camera is running (a close-up needs it). */
  const [live, setLive] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** Add was tapped on a printing picked by eye: asking to check it first. */
  const [confirming, setConfirming] = useState(false);
  /** What Keep adding just added, shown on the camera for a moment. */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  /** Wrong card was tapped: the other cards it might be, a name box, or just scan again. */
  const [wrongOpen, setWrongOpen] = useState(false);
  const cam = useCameraControls();
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
    if (!justAdded) return;
    const t = setTimeout(() => setJustAdded(null), 2500);
    return () => clearTimeout(t);
  }, [justAdded]);

  const ocrRef = useRef<Promise<OcrEngine> | null>(null);
  /** False once the scanner closes: work finishing after that must clean up after itself. */
  const alive = useRef(true);
  /** The text reader (ML Kit in the Android app, PaddleOCR or Tesseract in the browser; ocrEngine.ts), started on first use. */
  const ocrEngine = useCallback(() => {
    // Tesseract's files are served by the app (scripts/copy-ocr.mjs), so it works offline and loads
    // nothing from a CDN. The folder and tesseract's own saved copy of the model are named by the
    // engine's version, so a new engine is fetched rather than an old copy kept.
    const ocr = `/ocr/${import.meta.env.VITE_OCR_VERSION}`;
    ocrRef.current ??= ocrProp
      ? Promise.resolve(ocrProp)
      : createScannerOcr({ workerPath: `${ocr}/worker.min.js`, corePath: `${ocr}/core`, langPath: `${ocr}/lang`, cachePath: `ocr-${import.meta.env.VITE_OCR_VERSION}` }).then((o) => {
          if (!alive.current) {
            void o.terminate();
            throw new Error("The scanner is closed");
          }
          return (ownedOcr.current = o);
        });
    ocrRef.current.catch(() => (ocrRef.current = null));
    return ocrRef.current;
  }, [ocrProp]);
  /** The text reader (OCR plus every card name), started on first use. */
  const textReader = useCallback(() => {
    textRef.current ??= (async () => {
      const catalog = catalogProp ?? (await createServerCatalog({ setCodes: await api<string[]>("/api/sets").catch(() => undefined) }));
      return { ocr: await ocrEngine(), catalog, names: new NameIndex(catalog.names()) };
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
        art = await loadArtRecognizer((s) => !cancelled && setLoadState(s));
      } catch (e) {
        console.warn("Card recognizer unavailable", e);
      }
      if (cancelled) return art?.dispose();
      artRef.current = art;
      setLoadState(null);
      if (art) setMode("art");
      else {
        try {
          await textReader();
          if (!cancelled) setMode("text");
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      artRef.current = null;
      art?.dispose();
      void ownedOcr.current?.terminate();
      ownedOcr.current = null;
      ocrRef.current = null;
      textRef.current = null;
    };
  }, [textReader]);

  // A new zoom moves everything in the recognizer's frame: drop the card it was tracking.
  useEffect(() => {
    artRef.current?.reset();
  }, [cam.digital]);

  // The locked sets' artworks, for the recognizer to match as well.
  useEffect(() => {
    const art = artRef.current;
    if (mode !== "art" || !art) return;
    void art.setPool(lockOn ? poolKeys(lock) : null);
  }, [mode, lock, lockOn]);

  // Camera.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("no-camera");
      setError("This browser can't open the camera here (it needs https). Use a photo instead.");
      return;
    }
    navigator.mediaDevices
      // As sharp as the camera allows: the collector line is tiny. Frames are scaled down for
      // recognition anyway; only the crops read as text use the full resolution.
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const track = s.getVideoTracks()[0];
        cam.attach(track ?? null);
        if (track) {
          const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
          if (caps.focusMode?.includes("continuous")) {
            await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
          }
          const st = track.getSettings();
          if (st.width && st.height) setCamera(`${st.width}×${st.height}`);
        }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setLive(true);
        setPhase((p) => (p === "loading" ? "scanning" : p));
      })
      .catch((e: unknown) => {
        if (stopped) return;
        setPhase("no-camera");
        setError(e instanceof Error ? `No camera: ${e.message}` : "No camera");
      });
    return () => {
      stopped = true;
      cam.attach(null);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // cam.attach is stable (useCallback with no inputs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Settle the printing of what was found (not needed when only the card's identity matters). */
  const settle = useCallback(
    async (seq: number, f: Found, query: { art?: string | null; id?: string; name?: string }, read?: { image: RgbaImage; quad: Quad } | null, known?: { set?: string; number?: string; proven?: boolean }) => {
      const update = (patch: Partial<Found>) => {
        if (foundSeq.current === seq) setFound((cur) => (cur ? { ...cur, ...patch } : cur));
      };
      try {
        let opts = await printingOptions(query);
        // Locked to sets: choose among the printings in them. None there: ask (outside).
        const lockNow = f.unlocked ? null : lockRef.current;
        let bySet = false;
        if (lockNow) {
          const inSets = inLockedSets(opts.printings, lockNow.codes);
          // A name typed by the person is what they say it is: no need to ask about the set.
          const typed = f.method === "name" && f.confidence === 1;
          if (inSets.length === 0 && !typed) {
            update({ options: opts.printings, sameArt: opts.sameArt, outside: true, chosen: null, how: null, sure: false, reading: false });
            return;
          }
          if (inSets.length > 0) {
            opts = { sameArt: opts.sameArt, printings: inSets };
            bySet = true;
          }
        }
        let choice: Choice = choosePrinting(opts);
        // Read from the collector line by the text reader already: proof when the read was.
        if (!choice.chosen && known?.set && known.number) {
          const hit = opts.printings.find((p) => p.set_code === known.set && p.collector_number === known.number);
          if (hit) choice = { chosen: hit, how: "collector", options: [hit, ...choice.options.filter((p) => p !== hit)], certain: !!known.proven };
        }
        const how: Found["how"] = bySet && choice.how === "only" ? "set" : choice.how;
        const reading = !choice.chosen && !!read;
        const sure = choice.how === "only" || !!choice.certain;
        update({ options: choice.options, sameArt: opts.sameArt, outside: false, chosen: choice.chosen, how, sure, settledId: sure ? choice.chosen?.scryfall_id : undefined, reading });
        if (!reading) return;
        // Several printings share the art: read the collector line to tell them apart, trying a
        // few cuts of the corner until one settles it.
        let first: string | null = null;
        let best: Choice | null = null;
        for await (const text of readCollectorLines(read!.image, read!.quad, await ocrEngine())) {
          if (foundSeq.current !== seq) return;
          first ??= text;
          const c = choosePrinting(opts, text);
          if (c.certain) {
            update({ options: c.options, chosen: c.chosen, how: c.how, sure: true, settledId: c.chosen?.scryfall_id, raw: text, reading: false });
            return;
          }
          best ??= c.chosen ? c : null;
        }
        // No read was proof: the best guess goes first in the picker and the close-up step confirms it.
        update({ options: (best ?? choosePrinting(opts, first ?? "")).options, chosen: null, how: null, sure: false, raw: first ?? "", reading: false });
      } catch (e) {
        update({ options: [], reading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [ocrEngine],
  );

  /** Show a card recognised by its art. `read` is a sharp view of it for the collector line. */
  const showArt = useCallback(
    (r: Recognition, top: ArtMatch, read: { image: RgbaImage; quad: Quad } | null, carry: Pick<Found, "shot" | "guess" | "unlocked"> = {}) => {
      const seq = ++foundSeq.current;
      const f: Found = {
        shot: read,
        ...carry,
        name: top.name,
        method: "art",
        confidence: top.score,
        art: top,
        // Every other match, including the best anywhere when the set lock chose an in-set one.
        others: [...r.matches, ...(r.pool ?? [])].filter((m, i, all) => m.index !== top.index && m.name !== top.name && m.score >= top.score - 0.2 && all.findIndex((x) => x.name === m.name) === i),
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
      // The text reader's proof of a printing: set code and number found together with a matching
      // title (0.97), or an exact, anchored collector line on its own (0.85). See pipeline.ts decide.
      const proven = best.confidence >= 0.95 || (best.method === "collector" && best.confidence >= 0.85);
      const f: Found = {
        shot,
        known: { set: best.set, number: best.number, proven },
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
          if (best?.name === held.name) setStatus("Ready for the next card");
          // Another card seen while held counts toward locking on it once the hold ends.
          else if (best) last.current = { index: -1, card: best, at: Date.now() };
          return false;
        }
        blockedName.current = null;
      }
      if (!best) return false;
      const seen = last.current && Date.now() - last.current.at < 2500 ? last.current.card : undefined;
      const lock = single || best.confidence >= 0.95 || (best.confidence >= 0.6 && sameCard(best, seen));
      last.current = { index: -1, card: best, at: Date.now() };
      if (lock) showText(res, shot);
      else setStatus(`Hold still: ${best.name}?`);
      return lock;
    },
    [showText],
  );

  // Read loop: one frame at a time.
  useEffect(() => {
    if (phase !== "scanning" || !mode || closeup || photoBusy || paused || lockOpen) return;
    let stop = false;
    let failedReads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unknownFrames = 0;
    let textFrame = 0;
    setStatus(mode === "art" ? "Hold a card in view" : "Line the card up with the frame");
    const next = (ms: number) => {
      if (!stop) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (stop) return;
      const v = videoRef.current;
      const art = artRef.current;
      if (!v || v.videoWidth === 0 || document.visibilityState !== "visible") return next(200);
      canvasRef.current ??= document.createElement("canvas");
      hiCanvasRef.current ??= document.createElement("canvas");
      try {
        if (mode === "art" && art) {
          // A digital zoom gives the recognizer the middle of the frame, at more of its pixels.
          const box = v.closest(".scan-camera")?.getBoundingClientRect();
          const zone = digitalRegion(v.videoWidth, v.videoHeight, digitalRef.current, box);
          const { image, k } = smallRegion(v, zone, canvasRef.current);
          const r = await art.identify(image);
          if (stop) return;
          const toVideo = (q: Quad) => q.map(([x, y]) => [x / k + zone.x, y / k + zone.y]) as Quad;
          setOutline(r.quad ? { quad: toVideo(r.quad), w: v.videoWidth, h: v.videoHeight } : null);
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
          if (!r.quad || !top) {
            if (++noCard.current >= AWAY_FRAMES) blockedName.current = null;
            last.current = undefined;
            unknownFrames = 0;
            setStatus(blocked.current || blockedName.current ? "Ready for the next card" : "Hold a card in view");
            return next(60);
          }
          noCard.current = 0;
          if (blocked.current) {
            setStatus("Ready for the next card");
            return next(60);
          }
          const prev = last.current && last.current.index === top.index && Date.now() - last.current.at < 1500;
          last.current = { index: top.index, at: Date.now() };
          if (top.score >= LOCK_ONCE || (top.score >= LOCK_TWICE && prev)) {
            unknownFrames = 0;
            const read = identityOnly && !savingPhotos() ? null : around(v, v.videoWidth, v.videoHeight, toVideo(r.quad), hiCanvasRef.current);
            showArt(r, top, read);
            return;
          }
          if (top.score >= ART_UNKNOWN) {
            setStatus(`Hold still: ${top.name}?`);
            return next(30);
          }
          // A card the artwork index doesn't know (a new set, a battle): read its text.
          setStatus("Hold still");
          if (++unknownFrames >= 3) {
            unknownFrames = 0;
            const full = await textReader();
            if (stop) return;
            // Locked: read the name against the locked sets' cards only (new cards the art index
            // doesn't know yet are usually in the set being scanned).
            const reader = lockRef.current?.names ? { ...full, names: lockRef.current.names } : full;
            const quad = toVideo(r.quad);
            const hi = around(v, v.videoWidth, v.videoHeight, quad, hiCanvasRef.current);
            // One orientation per attempt, so the camera stays responsive.
            const res = await readAt(hi.image, hi.quad, reader, [quarterTurns(hi.quad)[textFrame++ % 3]!]);
            if (!stop && handleText(res, false, false, hi)) return;
            // Still nothing: ask for a close-up of the name.
            // (Not while the card just added is held: that would read it again.)
            if (!stop && closeups && !res.candidates[0] && !blockedName.current && ++failedReads >= TITLE_AFTER) {
              setCloseup("title");
              return;
            }
          }
          return next(30);
        }
        // Text only: read the part of the frame around the on-screen guide.
        const g = guideRef.current;
        const reader = await textReader();
        if (stop || !g) return next(200);
        const { sx, sy, sw, sh, gx, gy, gw, gh } = boxInVideo(v, g, MARGIN);
        const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
        const image = draw(v, sx, sy, sw, sh, sw * k, sh * k, canvasRef.current);
        const upright: Quad = rectQuad((gx - sx) * k, (gy - sy) * k, gw * k, gh * k);
        // Alternate upright and upside-down reads across frames rather than both in one frame.
        const flip = textFrame++ % 2 === 1;
        const guide: Quad = flip ? [upright[2], upright[3], upright[0], upright[1]] : upright;
        const res = await scanFrame(image, { ...reader, guide, tryUpsideDown: false });
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
      stop = true;
      clearTimeout(timer);
    };
  }, [phase, mode, closeup, photoBusy, paused, lockOpen, identityOnly, closeups, showArt, handleText, textReader]);

  const fromPhoto = async (file: File) => {
    setStatus("Reading the photo");
    setPhotoBusy(true);
    // Anything shown meanwhile (a typed name, Not this) makes this photo's answer stale.
    const start = foundSeq.current;
    const current = () => foundSeq.current === start && alive.current;
    try {
      const bmp = await createImageBitmap(file);
      canvasRef.current ??= document.createElement("canvas");
      hiCanvasRef.current ??= document.createElement("canvas");
      const art = artRef.current;
      if (art) {
        art.reset();
        const { image, k } = small(bmp, bmp.width, bmp.height, canvasRef.current);
        const r = await art.identify(image);
        const locked = lockRef.current;
        const judged = locked && r.quad ? judgeLocked(r.matches, r.pool, locked.inSets, ART_UNKNOWN) : null;
        const top = judged && judged.kind !== "none" ? judged.match : r.matches[0];
        if (r.quad && top && top.score >= LOCK_TWICE) {
          const read = identityOnly && !savingPhotos() ? null : around(bmp, bmp.width, bmp.height, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
          bmp.close();
          if (current()) showArt(r, top, read);
          return;
        }
        // A card whose art isn't known: read its text where the recognizer found it.
        if (r.quad) {
          const reader = await textReader();
          const hi = around(bmp, bmp.width, bmp.height, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
          const res = await readAt(hi.image, hi.quad, reader);
          if ((res.candidates[0]?.confidence ?? 0) >= SURE) {
            bmp.close();
            if (current()) handleText(res, true, false, hi);
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
      if (!res || !handleText(res, true, false, { image, quad: res.quad })) setStatus("Couldn't read that photo. Fill the photo with the card, or type the name.");
    } catch (err) {
      if (current()) setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  /** A card typed by name: straight to its printings. */
  const fromName = (name: string, how: "typed" | "name" = "typed", carry: Pick<Found, "shot" | "guess"> = {}) => {
    const seq = ++foundSeq.current;
    const f: Found = { name, method: "name", confidence: how === "typed" ? 1 : 0.9, others: [], options: null, sameArt: false, chosen: null, how: null, picking: false, ...carry };
    setFound(f);
    setShowAll(false);
    setWrongOpen(false);
    setCopies(1);
    setPhase("found");
    if (!identityOnly) void settle(seq, f, { name });
  };

  /** Back to scanning. The card just shown isn't found again until it leaves the view. */
  const again = () => {
    foundSeq.current += 1;
    setWrongOpen(false);
    blocked.current = found?.art ? { index: found.art.index, away: 0 } : null;
    noCard.current = 0;
    blockedName.current = found && !found.art ? hold(found.name, Date.now()) : null;
    last.current = undefined;
    setFound(null);
    setOutline(null);
    setCloseup(null);
    artRef.current?.reset();
    setStatus(mode === "text" ? "Line the card up with the frame" : "Hold a card in view");
    setPhase(videoRef.current?.srcObject ? "scanning" : "no-camera");
  };

  /** Switch to another card the art might be. */
  const pickOther = (m: ArtMatch) => {
    if (!found?.art) return;
    showArt({ quad: null, upright: 1, matches: [m, found.art, ...found.others.filter((o) => o !== m)], timings: { detectMs: 0, embedMs: 0, totalMs: found.ms ?? 0 } }, m, identityOnly ? null : (found.shot ?? null), {
      shot: found.shot,
      guess: found.guess ?? guessOf(found),
      unlocked: found.unlocked,
    });
  };

  /** Keep the photo of this card, if Save scan photos is on, with what the person said it was. */
  const keep = (f: Found, kind: SampleLabel["kind"], label?: ScanCandidate) => {
    if (!f.shot) return;
    const changedPrinting = !!f.settledId && !!label?.scryfall_id && label.scryfall_id !== f.settledId;
    void keepSample(f.shot, {
      ...(f.guess ?? guessOf(f)),
      kind: kind === "added" && (f.guess || changedPrinting) ? "corrected" : kind,
      label_name: label?.name,
      label_scryfall_id: label?.scryfall_id,
      camera: camera ?? undefined,
    });
  };

  /** Wrong card, with nothing more said: keep the photo as a miss and scan again. */
  const wrongAgain = () => {
    if (found) keep(found, "wrong");
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

  // Step 2 starts by itself when the printing isn't settled: several share the art and the
  // collector line couldn't be read from the whole-card view. Without close-ups, the picker asks.
  const needsCollector = closeups && live && phase === "found" && !identityOnly && !!found?.options && found.options.length > 1 && !found.chosen && !found.reading && !found.outside;
  useEffect(() => {
    if (needsCollector) setCloseup("collector");
  }, [needsCollector]);
  // Turning close-ups off ends one in progress.
  useEffect(() => {
    if (!closeups) setCloseup(null);
  }, [closeups]);
  useEffect(() => {
    if (phase !== "found" && closeup === "collector") setCloseup(null);
    if (phase === "found" && closeup === "title") setCloseup(null);
  }, [phase, closeup]);

  // The close-up loop: read the box as text until it settles the printing or the name.
  useEffect(() => {
    if (!closeup || paused) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: string | null = null;
    setCloseupRead("");
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
        const image = draw(v, sx, sy, sw, sh, (sw * h) / sh, h, hiCanvasRef.current);
        const text = await readCloseup(image, closeup, await ocrEngine());
        if (stop) return;
        setCloseupRead(text.replace(/\s+/g, " ").trim());
        if (closeup === "collector") {
          const f = foundRef.current;
          if (!f?.options) return next(200);
          const c = choosePrinting({ sameArt: f.sameArt, printings: f.options }, text);
          // Set code and number both read: done. One of them: the same answer twice.
          if (c.chosen && (c.certain || previous === c.chosen.scryfall_id)) {
            const chosenNow = c.chosen;
            setFound((cur) => (cur && cur === f ? { ...cur, chosen: chosenNow, how: "collector", sure: true, settledId: chosenNow.scryfall_id, options: c.options, raw: text } : cur));
            setCloseup(null);
            buzz(30);
            return;
          }
          previous = c.chosen?.scryfall_id ?? null;
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
      stop = true;
      clearTimeout(timer);
    };
    // fromName is a plain function of this render; the loop only needs the latest at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeup, paused, ocrEngine, textReader]);

  const chosen = found?.chosen ?? null;
  const ready = identityOnly || !!chosen;
  // A printing tapped in the picker, among several, wasn't read from the card: the pictures of
  // reprints often look alike (or are the same art). Adding it asks for a check first.
  const unread = !identityOnly && found?.how === "picked" && !!found.options && found.options.length > 1;
  // Any change to the card, its printing or the step (including reopening the picker) asks again.
  useEffect(() => {
    setConfirming(false);
  }, [chosen, phase, closeup, found?.picking]);
  // When the next step is a tap, not the camera, say so on the camera view, buzz, and bring it into view.
  const tapNeeded: string | null =
    phase !== "found" || !found || closeup
      ? null
      : found.outside
        ? `Not in ${lockLabel}: another set?`
      : confirming
        ? "Check the printing below"
        : (!chosen || found.picking) && !found.reading && !!found.options && found.options.length > 1
          ? "Tap your printing below"
          : null;
  useEffect(() => {
    if (!tapNeeded) return;
    buzz([20, 60, 20]);
    tapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tapNeeded]);
  useEffect(() => {
    if (!autoAdd || !onAccept || paused || phase !== "found" || !found || !(identityOnly ? addsByIdentity(found) : addsItself(found))) return;
    const c = identityOnly ? null : found.chosen!;
    const label = c ? `${c.name} (${c.set_code.toUpperCase()} ${c.collector_number})` : found.name;
    const card = candidateOf(found, c);
    keep(found, "added", card);
    if (c) {
      filedSetNames.current.set(c.set_code, c.set_name);
      setFiledSets((s) => [c.set_code, ...s].slice(0, 10));
    }
    const saved = onAccept(card, 1, true);
    // The card stays in the session list either way (a failed save can be tried again there), so
    // scanning goes on; "Added" waits for the save.
    again();
    void Promise.resolve(saved).then(
      (ok) => {
        if (ok === false) setJustAdded(`Couldn't save ${label}. Tap ${addedWord} to try again`);
        else {
          buzz(40);
          setJustAdded(`${addedWord} ${label}`);
        }
      },
      () => setJustAdded(`Couldn't save ${label}. Tap ${addedWord} to try again`),
    );
    // again() is a plain function of this render; only these decide whether to add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdd, onAccept, paused, identityOnly, phase, found]);
  const price = chosen ? (finish === "foil" ? chosen.usd_foil : chosen.usd) : null;
  const isFound = phase === "found" && !!found;
  const options = found?.options ?? null;
  const showPicker = !identityOnly && !!found && !found.outside && !!options && options.length > 1 && !found.reading && (found.picking || !chosen);
  const range = !identityOnly && found && !chosen && options && options.length > 1 ? priceRange(options, finish) : null;
  const suggested = lockOffered && !lockOpen && lockCodes.length === 0 ? suggestLock(filedSets, new Set(lockCodes)) : null;
  const suggestedName = suggested ? (filedSetNames.current.get(suggested) ?? suggested.toUpperCase()) : null;
  const loadingText =
    loadState?.kind === "downloading"
      ? `Getting card recognition ready (${Math.round(loadState.loaded / 1e6)} of ${Math.round(loadState.total / 1e6)} MB, once)`
      : loadState?.kind === "preparing"
        ? "Getting card recognition ready"
        : "Getting the scanner ready";

  return (
    <div className="scan">
      <div className="scan-camera">
        <div className="scan-zoom" style={cam.digital > 1 ? { transform: `scale(${cam.digital})` } : undefined}>
          <video ref={videoRef} className="scan-video" playsInline muted autoPlay aria-hidden="true" />
          {outline && phase === "scanning" && !closeup && (
            <svg className="scan-outline" viewBox={`0 0 ${outline.w} ${outline.h}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
              <polygon points={outline.quad.map((p) => p.join(",")).join(" ")} />
            </svg>
          )}
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
        {addedCount > 0 &&
          (onShowAdded ? (
            <Button className="scan-count" onClick={onShowAdded}>
              {addedWord} {addedCount}
              {unsavedCount > 0 ? `, ${unsavedCount} not saved` : ""}: review
            </Button>
          ) : (
            <span className="scan-count">{addedWord} {addedCount} so far</span>
          ))}
        {lockOffered && (
          <Button className={`scan-lock${lockOn ? " is-on" : ""}`} onClick={() => setLockOpen((o) => !o)} aria-expanded={lockOpen}>
            {lockCodes.length === 0 ? "Any set" : lockOn ? `Only ${lockLabel}` : lockError ? "Set lock failed" : "Getting the set…"}
          </Button>
        )}
        <CameraControls c={cam} live={live} />
        {typeof overlay === "function" ? overlay(isFound && found ? candidateOf(found, chosen) : null) : overlay}
        <span className={`scan-chip${tapNeeded ? " is-tap" : isFound ? " found" : justAdded ? " found" : ""}`} role="status">
          {tapNeeded ??
            (isFound && found?.outside
              ? `Not in ${lockLabel}`
              : isFound && closeup === "collector"
                ? "Found it. Now the printing"
                : isFound
                  ? "Found it"
                  : lockOpen
                    ? "Choose the sets"
                    : (justAdded ?? (mode ? status : loadingText)))}
        </span>
      </div>

      <div className="scan-panel" aria-live="polite">
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
            <ErrorText error={error} />
            {lockError && <p className="error">Couldn't lock to {lockCodes.map((c) => c.toUpperCase()).join(", ")}: {lockError}</p>}
            {suggested && suggestedName && suggestDismissed !== suggested && (
              <div className="scan-step scan-suggest">
                <p>
                  The last few cards were all from <strong>{suggestedName}</strong>. Scan only that set? Its printings are then filed without reading the corner.
                </p>
                <div className="scan-other-ways">
                  <Button variant="primary" onClick={() => setLockCodes([suggested])}>
                    Only {suggested.toUpperCase()}
                  </Button>
                  <Button onClick={() => setSuggestDismissed(suggested)}>No thanks</Button>
                </div>
              </div>
            )}
            {controls}
            <SavePhotosSwitch />
            <div className="scan-other-ways">
              <label className="scan-photo button">
                Use a photo
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(ev) => {
                    const file = ev.target.files?.[0];
                    ev.target.value = "";
                    if (file) void fromPhoto(file);
                  }}
                />
              </label>
              <NameEntry onPick={(n) => fromName(n)} />
              {live && phase === "scanning" && (
                <Button className="scan-photo" onClick={() => setCloseup("title")}>
                  Read the name up close
                </Button>
              )}
            </div>
            {mode === "text" && <p className="scan-note">Card recognition isn't available right now, so the scanner is reading text. Line the card up with the frame.</p>}
            {recent.length > 0 && <p className="scan-note">Recent: {recent.slice(0, 3).join(", ")}.</p>}
          </>
        )}
        {isFound && found && !lockOpen && (
          <>
            <div className="scan-result">
              <CardThumb className="scan-thumb" src={chosen?.image_normal} name={chosen?.name} eager fallback={<div className="scan-thumb card-fallback">{found.name}</div>} />
              <div className="scan-info">
                <h3>{found.name}</h3>
                {!identityOnly && chosen && (
                  <span className="dim">
                    {`${chosen.set_name} #${chosen.collector_number}`}
                    {chosen.lang !== "en" ? `, ${chosen.lang}` : ""}
                    {`, ${finish === "foil" ? "foil" : "regular"}`}
                  </span>
                )}
                {!identityOnly && chosen && (
                  <span>
                    {usd(price)}
                    {price != null && <span className="dim"> market, {shortDate(chosen.price_date) ?? "date unknown"}</span>}
                  </span>
                )}
                {range && (
                  <span>
                    {range.low === range.high ? usd(range.low) : `${usd(range.low)} to ${usd(range.high)}`}
                    <span className="dim"> market, by printing, {shortDate(range.date) ?? "date unknown"}</span>
                  </span>
                )}
                <span className="scan-method">{explain(found, identityOnly, lock.map((l) => l.name).join(" or "))}</span>
                {!identityOnly && chosen && options && options.length > 1 && !found.picking && (
                  <Button className="scan-alt" onClick={() => setFound({ ...found, picking: true })}>
                    Change printing ({options.length})
                  </Button>
                )}
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
                {closeupRead && <p className="scan-note">Reading: {closeupRead}</p>}
              </div>
            )}
            {live && !identityOnly && !closeup && !chosen && !found.outside && options && options.length > 1 && !found.reading && (
              <Button className="scan-alt" onClick={() => setCloseup("collector")}>
                Read the collector number up close
              </Button>
            )}
            {showPicker && options && (!chosen || found.picking) && !closeup && (
              <div ref={tapRef} className="scan-step is-tap">
                <p>
                  <strong>Your turn:</strong> tap the printing that matches your card. Its set code and number are in the bottom-left corner.
                </p>
              </div>
            )}
            {showPicker && options && (
              <div className="scan-printings" role="listbox" aria-label="Printings">
                {(showAll ? options : options.slice(0, PICKER_FIRST)).map((p) => (
                  <Button
                    key={p.scryfall_id}
                    role="option"
                    aria-selected={p === chosen}
                    className={`scan-printing${p === chosen ? " is-chosen" : ""}`}
                    onClick={() => {
                      setCloseup(null);
                      setFound({ ...found, chosen: p, how: "picked", sure: false, picking: false });
                    }}
                  >
                    <CardThumb src={p.image_small} fallback={<span className="card-fallback">{p.name}</span>} />
                    <span className="scan-printing-set">{p.set_name}</span>
                    <span className="dim">
                      #{p.collector_number}
                      {p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}
                      {p.lang !== "en" ? `, ${p.lang}` : ""}
                    </span>
                  </Button>
                ))}
                {!showAll && options.length > PICKER_FIRST && (
                  <Button className="scan-alt" onClick={() => setShowAll(true)}>
                    Show all {options.length}
                  </Button>
                )}
              </div>
            )}
            <ErrorText error={found.error} />
            {confirming && chosen && options && (
              <div ref={tapRef} className="scan-step is-tap" role="alert">
                <p>
                  <strong>This printing wasn't read from the card.</strong>{" "}
                  {found.sameArt ? `${options.length} printings share this art, so the pictures can't tell them apart.` : "It was picked by its picture, and reprints often look alike."} Check that the
                  card's bottom-left corner shows {chosen.set_code.toUpperCase()} {chosen.collector_number}.
                </p>
                {live && (
                  <Button className="scan-alt" onClick={() => setCloseup("collector")}>
                    Read the collector number up close
                  </Button>
                )}
              </div>
            )}
            {renderResult?.(candidateOf(found, chosen))}
            {controls}
            <div className="scan-buttons">
              {onAccept && (
                <div className="scan-accept">
                  {!identityOnly && !single && (
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
                  <Button
                    variant="primary"
                    disabled={!ready}
                    onClick={() => {
                      if (unread && !confirming) return setConfirming(true);
                      const card = candidateOf(found, chosen);
                      keep(found, "added", card);
                      if (chosen) {
                        filedSetNames.current.set(chosen.set_code, chosen.set_name);
                        setFiledSets((s) => [chosen.set_code, ...s].slice(0, 10));
                      }
                      void onAccept(card, copies, false);
                      again();
                    }}
                  >
                    {!ready ? (options && !found.reading ? "Pick the printing" : "Finding the printing…") : confirming ? `${acceptLabel} anyway` : acceptLabel}
                  </Button>
                </div>
              )}
              <Button onClick={again}>{onAccept ? "Skip" : "Scan next"}</Button>
              {!wrongOpen && (
                <Button className="scan-alt" onClick={() => setWrongOpen(true)}>
                  Wrong card?
                </Button>
              )}
            </div>
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
                  <NameEntry onPick={(n) => fromName(n, "typed", { shot: found.shot, guess: found.guess ?? guessOf(found) })} />
                  <Button onClick={wrongAgain}>Scan it again</Button>
                </div>
              </div>
            )}
            {(found.others.length > 0 || recent.length > 0) && (
              <p className="scan-note">
                {found.others.length > 0 && (
                  <>
                    Not this card? It might be{" "}
                    {found.others.map((m, i) => (
                      <span key={m.index}>
                        {i > 0 && " or "}
                        <Button className="scan-alt" onClick={() => pickOther(m)}>
                          {m.name}
                        </Button>
                      </span>
                    ))}
                    .{" "}
                  </>
                )}
                {recent.length > 0 && `Recent: ${recent.slice(0, 3).join(", ")}.`}
              </p>
            )}
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
          </>
        )}
      </div>
    </div>
  );
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
 * added by itself unless the art looks like another card too; one read as text only when the read
 * was sure. A typed name, or a less certain read, waits for Add.
 */
export function addsByIdentity(f: Pick<Found, "method" | "confidence" | "others">): boolean {
  const typed = f.method === "name" && f.confidence === 1;
  if (typed) return false;
  return f.method === "art" ? f.others.length === 0 : f.confidence >= SURE;
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
    case "picked":
      return f.options.length > 1 ? `${by}. You picked the printing; it wasn't read from the card.` : `${by}. You picked the printing.`;
    default:
      if (f.options.length === 0) return `${by}. Yama's card data has no printing of it.`;
      return f.sameArt ? `${by}. ${f.options.length} printings share this art: pick yours.` : `${by}. Pick the printing.`;
  }
}

/** Save scan photos (samples.ts): off unless turned on, per device. */
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
          <strong>Save scan photos.</strong> Keep a small photo of each card you add or correct, with what it was, so the scanner can be tested and trained on real cards. They stay in your account, used for nothing else and shown to no one.
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
