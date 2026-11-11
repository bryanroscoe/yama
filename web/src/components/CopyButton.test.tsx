// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";
import { ErrorText } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const button = () => host.querySelector("button")!;
const press = () => act(async () => button().click());
const clipboard = (writeText: (text: string) => Promise<void>) => Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("copies the text, says Copied for two seconds, and tells a screen reader", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    clipboard(writeText);
    act(() => root.render(<CopyButton text="1 Sol Ring" label="Copy the list" className="outline" />));
    expect(button().textContent).toBe("Copy the list");
    expect(button().getAttribute("type")).toBe("button");
    expect(button().className).toBe("outline");
    await press();
    expect(writeText).toHaveBeenCalledWith("1 Sol Ring");
    expect(button().textContent).toBe("Copied");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Copied");
    act(() => vi.advanceTimersByTime(2000));
    expect(button().textContent).toBe("Copy the list");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
  });

  it("stops saying Copied when the text changes", async () => {
    clipboard(() => Promise.resolve());
    act(() => root.render(<CopyButton text="1 Sol Ring" label="Copy" />));
    await press();
    expect(button().textContent).toBe("Copied");
    act(() => root.render(<CopyButton text="Sol Ring" label="Copy" />));
    expect(button().textContent).toBe("Copy");
  });

  it("shows the text to copy by hand when the browser refuses", async () => {
    clipboard(() => Promise.reject(new Error("denied")));
    act(() => root.render(<CopyButton text="1 Sol Ring" label="Copy the list" />));
    await press();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Copy the list");
    expect(dialog.querySelector("textarea")!.value).toBe("1 Sol Ring");
    expect(button().textContent).toBe("Copy the list");
  });

  it("can be turned off", () => {
    act(() => root.render(<CopyButton text="" label="Copy" disabled />));
    expect(button().disabled).toBe(true);
  });
});

describe("ErrorText", () => {
  it("draws nothing for no error", () => {
    expect(renderToStaticMarkup(<ErrorText error={null} />)).toBe("");
    expect(renderToStaticMarkup(<ErrorText error={undefined} retry={() => {}} />)).toBe("");
  });

  it("is an alert with the error's words, from an Error or a message", () => {
    expect(renderToStaticMarkup(<ErrorText error={new Error("That deck is private.")} />)).toBe('<p class="error" role="alert">That deck is private.</p>');
    expect(renderToStaticMarkup(<ErrorText small error="Couldn't reach the printer." />)).toBe('<p class="error small" role="alert">Couldn&#x27;t reach the printer.</p>');
  });

  it("offers Try again on the same line when asking again can work", () => {
    const retry = vi.fn();
    act(() => root.render(<ErrorText error={new Error("Yama didn't answer.")} retry={retry} />));
    const again = button();
    expect(again.textContent).toBe("Try again");
    expect(again.getAttribute("type")).toBe("button");
    expect(again.parentElement!.getAttribute("role")).toBe("alert");
    act(() => again.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
