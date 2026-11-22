// @vitest-environment jsdom
// The collection scanner's host with card first, printing after (scanner/later.ts): a provisional
// row is in the session and the strip at once, saves nothing, and is saved in place once its
// printing settles (the scanner's work, or a pick); taken back out, it simply goes. The scanner
// itself is faked here: only what the host does with the rows it's handed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ScannerViewProps } from "../scanner";
import { Provisional } from "../scanner/later";

const got = vi.hoisted(() => ({ props: null as ScannerViewProps | null, ops: [] as unknown[][] }));
vi.mock("../scanner", async (original) => ({
  ...(await original<typeof import("../scanner")>()),
  ScannerView: (props: ScannerViewProps) => {
    got.props = props;
    return <div className="fake-scanner" />;
  },
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: async (path: string, init?: { method?: string; json?: unknown }) => {
    if (path === "/api/collection/ops" && init?.method === "POST") {
      got.ops.push(init.json as unknown[]);
      return { applied: 1, skipped_duplicates: 0 };
    }
    if (path.startsWith("/api/collection")) return [];
    throw new Error(`offline: ${path}`);
  },
}));

const { ScanToCollection } = await import("./Collection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const printing = (id: string, set: string, number: string, extra: Partial<Printing> = {}): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil", "foil"], released_at: "2024-01-01", image_normal: null, image_small: `https://cards.scryfall.io/small/front/${id}.jpg`, back_image_normal: null, artist: null,
  price_date: "2026-11-20", usd: 1.5, usd_foil: 4, usd_etched: null, eur: null, eur_foil: null, ...extra,
});
const row = () =>
  new Provisional({ name: "Arcane Signet", confidence: 0.93, method: "art" }, 1, true, (p, how) => ({
    name: p.name, set: p.set_code, number: p.collector_number, scryfall_id: p.scryfall_id, oracle_id: p.oracle_id, finishes: p.finishes, thumb: p.image_small, confidence: 0.93, method: "art",
    prices: { usd: p.usd, usd_foil: p.usd_foil, usd_etched: p.usd_etched, date: p.price_date }, ...(how === "price" ? { byPrice: true } : {}),
  }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  got.props = null;
  got.ops.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient();
  const router = createMemoryRouter([{ path: "/", element: <QueryClientProvider client={client}><ScanToCollection containers={[]} onClose={() => undefined} /></QueryClientProvider> }]);
  act(() => root.render(<RouterProvider router={router} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}

describe("the collection scanner's host, card first", () => {
  it("shows a provisional row at once, saves nothing until its printing settles, then saves it in place", async () => {
    const props = await until(() => got.props, "the scanner");
    expect(props.onProvisional).toBeTypeOf("function");
    const r = row();
    act(() => props.onProvisional!(r));
    let tiles = got.props!.recentCards!;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ name: "Arcane Signet", state: "finding", set: undefined });
    expect(got.ops).toEqual([]);
    // Its printings come: the tile gets a picture. The scanner gives up: it waits for a pick.
    act(() => r.offer([printing("p-a", "woc", "145"), printing("p-b", "c19", "236")]));
    act(() => r.giveUp());
    expect(got.props!.recentCards![0]).toMatchObject({ state: "pick", image: "https://cards.scryfall.io/small/front/p-a.jpg" });
    expect(got.ops).toEqual([]);
    // The pick settles it: saved as an add, with the finish chosen when it was scanned.
    act(() => void r.pick(printing("p-b", "c19", "236")));
    await until(() => got.ops.length === 1, "the add");
    expect(got.ops[0]).toEqual([expect.objectContaining({ kind: "add", scryfall_id: "p-b", qty: 1, finish: "nonfoil", proxy: false, container_id: null })]);
    tiles = await until(() => (got.props!.recentCards![0]!.state === undefined ? got.props!.recentCards! : null), "the saved tile");
    expect(tiles[0]).toMatchObject({ key: r.key, set: "c19", number: "236" });
  });

  it("marks a row settled by price", async () => {
    const props = await until(() => got.props, "the scanner");
    const r = row();
    act(() => props.onProvisional!(r));
    act(() => void r.settle(printing("p-a", "woc", "145"), "price"));
    await until(() => got.ops.length === 1, "the add");
    expect(await until(() => got.props!.recentCards![0]!.byPrice, "the by-price mark")).toBe(true);
  });

  it("lets a row go when it's taken back out (Undo) before it settles: nothing is saved", async () => {
    const props = await until(() => got.props, "the scanner");
    const r = row();
    act(() => props.onProvisional!(r));
    expect(got.props!.recentCards).toHaveLength(1);
    await act(async () => got.props!.onUndo!(r.card));
    expect(r.state.phase).toBe("dropped");
    expect(got.props!.recentCards).toHaveLength(0);
    expect(got.ops).toEqual([]);
  });

  it("marks a card the sheet settled by price, with card first off too (review of #195)", async () => {
    const props = await until(() => got.props, "the scanner");
    await act(async () => void (await props.onAccept!({ name: "Arcane Signet", set: "woc", number: "145", scryfall_id: "p-a", finishes: ["nonfoil"], confidence: 0.93, method: "art", byPrice: true }, 1, true)));
    expect(got.props!.recentCards![0]).toMatchObject({ set: "woc", byPrice: true });
  });

  it("lets waiting rows go when the page goes, so none saves afterwards", async () => {
    const props = await until(() => got.props, "the scanner");
    const r = row();
    act(() => props.onProvisional!(r));
    act(() => root.unmount());
    expect(r.state.phase).toBe("dropped");
    root = createRoot(host);
  });

  it("asks before closing with rows still waiting for their printing", async () => {
    const props = await until(() => got.props, "the scanner");
    act(() => props.onProvisional!(row()));
    act(() => got.props!.onClose!());
    await until(() => document.body.textContent?.includes("still waiting for a printing"), "the question");
  });
});
