import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, Loading } from "./ui";

describe("Loading", () => {
  it("is a polite status line that says what is on its way", () => {
    expect(renderToStaticMarkup(<Loading>Loading the deck…</Loading>)).toBe('<p class="loading dim" role="status">Loading the deck…</p>');
  });

  it("says Loading… when the page has nothing more to say", () => {
    expect(renderToStaticMarkup(<Loading />)).toBe('<p class="loading dim" role="status">Loading…</p>');
  });

  it("can leave the announcement to a live region it sits in", () => {
    expect(renderToStaticMarkup(<Loading quiet small>Saving…</Loading>)).toBe('<p class="loading dim small">Saving…</p>');
  });

  it("can be small, padded, or a whole page", () => {
    expect(renderToStaticMarkup(<Loading small>Saving…</Loading>)).toContain('class="loading dim small"');
    expect(renderToStaticMarkup(<Loading padded>Starting the scanner…</Loading>)).toContain('class="loading dim is-padded"');
    const page = renderToStaticMarkup(<Loading page>Loading the game…</Loading>);
    expect(page).toBe('<main class="page"><p class="loading dim" role="status">Loading the game…</p></main>');
  });
});

describe("EmptyState", () => {
  it("is one sentence in a paragraph", () => {
    expect(renderToStaticMarkup(<EmptyState>No playgroup yet.</EmptyState>)).toBe('<p class="empty">No playgroup yet.</p>');
  });

  it("puts the way to add the first thing under the sentence", () => {
    const html = renderToStaticMarkup(<EmptyState action={<a href="/decks/import">Add a deck</a>}>No decks yet.</EmptyState>);
    expect(html).toBe('<div class="empty has-parts"><p>No decks yet.</p><div class="empty-actions"><a href="/decks/import">Add a deck</a></div></div>');
  });

  it("can lead with a heading", () => {
    const html = renderToStaticMarkup(<EmptyState title="No plan for this deck" action={<a href="/decks/plans">How plans work</a>} />);
    expect(html).toContain("<h2>No plan for this deck</h2>");
    expect(html).not.toContain("<p>");
  });

  it("has a dashed slot, a panel and a compact line", () => {
    expect(renderToStaticMarkup(<EmptyState variant="boxed">No changes yet.</EmptyState>)).toBe('<p class="empty is-boxed">No changes yet.</p>');
    expect(renderToStaticMarkup(<EmptyState variant="panel">No plans yet.</EmptyState>)).toContain('class="empty is-panel"');
    expect(renderToStaticMarkup(<EmptyState variant="compact">No swaps yet.</EmptyState>)).toContain('class="empty is-compact"');
  });
});
