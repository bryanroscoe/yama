import { describe, expect, it } from "vitest";
import { cardCount } from "./Decks";

describe("the deck list", () => {
  it("counts one card as a card", () => {
    expect(cardCount(1)).toBe("1 card");
    expect(cardCount(0)).toBe("0 cards");
    expect(cardCount(100)).toBe("100 cards");
  });
});
