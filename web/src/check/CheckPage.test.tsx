// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../api";
import { analysis } from "../decks/analysisFixture";
import { CheckPage } from "./CheckPage";
import { newGuestDeck, readGuestDeck, writeGuestDeck, type CheckedCard, type ListCheck } from "./guestDeck";

const server = vi.hoisted(() => ({
  calls: [] as { path: string; method?: string; json: unknown }[],
  me: null as { id: string } | null,
  refuse: null as string | null,
  /** The list names its commander under a Commander heading. */
  marked: false,
  /** Held back until released: a save whose answer hasn't come yet. */
  hold: null as null | (() => void),
  /** Reading those settings fails. */
  sharingFails: false,
  /** The signed-in account's sharing settings (`GET /api/me/sharing`). */
  sharing: { handle: null as string | null, new_deck_visibility: "private", public_listed_at: null as string | null, collection_public: false, wants_public: false, wants_include_pending: false, share_lab_results: false, decks: { private: 0, link: 0, public: 0 } },
}));

const cardData = (name: string, type_line: string): Card =>
  ({ oracle_id: `o-${name}`, name, type_line, cmc: type_line.includes("Land") ? 0 : 3, mana_cost: "{2}{G}", oracle_text: "", colors: "G", color_identity: "G", legalities: { commander: "legal" }, image_small: null, image_normal: `https://img/${encodeURIComponent(name)}.jpg`, image_art_crop: `https://art/${encodeURIComponent(name)}.jpg`, artist: "Rebecca Guay", game_changer: false }) as unknown as Card;

const entry = (name: string, board: CheckedCard["board"], type_line: string, qty = 1, usd: number | null = null): CheckedCard => ({
  oracle_id: `o-${name}`,
  name,
  qty,
  board,
  card: cardData(name, type_line),
  cheapest_usd: usd,
  cheapest_printing: usd == null ? null : { scryfall_id: `p-${name}`, set_code: "cmm", set_name: "Commander Masters", collector_number: "1", date: "2026-11-10" },
  produced_mana: type_line.includes("Land") ? "G" : "",
  can_lead: type_line.includes("Legendary"),
});

