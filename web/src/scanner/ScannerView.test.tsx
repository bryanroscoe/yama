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
    if (path.startsWith("/api/cards/autocomplete")) return Promise.resolve(path.includes("Sol") ? ["Sol Ring"] : ["Arcane Signet"]);
    // One English printing (so it's settled as "the only one") and two in other languages.
    if (path.startsWith("/api/scan/printings") && path.includes("Sol"))
      return Promise.resolve({ same_art: false, printings: [{ ...printing("ecc", "57"), name: "Sol Ring", scryfall_id: "sol-en", usd: 12 }, { ...printing("cmm", "410"), name: "Sol Ring", lang: "ja", scryfall_id: "sol-ja" }, { ...printing("cmm", "411"), name: "Sol Ring", lang: "de", scryfall_id: "sol-de" }] });
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

const sounds = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock("./sounds", async (original) => ({
  ...(await original<typeof import("./sounds")>()),
  playScanSound: (kind: string) => sounds.played.push(kind),
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

async function typeName(name = "Arcane Signet") {
  const input = await until(() => document.querySelector<HTMLInputElement>('input[aria-label="Card name"]'), "the name box");
  await act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, name.split(" ")[0]!);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(await until(() => button(name), "the suggestion"));
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

  it("Wrong printing before filing reopens the list with the misread marked, and a tap files the right one, once", async () => {
    const accepted: ScanCandidate[] = [];
    act(() =>
      root.render(
        <ScannerView
          onAccept={async (c) => {
            accepted.push(c);
            return true;
          }}
        />,
      ),
    );
    await typeName("Sol Ring");
    // No placeholder text: the picture's stand-in is an empty card shape, the name is the heading.
    await until(() => document.querySelector("h3"), "the card's name");
    expect(document.querySelector("h3")?.textContent).toBe("Sol Ring");
    expect(document.querySelector(".scan-thumb.card-fallback")?.textContent ?? "").toBe("");
    // Settled by the scanner (the only English printing): Wrong printing is offered.
    await click(await until(() => button("Wrong printing?"), "Wrong printing?"));
    const marked = await until(() => document.querySelector(".scan-misread"), "the misread mark");
    expect(marked.textContent).toBe("Read as this");
    expect(marked.closest('[role="option"]')?.textContent).toContain("ECC");
    expect(accepted).toHaveLength(0);
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("#411"))!);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ scryfall_id: "sol-de" });
  });

  it("Wrong printing after filing changes that copy rather than adding one, and Undo then takes back the changed copy", async () => {
    const accepted: ScanCandidate[] = [];
    const corrected: [ScanCandidate, ScanCandidate][] = [];
    const undone: ScanCandidate[] = [];
    act(() =>
      root.render(
        <ScannerView
          onAccept={async (c) => {
            accepted.push(c);
            return true;
          }}
          onCorrect={async (from, to) => {
            corrected.push([from, to]);
            return "changed";
          }}
          onUndo={async (c) => {
            undone.push(c);
          }}
        />,
      ),
    );
    await typeName("Sol Ring");
    await click(await until(() => button("Add"), "Add"));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ scryfall_id: "sol-en" });

    // On the camera after it's saved: Wrong printing reopens its list, marked as added.
    await click(await until(() => button("Wrong printing"), "Wrong printing on the chip"));
    const marked = await until(() => document.querySelector(".scan-misread"), "the filed printing's mark");
    expect(marked.textContent).toBe("Added as this");
    expect(button("Keep it as it was")).toBeDefined();
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("#410"))!);
    // The filed copy is changed: no second add.
    expect(accepted).toHaveLength(1);
    await until(() => (corrected.length ? corrected : null), "the correction");
    expect(corrected[0]![0]).toBe(accepted[0]);
    expect(corrected[0]![1]).toMatchObject({ scryfall_id: "sol-ja" });
    await until(() => (document.querySelector(".scan-chip")?.textContent?.includes("Changed to Sol Ring (CMM 410)") ? true : null), "Changed to");

    // Undo now stands for the changed copy.
    await click(await until(() => button("Undo"), "Undo"));
    await until(() => (undone.length ? undone : null), "the undo");
    expect(undone[0]).toBe(corrected[0]![1]);
  });
});

