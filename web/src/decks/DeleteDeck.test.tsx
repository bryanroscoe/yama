import { describe, expect, it } from "vitest";
import { deleteWording } from "./DeleteDeck";

const ref = (id: string, name: string, configuration: string | null = null) => ({ id, name, configuration, visibility: "private" as const, share_token: null });

describe("deleting a deck or a configuration", () => {
  it("names a configuration as one and goes back to its main deck", () => {
    const w = deleteWording({ id: "s", name: "Riders (stock)", parent_id: "m", configuration: "stock", configurations: [ref("m", "Riders"), ref("s", "Riders (stock)", "stock")] });
    expect(w.action).toBe("Delete configuration");
    expect(w.what).toContain("The Stock configuration of Riders leaves your decks");
    expect(w.configurations).toEqual([]);
    expect(w.after).toBe("/decks/m");
  });

  it("offers a main deck's configurations as a choice", () => {
    const w = deleteWording({ id: "m", name: "Riders", parent_id: null, configuration: null, configurations: [ref("m", "Riders"), ref("s", "Riders (stock)", "stock"), ref("b", "Riders (Bracket 2)", "Bracket 2")] });
    expect(w.action).toBe("Delete deck");
    expect(w.configurations).toEqual(["Stock", "Bracket 2"]);
    expect(w.after).toBe("/decks");
  });

  it("asks nothing more of a deck without configurations", () => {
    const w = deleteWording({ id: "m", name: "Solo", parent_id: null, configuration: null, configurations: [ref("m", "Solo")] });
    expect(w.configurations).toEqual([]);
  });
});
