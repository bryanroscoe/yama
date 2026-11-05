import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNative, isServerPage, nativeSignInMessage } from "./native";

describe("the Android app", () => {
  it("is off in a browser", () => {
    expect(isNative()).toBe(false);
  });

  it("opens the server's own pages on the server, and keeps the app's pages in the app", () => {
    for (const path of ["/precons", "/precons/methodology", "/commanders", "/about/", "/privacy/", "/tos/", "/delete-account/", "/docs/mcp/", "/u/pat", "/d/abc", "/r/abc", "/sitemap.xml"]) {
      expect(isServerPage(path), path).toBe(true);
    }
    for (const path of ["/", "/decks", "/decks/plan", "/lab", "/lab/runs", "/group", "/play", "/collection", "/cards", "/table/play", "/users", "/docs-ish"]) {
      expect(isServerPage(path), path).toBe(false);
    }
  });

  it("knows every public page the service worker leaves to the server", () => {
    const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const names = sw.match(/\^\\\/\(([a-z|-]+)\)/)?.[1]?.split("|") ?? [];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(isServerPage(`/${name}/x`), name).toBe(true);
  });

  it("turns Google sign-in failures into one plain sentence", () => {
    // What the plugin sent on a debug build with no Android OAuth client (2026-11-05).
    const unregistered = {
      message:
        "Google Sign-In failed: [16] Account reauth failed. The plugin cleared Credential Manager credential-selection state and retried once. If this affects only some users, check OAuth consent screen (External vs Internal, test users in Testing mode), Family Link accounts (ensure filterByAuthorizedAccounts is not set to true), and whether the user disabled Sign in with Google for your app. See Logcat tag GoogleProvider for package, signingSha1, and webClientId.",
    };
    const message = nativeSignInMessage(unregistered);
    expect(message).toMatch(/^Google won't sign in to this version of the app/);
    expect(message).not.toMatch(/Logcat|plugin|OAuth/);
    expect(nativeSignInMessage(new Error("[10] Developer console is not set up correctly."))).toMatch(/this version of the app/);
    // Android 12 reports the same missing registration as a cancellation (Pixel 3, 2026-11-05).
    for (const cancelled of [{ message: "Google Sign-In cancelled by user", code: "USER_CANCELLED" }, new Error("[16] Cancelled by user.")]) {
      expect(nativeSignInMessage(cancelled)).toBe("Sign-in didn't finish. Try again, or sign in to Yama in your browser.");
    }
    expect(nativeSignInMessage(new Error("NoCredentialException: No credentials available"))).toMatch(/no Google account/);
    expect(nativeSignInMessage(new Error("A network error occurred"))).toMatch(/connection/);
    expect(nativeSignInMessage(new Error("Google didn't send an ID token. Try again."))).toBe("Google didn't send an ID token. Try again.");
    expect(nativeSignInMessage("something else")).toBe("Google sign-in didn't work. Try again.");
  });
});
