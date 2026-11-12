// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, ButtonLink } from "./Button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = renderToStaticMarkup;

describe("Button", () => {
  it("is a secondary button that doesn't submit, unless told to", () => {
    expect(html(<Button>Print swap card</Button>)).toBe('<button type="button">Print swap card</button>');
    expect(html(<Button type="submit">Save</Button>)).toBe('<button type="submit">Save</button>');
  });

  it("draws each look with the design system's class", () => {
    expect(html(<Button variant="primary">Approve plan</Button>)).toBe('<button type="button" class="primary">Approve plan</button>');
    expect(html(<Button variant="outline">Copy list</Button>)).toContain('class="outline"');
    expect(html(<Button variant="quiet" size="small">Skip</Button>)).toContain('class="quiet small"');
    expect(html(<Button variant="outline" danger>Delete run</Button>)).toContain('class="outline danger"');
    expect(html(<Button danger>Remove</Button>)).toContain('class="danger"');
    expect(html(<Button variant="destructive">Delete deck</Button>)).toContain('class="destructive"');
    expect(html(<Button variant="secondary">Share</Button>)).not.toContain("class=");
  });

  it("leaves --bad words off a primary and a destructive button, which have their own color", () => {
    expect(html(<Button variant="primary" danger>Approve</Button>)).toContain('class="primary"');
    expect(html(<Button variant="destructive" danger>Delete deck</Button>)).toContain('class="destructive"');
    expect(html(<Button variant="quiet" danger>Delete from collection</Button>)).toContain('class="quiet danger"');
  });

  it("keeps a caller's own class after the look", () => {
    expect(html(<Button variant="primary" className="buy-cart">Buy</Button>)).toContain('class="primary buy-cart"');
    expect(html(<Button className="list-row">Atraxa</Button>)).toContain('class="list-row"');
  });

  it("passes names, states and relationships through to the button", () => {
    const out = html(
      <Button aria-label="Close" aria-pressed={true} aria-expanded={false} aria-controls="menu" disabled title="Close the sheet">
        ×
      </Button>,
    );
    expect(out).toContain('aria-label="Close"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-controls="menu"');
    expect(out).toContain("disabled");
    expect(out).toContain('title="Close the sheet"');
  });
});

describe("Button in the page", () => {
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

  it("calls its handler when pressed, and not when it is off", () => {
    const press = vi.fn();
    act(() => root.render(<Button onClick={press}>Undo</Button>));
    act(() => host.querySelector("button")!.click());
    expect(press).toHaveBeenCalledTimes(1);
    act(() => root.render(<Button onClick={press} disabled>Undo</Button>));
    act(() => host.querySelector("button")!.click());
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("doesn't submit the form it sits in; a submit button does", () => {
    const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    act(() =>
      root.render(
        <form onSubmit={submit}>
          <Button>Add a seat</Button>
          <Button type="submit" variant="primary">Save</Button>
        </form>,
      ),
    );
    const [add, save] = [...host.querySelectorAll("button")];
    act(() => add!.click());
    expect(submit).not.toHaveBeenCalled();
    act(() => save!.click());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("can take focus, and hands its element to a ref", () => {
    const ref = createRef<HTMLButtonElement>();
    act(() => root.render(<Button ref={ref} autoFocus>More</Button>));
    expect(ref.current).toBe(host.querySelector("button"));
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(ref.current);
  });
});

describe("ButtonLink", () => {
  it("is a link in the app for `to`, with the button look", () => {
    const out = html(
      <MemoryRouter>
        <ButtonLink variant="primary" to="/decks/import">Add a deck</ButtonLink>
      </MemoryRouter>,
    );
    expect(out).toMatch(/^<a /);
    expect(out).toContain('class="button primary"');
    expect(out).toContain('href="/decks/import"');
    expect(out).not.toContain("type=");
    expect(out).not.toContain("role=");
  });

  it("is a plain link for `href`, keeping what the caller sets", () => {
    const out = html(
      <ButtonLink href="https://scryfall.com" target="_blank" rel="noreferrer" variant="outline" size="small" className="pb-secondary">
        Open on Scryfall
      </ButtonLink>,
    );
    expect(out).toBe('<a class="button outline small pb-secondary" href="https://scryfall.com" target="_blank" rel="noreferrer">Open on Scryfall</a>');
  });

  it("can say it removes something", () => {
    expect(html(<ButtonLink href="/delete-account/" variant="outline" danger>Delete your account</ButtonLink>)).toContain('class="button outline danger"');
  });

  it("is the secondary look with no variant", () => {
    expect(html(<ButtonLink href="/precons">Precons</ButtonLink>)).toBe('<a class="button" href="/precons">Precons</a>');
  });
});
