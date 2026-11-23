// @vitest-environment jsdom
// The outline drawn over the camera (CardOutline.tsx): corner marks where the finder sees a card,
// redrawn each screen frame, and faded out when the scanner stops looking.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardOutline } from "./CardOutline";
import { MAX_OUTLINES, OutlineTracker } from "./outline";
import type { Quad } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: Quad = [[100, 100], [226, 100], [226, 276], [100, 276]];
let frames: ((t: number) => void)[] = [];
let now = 0;
/** One screen frame, `ms` later. */
const tick = (ms = 16) => {
  now += ms;
  const run = frames;
  frames = [];
  for (const f of run) f(now);
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  frames = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const groups = () => [...host.querySelectorAll<SVGGElement>(".scan-outline g")];

describe("the card outline", () => {
  it("draws corner marks where the card is, fading in, in the camera's own pixels", () => {
    const tracker = new OutlineTracker();
    act(() => root.render(<CardOutline tracker={tracker} show />));
    expect(groups()).toHaveLength(MAX_OUTLINES);
    tick();
    // Nothing seen: nothing drawn, and no frames asked for.
    expect(groups().every((g) => g.getAttribute("opacity") === "0")).toBe(true);
    expect(frames).toHaveLength(0);
    // Seen on two passes: steady, so drawn (outline.ts).
    tracker.see([card], { w: 1920, h: 1080 });
    tracker.see([card], { w: 1920, h: 1080 });
    tick();
    const svg = host.querySelector(".scan-outline")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1920 1080");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const g = groups()[0]!;
    const d = g.querySelector(".scan-outline-line")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(4);
    expect(g.querySelector(".scan-outline-shade")!.getAttribute("d")).toBe(d);
    const first = Number(g.getAttribute("opacity"));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    for (let i = 0; i < 12; i += 1) tick();
    expect(Number(g.getAttribute("opacity"))).toBe(1);
  });

  it("fades out when the scanner stops looking, then stops redrawing", () => {
    const tracker = new OutlineTracker();
    act(() => root.render(<CardOutline tracker={tracker} show />));
    // Seen on two passes: steady, so drawn (outline.ts).
    tracker.see([card], { w: 1920, h: 1080 });
    tracker.see([card], { w: 1920, h: 1080 });
    for (let i = 0; i < 12; i += 1) tick();
    act(() => root.render(<CardOutline tracker={tracker} show={false} />));
    tick();
    const mid = Number(groups()[0]!.getAttribute("opacity"));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    for (let i = 0; i < 20; i += 1) tick();
    expect(groups()[0]!.getAttribute("opacity")).toBe("0");
    expect(groups()[0]!.querySelector("path")!.getAttribute("d")).toBe("");
    expect(frames).toHaveLength(0);
  });

  it("stops with the scanner", () => {
    const tracker = new OutlineTracker();
    act(() => root.render(<CardOutline tracker={tracker} show />));
    tracker.see([card], { w: 100, h: 100 });
    act(() => root.unmount());
    expect(tracker.onWake).toBeNull();
    expect(frames).toHaveLength(0);
    root = createRoot(host);
  });
});
