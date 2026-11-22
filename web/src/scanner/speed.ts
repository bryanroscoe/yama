// The scanner speed test (docs/scanner.md, "Speed test"). Bryan, 21 Nov 2026: the scanner should be
// as fast as CardVision, and "It should work on any phone but mostly [care] about the Pixel one for
// now". Every speed number before this was from Chrome on an M3 Pro (scanner-lab/speed/); this times
// the scanner on the device itself, with one tap in Scan settings and no camera: synthetic frames
// made of real cards' Scryfall pictures go through the real art worker, for this device's models,
// the defaults and the faster options, and the printing look is timed on one picture and one frame.
//
// This file is the pure part (no workers or DOM): which cards, where each frame puts its card, the
// statistics, what's recorded about the device, and the plain summary. speedRun.ts runs it.

import type { Art } from "./recognizer";
import type { Quad } from "./types";

/** The recognizer's frame: portrait, 640 px wide (artClient.ts, RECOGNIZER_SHORT_SIDE). */
export const SPEED_FRAME = { width: 640, height: 1138 } as const;
/** Cards shown, and frames of each: one fresh frame, then tracked ones, as live. */
export const SPEED_CARDS = 8;
export const FRAMES_PER_CARD = 4;
/** The faster options (docs/scanner.md, "Faster options"), timed beside this device's and the defaults. */
export const FAST_DETECTOR = "yama-corners-20261120";
export const FAST_ART = "yama-art-20261118-cascade";
/**
 * The defaults before the faster ones took their place (22 Nov 2026: docs/scanner.md, "The faster
 * models as the defaults"), timed too where they aren't the defaults, so a device still sees what
 * the change saved.
 */
export const BEFORE_DETECTOR = "bundle-detector";
export const BEFORE_ART = "yama-art-20261118";
/**
 * The report's form, for readers of saved tests. 2 (22 Nov 2026): a configuration may run its card
 * finder in the app's own code (`runtime` "native-cpu", `runtimes`, `parity`).
 */
export const SPEED_REPORT_VERSION = 2;
/**
 * What ran the models: onnxruntime-web's WASM build on one thread, as the scanner does. Native runs
 * (ONNX Runtime for Android) and GPU ones will say otherwise, so they can be told apart.
 */
export const SPEED_RUNTIME = "wasm-1-thread";

/** A card the test shows: a gallery artwork with a printing to fetch the picture of. */
export interface SpeedCard {
  /** Its gallery index (ArtMatch.index), and the printing's Scryfall ID. */
  index: number;
  id: string;
  name: string;
  set: string;
  number: string;
  illustrationId: string | null;
}

/**
 * `count` of the bundle gallery's single-faced normal cards, spread evenly through it (the gallery
 * is in the bundle's order, so the same bundle gives every device the same cards).
 */
export function speedCards(arts: readonly Art[], count = SPEED_CARDS): SpeedCard[] {
  const out: SpeedCard[] = [];
  const taken = new Set<string>();
  if (arts.length === 0) return out;
  for (let k = 0; k < count; k++) {
    const start = Math.floor(((k + 0.5) / count) * arts.length);
    for (let step = 0; step < arts.length; step++) {
      const i = (start + step) % arts.length;
      const a = arts[i]!;
      if (a.layout !== "normal" || a.id.endsWith("-1") || !a.id || taken.has(a.name)) continue;
      taken.add(a.name);
      out.push({ index: i, id: a.id, name: a.name, set: a.set, number: a.number, illustrationId: a.illustrationId });
      break;
    }
  }
  return out;
}

/** Where a frame puts its card: the centre, its width, its turn (radians) and how much narrower its top edge is (a slight perspective). */
export interface Placement {
  cx: number;
  cy: number;
  width: number;
  angle: number;
  /** The top edge's width as a share of the bottom's (1: seen square on). */
  keystone: number;
}

