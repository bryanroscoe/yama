// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedPrompt, type UnsavedGuard } from "./unsaved";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};
const guard = (over: Partial<UnsavedGuard> = {}): UnsavedGuard => ({ asking: true, stay: vi.fn(), leave: vi.fn(), close: vi.fn(), allow: vi.fn(), ...over });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the unsaved-work question", () => {
  it("draws nothing until a way out is waiting for an answer", () => {
    act(() => root.render(<UnsavedPrompt guard={guard({ asking: false })} />));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("is a named alert dialog that says what would be lost, with the safe answer focused", () => {
    act(() => root.render(<UnsavedPrompt guard={guard()} what="your changes to this list" />));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Leave without saving?");
    expect(dialog.textContent).toContain("If you leave now, your changes to this list will be lost.");
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Keep editing", "Leave without saving"]);
    expect(document.activeElement).toBe(button("Keep editing"));
  });

  it("keeps Tab round its two buttons and never out to the page behind", () => {
    act(() => root.render(<UnsavedPrompt guard={guard()} />));
    button("Leave without saving").focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Keep editing"));
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("Leave without saving"));
    // In between, the browser's own move is right.
    button("Keep editing").focus();
    expect(press("Tab").defaultPrevented).toBe(false);
  });

  it("takes Escape and the scrim as keep editing, and each button as its own answer", () => {
    const g = guard();
    act(() => root.render(<UnsavedPrompt guard={g} />));
    press("Escape");
    expect(g.stay).toHaveBeenCalledTimes(1);
    act(() => document.querySelector<HTMLElement>(".scrim")!.click());
    expect(g.stay).toHaveBeenCalledTimes(2);
    act(() => button("Keep editing").click());
    expect(g.stay).toHaveBeenCalledTimes(3);
    expect(g.leave).not.toHaveBeenCalled();
    act(() => button("Leave without saving").click());
    expect(g.leave).toHaveBeenCalledTimes(1);
  });
});
