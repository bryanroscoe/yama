// Installing Yama as an app, and full screen. Chrome and Edge offer an install prompt
// (beforeinstallprompt), caught here as soon as the app loads so a button can offer it later.
// Safari has no prompt: on an iPhone or iPad it's Share, then Add to Home Screen. An installed
// Yama opens without the browser's bars (manifest display: standalone).

import { useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
let fullscreen = typeof document !== "undefined" && !!document.fullscreenElement;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen = !!document.fullscreenElement;
    emit();
  });
}

/** Opened from the home screen (or as an installed app), not in a browser tab. */
function standalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** An iPhone or iPad (iPadOS says it's a Mac, but has touch). */
function apple(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function useInstall() {
  const prompt = useSyncExternalStore(subscribe, () => deferred);
  const installed = standalone();
  return {
    installed,
    /** The browser will show its install prompt. */
    canPrompt: !installed && !!prompt,
    /** Safari on an iPhone or iPad: install from the Share menu. */
    fromShareMenu: !installed && !prompt && apple(),
    install: async () => {
      if (!deferred) return;
      const p = deferred;
      deferred = null;
      emit();
      await p.prompt();
    },
  };
}

export function useFullscreen() {
  const on = useSyncExternalStore(subscribe, () => fullscreen);
  // iPhone Safari has no full screen for pages; installing is the way there.
  const supported = typeof document !== "undefined" && !!document.fullscreenEnabled && !standalone();
  return {
    supported,
    on,
    toggle: () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    },
  };
}