/** A card's height for its width (63 × 88 mm). */
export const CARD_ASPECT = 88 / 63;

const ANGLES = [-5, 3, -2, 6, -4, 1, 4, -6];
const OFFSETS: [number, number][] = [
  [-18, 12],
  [14, -20],
  [6, 24],
  [-22, -8],
  [20, 16],
  [-10, -24],
  [24, 4],
  [-4, 20],
];
/** A held card moves a little between frames: by these pixels and tenths of a degree. */
const JITTER: [number, number, number][] = [
  [0, 0, 0],
  [2, -1, 3],
  [-1, 2, -2],
  [1, 3, 4],
];

/** The placement of card `card`'s frame `frame`: the same on every device. */
export function placement(card: number, frame: number): Placement {
  const [ox, oy] = OFFSETS[card % OFFSETS.length]!;
  const [jx, jy, ja] = JITTER[frame % JITTER.length]!;
  return {
    cx: SPEED_FRAME.width / 2 + ox + jx,
    cy: SPEED_FRAME.height / 2 + oy + jy,
    width: 340 + (card % 4) * 15,
    angle: ((ANGLES[card % ANGLES.length]! + ja / 10) * Math.PI) / 180,
    keystone: 0.93 + (card % 3) * 0.02,
  };
}

/** The card's corners in the frame, top-left first and clockwise, as the recognizer reports them. */
export function placedQuad(p: Placement): Quad {
  const h = p.width * CARD_ASPECT;
  const top = (p.width * p.keystone) / 2;
  const bottom = p.width / 2;
  const corners: [number, number][] = [
    [-top, -h / 2],
    [top, -h / 2],
    [bottom, h / 2],
    [-bottom, h / 2],
  ];
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  return corners.map(([x, y]) => [p.cx + x * c - y * s, p.cy + x * s + y * c]) as Quad;
}

/** The value at quantile `q`, by nearest rank (as the server's timing summaries); null for none. */
export function quantile(values: readonly number[], q: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rank = Math.min(v.length, Math.max(1, Math.ceil(q * v.length)));
  return v[rank - 1]!;
}

export interface Stat {
  median: number | null;
  p90: number | null;
  n: number;
}

const tenth = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** Median and 90th percentile, to a tenth of a millisecond. */
export function stat(values: readonly number[]): Stat {
  return { median: tenth(quantile(values, 0.5)), p90: tenth(quantile(values, 0.9)), n: values.filter(Number.isFinite).length };
}

/** One frame through the art worker. */
export interface FrameTime {
  card: number;
  frame: number;
  /** Searched for the card (two or more detector passes) rather than tracked (one pass on last frame's window). */
  fresh: boolean;
  /** From posting the frame to the worker to its answer (worker messaging included). */
  roundMs: number;
  /** The recognizer's own time for the frame, inside the worker. */
  totalMs: number;
  /** Each graph run's time (recognizer.ts, `GraphRuns`). */
  detector: number[];
  embed: number[];
  search: number[];
  cuts: number | null;
  found: boolean;
  /** The card shown came first (or another printing with its art). */
  right: boolean;
}

/** The app's card finder against the web view's on the same frames (speedRun.ts). */
export interface FinderParity {
  frames: number;
  /** Frames both found a card on, and frames only one of them did. */
  both: number;
  disagreed: number;
  /** Over the frames both found it on: the furthest any corner was from the other's (px), the median of each frame's furthest. */
  maxPx: number | null;
  medianPx: number | null;
  /** Frames whose best match was the same card both ways. */
  sameTop: number;
  /** The most the best match's score differed, the art read in the app against the worker's own on the same corners (none when it wasn't read there). */
  scoreGap?: number | null;
}

/** The furthest any corner of `a` is from the same corner of `b`. */
export function cornerGap(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));
}

