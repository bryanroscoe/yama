import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BackLink } from "./BackLink";

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("BackLink", () => {
  it("is a link named for where it goes, with a chevron a screen reader skips", () => {
    const out = html(<BackLink to="/decks/plans" label="Back to plans" />);
    expect(out).toMatch(/^<a [^>]*aria-label="Back to plans"/);
    expect(out).toContain('href="/decks/plans"');
    expect(out).toContain('class="area-back"');
    expect(out).toContain('<svg width="20" height="20"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("<span");
  });

  it("shows the place beside the chevron when it has words", () => {
    const out = html(<BackLink to="/decks/abc" label="Back to Blight Curse" text="Blight Curse" />);
    expect(out).toContain('class="area-back has-text"');
    expect(out).toContain('<span class="area-back-text">Blight Curse</span>');
  });

  it("sits on an art header", () => {
    expect(html(<BackLink to="/decks" label="Back to decks" text="Decks" onArt />)).toContain('class="area-back has-text on-art"');
  });

  it("names itself from the place when no label is given", () => {
    expect(html(<BackLink to="/decks" text="Decks" onArt />)).toContain('aria-label="Back to Decks"');
    expect(html(<BackLink inline to="/sharing" text="Sharing" />)).toContain('aria-label="Back to Sharing"');
  });

  it("is a line of words on a page with no top row, keeping a caller's class", () => {
    const out = html(<BackLink inline to="/play" label="Back to Play online" text="Play online" className="lobby" />);
    expect(out).toContain('class="back-inline lobby"');
    expect(out).toContain('aria-label="Back to Play online"');
    expect(out).toContain("<span>Play online</span>");
  });
});
