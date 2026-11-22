// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Printing } from "../api";
import type { Added, Fix } from "./session";

vi.mock("../offline/cards", () => ({ offlineCard: async () => ({ oracle_id: "o-westvale", edhrec_rank: 2400, game_changer: false }) as Card }));
const { ScannedCard } = await import("./AddedList");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry: Added = {
  key: "k",
  name: "Westvale Abbey",
  oracle_id: "o-westvale",
  scryfall_id: "s",
  set: "soi",
  number: "281",
  image: "https://cards.scryfall.io/small/front/a.jpg",
  finish: "nonfoil",
  finishes: ["nonfoil", "foil"],
  container: null,
  copies: 2,
  auto: true,
  prices: { usd: 1.1, usd_foil: 3.2, usd_etched: null, date: "2026-11-14" },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a scanned card, large (Bryan, 16 Nov 2026)", () => {
  it("shows the card at normal size, its dated price, the other finish's price and why it's tagged", async () => {
    act(() => root.render(<ScannedCard a={entry} onFix={async () => undefined} onRetry={async () => undefined} onClose={() => undefined} />));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(host.querySelector<HTMLImageElement>(".scan-big-card img")?.src).toContain("/normal/");
    expect(host.querySelector(".scan-big-price")?.textContent).toBe("$1.10 market each, Nov 14");
    expect(host.textContent).toContain("Foil $3.20");
    expect(host.querySelector(".scan-play-tag")?.textContent).toBe("Played");
    expect(host.querySelector(".scan-big-play")?.textContent).toBe("Played EDHREC #2,400");
  });

  it("changes the finish of the copies added here with one tap", async () => {
    const onFix = vi.fn(async (_a: Added, _f: Fix) => undefined);
    act(() => root.render(<ScannedCard a={entry} onFix={onFix} onRetry={async () => undefined} onClose={() => undefined} />));
    const foil = [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Finish"] button')].find((b) => b.textContent === "Foil")!;
    await act(async () => foil.click());
    expect(onFix).toHaveBeenCalledWith(entry, expect.objectContaining({ finish: "foil", copies: 2, scryfall_id: "s" }));
  });
});

describe("a provisional row, large (card first, printing after)", () => {
  it("lists its printings to pick, and the pick settles it; Remove lets it go", async () => {
    const { Provisional } = await import("./later");
    const row = new Provisional({ name: "Arcane Signet", confidence: 0.9, method: "art" }, 1, true, (p) => ({ name: p.name, scryfall_id: p.scryfall_id, confidence: 0.9, method: "art" }));
    const p = (id: string, set: string, number: string, usd: number | null) =>
      ({ scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: set, collector_number: number, lang: "en", rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null, price_date: "2026-11-20", usd, usd_foil: null, usd_etched: null, eur: null, eur_foil: null }) as Printing;
    row.offer([p("a", "woc", "145", 1.2), p("b", "c19", "236", null)]);
    row.giveUp();
    const later: Added = { ...entry, key: row.key, name: "Arcane Signet", scryfall_id: "", set: "", number: "", prices: null, later: row, wanted: "nonfoil" };
    let closed = 0;
    act(() => root.render(<ScannedCard a={later} onFix={async () => undefined} onRetry={async () => undefined} onClose={() => void (closed += 1)} />));
    expect(host.textContent).toContain("Pick the printing. Not saved to your collection until it has one.");
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((o) => o.querySelector(".scan-printing-number")?.textContent)).toEqual(["#145", "#236"]);
    // The price in the finish it would be filed in; a missing one says so, never $0.
    expect(options[1]!.querySelector(".scan-printing-what")?.textContent).toContain("No price");
    act(() => options[0]!.click());
    expect(row.state).toMatchObject({ phase: "settled", how: "picked", chosen: { scryfall_id: "a" } });
    const other = new Provisional({ name: "Arcane Signet", confidence: 0.9, method: "art" }, 1, true, (x) => ({ name: x.name, confidence: 0.9, method: "art" }));
    act(() => root.render(<ScannedCard a={{ ...later, later: other }} onFix={async () => undefined} onRetry={async () => undefined} onClose={() => void (closed += 1)} />));
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Remove")!.click());
    expect(other.state.phase).toBe("dropped");
    expect(closed).toBe(1);
  });
});

