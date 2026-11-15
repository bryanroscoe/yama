// @vitest-environment jsdom
// The scanner's flow after a printing is chosen (Bryan, 15 Nov 2026): tapping a printing files it
// at once with Undo on the camera; the card is then held back as the same card, and "Scan anyway"
// files one more copy of it; the ways in used now and then sit in More. No camera here, so the
// card comes from a typed name.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ScanCandidate } from "./types";

const printing = (set: string, n: string): Printing => ({
  scryfall_id: `id-${set}-${n}`, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: n, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null,
  price_date: null, usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    if (path.startsWith("/api/cards/autocomplete")) return Promise.resolve(["Arcane Signet"]);
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: false, printings: [printing("woc", "145"), printing("cmm", "390"), printing("c21", "236")] });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: () => Promise.reject(new Error("no bundle here")),
}));
vi.mock("./serverCatalog", () => ({
  createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => [] }),
}));
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async () => ({ engine: "tesseract", read: async () => ({ text: "", confidence: 0 }), terminate: async () => undefined }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView ??= () => undefined;

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
async function until<T>(get: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}
const click = (el: HTMLElement) => act(() => el.click());

async function typeName() {
  const input = await until(() => document.querySelector<HTMLInputElement>('input[aria-label="Card name"]'), "the name box");
  await act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Arcane");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(await until(() => button("Arcane Signet"), "the suggestion"));
}

describe("ScannerView after a printing is chosen", () => {
  it("files a tapped printing at once, offers Undo, then Scan anyway files one more of it", async () => {
    const accepted: [ScanCandidate, number, boolean][] = [];
    const undone: ScanCandidate[] = [];
    act(() =>
      root.render(
        <ScannerView
          onAccept={async (c, n, auto) => {
            accepted.push([c, n, auto]);
            return true;
          }}
          onUndo={async (c) => {
            undone.push(c);
          }}
        />,
      ),
    );
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    // No extra confirm: the tap files it.
    await click(options[1]!);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]![0]).toMatchObject({ name: "Arcane Signet", set: "cmm", number: "390", scryfall_id: "id-cmm-390" });
    expect(accepted[0]!.slice(1)).toEqual([1, false]);
    expect(button("Add anyway")).toBeUndefined();

    // Undo on the camera, once saved.
    await until(() => button("Undo"), "Undo");
    expect(document.querySelector(".scan-chip")?.textContent).toContain("Added Arcane Signet (CMM 390)");

    // The card is held as the one just added: Scan anyway files another copy, same printing.
    await click(await until(() => button("Scan anyway"), "Scan anyway"));
    expect(accepted).toHaveLength(2);
    expect(accepted[1]![0]).toMatchObject({ scryfall_id: "id-cmm-390" });
    expect(accepted[1]!.slice(1)).toEqual([1, false]);
    // Still held after it, so another Scan anyway is a third copy, never one by itself.
    await until(() => button("Scan anyway"), "Scan anyway again");

    // Undo takes back the newest copy: the card object handed to onAccept for it.
    await click(await until(() => button("Undo"), "Undo for the extra copy"));
    await until(() => (undone.length ? undone : null), "the undo");
    expect(undone[0]).toBe(accepted[1]![0]);
  });

  it("files one copy for a double tap on Scan anyway, and drops the offer when the finish changes", async () => {
    const accepted: ScanCandidate[] = [];
    let release: (ok: boolean) => void = () => undefined;
    const view = (finish: "nonfoil" | "foil") => (
      <ScannerView
        finish={finish}
        onAccept={(c) => {
          accepted.push(c);
          // The first save goes through; Scan anyway's waits until released.
          return accepted.length === 1 ? Promise.resolve(true) : new Promise<boolean>((r) => (release = r));
        }}
      />
    );
    act(() => root.render(view("nonfoil")));
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    const again = await until(() => button("Scan anyway"), "Scan anyway");
    await act(() => {
      again.click();
      again.click();
    });
    expect(accepted).toHaveLength(2);
    expect(button("Adding…")?.disabled).toBe(true);
    await act(async () => release(true));
    await until(() => button("Scan anyway"), "Scan anyway after the save");
    expect(accepted).toHaveLength(2);

    // Foil now: another copy wouldn't be the same as the one filed, so the offer goes.
    act(() => root.render(view("foil")));
    await wait(20);
    expect(button("Scan anyway")).toBeUndefined();
  });

  it("keeps Use a photo and Read the name up close, in More", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await until(() => document.querySelector('input[aria-label="Card name"]'), "the name box");
    expect(button("Use a photo")).toBeUndefined();
    const more = await until(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("More")), "More");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await click(more);
    expect(button("Use a photo")).toBeDefined();
    // The photo's file box stays on the page, so choosing the item (which closes the menu) still opens it.
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("offers no Scan anyway for a one-card rescan", async () => {
    const accepted: ScanCandidate[] = [];
    act(() =>
      root.render(
        <ScannerView
          single
          onAccept={async (c) => {
            accepted.push(c);
            return true;
          }}
        />,
      ),
    );
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[0]!);
    expect(accepted).toHaveLength(1);
    await wait(50);
    expect(button("Scan anyway")).toBeUndefined();
  });
});
