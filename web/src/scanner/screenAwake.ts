// The screen stays on while the scanner's camera runs (Bryan, 22 Nov 2026: "I noticed the screen
// turned off while I was using it. We need to do something to keep the screen on when we're using
// it too"). Scanning is hands busy with cards, not touching the screen, so the phone's idle timeout
// ran out mid-stack.
//
// In the Android app the page asks the app (ScannerCameraPlugin.keepScreenOn: the window's
// FLAG_KEEP_SCREEN_ON), since Android's web view has no Screen Wake Lock [read: the API's
// compatibility tables list it for Chrome on Android, not WebView]. An APK from before that method
// rejects the call, and the browser's lock is tried instead (absent there, so the screen sleeps as
// before). In a browser it's the Screen Wake Lock API, which the browser lets go whenever the page
// is hidden; it's asked for again when the page is back. Either is let go when the scanner closes
// or its camera stops, and while the app or tab is in the background.

import { nativeKeepScreenOn } from "./nativeCamera";

interface Sentinel {
  released: boolean;
  release(): Promise<void>;
}

export interface AwakeDeps {
  /** The app's way (nativeCamera.ts); resolves false where it can't. */
  native?: (on: boolean) => Promise<boolean>;
  /** The browser's Screen Wake Lock, where it has one. */
  wakeLock?: { request(type: "screen"): Promise<Sentinel> } | null;
}

/**
 * The app's flag is one for the whole window, so it's counted: on while any scanner holds it, and
 * each change is sent after the one before, so a scanner closing just as another opens can't leave
 * it off (an independent review of #202).
 */
let holders = 0;
let sent: Promise<unknown> = Promise.resolve();
function appHold(native: (on: boolean) => Promise<boolean>, delta: 1 | -1): Promise<boolean> {
  holders = Math.max(0, holders + delta);
  const on = holders > 0;
  const p = sent.then(() => native(on));
  sent = p.catch(() => undefined);
  return p;
}

/** Keep the screen on until the returned function is called. */
export function keepScreenAwake(deps: AwakeDeps = {}): () => void {
  const native = deps.native ?? nativeKeepScreenOn;
  const wakeLock = deps.wakeLock !== undefined ? deps.wakeLock : ((navigator as Navigator & { wakeLock?: AwakeDeps["wakeLock"] }).wakeLock ?? null);
  let done = false;
  /** The app can hold the screen on (null until it has answered: an older APK can't). */
  let byApp: boolean | null = null;
  /** This scanner counts among the app's holders now. */
  let holding = false;
  let sentinel: Sentinel | null = null;
  let asking = false;

  const browser = async () => {
    if (!wakeLock || done || asking || (sentinel && !sentinel.released) || document.visibilityState !== "visible") return;
    asking = true;
    try {
      const s = await wakeLock.request("screen");
      if (done) void s.release().catch(() => undefined);
      else sentinel = s;
    } catch {
      // Refused (battery saver, a page that isn't in front): the screen sleeps as it would anyway.
    } finally {
      asking = false;
    }
  };

  const letGoOfApp = () => {
    if (!holding) return;
    holding = false;
    void appHold(native, -1);
  };

  const hold = async () => {
    if (done || document.visibilityState !== "visible") return;
    if (byApp !== false) {
      if (holding) return;
      holding = true;
      const ok = await appHold(native, 1);
      if (byApp === null) byApp = ok;
      if (ok) return;
      // Not the app (or an APK without the method): this scanner doesn't count (unless it was let
      // go meanwhile), and the browser's lock is tried.
      if (holding) {
        holding = false;
        holders = Math.max(0, holders - 1);
      }
    }
    await browser();
  };

  const onVisibility = () => {
    if (done) return;
    if (document.visibilityState === "visible") void hold();
    // In the background nothing should hold the screen: the app's flag is let go too.
    else letGoOfApp();
  };
  document.addEventListener("visibilitychange", onVisibility);
  void hold();

  return () => {
    if (done) return;
    done = true;
    document.removeEventListener("visibilitychange", onVisibility);
    letGoOfApp();
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) void s.release().catch(() => undefined);
  };
}
