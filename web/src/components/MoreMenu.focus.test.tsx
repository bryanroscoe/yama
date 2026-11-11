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

/** An action that keeps its own dialog inside the menu's items, with a control that opens another. */
function Nested() {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <MoreMenu>
      <span>
        {/* It keeps the menu open: its dialog lives inside the menu's items. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setFirst(true);
          }}
        >
          Export
        </button>
        {first && (
          <Dialog title="Export" onClose={() => setFirst(false)}>
            <button
              id="format"
              onClick={(e) => {
                e.stopPropagation();
                setSecond(true);
              }}
            >
              Choose a format
            </button>
            {second && (
              <Dialog title="Format" onClose={() => setSecond(false)}>
                <input aria-label="Format" />
              </Dialog>
            )}
          </Dialog>
        )}
      </span>
    </MoreMenu>
  );
}

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

  it("goes back to the control inside a dialog that sits in the menu, not to More behind it", () => {
    act(() => root.render(<Nested />));
    act(() => more().click());
    const exportButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Export")!;
    act(() => exportButton.click());
    const format = document.getElementById("format")!;
    format.focus();
    act(() => format.click());
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Format");
    escape();
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).not.toContain("Format");
    expect(document.activeElement).toBe(format);
  });
});
