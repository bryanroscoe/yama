// @vitest-environment jsdom
// The camera controls publish zoom and torch state only for the camera they were applied to
// (review of #145): a 4× meant for a camera with its own zoom, finishing after a switch to one
// without, must not set that camera's digital zoom.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CameraControls, clampZoom, useCameraControls, type CameraControlState } from "./camera";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function track(zoom: { min: number; max: number } | null, apply: () => Promise<void>): MediaStreamTrack {
  return { getCapabilities: () => (zoom ? { zoom, torch: true } : {}), applyConstraints: apply, getSettings: () => ({}) } as unknown as MediaStreamTrack;
}

describe("the flashlight", () => {
  it("isn't counted on when the camera resolves without turning it on, and knows the person's own taps (review of #208)", async () => {
    let cam!: CameraControlState;
    function Probe() {
      cam = useCameraControls();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    // A browser that skips the setting it can't meet and still resolves: its own report says off.
    const ignoring = { getCapabilities: () => ({ torch: true }), applyConstraints: async () => undefined, getSettings: () => ({ torch: false }) } as unknown as MediaStreamTrack;
    act(() => cam.attach(ignoring));
    let took: boolean | undefined;
    await act(async () => {
      took = await cam.setTorch(true);
    });
    expect(took).toBe(false);
    expect(cam.torch).toBe(false);
    // One that takes it, by the person's own tap.
    let lit = false;
    const taking = { getCapabilities: () => ({ torch: true }), applyConstraints: async (c: { advanced?: { torch?: boolean }[] }) => void (lit = c.advanced?.[0]?.torch ?? lit), getSettings: () => ({ torch: lit }) } as unknown as MediaStreamTrack;
    act(() => cam.attach(taking));
    expect(cam.torchTouched()).toBe(false);
    await act(async () => {
      took = await cam.personSetsTorch(true);
    });
    expect(took).toBe(true);
    expect(cam.torch).toBe(true);
    expect(cam.torchTouched()).toBe(true);
    act(() => root.unmount());
  });
});

describe("useCameraControls across a camera switch", () => {
  it("doesn't publish a zoom or torch that finished after the camera changed", async () => {
    let cam!: CameraControlState;
    function Probe() {
      cam = useCameraControls();
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const zooming = track({ min: 1, max: 10 }, () => slow);
    act(() => cam.attach(zooming));
    let zoomed!: Promise<void>;
    let lit!: Promise<boolean>;
    act(() => {
      zoomed = cam.autoZoom(4) as unknown as Promise<void>;
      lit = cam.setTorch(true);
    });
    // Switched to a camera without its own zoom while those were on their way.
    act(() => cam.attach(track(null, async () => undefined)));
    await act(async () => {
      release();
      await Promise.all([zoomed, lit]);
    });
    expect(cam.zoom).toBe(1);
    expect(cam.torch).toBe(false);
    expect(cam.digital).toBe(1);
    act(() => root.unmount());
  });

  /** A camera whose zoom goes from 1 to `max`, recording what it's asked and reporting where it is. */
  function zoomCamera(max: number, apply: (c: { zoom?: number }) => Promise<void> = async () => undefined) {
    const asked: number[] = [];
    let at = 1;
    const t = {
      getCapabilities: () => ({ zoom: { min: 1, max } }),
      getSettings: () => ({ zoom: at }),
      applyConstraints: async (c: { advanced: { zoom?: number }[] }) => {
        const z = c.advanced[0]?.zoom;
        await apply({ zoom: z });
        if (typeof z === "number") {
          asked.push(z);
          // Like a real camera, it goes no further than it can.
          at = Math.min(max, z);
        }
      },
    } as unknown as MediaStreamTrack;
    return { t, asked };
  }

  it("drops a pinch queued on one camera rather than zooming the next (review of #145)", async () => {
    let cam!: CameraControlState;
    function Probe() {
      cam = useCameraControls();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const a = zoomCamera(10, () => slow);
    act(() => cam.attach(a.t));
    // A pinch to 3× is on its way when the next pinch, to 4×, is queued behind it.
    act(() => cam.zoomTo(3));
    act(() => cam.zoomTo(4));
    // Switched to a camera that zooms only to 2×.
    const b = zoomCamera(2);
    act(() => cam.attach(b.t));
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(b.asked).toEqual([]);
    expect(cam.zoom).toBe(1);
    act(() => root.unmount());
  });

  it("clamps a zoom to the camera in use and shows what the camera reports", async () => {
    let cam!: CameraControlState;
    function Probe() {
      cam = useCameraControls();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    const b = zoomCamera(2);
    act(() => cam.attach(b.t));
    await act(async () => {
      cam.zoomTo(4);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(b.asked).toEqual([2]);
    expect(cam.zoom).toBe(2);
    expect(clampZoom({ torch: false, zoom: { min: 1, max: 10 } }, 9)).toBe(4);
    expect(clampZoom({ torch: false, zoom: null }, 9)).toBe(3);
    act(() => root.unmount());
  });
});


describe("CameraControls: zoom is one button (16 Nov 2026)", () => {
  it("shows the level, opens + and − on a tap, and is gone where the camera can't zoom", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const c = { zoom: 1, canZoomIn: true, canZoomOut: false, zoomIn: () => {}, zoomOut: () => {}, caps: { torch: false }, torch: false, setTorch: () => {}, error: null } as unknown as CameraControlState;
    act(() => root.render(<CameraControls c={c} live />));
    const labels = () => [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels()).toEqual(["Zoom 1×, change it"]);
    act(() => host.querySelector<HTMLButtonElement>(".scan-zoom-level")!.click());
    expect(labels()).toEqual(["Zoom in", "Zoom 1×", "Zoom out"]);
    act(() => root.render(<CameraControls c={{ ...c, canZoomIn: false } as CameraControlState} live />));
    expect(host.querySelector(".scan-zoom-buttons")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("folds + and − away after a few seconds, handing focus on one of them back to the level button (Codex review, 16 Nov 2026)", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const c = { zoom: 1, canZoomIn: true, canZoomOut: true, zoomIn: () => {}, zoomOut: () => {}, caps: { torch: false }, torch: false, setTorch: () => {}, error: null } as unknown as CameraControlState;
    act(() => root.render(<CameraControls c={c} live />));
    act(() => host.querySelector<HTMLButtonElement>(".scan-zoom-level")!.click());
    const zoomIn = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Zoom in")!;
    zoomIn.focus();
    expect(document.activeElement).toBe(zoomIn);
    act(() => vi.advanceTimersByTime(4000));
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(document.activeElement).toBe(host.querySelector(".scan-zoom-level"));
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });
});
