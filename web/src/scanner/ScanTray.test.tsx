// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../api";
import type { RecentCard } from "./price";

const ranks: Record<string, Partial<Card>> = {
  "o-sol": { edhrec_rank: 1, game_changer: false },
  "o-rhystic": { edhrec_rank: 40, game_changer: true },
  "o-westvale": { edhrec_rank: 2400, game_changer: false },
  "o-bulk": { edhrec_rank: 24000, game_changer: false },
};
vi.mock("../offline/cards", () => ({ offlineCard: async (id: string) => (ranks[id] ? ({ oracle_id: id, ...ranks[id] } as Card) : null) }));

const { ScanTray, trayTotal } = await import("./ScanTray");
const { playLine, playTag } = await import("./playable");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prices = (usd: number | null, foil: number | null = null, date = "2026-11-14") => ({ usd, usd_foil: foil, usd_etched: null, date });
const cards: RecentCard[] = [
  { key: "a", name: "Westvale Abbey", set: "soi", number: "281", finish: "foil", copies: 1, prices: prices(1.1, 3.2), image: "https://cards.scryfall.io/small/front/a.jpg", oracleId: "o-westvale" },
  { key: "b", name: "Sol Ring", set: "ecc", number: "57", finish: "nonfoil", copies: 2, prices: prices(1.5, null, "2026-11-15"), image: null, oracleId: "o-sol", state: "saving" },
  { key: "c", name: "Bulk Bear", set: "woc", number: "145", finish: "nonfoil", copies: 1, prices: prices(null), oracleId: "o-bulk", state: "failed" },
  { key: "d", name: "Rhystic Study", set: "pcy", number: "45", finish: "proxy", copies: 1, prices: prices(30), oracleId: "o-rhystic" },
];

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
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("the strip of cards scanned (Bryan, 16 Nov 2026)", () => {
  it("shows each card newest first with its price in the finish filed, and the dated total", async () => {
    const open = vi.fn();
    act(() => root.render(<ScanTray cards={cards} worth={2} onOpen={open} onReview={() => undefined} />));
    await settle();
    const tiles = [...host.querySelectorAll<HTMLButtonElement>(".scan-tile")];
    expect(tiles.map((t) => t.querySelector(".scan-tile-price")?.textContent)).toEqual(["$3.20", "$1.50", "Unsaved", "Proxy"]);
    expect(tiles[0]!.className).toContain("is-newest");
    // Worth it: $3.20 foil at $2. A missing price never is; nor is a proxy, whatever its printing costs.
    expect(tiles.map((t) => t.classList.contains("is-worth"))).toEqual([true, false, false, false]);
    expect(tiles[1]!.className).toContain("is-saving");
    expect(tiles[2]!.className).toContain("is-failed");
    expect(host.querySelector(".scan-tray-last")?.textContent).toBe("Westvale Abbey SOI #281");
    expect(host.querySelector(".scan-tray-total")?.textContent).toBe("5 cards, $6.20 market, Nov 14 to Nov 15, 1 unpriced");
    // A failed save turns Review all into how many weren't saved, which opens the same list.
    expect(host.querySelector(".scan-tray-review")?.textContent).toBe("1 to try again");
    expect(tiles[1]!.getAttribute("aria-label")).toBe("Sol Ring, ECC 57, $1.50, 2 copies, Staple, saving. Show it larger");
    act(() => tiles[2]!.click());
    expect(open).toHaveBeenCalledWith("c");
  });

  it("tags the cards that see play in Commander, and not the bulk: on the card just added, and in every card's label", async () => {
    act(() => root.render(<ScanTray cards={cards} worth={2} />));
    await settle();
    // Only the newest shows its tag (16 Nov 2026: the strip was too busy); every tile still says it.
    expect([...host.querySelectorAll(".scan-tile")].map((t) => t.querySelector(".scan-tile-tag")?.textContent ?? null)).toEqual(["Played", null, null, null]);
    const labels = [...host.querySelectorAll(".scan-tile")].map((t) => t.getAttribute("aria-label") ?? "");
    expect(labels[1]).toContain("Staple");
    expect(labels[3]).toMatch(/Game Changer|GC/);
    // Without onOpen the tiles are pictures, not buttons.
    expect(host.querySelector("button.scan-tile")).toBeNull();
  });

  it("says nothing with no cards", () => {
    act(() => root.render(<ScanTray cards={[]} worth={2} />));
    expect(host.innerHTML).toBe("");
  });

  it("totals only known prices", () => {
    expect(trayTotal([cards[2]!])).toEqual({ head: "1 card", note: "no prices" });
    expect(trayTotal([cards[3]!])).toEqual({ head: "1 card", note: null });
    // A price without a date is in the total and said to be undated; with no dates at all, "date unknown".
    const undated: RecentCard = { key: "u", name: "Undated", finish: "nonfoil", copies: 2, prices: { usd: 3, usd_foil: null, usd_etched: null, date: null } };
    expect(trayTotal([cards[1]!, undated])).toEqual({ head: "4 cards, $9.00", note: "market, Nov 15, 2 undated" });
    expect(trayTotal([undated])).toEqual({ head: "2 cards, $6.00", note: "market, date unknown" });
  });
});

describe("playability", () => {
  it("tags the strongest reason, and says where it comes from", () => {
    expect(playTag({ rank: 50, gameChanger: true })).toBe("game-changer");
    expect(playTag({ rank: 1000, gameChanger: false })).toBe("staple");
    expect(playTag({ rank: 5000, gameChanger: null })).toBe("played");
    expect(playTag({ rank: 5001, gameChanger: false })).toBeNull();
    expect(playTag({ rank: null, gameChanger: null })).toBeNull();
    expect(playTag(null)).toBeNull();
    expect(playLine({ rank: 2400, gameChanger: false })).toBe("Ranked by how many Commander decks run it.");
    expect(playLine({ rank: 24000, gameChanger: false })).toBe("Rarely in Commander decks.");
    expect(playLine({ rank: 40, gameChanger: true })).toBe("On the Game Changer list. Ranked by how many Commander decks run it.");
    expect(playLine({ rank: null, gameChanger: null })).toBeNull();
  });
});

describe("the strip's head is the receipt (design pass, 16 Nov 2026)", () => {
  it("names the card just added with what can be done about it, and says an event in its place", async () => {
    act(() => root.render(<ScanTray cards={cards} worth={2} actions={<button>Undo</button>} />));
    await settle();
    const head = host.querySelector(".scan-tray-head")!;
    expect(head.querySelector(".scan-tray-last")?.textContent).toContain("Westvale Abbey");
    expect(head.querySelector(".scan-tray-do")?.textContent).toBe("Undo");
    act(() => root.render(<ScanTray cards={cards} worth={2} event="Took out Sol Ring (ECC 57)" />));
    await settle();
    expect(head.querySelector(".scan-tray-last")?.textContent).toBe("Took out Sol Ring (ECC 57)");
    expect(head.querySelector(".scan-tray-do")).toBeNull();
  });

  it("offers Clear beside Review all when the host can clear the list", async () => {
    const clear = vi.fn();
    act(() => root.render(<ScanTray cards={cards} worth={2} onReview={() => undefined} onClear={clear} />));
    await settle();
    const button = host.querySelector<HTMLButtonElement>(".scan-tray-clear");
    expect(button?.textContent).toBe("Clear");
    act(() => button!.click());
    expect(clear).toHaveBeenCalledOnce();
    act(() => root.render(<ScanTray cards={cards} worth={2} onReview={() => undefined} />));
    expect(host.querySelector(".scan-tray-clear")).toBeNull();
  });
});
