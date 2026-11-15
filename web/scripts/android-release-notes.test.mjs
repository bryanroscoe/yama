import { describe, expect, it } from "vitest";
import { NOTES_MAX, notesLine, titleOf } from "./android-release-notes.mjs";

describe("titleOf", () => {
  it("takes a merged pull request's title from the merge commit's body", () => {
    expect(titleOf("Merge pull request #34 from bryanroscoe/t3/x", "\nSwap sheet: FOIL on cards\n\nmore")).toBe("Swap sheet: FOIL on cards");
  });
  it("drops a squash merge's pull request number", () => {
    expect(titleOf("Scanner: Scan anyway adds another copy (#137)", "")).toBe("Scanner: Scan anyway adds another copy");
  });
});

describe("notesLine", () => {
  it("joins titles newest first, once each", () => {
    expect(notesLine(["Settings updates the app", "Scanner fixes", "Settings updates the app", ""])).toBe("Settings updates the app; Scanner fixes");
  });
  it("stops between titles before the limit", () => {
    const line = notesLine(["a".repeat(150), "b".repeat(60)]);
    expect(line).toBe("a".repeat(150));
  });
  it("cuts a single overlong title", () => {
    expect(notesLine(["x".repeat(300)]).length).toBe(NOTES_MAX);
  });
  it("is empty with nothing to say", () => {
    expect(notesLine([])).toBe("");
  });
});
