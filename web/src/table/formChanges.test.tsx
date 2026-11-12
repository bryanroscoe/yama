// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFormChanges, type FormChanges } from "./formChanges";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
/** The form under test: one value, the hook, and a way to set the value from outside. */
let form: { changes: FormChanges; set: (v: { note: string; deck: string | null }) => void };
function Form() {
  const [value, set] = useState<{ note: string; deck: string | null }>({ note: "", deck: null });
  form = { changes: useFormChanges(value), set };
  return null;
}
const set = (v: { note: string; deck: string | null }) => act(() => form.set(v));

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Form />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("what a form holds that the person entered", () => {
  it("is anything that differs from how the form opened, however it was entered", () => {
    expect(form.changes.changed).toBe(false);
    // Typed.
    set({ note: "Great game", deck: null });
    expect(form.changes.changed).toBe(true);
    // Put back as it was: nothing to lose again.
    set({ note: "", deck: null });
    expect(form.changes.changed).toBe(false);
    // Picked from a list or with the keyboard: no typing and no button, still entered.
    set({ note: "", deck: "atraxa" });
    expect(form.changes.changed).toBe(true);
  });

  it("doesn't count what the form fills in itself, and counts what the person does after", () => {
    // A saved game's players matched to their playgroup: the form says so, then changes its values.
    act(() => form.changes.byItself());
    set({ note: "", deck: "matched" });
    expect(form.changes.changed).toBe(false);
    // From there on, the person's edits count against the new starting point.
    set({ note: "typed", deck: "matched" });
    expect(form.changes.changed).toBe(true);
    set({ note: "", deck: "matched" });
    expect(form.changes.changed).toBe(false);
  });

  it("keeps the person's edit when the form changes something after it", () => {
    set({ note: "typed", deck: null });
    act(() => form.changes.byItself());
    set({ note: "typed", deck: "matched" });
    expect(form.changes.changed).toBe(true);
  });

  it("forgets a change the form announced that never came, so the next edit still counts", () => {
    // A lookup that found nothing to fill in.
    act(() => form.changes.byItself());
    act(() => void vi.advanceTimersByTime(600));
    set({ note: "typed", deck: null });
    expect(form.changes.changed).toBe(true);
  });

  it("starts over after a save: what is carried into the next entry isn't work to lose", () => {
    set({ note: "first game", deck: "atraxa" });
    expect(form.changes.changed).toBe(true);
    // Save and log another: the answers are cleared, the deck stays.
    act(() => form.changes.startOver());
    set({ note: "", deck: "atraxa" });
    expect(form.changes.changed).toBe(false);
    set({ note: "second game", deck: "atraxa" });
    expect(form.changes.changed).toBe(true);
  });
});