/** What the server answers for a list, with whichever commander was picked. */
function answer(commanders: string[]): ListCheck {
  const lead = commanders[0] ?? "o-Omo, Queen of Vesuva";
  const cards = [
    entry("Omo, Queen of Vesuva", lead === "o-Omo, Queen of Vesuva" ? "commander" : "main", "Legendary Creature — Shapeshifter"),
    entry("Tana, the Bloodsower", lead === "o-Tana, the Bloodsower" ? "commander" : "main", "Legendary Creature — Elf Druid"),
    entry("Sol Ring", "main", "Artifact", 1, 1.5),
    entry("Forest", "main", "Basic Land — Forest", 97),
  ];
  return {
    cards,
    unknown: ["Mystery Card"],
    commander_guessed: commanders.length === 0 && !server.marked,
    validation: { ok: false, total: 100, color_identity: "G", errors: ["Sol Ring × 2: Commander is singleton", "Another problem"], warnings: [] },
    game_changers: ["Sol Ring"],
    game_changers_as_of: "2026-11-01",
    reserved_list: [],
    reserved_list_as_of: "2026-11-01",
    singles_value: { usd: 1.5, priced_copies: 1, unpriced_copies: 99, oldest_date: "2026-11-10", newest_date: "2026-11-10", source: "TCGplayer market via Scryfall" },
    analysis: analysis(5.4, { combos: { checked: false, lines: [], score: 0, families: 0, compact: 0, unrecognized: 0 } }),
  };
}

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: unknown }) => {
    // The account's setting for new decks, which the page reads to say what a saved deck starts
    // as (and holds Save until it has). Not one of the calls these tests count.
    if (path === "/api/me/sharing" && init?.method !== "PUT") return server.sharingFails ? Promise.reject(new Error("Yama didn't answer.")) : Promise.resolve({ ...server.sharing });
    server.calls.push({ path, method: init?.method, json: init?.json });
    // Choosing a handle with a first public deck.
    if (path === "/api/me/sharing") return Promise.resolve({ ...server.sharing, ...(init?.json as object) });
    if (server.refuse) return Promise.reject(new Error(server.refuse));
    if (path === "/api/public/deck-check") return Promise.resolve(answer((init?.json as { commanders: string[] }).commanders));
    if (path === "/api/decks") {
      const made = { id: "d-new", unknown: [] };
      return server.hold === null ? Promise.resolve(made) : new Promise((done) => (server.hold = () => done(made)));
    }
    return Promise.reject(new Error(`unexpected request to ${path}`));
  },
}));
vi.mock("../auth", async (original) => ({
  ...(await original<typeof import("../auth")>()),
  useMe: () => ({ data: server.me ?? undefined, isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIST = "1 Omo, Queen of Vesuva\n1 Tana, the Bloodsower\n1 Sol Ring\n97 Forest\n1 Mystery Card";

describe("Check a deck", () => {
  let host: HTMLElement;
  let root: Root;
  let router: ReturnType<typeof createMemoryRouter>;
  const show = async (at = "/check") => {
    router = createMemoryRouter(
      [
        { path: "/check", element: <CheckPage /> },
        { path: "/signin", element: <p>Sign-in page</p> },
        { path: "/decks/:id", element: <p>The saved deck</p> },
      ],
      { initialEntries: [at] },
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    await settle();
  };
  /** Let the answers on their way arrive and the page draw them. */
  const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 20))));
  const press = async (el: HTMLElement | undefined) => {
    await act(async () => el!.click());
    await settle();
  };
  const text = () => document.body.textContent ?? "";
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  const link = (label: string) => [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === label);
  const type = (value: string) =>
    act(() => {
      const box = document.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const checks = () => server.calls.filter((c) => c.path === "/api/public/deck-check");
  const saves = () => server.calls.filter((c) => c.path === "/api/decks");

  beforeEach(() => {
    server.calls.length = 0;
    server.me = null;
    server.refuse = null;
    server.marked = false;
    server.sharingFails = false;
    server.sharing = { ...server.sharing, handle: null, new_deck_visibility: "private", public_listed_at: null };
    server.hold = null;
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    // A list held because storage was blocked goes with the test.
    writeGuestDeck(null);
  });

  it("opens on the box, with where the list goes said beside it, and asks nothing of the server", async () => {
    await show();
    expect(document.querySelector("h1")!.textContent).toBe("Check a deck");
    expect(text()).toContain("No account needed.");
    expect(text()).toContain("Your list is kept in this browser only");
    expect(text()).toContain("Yama's server checks it and keeps neither the list nor the result, and the list isn't sent to any other service.");
    expect(link("Privacy")!.getAttribute("href")).toBe("/privacy/");
    expect(server.calls).toEqual([]);
  });

  it("won't send an empty box", async () => {
    await show();
    await press(button("Check this deck"));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Paste a deck list first.");
    expect(server.calls).toEqual([]);
    expect(readGuestDeck()).toBeNull();
  });

  it("checks a pasted list, keeps it in the browser and shows what the deck page shows", async () => {
    await show();
    type(LIST);
    await press(button("Check this deck"));
    expect(checks()).toEqual([{ path: "/api/public/deck-check", method: "POST", json: { text: LIST, commanders: [] } }]);
    expect(readGuestDeck()).toMatchObject({ text: LIST, name: "", commanders: [] });

    // The hero: named after the commander, with the art's credit, legality and the three tiles.
    expect(document.querySelector("h1")!.textContent).toBe("Omo, Queen of Vesuva");
    expect(document.querySelector(".hero-credit")!.textContent).toBe("Omo, Queen of Vesuva. Art: Rebecca Guay, © Wizards of the Coast.");
    expect(text()).toContain("Not legal yet");
    expect(text()).toContain("Sol Ring × 2: Commander is singleton");
    expect(text()).toContain("Another problem");
    const tiles = [...document.querySelectorAll(".deck-head-tiles")][0]!.textContent!;
    expect(tiles).toContain("Plays like bracket2 to 3");
    expect(tiles).toContain("Card rules allow 2 or higher");
    expect(tiles).toContain("Value$1.50");
    expect(tiles).toContain("Partial, 99 without a price. TCGplayer market via Scryfall, Nov 10");
    expect(tiles).toContain("Power5.4");
    // Lines that matched no card are named, not dropped silently.
    expect(text()).toContain("One line matched no card and isn't counted: Mystery Card.");
    // The cards, with nothing about owning them.
    expect(text()).toContain("Sol Ring");
    expect(text()).not.toContain("Still need");
    expect(text()).not.toContain("Not owned");
    // Why this bracket: Game Changers from the list; combos say when they're checked, and that
    // the list went nowhere.
    const why = document.querySelector(".why-bracket")!.textContent!;
    expect(why).toContain("Game Changers1");
    expect(why).toContain("Two-card combosChecked once saved");
    expect(why).toContain("This list hasn't been sent anywhere.");
    expect(why).not.toContain("Yama sends this deck's card list");
    expect(text()).not.toContain("·");
  });

  it("shows the power level, curve, colors, themes, flags and value on the Stats tab", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    await show("/check?tab=stats");
    expect(text()).toContain("Power level");
    expect(document.querySelector(".power-dial")!.getAttribute("aria-label")).toContain("Power 5.4 of 10");
    expect(text()).toContain("Mana curve");
    expect(text()).toContain("Color balance");
    expect(text()).toContain("Themes");
    expect(text()).toContain("Game Changers and Reserve List");
    expect(text()).toContain("Market value (estimate)");
    expect(document.getElementById("check-value")!.textContent).toContain("$1.50 in singles (partial: 99 copies without a price). TCGplayer market via Scryfall, Nov 10");
    // Nothing that needs an account: no other decks to compare with, no ownership split.
    expect(text()).not.toContain("Another deck");
    expect(text()).not.toContain("Real cards you own");
    expect(server.calls.map((c) => c.path)).toEqual(["/api/public/deck-check"]);
  });

  it("is still there on the next visit, and asks the server again rather than keeping the answer", async () => {
    writeGuestDeck({ ...newGuestDeck(LIST, "Lands matter"), commanders: ["o-Tana, the Bloodsower"] });
    await show();
    expect(document.querySelector("h1")!.textContent).toBe("Lands matter");
    expect(checks()[0]!.json).toEqual({ text: LIST, commanders: ["o-Tana, the Bloodsower"] });
    expect(Object.keys(localStorage)).toEqual(["yama.check.deck"]);
    expect(localStorage.getItem("yama.check.deck")).not.toContain("validation");
  });

  it("says whose guess the commander is and checks again with the one picked", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    await show();
    expect(text()).toContain("The list has no Commander heading, so Yama took Omo, Queen of Vesuva.");
    const pick = document.querySelector<HTMLSelectElement>(".check-commander select")!;
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Omo, Queen of Vesuva", "Tana, the Bloodsower"]);
    await act(async () => {
      pick.value = "o-Tana, the Bloodsower";
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(checks().at(-1)!.json).toEqual({ text: LIST, commanders: ["o-Tana, the Bloodsower"] });
    expect(readGuestDeck()!.commanders).toEqual(["o-Tana, the Bloodsower"]);
    expect(document.querySelector("h1")!.textContent).toBe("Tana, the Bloodsower");
    expect(text()).toContain("You picked the commander.");
  });

  it("offers the pickers for a list with a Commander heading too, so a partner can be added", async () => {
    server.marked = true;
    writeGuestDeck(newGuestDeck(`Commander\n${LIST}`));
    await show();
    expect(text()).toContain("The list's Commander heading names Omo, Queen of Vesuva. Pick here to change it or add a partner.");
    const [, partner] = [...document.querySelectorAll<HTMLSelectElement>(".check-commander select")];
    expect([...partner!.options].map((o) => o.textContent)).toEqual(["None", "Tana, the Bloodsower"]);
    await act(async () => {
      partner!.value = "o-Tana, the Bloodsower";
      partner!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(checks().at(-1)!.json).toEqual({ text: `Commander\n${LIST}`, commanders: ["o-Omo, Queen of Vesuva", "o-Tana, the Bloodsower"] });
  });

  it("a pick of commander is a new save: the id sent with the old one isn't reused", async () => {
    const first = newGuestDeck(LIST);
    writeGuestDeck(first);
    server.me = { id: "u1" };
    await show();
    const pick = document.querySelector<HTMLSelectElement>(".check-commander select")!;
    await act(async () => {
      pick.value = "o-Tana, the Bloodsower";
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const picked = readGuestDeck()!.opId;
    expect(picked).not.toBe(first.opId);
    await press(button("Save to your decks"));
    expect((saves()[0]!.json as { op_id: string }).op_id).toBe(picked);
    expect((saves()[0]!.json as { op_id: string }).op_id).not.toBe(first.opId);
  });

  it("while a save is on its way the list can't be edited or cleared, and the save removes only the list it saved", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    server.me = { id: "u1" };
    server.hold = () => {};
    await show();
    await press(button("Save to your decks"));
    expect(button("Saving…")!.disabled).toBe(true);
    expect(button("Edit the list")!.disabled).toBe(true);
    expect(button("Clear")!.disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLSelectElement>(".check-commander select")].every((s) => s.disabled)).toBe(true);
    // Another tab kept a different list meanwhile.
    const other = newGuestDeck("1 Sol Ring");
    writeGuestDeck(other);
    await act(async () => server.hold!());
    await settle();
    expect(router.state.location.pathname).toBe("/decks/d-new");
    expect(readGuestDeck()).toEqual(other);
  });

  it("where the browser won't keep the list, says so and still carries it to sign-in and back", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await show();
    type(LIST);
    await press(button("Check this deck"));
    expect(localStorage.getItem("yama.check.deck")).toBeNull();
    expect(text()).toContain("This browser isn't keeping the list, so it's gone once this page is closed or reloaded.");
    expect(text()).not.toContain("this list is in your browser");
    await press(link("Sign in to save this deck"));
    expect(text()).toBe("Sign-in page");
    // Signed in on the same page load, and back: the list is still there, and saved when asked.
    server.me = { id: "u1" };
    await act(async () => void router.navigate("/check"));
    await settle();
    expect(saves()).toEqual([]);
    await press(button("Save to your decks"));
    expect(saves()).toHaveLength(1);
    expect((saves()[0]!.json as { name: string }).name).toBe("Omo, Queen of Vesuva");
    expect(router.state.location.pathname).toBe("/decks/d-new");
    expect(readGuestDeck()).toBeNull();
  });

  it("signed out, offers to sign in to save and says that signing in saves nothing by itself", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    await show();
    const signIn = link("Sign in to save this deck")!;
    expect(signIn.getAttribute("href")).toBe("/signin?next=%2Fcheck");
    expect(button("Save to your decks")).toBeUndefined();
    // No choice to make yet, and no setting of anyone's shown.
    expect(document.querySelector(".visibility-choice")).toBeNull();
    expect(text()).toContain("Signing in doesn't save the deck. Back here you choose who can see it (Public, Link only or Private), and it is saved when you press Save.");
    await press(signIn);
    expect(text()).toBe("Sign-in page");
    expect(saves()).toEqual([]);
    expect(readGuestDeck()!.text).toBe(LIST);
  });

  const choice = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".visibility-choice button")].find((b) => b.textContent === label)!;
  const sentSave = () => saves()[0]!.json as { name: string; cards: { name: string; qty: number; board: string }[]; op_id: string; visibility: string };

  it("back from signing in, saves nothing until Save is pressed, then with who can see it as picked", async () => {
    // A new account: its decks start Public unless the person says otherwise.
    server.sharing = { ...server.sharing, new_deck_visibility: "public", public_listed_at: "2026-11-12T17:00:00Z" };
    const deck = newGuestDeck(LIST);
    // A record from before this change, when a sign-in soon after asking saved by itself.
    localStorage.setItem("yama.check.deck", JSON.stringify({ ...deck, saveAsked: Date.now() - 60_000 }));
    server.me = { id: "u1" };
    await show();
    expect(saves()).toEqual([]);
    expect(router.state.location.pathname).toBe("/check");
    // The save step's own choice, starting at the account's setting, with what it means.
    expect(text()).toContain("Who can see it");
    expect(choice("Public").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Once you pick a handle it is on your profile, and can be listed in Browse and found by search engines.");
    await act(async () => choice("Private").click());
    expect(choice("Private").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Only you can see it.");
    expect(saves()).toEqual([]);
    await press(button("Save to your decks"));
    expect(saves()).toHaveLength(1);
    expect(sentSave()).toMatchObject({ name: "Omo, Queen of Vesuva", op_id: deck.opId, visibility: "private" });
    expect(sentSave().cards.map((c) => [c.name, c.qty, c.board])).toEqual([
      ["Omo, Queen of Vesuva", 1, "commander"],
      ["Tana, the Bloodsower", 1, "main"],
      ["Sol Ring", 1, "main"],
      ["Forest", 97, "main"],
    ]);
    expect(text()).toBe("The saved deck");
    expect(router.state.location.pathname).toBe("/decks/d-new");
    expect(readGuestDeck()).toBeNull();
  });

  it("saves with the account's setting when the person leaves the choice as it is", async () => {
    server.sharing = { ...server.sharing, new_deck_visibility: "link" };
    writeGuestDeck(newGuestDeck(LIST));
    server.me = { id: "u1" };
    await show();
    expect(choice("Link only").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Anyone with the link can see the list. It isn't listed anywhere.");
    await press(button("Save to your decks"));
    expect(sentSave().visibility).toBe("link");
  });

  it("a first public deck asks for a handle, saved before the deck, and can be left blank", async () => {
    server.sharing = { ...server.sharing, new_deck_visibility: "public", public_listed_at: "2026-11-12T17:00:00Z" };
    writeGuestDeck(newGuestDeck(LIST));
    server.me = { id: "u1" };
    await show();
    const field = () => document.querySelector<HTMLInputElement>(".import-handle input");
    expect(field()).not.toBeNull();
    const typeHandle = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field()!, value);
        field()!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    // A handle that can't be one holds the save.
    typeHandle("no");
    expect(button("Save to your decks")!.disabled).toBe(true);
    typeHandle("Kelly");
    expect(button("Save to your decks")!.disabled).toBe(false);
    await press(button("Save to your decks"));
    expect(server.calls.filter((c) => c.path !== "/api/public/deck-check").map((c) => [c.method, c.path])).toEqual([["PUT", "/api/me/sharing"], ["POST", "/api/decks"]]);
    expect(sentSave().visibility).toBe("public");
    // Not asked for a deck that isn't public.
    act(() => root.unmount());
    root = createRoot(host);
    server.calls.length = 0;
    writeGuestDeck(newGuestDeck(LIST));
    await show();
    await act(async () => choice("Link only").click());
    expect(field()).toBeNull();
  });

  it("holds Save while the account's setting can't be read, so no deck is made before the choice is on screen", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    server.me = { id: "u1" };
    server.sharingFails = true;
    await show();
    expect(document.querySelector(".visibility-choice")).toBeNull();
    expect(button("Save to your decks")!.disabled).toBe(true);
    expect(text()).toContain("Yama didn't answer.");
    expect(saves()).toEqual([]);
  });

  it("keeps the list when the server refuses, and offers to edit it", async () => {
    writeGuestDeck(newGuestDeck(LIST));
    server.refuse = "Too many deck checks from this address. Try again in 3 minutes.";
    await show();
    expect(text()).toContain("Too many deck checks from this address. Try again in 3 minutes.");
    expect(readGuestDeck()!.text).toBe(LIST);
    server.refuse = null;
    await press(button("Edit the list"));
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(LIST);
    // Cancel goes back to the same list, unchanged.
    await press(button("Cancel"));
    expect(document.querySelector("h1")!.textContent).toBe("Omo, Queen of Vesuva");
  });

  it("changing the list starts a new one: no commander pick or save id carries over", async () => {
    const first = { ...newGuestDeck(LIST), commanders: ["o-Tana, the Bloodsower"] };
    writeGuestDeck(first);
    await show();
    await press(button("Edit the list"));
    type(`${LIST}\n1 Rampant Growth`);
    await press(button("Check this deck"));
    const kept = readGuestDeck()!;
    expect(kept.text).toBe(`${LIST}\n1 Rampant Growth`);
    expect(kept.commanders).toEqual([]);
    expect(kept.opId).not.toBe(first.opId);
  });
});
