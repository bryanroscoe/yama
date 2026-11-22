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

/** Keep the screen on until the returned function is called. */
export function keepScreenAwake(deps: AwakeDeps = {}): () => void {
  const native = deps.native ?? nativeKeepScreenOn;
  const wakeLock = deps.wakeLock !== undefined ? deps.wakeLock : ((navigator as Navigator & { wakeLock?: AwakeDeps["wakeLock"] }).wakeLock ?? null);
  let done = false;
  /** The app holds the screen on (null until it has answered). */
  let byApp: boolean | null = null;
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

  const hold = async () => {
    if (done) return;
    if (byApp !== false) {
      const ok = await native(true);
      if (done) {
        if (ok) void native(false);
        return;
      }
      byApp = ok;
      if (ok) return;
    }
    await browser();
  };

  const onVisibility = () => {
    if (done) return;
    if (document.visibilityState === "visible") void hold();
    // In the background nothing should hold the screen: the app's flag is let go too.
    else if (byApp) void native(false);
  };
  document.addEventListener("visibilitychange", onVisibility);
  void hold();

  return () => {
    if (done) return;
    done = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (byApp) void native(false);
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) void s.release().catch(() => undefined);
  };
}