describe("Wrong printing after filing, when the host can't confirm it (review of #138)", () => {
  async function fileThenCorrect(onCorrect: (from: ScanCandidate, to: ScanCandidate) => Promise<"changed" | "kept">) {
    act(() =>
      root.render(
        <ScannerView onAccept={async () => true} onCorrect={onCorrect} onUndo={async () => undefined} />,
      ),
    );
    await typeName("Sol Ring");
    await click(await until(() => button("Add"), "Add"));
    await click(await until(() => button("Wrong printing"), "Wrong printing on the chip"));
    await until(() => document.querySelector(".scan-misread"), "the list");
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("#410"))!);
  }

  it("shows no Undo, Wrong printing or Scan anyway on a printing it can't vouch for", async () => {
    await fileThenCorrect(async () => {
      throw new Error("Still saving the last change");
    });
    const chip = await until(() => (document.querySelector(".scan-chip")?.textContent?.includes("Couldn't confirm") ? document.querySelector(".scan-chip") : null), "the failure");
    expect(chip.textContent).toContain("The Added list shows that card");
    expect(button("Undo")).toBeUndefined();
    expect(button("Wrong printing")).toBeUndefined();
    expect(button("Scan anyway")).toBeUndefined();
  });

  it("says Kept only when the host says the copy already was that printing", async () => {
    await fileThenCorrect(async () => "kept");
    await until(() => (document.querySelector(".scan-chip")?.textContent?.includes("Kept Sol Ring (CMM 410)") ? true : null), "Kept");
  });
});

describe("scan photos of corrections", () => {
  it("keeps a Wrong printing correction as corrected, with the scanner's guess", async () => {
    const { sampleKind } = await import("./ScannerView");
    // Wrong printing keeps what the scanner said in `guess`.
    expect(sampleKind({ settledId: "sol-en", guess: { guess_scryfall_id: "sol-en" } }, "added", { scryfall_id: "sol-ja" })).toBe("corrected");
    // A tapped printing other than the one settled is a correction too; the same one isn't.
    expect(sampleKind({ settledId: "sol-en" }, "added", { scryfall_id: "sol-ja" })).toBe("corrected");
    expect(sampleKind({ settledId: "sol-en" }, "added", { scryfall_id: "sol-en" })).toBe("added");
    expect(sampleKind({}, "wrong")).toBe("wrong");
  });
});

describe("the card just filed by its name stays held (with the title-first change)", () => {
  it("knows a two-faced card by either face, from art or a title read", async () => {
    const { fusedHeld, sameCardName } = await import("./ScannerView");
    const { fuseTitle, titleRead } = await import("./fuse");
    const { NameIndex } = await import("./fuzzy");
    const full = "Westvale Abbey // Ormendahl, Profane Prince";
    expect(sameCardName("Ormendahl, Profane Prince", full)).toBe(true);
    expect(sameCardName("Wei Night Raiders", full)).toBe(false);
    const reader = { names: new NameIndex(["Westvale Abbey", "Ormendahl, Profane Prince", "Wei Night Raiders"]), catalog: { fullName: (n: string) => (n === "Wei Night Raiders" ? n : full) } };
    // The held card's title read again, or its back face's art: held, not filed again.
    expect(fusedHeld(fuseTitle([{ name: "Wei Night Raiders", score: 0.66 }], titleRead(["Westvale Abbey"], reader)), full)).toBe(true);
    expect(fusedHeld(fuseTitle([{ name: "Ormendahl, Profane Prince", score: 0.6 }], titleRead(["Westvale Abbey"], reader)), full)).toBe(true);
    // Another card: not held. Nothing held: nothing to hold.
    expect(fusedHeld(fuseTitle([{ name: "Wei Night Raiders", score: 0.66 }], titleRead(["Wei Night Raiders"], reader)), full)).toBe(false);
    expect(fusedHeld(fuseTitle([], titleRead(["Westvale Abbey"], reader)), undefined)).toBe(false);
  });
});

describe("sounds (Bryan, 15 Nov 2026)", () => {
  beforeEach(() => {
    sounds.played.length = 0;
    localStorage.removeItem("yama.scan.sounds");
    localStorage.removeItem("yama.scan.worthIt");
  });

  it("plays the brighter sound for a card worth $5 or more in the finish filed, and the plain one otherwise", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName("Sol Ring");
    await click(await until(() => button("Add"), "Add"));
    await until(() => (sounds.played.length ? true : null), "a sound");
    expect(sounds.played).toEqual(["valuable"]);
  });

  it("plays the plain chime for a card with no price in the finish filed (a missing price is never worth it)", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} finish="foil" />));
    await typeName("Sol Ring");
    await click(await until(() => button("Add"), "Add"));
    await until(() => (sounds.played.length ? true : null), "a sound");
    expect(sounds.played).toEqual(["filed"]);
  });

  it("plays the low tone when the picker needs a tap, and nothing with Sounds off", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName();
    await until(() => (sounds.played.includes("needs-you") ? true : null), "the needs-you tone");
    act(() => root.unmount());
    root = createRoot(host);
    sounds.played.length = 0;
    localStorage.setItem("yama.scan.sounds", "0");
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName();
    await until(() => document.querySelectorAll('[role="option"]').length === 3 || null, "the printings");
    await wait(50);
    expect(sounds.played).toEqual([]);
  });

  it("offers the Sounds switch and its amount in Scan settings, on and $5 by default", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const box = await until(() => document.querySelector<HTMLInputElement>("#scan-sounds"), "the Sounds switch");
    expect(box.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>(".scan-worth input")?.value).toBe("5");
  });
});

