import { describe, expect, it } from "vitest";
import { versionLabel } from "./DeckHistory";

describe("what a saved version is called in History", () => {
  it("uses the note someone wrote", () => {
    expect(versionLabel("Cut the slow lands", false)).toBe("Cut the slow lands");
  });

  it("never shows the server's own word for the first save", () => {
    expect(versionLabel("created", true)).toBe("First version");
    expect(versionLabel("Created", false)).toBe("Saved version");
  });

  it("names a save with no note by which one it was", () => {
    expect(versionLabel(null, true)).toBe("First version");
    expect(versionLabel("  ", false)).toBe("Saved version");
  });
});
