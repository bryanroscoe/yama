// The camera's frame rate (docs/plans/scanner-match-cardvision.md, item 14): 60 frames a second is
// asked for where the camera says it can deliver it at the resolution it is already giving, because
// a shorter exposure blurs a moving card less. What it then delivers is measured from the video
// itself and kept with Scanner diagnostics, since a browser may accept a rate and deliver another.

/** On this device: "0" when 60 fps isn't to be asked for. On unless turned off. */
export const FPS60_KEY = "yama.scan.fps60";
/** At or over this the camera is already at 60 (cameras report 59.94 and the like). */
const SIXTY = 59;

export function fps60On(): boolean {
  try {
    return localStorage.getItem(FPS60_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setFps60(on: boolean) {
  try {
    if (on) localStorage.removeItem(FPS60_KEY);
    else localStorage.setItem(FPS60_KEY, "0");
  } catch {
    /* storage off */
  }
}

type RateTrack = Pick<MediaStreamTrack, "getSettings" | "applyConstraints"> & { getCapabilities?: () => MediaTrackCapabilities };

/** Whether this camera says it can deliver 60 frames a second at some size. */
export function offers60(track: RateTrack): boolean {
  const max = track.getCapabilities?.().frameRate?.max;
  return typeof max === "number" && max >= SIXTY;
}

export type RateAnswer = "sixty" | "already" | "unavailable" | "refused";

/**
 * Ask for 60 frames a second without giving up resolution: the size delivered now is required as
 * the least, so a camera that can only do 60 on a smaller picture refuses and stays as it is. If
 * the picture came back smaller all the same, the rate is given back.
 */
export async function ask60(track: RateTrack): Promise<RateAnswer> {
  if (!offers60(track)) return "unavailable";
  const before = track.getSettings();
  if ((before.frameRate ?? 0) >= SIXTY) return "already";
  const { width: w, height: h } = before;
  if (!w || !h) return "unavailable";
  try {
    await track.applyConstraints({ width: { min: w, ideal: w }, height: { min: h, ideal: h }, frameRate: { min: 50, ideal: 60 } });
  } catch {
    return "refused";
  }
  const after = track.getSettings();
  if ((after.width ?? 0) < w || (after.height ?? 0) < h) {
    await track.applyConstraints({ width: { ideal: w }, height: { ideal: h } }).catch(() => undefined);
    return "refused";
  }
  return "sixty";
}

/** Back to the camera's usual rate, at the size it delivers now. */
export async function askUsualRate(track: RateTrack): Promise<void> {
  const { width: w, height: h } = track.getSettings();
  await track.applyConstraints({ ...(w && h ? { width: { ideal: w }, height: { ideal: h } } : {}), frameRate: { ideal: 30 } }).catch(() => undefined);
}

/** Frames a second actually presented, over the last WINDOW_MS. */
export class FrameRateMeter {
  static readonly WINDOW_MS = 2000;
  private times: number[] = [];

  /** A frame was presented at `t` (ms). */
  tick(t: number) {
    this.times.push(t);
    const from = t - FrameRateMeter.WINDOW_MS;
    while (this.times.length && this.times[0]! < from) this.times.shift();
  }

  reset() {
    this.times = [];
  }

  /** To one decimal; null until half a second of frames has been seen. */
  fps(): number | null {
    const n = this.times.length;
    if (n < 2) return null;
    const span = this.times[n - 1]! - this.times[0]!;
    if (span < 500) return null;
    return Math.round(((n - 1) * 10000) / span) / 10;
  }
}

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number) => void) => number; cancelVideoFrameCallback?: (id: number) => void };

/** Count the video's presented frames into `meter`, where the browser reports them. Returns the stop. */
export function watchFrameRate(video: HTMLVideoElement, meter: FrameRateMeter): () => void {
  const v = video as FrameVideo;
  if (typeof v.requestVideoFrameCallback !== "function") return () => undefined;
  meter.reset();
  let id = 0;
  let done = false;
  const on = (now: number) => {
    if (done) return;
    meter.tick(now);
    id = v.requestVideoFrameCallback!(on);
  };
  id = v.requestVideoFrameCallback(on);
  return () => {
    done = true;
    v.cancelVideoFrameCallback?.(id);
  };
}
