// Camera scanner: a card-shaped guide over the live camera. Every few hundred milliseconds the
// part of the frame around the guide is read; when the same card comes back twice (or once
// with high confidence) the scanner locks and shows it.
//
// Needs a secure context for the camera (https or localhost; a phone on the LAN dev server over
// plain http gets no camera, so "Use a photo" is offered as a fallback).

import { useCallback, useEffect, useRef, useState } from "react";
import { NameIndex } from "./fuzzy";
import { rectQuad } from "./image";
import { scanFrame, SURE } from "./pipeline";
import { createServerCatalog } from "./serverCatalog";
import { createTesseractOcr, type TesseractOcr } from "./tesseract";
import type { OcrEngine, Quad, RgbaImage, ScanCandidate, ScanCatalog, ScanResult } from "./types";
import "./scanner.css";

export interface ScannerViewProps {
  /** Called when the user confirms a card. Without it the scanner only shows what it found. */
  onAccept?: (card: ScanCandidate) => void;
  /** Defaults to the server lookup plus the offline card names. */
  catalog?: ScanCatalog;
  /** Defaults to tesseract.js. */
  ocr?: OcrEngine;
  /** Pause between reads. */
  intervalMs?: number;
  onClose?: () => void;
}

type Phase = "loading" | "scanning" | "found" | "no-camera";

/** Extra frame kept around the guide so the edge finder can see the card's edges. */
const MARGIN = 0.12;
/** Long side of the image handed to the pipeline. Keeps small print readable without wasting time. */
const MAX_SIDE = 1500;
const CARD_ASPECT = 88 / 63;

const sameCard = (a: ScanCandidate | undefined, b: ScanCandidate | undefined) =>
  !!a && !!b && a.name === b.name && a.set === b.set && a.number === b.number;

function grab(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, canvas: HTMLCanvasElement): { image: RgbaImage; scale: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { image: ctx.getImageData(0, 0, canvas.width, canvas.height), scale };
}

