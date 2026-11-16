// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../api";
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
