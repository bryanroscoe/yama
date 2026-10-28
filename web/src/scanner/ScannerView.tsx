// Camera scanner. Hold a card anywhere in view: the art recognizer (recognizer.ts, in a worker)
// finds it, outlines it and names it from its artwork, usually within a frame or two. The
// printing comes from the printings that share that art: settled when there's only one, read
// from the collector line when there are several, and otherwise picked by the person. Nothing
// is filed under a guessed printing.
//
// When the recognition bundle isn't available (the server is still downloading it, or an old
// browser), or a card's art isn't in it (new sets, battles), the scanner reads text with
// Tesseract instead (pipeline.ts), as it did before.
//
// Needs a secure context for the camera (https or localhost). "Use a photo" works anywhere.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, shortDate, usd, type Printing } from "../api";
import { loadArtRecognizer, RECOGNIZER_SHORT_SIDE, type ArtRecognizer, type LoadState } from "./artClient";
import { NameIndex } from "./fuzzy";
import { rectQuad } from "./image";
import { readCloseup, readCollectorLine, scanFrame, SURE } from "./pipeline";
import { choosePrinting, printingOptions } from "./printings";
import type { ArtMatch, Recognition } from "./recognizer";
import { createServerCatalog } from "./serverCatalog";
import { createTesseractOcr, type TesseractOcr } from "./tesseract";
import type { OcrEngine, Quad, RgbaImage, ScanCandidate, ScanCatalog, ScanResult } from "./types";
import "./scanner.css";

