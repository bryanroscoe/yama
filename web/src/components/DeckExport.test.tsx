// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "../api";
import { DeckExport } from "./DeckExport";

const saved = vi.hoisted(() => ({ files: [] as { name: string; type: string; text: Promise<string> }[] }));
vi.mock("../download", () => ({
  saveFile: (blob: Blob, name: string) => {
    saved.files.push({ name, type: blob.type, text: blob.text() });
    return Promise.resolve();
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (name: string, board: string, printing: object | null = null) => ({ oracle_id: name, name, qty: 1, board, card: { layout: "normal" }, printing }) as unknown as DeckView["cards"][number];
const deck = {
  id: "d1",
  name: "Riders of Rohan",
  cards: [
    entry("Éowyn, Shieldmaiden", "commander", { set_code: "ltc", collector_number: "2", finish: "nonfoil", from: "owned" }),
    entry("Sol Ring", "main", { set_code: "cmm", collector_number: "410", finish: "foil", from: "default" }),
    entry("Negate", "side"),
  ],
} as unknown as DeckView;

let host: HTMLElement;
let root: Root;
const text = () => document.querySelector<HTMLTextAreaElement>("textarea")!.value;
const pick = (label: string) =>
  act(() => [...document.querySelectorAll("label")].find((l) => l.textContent!.startsWith(label))!.querySelector("input")!.click());
const downloadButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent!.startsWith("Download"))!;

beforeEach(() => {
  localStorage.clear();
  saved.files.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<DeckExport deck={deck} onClose={() => {}} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Export deck", () => {
  it("offers every format, names only first", () => {
    const labels = [...document.querySelectorAll('input[name="export-format"]')].map((i) => i.parentElement!.firstChild!.nextSibling!.textContent);
    expect(labels).toEqual(["Names only", "Moxfield", "MTG Arena", "Archidekt", "Magic Online (.dek)", "Cockatrice (.cod)", "CSV"]);
    expect(text()).toBe("Commander\n1 Éowyn, Shieldmaiden\n\nDeck\n1 Sol Ring\n");
    expect(downloadButton().textContent).toBe("Download .txt");
  });

  it("writes Archidekt's text with the commander as a category", () => {
    pick("Archidekt");
    expect(text()).toBe("1x Éowyn, Shieldmaiden (ltc) 2 [Commander{top}]\n1x Sol Ring (cmm) 410 *F*\n1x Negate [Sideboard{noDeck}{noPrice}]\n");
    // The same note as Moxfield: which printings a card you don't own names.
    expect(document.body.textContent).toContain("1 card isn't in your collection, so it names a paper printing");
  });

  it("saves a Cockatrice file under the deck's name, with the deck's name inside", async () => {
    pick("Cockatrice");
    expect(text()).toContain("<deckname>Riders of Rohan</deckname>");
    expect(downloadButton().textContent).toBe("Download .cod");
    act(() => downloadButton().click());
    expect(saved.files.map((f) => `${f.name} ${f.type}`)).toEqual(["riders-of-rohan.cod application/xml;charset=utf-8"]);
    expect(await saved.files[0]!.text).toBe(text());
  });

  it("saves a Magic Online .dek and a CSV with their own endings and types", () => {
    pick("Magic Online");
    act(() => downloadButton().click());
    pick("CSV");
    expect(text().split("\n")[0]).toBe("Quantity,Name,Board,Set code,Collector number,Finish");
    act(() => downloadButton().click());
    expect(saved.files.map((f) => `${f.name} ${f.type}`)).toEqual(["riders-of-rohan.dek application/xml;charset=utf-8", "riders-of-rohan.csv text/csv;charset=utf-8"]);
  });

  it("starts from names only when the remembered format is one it no longer has", () => {
    act(() => root.unmount());
    localStorage.setItem("yama.deck.exportFormat", "tappedout");
    root = createRoot(host);
    act(() => root.render(<DeckExport deck={deck} onClose={() => {}} />));
    expect(text().startsWith("Commander\n")).toBe(true);
  });

  it("remembers the last format on this device", () => {
    pick("CSV");
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<DeckExport deck={deck} onClose={() => {}} />));
    expect(text().startsWith("Quantity,Name")).toBe(true);
  });
});
