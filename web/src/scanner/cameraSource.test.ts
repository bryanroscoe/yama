// @vitest-environment jsdom
// The camera-source seam: the box a read is cut from, the browser's camera as a source, and what
// a timing record calls the camera.
import { describe, expect, it } from "vitest";
import { browserCameraSource, cutBox, sourceLabel } from "./cameraSource";
import type { Quad } from "./types";

const quad: Quad = [
  [100, 200],
  [300, 200],
  [300, 480],
  [100, 480],
];

/** A stand-in <video>: a size and a track, nothing drawn. */
function video(width: number, height: number, frameRate = 30) {
  const track = { label: "camera2 0, facing back", getSettings: () => ({ frameRate }) };
  return { videoWidth: width, videoHeight: height, srcObject: { getVideoTracks: () => [track] } } as unknown as HTMLVideoElement;
}

/** A canvas that records what was drawn into it (jsdom draws nothing). */
function canvas() {
  const drawn: number[][] = [];
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (_s: unknown, ...a: number[]) => drawn.push(a),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    }),
  };
  return { canvas: c as unknown as HTMLCanvasElement, drawn };
}

describe("cutBox", () => {
  it("is the quad's bounds and 8% of its longer side, at full size when it fits", () => {
    // 200 × 280: the margin is 22.4.
    expect(cutBox(quad, 1920, 1080, 2400)).toEqual({ x: 77, y: 177, w: 246, h: 326, k: 1 });
  });
  it("stays inside the frame and scales the longest side down to the limit, never up", () => {
    const b = cutBox(quad, 310, 490, 163);
    expect(b).toMatchObject({ x: 77, y: 177, w: 233, h: 313 });
    expect(b.k).toBeCloseTo(163 / 313);
    expect(cutBox(quad, 1920, 1080, 10_000).k).toBe(1);
  });
});

describe("the browser's camera as a source", () => {
  it("has no frame until the video does, and none without a video", () => {
    expect(browserCameraSource(() => null).frame()).toBeNull();
    expect(browserCameraSource(() => null).info()).toBeNull();
    expect(browserCameraSource(() => video(0, 0)).info()).toBeNull();
  });
  it("reads frames at full resolution: the video itself, one pixel for one", () => {
    const v = video(1920, 1080);
    const s = browserCameraSource(() => v);
    expect(s.kind).toBe("browser");
    expect(s.frame()).toBe(v);
    expect(s.fullScale()).toBe(1);
    expect(s.track()?.label).toBe("camera2 0, facing back");
    expect(s.info()).toMatchObject({ source: "browser", width: 1920, height: 1080, frameRate: 30 });
  });
  it("cuts around a card from the video, with the quad moved into the cut", async () => {
    const { canvas: c, drawn } = canvas();
    const cut = await browserCameraSource(() => video(1920, 1080)).around(quad, c, 163);
    const k = 163 / 326;
    expect(drawn).toEqual([[77, 177, 246, 326, 0, 0, Math.round(246 * k), 163]]);
    expect(cut.image.height).toBe(163);
    expect(cut.quad[0]![0]).toBeCloseTo((100 - 77) * k);
    expect(cut.quad[2]![1]).toBeCloseTo((480 - 177) * k);
  });
  it("draws a box of the frame at the size asked for", async () => {
    const { canvas: c, drawn } = canvas();
    const image = await browserCameraSource(() => video(1920, 1080)).region({ x: 10, y: 20, w: 400, h: 100 }, 800, 200, c);
    expect(drawn).toEqual([[10, 20, 400, 100, 0, 0, 800, 200]]);
    expect([image.width, image.height]).toEqual([800, 200]);
  });
  it("refuses a cut before there is a frame", async () => {
    await expect(browserCameraSource(() => video(0, 0)).around(quad, canvas().canvas)).rejects.toThrow("no frame");
  });
});

describe("sourceLabel", () => {
  it("is the frame's size for a browser's camera, as timing records always had it", () => {
    expect(sourceLabel({ source: "browser", width: 2160, height: 3840 })).toBe("2160×3840");
    expect(sourceLabel({ source: "browser" })).toBeNull();
  });
  it("names the app's camera, its lens and the rate delivered, within the server's 40 characters", () => {
    expect(sourceLabel({ source: "native", width: 2160, height: 3840, lens: "main", frameRate: 58.9, fpsRange: [60, 60] })).toBe("2160×3840 native main 59fps");
    // Before the rate is measured: what the camera was given.
    expect(sourceLabel({ source: "native", width: 1080, height: 1920, lens: "ultrawide", fpsRange: [30, 60] })).toBe("1080×1920 native ultrawide 60fps");
    expect(sourceLabel({ source: "native", width: 2160, height: 3840, lens: "telephoto", frameRate: 120 })!.length).toBeLessThanOrEqual(40);
  });
});
