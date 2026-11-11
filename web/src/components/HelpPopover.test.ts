import { describe, expect, it } from "vitest";
import { popoverPlace } from "./HelpPopover";

describe("where a help popover opens", () => {
  it("starts just left of its button when there is room", () => {
    // A laptop, the button near the left: 380 px wide from x = 292.
    expect(popoverPlace(300, 1440)).toEqual({ left: -8, width: 380 });
  });

  it("moves left to stay on a phone's screen", () => {
    // The Cards help on a 390 px phone: the button at x = 108, the popover 358 px wide.
    const { left, width } = popoverPlace(108, 390);
    expect(width).toBe(358);
    expect(108 + left).toBe(16);
    expect(108 + left + width).toBe(390 - 16);
  });

  it("keeps the same margin for a button at the far right", () => {
    const { left, width } = popoverPlace(1400, 1440);
    expect(1400 + left + width).toBe(1440 - 16);
  });

  it("fits the page beside a scrollbar, not the window", () => {
    // A 400 px window with a 17 px scrollbar: the page is 383 px wide, and the popover's width
    // and its right edge both come from that.
    const { left, width } = popoverPlace(120, 383);
    expect(width).toBe(351);
    expect(120 + left + width).toBe(383 - 16);
    expect(120 + left).toBe(16);
  });
});
