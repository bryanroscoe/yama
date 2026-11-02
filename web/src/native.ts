// The Android app (Capacitor) runs this same web build from the device, at https://localhost,
// and talks to the server at API_BASE with a bearer token (api.ts). Everything native-only lives
// here and loads only inside the app, so the web build carries none of it.

import { Capacitor } from "@capacitor/core";
import { API_BASE } from "./api";

/** Inside the Android app rather than a browser. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Pages the server renders rather than the app: the public reference, legal pages, shared decks,
 * profiles and notes, the MCP guide. Keep in step with the list in `web/public/sw.js`. Inside the
 * app they'd fall through to the app shell, so they open on the server in the browser instead.
 */
const SERVER_PAGES = /^\/(about|privacy|tos|delete-account|precons|commanders|docs|u|d|r|mcp)(\/|$)/;

export function isServerPage(path: string): boolean {
  return SERVER_PAGES.test(path) || path === "/sitemap.xml";
}

/**
 * Inside the app: open links to server pages in the browser, on the server, and make Android's
 * back button go back through the app's pages (it closes the app from the first page). Does
 * nothing in a browser.
 */
export function installNative() {
  if (!isNative()) return;
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || !isServerPage(url.pathname)) return;
      e.preventDefault();
      window.open(API_BASE + url.pathname + url.search + url.hash, "_blank");
    },
    true,
  );
  void import("@capacitor/app").then(({ App }) =>
    App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) history.back();
      else void App.exitApp();
    }),
  );
}

/**
 * Google's sign-in inside the app, through Android's Credential Manager: an ID token for the
 * server's Web client ID, which `/api/auth/google` checks exactly as it checks the web button's.
 * The app also needs an Android OAuth client (package name and signing-key SHA-1) in the same
 * Google Cloud project; it identifies the app and never goes in YAMA_GOOGLE_CLIENT_IDS
 * (docs/mobile.md). Resolves null when the person backs out.
 */
export async function nativeGoogleCredential(webClientId: string): Promise<string | null> {
  const { SocialLogin } = await import("@capgo/capacitor-social-login");
  await SocialLogin.initialize({ google: { webClientId, mode: "online" } });
  try {
    const res = await SocialLogin.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    const result = res.result as { idToken?: string | null; responseType?: string };
    if (!result.idToken) throw new Error("Google didn't send an ID token. Try again.");
    return result.idToken;
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}
