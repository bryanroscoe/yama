import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sharing } from "../api";
import { existingChoices, PublicDefaultBanner, PublicDefaultDialog, readyAnswer } from "./PublicDefaultPrompt";

const sharing = (decks: Sharing["decks"], over: Partial<Sharing> = {}): Sharing => ({
  handle: "saget",
  new_deck_visibility: "private",
  collection_public: false,
  wants_public: false,
  wants_include_pending: false,
  share_lab_results: false,
  public_listed_at: null,
  decks,
  ...over,
});

const none = { private: 0, link: 0, public: 0 };
const mixed = { private: 2, link: 1, public: 3 };
const quiet = { private: 2, link: 1, public: 0 };

describe("what the question offers for existing decks", () => {
  it("asks nothing about decks an account doesn't have", () => {
    expect(existingChoices(none, "public")).toEqual([]);
    expect(readyAnswer(none, "public", null)).toEqual({ new_decks: "public", existing: "keep", public_decks: 0 });
  });

  it("offers making every deck public only beside public new decks", () => {
    expect(existingChoices(quiet, "public").map((c) => c.value)).toEqual(["keep", "public"]);
    expect(existingChoices(quiet, "link").map((c) => c.value)).toEqual(["keep"]);
    expect(existingChoices(quiet, null).map((c) => c.value)).toEqual(["keep"]);
    expect(existingChoices(quiet, "public")[1]!.label).toBe("Make all 3 public");
    // Nothing to add when every deck is public already.
    expect(existingChoices({ private: 0, link: 0, public: 2 }, "public").map((c) => c.value)).toEqual(["keep", "link"]);
  });

  it("names keeping public decks for what it does (it lists them), and offers link only instead", () => {
    const choices = existingChoices(mixed, "link");
    expect(choices.map((c) => c.value)).toEqual(["keep", "link"]);
    expect(choices[0]!.label).toBe("Keep my 3 public decks public");
    expect(choices[0]!.hint).toBe("They are then listed in Browse and can be found by search engines, like any public deck. Your other decks stay as they are.");
    expect(choices[1]!.label).toBe("Change my 3 public decks to link only");
    const one = existingChoices({ private: 0, link: 0, public: 1 }, "private")[0]!;
    expect([one.label, one.hint]).toEqual(["Keep my 1 public deck public", "It is then listed in Browse and can be found by search engines, like any public deck."]);
    // Nothing public: keeping changes nothing, and says so.
    expect(existingChoices(quiet, "link")[0]).toMatchObject({ label: "Leave them as they are", hint: "None of them is public, so none is listed." });
  });
});

describe("when the answer can be sent", () => {
  it("needs a choice for new decks", () => {
    expect(readyAnswer(quiet, null, null)).toBeNull();
    expect(readyAnswer(mixed, null, "keep")).toBeNull();
  });

  it("never changes existing decks unless that was chosen", () => {
    // No public decks: keeping is the answer unless the person picks another.
    expect(readyAnswer(quiet, "public", null)).toEqual({ new_decks: "public", existing: "keep", public_decks: 0 });
    expect(readyAnswer(quiet, "public", "public")).toEqual({ new_decks: "public", existing: "public", public_decks: 0 });
  });

  it("makes an account with public decks say what happens to them", () => {
    expect(readyAnswer(mixed, "public", null)).toBeNull();
    expect(readyAnswer(mixed, "link", null)).toBeNull();
    // The answer names how many public decks it is about, so the server can refuse a stale one.
    expect(readyAnswer(mixed, "link", "keep")).toEqual({ new_decks: "link", existing: "keep", public_decks: 3 });
    expect(readyAnswer(mixed, "private", "link")).toEqual({ new_decks: "private", existing: "link", public_decks: 3 });
  });

  it("drops a choice that no longer goes with the answer", () => {
    // "Make all public" was picked, then new decks changed to link only.
    expect(readyAnswer(quiet, "link", "public")).toBeNull();
    expect(readyAnswer(mixed, "private", "public")).toBeNull();
  });
});

function render(node: React.ReactNode, me: object, data?: Sharing) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  if (data) client.setQueryData(["sharing", "u1"], data);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("the one-time question", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains the new meaning, offers link only and private, and has nothing chosen for new decks", () => {
    const html = render(<PublicDefaultDialog sharing={sharing(mixed)} onClose={() => {}} />, { id: "u1" });
    expect(html).toContain("Yama decks are now public by default");
    expect(html).toContain("Make yours public?");
    expect(html).toContain("listed in Browse and can be found by search engines");
    expect(html).toContain("Link only");
    expect(html).toContain("Your 6 existing decks");
    expect(html).toContain("Ask me later");
    // Nothing is chosen for the person, so the answer can't be sent yet.
    expect(html).not.toMatch(/type="radio"[^>]*checked/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("has keeping chosen only for an account with no public deck", () => {
    const html = render(<PublicDefaultDialog sharing={sharing(quiet)} onClose={() => {}} />, { id: "u1" });
    expect(html.match(/type="radio"[^>]*checked/g)).toHaveLength(1);
    expect(html).toMatch(/name="public-default-existing"[^>]*checked/);
  });

  it("shows on the Decks page only to an account that hasn't answered, and not while an admin views as it", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "1", setItem: () => {} });
    expect(render(<PublicDefaultBanner />, { id: "u1" }, sharing(mixed))).toContain("Choose for your decks");
    expect(render(<PublicDefaultBanner />, { id: "u1" }, sharing(mixed, { public_listed_at: "2026-11-12T00:00:00Z" }))).toBe("");
    expect(render(<PublicDefaultBanner />, { id: "u1", viewing: { name: "Sam" } }, sharing(mixed))).toBe("");
  });

  it("opens the question once a visit: not again after Ask me later", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    expect(render(<PublicDefaultBanner />, { id: "u1" }, sharing(mixed))).toContain("Save my answer");
    vi.stubGlobal("sessionStorage", { getItem: () => "1", setItem: () => {} });
    expect(render(<PublicDefaultBanner />, { id: "u1" }, sharing(mixed))).not.toContain("Save my answer");
  });
});

describe("Sharing settings", () => {
  it("offers the question until it is answered, and not while an admin views as the account", async () => {
    const { SharingSettings } = await import("./SharingSettings");
    vi.stubGlobal("location", new URL("https://yama.ing/sharing"));
    expect(render(<SharingSettings />, { id: "u1" }, sharing(mixed))).toContain("Choose for your decks");
    expect(render(<SharingSettings />, { id: "u1" }, sharing(mixed, { public_listed_at: "2026-11-12T00:00:00Z" }))).not.toContain("Choose for your decks");
    expect(render(<SharingSettings />, { id: "u1", viewing: { name: "Sam" } }, sharing(mixed))).not.toContain("Choose for your decks");
    vi.unstubAllGlobals();
  });
});
