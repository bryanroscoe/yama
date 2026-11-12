// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pager, ShowMore } from "./Pager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = renderToStaticMarkup;
let host: HTMLElement;
let root: Root;
const buttons = () => [...host.querySelectorAll("button")];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Pager", () => {
  it("is a named navigation landmark with Previous, the page and Next", () => {
    const out = html(<Pager label="Game history pages" page={2} pages={1400} onPrevious={() => {}} onNext={() => {}} />);
    expect(out).toBe(
      '<nav class="pager" aria-label="Game history pages">' +
        '<button type="button" aria-disabled="false">Previous</button>' +
        '<span class="dim num" role="status">Page 2 of 1,400</span>' +
        '<button type="button" aria-disabled="false">Next</button>' +
        "</nav>",
    );
  });

  it("leaves the total out when it isn't known", () => {
    expect(html(<Pager label="Evidence pages" page={3} onNext={() => {}} />)).toContain(">Page 3</span>");
  });

  const off = () => buttons().map((b) => b.getAttribute("aria-disabled") === "true");

  it("turns off the way that has no page, and goes the other way when pressed", () => {
    const next = vi.fn();
    act(() => root.render(<Pager label="Pages" page={1} pages={4} onNext={next} />));
    expect(off()).toEqual([true, false]);
    act(() => buttons()[1]!.click());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("turns both off while a page is loading, and pressing one then does nothing", () => {
    const go = vi.fn();
    act(() => root.render(<Pager label="Pages" page={2} pages={4} busy onPrevious={go} onNext={go} />));
    expect(off()).toEqual([true, true]);
    act(() => buttons()[1]!.click());
    expect(go).not.toHaveBeenCalled();
  });

  it("keeps the keyboard's place on a button that turns itself off", () => {
    // Next on the last page but one: the button goes off under the finger.
    const Pages = ({ page }: { page: number }) => <Pager label="Pages" page={page} pages={2} onPrevious={page > 1 ? () => {} : undefined} onNext={page < 2 ? () => {} : undefined} />;
    act(() => root.render(<Pages page={1} />));
    buttons()[1]!.focus();
    act(() => root.render(<Pages page={2} />));
    expect(off()).toEqual([false, true]);
    expect(document.activeElement).toBe(buttons()[1]);
  });

  it("says the page number when it changes", () => {
    act(() => root.render(<Pager label="Pages" page={2} pages={4} onNext={() => {}} />));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Page 2 of 4");
  });
});

describe("ShowMore", () => {
  it("says how many there are, and what they are when asked", () => {
    expect(html(<ShowMore total={42} onToggle={() => {}} />)).toBe('<button type="button" class="quiet small">Show all 42</button>');
    expect(html(<ShowMore total={1200} noun="printings" onToggle={() => {}} />)).toContain(">Show all 1,200 printings<");
  });

  it("is a toggle that says whether the list is open when it folds back", () => {
    expect(html(<ShowMore total={9} expanded={false} onToggle={() => {}} />)).toBe('<button type="button" class="quiet small" aria-expanded="false">Show all 9</button>');
    expect(html(<ShowMore total={9} expanded onToggle={() => {}} className="h2h-more" />)).toBe('<button type="button" class="quiet small h2h-more" aria-expanded="true">Show fewer</button>');
  });

  it("calls its handler when pressed", () => {
    const toggle = vi.fn();
    act(() => root.render(<ShowMore total={7} onToggle={toggle} />));
    act(() => buttons()[0]!.click());
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
