// Keeping the phone awake while a game is on the table. The browser lets go of a screen wake
// lock whenever the page is hidden (another app, a notification, the phone locked), so asking
// once isn't enough: ask again each time the page comes back, and on the next tap if the lock
// is still missing (some browsers only grant it from a tap, or drop it for battery saver).

import { useEffect } from "react";

interface Sentinel {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", fn: () => void): void;
}

export interface WakeLockHost {
  wakeLock?: { request(type: "screen"): Promise<Sentinel> };
}

export interface PageHost {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: string, fn: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void, options?: AddEventListenerOptions): void;
}

/** Holds the screen awake until the returned stop is called. Does nothing where unsupported. */
export function holdScreenAwake(nav: WakeLockHost, page: PageHost): () => void {
  const api = nav.wakeLock;
  if (!api) return () => {};
  let lock: Sentinel | null = null;
  let asking = false;
  let stopped = false;

  const held = () => lock !== null && !lock.released;
  const ask = () => {
    if (stopped || asking || held() || page.visibilityState !== "visible") return;
    asking = true;
    api
      .request("screen")
      .then((l) => {
        // Stopped while asking: give it straight back.
        if (stopped) return void l.release().catch(() => {});
        lock = l;
        l.addEventListener?.("release", () => {
          if (lock === l) lock = null;
        });
      })
      .catch(() => {})
      .finally(() => (asking = false));
  };

  page.addEventListener("visibilitychange", ask);
  // A click, not pointerdown: a touch only counts as a tap (user activation) once it lifts.
  page.addEventListener("click", ask, { capture: true, passive: true });
  ask();

  return () => {
    stopped = true;
    page.removeEventListener("visibilitychange", ask);
    page.removeEventListener("click", ask, { capture: true });
    void lock?.release().catch(() => {});
    lock = null;
  };
}

/** Keep the screen on while the calling page is open (and `on`), where the browser supports it. */
export function useScreenAwake(on = true) {
  useEffect(() => (on ? holdScreenAwake(navigator as Navigator & WakeLockHost, document) : undefined), [on]);
}
