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
 * profiles and notes, the MCP guide, phase's board. Keep in step with the list in `web/public/sw.js`. Inside the
 * app they'd fall through to the app shell, so they open on the server in the browser instead.
 */
const SERVER_PAGES = /^\/(about|privacy|tos|delete-account|precons|commanders|docs|u|d|r|board|mcp)(\/|$)/;

export function isServerPage(path: string): boolean {
  return SERVER_PAGES.test(path) || path === "/sitemap.xml";
}

/** Go to a path: a server page opens on the server in the browser inside the app; anything else in place. */
export function openPage(path: string) {
  if (isNative() && isServerPage(new URL(path, location.href).pathname)) window.open(API_BASE + path, "_blank");
  else location.assign(path);
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
 * (docs/mobile.md).
 */
export async function nativeGoogleCredential(webClientId: string): Promise<string> {
  const { SocialLogin } = await import("@capgo/capacitor-social-login");
  await SocialLogin.initialize({ google: { webClientId, mode: "online" } });
  try {
    // No `scopes`: the defaults (openid, email, profile) are all Yama asks for, and custom
    // scopes would need a modified MainActivity.
    const res = await SocialLogin.login({ provider: "google", options: {} });
    const result = res.result as { idToken?: string | null; responseType?: string };
    if (!result.idToken) throw new Error("Google didn't send an ID token. Try again.");
    return result.idToken;
  } catch (e) {
    const message = nativeSignInMessage(e);
    // The plugin's own text is a paragraph meant for developers: it stays in the log (logcat
    // shows it as Capacitor/Console), and the sign-in page gets one plain sentence.
    console.error("Google sign-in failed:", errorText(e));
    throw new Error(message);
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * What the sign-in page says when the app's Google sign-in fails. Credential Manager reports an
 * app Google doesn't recognise (no Android OAuth client for this package and signing key, or
 * sign-in turned off for it in the Google account) as "[16] Account reauth failed" or "[10]"
 * (DEVELOPER_ERROR) on recent Android, and the plugin only adds advice to it. Android 12 reports
 * the same failure as USER_CANCELLED, just after the person picked an account, so a cancellation
 * gets a quiet line rather than nothing: it can't be told apart from backing out.
 */
export function nativeSignInMessage(e: unknown): string {
  const text = errorText(e);
  if (/\[10\]|reauth|developer.?error|unregistered/i.test(text)) {
    return "Google won't sign in to this version of the app. Sign in to Yama in your browser for now.";
  }
  if (/cancel/i.test(text)) return "Sign-in didn't finish. Try again, or sign in to Yama in your browser.";
  if (/no ?credential|no google account|no account/i.test(text)) {
    return "There's no Google account on this phone. Add one in Settings, then try again.";
  }
  if (/network|timed? ?out|unreachable|offline/i.test(text)) {
    return "Couldn't reach Google. Check your connection and try again.";
  }
  if (/didn't send an ID token/.test(text)) return text;
  return "Google sign-in didn't work. Try again.";
}
