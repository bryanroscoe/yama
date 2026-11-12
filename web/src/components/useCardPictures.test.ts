import { describe, expect, it, vi } from "vitest";

const pages: Record<string, { total: number; page_size: number; cards: { name: string }[] }> = {};
vi.mock("../api", () => ({ api: vi.fn(async (path: string) => pages[new URL(path, "http://x").searchParams.get("page") ?? "1"]) }));

const { everyPage, term } = await import("./useCardPictures");

describe("card picture lookups", () => {
  it("finds a name with double quotes by its parts", () => {
    expect(term('Henzie "Toolbox" Torre')).toBe('("Henzie" "Toolbox" "Torre")');
    expect(term("Lorehold Archivist // Restore Relic")).toBe('!"Lorehold Archivist // Restore Relic"');
  });
  it("reads every page when a batch matches more cards than one page holds", async () => {
    const card = (i: number) => ({ name: `Card ${i}` });
    pages["1"] = { total: 68, page_size: 60, cards: Array.from({ length: 60 }, (_, i) => card(i)) };
    pages["2"] = { total: 68, page_size: 60, cards: Array.from({ length: 8 }, (_, i) => card(60 + i)) };
    const cards = await everyPage('!"Vex" or !"Web" or !"Zap"');
    expect(cards).toHaveLength(68);
    expect(cards.at(-1)?.name).toBe("Card 67");
  });
});
