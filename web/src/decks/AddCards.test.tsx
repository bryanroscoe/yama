// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../api";
import { AddCards } from "./AddCards";
import type { Hit } from "./cardFit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (over: Partial<Hit>): Hit => ({ oracle_id: over.name, mana_cost: null, type_line: "Artifact", oracle_text: "", color_identity: "", legalities: { commander: "legal" }, image_small: null, owned: 0, owned_in: null, ...over }) as Hit;
const HITS: Hit[] = [
  hit({ name: "Sol Ring", owned: 2, owned_in: "Trade binder" }),
  hit({ name: "Lightning Bolt", type_line: "Instant", color_identity: "R" }),
  hit({ name: "Forest", type_line: "Basic Land — Forest", color_identity: "G" }),
  hit({ name: "Channel", type_line: "Sorcery", color_identity: "G", legalities: { commander: "banned" } }),
];
const LIST = "Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n2 Forest";

let host: HTMLElement;
let root: Root;
let client: QueryClient;

/** The page with the search already answered for what gets typed. */
function show(props: { text?: string; identity?: string | null; onChange?: (next: string) => void; disabled?: boolean }) {
  const result: SearchResult = { total: 40, page: 1, page_size: 60, cards: HITS };
  for (const within of ["", " id<=ug"]) client.setQueryData(["search", `ring${within}`, "edhrec", 1], result);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AddCards text={props.text ?? LIST} identity={props.identity === undefined ? "UG" : props.identity} onChange={props.onChange ?? (() => {})} disabled={props.disabled} />
      </QueryClientProvider>,
    ),
  );
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ring");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The search waits a moment after typing stops.
  act(() => vi.advanceTimersByTime(300));
}
const row = (name: string) => [...host.querySelectorAll("li")].find((li) => li.querySelector("b")?.textContent === name)!;
const buttons = (name: string) => [...row(name).querySelectorAll("button")].map((b) => b.textContent);
const press = (name: string, label: string) => act(() => [...row(name).querySelectorAll("button")].find((b) => b.textContent === label)!.click());

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

describe("Add cards", () => {
  it("shows nothing but the search until something is typed", () => {
    act(() => root.render(<QueryClientProvider client={client}><AddCards text={LIST} identity="UG" onChange={() => {}} /></QueryClientProvider>));
    expect(host.querySelector("h2")!.textContent).toBe("Add cards");
    expect(host.querySelector("ul")).toBeNull();
    expect(host.textContent).toContain("Only cards in the commander's colors (Simic)");
  });

  it("says for each result whether it fits the deck and whether you own it", () => {
    show({});
    expect(row("Sol Ring").textContent).toContain("Legal in this deck.");
    expect(row("Sol Ring").textContent).toContain("You own 2 (in Trade binder).");
    expect(row("Lightning Bolt").textContent).toContain("Outside your commander's colors (red).");
    expect(row("Lightning Bolt").textContent).toContain("Not in your collection.");
    expect(row("Channel").textContent).toContain("Banned in Commander.");
    expect(host.textContent).toContain("Showing the 4 most played of 40 matches.");
  });

  it("offers Add for a card not in the list, Remove for one that is, and both for a basic", () => {
    show({});
    expect(buttons("Lightning Bolt")).toEqual(["Add"]);
    expect(buttons("Sol Ring")).toEqual(["Remove"]);
    expect(row("Sol Ring").textContent).toContain("In the list");
    expect(buttons("Forest")).toEqual(["Remove", "Add another"]);
    expect(row("Forest").textContent).toContain("2 in the list");
  });

  it("adds a card to the list's text with one press, and tells a screen reader", () => {
    const onChange = vi.fn();
    show({ onChange });
    press("Lightning Bolt", "Add");
    expect(onChange).toHaveBeenCalledWith(`${LIST}\n1 Lightning Bolt`);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Added Lightning Bolt to the list.");
  });

  it("takes a card out with one press, and adds another copy of a basic", () => {
    const onChange = vi.fn();
    show({ onChange });
    press("Sol Ring", "Remove");
    expect(onChange).toHaveBeenLastCalledWith("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n2 Forest");
    press("Forest", "Add another");
    expect(onChange).toHaveBeenLastCalledWith("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n3 Forest");
  });

  it("has no color filter and judges only the format when the deck has no commander", () => {
    show({ identity: null, text: "1 Sol Ring" });
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(row("Lightning Bolt").textContent).toContain("Legal in Commander.");
  });

  it("holds its buttons while another list loads into the box", () => {
    show({ disabled: true });
    expect([...host.querySelectorAll<HTMLButtonElement>("li button")].every((b) => b.disabled)).toBe(true);
  });
});