/** What a configuration's frames add up to. */
export interface ConfigStats {
  /** One detector pass. */
  detector: Stat;
  /** A frame's art embedding (the cascade's two stages together, when it ran both). */
  embed: Stat;
  /** A frame's search. */
  search: Stat;
  /** A whole frame, from the page: tracked and fresh. */
  tracked: Stat;
  fresh: Stat;
  /** The same inside the worker, comparable with scanner-lab/speed/. */
  trackedInWorker: Stat;
  freshInWorker: Stat;
}

const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);

/** The statistics of a configuration's frames: the first card's are left out (it warms up), unless they're all there is. */
export function configStats(frames: readonly FrameTime[]): ConfigStats {
  const later = frames.some((f) => f.card !== frames[0]?.card) ? frames.filter((f) => f.card !== frames[0]!.card) : frames;
  const found = later.filter((f) => f.found);
  const tracked = later.filter((f) => !f.fresh);
  const fresh = later.filter((f) => f.fresh);
  return {
    detector: stat(later.flatMap((f) => f.detector)),
    embed: stat(found.map((f) => sum(f.embed))),
    search: stat(found.map((f) => sum(f.search))),
    tracked: stat(tracked.map((f) => f.roundMs)),
    fresh: stat(fresh.map((f) => f.roundMs)),
    trackedInWorker: stat(tracked.map((f) => f.totalMs)),
    freshInWorker: stat(fresh.map((f) => f.totalMs)),
  };
}

/** Which models a configuration runs, by option id and name. */
export interface ModelPair {
  detector: { id: string; label: string };
  art: { id: string; label: string };
}

/** What a configuration stands for: this device's choices, the defaults, the faster options (one configuration may be several). */
export type SpeedRole = "yours" | "defaults" | "faster" | "before";

export interface ConfigResult {
  roles: SpeedRole[];
  /**
   * What ran the models (SPEED_RUNTIME): "native-cpu" when the card finder ran in the app's own
   * code (nativeModels.ts), the art match still in the web view (`runtimes` says which ran what).
   */
  runtime: string;
  runtimes?: { detector: string; art: string };
  /**
   * A configuration run in the app: its card finder's corners against the web view's own on the
   * same frames, with the same model (the web configuration it stands beside).
   */
  parity?: FinderParity | null;
  /** What was asked for, and what the worker ran (a model that doesn't load gives way to the defaults). */
  wanted: ModelPair;
  ran: { detector: string; art: string } | null;
  /** Loading the worker and its models, compiling and warming them up; and whether anything was downloaded for it. */
  loadMs: number | null;
  downloaded: boolean;
  /** The first frame's time from the page: the rest of the warm-up. */
  firstFrameMs: number | null;
  stats: ConfigStats | null;
  /** Of the frames, how many found a card and how many put the right card first. */
  found: number;
  right: number;
  frames: FrameTime[];
  error: string | null;
}

export interface LookResult {
  /** What ran the model (SPEED_RUNTIME). */
  runtime: string;
  option: string;
  label: string;
  loadMs: number | null;
  /** The first picture and frame (kernels being set up), apart from the rest. */
  firstMs: number | null;
  picture: Stat;
  frame: Stat;
  fetch: Stat;
  decode: Stat;
  error: string | null;
}

/** What's recorded about the device and browser. */
export interface SpeedEnv {
  userAgent: string;
  /** Chrome's User-Agent Client Hints, where given (the model and Android version: Chrome's user agent hides them). */
  hints: Record<string, unknown> | null;
  app: { web: string; built: string; native: { versionName?: string; versionCode: number } | null };
  cores: number | null;
  /** navigator.deviceMemory, in GB (Chrome rounds it, and caps it at 8). */
  memory: number | null;
  /** Cross-origin isolated: whether WASM threads could be used (Yama isn't, so it runs one). */
  isolated: boolean;
  sharedMemory: boolean;
  webgpu: WebGpuInfo;
}

