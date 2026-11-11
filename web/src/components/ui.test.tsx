import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, Loading, Segmented } from "./ui";

describe("Segmented", () => {
  const options = [["list", "List"], ["pictures", "Pictures"]] as const;

  it("is a labelled group of buttons, the chosen one pressed", () => {
    const html = renderToStaticMarkup(<Segmented label="View" value="list" onChange={() => {}} options={options} />);
    expect(html).toBe(
      '<div class="segmented" role="group" aria-label="View">' +
        '<button type="button" aria-pressed="true">List</button>' +
        '<button type="button" aria-pressed="false">Pictures</button>' +
        "</div>",
    );
  });

  it("can take its name from a label already on the page", () => {
    const html = renderToStaticMarkup(<Segmented labelledBy="speed-label" value={2} onChange={() => {}} options={[[1, "1x"], [2, "2x"]]} />);
    expect(html).toContain('aria-labelledby="speed-label"');
    expect(html).not.toContain("aria-label=");
  });

  it("presses nothing when the value matches no segment", () => {
    const html = renderToStaticMarkup(<Segmented label="Speed" value={undefined} onChange={() => {}} options={[["1x", "1x"], ["2x", "2x"]]} />);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("names a short label in full, and turns off one segment or all of them", () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Bracket"
        value={null}
        onChange={() => {}}
        options={[
          { value: null, label: "None", title: "Not declared" },
          { value: 3, label: "3", title: "3, Upgraded", disabled: true },
        ]}
      />,
    );
    expect(html).toContain('<button type="button" title="Not declared" aria-label="Not declared" aria-pressed="true">None</button>');
    expect(html).toContain('<button type="button" title="3, Upgraded" aria-label="3, Upgraded" aria-pressed="false" disabled="">3</button>');
    const off = renderToStaticMarkup(<Segmented label="View" value="list" disabled onChange={() => {}} options={options} />);
    expect(off.match(/disabled=""/g)).toHaveLength(2);
  });

  it("has a compact track and can sit inside a line of text", () => {
    const html = renderToStaticMarkup(<Segmented as="span" compact className="deck-view" label="View" value="list" onChange={() => {}} options={options} />);
    expect(html).toMatch(/^<span class="segmented is-compact deck-view" role="group"/);
  });

  it("never uses the radio or tab roles", () => {
    const html = renderToStaticMarkup(<Segmented label="View" value="list" onChange={() => {}} options={options} />);
    expect(html).not.toMatch(/role="(radio|radiogroup|tab|tablist)"/);
    expect(html).not.toMatch(/aria-(checked|selected)/);
  });
});

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
