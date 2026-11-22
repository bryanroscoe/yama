// Runs the scanner speed test (speed.ts; docs/scanner.md, "Speed test"): fetches a few cards'
// Scryfall pictures, draws synthetic camera frames of them, and sends each frame through a fresh
// art worker (artClient.ts, the scanner's own path, so worker messaging counts) for this device's
// models, the defaults and the faster options in turn, one worker at a time; then times the
// printing look in a look worker of its own. Nothing here runs unless the person presses the
// button, and the scanner's own loop is paused meanwhile (Scan settings is open).

import { api, API_BASE, type Printing } from "../api";
import { BUILD_COMMIT, BUILD_TIME } from "../version";
import { isNative } from "../native";
import { Updater } from "../nativeUpdate";
import { loadArtRecognizer, scanBundleInfo, type ArtRecognizer, type BundleInfo, type LoadState } from "./artClient";
import type { LookTiming, LookWorkerReply, LookWorkerRequest, WireFrame } from "./look";
import { defaultOption, modelsOf, running, savedModels, type DeviceCan, type ModelChoices, type ModelOption, type ModelsInfo } from "./models";
import { finderKey, loadNativeArt, loadNativeFinder, nativeCameraAvailable, nativeEmbed, nativeFind, nativeFinderAbility, NATIVE_GONE, savedNativeCamera, unloadNativeArt, type NativeFound } from "./nativeCamera";
import { NATIVE_RUNTIME, nativeId, nativeWanted, savedNative } from "./nativeModels";
import type { Recognition, RemoteEmbed } from "./recognizer";
import { cachedFile } from "./scanCache";
import {
  captureEnv,
  configStats,
  cornerGap,
  deviceLabel,
  BEFORE_ART,
  BEFORE_DETECTOR,
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
  type FinderParity,
  type FrameTime,
  type LookResult,
  type ModelPair,
  type Placement,
  type SpeedCard,
  type SpeedEnv,
  type SpeedReport,
  type SpeedRole,
  type Alongside,
  CARD_ASPECT,
} from "./speed";
import type { Quad, RgbaImage } from "./types";

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
  /** The card finder in the app's own code (nativeModels.ts), where the app has it. */
  native?: NativeSpeed;
}