export interface WebGpuInfo {
  /** navigator.gpu exists. */
  api: boolean;
  /** requestAdapter() gave an adapter. */
  adapter: boolean;
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  fallback?: boolean;
  /** The adapter supports `shader-f16`. */
  f16?: boolean;
  error?: string;
}

/** The parts of `navigator` read (fakes in tests). */
export interface NavigatorLike {
  userAgent?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgentData?: { getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>; brands?: unknown; mobile?: boolean; platform?: string };
  gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> };
}

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean };
  requestAdapterInfo?(): Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
  features?: { has(name: string): boolean };
  isFallbackAdapter?: boolean;
}

const HINTS = ["model", "platform", "platformVersion", "architecture", "bitness", "fullVersionList", "mobile"];

/** At most `ms` for a browser call that might never answer. */
export const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms))]);

const short = (v: unknown, n = 120) => (typeof v === "string" ? v.slice(0, n) : undefined);

/** WebGPU as this browser offers it: whether the API is there, and the adapter it gives. */
export async function webGpuInfo(nav: NavigatorLike): Promise<WebGpuInfo> {
  if (!nav.gpu) return { api: false, adapter: false };
  try {
    const a = await within(nav.gpu.requestAdapter(), 5000);
    if (!a) return { api: true, adapter: false };
    const info = a.info ?? (a.requestAdapterInfo ? await within(a.requestAdapterInfo(), 3000).catch(() => undefined) : undefined) ?? {};
    const fallback = (info as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? a.isFallbackAdapter;
    return {
      api: true,
      adapter: true,
      vendor: short(info.vendor),
      architecture: short(info.architecture),
      device: short(info.device),
      description: short(info.description),
      ...(fallback !== undefined ? { fallback: !!fallback } : {}),
      f16: !!a.features?.has("shader-f16"),
    };
  } catch (e) {
    return { api: true, adapter: false, error: short(e instanceof Error ? e.message : String(e), 200) };
  }
}

/** The device and browser, as recorded with a test. */
export async function captureEnv(
  nav: NavigatorLike,
  g: { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown },
  app: SpeedEnv["app"],
): Promise<SpeedEnv> {
  let hints: Record<string, unknown> | null = null;
  try {
    const ua = nav.userAgentData;
    if (ua?.getHighEntropyValues) {
      const v = await within(ua.getHighEntropyValues(HINTS), 3000);
      hints = Object.fromEntries(Object.entries(v).filter(([k]) => k === "brands" || HINTS.includes(k)));
    }
  } catch {
    hints = null;
  }
  return {
    userAgent: (nav.userAgent ?? "").slice(0, 400),
    hints,
    app,
    cores: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    memory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    isolated: g.crossOriginIsolated === true,
    sharedMemory: typeof g.SharedArrayBuffer === "function",
    webgpu: await webGpuInfo(nav),
  };
}

/** The browser's name and major version from its user agent hints or string. */
function browserOf(env: SpeedEnv): string | null {
  const list = env.hints?.fullVersionList;
  if (Array.isArray(list)) {
    const known = (list as { brand?: string; version?: string }[]).find((b) => b.brand && /Chrome|Edge|Opera|Samsung|Android WebView/.test(b.brand) && !/Chromium/.test(b.brand));
    if (known?.brand) return `${known.brand} ${(known.version ?? "").split(".")[0]}`.trim();
  }
  const ua = env.userAgent;
  if (/; wv\)/.test(ua)) return `Android WebView ${ua.match(/Chrome\/(\d+)/)?.[1] ?? ""}`.trim();
  const m = ua.match(/(Edg|Firefox|Chrome|Version)\/(\d+)/);
  if (!m) return null;
  const name = m[1] === "Edg" ? "Edge" : m[1] === "Version" ? "Safari" : m[1]!;
  return `${name} ${m[2]}`;
}

