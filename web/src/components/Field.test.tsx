// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckRow, Field } from "./Field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = renderToStaticMarkup;
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Field", () => {
  it("is one label around the words and the control", () => {
    expect(html(<Field label="Deck name"><input defaultValue="Blight Curse" /></Field>)).toBe('<label>Deck name<input value="Blight Curse"/></label>');
    expect(html(<Field label="Finish" className="coll-finish"><select><option>Foil</option></select></Field>)).toBe('<label class="coll-finish">Finish<select><option>Foil</option></select></label>');
  });

  it("names its control, and pressing the words focuses it", () => {
    act(() => root.render(<Field label="Join code"><input /></Field>));
    const input = host.querySelector("input")!;
    expect(input.labels?.[0]?.textContent).toBe("Join code");
    // jsdom sends a label's click on to its control, as a browser does.
    const pressed = vi.fn();
    input.addEventListener("click", pressed);
    act(() => host.querySelector("label")!.click());
    expect(pressed).toHaveBeenCalled();
  });

  /** The words a screen reader reads as the control's name: what `aria-labelledby` points at. */
  const nameOf = (control: Element) => document.getElementById(control.getAttribute("aria-labelledby") ?? "")?.textContent;

  it("marks the control invalid and describes it by the error, which is announced", () => {
    act(() => root.render(<Field label="Most a card may cost" error="That isn't a price."><input /></Field>));
    const input = host.querySelector("input")!;
    const error = host.querySelector('[role="alert"]')!;
    expect(error.textContent).toBe("That isn't a price.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("keeps the error and the hint out of the control's name", () => {
    act(() => root.render(<Field label="Most a card may cost" hint="In dollars." error="That isn't a price."><input /></Field>));
    const input = host.querySelector("input")!;
    // Everything in a wrapping label would otherwise be the name, error and all.
    expect(nameOf(input)).toBe("Most a card may cost");
    expect(input.getAttribute("aria-describedby")!.split(" ")).toHaveLength(2);
    // Pressing the words still reaches the control.
    expect(input.labels?.[0]).toBe(host.querySelector("label"));
  });

  it("describes the control by a hint, keeping a description the caller set", () => {
    act(() => root.render(<Field label="Handle" hint="Letters and numbers."><input aria-describedby="taken" /></Field>));
    const input = host.querySelector("input")!;
    const hint = host.querySelector(".hint")!;
    expect(input.getAttribute("aria-describedby")).toBe(`taken ${hint.id}`);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(nameOf(input)).toBe("Handle");
  });

  it("leaves the control untouched when there is nothing to add", () => {
    const out = html(<Field label="Note"><textarea defaultValue="" /></Field>);
    expect(out).not.toMatch(/aria-|id=/);
  });
});

describe("CheckRow", () => {
  it("is one label around a checkbox and its words", () => {
    expect(html(<CheckRow checked onChange={() => {}}>Foil</CheckRow>)).toBe('<label><input type="checkbox" checked=""/>Foil</label>');
  });

  it("can be a radio, with a name and a value", () => {
    expect(html(<CheckRow type="radio" name="who" value="me" defaultChecked>Only me</CheckRow>)).toBe('<label><input type="radio" name="who" checked="" value="me"/>Only me</label>');
  });

  it("names its box, and pressing the words checks it", () => {
    const change = vi.fn();
    act(() => root.render(<CheckRow onChange={change} className="check" hint="Counted with real cards.">Proxy</CheckRow>));
    const box = host.querySelector("input")!;
    expect(box.labels?.[0]).toBe(host.querySelector("label"));
    expect(host.querySelector("label")!.className).toBe("check");
    // The hint describes the box; its name is the words alone.
    expect(document.getElementById(box.getAttribute("aria-labelledby")!)!.textContent).toBe("Proxy");
    expect(document.getElementById(box.getAttribute("aria-describedby")!)!.textContent).toBe("Counted with real cards.");
    act(() => host.querySelector("label")!.click());
    expect(change).toHaveBeenCalledTimes(1);
    expect(box.checked).toBe(true);
  });

  it("can be turned off", () => {
    expect(html(<CheckRow disabled>Send by email</CheckRow>)).toContain("disabled");
  });
});
