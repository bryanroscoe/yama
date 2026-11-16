// The scanner's sheet and camera gestures (Bryan, 13 Nov 2026: "All this extra question stuff
// should be a tapable expandable thing. There should be a pinch-to-zoom on the picture too. I
// should be able to drag away this huge bottom drawer if I want as well").

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Dialog } from "../components/ui";

/**
 * Scan settings, over the scanner (Bryan, 16 Nov 2026: "move a lot of the options into a little
 * settings pane, like a little settings icon"): opened from the gear on the camera, or from what
 * the sheet says cards are filed as. The scanner stops reading while it's open.
 */
export function ScanSettings({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <Dialog title="Scan settings" onClose={onClose} className="scan-settings">
      <div className="scan-choices">{children}</div>
    </Dialog>
  );
}

/** The gear on the camera that opens Scan settings. */
export function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** How far apart two touches are. */
const spread = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);

/**
 * Two fingers on the camera view zoom it: the zoom follows the change in their spread from where
 * the pinch began. One finger does nothing here, so taps on the buttons over the view still work.
 */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, zoom: number, zoomTo: (z: number) => void) {
  const latest = useRef({ zoom, zoomTo });
  latest.current = { zoom, zoomTo };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { spread: number; zoom: number } | null = null;
    const begin = (e: TouchEvent) => {
      if (e.touches.length === 2) start = { spread: spread(e.touches), zoom: latest.current.zoom };
    };
    const move = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const d = spread(e.touches);
      if (start.spread > 0) latest.current.zoomTo(start.zoom * (d / start.spread));
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    el.addEventListener("touchstart", begin, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", begin);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [ref]);
}

/** A drag this far (px) down hides the sheet, or this far up brings it back. */
const DRAG_TO_TOGGLE = 56;
/** Less movement than this is a tap on the handle. */
const TAP_SLOP = 8;

/**
 * The sheet's handle: drag it down to hide the sheet and see the whole camera, drag it up (or tap
 * it) to bring the sheet back. The sheet follows the finger while dragging.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>) {
  const [hidden, setHidden] = useState(false);
  const drag = useRef<{ id: number; y: number; dy: number } | null>(null);
  const follow = (dy: number) => {
    const el = sheet.current;
    if (!el) return;
    el.style.transform = dy ? `translateY(${dy}px)` : "";
    el.style.transition = dy ? "none" : "";
  };
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.dy = e.clientY - d.y;
      // Shown: follow downward only. Hidden: follow upward only, a little.
      follow(hidden ? Math.min(0, Math.max(-DRAG_TO_TOGGLE * 1.5, d.dy)) : Math.max(0, d.dy));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hidden],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      follow(0);
      if (Math.abs(d.dy) < TAP_SLOP) setHidden((h) => !h);
      else if (!hidden && d.dy > DRAG_TO_TOGGLE) setHidden(true);
      else if (hidden && d.dy < -DRAG_TO_TOGGLE / 2) setHidden(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hidden],
  );
  const onPointerCancel = useCallback(() => {
    drag.current = null;
    follow(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Enter or Space on the handle (a click with no pointer behind it) toggles too.
  const onClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.detail === 0) setHidden((h) => !h);
  }, []);
  return { hidden, setHidden, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick } };
}
