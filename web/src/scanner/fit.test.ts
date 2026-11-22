import { describe, expect, it } from "vitest";
import { digitalRegion } from "./camera";
import { DEFAULT_ASPECT, fitHeight, visibleView } from "./fit";

// Bryan, 22 Nov 2026: with the sheet part way up, the camera left above it cut the card off top and
// bottom. The picture now always shows its whole height.
describe("fitting the camera's picture to its box", () => {
  it("shows a phone's upright picture at its full height above a raised sheet, with bars at the sides", () => {
    // A 412 × 386 camera box (the sheet over half the screen) and a 2160 × 3840 picture.
    const r = fitHeight({ left: 0, top: 0, width: 412, height: 386 }, 2160 / 3840);
    expect(r.height).toBe(386);
    expect(r.width).toBeCloseTo(217.1, 1);
    expect(r.left).toBeCloseTo((412 - 217.1) / 2, 1);
    expect(r.top).toBe(0);
  });

  it("cuts only the sides, as before, when the box is narrower than the picture (the sheet down)", () => {
    const r = fitHeight({ left: 0, top: 20, width: 412, height: 860 }, 9 / 16);
    expect(r.width).toBeCloseTo(483.75, 2);
    expect(r.left).toBeCloseTo(-35.875, 3);
    expect(r.top).toBe(20);
  });

  it("takes an upright phone's shape until the camera says otherwise", () => {
    expect(fitHeight({ left: 0, top: 0, width: 100, height: 160 }, 0).width).toBeCloseTo(160 * DEFAULT_ASPECT);
    expect(fitHeight({ left: 0, top: 0, width: 100, height: 160 }, Number.NaN).width).toBeCloseTo(160 * DEFAULT_ASPECT);
  });

  it("gives the part of the picture that shows: the whole height, and as much width as the box has", () => {
    expect(visibleView({ width: 412, height: 386 }, 2160, 3840)).toEqual({ width: (386 * 2160) / 3840, height: 386 });
    expect(visibleView({ width: 412, height: 860 }, 2160, 3840)).toEqual({ width: 412, height: 860 });
    // Digital zoom then takes the middle of the whole height, not of a cut-down one.
    const zone = digitalRegion(2160, 3840, 2, visibleView({ width: 412, height: 386 }, 2160, 3840));
    expect(zone.h).toBeCloseTo(1920);
    expect(zone.w).toBeCloseTo(1080);
  });
});
