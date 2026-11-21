// Runs the scanner speed test (speed.ts; docs/scanner.md, "Speed test"): fetches a few cards'
// Scryfall pictures, draws synthetic camera frames of them, and sends each frame through a fresh
// art worker (artClient.ts, the scanner's own path, so worker messaging counts) for this device's
// models, the defaults and the faster options in turn, one worker at a time; then times the
// printing look in a look worker of its own. Nothing here runs unless the person presses the
// button, and the scanner's own loop is paused meanwhile (Scan settings is open).

import { api, API_BASE } from "../api";
import { BUILD_COMMIT, BUILD_TIME } from "../version";
import { isNative } from "../native";
import { Updater } from "../nativeUpdate";
import { loadArtRecognizer, scanBundleInfo, type ArtRecognizer, type BundleInfo, type LoadState } from "./artClient";
import type { LookTiming, LookWorkerReply, LookWorkerRequest, WireFrame } from "./look";
import { defaultOption, modelsOf, running, savedModels, type DeviceCan, type ModelChoices, type ModelOption, type ModelsInfo } from "./models";
import { printingOptions } from "./printings";
import type { Recognition } from "./recognizer";
import {
  captureEnv,
  configStats,
  deviceLabel,
  FAST_ART,
  FAST_DETECTOR,
  FRAMES_PER_CARD,
  placedQuad,
  placement,
  SPEED_CARDS,
  SPEED_FRAME,
  SPEED_REPORT_VERSION,
  SPEED_RUNTIME,
  stat,
  within,
  type ConfigResult,
  type FrameTime,
  type LookResult,
  type ModelPair,
  type Placement,
  type SpeedCard,
  type SpeedEnv,
  type SpeedReport,
  type SpeedRole,
  CARD_ASPECT,
} from "./speed";
import type { RgbaImage } from "./types";

/** What the test is doing, for the line under the button. */
export interface SpeedProgress {
  text: string;
  /** Steps done of all, for a bar. */
  done: number;
  total: number;
}

/** A card's picture, ready to draw. */
export interface CardPicture {
  card: SpeedCard;
  url: string;
  image: CanvasImageSource & { width: number; height: number };
}

/** A look worker for timing (look.worker.ts's `time`). */
export interface LookTimer {
  time(url: string, frame: WireFrame | null): Promise<LookTiming>;
  dispose(): void;
}

/** What the run uses from the browser and the app: the real ones by default, fakes in tests. */
export interface SpeedDeps {
  now(): number;
  env(): Promise<SpeedEnv>;
  bundleInfo(): Promise<BundleInfo | null>;
  choices(): ModelChoices;
  /** Exactly these models (no falling back to the defaults); `signal` ends a load under way. */
  loadRecognizer(info: BundleInfo, art: ModelOption, detector: ModelOption, onState: (s: LoadState) => void, signal?: AbortSignal): Promise<ArtRecognizer | null>;
  picture(card: SpeedCard, signal?: AbortSignal): Promise<CardPicture>;
  frame(picture: CardPicture, p: Placement): RgbaImage;
  lookTimer(option: ModelOption, signal?: AbortSignal): Promise<LookTimer>;
}

/** The art slot and card finder have files: the text reader's list doesn't matter here. */
const CAN: DeviceCan = { text: [] };

const pair = (detector: ModelOption, art: ModelOption): ModelPair => ({ detector: { id: detector.id, label: detector.label }, art: { id: art.id, label: art.label } });

interface Planned {
  roles: SpeedRole[];
  detector: ModelOption;
  art: ModelOption;
}

/**
 * The configurations to time: this device's choices, the defaults, and the faster options (each
 * faster one only if the server offers it, so it's downloaded or downloadable, standing in for the
 * default where the other isn't), each pair once with every role it fills.
 */
