// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/Dialog";
import { PageHeader } from "../components/PageHeader";
import { BugReportProvider, dialogName } from "./BugReport";
import { boxFrom, commonAncestor, overlaps, pathOf, readRegion, squeeze } from "./region";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function show(node: ReactNode, enabled = true) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/decks/42?tab=list"]}>
          <BugReportProvider enabled={enabled}>{node}</BugReportProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

const bugs = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Report a bug"]')];
const click = (el: Element) => act(() => (el as HTMLElement).click());
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;

function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function WithDialog() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <PageHeader title="Atraxa" />
      {open && (
        <Dialog title="Add cards" onClose={() => setOpen(false)}>
          <p>Search</p>
        </Dialog>
      )}
    </>
  );
}

describe("reporting a bug", () => {
  it("shows the bug on page and dialog heads only for someone signed in", () => {
    show(<WithDialog />, false);
    expect(bugs()).toHaveLength(0);
    show(<WithDialog />, true);
    expect(bugs()).toHaveLength(2);
  });

  it("sends the words, the page and the dialog it came from", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "r1" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    show(<WithDialog />);
    const inDialog = bugs().find((b) => b.closest("[role=dialog]"))!;
    click(inDialog);
    const form = [...document.querySelectorAll("[role=dialog]")].find((d) => d.textContent?.includes("Report a bug"))!;
    expect(form).toBeTruthy();
    // No bug button inside the report itself.
    expect(form.querySelector('button[aria-label="Report a bug"]')).toBeNull();
    expect(form.textContent).toContain("the Add cards dialog");
    const send = byText("Send report");
    expect(send.disabled).toBe(true);
    type(form.querySelector("textarea")!, "  The count is off  ");
    expect(byText("Send report").disabled).toBe(false);
    await act(async () => {
      byText("Send report").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/bug-reports");
    const body = JSON.parse(String(init.body));
    expect(body.message).toBe("The count is off");
    expect(body.page).toBe("/decks/42?tab=list");
    expect(body.context.dialog).toBe("Add cards");
    expect(body.context.heading).toBe("Atraxa");
    expect(body.context.viewport.w).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Thanks for the report");
  });

  it("points at a part of the screen by tapping it, and Escape goes back without one", () => {
    show(
      <>
        <PageHeader title="Atraxa" />
        <ul id="cards">
          <li id="sol">
            Sol Ring <button>Remove</button>
          </li>
        </ul>
      </>,
    );
    click(bugs()[0]!);
    click(byText("Point at it"));
    const picker = document.querySelector<HTMLElement>(".bug-picker")!;
    expect(picker).toBeTruthy();
    expect(picker.getAttribute("aria-label")).toBe("Point at the problem");

    // Escape: back to the form, nothing picked.
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector(".bug-picker")).toBeNull();
    expect(byText("Point at it")).toBeTruthy();

    click(byText("Point at it"));
    const sol = document.getElementById("sol")!;
    sol.getBoundingClientRect = () => ({ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
    document.elementsFromPoint = () => [document.querySelector(".bug-picker")!, sol];
    const at = { clientX: 50, clientY: 30, pointerId: 1, bubbles: true };
    const layer = document.querySelector(".bug-picker")!;
    act(() => {
      layer.dispatchEvent(new PointerEvent("pointerdown", at));
      layer.dispatchEvent(new PointerEvent("pointerup", at));
    });
    expect(document.querySelector(".bug-picker")).toBeNull();
    expect(document.body.textContent).toContain("You pointed at");
    expect(document.body.textContent).toContain("Sol Ring");
    expect(document.querySelector(".bug-mini-box")).toBeTruthy();
  });
});

describe("what a box covers", () => {
  it("makes a box from two corners either way round", () => {
    expect(boxFrom(30, 40, 10, 5)).toEqual({ x: 10, y: 5, w: 20, h: 35 });
  });

  it("overlaps only what it touches", () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(overlaps(box, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
    expect(overlaps(box, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(overlaps(box, { left: 2, top: 2, right: 2, bottom: 2 })).toBe(false);
  });

  it("folds whitespace and cuts long text", () => {
    expect(squeeze("  a \n\n b  ", 10)).toBe("a b");
    expect(squeeze("abcdefghij", 5)).toBe("abcd…");
  });

  it("names where an element sits and what holds several", () => {
    document.body.innerHTML = '<main class="page decks"><ul id="list"><li class="row">a</li><li class="row">b</li></ul></main>';
    const [a, b] = [...document.querySelectorAll("li")];
    expect(commonAncestor([a!, b!])?.id).toBe("list");
    expect(pathOf(a!)).toBe("main.page.decks › ul#list › li.row");
    expect(dialogName(a)).toBeUndefined();
  });

  it("reads the words, controls and pictures in the box", () => {
    document.body.innerHTML = '<section id="s"><p>Sol Ring</p><button aria-label="Remove Sol Ring">x</button><img alt="Sol Ring card"></section>';
    const s = document.getElementById("s")!;
    const r = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    for (const el of s.querySelectorAll("*")) (el as HTMLElement).getBoundingClientRect = () => r;
    document.elementsFromPoint = () => [s];
    const region = readRegion({ x: 0, y: 0, w: 50, h: 50 }, null);
    expect(region.text).toContain("Sol Ring");
    expect(region.controls).toEqual(["button: Remove Sol Ring"]);
    expect(region.images).toEqual(["Sol Ring card"]);
  });
});
