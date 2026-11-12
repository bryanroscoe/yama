import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPill, Tag, toneOf } from "./StatusPill";

const html = renderToStaticMarkup;

describe("StatusPill", () => {
  it("is a neutral pill of text unless it has a tone", () => {
    expect(html(<StatusPill>Archived</StatusPill>)).toBe('<span class="tag">Archived</span>');
    expect(html(<StatusPill tone="neutral">Archived</StatusPill>)).toBe('<span class="tag">Archived</span>');
  });

  it("carries its tone as a class beside the words that say what", () => {
    expect(html(<StatusPill tone="good">In the deck</StatusPill>)).toBe('<span class="tag good">In the deck</span>');
    expect(html(<StatusPill tone="warn">Waiting for your OK</StatusPill>)).toBe('<span class="tag warn">Waiting for your OK</span>');
    expect(html(<StatusPill tone="bad">Banned</StatusPill>)).toBe('<span class="tag bad">Banned</span>');
  });

  it("is plain text to a screen reader: no role, no live region, nothing hidden", () => {
    const out = html(<StatusPill tone="warn">Need 3 cards</StatusPill>);
    expect(out).not.toMatch(/role=|aria-/);
    expect(out).toContain(">Need 3 cards<");
  });

  it("keeps the caller's class, title and other attributes", () => {
    const out = html(
      <StatusPill tone="good" className="cp-yours" title="In your collection" id="yours">
        Yours, 2
      </StatusPill>,
    );
    expect(out).toBe('<span class="tag good cp-yours" title="In your collection" id="yours">Yours, 2</span>');
  });

  it("is a link when it has somewhere to go, and keeps its tone", () => {
    expect(html(<StatusPill href="#changes">3 in, 3 out</StatusPill>)).toBe('<a class="tag" href="#changes">3 in, 3 out</a>');
    expect(html(<StatusPill tone="warn" href="#questions">2 questions</StatusPill>)).toBe('<a class="tag warn" href="#questions">2 questions</a>');
  });
});

describe("Tag", () => {
  it("is the neutral pill, for a label that names a kind", () => {
    expect(html(<Tag>Foil</Tag>)).toBe('<span class="tag">Foil</span>');
    expect(html(<Tag className="gc" title="On the Game Changers list">Game Changer</Tag>)).toBe('<span class="tag gc" title="On the Game Changers list">Game Changer</span>');
  });
});

describe("toneOf", () => {
  it("reads a tone from a word, and anything else as neutral", () => {
    expect(toneOf("good")).toBe("good");
    expect(toneOf("warn")).toBe("warn");
    expect(toneOf("bad")).toBe("bad");
    for (const other of ["quiet", "dim", "plain", "", null, undefined]) expect(toneOf(other)).toBe("neutral");
  });
});
