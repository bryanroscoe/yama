import { describe, expect, it } from "vitest";
import { settingsPatch } from "./DeckSettings";

const ref = (id: string) => ({ id, name: id, configuration: null, visibility: "private" as const, share_token: null });
const choices = { name: " Revival Trance ", ownership: "owned" as const, container: "", parent: null, list: "" };

describe("deck settings", () => {
  it("saves a main deck's name, box and ownership, never its bracket or cards", () => {
    const p = settingsPatch({ parent_id: null, configurations: [ref("m")] }, { ...choices, container: "box1" });
    expect(p).toEqual({ name: "Revival Trance", container_id: "box1", acquisition_status: "owned", parent_id: null });
    expect(p).not.toHaveProperty("bracket");
    expect(p).not.toHaveProperty("cards");
  });

  it("keeps a deck with lists of its own a main deck", () => {
    const p = settingsPatch({ parent_id: null, configurations: [ref("m"), ref("s")] }, { ...choices, parent: "other" });
    expect(p).not.toHaveProperty("parent_id");
    expect(p.acquisition_status).toBe("owned");
  });

  it("moves a deck under another with its list name and no ownership", () => {
    const p = settingsPatch({ parent_id: null, configurations: [ref("m")] }, { ...choices, parent: "main", list: " Stock " });
    expect(p).toEqual({ name: "Revival Trance", container_id: null, parent_id: "main", configuration: "Stock" });
  });

  it("drops the list name when a list becomes its own deck", () => {
    const p = settingsPatch({ parent_id: "main", configurations: [ref("main"), ref("s")] }, { ...choices, ownership: "" });
    expect(p).toMatchObject({ parent_id: null, configuration: null, acquisition_status: null });
  });
});