/** The app's card finder, for the speed test. */
export interface NativeSpeed {
  /** Whether the app can run it here, and whether this device's scanner does. */
  can(): Promise<{ can: boolean; runs: boolean }>;
  /** Load this card finder in the app; resolves with the milliseconds it took. */
  load(info: BundleInfo, detector: ModelOption): Promise<number>;
  /** Find the card on a frame (tracking across calls until `reset`), timed in native code. */
  find(image: RgbaImage, reset: boolean): Promise<NativeFound & { runs: number[] }>;
  /** Load this art model in the app too (stage 4), and read the art there of a frame `find` kept. */
  loadArt?(info: BundleInfo, art: ModelOption): Promise<number>;
  embed?(seq: number, quad: Quad, cuts: number[] | undefined): Promise<Awaited<ReturnType<RemoteEmbed>>>;
  /** Let the art model go in the app once the test is done with it (the scanner loads its own again). */
  unloadArt?(): Promise<void>;
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
  // The defaults before the faster ones became them, where they no longer are: what the change saved.
  const beforeDetector = models.detector.options.find((o) => o.id === BEFORE_DETECTOR && o.file);
  const beforeArt = models.art.options.find((o) => o.id === BEFORE_ART && o.file);
  if (beforeDetector && beforeArt && (beforeDetector.id !== baseDetector.id || beforeArt.id !== baseArt.id)) wanted.push({ roles: ["before"], detector: beforeDetector, art: beforeArt });
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

/** `p`, or a rejection the moment `signal` stops the test (a request with no signal of its own). */
function orStop<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("The speed test was stopped"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

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
export async function runSpeedTest(onProgress: (p: SpeedProgress) => void, signal?: AbortSignal, deps: SpeedDeps = browserDeps(), alongside: Alongside | null = null): Promise<SpeedReport> {
  const t0 = deps.now();
  const startedAt = new Date().toISOString();
  // The device first, so asking for a WebGPU adapter never overlaps a timed load.
  const env = await orStop(deps.env(), signal);
  const info = await orStop(deps.bundleInfo(), signal);
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
  /** The cards' pictures couldn't be had: nothing else can be timed. */
  let noPictures = false;
  const configs: ConfigResult[] = [];
  // The app's own card finder, timed beside each configuration on the same frames (with the same
  // worker for the art match): its own configuration, before the web view's when this device's
  // scanner runs it, so "yours" is what the scanner runs.
  const native = deps.native ? await orStop(deps.native.can(), signal).catch(() => ({ can: false, runs: false })) : { can: false, runs: false };
  for (const p of plan) {
    stopped(signal);
    const name = `${p.detector.label} and ${p.art.label}`;
    const result: ConfigResult = { roles: p.roles, runtime: SPEED_RUNTIME, wanted: pair(p.detector, p.art), ran: null, loadMs: null, downloaded: false, firstFrameMs: null, stats: null, found: 0, right: 0, frames: [], error: null };
    configs.push(result);
    let rec: ArtRecognizer | null = null;
    /** The same configuration with the card finder in the app, when it loaded there; and its art read there too. */
    let twin: ConfigResult | null = null;
    let twinArt = false;
    let scoreGap: number | null = null;
    const gaps: number[] = [];
    const parity: FinderParity = { frames: 0, both: 0, disagreed: 0, maxPx: null, medianPx: null, sameTop: 0 };
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
      if (native.can && deps.native && p.detector.file) {
        const t: ConfigResult = { roles: p.roles, runtime: NATIVE_RUNTIME, runtimes: { detector: NATIVE_RUNTIME, art: SPEED_RUNTIME }, wanted: pair(p.detector, p.art), ran: null, loadMs: null, downloaded: false, firstFrameMs: null, stats: null, found: 0, right: 0, frames: [], error: null, parity: null };
        configs.splice(native.runs ? configs.indexOf(result) : configs.length, 0, t);
        try {
          say(`Loading ${p.detector.label} in the app`);
          t.loadMs = round(await orStop(deps.native.load(info, p.detector), signal));
          t.ran = { detector: nativeId(p.detector.id), art: rec.art };
          twin = t;
          // And the art read there too, where the app has it: the worker searches what it gives.
          if (deps.native.loadArt && deps.native.embed && p.art.file) {
            try {
              say(`Loading ${p.art.label} in the app`);
              t.loadMs = round(t.loadMs + (await orStop(deps.native.loadArt(info, p.art), signal)));
              twinArt = true;
              t.runtimes = { detector: NATIVE_RUNTIME, art: NATIVE_RUNTIME };
              t.ran = { detector: nativeId(p.detector.id), art: nativeId(rec.art) };
            } catch (e) {
              if (signal?.aborted) throw e;
              t.error = `The art wasn't read in the app: ${message(e)}`;
            }
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          t.error = message(e);
          // Not run in the app after all: the web view's configuration stands for its roles.
          configs.splice(configs.indexOf(t), 1);
          configs.push(t);
        }
      }
      say(`Loaded ${name}`, 1);
      if (!pictures) {
        stopped(signal);
        const cards = (await orStop(rec.sample?.(SPEED_CARDS) ?? Promise.resolve([]), signal)) ?? [];
        say("Getting the cards' pictures from Scryfall");
        const got = await Promise.allSettled(cards.map((c) => deps.picture(c, signal)));
        stopped(signal);
        const ok = got.flatMap((g) => (g.status === "fulfilled" ? [g.value] : []));
        if (ok.length < 2) {
          noPictures = true;
          throw new Error(cards.length ? "Couldn't get the cards' pictures from Scryfall" : "The card recognizer gave no cards to show");
        }
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
          if (twin && deps.native) {
            try {
              // The same frame, drawn again: the first went to the worker.
              const again = deps.frame(pic, at);
              const nf = await orStop(deps.native.find(again, f === 0), signal);
              const s1 = deps.now();
              const embed = deps.native.embed;
              const remote: RemoteEmbed | undefined = twinArt && embed && nf.seq != null ? (q, cuts) => embed(nf.seq!, q, cuts) : undefined;
              const r2 = await rec.matchAt(again, { quad: nf.quad, upright: nf.vote }, { turn: true, remote });
              // The art read in the app failed (not a frame it no longer had): the configuration ends
              // here, its frames all read in the app, rather than mixing in the worker's (Codex review
              // of #198). This frame, read partly by the worker, isn't counted.
              if (r2.remote?.failed && !r2.remote.failed.includes(NATIVE_GONE)) {
                twin.error = `The art read in the app stopped: ${r2.remote.failed}`;
                twin = null;
                continue;
              }
              // The frame as the live scanner has it: found in native code (its own time there; the
              // test's copy of the frame across the bridge isn't something the camera pays), then
              // the art matched in the worker.
              const nativeRound = nf.ms + (deps.now() - s1);
              if (twin.firstFrameMs === null) twin.firstFrameMs = round(nativeRound);
              const runs2 = r2.timings.runs ?? { detector: [], embed: [], search: [] };
              twin.frames.push({
                card: ci,
                frame: f,
                fresh: nf.runs.length !== 1,
                roundMs: round(nativeRound),
                totalMs: round(nf.ms + r2.timings.totalMs),
                detector: nf.runs.map(round),
                embed: runs2.embed.map(round),
                search: runs2.search.map(round),
                cuts: r2.timings.cuts ?? null,
                found: !!r2.quad,
                right: isRight(r2, pic.card),
              });
              // (After the frame's time.) How far the app's art read is from the worker's own on the very same corners (the
              // app's): the art alone, apart from the two finders' corners.
              if (r2.remote?.reads && r2.matches[0]) {
                const local = await rec.matchAt(deps.frame(pic, at), { quad: nf.quad, upright: nf.vote }, { turn: true });
                if (local.matches[0]?.name === r2.matches[0].name) scoreGap = Math.max(scoreGap ?? 0, Math.abs(local.matches[0].score - r2.matches[0].score));
              }
              parity.frames += 1;
              if (r.quad && nf.quad) {
                parity.both += 1;
                gaps.push(cornerGap(r.quad, nf.quad));
              } else if (!!r.quad !== !!nf.quad) parity.disagreed += 1;
              if (r.matches[0] && r2.matches[0] && r.matches[0].name === r2.matches[0].name) parity.sameTop += 1;
            } catch (e) {
              if (signal?.aborted) throw e;
              if (twin) twin.error = message(e);
              twin = null;
            }
          }
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
      // (Whether or not the art reads went on to the end.)
      if (twinArt) await deps.native?.unloadArt?.().catch(() => undefined);
      // The configuration in the app, whatever part of it ran.
      const t = configs.find((c) => c.runtime === NATIVE_RUNTIME && c.wanted.detector.id === p.detector.id && c.wanted.art.id === p.art.id && !c.stats);
      if (t && t.frames.length) {
        t.found = t.frames.filter((f) => f.found).length;
        t.right = t.frames.filter((f) => f.right).length;
        t.stats = configStats(t.frames);
        const sorted = [...gaps].sort((a, b) => a - b);
        t.parity = { ...parity, maxPx: sorted.length ? round(sorted[sorted.length - 1]!) : null, medianPx: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]!) : null, scoreGap: scoreGap == null ? null : Math.round(scoreGap * 10000) / 10000 };
      }
      signal?.removeEventListener("abort", end);
      rec?.dispose();
    }
    // Without the cards' pictures nothing else can be timed; a configuration that didn't load
    // leaves the next to try (and to fetch them).
    if (noPictures) break;
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
    alongside,
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
async function pictureUrl(card: SpeedCard, signal?: AbortSignal): Promise<string> {
  try {
    const q = new URLSearchParams({ id: card.id, ...(card.illustrationId ? { art: card.illustrationId } : {}) });
    const r = await api<{ printings: Printing[] }>(`/api/scan/printings?${q}`, { signal });
    const p = r.printings.find((x) => x.scryfall_id === card.id);
    if (p?.image_normal) return p.image_normal;
  } catch (e) {
    if (signal?.aborted) throw e;
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
  const onStop = () => fail("Stopped");
  signal?.addEventListener("abort", onStop, { once: true });
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
      signal?.removeEventListener("abort", onStop);
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
      dispose: () => {
        signal?.removeEventListener("abort", onStop);
        fail("The look timer was closed");
      },
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
      const url = await pictureUrl(card, signal);
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
    native: nativeCameraAvailable()
      ? {
          async can() {
            const a = await nativeFinderAbility();
            return { can: a.finder, runs: a.finder && savedNativeCamera().on && nativeWanted("detector", savedNative()) };
          },
          async load(info, detector) {
            const file = detector.file;
            if (!file || !info.constants) throw new Error(`${detector.label} has no model file`);
            const t0 = performance.now();
            await loadNativeFinder({ key: finderKey(file), bytes: () => cachedFile(new URL(file, API_BASE || location.origin).href, detector.bytes ?? 0, () => undefined) }, info.constants);
            return performance.now() - t0;
          },
          find: (image, reset) => nativeFind(image, reset),
          async loadArt(_info, art) {
            const file = art.file;
            if (!file) throw new Error(`${art.label} has no model file`);
            const t0 = performance.now();
            await loadNativeArt({ key: finderKey(file), bytes: () => cachedFile(new URL(file, API_BASE || location.origin).href, art.bytes ?? 0, () => undefined) });
            return performance.now() - t0;
          },
          embed: (seq, quad, cuts) => nativeEmbed(seq, quad, cuts),
          unloadArt: () => unloadNativeArt(),
        }
      : undefined,
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
