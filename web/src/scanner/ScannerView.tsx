// Camera scanner: a card-shaped guide over the live camera. Every few hundred milliseconds the
// part of the frame around the guide is read; when the same card comes back twice (or once
// with high confidence) the scanner locks and shows it.
//
// Needs a secure context for the camera (https or localhost; a phone on the LAN dev server over
// plain http gets no camera, so "Use a photo" is offered as a fallback).

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NameIndex } from "./fuzzy";
import { rectQuad } from "./image";
import { scanFrame, SURE } from "./pipeline";
import { api, shortDate, usd, type Printing } from "../api";
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
  /** Copies added since the scanner opened, for the "Added 3 so far" chip. */
  addedCount?: number;
  /** Names of the last few cards added, newest first. */
  recent?: string[];
  /** The finish being added, so the found card shows that finish's price. */
  finish?: "nonfoil" | "foil";
  /** Choices shown in the panel (finish, where to put the card). */
  controls?: ReactNode;
  /** The accept button's words. */
  acceptLabel?: string;
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

export function ScannerView({ onAccept, catalog: catalogProp, ocr: ocrProp, intervalMs = 250, onClose, addedCount = 0, recent = [], finish = "nonfoil", controls, acceptLabel = "Add" }: ScannerViewProps) {
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
        const catalog = catalogProp ?? (await createServerCatalog({ setCodes: await api<string[]>("/api/sets").catch(() => undefined) }));
        let ocr = ocrProp;
        // Served by the app (scripts/copy-ocr.mjs), so scanning works offline and loads nothing from a CDN.
        if (!ocr) ocr = owned = await createTesseractOcr({ workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang" });
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
    try {
      const bmp = await createImageBitmap(file);
      canvasRef.current ??= document.createElement("canvas");
      const { image } = grab(bmp, 0, 0, bmp.width, bmp.height, canvasRef.current);
      // A photo cropped to the card (a scan, a screenshot) is the card: try that first, as is.
      // Otherwise assume the card is centred; try a few sizes and let the edge finder correct each.
      let res: ScanResult | null = null;
      const cropped = Math.abs(image.height / image.width - CARD_ASPECT) < 0.06;
      const tries: { fill: number; refine: boolean }[] = [
        ...(cropped ? [{ fill: 1, refine: false }] : []),
        { fill: 0.9, refine: true },
        { fill: 0.78, refine: true },
        { fill: 0.65, refine: true },
      ];
      for (const { fill, refine } of tries) {
        const h = Math.min(image.height * fill, image.width * fill * CARD_ASPECT);
        const w = h / CARD_ASPECT;
        const guide = rectQuad((image.width - w) / 2, (image.height - h) / 2, w, h);
        const r = await scanFrame(image, { ...e, guide, refine });
        if (!res || (r.candidates[0]?.confidence ?? 0) > (res.candidates[0]?.confidence ?? 0)) res = r;
        if ((res.candidates[0]?.confidence ?? 0) >= SURE) break;
      }
      if (!res || !handle(res, true)) setStatus("Couldn't read that photo. Fill the photo with the card and try again.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const again = () => {
    last.current = undefined;
    setResult(null);
    setPhase(videoRef.current?.srcObject ? "scanning" : "no-camera");
  };

  const best = result?.candidates[0];
  // The printing's set name and market price, once the collector line has been read.
  const printing = useQuery({
    queryKey: ["scan-printing", best?.set, best?.number, best?.lang],
    queryFn: () => api<Printing>(`/api/printings/lookup?${new URLSearchParams({ set: best!.set!, number: best!.number!, lang: best!.lang ?? "en" })}`),
    enabled: phase === "found" && !!best?.set && !!best?.number,
    retry: false,
    staleTime: Infinity,
  });
  const p = printing.data;
  const price = p ? (finish === "foil" ? p.usd_foil : p.usd) : undefined;
  const found = phase === "found" && !!best;
  return (
    <div className="scan">
      <div className="scan-camera">
        <video ref={videoRef} className="scan-video" playsInline muted autoPlay aria-hidden="true" />
        <div className="scan-frame" aria-hidden="true">
          <div ref={guideRef} className={`scan-guide${phase === "found" ? " is-locked" : ""}`} />
        </div>
        {onClose && (
          <button className="scan-close" onClick={onClose} aria-label="Close the scanner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
        {addedCount > 0 && <span className="scan-count">Added {addedCount} so far</span>}
        <span className={`scan-chip${found ? " found" : ""}`} role="status">
          {found ? "Found it" : ready ? status : "Getting the reader ready"}
        </span>
      </div>

      <div className="scan-panel" aria-live="polite">
        {!found && (
          <>
            {error && <p className="error">{error}</p>}
            {controls}
            <label className="scan-photo button">
              Use a photo instead
              <input type="file" accept="image/*" capture="environment" onChange={(ev) => ev.target.files?.[0] && void fromPhoto(ev.target.files[0])} />
            </label>
            {recent.length > 0 && <p className="scan-note">Recent: {recent.slice(0, 3).join(", ")}.</p>}
          </>
        )}
        {found && best && (
          <>
            <div className="scan-result">
              {best.image ? <img className="scan-thumb" src={best.image} alt={best.name} /> : <div className="scan-thumb card-fallback">{best.name}</div>}
              <div className="scan-info">
                <h3>{best.name}</h3>
                <span className="dim">
                  {best.set ? `${p?.set_name ?? best.set.toUpperCase()} #${best.number}` : "Printing not read"}
                  {best.lang && best.lang !== "en" ? `, ${best.lang}` : ""}
                  {`, ${finish === "foil" ? "foil" : "regular"}`}
                </span>
                {best.set && !printing.isPending && (
                  <span>
                    {usd(price)}
                    {price != null && <span className="dim"> market, {shortDate(p?.price_date) ?? "date unknown"}</span>}
                  </span>
                )}
                <span className="scan-method">{describe(best)}</span>
              </div>
            </div>
            {controls}
            <div className="scan-buttons">
              {onAccept && (
                <button className="primary" onClick={() => { onAccept(best); again(); }}>
                  {acceptLabel}
                </button>
              )}
              <button onClick={again}>{onAccept ? "Not this" : "Scan next"}</button>
            </div>
            {(result.candidates.length > 1 || recent.length > 0) && (
              <p className="scan-note">
                {result.candidates.length > 1 && (
                  <>
                    Not this one? {onAccept ? "Add" : "It might be"}{" "}
                    {result.candidates.slice(1).map((c, i) => (
                      <span key={`${c.name}${c.set ?? ""}${c.number ?? ""}`}>
                        {i > 0 && " or "}
                        <button className="scan-alt" onClick={() => { onAccept?.(c); again(); }}>
                          {c.name}
                          {c.set ? ` (${c.set.toUpperCase()} ${c.number})` : ""}
                        </button>
                      </span>
                    ))}
                    {onAccept ? " instead" : ""}.{" "}
                  </>
                )}
                {recent.length > 0 && `Recent: ${recent.slice(0, 3).join(", ")}.`}
              </p>
            )}
            <details className="small dim">
              <summary>What the camera read</summary>
              <pre className="scan-raw">{`${result.raw.collector}\n${result.raw.name}\n${Math.round(result.timings.totalMs)} ms`}</pre>
            </details>
          </>
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
