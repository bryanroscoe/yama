// @vitest-environment jsdom
// The scanner's flow after a printing is chosen (Bryan, 15 Nov 2026): tapping a printing files it
// at once with Undo on the camera; the card is then held back as the same card, and "Scan anyway"
// files one more copy of it; the ways in used now and then sit in More. No camera here, so the
// card comes from a typed name.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ScanCandidate } from "./types";

const printing = (set: string, n: string): Printing => ({
  scryfall_id: `id-${set}-${n}`, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: n, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null,
  price_date: null, usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});

const diag = vi.hoisted(() => ({ posted: [] as { outcome: string; detail: Record<string, unknown> }[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: unknown }) => {
    if (path === "/api/scan/diagnostics" && init?.method === "POST") {
      diag.posted.push(init.json as (typeof diag.posted)[number]);
      return Promise.resolve({ id: "d1" });
    }
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    if (path.startsWith("/api/cards/autocomplete")) return Promise.resolve(path.includes("Sol") ? ["Sol Ring"] : ["Arcane Signet"]);
    // One English printing (so it's settled as "the only one") and two in other languages.
    if (path.startsWith("/api/scan/printings") && path.includes("Sol"))
      return Promise.resolve({ same_art: false, printings: [{ ...printing("ecc", "57"), name: "Sol Ring", scryfall_id: "sol-en", usd: 12, finishes: ["nonfoil", "foil"] }, { ...printing("cmm", "410"), name: "Sol Ring", lang: "ja", scryfall_id: "sol-ja" }, { ...printing("cmm", "411"), name: "Sol Ring", lang: "de", scryfall_id: "sol-de" }] });
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: false, printings: [printing("woc", "145"), printing("cmm", "390"), { ...printing("c21", "236"), finishes: ["foil"], promo_types: ["surgefoil", "universesbeyond"], usd_foil: 2.5 }] });
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
  it("keeps Copies beside the printings to tap, with no Add, and the tap files that many (Codex review, 16 Nov 2026)", async () => {
    const accepted: [ScanCandidate, number][] = [];
    act(() =>
      root.render(
        <ScannerView
          onAccept={async (c, n) => {
            accepted.push([c, n]);
            return true;
          }}
          acceptLabel="Add and scan next"
        />,
      ),
    );
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    expect(button("Add and scan next")).toBeUndefined();
    const select = document.querySelector<HTMLSelectElement>(".scan-copies select")!;
    expect(select).not.toBeNull();
    act(() => {
      select.value = "3";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(options[1]!);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]![1]).toBe(3);
  });

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

  it("names a special printing in the list and hands the host its finishes", async () => {
    const accepted: ScanCandidate[] = [];
    act(() =>
      root.render(
        <ScannerView
          finish="nonfoil"
          onAccept={async (c) => {
            accepted.push(c);
            return true;
          }}
        />,
      ),
    );
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    // "Surge foil" names the special printing; promo types without words ("universesbeyond") stay out.
    expect(options[2]!.textContent).toContain("Surge foil");
    expect(options[2]!.textContent).not.toContain("universesbeyond");
    expect(options[0]!.textContent).not.toContain("foil");
    await click(options[2]!);
    // A tap files it at once: the card handed to the host carries its finishes (foil only) and
    // what makes it special, so the host files it as foil whatever was chosen last.
    expect(accepted[0]).toMatchObject({ scryfall_id: "id-c21-236", finishes: ["foil"], treatment: { promo_types: ["surgefoil", "universesbeyond"] } });
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
    expect(document.querySelector("h3")?.firstChild?.textContent).toBe("Sol Ring");
    expect(document.querySelector(".scan-thumb.card-fallback")?.textContent ?? "").toBe("");
    // Settled by the scanner (the only English printing): Wrong printing is offered, under More.
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Wrong printing"), "Wrong printing"));
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

describe("with the strip, what just happened is said beside the card (design pass, 16 Nov 2026)", () => {
  it("puts Undo in the strip's head, and +1 copy (Scan anyway) on the camera while the card is still in view", async () => {
    const accepted: ScanCandidate[] = [];
    const undone: ScanCandidate[] = [];
    function Host() {
      const [cards, setCards] = useState<ScanCandidate[]>([]);
      return (
        <ScannerView
          onAccept={async (c) => {
            accepted.push(c);
            setCards((a) => [c, ...a]);
            return true;
          }}
          onUndo={async (c) => {
            undone.push(c);
            setCards((a) => a.filter((x) => x !== c));
          }}
          onCorrect={async () => "changed"}
          recentCards={cards.map((c, i) => ({ key: `k${cards.length - i}`, name: c.name, set: c.set, number: c.number, finish: "nonfoil", copies: 1, prices: c.prices, image: null, oracleId: c.oracle_id }))}
        />
      );
    }
    act(() => root.render(<Host />));
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    const tray = await until(() => document.querySelector(".scan-tray"), "the strip");
    const head = () => tray.querySelector(".scan-tray-head")!;
    await until(() => (head().querySelector(".scan-tray-do") ? true : null), "the receipt's actions");
    expect(head().textContent).toContain("Arcane Signet");
    // A printing you tapped yourself is rarely wrong: Undo alone (Wrong printing is in the card's sheet).
    expect([...head().querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Undo"]);
    // The camera says so for a moment where the eye is, then that the card is still in view, with +1 copy.
    const chip = () => document.querySelector(".scan-chip")!;
    expect(chip().textContent).toContain("Added");
    expect(chip().textContent).toContain("+1 copy");
    await until(() => (chip().textContent?.startsWith("Still in view") ? true : null), "Still in view");
    // No "still in view" box in the sheet.
    expect(document.querySelector(".scan-dupe")).toBeNull();

    await click([...chip().querySelectorAll("button")].find((b) => b.textContent === "+1 copy")!);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toMatchObject({ set: "cmm", number: "390" });
    // A stack can be counted: after the moment's "Added", the chip says how many in a row.
    await until(() => (chip().textContent?.startsWith("2 added") ? true : null), "2 added");
    // Undo takes back the newest copy.
    await click(await until(() => [...head().querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo for the extra copy"));
    await until(() => (undone.length === 1 ? true : null), "the undo");
    expect(undone[0]).toBe(accepted[1]);
    // What Undo did is said where the card was named.
    await until(() => (document.querySelector(".scan-tray-last.is-event")?.textContent?.includes("Took out") ? true : null), "Took out");
  });

  function stripHost(accept: (c: ScanCandidate, n: number) => Promise<boolean>, undone: ScanCandidate[], props: Partial<Parameters<typeof ScannerView>[0]> = {}) {
    let n = 0;
    // Like Collection's `filedAs`: the entry each card handed to onAccept went into.
    const keys = new WeakMap<ScanCandidate, string>();
    function Host() {
      const [cards, setCards] = useState<ScanCandidate[]>([]);
      return (
        <ScannerView
          // Like Collection: the entry goes into the strip at once, before its save comes back.
          onAccept={(c) => {
            keys.set(c, `k${n}`);
            setCards((a) => [c, ...a]);
            return accept(c, n++);
          }}
          onUndo={async (c) => {
            undone.push(c);
          }}
          onCorrect={async () => "changed"}
          entryOf={(c) => keys.get(c)}
          recentCards={cards.map((c) => ({ key: keys.get(c)!, name: c.name, set: c.set, number: c.number, finish: "nonfoil", copies: 1, prices: c.prices, image: null, oracleId: c.oracle_id }))}
          {...props}
        />
      );
    }
    act(() => root.render(<Host />));
  }

  it("never puts an Undo beside a card it wouldn't take out: a second card filed inside the Undo window has none (review, 16 Nov 2026)", async () => {
    const undone: ScanCandidate[] = [];
    // The first save comes back; the second never does.
    stripHost((_, n) => (n === 0 ? Promise.resolve(true) : new Promise<boolean>(() => {})), undone);
    await typeName();
    let options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    const head = () => document.querySelector(".scan-tray-head")!;
    await until(() => (head().querySelector(".scan-tray-do") ? true : null), "Undo for the first card");
    // Every add is said to a screen reader, in the strip's status line.
    expect(head().querySelector('.visually-hidden[role="status"]')?.textContent).toContain("Added Arcane Signet");

    await typeName();
    options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings again");
    await click(options[2]!);
    await until(() => (document.querySelectorAll(".scan-tile").length === 2 ? true : null), "the second card in the strip");
    // The head no longer offers Undo: it would have taken out the first card, not the one named.
    expect(head().querySelector(".scan-tray-do")).toBeNull();
    expect(undone).toHaveLength(0);
  });

  it("puts no Undo beside a +1 copy of the same printing while it saves: Undo would take out the earlier entry (Codex review, 16 Nov 2026)", async () => {
    const undone: ScanCandidate[] = [];
    // The first save comes back; the extra copy's never does.
    stripHost((_, n) => (n === 0 ? Promise.resolve(true) : new Promise<boolean>(() => {})), undone);
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    const head = () => document.querySelector(".scan-tray-head")!;
    await until(() => (head().querySelector(".scan-tray-do") ? true : null), "Undo for the first copy");
    const chip = () => document.querySelector(".scan-chip")!;
    await click(await until(() => [...chip().querySelectorAll("button")].find((b) => b.textContent === "+1 copy"), "+1 copy"));
    await until(() => (document.querySelectorAll(".scan-tile").length === 2 ? true : null), "the extra copy in the strip");
    // Same name, set and number as the newest tile, but not its entry: no Undo or Wrong printing.
    expect(head().querySelector(".scan-tray-do")).toBeNull();
    expect(undone).toHaveLength(0);
  });

  it("pins name suggestions in the scanner itself, not the sheet, so the sheet keeps scrolling and a drag doesn't carry them off (Codex review, 16 Nov 2026)", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const input = await until(() => document.querySelector<HTMLInputElement>('input[aria-label="Card name"]'), "the name box");
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Arcane");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const list = await until(() => document.querySelector<HTMLElement>(".scan-name-list"), "the suggestions");
    expect(list.classList.contains("is-pinned")).toBe(true);
    expect(list.closest(".scan-panel")).toBeNull();
    expect(list.parentElement?.classList.contains("scan")).toBe(true);
    expect(list.style.getPropertyValue("--name-width")).not.toBe("");
    // Picking one still works from there.
    await click(await until(() => button("Arcane Signet"), "the suggestion"));
    await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? true : null), "the printings");
    expect(document.querySelector(".scan-name-list")).toBeNull();
  });

  it("has no More when there is nothing in it (a deck check, after Wrong card)", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await typeName();
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Wrong card"), "Wrong card"));
    await until(() => (document.querySelector(".scan-wrong") ? true : null), "the Wrong card panel");
    expect(button("More")).toBeUndefined();
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

  it("plays the brighter sound for a card worth $2 or more in the finish filed, and the plain one otherwise", async () => {
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

  it("offers the Sounds switch and its amount in Scan settings, behind the gear, on and $2 by default", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    expect(document.querySelector("#scan-sounds")).toBeNull();
    await click(await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]'), "the gear"));
    const box = await until(() => document.querySelector<HTMLInputElement>("#scan-sounds"), "the Sounds switch");
    expect(box.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>(".scan-worth input")?.value).toBe("2");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Scan settings");
  });
});


describe("the camera (review of #145)", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const fakeStream = () => {
    const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "x" }), getCapabilities: () => ({}), applyConstraints: async () => undefined, label: "fake" };
    return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
  };
  afterEach(() => {
    localStorage.removeItem("yama.scan.camera");
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("asks for no other camera after the scanner has closed, and stops a stream that arrives late", async () => {
    localStorage.setItem("yama.scan.camera", JSON.stringify({ id: "old-id", label: "camera2 1, facing front" }));
    const first = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => first.promise);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, enumerateDevices: async () => [] } });
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await wait(10);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // Closed while the saved camera is still being asked for, and then it fails: no fallback request.
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => first.reject(new Error("OverconstrainedError")));
    await wait(10);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // Kept: its label may find it again under a new id.
    expect(localStorage.getItem("yama.scan.camera")).toContain("camera2 1, facing front");

    // And a stream that arrives after closing is stopped.
    const late = deferred<MediaStream>();
    getUserMedia.mockImplementation(() => late.promise);
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await wait(10);
    act(() => root.unmount());
    root = createRoot(host);
    const { stream, track } = fakeStream();
    await act(async () => late.resolve(stream));
    await wait(10);
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("withTimeout", () => {
  it("gives up on a promise that never answers, and passes through one that does", async () => {
    const { withTimeout } = await import("./ScannerView");
    vi.useFakeTimers();
    try {
      const hung = withTimeout(new Promise<never>(() => undefined), 2000);
      const settled = expect(hung).rejects.toThrow("No answer in 2000 ms");
      vi.advanceTimersByTime(2000);
      await settled;
      await expect(withTimeout(Promise.resolve(5), 2000)).resolves.toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scanner diagnostics, when they're on (slice 5)", () => {
  beforeEach(() => {
    diag.posted.length = 0;
  });
  afterEach(() => localStorage.removeItem("yama.scan.diagnostics"));

  it("keeps a card whose printing was picked from the list, with the candidates and how it ended", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    const sent = await until(() => diag.posted[0], "the record");
    expect(sent.outcome).toBe("picked");
    expect(sent.detail.reasons).toEqual(["picked"]);
    expect(sent.detail.final).toMatchObject({ id: "id-cmm-390", how: "picked" });
    expect((sent.detail.options as { id: string }[]).map((o) => o.id)).toEqual(["id-woc-145", "id-cmm-390", "id-c21-236"]);
    expect(sent.detail.found).toMatchObject({ method: "typed", name: "Arcane Signet" });
  });

  it("keeps nothing with the switch off (its default), and nothing for a card that went smoothly", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName();
    const options = await until(() => (document.querySelectorAll('[role="option"]').length === 3 ? document.querySelectorAll<HTMLElement>('[role="option"]') : null), "the printings");
    await click(options[1]!);
    await wait(30);
    expect(diag.posted).toEqual([]);
    // The switch is in Scan settings, behind the gear.
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]')!);
    expect(document.querySelector<HTMLInputElement>("#scan-diagnostics")?.checked).toBe(false);

    // On, but a card filed straight away (the only printing): no reason to keep it.
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem("yama.scan.diagnostics", "1");
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await typeName("Sol Ring");
    await click(await until(() => button("Add"), "Add"));
    await wait(30);
    expect(diag.posted).toEqual([]);
  });
});

