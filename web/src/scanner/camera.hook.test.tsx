// @vitest-environment jsdom
// The camera controls publish zoom and torch state only for the camera they were applied to
// (review of #145): a 4× meant for a camera with its own zoom, finishing after a switch to one
// without, must not set that camera's digital zoom.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useCameraControls, type CameraControlState } from "./camera";

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
});
