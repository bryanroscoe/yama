import { useEffect, useState } from "react";
import { isNative } from "../native";
import { Updater, WEB_BUILD } from "../nativeUpdate";
import { checkForUpdates, installApp, NATIVE_CHECK_MS, resumed, useAppUpdate, type AppUpdateState } from "../appUpdate";
import { Button } from "./Button";
import { fmtTime } from "@yama/core";
import { BUILD_COMMIT, BUILD_TIME, versionLine } from "../version";

export function shellBuild(html: string): string | null {
  return html.match(/<meta name="yama-precache" content="(\/assets\/precache-[\w-]+\.json)"/)?.[1] ?? null;
}

/** An open tab keeps its loaded code across releases. Offer a reload after saving edits. */
export function AppUpdate() {
  return isNative() ? <NativeAppUpdate /> : <WebAppUpdate />;
}

function WebAppUpdate() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = document.querySelector<HTMLMetaElement>('meta[name="yama-precache"]')?.content;
    if (!current) return; // Vite development has no build manifest.
    let live = true;
    let busy = false;
    const controller = new AbortController();
    const check = async () => {
      if (busy || document.visibilityState === "hidden" || !navigator.onLine) return;
      busy = true;
      try {
        const response = await fetch(`/?yama-build-check=${Date.now()}`, { cache: "no-store", signal: controller.signal });
        if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
          const build = shellBuild(await response.text());
          if (live && build && build !== current) setAvailable(true);
        }
      } catch { /* Offline: keep the saved app working. */ }
      finally { busy = false; }
    };
    void check();
    const interval = window.setInterval(() => void check(), 5 * 60_000);
    const changed = () => void check();
    window.addEventListener("focus", changed);
    window.addEventListener("online", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      live = false; controller.abort(); window.clearInterval(interval);
      window.removeEventListener("focus", changed); window.removeEventListener("online", changed);
      document.removeEventListener("visibilitychange", changed);
    };
  }, []);
  return available ? <aside className="app-update" role="status"><span>A Yama update is ready. Save open edits before reloading.</span><Button onClick={() => window.location.reload()}>Reload</Button></aside> : null;
}

/**
 * The Android app (appUpdate.ts): a web build downloads quietly and starts with the app next
 * time, with a Reload offer meanwhile; a newer APK gets an Update button and its what's new.
 * Settings has the same Update, and Check for updates, in its "Yama app" row.
 */
function NativeAppUpdate() {
  const s = useAppUpdate();
  useEffect(() => {
    // This build started: keep it (the updater goes back to the previous one otherwise).
    void Updater.started({ version: WEB_BUILD }).catch(() => {});
    void checkForUpdates(true);
    const interval = window.setInterval(() => void checkForUpdates(), NATIVE_CHECK_MS);
    const onResume = import("@capacitor/app").then(({ App }) => App.addListener("resume", () => void resumed()));
    // Signal back after a failed check: try again (spaced by checkForUpdates).
    const online = () => void checkForUpdates();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      window.clearInterval(interval);
      void onResume.then((h) => h.remove());
    };
  }, []);
  if (s.app) {
    return (
      <aside className="app-update" role="status">
        <span className="app-update-text">
          <span>{appUpdateMessage(s)}</span>
          {s.app.notes && !s.awaitingPermission && !s.installError && <span className="dim">{s.app.notes}</span>}
        </span>
        <Button onClick={() => void installApp()} disabled={s.installing}>{s.installing ? "Downloading…" : "Update"}</Button>
      </aside>
    );
  }
  if (s.web) {
    return (
      <aside className="app-update" role="status">
        <span>A Yama update is ready. It starts next time you open the app, or reload now after saving open edits.</span>
        <Button onClick={() => void Updater.apply({ version: s.web! })}>Reload</Button>
      </aside>
    );
  }
  return null;
}

/** The banner's line for a newer APK, also used in Settings. */
export function appUpdateMessage(s: Pick<AppUpdateState, "app" | "awaitingPermission" | "installError">): string {
  if (s.installError) return s.installError;
  if (s.awaitingPermission) return "Allow Yama to install apps, then come back to Yama. The update carries on by itself.";
  return s.app ? `A new version of the Yama app is ready: ${s.app.versionName}.` : "";
}

/** The status line in Settings' "Yama app" row. */
export function appStatus(s: AppUpdateState): string {
  if (s.info?.nativeHash === "dev") return "A local build: it doesn't update itself.";
  if (s.app) return `Update available: ${s.app.versionName}`;
  if (s.web) return "Up to date. A web update is ready and starts next time you open the app.";
  if (s.checking) return "Checking for updates…";
  if (s.checkFailed) return "Couldn't check for updates. Try again when you have signal.";
  if (s.checkedAt) return `Up to date (checked ${fmtTime(new Date(s.checkedAt).toISOString())})`;
  return "";
}

/**
 * Settings' "Yama app" row, in the Android app only: the installed app and web build, whether an
 * update is out, and Update (the same install as the banner) or Check for updates.
 */
export function AppUpdateSetting() {
  const s = useAppUpdate();
  const native = s.info ? { versionName: s.info.versionName, versionCode: s.info.versionCode } : null;
  const status = appStatus(s);
  const message = s.app ? appUpdateMessage({ ...s, app: null }) : "";
  return (
    <div className="grp-you-row grp-you-stack">
      <div className="grp-you-line">
        <span className="grp-you-text">
          <b>Yama app</b>
          <span>{versionLine(native, BUILD_COMMIT, BUILD_TIME)}</span>
          {status && <span>{status}</span>}
          {s.app?.notes && <span className="dim">{s.app.notes}</span>}
        </span>
        {s.app ? (
          <Button onClick={() => void installApp()} disabled={s.installing}>{s.installing ? "Downloading…" : "Update app"}</Button>
        ) : s.web ? (
          <Button onClick={() => void Updater.apply({ version: s.web! })}>Reload</Button>
        ) : s.info?.nativeHash !== "dev" ? (
          <Button variant="outline" onClick={() => void checkForUpdates(true)} disabled={s.checking}>{s.checking ? "Checking…" : "Check for updates"}</Button>
        ) : null}
      </div>
      {message && <p className="small" role="status">{message}</p>}
    </div>
  );
}
