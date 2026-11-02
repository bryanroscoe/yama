import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: { target: unknown }) => Promise<void> | void;
function harness(writeText: (text: string) => Promise<void>) {
  const listeners = new Map<string, Listener>();
  const box = { value: "1 Sol Ring\n", focus: vi.fn(), select: vi.fn() };
  const button = { hidden: true, textContent: "Copy", dataset: { copy: "shop-buy" } as Record<string, string>, closest: (s: string) => (s === "button[data-copy]" ? button : null) };
  const document = { readyState: "complete", querySelectorAll: () => [button], getElementById: (id: string) => (id === "shop-buy" ? box : null), addEventListener: (name: string, fn: Listener) => listeners.set(name, fn) };
  runInNewContext(readFileSync(new URL("../public/share-copy-v1.js", import.meta.url), "utf8"), { document, navigator: { clipboard: { writeText } }, setTimeout: vi.fn() });
  return { box, button, click: () => listeners.get("click")?.({ target: button }) };
}

describe("shared page copy buttons", () => {
  it("shows the buttons and copies the box's text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const h = harness(writeText);
    expect(h.button.hidden).toBe(false);
    await h.click();
    expect(writeText).toHaveBeenCalledWith("1 Sol Ring\n");
    expect(h.button.textContent).toBe("Copied");
  });
  it("selects the text when the clipboard is refused", async () => {
    const h = harness(() => Promise.reject(new Error("denied")));
    await h.click();
    expect(h.box.select).toHaveBeenCalled();
    expect(h.button.textContent).toBe("Selected: press copy");
  });
});
