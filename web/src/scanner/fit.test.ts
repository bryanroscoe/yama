import { describe, expect, it } from "vitest";
import { digitalRegion } from "./camera";
import { DEFAULT_ASPECT, fitPicture, MIN_SHOWN, zoomRegion } from "./fit";

// Bryan, 22 Nov 2026: with the sheet part way up, the camera left above it cut the card off top and
// bottom. The picture now never loses more than a sixth or so of its height.
describe("fitting the camera's picture to its box", () => {
  it("shows a phone's upright picture smaller above a raised sheet, with bars at the sides, never cut past MIN_SHOWN", () => {
    // A 412 × 386 camera box (the sheet over half the screen) and a 2160 × 3840 picture.
    const r = fitPicture({ left: 0, top: 0, width: 412, height: 386 }, 2160 / 3840);
    expect(r.height).toBeCloseTo(386 / MIN_SHOWN, 6);
    expect(r.width).toBeCloseTo((386 / MIN_SHOWN) * 0.5625, 6);
    expect(r.width).toBeLessThan(412);
    expect(r.left).toBeCloseTo((412 - r.width) / 2, 6);
    expect(r.top).toBeCloseTo((386 - r.height) / 2, 6);
  });

  it("covers the box as before when that cuts little (the sheet down), and cuts only the sides of a tall box", () => {
    // 412 × 640: covering cuts 13% of the height, inside the 15% allowed.
    const wide = fitPicture({ left: 0, top: 0, width: 412, height: 640 }, 9 / 16);
    expect(wide.width).toBeCloseTo(412, 6);
    expect(wide.height).toBeCloseTo(412 / 0.5625, 6);
    const tall = fitPicture({ left: 0, top: 20, width: 412, height: 860 }, 9 / 16);
    expect(tall.height).toBe(860);
    expect(tall.width).toBeCloseTo(483.75, 2);
    expect(tall.left).toBeCloseTo(-35.875, 3);
    expect(tall.top).toBe(20);
  });

  it("takes an upright phone's shape until the camera says otherwise", () => {
    expect(fitPicture({ left: 0, top: 0, width: 100, height: 200 }, 0).width).toBeCloseTo(200 * DEFAULT_ASPECT);
    expect(fitPicture({ left: 0, top: 0, width: 100, height: 200 }, Number.NaN).width).toBeCloseTo(200 * DEFAULT_ASPECT);
  });

  it("takes for digital zoom what shows on screen: the bars fill as the fitted picture is enlarged (Codex review of #202)", () => {
    // The 412 × 386 box: the picture laid out 255 px wide; at 2× it is 511 px wide, 412 of them shown.
    const zone = zoomRegion(2160, 3840, 2, { width: 412, height: 386 }, true);
    const laid = (386 / MIN_SHOWN) * 0.5625;
    expect(zone.w / 2160).toBeCloseTo(412 / (2 * laid), 6);
    expect(zone.h / 3840).toBeCloseTo(386 / (2 * (386 / MIN_SHOWN)), 6);
    expect(zone.x).toBeCloseTo((2160 - zone.w) / 2, 6);
    // A DOMRect, as getBoundingClientRect gives: its sizes are getters on the prototype.
    class Rect {
      get width() {
        return 412;
      }
      get height() {
        return 386;
      }
    }
    expect(zoomRegion(2160, 3840, 2, new Rect(), true)).toEqual(zone);
    // At 1× the whole frame, as before.
    expect(zoomRegion(2160, 3840, 1, { width: 412, height: 386 }, true)).toEqual({ x: 0, y: 0, w: 2160, h: 3840 });
  });

  it("is the cover fit's digital zoom where the page covers the box (an older web view)", () => {
    for (const box of [{ width: 300, height: 600 }, { width: 412, height: 386 }, { width: 412, height: 860 }])
      for (const z of [1.5, 2, 3]) {
        const a = zoomRegion(1000, 600, z, box, false);
        const b = digitalRegion(1000, 600, z, box);
        expect(a.x).toBeCloseTo(b.x, 6);
        expect(a.y).toBeCloseTo(b.y, 6);
        expect(a.w).toBeCloseTo(b.w, 6);
        expect(a.h).toBeCloseTo(b.h, 6);
      }
    expect(zoomRegion(1000, 600, 2, null, true)).toEqual(digitalRegion(1000, 600, 2));
  });
});
