import { describe, expect, it } from "vitest";
import { pickerPlacement } from "./pickerPlacement";

describe("picker placement", () => {
  const viewport = { width: 1024, height: 640 };
  it("opens a bottom-of-screen field above and keeps the complete scroll box visible", () => {
    const field = { left: 780, top: 558, bottom: 602, width: 220 };
    const p = pickerPlacement(field, viewport);
    expect(p.opensAbove).toBe(true);
    expect(field.top - 4 - p.maxHeight).toBeGreaterThanOrEqual(16);
    expect(field.left + p.left + p.width).toBeLessThanOrEqual(1008);
  });
  it("opens below when there is room, with a readable width even in a narrow seat", () => {
    const field = { left: 16, top: 70, bottom: 114, width: 210 };
    const p = pickerPlacement(field, viewport);
    expect(p.opensAbove).toBe(false);
    expect(p.width).toBeGreaterThan(field.width);
    expect(field.bottom + 4 + p.maxHeight).toBeLessThanOrEqual(624);
  });
  it("fits inside a scrolling sheet as well as the viewport", () => {
    const field = { left: 300, top: 470, bottom: 514, width: 424 };
    const p = pickerPlacement(field, viewport, { top: 300, bottom: 530 });
    expect(p.opensAbove).toBe(true);
    expect(field.top - 4 - p.maxHeight).toBeGreaterThanOrEqual(300);
    expect(p.maxHeight).toBeGreaterThan(100);
  });
  it("caps either direction to the available space in a very short region", () => {
    const field = { left: 40, top: 100, bottom: 144, width: 240 };
    const p = pickerPlacement(field, { width: 320, height: 240 }, { top: 70, bottom: 190 });
    expect(p.maxHeight).toBeLessThanOrEqual(42);
    expect(p.width).toBeLessThanOrEqual(288);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
