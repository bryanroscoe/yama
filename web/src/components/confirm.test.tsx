// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, ConfirmHost, tell } from "./confirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = (name: string) => act(() => button(name).click());
/** Raise a question and let the host draw it. (An object, so awaiting this doesn't wait for the answer.) */
async function raise<T>(question: () => Promise<T>): Promise<{ answer: Promise<T> }> {
  let answer!: Promise<T>;
  await act(async () => {
    answer = question();
  });
  return { answer };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ConfirmHost />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ask", () => {
  const question = { title: "Delete this run?", body: "Its games and results go too.", confirm: "Delete run", danger: true };

  it("draws an alert dialog named by the question, with the consequence and two answers", async () => {
    const { answer: answer } = await raise(() => ask(question));
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-label")).toBe("Delete this run?");
    expect(d.querySelector("h2")!.textContent).toBe("Delete this run?");
    expect(d.textContent).toContain("Its games and results go too.");
    expect([...d.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Delete run"]);
    // No Close beside the heading: the answers are the way out.
    expect(button("Close")).toBeUndefined();
    click("Cancel");
    await expect(answer).resolves.toBe(false);
  });

  it("resolves true for the confirming button and goes away", async () => {
    const { answer: answer } = await raise(() => ask(question));
    click("Delete run");
    await expect(answer).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it("puts focus on Cancel when the other answer destroys something", async () => {
    const { answer: answer } = await raise(() => ask(question));
    expect(document.activeElement).toBe(button("Cancel"));
    expect(button("Delete run").className).toBe("danger");
    click("Cancel");
    await answer;
  });

  it("puts focus on the confirming button when nothing is destroyed", async () => {
    const { answer: answer } = await raise(() => ask({ title: "Stop this run?", confirm: "Stop run" }));
    expect(document.activeElement).toBe(button("Stop run"));
    expect(button("Stop run").className).toBe("primary");
    click("Stop run");
    await answer;
  });

  it("takes Escape as no", async () => {
    const { answer: answer } = await raise(() => ask(question));
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await expect(answer).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it("asks one question at a time, in order", async () => {
    const { answer: first } = await raise(() => ask({ title: "First?", confirm: "Yes" }));
    const { answer: second } = await raise(() => ask({ title: "Second?", confirm: "Yes" }));
    expect(dialog()!.getAttribute("aria-label")).toBe("First?");
    click("Cancel");
    await expect(first).resolves.toBe(false);
    expect(dialog()!.getAttribute("aria-label")).toBe("Second?");
    click("Yes");
    await expect(second).resolves.toBe(true);
  });

  it("falls back to the browser's own when nothing is mounted to draw it", async () => {
    act(() => root.unmount());
    root = createRoot(host);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(ask(question)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete this run? Its games and results go too.");
  });
});

describe("tell", () => {
  it("has one button, and resolves when it is dismissed", async () => {
    const { answer: done } = await raise(() => tell({ title: "Couldn't export", body: "No connection." }));
    const d = dialog()!;
    expect(d.getAttribute("aria-label")).toBe("Couldn't export");
    expect([...d.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["OK"]);
    click("OK");
    await expect(done).resolves.toBeUndefined();
    expect(dialog()).toBeNull();
  });
});
