import { describe, expect, it } from "vitest";
import { cardDistance, tooCloseToFocus } from "./closer";

describe("how far away the card is, for the lens's nearest focus (Bryan, 22 Nov 2026)", () => {
  it("estimates the distance from the card's share of the picture and the lens's focal length", () => {
    // A 26 mm main lens, the card 44% of the picture's height: about 15 cm away.
    expect(cardDistance(0.44, 26)).toBeCloseTo(0.15, 2);
    // Twice the zoom, the same share: twice as far.
    expect(cardDistance(0.44, 26, 2)).toBeCloseTo(0.3, 2);
    expect(cardDistance(0, 26)).toBeNull();
    expect(cardDistance(0.5, 0)).toBeNull();
  });

  it("says the card is too close only past the lens's nearest focus, with a tenth to spare", () => {
    const main = { equivalent: 26, nearest: 0.15 };
    // Bryan's Pixel held a card at 53% to 61% of the picture (Scanner diagnostics): about 11 to 12 cm.
    expect(tooCloseToFocus(0.57, main)).toBe(true);
    expect(tooCloseToFocus(0.44, main)).toBe(false);
    // Zoomed in 1.5×, the same share is further away.
    expect(tooCloseToFocus(0.57, main, 1.5)).toBe(false);
  });

  it("trusts only figures a phone's lens could have", () => {
    expect(tooCloseToFocus(0.9, null)).toBe(false);
    expect(tooCloseToFocus(0.9, { equivalent: 0, nearest: 0.15 })).toBe(false);
    expect(tooCloseToFocus(0.9, { equivalent: 26, nearest: 0 })).toBe(false);
    expect(tooCloseToFocus(0.9, { equivalent: 26, nearest: 5 })).toBe(false);
  });
});
