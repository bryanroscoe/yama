import { describe, expect, it } from "vitest";
import { handleShown } from "./SharingSettings";

describe("the handle box in Sharing settings", () => {
  it("shows the saved handle until something is typed", () => {
    expect(handleShown(null, null)).toBe("");
    expect(handleShown(null, "kelly")).toBe("kelly");
  });

  it("keeps what's being typed when another setting on the form is saved", () => {
    // Changing "New decks start as" saves and reloads the settings; the saved handle is unchanged.
    expect(handleShown({ value: "kel", over: null }, null)).toBe("kel");
    expect(handleShown({ value: "kelly-2", over: "kelly" }, "kelly")).toBe("kelly-2");
  });

  it("shows the saved handle once the handle itself is saved, as the server normalised it", () => {
    expect(handleShown({ value: " @Kelly ", over: null }, "kelly")).toBe("kelly");
    expect(handleShown({ value: "kelly", over: "old" }, null)).toBe("");
  });
});
