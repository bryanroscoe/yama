// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MemoryRouter as Router } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallBanner as Banner } from "./InstallBanner";

const ANDROID_APP_URL = "https://github.com/bryanroscoe/yama/releases/download/android-app/yama.apk";
// install.ts keeps the browser's prompt in module state: each test gets a fresh copy.
let InstallBanner: typeof Banner;
let MemoryRouter: typeof Router;

const device = vi.hoisted(() => ({ native: false, standalone: false }));
vi.mock("../native", () => ({ isNative: () => device.native }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
function browser(ua: string, touch = 0) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch });
}
function offer() {
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt });
  act(() => window.dispatchEvent(event));
  return prompt;
}
function draw(at = "/") { act(() => root.render(<MemoryRouter key={at} initialEntries={[at]}><InstallBanner /></MemoryRouter>)); }
beforeEach(async () => {
  vi.resetModules();
  // The router with the banner: a fresh copy of the banner reads its own copy of the router.
  ({ MemoryRouter } = await import("react-router"));
  ({ InstallBanner } = await import("./InstallBanner"));
  localStorage.clear();
  device.native = false;
  device.standalone = false;
  window.matchMedia = vi.fn(() => ({ matches: device.standalone } as MediaQueryList));
  browser("Mozilla/5.0 (X11; Linux x86_64) Chrome/130");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("mobile app installation offer", () => {
  it("does not advertise installation on desktop, even with touch and an install prompt", () => {
    browser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", 10);
    offer(); draw();
    expect(host.textContent).toBe("");
  });
  it("offers the browser prompt on Android and invokes it", async () => {
    browser("Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile");
    draw();
    const prompt = offer();
    expect(host.textContent).toContain("Install Yama");
    // A secondary button: Home under it has its own primary.
    expect(host.querySelector("button")!.textContent).toBe("Install");
    expect(host.querySelector("button.primary")).toBeNull();
    await act(async () => host.querySelector("button")!.click());
    expect(prompt).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  });
  it("offers the Android app beside the browser prompt, and alone where there is no prompt", () => {
    browser("Mozilla/5.0 (Linux; Android 15) Firefox/130 Mobile");
    draw();
    expect(host.textContent).toContain("from the browser's menu, or get the Android app");
    expect(host.querySelector("a")!.getAttribute("href")).toBe(ANDROID_APP_URL);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    offer();
    expect(host.textContent).toContain("home screen, or get the Android app");
    expect(host.querySelectorAll("button")).toHaveLength(2);
    // Nothing here is the page's main action: Home under it has its own.
    expect(host.querySelector(".primary")).toBeNull();
  });
  it("offers no Android app on iPhone", () => {
    browser("Mozilla/5.0 (iPhone) Version/18 Safari/605", 5); draw();
    expect(host.querySelector("a")).toBeNull();
  });
  it("offers it on Home only, not above the life counter's setup or any other page", () => {
    browser("Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile");
    offer();
    for (const at of ["/play/table", "/decks", "/cards", "/profile"]) {
      draw(at);
      expect(host.textContent).toBe("");
    }
    draw("/");
    expect(host.textContent).toContain("Install Yama");
  });
  it("explains the Share menu on iPhone and on iPadOS with a desktop user agent", () => {
    for (const [ua, touch] of [["Mozilla/5.0 (iPhone) Version/18 Safari/605", 5], ["Mozilla/5.0 (Macintosh) Version/18 Safari/605", 5]] as const) {
      browser(ua, touch); draw();
      expect(host.textContent).toContain("Add to Home Screen");
      expect(host.querySelectorAll("button")).toHaveLength(1);
    }
  });
  it("keeps Not now dismissed after remounting", () => {
    browser("iPhone"); draw();
    act(() => host.querySelector("button")!.click());
    expect(host.textContent).toBe("");
    act(() => root.unmount());
    root = createRoot(host); draw();
    expect(host.textContent).toBe("");
  });
  it("does not offer installation in standalone or native apps", () => {
    browser("Android"); offer();
    device.standalone = true; draw();
    expect(host.textContent).toBe("");
    device.standalone = false; device.native = true; draw();
    expect(host.textContent).toBe("");
  });
  it("removes the offer immediately after appinstalled, including the iOS fallback", () => {
    browser("iPhone"); offer(); draw();
    expect(host.textContent).toContain("Install Yama");
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(host.textContent).toBe("");
  });
});
