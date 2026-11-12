// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeckAbout, descriptionParagraphs, descriptionToSave, DESCRIPTION_MAX, EditDescription, whoSees } from "./DeckDescription";

const sent = vi.hoisted(() => ({ calls: [] as { path: string; json: unknown }[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { json?: unknown }) => {
    sent.calls.push({ path, json: init?.json });
    return Promise.resolve(null);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a deck's description as text", () => {
  it("splits paragraphs on blank lines and keeps single line breaks", () => {
    expect(descriptionParagraphs("Lands matter.\nRamp first.\r\n\r\n\nThen win.")).toEqual([["Lands matter.", "Ramp first."], ["Then win."]]);
    expect(descriptionParagraphs("  \n ")).toEqual([]);
  });

  it("saves trimmed text, and nothing for a blank one", () => {
    expect(descriptionToSave("  Lands.\r\nMore.  ")).toBe("Lands.\nMore.");
    expect(descriptionToSave(" \n ")).toBeNull();
  });

  it("says who reads it for each kind of sharing", () => {
    expect(whoSees("private")).toContain("only you see it for now");
    expect(whoSees("link")).toContain("anyone with the link can read it now");
    expect(whoSees("public")).toContain("anyone can read it now");
  });
});

describe("About this deck, on the deck page", () => {
  it("shows the description as text, never as markup", () => {
    const html = renderToStaticMarkup(<DeckAbout deck={{ description: "Play <b>big</b> things.\n\n<script>alert(1)</script>", visibility: "link" }} onEdit={() => {}} />);
    expect(html).toContain("About this deck</h2>");
    expect(html).toContain("Play &lt;b&gt;big&lt;/b&gt; things.");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Shown to anyone who can see this deck.");
  });

  it("says a private deck's description is only the owner's for now", () => {
    expect(renderToStaticMarkup(<DeckAbout deck={{ description: "Lands.", visibility: "private" }} onEdit={() => {}} />)).toContain("Only you see this while the deck is private.");
  });

  it("is nothing without a description", () => {
    expect(renderToStaticMarkup(<DeckAbout deck={{ description: null, visibility: "public" }} onEdit={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<DeckAbout deck={{ description: "  ", visibility: "public" }} onEdit={() => {}} />)).toBe("");
  });
});

describe("writing the description", () => {
  let host: HTMLElement;
  let root: Root;
  let closed: number;
  const show = (deck: { id: string; description?: string | null; visibility: "private" | "link" | "public" }) => {
    const client = new QueryClient();
    // The sheet asks before closing with changes (unsaved.tsx), which needs a data router.
    const router = createMemoryRouter([{ path: "/", element: <EditDescription deck={deck} onClose={() => closed++} /> }]);
    act(() => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  };
  const box = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const saveButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save")!;

  beforeEach(() => {
    sent.calls.length = 0;
    closed = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("says right where it is written that anyone who can see the deck reads it", () => {
    show({ id: "d1", description: "Lands.", visibility: "link" });
    expect(box().value).toBe("Lands.");
    const hint = document.getElementById(box().getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Shown to anyone who can see this deck. This deck is link only, so anyone with the link can read it now.");
    expect(document.body.textContent).toContain(`${(DESCRIPTION_MAX - 6).toLocaleString("en-US")} characters left.`);
  });

  it("saves the trimmed text to the deck, and null when it is cleared", async () => {
    show({ id: "d 1", description: null, visibility: "private" });
    type("  Lands matter.  ");
    await act(async () => saveButton().click());
    expect(sent.calls).toEqual([{ path: "/api/decks/d%201", json: { description: "Lands matter." } }]);
    expect(closed).toBe(1);
    type("   ");
    await act(async () => saveButton().click());
    expect(sent.calls[1]!.json).toEqual({ description: null });
  });

  it("won't save past the cap, and says how far over it is", () => {
    show({ id: "d1", description: null, visibility: "private" });
    type("é".repeat(DESCRIPTION_MAX + 3));
    expect(saveButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("3 too many characters.");
    type("é".repeat(DESCRIPTION_MAX));
    expect(saveButton().disabled).toBe(false);
    expect(document.body.textContent).toContain("0 characters left.");
    // Spaces around it aren't saved, so they don't count; characters outside the basic plane count once.
    type(`  ${"é".repeat(DESCRIPTION_MAX)}\n\n`);
    expect(saveButton().disabled).toBe(false);
    type("🂡".repeat(DESCRIPTION_MAX));
    expect(saveButton().disabled).toBe(false);
  });
});
