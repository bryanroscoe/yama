import { describe, expect, it, vi } from "vitest";
import { createServerCatalog } from "./serverCatalog";
import { decide } from "./pipeline";
import { NameIndex } from "./fuzzy";

vi.mock("../offline/cards", () => ({ loadOfflineCards: async () => ({ cards: [
  { i: "keep", n: "Keep Card" }, { i: "double", n: "Front Face // Back Face" },
  { i: "brainstorm", n: "Brainstorm" }, { i: "adventure", n: "Harmonized Trio // Brainstorm" },
] }) }));
vi.mock("../api", () => ({ api: vi.fn(() => { throw new Error("No network in identity mode"); }), ApiError: class extends Error {} }));

describe("identity-only scan catalog", () => {
  it("recognizes plan names and either face without any printing request, and keeps unrelated cards", async () => {
    const catalog = await createServerCatalog({ identityOnly: true, extraNames: ["Plan Card", "Front Face", "Plan Card"] });
    expect(catalog.names()).toEqual(["Keep Card", "Front Face // Back Face", "Front Face", "Back Face", "Brainstorm", "Harmonized Trio // Brainstorm", "Harmonized Trio", "Plan Card"]);
    const names = new NameIndex(catalog.names());
    for (const [read, expected] of [["Plan Card", "Plan Card"], ["Back Face", "Front Face // Back Face"], ["Keep Card", "Keep Card"]]) {
      const found = await decide("R 0214\nMOM EN", read!, { catalog, names });
      expect(found[0]?.name).toBe(expected);
    }
    expect(await catalog.lookup("mom", "214", "en")).toBe(null);
    expect(await catalog.printingsOf?.("Plan Card")).toEqual([]);
    expect((await decide("", "Brainstorm", { catalog, names }))[0]?.name).toBe("Brainstorm");
  });
});
