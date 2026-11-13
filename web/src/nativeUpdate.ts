// Updates for the sideloaded Android app (docs/mobile.md, "Updates"). The release workflow
// publishes update.json beside the APK and the web build on the repository's `android-app`
// release. A web build for the app's own native code downloads quietly and starts the next time
// the app opens (or at once on Reload); a newer APK is offered with an Update button, which hands
// it to Android's installer. The native side is UpdaterPlugin.java.

import { registerPlugin } from "@capacitor/core";

export const UPDATE_MANIFEST_URL = "https://github.com/bryanroscoe/yama/releases/download/android-app/update.json";

/** This web build's version: the commit it was built from, set by the release workflow. Empty in other builds. */
export const WEB_BUILD: string = import.meta.env.VITE_APP_BUILD ?? "";

export interface UpdaterInfo {
  versionCode: number;
  versionName?: string;
  /** The native code this app was built from; "dev" for local builds, which never update. */
  nativeHash: string;
  failed: string[];
  next: string;
  canInstall: boolean;
}

interface Updater {
  info(): Promise<UpdaterInfo>;
  fetchText(o: { url: string }): Promise<{ text: string }>;
  downloadBuild(o: { url: string; sha256: string; version: string }): Promise<{ version: string }>;
  apply(o: { version: string }): Promise<void>;
  started(o: { version: string }): Promise<void>;
  installApk(o: { url: string; sha256: string; versionCode: number }): Promise<{ status: "installing" | "permission" }>;
}

export const Updater = registerPlugin<Updater>("Updater");

export interface UpdateManifest {
  native: { versionCode: number; versionName: string; hash: string; url: string; sha256: string };
  web: { version: string; nativeHash: string; url: string; sha256: string } | null;
}

const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const HASH = /^[0-9a-f]{16}$/;
const URL_OK = (u: unknown): u is string => typeof u === "string" && /^https:\/\/(github\.com|yama\.ing)\//.test(u);

/** The manifest, checked field by field; null if anything is off. */
export function parseManifest(text: string): UpdateManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const m = raw as { native?: Record<string, unknown>; web?: Record<string, unknown> | null };
  const n = m?.native;
  if (!n || !Number.isInteger(n.versionCode) || (n.versionCode as number) < 1 || typeof n.versionName !== "string" || typeof n.hash !== "string" || !HASH.test(n.hash) || !URL_OK(n.url) || typeof n.sha256 !== "string" || !SHA.test(n.sha256)) return null;
  const native = { versionCode: n.versionCode as number, versionName: n.versionName, hash: n.hash, url: n.url, sha256: n.sha256 };
  const w = m.web;
  if (w == null) return { native, web: null };
  if (typeof w.version !== "string" || !VERSION.test(w.version) || typeof w.nativeHash !== "string" || !HASH.test(w.nativeHash) || !URL_OK(w.url) || typeof w.sha256 !== "string" || !SHA.test(w.sha256)) return null;
  return { native, web: { version: w.version, nativeHash: w.nativeHash, url: w.url, sha256: w.sha256 } };
}

export type UpdatePlan =
  | { kind: "none" }
  | { kind: "app"; versionCode: number; versionName: string; url: string; sha256: string }
  | { kind: "web"; version: string; url: string; sha256: string };

/**
 * What to do with a manifest. A newer APK comes first: once its native code differs, this app
 * can't take that code's web builds. Otherwise a web build made for this app's native code, if
 * it's not the one running, not already waiting, and hasn't failed to start here before.
 */
export function planUpdate(info: UpdaterInfo, manifest: UpdateManifest, running: string): UpdatePlan {
  if (info.nativeHash === "dev") return { kind: "none" };
  const n = manifest.native;
  if (n.versionCode > info.versionCode) return { kind: "app", versionCode: n.versionCode, versionName: n.versionName, url: n.url, sha256: n.sha256 };
  const w = manifest.web;
  if (w && w.nativeHash === info.nativeHash && w.version !== running && w.version !== info.next && !info.failed.includes(w.version)) {
    return { kind: "web", version: w.version, url: w.url, sha256: w.sha256 };
  }
  return { kind: "none" };
}
