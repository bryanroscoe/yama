// The scanner's models, switchable on the fly (Bryan, 20 Nov 2026: "We should have the ability to
// switch scanners on the fly if need be by the way we want to be able to try a lot of things here
// and switch between models when things break"). Each slot runs the server's default or an option
// chosen in Scan settings, per device:
//   - detector: the card finder, which places the card's corners in the frame (the bundle's
//     detector.onnx, or Yama's own);
//   - art: the art match's query model (the bundle's embed.onnx, or one of Yama's own);
//   - look: the printing look, which compares the card with each candidate printing's picture;
//   - text: the text reader (ocrEngine.ts);
//   - lock: the rule that settles a card by its art (fuse.ts).
// The server lists what's on offer in `GET /api/scan/bundle` (`models`; server/src/scan.rs,
// `MODELS`) and can withdraw an option (`YAMA_SCAN_WITHDRAW`): a choice no longer on offer runs
// the slot's default meanwhile, and comes back when the option does. docs/scanner.md, "Models you
// can switch".

import type { BundleInfo } from "./artClient";

export type ModelSlot = "detector" | "art" | "look" | "text" | "lock";
export const MODEL_SLOTS: readonly ModelSlot[] = ["detector", "art", "look", "text", "lock"];

/** What each slot is called in Scan settings. */
export const SLOT_LABEL: Record<ModelSlot, string> = {
  detector: "Card finder",
  art: "Art match",
  look: "Printing look",
  text: "Text reader",
  lock: "Settling by art",
};

export interface ModelOption {
  id: string;
  label: string;
  note: string;
  licence?: string | null;
  /** Where its file is served, when it has one (immutable; the art worker caches it by URL). */
  file?: string | null;
  bytes?: number | null;
}

export interface SlotInfo {
  default: string | null;
  options: ModelOption[];
}

export type ModelsInfo = Record<ModelSlot, SlotInfo>;

/** This device's choices: an option id per slot; none means the slot's default. */
export type ModelChoices = Partial<Record<ModelSlot, string>>;

/** What a slot runs: the option, and whether a choice not on offer now fell back to it. */
export interface Running {
  option: ModelOption | null;
  /** The choice made on this device, if any (it stays chosen while it isn't on offer). */
  chosen: string | null;
  /** The choice isn't on offer here now, so the slot's default runs instead. */
  fellBack: boolean;
}

/** What the app's own code can run, for slots whose options are code rather than a file. */
export interface DeviceCan {
  /** Text readers this device has (ocrEngine.ts, `availableEngines`). */
  text: readonly string[];
}

/** The lock rules fuse.ts knows. */
export const LOCK_RULES = ["lead", "sure"] as const;
export type LockRuleId = (typeof LOCK_RULES)[number];

export const MODELS_KEY = "yama.scan.models";

const listeners = new Set<() => void>();

/** The choices as set on this page: they hold even when storage can't be written. */
let chosen: ModelChoices | null = null;

