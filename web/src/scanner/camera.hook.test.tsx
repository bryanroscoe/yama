// @vitest-environment jsdom
// The camera controls publish zoom and torch state only for the camera they were applied to
// (review of #145): a 4× meant for a camera with its own zoom, finishing after a switch to one
// without, must not set that camera's digital zoom.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { clampZoom, useCameraControls, type CameraControlState } from "./camera";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function track(zoom: { min: number; max: number } | null, apply: () => Promise<void>): MediaStreamTrack {
  return { getCapabilities: () => (zoom ? { zoom, torch: true } : {}), applyConstraints: apply, getSettings: () => ({}) } as unknown as MediaStreamTrack;
}

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
    let lit!: Promise<void>;
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

