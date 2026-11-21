// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectState, offerDeclined, type CollectAfter, type CollectPreview } from "./collect";
import { CollectSheet } from "./CollectSheet";

const none = { moved: 0, added: 0, left_out: 0 };
const preview = (over: Partial<CollectPreview> = {}): CollectPreview => ({
  deck_id: "d1", deck_name: "Tricky Terrain", version_id: "v", box_id: "b", box_name: "Tricky Terrain", box_kind: "deck", box_exists: true,
  same_printing: "move", cards: 100, in_box: 100, missing: 0, same_elsewhere: 0, not_in_list: 0,
  options: { move: none, add: none, skip: none }, ...none, proxies: 0, no_printing: [], lines: [], applied: false, ...over,
});
/** The box is two cards short of the list. */
const short = () => {
  const adds = { moved: 0, added: 2, left_out: 0 };
  return preview({ in_box: 98, missing: 2, ...adds, options: { move: adds, add: adds, skip: adds } });
};

const server = vi.hoisted(() => ({
  /** What the next preview answers: a preview, an error, or (null) nothing yet. */
  answer: null as unknown,
  asked: 0,
}));

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: () => {
    server.asked++;
    if (server.answer === null) return new Promise(() => {});
    return server.answer instanceof Error ? Promise.reject(server.answer) : Promise.resolve(server.answer);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let closed = 0;

beforeEach(() => {
  server.answer = null;
  server.asked = 0;
  closed = 0;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // As in the app: an answer is kept as good for half a minute.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});

async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 100 && !ready(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

async function open(after: CollectAfter | null) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[{ pathname: "/decks/d1", search: "?collect=1", state: after ? collectState(after) : null }]}>
          <CollectSheet deckId="d1" offer onClose={() => closed++} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("the line after a saved edit", () => {
  it("offers the cards the box is short of now, whatever was worked out before the save", async () => {
    // Half a minute ago the box held the whole list; the edit just saved added two cards.
    client.setQueryData(["deck-collect", "d1", "move", null], preview());
    server.answer = short();
    await open("edit");
    await until(() => text().includes("aren't in the deck's box yet"), "the line");
    expect(text()).toContain("2 cards in this list aren't in the deck's box yet.");
    expect(closed).toBe(0);
  });

  it("says nothing from an answer kept from before the save, and closes once the new one has nothing to offer", async () => {
    client.setQueryData(["deck-collect", "d1", "move", null], short());
    await open("edit");
    // The check for the new list is still on its way: the old answer is neither shown nor final.
    expect(server.asked).toBe(1);
    expect(text()).not.toContain("in the deck's box yet");
    expect(closed).toBe(0);
    server.answer = preview();
    await act(() => client.refetchQueries({ queryKey: ["deck-collect"] }));
    await until(() => closed > 0, "the line to close");
    expect(text()).not.toContain("in the deck's box yet");
  });

  it("closes without a word when the check fails", async () => {
    server.answer = new Error("offline");
    await open("edit");
    await until(() => closed > 0, "the line to close");
    expect(offerDeclined("d1")).toBe(false);
  });

  it("remembers Not now", async () => {
    server.answer = short();
    await open("edit");
    await until(() => !!button("Not now"), "the line");
    act(() => button("Not now")!.click());
    expect(closed).toBe(1);
    expect(offerDeclined("d1")).toBe(true);
  });
});

describe("closing the sheet that offers a new deck's cards", () => {
  it("is Not now once the offer is on screen", async () => {
    server.answer = short();
    await open("import");
    await until(() => !!button("Add 2 cards"), "the offer");
    act(() => button("Not now")!.click());
    expect(closed).toBe(1);
    expect(offerDeclined("d1")).toBe(true);
  });

  it("declines nothing while the sheet is still checking, or when the check failed", async () => {
    await open("import");
    expect(text()).toContain("Checking your collection");
    act(() => button("Close")!.click());
    expect(closed).toBe(1);
    expect(offerDeclined("d1")).toBe(false);
  });

  it("declines nothing when there was nothing to add", async () => {
    server.answer = preview();
    await open("import");
    await until(() => !!button("Nothing to add"), "the answer");
    act(() => button("Not now")!.click());
    expect(closed).toBe(1);
    expect(offerDeclined("d1")).toBe(false);
  });
});
