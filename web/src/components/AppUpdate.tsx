import { useEffect, useState } from "react";

export function shellBuild(html: string): string | null {
  return html.match(/<meta name="yama-precache" content="(\/assets\/precache-[\w-]+\.json)"/)?.[1] ?? null;
}

/** An open tab keeps its loaded code across releases. Offer a reload after saving edits. */
export function AppUpdate() {
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
  return available ? <aside className="app-update" role="status"><span>A Yama update is ready. Save open edits before reloading.</span><button onClick={() => window.location.reload()}>Reload</button></aside> : null;
}
