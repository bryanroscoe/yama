import { describe, expect, it } from "vitest";
import { createOpIds } from "./saveOps";

describe("op ids for creating decks", () => {
  const counter = () => {
    let n = 0;
    return () => `op-${++n}`;
  };
  const body = { cards: [{ oracle_id: "o-sol", name: "Sol Ring", qty: 1, board: "main" }], prints: [] };

  it("gives a deck the same id every time it is sent, so a retry makes one deck", () => {
    const opIdFor = createOpIds(counter());
    const first = opIdFor(0, "Rohan", body);
    expect(opIdFor(0, "Rohan", body)).toBe(first);
    // The same content built again (as each save does) is still the same deck.
    expect(opIdFor(0, "Rohan", JSON.parse(JSON.stringify(body)))).toBe(first);
  });

  it("counts the Considering list: a deck whose maybeboard changed is another request", () => {
    const opIdFor = createOpIds(counter());
    const plain = opIdFor(0, "Rohan", body);
    // No list, or an empty one, is the request it always was.
    expect(opIdFor(0, "Rohan", { ...body, maybe: [] })).toBe(plain);
    const one = opIdFor(0, "Rohan", { ...body, maybe: [{ oracle_id: "o-opt", name: "Opt", qty: 1 }] });
    expect(one).not.toBe(plain);
    expect(opIdFor(0, "Rohan", { ...body, maybe: [{ oracle_id: "o-opt", name: "Opt", qty: 1 }] })).toBe(one);
    expect(opIdFor(0, "Rohan", { ...body, maybe: [{ oracle_id: "o-opt", name: "Opt", qty: 2 }] })).not.toBe(one);
  });

  it("gives another deck, or the same deck changed, its own id", () => {
    const opIdFor = createOpIds(counter());
    const first = opIdFor(0, "Rohan", body);
    expect(opIdFor(1, "Rohan", body)).not.toBe(first);
    expect(opIdFor(0, "Rohan again", body)).not.toBe(first);
    expect(opIdFor(0, "Rohan", { ...body, cards: [{ ...body.cards[0], qty: 2 }] })).not.toBe(first);
    expect(opIdFor(0, "Rohan", { ...body, prints: [{ oracle_id: "o-sol", set_code: "cmm" }] })).not.toBe(first);
  });

  it("keeps ids apart between two imports", () => {
    expect(createOpIds()(0, "Rohan", body)).not.toBe(createOpIds()(0, "Rohan", body));
  });
});
