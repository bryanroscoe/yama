import { describe, expect, it } from "vitest";
import { groupConfigurations } from "./configurations";

const d = (id: string, parent_id: string | null = null, configuration: string | null = null) => ({ id, parent_id, configuration });

describe("groupConfigurations", () => {
  it("puts configurations under their main deck, by label", () => {
    const groups = groupConfigurations([d("rohan"), d("stock", "rohan", "stock"), d("omo"), d("after", "rohan", "after prints")]);
    expect(groups.map((g) => [g.main.id, g.configurations.map((c) => c.id)])).toEqual([
      ["rohan", ["after", "stock"]],
      ["omo", []],
    ]);
  });

  it("shows a configuration whose main deck isn't listed as a main deck", () => {
    expect(groupConfigurations([d("stock", "archived", "stock")]).map((g) => g.main.id)).toEqual(["stock"]);
  });
});
