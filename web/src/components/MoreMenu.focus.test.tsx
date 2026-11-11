// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { MoreMenu } from "./MoreMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

/** A page whose More menu has an action that opens a dialog, as a deck's Deck settings does. */
function Page() {
  const [settings, setSettings] = useState(false);
  return (
    <main>
      <a href="/decks">Decks</a>
      <MoreMenu>
        <button onClick={() => setSettings(true)}>Deck settings</button>
      </MoreMenu>
      {settings && (
        <Dialog title="Deck settings" onClose={() => setSettings(false)}>
          <input aria-label="Name" />
        </Dialog>
      )}
    </main>
  );
}

const more = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("More"))!;
const item = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Deck settings")!;
const escape = () =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

function openSettingsFromTheMenu() {
  act(() => root.render(<Page />));
  more().focus();
  act(() => more().click());
  item().focus();
  act(() => item().click());
  expect(document.querySelector("h2")?.textContent).toBe("Deck settings");
  // The menu, and the item that was pressed, are gone.
  expect(item()).toBeUndefined();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a dialog opened from a More menu", () => {
  it("gives focus back to the More button when it closes (the phone's sheet menu)", () => {
    openSettingsFromTheMenu();
    escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it("gives focus back to the More button when it closes (the laptop's popover menu)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    openSettingsFromTheMenu();
    escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(more());
  });
});
