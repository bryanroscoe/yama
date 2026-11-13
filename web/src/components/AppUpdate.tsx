import { useEffect, useState } from "react";
import { isNative } from "../native";
import { parseManifest, planUpdate, Updater, UPDATE_MANIFEST_URL, WEB_BUILD } from "../nativeUpdate";
import { Button } from "./Button";

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

/** How often the app asks for update.json while it's open or comes back to the front. */
const NATIVE_CHECK_MS = 30 * 60_000;

/**
 * The Android app (nativeUpdate.ts): a web build downloads quietly and starts with the app next
 * time, with a Reload offer meanwhile; a newer APK gets an Update button.
 */
function NativeAppUpdate() {
  const [web, setWeb] = useState<string | null>(null);
  const [app, setApp] = useState<{ versionCode: number; url: string; sha256: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let checking = false;
    let last = 0;
    // This build started: keep it (the updater goes back to the previous one otherwise).
    void Updater.started({ version: WEB_BUILD }).catch(() => {});
    const check = async (force = false) => {
      if (checking || (!force && Date.now() - last < NATIVE_CHECK_MS) || !navigator.onLine) return;
      checking = true;
      last = Date.now();
      try {
        const info = await Updater.info();
        if (info.nativeHash === "dev") return;
        if (info.next && info.next !== WEB_BUILD && live) setWeb(info.next);
        const manifest = parseManifest((await Updater.fetchText({ url: `${UPDATE_MANIFEST_URL}?t=${Date.now()}` })).text);
        if (!manifest || !live) return;
        const plan = planUpdate(info, manifest, WEB_BUILD);
        if (plan.kind === "app") setApp(plan);
        else if (plan.kind === "web") {
          const { version } = await Updater.downloadBuild(plan);
          if (live) setWeb(version);
        }
      } catch { /* Offline or GitHub unreachable: try again later. */ }
      finally { checking = false; }
    };
    void check(true);
    const interval = window.setInterval(() => void check(), NATIVE_CHECK_MS);
    const resumed = import("@capacitor/app").then(({ App }) => App.addListener("resume", () => void check()));
    return () => {
      live = false;
      window.clearInterval(interval);
      void resumed.then((h) => h.remove());
    };
  }, []);
  const install = async () => {
    if (!app) return;
    setBusy(true);
    setNote(null);
    try {
      const { status } = await Updater.installApk(app);
      setNote(status === "permission" ? "Allow Yama to install updates, then come back and tap Update again." : null);
    } catch {
      setNote("The update didn't download. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  if (app) {
    return (
      <aside className="app-update" role="status">
        <span>{note ?? "A new version of the Yama app is ready."}</span>
        <Button onClick={() => void install()} disabled={busy}>{busy ? "Downloading…" : "Update"}</Button>
      </aside>
    );
  }
  if (web) {
    return (
      <aside className="app-update" role="status">
        <span>A Yama update is ready. It starts next time you open the app, or reload now after saving open edits.</span>
        <Button onClick={() => void Updater.apply({ version: web })}>Reload</Button>
      </aside>
    );
  }
  return null;
}