export interface ScannerViewProps {
  /** Called when the person confirms a card. Without it the scanner only shows what it found. */
  onAccept?: (card: ScanCandidate, copies: number) => void;
  /** For reading text: defaults to the server lookup plus the offline card names. */
  catalog?: ScanCatalog;
  /** For reading text: defaults to tesseract.js. */
  ocr?: OcrEngine;
  onClose?: () => void;
  /** Copies added since the scanner opened, for the "Added 3 so far" chip. */
  addedCount?: number;
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
  how: "only" | "collector" | "picked" | null;
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

const candidateOf = (f: Found, p: Printing | null): ScanCandidate => ({
  name: p?.name ?? f.name,
  set: p?.set_code,
  number: p?.collector_number,
  lang: p?.lang,
  scryfall_id: p?.scryfall_id,
  image: p?.image_normal,
  confidence: f.confidence,
  method: f.method,
});

export function ScannerView({ onAccept, catalog: catalogProp, ocr: ocrProp, onClose, addedCount = 0, recent = [], finish = "nonfoil", controls, acceptLabel = "Add", renderResult, identityOnly = false }: ScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const artRef = useRef<ArtRecognizer | null>(null);
  const textRef = useRef<Promise<{ ocr: OcrEngine; catalog: ScanCatalog; names: NameIndex }> | null>(null);
  const ownedOcr = useRef<TesseractOcr | null>(null);
  const last = useRef<{ index: number; card?: ScanCandidate; at: number } | undefined>(undefined);
  /** The art just accepted: not found again until the card leaves or another one shows. */
  const blocked = useRef<number | null>(null);
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

  const ocrRef = useRef<Promise<OcrEngine> | null>(null);
  /** False once the scanner closes: work finishing after that must clean up after itself. */
  const alive = useRef(true);
  /** Tesseract, started on first use. */
  const ocrEngine = useCallback(() => {
    // Served by the app (scripts/copy-ocr.mjs), so it works offline and loads nothing from a CDN.
    ocrRef.current ??= ocrProp
      ? Promise.resolve(ocrProp)
      : createTesseractOcr({ workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang" }).then((o) => {
          if (!alive.current) {
            void o.terminate();
            throw new Error("The scanner is closed");
          }
          return (ownedOcr.current = o);
        });
    ocrRef.current.catch(() => (ocrRef.current = null));
    return ocrRef.current;
  }, [ocrProp]);
  /** The text reader (Tesseract plus every card name), started on first use. */
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
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /** Settle the printing of what was found (not needed when only the card's identity matters). */
  const settle = useCallback(
    async (seq: number, f: Found, query: { art?: string | null; id?: string; name?: string }, read?: { image: RgbaImage; quad: Quad } | null, known?: { set?: string; number?: string }) => {
      const update = (patch: Partial<Found>) => {
        if (foundSeq.current === seq) setFound((cur) => (cur ? { ...cur, ...patch } : cur));
      };
      try {
        const opts = await printingOptions(query);
        let choice = choosePrinting(opts);
        // Read from the collector line by the text reader already.
        if (!choice.chosen && known?.set && known.number) {
          const hit = opts.printings.find((p) => p.set_code === known.set && p.collector_number === known.number);
          if (hit) choice = { chosen: hit, how: "collector", options: [hit, ...choice.options.filter((p) => p !== hit)] };
        }
        const reading = !choice.chosen && !!read;
        update({ options: choice.options, sameArt: opts.sameArt, chosen: choice.chosen, how: choice.how, reading });
        if (!reading) return;
        // Several printings share the art: read the collector line to tell them apart.
        const text = await readCollectorLine(read!.image, read!.quad, await ocrEngine());
        // One read from the whole-card view settles it only when it's proof; otherwise the guess goes
        // first in the picker and the close-up step confirms it.
        const byLine = choosePrinting(opts, text);
        update({ options: byLine.options, chosen: byLine.certain ? byLine.chosen : null, how: byLine.certain ? byLine.how : null, raw: text, reading: false });
      } catch (e) {
        update({ options: [], reading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [ocrEngine],
  );

  /** Show a card recognised by its art. `read` is a sharp view of it for the collector line. */
  const showArt = useCallback(
    (r: Recognition, top: ArtMatch, read: { image: RgbaImage; quad: Quad } | null) => {
      const seq = ++foundSeq.current;
      const f: Found = {
        name: top.name,
        method: "art",
        confidence: top.score,
        art: top,
        others: r.matches.slice(1).filter((m, i, all) => m.name !== top.name && m.score >= top.score - 0.2 && all.findIndex((x) => x.name === m.name) === i),
        options: null,
        sameArt: true,
        chosen: null,
        how: null,
        picking: false,
        ms: r.timings.totalMs,
      };
      setFound(f);
      setShowAll(false);
      setCopies(1);
      setPhase("found");
      navigator.vibrate?.(30);
      if (!identityOnly) void settle(seq, f, { art: top.illustrationId, id: top.id }, read);
    },
    [identityOnly, settle],
  );

  /** Show a card read as text. */
  const showText = useCallback(
    (res: ScanResult) => {
      const best = res.candidates[0]!;
      const seq = ++foundSeq.current;
      const f: Found = {
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
      setCopies(1);
      setPhase("found");
      navigator.vibrate?.(30);
      if (!identityOnly) void settle(seq, f, { name: best.name }, null, { set: best.set, number: best.number });
    },
    [identityOnly, settle],
  );

  /** A text read: lock on the same card twice, or once when it's certain. */
  const handleText = useCallback(
    (res: ScanResult, single: boolean) => {
      const best = res.candidates[0];
      if (!best) return false;
      const seen = last.current && Date.now() - last.current.at < 2500 ? last.current.card : undefined;
      const lock = single || best.confidence >= 0.95 || (best.confidence >= 0.6 && sameCard(best, seen));
      last.current = { index: -1, card: best, at: Date.now() };
      if (lock) showText(res);
      else setStatus(`Hold still: ${best.name}?`);
      return lock;
    },
    [showText],
  );

  // Read loop: one frame at a time.
  useEffect(() => {
    if (phase !== "scanning" || !mode || closeup || photoBusy) return;
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
          const { image, k } = small(v, v.videoWidth, v.videoHeight, canvasRef.current);
          const r = await art.identify(image);
          if (stop) return;
          setOutline(r.quad ? { quad: scaleQuad(r.quad, 1 / k), w: v.videoWidth, h: v.videoHeight } : null);
          const top = r.matches[0];
          if (!r.quad || !top) {
            blocked.current = null;
            last.current = undefined;
            unknownFrames = 0;
            setStatus("Hold a card in view");
            return next(60);
          }
          if (blocked.current !== null) {
            if (top.index !== blocked.current || top.score < ART_UNKNOWN) blocked.current = null;
            else {
              setStatus("Ready for the next card");
              return next(60);
            }
          }
          const prev = last.current && last.current.index === top.index && Date.now() - last.current.at < 1500;
          last.current = { index: top.index, at: Date.now() };
          if (top.score >= LOCK_ONCE || (top.score >= LOCK_TWICE && prev)) {
            unknownFrames = 0;
            const read = identityOnly ? null : around(v, v.videoWidth, v.videoHeight, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
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
            const reader = await textReader();
            if (stop) return;
            const quad = scaleQuad(r.quad, 1 / k);
            const hi = around(v, v.videoWidth, v.videoHeight, quad, hiCanvasRef.current);
            // One orientation per attempt, so the camera stays responsive.
            const res = await readAt(hi.image, hi.quad, reader, [quarterTurns(hi.quad)[textFrame++ % 3]!]);
            if (!stop && handleText(res, false)) return;
            // Still nothing: ask for a close-up of the name.
            if (!stop && !res.candidates[0] && ++failedReads >= TITLE_AFTER) {
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
        if (!stop && handleText(res, false)) return;
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
  }, [phase, mode, closeup, photoBusy, identityOnly, showArt, handleText, textReader]);

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
        const top = r.matches[0];
        if (r.quad && top && top.score >= LOCK_TWICE) {
          const read = identityOnly ? null : around(bmp, bmp.width, bmp.height, scaleQuad(r.quad, 1 / k), hiCanvasRef.current);
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
            if (current()) handleText(res, true);
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
      if (!res || !handleText(res, true)) setStatus("Couldn't read that photo. Fill the photo with the card, or type the name.");
    } catch (err) {
      if (current()) setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  /** A card typed by name: straight to its printings. */
  const fromName = (name: string, how: "typed" | "name" = "typed") => {
    const seq = ++foundSeq.current;
    const f: Found = { name, method: "name", confidence: how === "typed" ? 1 : 0.9, others: [], options: null, sameArt: false, chosen: null, how: null, picking: false };
    setFound(f);
    setShowAll(false);
    setCopies(1);
    setPhase("found");
    if (!identityOnly) void settle(seq, f, { name });
  };

  /** Back to scanning. The card just shown isn't found again until it leaves the view. */
  const again = () => {
    foundSeq.current += 1;
    blocked.current = found?.art ? found.art.index : null;
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
    showArt({ quad: null, upright: 1, matches: [m, found.art, ...found.others.filter((o) => o !== m)], timings: { detectMs: 0, embedMs: 0, totalMs: found.ms ?? 0 } }, m, null);
  };

  // Step 2 starts by itself when the printing isn't settled: several share the art and the
  // collector line couldn't be read from the whole-card view.
  const needsCollector = live && phase === "found" && !identityOnly && !!found?.options && found.options.length > 1 && !found.chosen && !found.reading;
  useEffect(() => {
    if (needsCollector) setCloseup("collector");
  }, [needsCollector]);
  useEffect(() => {
    if (phase !== "found" && closeup === "collector") setCloseup(null);
    if (phase === "found" && closeup === "title") setCloseup(null);
  }, [phase, closeup]);

  // The close-up loop: read the box as text until it settles the printing or the name.
  useEffect(() => {
    if (!closeup) return;
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
            setFound((cur) => (cur && cur === f ? { ...cur, chosen: chosenNow, how: "collector", options: c.options, raw: text } : cur));
            setCloseup(null);
            navigator.vibrate?.(30);
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
  }, [closeup, ocrEngine, textReader]);

  const chosen = found?.chosen ?? null;
  const ready = identityOnly || !!chosen;
  const price = chosen ? (finish === "foil" ? chosen.usd_foil : chosen.usd) : null;
  const isFound = phase === "found" && !!found;
  const options = found?.options ?? null;
  const showPicker = !identityOnly && !!found && !!options && options.length > 1 && !found.reading && (found.picking || !chosen);
  const loadingText =
    loadState?.kind === "downloading"
      ? `Getting card recognition ready (${Math.round(loadState.loaded / 1e6)} of ${Math.round(loadState.total / 1e6)} MB, once)`
      : loadState?.kind === "preparing"
        ? "Getting card recognition ready"
        : "Getting the scanner ready";

  return (
    <div className="scan">
      <div className="scan-camera">
        <video ref={videoRef} className="scan-video" playsInline muted autoPlay aria-hidden="true" />
        {outline && phase === "scanning" && !closeup && (
          <svg className="scan-outline" viewBox={`0 0 ${outline.w} ${outline.h}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <polygon points={outline.quad.map((p) => p.join(",")).join(" ")} />
          </svg>
        )}
        <div className="scan-frame" aria-hidden="true">
          {closeup ? (
            <div ref={closeRef} className={`scan-closeup is-${closeup}`} />
          ) : (
            <div ref={guideRef} className={`scan-guide${mode === "art" ? " is-hint" : ""}${phase === "found" ? " is-locked" : ""}`} />
          )}
        </div>
        {onClose && (
          <button className="scan-close" onClick={onClose} aria-label="Close the scanner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
        {addedCount > 0 && <span className="scan-count">Added {addedCount} so far</span>}
        <span className={`scan-chip${isFound ? " found" : ""}`} role="status">
          {isFound ? "Found it" : mode ? status : loadingText}
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
              <button onClick={() => setCloseup(null)}>Back to scanning</button>
              <NameEntry onPick={(n) => fromName(n)} />
            </div>
          </div>
        )}
        {!isFound && closeup !== "title" && (
          <>
            {error && <p className="error">{error}</p>}
            {controls}
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
                <button className="scan-photo" onClick={() => setCloseup("title")}>
                  Read the name up close
                </button>
              )}
            </div>
            {mode === "text" && <p className="scan-note">Card recognition isn't available right now, so the scanner is reading text. Line the card up with the frame.</p>}
            {recent.length > 0 && <p className="scan-note">Recent: {recent.slice(0, 3).join(", ")}.</p>}
          </>
        )}
        {isFound && found && (
          <>
            <div className="scan-result">
              {chosen?.image_normal ? <img className="scan-thumb" src={chosen.image_normal} alt={chosen.name} /> : <div className="scan-thumb card-fallback">{found.name}</div>}
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
                <span className="scan-method">{explain(found, identityOnly)}</span>
                {!identityOnly && chosen && options && options.length > 1 && !found.picking && (
                  <button className="scan-alt" onClick={() => setFound({ ...found, picking: true })}>
                    Change printing ({options.length})
                  </button>
                )}
              </div>
            </div>
            {closeup === "collector" && options && (
              <div className="scan-step">
                <p>
                  <strong>Step 2: the printing.</strong> Hold the phone close to the card's bottom-left corner, so the set code and number fill the box. Or tap the printing below.
                </p>
                {closeupRead && <p className="scan-note">Reading: {closeupRead}</p>}
              </div>
            )}
            {live && !identityOnly && !closeup && !chosen && options && options.length > 1 && !found.reading && (
              <button className="scan-alt" onClick={() => setCloseup("collector")}>
                Read the collector number up close
              </button>
            )}
            {showPicker && options && (
              <div className="scan-printings" role="listbox" aria-label="Printings">
                {(showAll ? options : options.slice(0, PICKER_FIRST)).map((p) => (
                  <button
                    key={p.scryfall_id}
                    role="option"
                    aria-selected={p === chosen}
                    className={`scan-printing${p === chosen ? " is-chosen" : ""}`}
                    onClick={() => {
                      setCloseup(null);
                      setFound({ ...found, chosen: p, how: "picked", picking: false });
                    }}
                  >
                    {p.image_small ? <img src={p.image_small} alt="" loading="lazy" /> : <span className="card-fallback">{p.name}</span>}
                    <span className="scan-printing-set">{p.set_name}</span>
                    <span className="dim">
                      #{p.collector_number}
                      {p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}
                      {p.lang !== "en" ? `, ${p.lang}` : ""}
                    </span>
                  </button>
                ))}
                {!showAll && options.length > PICKER_FIRST && (
                  <button className="scan-alt" onClick={() => setShowAll(true)}>
                    Show all {options.length}
                  </button>
                )}
              </div>
            )}
            {found.error && <p className="error">{found.error}</p>}
            {renderResult?.(candidateOf(found, chosen))}
            {controls}
            <div className="scan-buttons">
              {onAccept && (
                <div className="scan-accept">
                  {!identityOnly && (
                    <label className="scan-copies">
                      Copies
                      <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="primary"
                    disabled={!ready}
                    onClick={() => {
                      onAccept(candidateOf(found, chosen), copies);
                      again();
                    }}
                  >
                    {ready ? acceptLabel : options && !found.reading ? "Pick the printing" : "Finding the printing…"}
                  </button>
                </div>
              )}
              <button onClick={again}>{onAccept ? "Not this" : "Scan next"}</button>
            </div>
            {(found.others.length > 0 || recent.length > 0) && (
              <p className="scan-note">
                {found.others.length > 0 && (
                  <>
                    Not this card? It might be{" "}
                    {found.others.map((m, i) => (
                      <span key={m.index}>
                        {i > 0 && " or "}
                        <button className="scan-alt" onClick={() => pickOther(m)}>
                          {m.name}
                        </button>
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

function explain(f: Found, identityOnly: boolean): string {
  const by = f.method === "art" ? "Recognized by its art" : f.method === "name" ? (f.confidence === 1 ? "Typed by name" : "Read from the card's name") : "Read from the collector number";
  if (identityOnly) return `${by}. Check the card name.`;
  if (f.options === null) return `${by}. Finding the printing…`;
  if (f.reading) return `${by}. ${f.options.length} printings share this art; reading the collector number…`;
  switch (f.how) {
    case "only":
      return f.sameArt ? `${by}. It's the only printing with this art.` : `${by}. It's the card's only printing.`;
    case "collector":
      return f.method === "art" ? `${by}; the collector number picked the printing.` : `${by}.`;
    case "picked":
      return `${by}. You picked the printing.`;
    default:
      if (f.options.length === 0) return `${by}. Yama's card data has no printing of it.`;
      return f.sameArt ? `${by}. ${f.options.length} printings share this art: pick yours.` : `${by}. Pick the printing.`;
  }
}

/** Type a card's name instead of scanning it. */
function NameEntry({ onPick }: { onPick: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return setNames([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      api<string[]>(`/api/cards/autocomplete?q=${encodeURIComponent(t)}`)
        .then((r) => !cancelled && setNames(r.slice(0, 6)))
        .catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <div className="scan-name">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or type the name" aria-label="Card name" autoComplete="off" />
      {names.length > 0 && (
        <ul className="scan-name-list">
          {names.map((n) => (
            <li key={n}>
              <button
                onClick={() => {
                  setQ("");
                  setNames([]);
                  onPick(n);
                }}
              >
                {n}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