export function savedModels(): ModelChoices {
  if (chosen) return { ...chosen };
  try {
    const raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: ModelChoices = {};
    for (const slot of MODEL_SLOTS) {
      const id = (raw as Record<string, unknown>)[slot];
      if (typeof id === "string" && id) out[slot] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** Choose `id` for `slot` on this device, or the default with null. */
export function saveModel(slot: ModelSlot, id: string | null) {
  const next = { ...savedModels() };
  if (id) next[slot] = id;
  else delete next[slot];
  chosen = next;
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(next));
  } catch {
    /* storage off: the choice holds until the page is reloaded */
  }
  for (const l of listeners) l();
}

/** Called after every saveModel on this page. Returns the unsubscribe. */
export function onModelsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * What the slots can run from this bundle info. A server from before `models` (or bundle info kept
 * from one, for opening offline) offers what it serves: its embed graph, no look, and the app's
 * own text readers and lock rules, with today's defaults.
 */
export function modelsOf(info: Pick<BundleInfo, "files" | "bytes"> & { models?: Partial<ModelsInfo> | null } | null): ModelsInfo {
  const given = info?.models ?? null;
  const embedFile = info?.files.embed ?? null;
  const embedName = embedFile?.split("/").pop() ?? "";
  const artFallback: SlotInfo = embedFile
    ? {
        default: embedName === "embed.onnx" ? "bundle" : embedName.replace(/\.onnx$/, ""),
        options: [{ id: embedName === "embed.onnx" ? "bundle" : embedName.replace(/\.onnx$/, ""), label: embedName === "embed.onnx" ? "ManaVault's art model" : "Yama's art model", note: "", file: embedFile, bytes: info?.bytes.embed ?? null }],
      }
    : { default: null, options: [] };
  const detectorFile = info?.files.detector ?? null;
  const fallback: ModelsInfo = {
    detector: detectorFile
      ? { default: "bundle-detector", options: [{ id: "bundle-detector", label: "ManaVault's card finder", note: "", file: detectorFile, bytes: info?.bytes.detector ?? null }] }
      : { default: null, options: [] },
    art: artFallback,
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: {
      default: "auto",
      options: [
        { id: "auto", label: "Automatic", note: "" },
        { id: "mlkit", label: "Google ML Kit", note: "" },
        { id: "paddle", label: "PaddleOCR (PP-OCRv5)", note: "" },
        { id: "tesseract", label: "Tesseract", note: "" },
      ],
    },
    lock: {
      default: "lead",
      options: [
        { id: "lead", label: "Art that leads", note: "" },
        { id: "sure", label: "Sure scores only", note: "" },
      ],
    },
  };
  if (!given) return fallback;
  const out = {} as ModelsInfo;
  for (const slot of MODEL_SLOTS) {
    const s = given[slot];
    out[slot] = s && Array.isArray(s.options) ? { default: typeof s.default === "string" ? s.default : null, options: s.options.filter((o) => o && typeof o.id === "string") } : fallback[slot];
  }
  return out;
}

/**
 * Whether this app can run an option: an art model, card finder or look model by its file (an art
 * model or card finder with the bundle graph's interface, the server listing one that needs more,
 * such as an art model's `cuts`, only to apps that say they can run it: artClient.ts asks with
 * `?can=`; a look model with look.ts's: `scene` and `quad` in, `symbol` and `card` out), "off" for
 * the look, and text readers and lock rules this
 * build has the code for, on this device (an option a newer server adds stays hidden until then).
 */
export function canRun(slot: ModelSlot, o: ModelOption, can: DeviceCan): boolean {
  switch (slot) {
    case "detector":
    case "art":
      return !!o.file;
    case "look":
      return o.id === "off" || !!o.file;
    case "text":
      return o.id === "auto" || can.text.includes(o.id);
    case "lock":
      return (LOCK_RULES as readonly string[]).includes(o.id);
  }
}

/** The options of a slot this app can run here, in the server's order. */
export const runnable = (info: ModelsInfo, slot: ModelSlot, can: DeviceCan): ModelOption[] => info[slot].options.filter((o) => canRun(slot, o, can));

/** The option a slot runs by default here: the server's default if it runs here, else the first that does. */
export function defaultOption(info: ModelsInfo, slot: ModelSlot, can: DeviceCan): ModelOption | null {
  const options = runnable(info, slot, can);
  return options.find((o) => o.id === info[slot].default) ?? options[0] ?? null;
}

/** What `slot` runs: the choice while it's on offer and runs here, else the default. */
export function running(info: ModelsInfo, slot: ModelSlot, chosen: string | undefined, can: DeviceCan): Running {
  const pick = chosen ? runnable(info, slot, can).find((o) => o.id === chosen) : undefined;
  return { option: pick ?? defaultOption(info, slot, can), chosen: chosen ?? null, fellBack: !!chosen && !pick };
}

export const runningAll = (info: ModelsInfo, choices: ModelChoices, can: DeviceCan): Record<ModelSlot, Running> =>
  Object.fromEntries(MODEL_SLOTS.map((s) => [s, running(info, s, choices[s], can)])) as Record<ModelSlot, Running>;

/** Every file the slots' options name, for the art worker's cache clean-up to keep (bundleCache.ts). */
export const modelFiles = (info: { models?: Partial<ModelsInfo> | null }): string[] =>
  MODEL_SLOTS.flatMap((s) => info.models?.[s]?.options ?? []).flatMap((o) => (o.file ? [o.file] : []));
