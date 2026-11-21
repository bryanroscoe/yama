// @vitest-environment jsdom
// The focus pin on the camera view (camera.tsx, cameraFocus.ts): off is the camera's continuous
// autofocus; on pins the lens where the slider puts it, remembered on this device.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CameraControls, useCameraControls, type CameraControlState } from "./camera";
import { FOCUS_KEY } from "./cameraFocus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A camera that records every setting it's given (each call replaces the last, as a browser's does). */
function camera(caps: Record<string, unknown> = { focusMode: ["continuous", "manual"], focusDistance: { min: 0.08, max: 10 }, torch: true }, focusedAt?: number) {
  const applied: Record<string, unknown>[] = [];
  const t = {
    getCapabilities: () => caps,
    getSettings: () => (focusedAt == null ? {} : { focusDistance: focusedAt }),
    applyConstraints: async (c: { advanced: Record<string, unknown>[] }) => void applied.push(c.advanced[0]!),
  } as unknown as MediaStreamTrack;
  return { t, applied, last: () => applied[applied.length - 1] };
}

let cam!: CameraControlState;
let root: Root;
let host: HTMLDivElement;
function Probe() {
  cam = useCameraControls();
  return <CameraControls c={cam} live />;
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});
const pinButton = () => host.querySelector<HTMLButtonElement>(".scan-focus .scan-tool");
const slider = () => host.querySelector<HTMLInputElement>(".scan-focus-slider input");

describe("the focus pin", () => {
  it("is off to start with: continuous autofocus, a button and no slider", async () => {
    const c = camera();
    act(() => cam.attach(c.t));
    await settle();
    expect(c.last()).toEqual({ focusMode: "continuous" });
    expect(cam.focus).toBeNull();
    expect(pinButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(slider()).toBeNull();
  });

  it("isn't offered where the browser can't pin the lens", async () => {
    const c = camera({ focusMode: ["continuous"], torch: true });
    act(() => cam.attach(c.t));
    await settle();
    expect(cam.focusCaps).toBeNull();
    expect(pinButton()).toBeNull();
  });

  it("pins the lens where the camera is focused now, and the slider moves it", async () => {
    const c = camera(undefined, 0.2);
    act(() => cam.attach(c.t));
    await settle();
    await act(async () => pinButton()!.click());
    await settle();
    expect(c.last()).toEqual({ focusMode: "manual", focusDistance: 0.2 });
    expect(cam.focus).toBe(0.2);
    expect(pinButton()?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".scan-focus-slider")?.textContent).toContain("Focus 20 cm");
    // Dragged to the near end.
    act(() => cam.setFocus(0.05));
    await settle();
    expect(c.last()).toEqual({ focusMode: "manual", focusDistance: 0.08 });
    expect(cam.focus).toBe(0.08);
    expect(JSON.parse(localStorage.getItem(FOCUS_KEY)!)).toEqual({ pinned: true, distance: 0.08 });
  });

  it("sends the pin along with the flashlight and zoom, not instead of them", async () => {
    const c = camera();
    act(() => cam.attach(c.t));
    act(() => cam.setFocus(0.3));
    await settle();
    await act(async () => cam.setTorch(true));
    expect(c.last()).toEqual({ focusMode: "manual", focusDistance: 0.3, torch: true });
  });

  it("goes back to autofocus when turned off, dropping the distance, and remembers where it was", async () => {
    const c = camera();
    act(() => cam.attach(c.t));
    act(() => cam.setFocus(0.3));
    await settle();
    await act(async () => pinButton()!.click());
    await settle();
    expect(c.last()).toEqual({ focusMode: "continuous" });
    expect(cam.focus).toBeNull();
    expect(slider()).toBeNull();
    expect(JSON.parse(localStorage.getItem(FOCUS_KEY)!)).toEqual({ pinned: false, distance: 0.3 });
    // Turned on again: where it was last.
    await act(async () => pinButton()!.click());
    await settle();
    expect(c.last()).toEqual({ focusMode: "manual", focusDistance: 0.3 });
  });

  it("stays pinned for the next camera opened on this device, within that camera's range", async () => {
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ pinned: true, distance: 0.05 }));
    const c = camera();
    act(() => cam.attach(c.t));
    await settle();
    expect(c.applied).toEqual([{ focusMode: "manual", focusDistance: 0.08 }]);
    expect(cam.focus).toBe(0.08);
    expect(slider()).not.toBeNull();
  });

  it("leaves a tap to focus alone while pinned", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getSupportedConstraints: () => ({ pointsOfInterest: true }) } });
    const c = camera();
    act(() => cam.attach(c.t));
    act(() => cam.setFocus(0.3));
    await settle();
    const before = c.applied.length;
    act(() => cam.focusAt(0.5, 0.5));
    await settle();
    expect(c.applied.length).toBe(before);
    act(() => cam.setFocus(null));
    await settle();
    act(() => cam.focusAt(0.5, 0.5));
    await settle();
    expect(c.last()).toEqual({ focusMode: "continuous", pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
  });

  it("says so when the camera won't hold a focus, and stays on autofocus", async () => {
    const c = camera();
    let fail = false;
    (c.t as unknown as { applyConstraints: () => Promise<void> }).applyConstraints = async () => {
      if (fail) throw new Error("no");
    };
    act(() => cam.attach(c.t));
    await settle();
    fail = true;
    act(() => cam.setFocus(0.3));
    await settle();
    expect(cam.focus).toBeNull();
    expect(host.querySelector(".scan-tool-error")?.textContent).toBe("The camera didn't hold that focus");
  });
});
