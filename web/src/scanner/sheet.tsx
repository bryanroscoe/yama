// The scanner's sheet and camera gestures (Bryan, 13 Nov 2026: "All this extra question stuff
// should be a tapable expandable thing. There should be a pinch-to-zoom on the picture too. I
// should be able to drag away this huge bottom drawer if I want as well").

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const SETTINGS_OPEN = "yama.scan.settingsOpen";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* Private mode: the choice lasts until the scanner closes. */
  }
}

/** Settings folded into one row; open or shut is remembered per device. */
export function ScanSettings({ summary, children }: { summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => readFlag(SETTINGS_OPEN));
  return (
    <details
      className="scan-settings"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        writeFlag(SETTINGS_OPEN, now);
      }}
    >
      <summary>
        <span className="scan-settings-title">Scan settings</span>
        {summary && <span className="scan-settings-summary">{summary}</span>}
      </summary>
      <div className="scan-choices">{children}</div>
    </details>
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
