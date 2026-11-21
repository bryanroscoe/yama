// Draws the outline of each card the finder sees over the camera (outline.ts), redrawn every screen
// frame so it glides between the finder's passes. It writes to the SVG directly: no React render per
// frame. An overlay only: the camera picture under it is never touched.

import { useEffect, useRef } from "react";
import { MAX_OUTLINES, outlinePath, type OutlineStyle, type OutlineTracker } from "./outline";

const nextFrame = (fn: (t: number) => void): number => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(() => fn(performance.now()), 16) as unknown as number));
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

const reducedMotion = () => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
};

export function CardOutline({ tracker, show, style = "corners" }: { tracker: OutlineTracker; show: boolean; style?: OutlineStyle }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let raf = 0;
    let done = false;
    tracker.still = reducedMotion();
    const draw = (t: number) => {
      raf = 0;
      const el = svg.current;
      if (done || !el) return;
      const frames = tracker.frame(t);
      const { w, h } = tracker.size;
      if (w > 0 && h > 0) el.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const groups = el.children;
      for (let i = 0; i < groups.length; i += 1) {
        const g = groups[i] as SVGGElement;
        const f = frames[i];
        const d = f ? outlinePath(f.quad, style) : "";
        g.setAttribute("opacity", f ? f.opacity.toFixed(3) : "0");
        for (let j = 0; j < g.children.length; j += 1) g.children[j]!.setAttribute("d", d);
      }
      if (tracker.active) raf = nextFrame(draw);
    };
    const wake = () => {
      if (!raf && !done) raf = nextFrame(draw);
    };
    tracker.onWake = wake;
    wake();
    return () => {
      done = true;
      if (tracker.onWake === wake) tracker.onWake = null;
      if (raf) cancelFrame(raf);
    };
  }, [tracker, style]);
  // Hidden (a card found, a close-up, a pause): what's drawn fades out rather than vanishing.
  useEffect(() => {
    if (!show) tracker.clear();
  }, [show, tracker]);
  return (
    <svg ref={svg} className="scan-outline" viewBox="0 0 1 1" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {Array.from({ length: MAX_OUTLINES }, (_, i) => (
        <g key={i} opacity="0">
          <path className="scan-outline-shade" />
          <path className="scan-outline-line" />
        </g>
      ))}
    </svg>
  );
}