export function ScannerView({ onAccept, catalog: catalogProp, ocr: ocrProp, intervalMs = 250, onClose }: ScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engine = useRef<{ ocr: OcrEngine; catalog: ScanCatalog; names: NameIndex } | null>(null);
  const last = useRef<{ card: ScanCandidate; at: number } | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("Line the card up with the frame");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // OCR workers and the catalog: once per mount.
  useEffect(() => {
    let cancelled = false;
    let owned: TesseractOcr | null = null;
    (async () => {
      try {
        const catalog = catalogProp ?? (await createServerCatalog());
        let ocr = ocrProp;
        if (!ocr) ocr = owned = await createTesseractOcr();
        const names = new NameIndex(catalog.names());
        if (cancelled) return;
        engine.current = { ocr, catalog, names };
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      engine.current = null;
      void owned?.terminate();
    };
  }, [catalogProp, ocrProp]);

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
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setPhase((p) => (p === "loading" ? "scanning" : p));
      })
      .catch((e: unknown) => {
        setPhase("no-camera");
        setError(e instanceof Error ? `No camera: ${e.message}` : "No camera");
      });
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handle = useCallback((res: ScanResult, single: boolean) => {
    const best = res.candidates[0];
    if (!best) {
      setStatus("Line the card up with the frame");
      return false;
    }
    // The same card twice within a couple of seconds, or once when the read is certain.
    const seen = last.current && Date.now() - last.current.at < 2500 ? last.current.card : undefined;
    const lock = single || best.confidence >= 0.95 || (best.confidence >= 0.6 && sameCard(best, seen));
    last.current = { card: best, at: Date.now() };
    if (lock) {
      setResult(res);
      setPhase("found");
      navigator.vibrate?.(30);
      return true;
    }
    setStatus(`Holding steady: ${best.name}?`);
    return false;
  }, []);

  // Read loop: one frame at a time, a short pause between reads.
  useEffect(() => {
    if (phase !== "scanning" || !ready) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus("Line the card up with the frame");
    let frameNo = 0;
    const tick = async () => {
      if (stop) return;
      const v = videoRef.current;
      const g = guideRef.current;
      const e = engine.current;
      if (v && g && e && v.videoWidth > 0 && document.visibilityState === "visible") {
        // Map the on-screen guide into video pixels (the video is object-fit: cover).
        const vb = v.getBoundingClientRect();
        const gb = g.getBoundingClientRect();
        const s = Math.max(vb.width / v.videoWidth, vb.height / v.videoHeight);
        const ox = vb.left + (vb.width - v.videoWidth * s) / 2;
        const oy = vb.top + (vb.height - v.videoHeight * s) / 2;
        const gx = (gb.left - ox) / s;
        const gy = (gb.top - oy) / s;
        const gw = gb.width / s;
        const gh = gb.height / s;
        const sx = Math.max(0, gx - gw * MARGIN);
        const sy = Math.max(0, gy - gh * MARGIN);
        const sw = Math.min(v.videoWidth, gx + gw * (1 + MARGIN)) - sx;
        const sh = Math.min(v.videoHeight, gy + gh * (1 + MARGIN)) - sy;
        canvasRef.current ??= document.createElement("canvas");
        const { image, scale } = grab(v, sx, sy, sw, sh, canvasRef.current);
        const upright: Quad = rectQuad((gx - sx) * scale, (gy - sy) * scale, gw * scale, gh * scale);
        // Alternate upright and upside-down reads across frames rather than both in one frame.
        const flip = frameNo++ % 2 === 1;
        const guide: Quad = flip ? [upright[2], upright[3], upright[0], upright[1]] : upright;
        try {
          const res = await scanFrame(image, { ...e, guide, tryUpsideDown: false });
          if (!stop && handle(res, false)) return;
        } catch (err) {
          if (!stop) setStatus(err instanceof Error ? err.message : String(err));
        }
      }
      if (!stop) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phase, ready, intervalMs, handle]);

  const fromPhoto = async (file: File) => {
    const e = engine.current;
    if (!e) return setStatus("The reader is still loading. Try again in a moment.");
    setStatus("Reading the photo");
    const bmp = await createImageBitmap(file);
    canvasRef.current ??= document.createElement("canvas");
    const { image } = grab(bmp, 0, 0, bmp.width, bmp.height, canvasRef.current);
    // Assume the card is centred; try a few sizes and let the edge finder correct each.
    let res: ScanResult | null = null;
    for (const fill of [0.9, 0.78, 0.65]) {
      const h = Math.min(image.height * fill, image.width * fill * CARD_ASPECT);
      const w = h / CARD_ASPECT;
      const guide = rectQuad((image.width - w) / 2, (image.height - h) / 2, w, h);
      const r = await scanFrame(image, { ...e, guide });
      if (!res || (r.candidates[0]?.confidence ?? 0) > (res.candidates[0]?.confidence ?? 0)) res = r;
      if ((res.candidates[0]?.confidence ?? 0) >= SURE) break;
    }
    if (!res || !handle(res, true)) setStatus("Couldn't read that photo. Fill the photo with the card and try again.");
  };

  const again = () => {
    last.current = undefined;
    setResult(null);
    setPhase(videoRef.current?.srcObject ? "scanning" : "no-camera");
  };

  const best = result?.candidates[0];
  return (
    <div className="scan">
      <video ref={videoRef} className="scan-video" playsInline muted autoPlay aria-hidden="true" />
      <div className="scan-frame" aria-hidden="true">
        <div ref={guideRef} className={`scan-guide${phase === "found" ? " is-locked" : ""}`} />
      </div>

      <div className="scan-top">
        {onClose && (
          <button className="quiet" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <div className="scan-panel" aria-live="polite">
        {phase !== "found" && (
          <>
            <p className="scan-status">{ready ? status : "Getting the reader ready"}</p>
            {error && <p className="error">{error}</p>}
            <label className="scan-photo button quiet">
              Use a photo instead
              <input type="file" accept="image/*" capture="environment" onChange={(ev) => ev.target.files?.[0] && void fromPhoto(ev.target.files[0])} />
            </label>
          </>
        )}
        {phase === "found" && best && (
          <div className="scan-result">
            {best.image ? <img className="scan-thumb" src={best.image} alt={best.name} /> : <div className="scan-thumb card-fallback">{best.name}</div>}
            <div className="scan-info">
              <h3>{best.name}</h3>
              <p className="dim small">
                {best.set ? `${best.set.toUpperCase()} ${best.number}` : "Printing not read"}
                {best.lang && best.lang !== "en" ? `, ${best.lang}` : ""}
              </p>
              <p className="faint small">{describe(best)}</p>
              <div className="row">
                {onAccept && (
                  <button className="primary" onClick={() => onAccept(best)}>
                    Add
                  </button>
                )}
                <button onClick={again}>Scan next</button>
              </div>
              {result.candidates.length > 1 && (
                <p className="small dim">
                  Or:{" "}
                  {result.candidates.slice(1).map((c) => (
                    <button key={`${c.name}${c.set ?? ""}${c.number ?? ""}`} className="quiet small" onClick={() => onAccept?.(c)}>
                      {c.name}
                    </button>
                  ))}
                </p>
              )}
              <details className="small faint">
                <summary>What the camera read</summary>
                <pre className="scan-raw">{`${result.raw.collector}\n${result.raw.name}\n${Math.round(result.timings.totalMs)} ms`}</pre>
              </details>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function describe(c: ScanCandidate): string {
  switch (c.method) {
    case "collector+name":
      return "Collector number and name both match.";
    case "collector":
      return "Read from the collector number. Check the name.";
    case "name":
      return "Matched by name. Pick the printing yourself.";
  }
}
