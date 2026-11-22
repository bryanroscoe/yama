import { describe, expect, it } from "vitest";
import { digitalRegion } from "./camera";
import { DEFAULT_ASPECT, fitPicture, MIN_SHOWN, visibleView } from "./fit";

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

  it("gives the part of the picture that shows, and digital zoom takes the middle of that", () => {
    const shown = visibleView({ width: 412, height: 386 }, 2160, 3840);
    expect(shown.height).toBe(386);
    expect(shown.width).toBeCloseTo((386 / MIN_SHOWN) * 0.5625, 6);
    expect(visibleView({ width: 412, height: 860 }, 2160, 3840)).toEqual({ width: 412, height: 860 });
    // At 2× the middle of what shows: half the picture's width, half of the 85% of its height that shows.
    const zone = digitalRegion(2160, 3840, 2, shown);
    expect(zone.w).toBeCloseTo(1080, 3);
    expect(zone.h).toBeCloseTo(3840 * MIN_SHOWN * 0.5, 3);
  });
});
