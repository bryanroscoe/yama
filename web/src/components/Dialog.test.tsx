// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, openLayers } from "./Dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

function show(node: ReactNode) {
  act(() => root.render(node));
}
const press = (key: string, init: KeyboardEventInit = {}) => {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;

/** A page with a button that opens a dialog, beside other content. */
function Page({ children, onClose }: { children?: ReactNode; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <nav id="nav">
        <a href="/decks">Decks</a>
      </nav>
      <main id="main">
        <button id="opener" onClick={() => setOpen(true)}>
          Edit deck
        </button>
        {open && (
          <Dialog
            title="Edit deck"
            onClose={() => {
              onClose?.();
              setOpen(false);
            }}
          >
            {children ?? (
              <>
                <input id="name" aria-label="Name" />
                <button id="save">Save</button>
              </>
            )}
          </Dialog>
        )}
      </main>
    </>
  );
}

function open(page: ReactNode = <Page />) {
  show(page);
  const opener = document.getElementById("opener")!;
  opener.focus();
  act(() => opener.click());
  return opener;
}

beforeEach(() => {
  host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.style.overflow = "";
});

describe("Dialog", () => {
  it("is a modal dialog named by its heading, with one Close button", () => {
    open();
    const d = dialog();
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(d.getAttribute("aria-labelledby")!)!;
    expect(heading.tagName).toBe("H2");
    expect(heading.textContent).toBe("Edit deck");
    const close = [...d.querySelectorAll("button")].filter((b) => b.textContent === "Close");
    expect(close).toHaveLength(1);
    expect(close[0]!.getAttribute("type")).toBe("button");
  });

  it("takes a label instead when it draws its own first line", () => {
    show(
      <Dialog label="Who goes first?" centered onClose={() => {}}>
        <button>Roll</button>
      </Dialog>,
    );
    const d = dialog();
    expect(d.getAttribute("aria-label")).toBe("Who goes first?");
    expect(d.hasAttribute("aria-labelledby")).toBe(false);
    expect(d.querySelector("h2")).toBeNull();
    expect(d.className).toBe("sheet sheet-centered");
  });

  it("can be an alert dialog, for a question that interrupts", () => {
    show(
      <Dialog label="Delete this deck?" alert onClose={() => {}}>
        <button>Delete</button>
      </Dialog>,
    );
    expect(dialog().getAttribute("role")).toBe("alertdialog");
  });

  it("moves focus to its heading when it opens, and back to the opener when it closes", () => {
    const opener = open();
    expect(document.activeElement).toBe(dialog().querySelector("h2"));
    press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus on a field that asked for it", () => {
    open(
      <Page>
        <input id="name" aria-label="Name" autoFocus />
      </Page>,
    );
    expect(document.activeElement).toBe(document.getElementById("name"));
    // ...and still knows what opened it.
    press("Escape");
    expect(document.activeElement).toBe(document.getElementById("opener"));
  });

  it("makes the rest of the page inert while it is open, and puts it back", () => {
    open();
    const nav = document.getElementById("nav")!;
    const opener = document.getElementById("opener")!;
    expect(nav.inert).toBe(true);
    expect(opener.inert).toBe(true);
    // The dialog and what holds it stay reachable.
    expect(dialog().closest("[inert]")).toBeNull();
    press("Escape");
    expect(nav.inert).toBe(false);
    expect(opener.inert).toBe(false);
  });

  it("doesn't un-inert what was already inert", () => {
    show(<Page />);
    const nav = document.getElementById("nav")!;
    nav.inert = true;
    const opener = document.getElementById("opener")!;
    act(() => opener.click());
    press("Escape");
    expect(nav.inert).toBe(true);
  });

  it("stops the page scrolling under it, and lets it scroll again after", () => {
    document.body.style.overflow = "auto";
    open();
    expect(document.body.style.overflow).toBe("hidden");
    press("Escape");
    expect(document.body.style.overflow).toBe("auto");
  });

  it("keeps Tab inside: from the last control to the first, and back", () => {
    open();
    const d = dialog();
    const close = [...d.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    const save = document.getElementById("save")!;
    // Shift+Tab from the heading it opened on goes to the last control.
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(save);
    // Tab from the last goes round to the first.
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first goes to the last.
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(save);
    // In the middle, Tab is the browser's.
    document.getElementById("name")!.focus();
    expect(press("Tab").defaultPrevented).toBe(false);
  });

  it("brings focus back in when it has fallen out", () => {
    open();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    press("Tab");
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape, on the scrim and on Close", () => {
    const onClose = vi.fn();
    open(<Page onClose={onClose} />);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => document.getElementById("opener")!.click());
    act(() => document.querySelector<HTMLElement>(".scrim")!.click());
    expect(onClose).toHaveBeenCalledTimes(2);

    act(() => document.getElementById("opener")!.click());
    act(() => [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Close")!.click());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dialog()).toBeNull();
  });

  it("still closes on Escape when focus has fallen out of it", () => {
    const onClose = vi.fn();
    open(<Page onClose={onClose} />);
    (document.activeElement as HTMLElement).blur();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets something open inside it take Escape first", () => {
    const onClose = vi.fn();
    open(
      <Page onClose={onClose}>
        {/* A menu inside the dialog that handles Escape itself and marks it handled. */}
        <button id="menu" onKeyDown={(e) => e.key === "Escape" && e.preventDefault()}>
          More
        </button>
      </Page>,
    );
    document.getElementById("menu")!.focus();
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("with two open, Escape closes only the top one", () => {
    const first = vi.fn();
    const second = vi.fn();
    function Two() {
      const [inner, setInner] = useState(true);
      return (
        <Dialog title="Deck" onClose={first}>
          <button id="under">Under</button>
          {inner && (
            <Dialog
              title="Pick a box"
              onClose={() => {
                second();
                setInner(false);
              }}
            >
              <button id="over">Over</button>
            </Dialog>
          )}
        </Dialog>
      );
    }
    show(<Two />);
    expect(openLayers()).toBe(2);
    // The one underneath is out of reach while the top one is open.
    expect(document.getElementById("under")!.inert).toBe(true);
    press("Escape");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(openLayers()).toBe(1);
    expect(document.getElementById("under")!.inert).toBe(false);
    // The page stays locked until the last one closes.
    expect(document.body.style.overflow).toBe("hidden");
    press("Escape");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("with two side by side, only the later one is reachable, and they can close in either order", () => {
    function Side({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <p id="page">Page</p>
          {a && (
            <Dialog title="First" onClose={() => {}}>
              <button id="in-first">One</button>
            </Dialog>
          )}
          {b && (
            <Dialog title="Second" onClose={() => {}}>
              <button id="in-second">Two</button>
            </Dialog>
          )}
        </>
      );
    }
    // jsdom keeps `inert` as a property without reflecting the attribute, so walk up by hand.
    const reachable = (id: string) => {
      for (let el: HTMLElement | null = document.getElementById(id); el; el = el.parentElement) if (el.inert) return false;
      return true;
    };
    // Both at once: the second is on top and usable, the first is out of reach.
    show(<Side a b />);
    expect(openLayers()).toBe(2);
    expect(reachable("in-second")).toBe(true);
    expect(reachable("in-first")).toBe(false);
    expect(reachable("page")).toBe(false);
    // The one underneath closes first: the page stays out of reach, the top one stays usable.
    show(<Side a={false} b />);
    expect(reachable("in-second")).toBe(true);
    expect(reachable("page")).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    show(<Side a={false} b={false} />);
    expect(reachable("page")).toBe(true);
    // The top one closes first: the one underneath is usable again.
    show(<Side a b />);
    show(<Side a b={false} />);
    expect(reachable("in-first")).toBe(true);
    expect(reachable("page")).toBe(false);
    show(<Side a={false} b={false} />);
    expect(reachable("page")).toBe(true);
    expect(openLayers()).toBe(0);
  });

  it("sets itself up once more under StrictMode and leaves nothing behind", () => {
    show(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    const opener = document.getElementById("opener")!;
    opener.focus();
    act(() => opener.click());
    expect(openLayers()).toBe(1);
    expect(document.getElementById("nav")!.inert).toBe(true);
    press("Escape");
    expect(openLayers()).toBe(0);
    expect(document.getElementById("nav")!.inert).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("doesn't let a page's own Escape handler run for a dialog's Escape", () => {
    const pageEscape = vi.fn();
    window.addEventListener("keydown", pageEscape);
    open();
    press("Escape");
    expect(pageEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", pageEscape);
  });
});
