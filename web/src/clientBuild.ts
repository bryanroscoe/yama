// Which build this is, as the app tells the server on its API requests (`X-Yama-Client`;
// server/src/client_builds.rs). Bryan, 15 Nov 2026: agents must be able to tell which build is on
// his phone without the phone. The server keeps the last one per signed-in device and shows it to
// the account's own assistant (`list_devices`) and on the admin People page.
//
//   Android app: "android/0.2.100 (100) web/638954329799 native/0123456789abcdef"
//   browser:     "web/638954329799"
//
// Only letters, digits and `._-` go into each part: the server ignores anything else.

/** The commit this web build was made from (vite.config.ts: the Android release's, the deploy's or Git's), or "" when the build didn't know it. Shown by version.tsx too. */
export const BUILD_COMMIT: string = import.meta.env.VITE_BUILD_COMMIT ?? "";

/** The Android app's own build, from the updater plugin (nativeUpdate.ts, `Updater.info()`). */
export interface NativeBuild {
  versionName?: string;
  versionCode: number;
  nativeHash: string;
}

const clean = (s: string, max: number) => s.replace(/[^A-Za-z0-9._-]/g, "").slice(0, max);

/** The header's value for this web build, inside the Android app (`native`) or a browser (null). */
export function clientString(commit: string, native: NativeBuild | null): string {
  const web = `web/${clean(commit, 12) || "local"}`;
  if (!native) return web;
  const code = Number.isFinite(native.versionCode) ? Math.max(0, Math.trunc(native.versionCode)) : 0;
  const name = clean(native.versionName ?? "", 32) || String(code);
  return `android/${name} (${code}) ${web} native/${clean(native.nativeHash, 32) || "unknown"}`;
}