export function speedConfigs(models: ModelsInfo, choices: ModelChoices): Planned[] {
  const detector = running(models, "detector", choices.detector, CAN).option;
  const art = running(models, "art", choices.art, CAN).option;
  const baseDetector = defaultOption(models, "detector", CAN);
  const baseArt = defaultOption(models, "art", CAN);
  if (!detector?.file || !art?.file || !baseDetector?.file || !baseArt?.file) return [];
  const fastDetector = models.detector.options.find((o) => o.id === FAST_DETECTOR && o.file);
  const fastArt = models.art.options.find((o) => o.id === FAST_ART && o.file);
  const wanted: Planned[] = [
    { roles: ["yours"], detector, art },
    { roles: ["defaults"], detector: baseDetector, art: baseArt },
  ];
  if (fastDetector || fastArt) wanted.push({ roles: ["faster"], detector: fastDetector ?? baseDetector, art: fastArt ?? baseArt });
  const out: Planned[] = [];
  for (const w of wanted) {
    const same = out.find((o) => o.detector.id === w.detector.id && o.art.id === w.art.id);
    if (same) same.roles.push(...w.roles);
    else out.push({ ...w, roles: [...w.roles] });
  }
  return out;
}

/** The look option to time: this device's, or the slot's default when its look is off. */
export function lookToTime(models: ModelsInfo, choices: ModelChoices): ModelOption | null {
  const mine = running(models, "look", choices.look, CAN).option;
  if (mine?.file) return mine;
  const d = defaultOption(models, "look", CAN);
  return d?.file ? d : (models.look.options.find((o) => o.file) ?? null);
}

const stopped = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("The speed test was stopped");
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const round = (v: number) => Math.round(v * 10) / 10;

/** Whether a recognition put this card first (or another printing with its art). */
const isRight = (r: Recognition, card: SpeedCard) => {
  const top = r.matches[0];
  return !!top && (top.id === card.id || (!!card.illustrationId && top.illustrationId === card.illustrationId));
};

/**
 * Run the test: the stats and the device's environment, as a report (whatever part of it ran).
 * Rejects only when nothing could run, or when `signal` stops it, which ends any worker under way
 * at once. Reusable: the panel in Scan settings runs it on a tap, and a later scanner may run it
 * quietly at start to say when a phone is slow (docs/plans/scanner-match-cardvision.md, item 29).
 */
