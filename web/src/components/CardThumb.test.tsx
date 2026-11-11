// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardThumb } from "./CardThumb";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = renderToStaticMarkup;
const SRC = "https://cards.scryfall.io/small/front/a/b/ab.jpg";

describe("CardThumb", () => {
  it("is decoration beside a name: empty alt, loaded lazily from Scryfall with CORS", () => {
    expect(html(<CardThumb src={SRC} />)).toBe(`<img src="${SRC}" alt="" loading="lazy" decoding="async" crossorigin="anonymous" draggable="false"/>`);
  });

  it("is named when the picture is the only thing that says which card it is", () => {
    const out = html(<CardThumb src={SRC} name="Sol Ring" className="scan-thumb" title="Art: Mark Tedin" />);
    expect(out).toContain('alt="Sol Ring"');
    expect(out).toContain('class="scan-thumb"');
    expect(out).toContain('title="Art: Mark Tedin"');
  });

  it("loads at once when asked, for a picture that is on screen from the start", () => {
    expect(html(<CardThumb src={SRC} eager />)).toContain('loading="eager"');
  });

  it("never filters, blurs or fades the picture", () => {
    expect(html(<CardThumb src={SRC} />)).not.toMatch(/style=|filter|opacity/);
  });

  it("draws the fallback, or nothing, when there is no picture", () => {
    expect(html(<CardThumb src={null} />)).toBe("");
    expect(html(<CardThumb src={undefined} fallback={<span className="card-fallback">Sol Ring</span>} />)).toBe('<span class="card-fallback">Sol Ring</span>');
  });
});

describe("CardThumb in the page", () => {
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

  it("swaps in the fallback when the picture fails to load, and tries a new address", () => {
    act(() => root.render(<CardThumb src={SRC} fallback={<span>Sol Ring</span>} />));
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("Sol Ring");
    act(() => root.render(<CardThumb src={`${SRC}?2`} fallback={<span>Sol Ring</span>} />));
    expect(host.querySelector("img")!.getAttribute("src")).toBe(`${SRC}?2`);
  });
});