/** "Pixel 10 Pro, Android 16, Chrome 142": a short name for the device, for lists. */
export function deviceLabel(env: SpeedEnv): string {
  // Chrome's own user agent says "Android 10; K" whatever the phone; a WebView's still names it.
  const model = short(env.hints?.model, 60) || env.userAgent.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?(?:; wv)?\)/)?.[1]?.trim();
  const platform = short(env.hints?.platform, 30);
  const version = short(env.hints?.platformVersion, 20);
  const os =
    platform && platform !== "Unknown"
      ? `${platform}${version && platform === "Android" ? ` ${version.split(".")[0]}` : ""}`
      : env.userAgent.match(/Android [\d.]+/)?.[0] ?? (/iPhone|iPad/.test(env.userAgent) ? "iOS" : /Mac OS X/.test(env.userAgent) ? "macOS" : /Windows/.test(env.userAgent) ? "Windows" : /Linux/.test(env.userAgent) ? "Linux" : null);
  const app = env.app.native ? `Yama app ${env.app.native.versionName ?? env.app.native.versionCode}` : null;
  return [model && model !== "K" ? model : null, os, app ?? browserOf(env)].filter(Boolean).join(", ").slice(0, 120) || "Unknown device";
}

/** A whole test, as saved. */
export interface SpeedReport {
  version: number;
  startedAt: string;
  /** How long the whole test took. */
  ms: number;
  bundle: string;
  device: string;
  env: SpeedEnv;
  /** This device's model choice per slot when it ran (models.ts, `ModelChoices`). */
  choices: Record<string, string>;
  cards: Pick<SpeedCard, "id" | "name" | "set" | "number">[];
  configs: ConfigResult[];
  look: LookResult | null;
  /**
   * What else held models in memory while the test ran: the scanner's own recognizer, loaded beside
   * the test's workers when the test runs from Scan settings over it (its card finder, art model and
   * look option). Null when nothing was (a check run before the scanner loads).
   */
  alongside: Alongside | null;
}

/** The scanner's own recognizer, as loaded while a test ran beside it. */
export interface Alongside {
  detector: string | null;
  art: string | null;
  look: string | null;
}

/** The configuration standing for `role`, if one ran. */
export const configFor = (r: Pick<SpeedReport, "configs">, role: SpeedRole): ConfigResult | undefined => r.configs.find((c) => c.roles.includes(role));

const ms = (v: number | null | undefined) => (v == null ? "?" : `${Math.round(v)} ms`);

/**
 * The plain summary: "A frame takes 142 ms with your models, 48 ms with the faster ones." The time
 * is a tracked frame's median from the page (worker messaging included), as the live camera's are.
 */
export function speedSummary(r: Pick<SpeedReport, "configs">): string {
  const frame = (c: ConfigResult | undefined) => (c?.stats?.tracked.median ?? null);
  const yours = configFor(r, "yours");
  const defaults = configFor(r, "defaults");
  const faster = configFor(r, "faster");
  const before = configFor(r, "before");
  const parts: string[] = [];
  let lead = "";
  if (yours && frame(yours) !== null) {
    const own = yours.roles.includes("faster") ? "your models (the faster ones)" : yours.roles.includes("defaults") ? "your models (the defaults)" : yours.roles.includes("before") ? "your models (the ones before)" : "your models";
    parts.push(`${ms(frame(yours))} with ${own}`);
  } else if (yours?.error) lead = `Your models weren't timed: ${yours.error}. `;
  if (defaults && defaults !== yours && frame(defaults) !== null) parts.push(`${ms(frame(defaults))} with the defaults`);
  if (faster && faster !== yours && frame(faster) !== null) parts.push(`${ms(frame(faster))} with the faster ones`);
  if (before && before !== yours && frame(before) !== null) parts.push(`${ms(frame(before))} with the models before`);
  if (parts.length === 0) return yours?.error ? `The test didn't finish: ${yours.error}` : "The test didn't finish.";
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(", ");
  return `${lead}A frame takes ${list}.`;
}