export async function runSpeedTest(onProgress: (p: SpeedProgress) => void, signal?: AbortSignal, deps: SpeedDeps = browserDeps()): Promise<SpeedReport> {
  const t0 = deps.now();
  const startedAt = new Date().toISOString();
  // The device first, so asking for a WebGPU adapter never overlaps a timed load.
  const env = await deps.env();
  stopped(signal);
  const info = await deps.bundleInfo();
  if (!info?.ready || !info.constants) throw new Error("Card recognition isn't ready on the server yet, so there's nothing to time.");
  const models = modelsOf(info);
  const choices = deps.choices();
  const plan = speedConfigs(models, choices);
  if (plan.length === 0) throw new Error("This server offers no card finder and art model to time.");
  const lookOption = lookToTime(models, choices);
  const steps = plan.length * (SPEED_CARDS + 1) + (lookOption ? SPEED_CARDS : 0) + 1;
  let done = 0;
  const say = (text: string, step = 0) => {
    done += step;
    onProgress({ text, done, total: steps });
  };

  let pictures: CardPicture[] | null = null;
  const configs: ConfigResult[] = [];
  for (const p of plan) {
    stopped(signal);
    const name = `${p.detector.label} and ${p.art.label}`;
    const result: ConfigResult = { roles: p.roles, runtime: SPEED_RUNTIME, wanted: pair(p.detector, p.art), ran: null, loadMs: null, downloaded: false, firstFrameMs: null, stats: null, found: 0, right: 0, frames: [], error: null };
    configs.push(result);
    let rec: ArtRecognizer | null = null;
    // Stopped: the worker goes at once (a frame under way is refused), not at the next step.
    const end = () => rec?.dispose();
    signal?.addEventListener("abort", end, { once: true });
    try {
      say(`Loading ${name}`);
      const l0 = deps.now();
      rec = await deps.loadRecognizer(
        info,
        p.art,
        p.detector,
        (s) => {
          if (s.kind === "downloading") {
            result.downloaded = true;
            say(`Downloading ${name}: ${Math.round((100 * s.loaded) / Math.max(1, s.total))}%`);
          }
        },
        signal,
      );
      if (!rec) throw new Error("Card recognition can't run in this browser");
      stopped(signal);
      result.loadMs = round(deps.now() - l0);
      result.ran = { detector: rec.detector, art: rec.art };
      // Never another model's times under this one's name.
      if (rec.detector !== p.detector.id || rec.art !== p.art.id) throw new Error(`${name} didn't load (${rec.detector} and ${rec.art} ran instead), so it wasn't timed`);
      say(`Loaded ${name}`, 1);
      if (!pictures) {
        stopped(signal);
        const cards = (await rec.sample?.(SPEED_CARDS)) ?? [];
        if (cards.length === 0) throw new Error("The card recognizer gave no cards to show");
        say("Getting the cards' pictures from Scryfall");
        const got = await Promise.allSettled(cards.map((c) => deps.picture(c, signal)));
        const ok = got.flatMap((g) => (g.status === "fulfilled" ? [g.value] : []));
        if (ok.length < 2) throw new Error("Couldn't get the cards' pictures from Scryfall");
        pictures = ok;
      }
      for (const [ci, pic] of pictures.entries()) {
        stopped(signal);
        say(`Timing ${name}: card ${ci + 1} of ${pictures.length}`);
        rec.reset();
        for (let f = 0; f < FRAMES_PER_CARD; f++) {
          stopped(signal);
          const at = placement(ci, f);
          const img = deps.frame(pic, at);
          const s0 = deps.now();
          const r = await rec.identify(img);
          const roundMs = deps.now() - s0;
          if (result.firstFrameMs === null) result.firstFrameMs = round(roundMs);
          const runs = r.timings.runs ?? { detector: [], embed: [], search: [] };
          const t: FrameTime = {
            card: ci,
            frame: f,
            fresh: runs.detector.length !== 1,
            roundMs: round(roundMs),
            totalMs: round(r.timings.totalMs),
            detector: runs.detector.map(round),
            embed: runs.embed.map(round),
            search: runs.search.map(round),
            cuts: r.timings.cuts ?? null,
            found: !!r.quad,
            right: isRight(r, pic.card),
          };
          result.frames.push(t);
        }
        done += 1;
      }
      result.found = result.frames.filter((f) => f.found).length;
      result.right = result.frames.filter((f) => f.right).length;
      result.stats = configStats(result.frames);
    } catch (e) {
      if (signal?.aborted) throw e;
      result.error = message(e);
      if (result.frames.length) result.stats = configStats(result.frames);
    } finally {
      signal?.removeEventListener("abort", end);
      rec?.dispose();
    }
    // Without the cards' pictures nothing else can be timed.
    if (!pictures) break;
  }

  let look: LookResult | null = null;
  if (lookOption && pictures) {
    stopped(signal);
    look = await timeLook(lookOption, pictures, deps, signal, (text) => say(text, 1));
  }
  say("Done", 1);
  return {
    version: SPEED_REPORT_VERSION,
    startedAt,
    ms: Math.round(deps.now() - t0),
    bundle: info.version,
    device: deviceLabel(env),
    env,
    choices: Object.fromEntries(Object.entries(choices).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    cards: (pictures ?? []).map(({ card }) => ({ id: card.id, name: card.name, set: card.set, number: card.number })),
    configs,
    look,
  };
}

/**
 * The look on each card: its picture and its first frame (drawn again, with the card's true corners
 * as the quad), embedded once each; the first apart (warm-up).
 */
async function timeLook(
  option: ModelOption,
  pictures: CardPicture[],
  deps: SpeedDeps,
  signal: AbortSignal | undefined,
  say: (text: string) => void,
): Promise<LookResult> {
  const out: LookResult = { runtime: SPEED_RUNTIME, option: option.id, label: option.label, loadMs: null, firstMs: null, picture: stat([]), frame: stat([]), fetch: stat([]), decode: stat([]), error: null };
  let timer: LookTimer | null = null;
  const end = () => timer?.dispose();
  signal?.addEventListener("abort", end, { once: true });
  try {
    const l0 = deps.now();
    timer = await deps.lookTimer(option, signal);
    stopped(signal);
    out.loadMs = round(deps.now() - l0);
    const times: LookTiming[] = [];
    for (const [i, pic] of pictures.entries()) {
      stopped(signal);
      say(`Timing the printing look: card ${i + 1} of ${pictures.length}`);
      const at = placement(i, 0);
      const img = deps.frame(pic, at);
      const wire: WireFrame = { width: img.width, height: img.height, quad: placedQuad(at), buffer: img.data.slice().buffer as ArrayBuffer };
      const t = await timer.time(pic.url, wire);
      if (i === 0) out.firstMs = round(t.pictureMs + (t.frameMs ?? 0));
      else times.push(t);
    }
    out.picture = stat(times.map((t) => t.pictureMs));
    out.frame = stat(times.flatMap((t) => (t.frameMs === null ? [] : [t.frameMs])));
    out.fetch = stat(times.map((t) => t.fetchMs));
    out.decode = stat(times.map((t) => t.decodeMs));
  } catch (e) {
    if (signal?.aborted) throw e;
    out.error = message(e);
  } finally {
    signal?.removeEventListener("abort", end);
    timer?.dispose();
  }
  return out;
}

/** The plain background the cards lie on: a mid grey, so a black border stands out as on a table. */
const BACKGROUND = "#5b6472";
/** Strips the card is drawn in, each a little wider than the one above: a slight perspective. */
const STRIPS = 64;

/** Draw a frame with the card at `p`, and read it back as the recognizer's input. */
export function drawFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pic: CardPicture, p: Placement): RgbaImage {
  const { width, height } = SPEED_FRAME;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(p.cx, p.cy);
  ctx.rotate(p.angle);
  const h = p.width * CARD_ASPECT;
  const sh = pic.image.height / STRIPS;
  for (let i = 0; i < STRIPS; i++) {
    // The strip's width at its middle, from the top edge's (keystone × width) to the bottom's.
    const w = p.width * (p.keystone + ((1 - p.keystone) * (i + 0.5)) / STRIPS);
    ctx.drawImage(pic.image, 0, i * sh, pic.image.width, sh, -w / 2, -h / 2 + (i * h) / STRIPS, w, h / STRIPS + 0.75);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  return { width, height, data: img.data };
}

/** A printing's Scryfall `normal` picture: as the server lists it, else from its ID. */
async function pictureUrl(card: SpeedCard): Promise<string> {
  try {
    const r = await printingOptions({ art: card.illustrationId, id: card.id });
    const p = r.printings.find((x) => x.scryfall_id === card.id);
    if (p?.image_normal) return p.image_normal;
  } catch {
    /* the server's list isn't needed: Scryfall's picture paths follow the ID */
  }
  return `https://cards.scryfall.io/normal/front/${card.id[0]}/${card.id[1]}/${card.id}.jpg`;
}

async function appVersion(): Promise<SpeedEnv["app"]> {
  let native: SpeedEnv["app"]["native"] = null;
  if (isNative()) {
    try {
      const v = await within(Updater.info(), 3000);
      native = { versionName: v.versionName, versionCode: v.versionCode };
    } catch {
      native = null;
    }
  }
  return { web: BUILD_COMMIT, built: BUILD_TIME, native };
}

/** A look worker that loads `option` without touching the printings' cache, for timing; `signal` ends it. */
function startLookTimer(option: ModelOption, signal?: AbortSignal): Promise<LookTimer> {
  const w = new Worker(new URL("./look.worker.ts", import.meta.url), { type: "module" });
  type Answer = Extract<LookWorkerReply, { type: "ready" | "timed" }>;
  const waiting = new Map<number, (m: Answer) => void>();
  let nextId = 1;
  let failed: string | null = null;
  w.onmessage = (e: MessageEvent<LookWorkerReply>) => {
    const m = e.data;
    if (m.type === "ready" || m.type === "timed") {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  };
  /** The worker is gone: everything waiting on it fails. */
  const fail = (why: string) => {
    failed ??= why;
    w.terminate();
    for (const p of waiting.values()) p({ type: "ready", id: 0, error: why });
    waiting.clear();
  };
  w.onerror = (e) => fail(e.message || "The printing look stopped");
  signal?.addEventListener("abort", () => fail("Stopped"), { once: true });
  if (signal?.aborted) fail("Stopped");
  const ask = (m: LookWorkerRequest, transfer: Transferable[] = []) =>
    new Promise<Answer>((resolve) => {
      if (failed) return resolve({ type: "ready", id: 0, error: failed });
      waiting.set(m.id, resolve);
      w.postMessage(m, transfer);
    });
  const base = API_BASE || location.origin;
  return ask({ type: "model", id: nextId++, url: new URL(option.file!, base).href, bytes: option.bytes ?? 0, cache: false }).then((r) => {
    if (r.error) {
      fail(r.error);
      throw new Error(r.error);
    }
    return {
      async time(url, frame) {
        const r = await ask({ type: "time", id: nextId++, url, frame }, frame ? [frame.buffer] : []);
        if (r.error) throw new Error(r.error);
        if (r.type !== "timed") throw new Error("The printing look didn't answer");
        return { fetchMs: r.fetchMs, decodeMs: r.decodeMs, pictureMs: r.pictureMs, frameMs: r.frameMs };
      },
      dispose: () => fail("The look timer was closed"),
    };
  });
}

/** The browser's own pieces. */
export function browserDeps(): SpeedDeps {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  return {
    now: () => performance.now(),
    env: async () => captureEnv(navigator as unknown as Parameters<typeof captureEnv>[0], globalThis as Parameters<typeof captureEnv>[1], await appVersion()),
    bundleInfo: scanBundleInfo,
    choices: savedModels,
    loadRecognizer: (info, art, detector, onState, signal) => loadArtRecognizer(onState, { info, art, detector, fallback: false, signal }),
    async picture(card, signal) {
      const url = await pictureUrl(card);
      // cards.scryfall.io sends Access-Control-Allow-Origin: *, so the picture's pixels can be read.
      const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", signal });
      if (!res.ok) throw new Error(`Couldn't fetch ${card.name}'s picture (${res.status})`);
      const image = await createImageBitmap(await res.blob());
      return { card, url, image };
    },
    frame(pic, p) {
      if (!ctx) {
        canvas = document.createElement("canvas");
        canvas.width = SPEED_FRAME.width;
        canvas.height = SPEED_FRAME.height;
        ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("This browser can't draw the test frames");
      }
      return drawFrame(ctx, pic, p);
    },
    lookTimer: startLookTimer,
  };
}

/** Keep a finished test on the account (POST /api/scan/speed-tests). */
export async function saveSpeedTest(report: SpeedReport): Promise<{ id: string }> {
  return api<{ id: string }>("/api/scan/speed-tests", { method: "POST", json: report });
}

/** How many speed tests the account keeps. */
export async function speedTestCount(): Promise<number> {
  return (await api<{ count: number }>("/api/scan/speed-tests?limit=0")).count;
}

/** Delete every speed test kept on the account. */
export async function deleteSpeedTests(): Promise<{ deleted: number }> {
  return api<{ deleted: number }>("/api/scan/speed-tests", { method: "DELETE" });
}
