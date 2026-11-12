import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { MenuSeparator, MoreMenu } from "./MoreMenu";

describe("More, a floating menu", () => {
  it("starts closed: one button, no actions on the page", () => {
    const html = renderToStaticMarkup(
      <MoreMenu className="on-art">
        <Button>History</Button>
        <MenuSeparator />
        <Button danger>Delete deck</Button>
      </MoreMenu>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">More<");
    expect(html).not.toContain("History");
    expect(html).not.toContain("more-menu-pop");
  });
});
