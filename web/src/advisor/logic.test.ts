import { describe, expect, it } from "vitest";
import type { AdvisorStatus } from "./api";
import { inline, modeLine, parseAnswer, parseSse, parseSuggestion, pausedText, possessive, sharedLine, unavailableText } from "./logic";

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

const HAIKU = { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "" };
const status = (over: Partial<AdvisorStatus> = {}): AdvisorStatus => ({
  available: true,
  mode: "shared",
  reason: null,
  has_key: false,
  key_hint: null,
  can_save_key: true,
  model: HAIKU.id,
  models: [HAIKU],
  per_day: 30,
  used_today: 4,
  subscription_connected: null,
  shared_granted: true,
  shared_owner: "Bryan",
  shared_paused_until: null,
  ...over,
});

describe("the shared key", () => {
  it("says plainly whose key answers, with the model and the day's count", () => {
    expect(sharedLine(status(), HAIKU.id)).toBe("On Bryan's shared key, with Claude Haiku 5.5. 4 of 30 questions in the last 24 hours.");
    expect(sharedLine(status({ shared_owner: null }), HAIKU.id)).toBe("On the server owner's shared key, with Claude Haiku 5.5. 4 of 30 questions in the last 24 hours.");
    expect(sharedLine(status({ mode: "own_key" }), HAIKU.id)).toBeNull();
    expect(sharedLine(status({ mode: "subscription" }), HAIKU.id)).toBeNull();
    expect(sharedLine(status(), HAIKU.id)).not.toContain("·");
    expect(possessive("  ")).toBe("the server owner's");
  });

  it("says when the month's cap is reached and when it's back", () => {
    expect(pausedText("Bryan", "2026-11-01T00:00:00Z")).toBe(
      "Bryan's shared key has reached this month's limit. It's back on November 1. Until then you can add your own Anthropic API key in Settings.",
    );
  });

  it("explains the order in Settings: your own key first", () => {
    expect(modeLine(status())).toBe(
      "Your questions use Bryan's shared API key (Claude Haiku 5.5), which they pay for. If you add your own Anthropic API key, Yama uses yours instead, billed to your Anthropic account, with every model.",
    );
    expect(modeLine(status({ mode: "own_key", key_hint: "abcd" }))).toBe(
      "Your questions use your own Anthropic API key ending abcd, billed to your Anthropic account. Remove it and they use Bryan's shared key instead.",
    );
    expect(modeLine(status({ mode: "own_key", key_hint: "abcd", shared_granted: false }))).toBe("Your questions use your own Anthropic API key ending abcd, billed to your Anthropic account.");
    // Not granted: unchanged, add your own key.
    expect(modeLine(status({ available: false, mode: null, reason: "needs_key", shared_granted: false }))).toContain("Add your own Anthropic API key");
  });
});
