import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { containerOption, placeName, type Container, type DeckSpares } from "../api";
import { spareBoxChoices, swapText, SwappableSpares } from "./SwappableSpares";

const box = (over: Partial<Container>): Container => ({ id: "c", kind: "box", name: "Box", copies: 0, ...over });

describe("swappable spares", () => {
  it("says what a spare comes in for, and where it came from", () => {
    expect(swapText({ out: "Thought Vessel", bracket: 4, note: null, from: "owner" })).toBe("For Thought Vessel at Bracket 4");
    expect(swapText({ out: "The One Ring", bracket: 2, note: null, from: "plan" })).toBe("For The One Ring at Bracket 2, from the plan's bracket bag");
    expect(swapText({ out: null, bracket: 3, note: "if the table is new", from: "owner" })).toBe("At Bracket 3 (if the table is new)");
  });

  it("offers only boxes that can hold them: no deck box, no other deck's spares", () => {
    const all = [box({ id: "a" }), box({ id: "d", kind: "deck" }), box({ id: "mine", spares_of_deck_id: "d1" }), box({ id: "theirs", spares_of_deck_id: "d2" })];
    expect(spareBoxChoices(all, "d1").map((c) => c.id)).toEqual(["a", "mine"]);
  });

  it("names those copies as in the deck's box in the collection", () => {
    expect(placeName({ container_name: "Riders of Rohan swap bag", spares_of_deck: "Riders of Rohan" })).toBe("Riders of Rohan's box (swappable)");
    expect(placeName({ container_name: null })).toBe("Not filed");
    expect(placeName({ container_name: "Bulk", spares_of_deck: null })).toBe("Bulk");
    expect(containerOption(box({ name: "Riders of Rohan swap bag", spares_of_deck: "Riders of Rohan" }))).toBe("Riders of Rohan's box (swappable): Riders of Rohan swap bag");
    expect(containerOption(box({ name: "Bulk" }))).toBe("Bulk (box)");
  });

  it("lists the spares on the deck page, apart from the 100", () => {
    const qc = new QueryClient();
    const data: DeckSpares = {
      deck_id: "d1",
      deck_name: "Riders of Rohan",
      container_id: "c1",
      container_name: "Riders of Rohan swap bag",
      place: "in Riders of Rohan's box (swappable)",
      copies: 2,
      cards: [
        { oracle_id: "o-tal", name: "Talisman of Creativity", qty: 1, proxies: 0, image_small: null, swaps: [{ out: "Thought Vessel", bracket: 4, note: null, from: "owner" }] },
        { oracle_id: "o-ban", name: "Vanquisher's Banner", qty: 1, proxies: 1, image_small: null, swaps: [] },
      ],
      planned_missing: [{ name: "Heirloom Blade", swaps: [{ out: "Smothering Tithe", bracket: 2, note: null, from: "plan" }] }],
    };
    qc.setQueryData(["deck-spares", "d1"], data);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SwappableSpares deckId="d1" onOpen={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Swappable spares <span class=\"dim num\">2</span>");
    expect(html).toContain("They count toward nothing in the deck: not its legality, stats, prices or exports.");
    expect(html).toContain('href="/collection?container=c1"');
    expect(html).toContain("For Thought Vessel at Bracket 4");
    expect(html).toContain("Vanquisher&#x27;s Banner, proxy");
    expect(html).toContain("Heirloom Blade (for Smothering Tithe at Bracket 2)");
  });
});
