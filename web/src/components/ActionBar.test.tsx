import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar } from "./ActionBar";
import { Button } from "./Button";

const html = renderToStaticMarkup;

describe("ActionBar", () => {
  it("is a plain row around its buttons: no role, so the buttons read as they are", () => {
    const out = html(
      <ActionBar>
        <Button variant="primary">Edit list</Button>
        <Button>Share</Button>
      </ActionBar>,
    );
    expect(out).toBe('<div class="action-bar"><button type="button" class="primary">Edit list</button><button type="button">Share</button></div>');
  });

  it("puts the actions at the end, at both ends or in the middle", () => {
    expect(html(<ActionBar align="end" />)).toBe('<div class="action-bar is-end"></div>');
    expect(html(<ActionBar align="between" />)).toBe('<div class="action-bar is-between"></div>');
    expect(html(<ActionBar align="center" />)).toBe('<div class="action-bar is-center"></div>');
  });

  it("can sit inside a line, keep a caller's class and carry a group name", () => {
    expect(html(<ActionBar as="span" className="ps-actions-row" />)).toBe('<span class="action-bar ps-actions-row"></span>');
    expect(html(<ActionBar role="group" aria-label="Deck actions" />)).toBe('<div class="action-bar" role="group" aria-label="Deck actions"></div>');
  });
});
