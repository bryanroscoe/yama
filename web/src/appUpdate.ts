// The Android app's update state, shared by the banner (components/AppUpdate.tsx) and the
// "Yama app" row in Settings (Bryan, 15 Nov 2026: know about a new APK while the app is open, and
// update it from inside the app, as there's no Play Store release). One check, one install: the
// two views never ask GitHub or start the installer separately. Checks run only while the app is
// open; nothing runs in the background. The rules for what to take are in nativeUpdate.ts.

import { useSyncExternalStore } from "react";
import { parseManifest, planUpdate, Updater, UPDATE_MANIFEST_URL, WEB_BUILD, type UpdatePlan, type UpdaterInfo } from "./nativeUpdate";

export type AppPlan = Extract<UpdatePlan, { kind: "app" }>;

export interface AppUpdateState {
  /** What the installed app says about itself; null until it answers. */
  info: UpdaterInfo | null;
  /** A newer APK, offered with Update. */
  app: AppPlan | null;
  /** A downloaded web build waiting for Reload. */
  web: string | null;
  checking: boolean;
  /** When the last check reached update.json (ms). */
  checkedAt: number | null;
  /** The last check failed (offline, GitHub unreachable, a manifest that didn't parse). */
  checkFailed: boolean;
  installing: boolean;
  /** Sent to Android's "Install unknown apps" page; the install carries on when the person comes back with it allowed. */
  awaitingPermission: boolean;
  installError: string | null;
}

const INITIAL: AppUpdateState = {
  info: null, app: null, web: null, checking: false, checkedAt: null, checkFailed: false,
  installing: false, awaitingPermission: false, installError: null,
};

let state = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<AppUpdateState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getAppUpdate(): AppUpdateState {
  return state;
}

export function subscribeAppUpdate(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The shared state, for a component. */
export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribeAppUpdate, getAppUpdate, getAppUpdate);
}

/** How often the app asks for update.json while it's open or comes back to the front. */
export const NATIVE_CHECK_MS = 30 * 60_000;

/** After a failed check (offline, GitHub unreachable), the next one may come this soon. */
export const RETRY_MS = 60_000;

let lastTry = 0;
let running: Promise<void> | null = null;

/**
 * Ask update.json what's new. `force` skips the spacing (launch, Check for updates): 30 minutes
 * after a check that worked, a minute after one that failed. A check already running is joined
 * rather than repeated.
 */
export function checkForUpdates(force = false): Promise<void> {
  if (running) return running;
  const wait = state.checkFailed ? RETRY_MS : NATIVE_CHECK_MS;
  if (!force && Date.now() - lastTry < wait) return Promise.resolve();
  lastTry = Date.now();
  running = runCheck().finally(() => {
    running = null;
  });
  return running;
}

async function runCheck() {
  set({ checking: true });
  let failed = false;
  try {
    const info = await Updater.info();
    set({ info });
    if (info.nativeHash === "dev") return;
    if (info.next && info.next !== WEB_BUILD) set({ web: info.next });
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      failed = true;
      return;
    }
    const manifest = parseManifest((await Updater.fetchText({ url: `${UPDATE_MANIFEST_URL}?t=${Date.now()}` })).text);
    if (!manifest) {
      failed = true;
      return;
    }
    const plan = planUpdate(info, manifest, WEB_BUILD);
    set({ app: plan.kind === "app" ? plan : null, checkedAt: Date.now() });
    if (plan.kind === "web") {
      const { version } = await Updater.downloadBuild(plan);
      set({ web: version });
    }
  } catch {
    // Offline or GitHub unreachable: try again later.
    failed = true;
  } finally {
    set({ checking: false, checkFailed: failed });
  }
}

/** Download the offered APK and hand it to Android's installer. */
export async function installApp(): Promise<void> {
  const app = state.app;
  if (!app || state.installing) return;
  set({ installing: true, installError: null, awaitingPermission: false });
  try {
    const { status } = await Updater.installApk(app);
    set({ awaitingPermission: status === "permission" });
  } catch {
    set({ installError: "The update didn't download. Try again in a moment." });
  } finally {
    set({ installing: false });
  }
}

/**
 * Back in the app. If it was sent to "Install unknown apps" for an update and that's now
 * allowed, the update carries on without a second tap; then a check, spaced as usual.
 */
export async function resumed(): Promise<void> {
  if (state.awaitingPermission) {
    try {
      const info = await Updater.info();
      set({ info });
      if (info.canInstall) {
        await installApp();
        return;
      }
      set({ awaitingPermission: false, installError: "Yama isn't allowed to install apps yet. Tap Update to allow it." });
    } catch {
      set({ awaitingPermission: false });
    }
  }
  await checkForUpdates();
}

/** For tests. */
export function resetAppUpdate() {
  state = INITIAL;
  lastTry = 0;
  running = null;
  for (const l of listeners) l();
}
