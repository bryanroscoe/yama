import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDES } from "./guides";
import { CommanderPicker, GuideTabs, noCommanderText } from "./ImportParts";

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

describe("a list with no card that can lead it", () => {
  const line = (board: "commander" | "main") => ({ name: "Atraxa, Praetor's Voice", qty: 1, board, maybe: false, set_code: null, collector_number: null, finish: null, suggestions: [] });

  it("says the commander's line didn't match when it is among the lines that matched no card", () => {
    expect(noCommanderText([line("commander")], "below")).toBe("Your commander's line didn't match a card: fix it below.");
    expect(noCommanderText([line("main"), line("commander")], "above")).toBe("Your commander's line didn't match a card: fix it above.");
  });

  it("points at the unmatched lines when the commander may be one of them, and otherwise asks for a commander", () => {
    expect(noCommanderText([line("main")], "below")).toBe("No card read so far can lead a deck. If your commander is one of the lines that didn't match, fix it below.");
    expect(noCommanderText([], "below")).toContain("No card in this list can lead a deck.");
  });

  it("shows that in place of the picker", () => {
    const html = renderToStaticMarkup(<CommanderPicker choices={[]} current={[]} onPick={() => {}} unknown={[line("commander")]} />);
    expect(html).toContain("Your commander&#x27;s line didn&#x27;t match a card: fix it below.");
  });
});
