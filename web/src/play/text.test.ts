import { describe, expect, it } from "vitest";
import { promptText, shortName } from "./text";

describe("promptText", () => {
  it("puts the engine's Title Case prompt in sentence case", () => {
    expect(promptText("Discard To Hand Size")).toBe("Discard to hand size");
    expect(promptText("Priority")).toBe("Priority");
  });
  it("leaves the card name after the colon alone", () => {
    expect(promptText("Choose Targets: Swords to Plowshares")).toBe("Choose targets: Swords to Plowshares");
  });
  it("keeps single capitals such as X", () => {
    expect(promptText("Choose X Value")).toBe("Choose X value");
  });
});

describe("shortName", () => {
  it("cuts legendary names at the comma", () => {
    expect(shortName("Éowyn, Shieldmaiden")).toBe("Éowyn");
    expect(shortName("Sol Ring")).toBe("Sol Ring");
  });
});
