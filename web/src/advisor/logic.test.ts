import { describe, expect, it } from "vitest";
import { inline, parseAnswer, parseSse, parseSuggestion, unavailableText } from "./logic";

describe("parseSse", () => {
  it("returns whole events and keeps a partial one for later", () => {
    const { events, rest } = parseSse('event: start\ndata: {"conversation_id":"c1"}\n\nevent: text\ndata: {"text":"Hi"}\n\nevent: te');
    expect(events).toEqual([
      { event: "start", data: { conversation_id: "c1" } },
      { event: "text", data: { text: "Hi" } },
    ]);
    expect(rest).toBe("event: te");
    expect(parseSse(`${rest}xt\ndata: {"text":"!"}\n\n`).events).toEqual([{ event: "text", data: { text: "!" } }]);
  });

  it("skips frames that aren't JSON", () => {
    expect(parseSse("data: nope\n\n").events).toEqual([]);
  });
});

describe("parseAnswer", () => {
  it("reads paragraphs, lists, headings and suggestions", () => {
    const blocks = parseAnswer(
      [
        "## First",
        "Lead with ramp.",
        "It helps.",
        "",
        "- One",
        "- Two",
        "  continued",
        "1. Uno",
        "```suggestion",
        "in: Dryad of the Ilysian Grove",
        "out: Explore",
        "why: Plays extra lands and fixes colors.",
        "```",
        "```suggestion",
        "in: Sol Ring",
        "out:",
        "```",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", text: "First" },
      { kind: "p", text: "Lead with ramp. It helps." },
      { kind: "list", ordered: false, items: ["One", "Two continued"] },
      { kind: "list", ordered: true, items: ["Uno"] },
      { kind: "suggestion", suggestion: { in: "Dryad of the Ilysian Grove", out: "Explore", why: "Plays extra lands and fixes colors." }, raw: "in: Dryad of the Ilysian Grove\nout: Explore\nwhy: Plays extra lands and fixes colors." },
      { kind: "suggestion", suggestion: { in: "Sol Ring", out: null, why: null }, raw: "in: Sol Ring\nout:" },
    ]);
  });

  it("shows an unfinished fence as code while the answer streams", () => {
    expect(parseAnswer("Try this:\n```suggestion\nin: Sol")).toEqual([
      { kind: "p", text: "Try this:" },
      { kind: "suggestion", suggestion: { in: "Sol", out: null, why: null }, raw: "in: Sol" },
    ]);
    expect(parseAnswer("```\nplain")).toEqual([{ kind: "code", text: "plain" }]);
  });
});

describe("parseSuggestion", () => {
  it("needs a card to put in and treats none as blank", () => {
    expect(parseSuggestion("out: Explore")).toBeNull();
    expect(parseSuggestion("in: Card\nout: none\nwhy: n/a")).toEqual({ in: "Card", out: null, why: null });
  });
});

describe("inline", () => {
  it("marks bold and code", () => {
    expect(inline("Play **Sol Ring** and `Arcane Signet` now")).toEqual([
      { text: "Play " },
      { text: "Sol Ring", bold: true },
      { text: " and " },
      { text: "Arcane Signet", code: true },
      { text: " now" },
    ]);
  });
});

describe("unavailableText", () => {
  it("says what the person can do", () => {
    expect(unavailableText("needs_key", true)).toContain("add your own Anthropic API key");
    expect(unavailableText("keys_off", false)).toContain("owner");
    expect(unavailableText("off", false)).toContain("isn't set up");
  });
});
