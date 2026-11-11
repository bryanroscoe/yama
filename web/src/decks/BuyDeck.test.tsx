// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { BuyDeck } from "./BuyDeck";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (name: string, over: Partial<DeckEntry> = {}): DeckEntry =>
  ({ oracle_id: name, name, qty: 1, board: "main", owned: 0, proxies: 0, needed: 1, cheapest_usd: null, cheapest_printing: null, card: null, ...over }) as DeckEntry;
const priced = (usd: number, date: string) => ({ cheapest_usd: usd, cheapest_printing: { scryfall_id: "p", set_code: "cmm", set_name: "Commander Masters", collector_number: "1", date } });
const CARDS = [
  entry("Omo, Queen of Vesuva", { board: "commander", owned: 1, ...priced(1.5, "2026-11-10") }),
  entry("Sol Ring", { ...priced(1.25, "2026-11-10") }),
  entry("Mystery Card"),
  entry("Forest", { qty: 8, owned: 8, ...priced(0.1, "2026-11-10") }),
];

let host: HTMLElement;
let root: Root;
const show = (cards: DeckEntry[]) => act(() => root.render(<BuyDeck cards={cards} />));
const links = () => [...host.querySelectorAll("a")].map((a) => `${a.textContent!.trim()} -> ${a.getAttribute("href")}`);
const segment = (label: RegExp) => [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => label.test(b.textContent!))!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Buy this deck", () => {
  it("offers the cards still needed first, with a dated market total and what has no price", () => {
    show(CARDS);
    expect(host.querySelector("h2")!.textContent).toBe("Buy this deck");
    expect(segment(/still need/).getAttribute("aria-pressed")).toBe("true");
    expect(segment(/still need/).textContent).toBe("Cards you still need (2)");
    expect(host.textContent).toContain("$1.25 for 2 cards at market prices, 1 card without a price. TCGplayer market via Scryfall, Nov 10. Basic lands left out.");
    expect(links()).toEqual([
      "Open in TCGplayer Mass Entry -> https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Sol%20Ring||1%20Mystery%20Card",
      "Open in Card Kingdom's deck builder -> https://www.cardkingdom.com/builder?c=1%20Sol%20Ring%0A1%20Mystery%20Card",
    ]);
    for (const a of host.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer");
    }
    expect(host.textContent).toContain("Yama earns nothing from these links.");
  });

  it("switches to the whole list", () => {
    show(CARDS);
    act(() => segment(/whole list/).click());
    expect(segment(/whole list/).textContent).toBe("The whole list (11)");
    expect(host.textContent).toContain("$3.55 for 11 cards at market prices, 1 card without a price.");
    expect(host.textContent).not.toContain("Basic lands left out.");
    expect(links()[1]).toBe("Open in Card Kingdom's deck builder -> https://www.cardkingdom.com/builder?c=1%20Omo%2C%20Queen%20of%20Vesuva%0A1%20Sol%20Ring%0A1%20Mystery%20Card%0A8%20Forest");
  });

  it("says No price, never $0, when nothing in the list has a price", () => {
    show([entry("Mystery Card")]);
    expect(host.textContent).toContain("No price for 1 card at market prices, 1 card without a price.");
    expect(host.textContent).not.toContain("$0");
  });

  it("offers the whole list when nothing is left to get", () => {
    show([entry("Sol Ring", { owned: 1, ...priced(1.25, "2026-11-10") })]);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.textContent).toContain("You have a copy or a proxy of every card that isn't a basic land.");
    expect(links()).toHaveLength(2);
  });

  it("gives the list to paste, and no dead link, when it is too long for an address", () => {
    show(Array.from({ length: 400 }, (_, i) => entry(`A Card With A Rather Long Name Number ${i}`)));
    expect(links()).toEqual([]);
    expect(host.textContent).toContain("This list is too long for a link.");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Copy the list")).toBe(true);
  });

  it("shows nothing for a deck with no cards", () => {
    show([entry("Negate", { board: "side" })]);
    expect(host.innerHTML).toBe("");
  });
});
