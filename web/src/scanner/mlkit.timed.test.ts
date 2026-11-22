// ML Kit's own time for a read (TextReaderPlugin.java's `ms`) reaches the scanner beside the text,
// so Scanner diagnostics can tell the engine's time from the crossing (Bryan, 22 Nov 2026).
import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", async (original) => ({
  ...(await original<typeof import("@capacitor/core")>()),
  registerPlugin: () => ({
    available: async () => ({ available: true }),
    read: async () => ({ lines: [{ text: "R 0019", confidence: 0.9, left: 0, top: 0, right: 50, bottom: 10 }], ms: 37 }),
  }),
}));

const { createMlKitOcr } = await import("./mlkit");

describe("the ML Kit reader", () => {
  it("gives ML Kit's own time with the text", async () => {
    const ocr = (await createMlKitOcr())!;
    const r = await ocr.read({ width: 2, height: 1, data: new Uint8ClampedArray([0, 255]) }, { mode: "block" });
    expect(r).toMatchObject({ text: "R 0019", ms: 37 });
  });
});
