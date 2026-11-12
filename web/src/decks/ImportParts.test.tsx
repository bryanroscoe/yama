import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDES } from "./guides";
import { GuideTabs } from "./ImportParts";

describe("where your deck is, on the import page", () => {
  it("is a named group of buttons that say whether their steps are open", () => {
    const html = renderToStaticMarkup(<GuideTabs guideKey={null} setGuideKey={() => {}} />);
    expect(html).toContain('role="group" aria-label="Where your deck is"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(GUIDES.length);
    // Nothing is chosen at first and a choice can be closed again: these aren't tabs.
    expect(html).not.toMatch(/role="tab|aria-selected/);
    expect(html).not.toContain('id="import-guide"');
  });

  it("points the open one at its steps", () => {
    const first = GUIDES[0]!;
    const html = renderToStaticMarkup(<GuideTabs guideKey={first.key} setGuideKey={() => {}} />);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="true" aria-controls="import-guide"/);
    expect(html).toContain(`id="import-guide" role="region" aria-label="From ${first.name}"`);
  });
});
