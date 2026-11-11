import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardSearchBox } from "./CardSearchBox";
import { moveSuggestion, nameBeingTyped, nameQuery } from "./cardQuery";
import { compileSearch, namePhrase } from "@yama/core";

function box(value: string): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CardSearchBox value={value} onChange={() => undefined} onPick={() => undefined} suggest />
    </QueryClientProvider>,
  );
}

describe("the Cards search box", () => {
  it("asks for a card name in plain words, not search syntax", () => {
    const html = box("");
    expect(html).toContain('placeholder="Search for a card by name"');
    expect(html).not.toMatch(/placeholder="[^"]*(t:|id<=|syntax)/);
    // Named for screen readers, and a combobox with nothing offered yet.
    expect(html).toMatch(/<label[^>]*for="cards-search-input"[^>]*>Search cards<\/label>/);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
  });

  it("offers names only while a name is being typed", () => {
    expect(nameBeingTyped("sol r")).toBe("sol r");
    expect(nameBeingTyped("  Jace, the Mind  ")).toBe("Jace, the Mind");
    expect(nameBeingTyped("mirror-breaker")).toBe("mirror-breaker");
    // Too short to ask, or search syntax: nothing is suggested into the middle of a search.
    for (const draft of ["", "s", "t:elf", "sol t:artifact", "mv<=2", 'o:"draw', "(sol ring)", "-sol ring", "ring -sol", '!"sol ring"', "pow>3"]) {
      expect(nameBeingTyped(draft), draft).toBeNull();
    }
  });

  it("moves through the names with Down and Up, back to the box at either end", () => {
    expect(moveSuggestion(-1, 3, 1)).toBe(0);
    expect(moveSuggestion(2, 3, 1)).toBe(-1);
    expect(moveSuggestion(-1, 3, -1)).toBe(2);
    expect(moveSuggestion(0, 3, -1)).toBe(-1);
    expect(moveSuggestion(-1, 0, 1)).toBe(-1);
  });

  it("searches for a picked name in a way the search grammar reads as that name", () => {
    expect(nameQuery("Sol Ring")).toBe("Sol Ring");
    expect(nameQuery("Jace, the Mind Sculptor")).toBe("Jace, the Mind Sculptor");
    expect(nameQuery("Fire // Ice")).toBe("Fire // Ice");
    // A colon, an "or" or an "and" would be read as syntax: the name goes in quotes.
    expect(nameQuery("Circle of Protection: Red")).toBe('"Circle of Protection: Red"');
    expect(nameQuery("Trick or Treat")).toBe('"Trick or Treat"');
    expect(nameQuery("Sword of Fire and Ice")).toBe('"Sword of Fire and Ice"');
    expect(nameQuery("B.F.M. (Big Furry Monster)")).toBe('"B.F.M. (Big Furry Monster)"');
    expect(nameQuery('Kongming, "Sleeping Dragon"')).toBe("Kongming, Sleeping Dragon");
    // Every one compiles, and names the phrase the results are ranked by.
    for (const name of ["Sol Ring", "Jace, the Mind Sculptor", "Fire // Ice", "Circle of Protection: Red", "Trick or Treat", "Sword of Fire and Ice", "B.F.M. (Big Furry Monster)", 'Kongming, "Sleeping Dragon"', "Will-o'-the-Wisp", "+2 Mace", "Borrowing 100,000 Arrows"]) {
      const q = nameQuery(name);
      expect(() => compileSearch(q), q).not.toThrow();
      expect(namePhrase(q), q).toBe(name.replace(/"/g, "").toLowerCase());
      // The card of that name is found by it.
      expect(compileSearch(q)({ n: name, i: "x", m: null, v: 0, t: "", o: "", c: "", ci: "", p: null, th: null, l: null, r: null, k: [], f: {}, y: null, img: null, e: null }), q).toBe(true);
    }
  });
});
