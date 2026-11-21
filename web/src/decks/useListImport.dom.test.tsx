// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commanders, draftFrom, fixUnknown, setCommanders, type ImportCard, type ImportCardInfo, type ImportPreview, type PreviewDeck } from "./importLogic";
import { useListImport } from "./useListImport";

const info = (oracle_id: string, name: string, leads = false): ImportCardInfo => ({
  oracle_id, name, type_line: leads ? "Legendary Creature" : "Artifact", mana_cost: null, cmc: 1, color_identity: "", image_small: null, image_normal: null, artist: null,
  can_be_commander: leads, any_number: false, partner: false,
});
const KNOWN = [info("o-atraxa", "Atraxa, Praetors' Voice", true), info("o-krenko", "Krenko, Mob Boss", true), info("o-thrasios", "Thrasios, Triton Hero", true), info("o-sol", "Sol Ring"), info("o-signet", "Arcane Signet")];
const signet = KNOWN[4]!;

/** The server's reading, near enough: "Commander" and "Deck" headings, one "1 Name" card a line, unknown names kept as written. */
function read(text: string): PreviewDeck {
  const deck: PreviewDeck = { name: null, cards: [], unknown: [], commander_marked: false, commander_guessed: false };
  let board: ImportCard["board"] = "main";
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line === "Commander" || line === "Deck") {
      board = line === "Commander" ? "commander" : "main";
      if (board === "commander") deck.commander_marked = true;
      continue;
    }
    const name = line.replace(/^1 /, "");
    const hit = KNOWN.find((k) => k.name === name);
    const rest = { qty: 1, board, maybe: false, set_code: null, collector_number: null, finish: null };
    if (hit) deck.cards.push({ ...hit, ...rest, print_found: null, print_image: null, written_as: null });
    else deck.unknown.push({ name, ...rest, suggestions: [signet] });
  }
  return deck;
}

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (_path: string, init?: { json?: { text: string } }) =>
    Promise.resolve({ format: "text", format_label: null, link: null, decks: [read(init!.json!.text)], skipped: [] } satisfies ImportPreview),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let list: ReturnType<typeof useListImport>;

function Harness() {
  list = useListImport({ initialText: () => "", makeDraft: (d) => draftFrom(d) });
  return null;
}

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});

/** Lets the reading asked for come back. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

/** A paste into the box; `whole`: over everything in it (select all first). */
async function paste(pasted: string, whole = false) {
  const value = list.text;
  let taken = false;
  act(() =>
    list.boxProps.onPaste({
      clipboardData: { getData: () => pasted },
      currentTarget: { value, selectionStart: whole ? 0 : value.length, selectionEnd: value.length },
      preventDefault: () => (taken = true),
    }),
  );
  // Over a list the browser makes the edit itself and reports the box's new text.
  if (!taken) act(() => list.boxProps.onChange({ target: { value: whole ? pasted : value + pasted } }));
  await settle();
}

/** Typing: the box's new text, read at once instead of after the typing pause. */
async function type(next: string) {
  act(() => {
    list.boxProps.onChange({ target: { value: next } });
    list.runCheck([{ text: next }]);
  });
  await settle();
}

const file = (name: string, text: string) => ({ name, size: text.length, text: () => Promise.resolve(text) }) as unknown as File;
const leaders = () => commanders(list.draft!).map((c) => c.name);

describe("what the person fixed in a reading", () => {
  const first = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signt";

  it("is made again when the same list is edited", async () => {
    await paste(first);
    expect(list.draft!.unknown.map((u) => u.name)).toEqual(["Arcane Signt"]);
    act(() => {
      list.rememberFix("Arcane Signt", signet);
      list.setDraft(fixUnknown(list.draft!, 0, signet));
    });
    await type(`${first}\n1 Krenko, Mob Boss`);
    expect(list.draft!.unknown).toEqual([]);
    expect(list.draft!.cards.map((c) => c.name)).toContain("Arcane Signet");
  });

  it("is forgotten when a paste over the whole box brings another list", async () => {
    await paste(first);
    act(() => {
      list.rememberFix("Arcane Signt", null);
      list.rememberCommanders(["o-atraxa"]);
    });
    // Another deck, with the same misspelt line: nobody answered it for this one.
    await paste("Commander\n1 Krenko, Mob Boss\n\nDeck\n1 Arcane Signt", true);
    expect(list.draft!.unknown.map((u) => u.name)).toEqual(["Arcane Signt"]);
    expect(leaders()).toEqual(["Krenko, Mob Boss"]);
  });

  it("isn't kept for decks read from several files, so a list pasted into the empty box starts clean", async () => {
    await act(() => list.readFiles([file("a.txt", first), file("b.txt", "Commander\n1 Krenko, Mob Boss\n\nDeck\n1 Sol Ring")]));
    await settle();
    expect(list.drafts).toHaveLength(2);
    expect(list.text).toBe("");
    act(() => {
      list.rememberFix("Arcane Signt", null);
      list.rememberCommanders(["o-sol"]);
      list.rememberName("File deck");
    });
    await paste("1 Thrasios, Triton Hero\n1 Sol Ring\n1 Arcane Signt");
    expect(list.drafts).toHaveLength(1);
    expect(list.draft!.unknown.map((u) => u.name)).toEqual(["Arcane Signt"]);
    expect(leaders()).toEqual([]);
    expect(list.draft!.name).toBe("");
  });
});

describe("a commander the person picked", () => {
  const withAtraxa = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Krenko, Mob Boss\n1 Thrasios, Triton Hero";

  it("stays over the list's own while that isn't changed, and gives way to one typed under the heading", async () => {
    await paste(withAtraxa);
    expect(leaders()).toEqual(["Atraxa, Praetors' Voice"]);
    act(() => {
      list.rememberCommanders(["o-krenko"]);
      list.setDraft(setCommanders(list.draft!, ["o-krenko"]));
    });
    // Another card typed in: the heading still says Atraxa, and the pick still stands.
    await type(`${withAtraxa}\n1 Sol Ring`);
    expect(leaders()).toEqual(["Krenko, Mob Boss"]);
    // The person writes Thrasios under the heading instead.
    const retyped = "Commander\n1 Thrasios, Triton Hero\n\nDeck\n1 Krenko, Mob Boss\n1 Atraxa, Praetors' Voice\n1 Sol Ring";
    await type(retyped);
    expect(leaders()).toEqual(["Thrasios, Triton Hero"]);
    // And the pick is gone for good, not waiting for the old heading to come back.
    await type(`${withAtraxa}\n1 Sol Ring`);
    expect(leaders()).toEqual(["Atraxa, Praetors' Voice"]);
  });

  it("names a deck that has no name only until the list says who leads; a typed name stays", async () => {
    await paste("1 Krenko, Mob Boss\n1 Atraxa, Praetors' Voice");
    expect(list.draft!.name).toBe("");
    act(() => {
      list.rememberCommanders(["o-krenko"]);
      list.setDraft(setCommanders(list.draft!, ["o-krenko"]));
    });
    expect(list.draft!.name).toBe("Krenko");
    // The name came from the pick, not from the person: with Atraxa under a heading it follows her.
    await type("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Krenko, Mob Boss");
    expect(leaders()).toEqual(["Atraxa, Praetors' Voice"]);
    expect(list.draft!.name).toBe("Atraxa");
    act(() => {
      list.rememberName("Superfriends");
      list.setDraft({ ...list.draft!, name: "Superfriends" });
    });
    await type("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Krenko, Mob Boss\n1 Sol Ring");
    expect(list.draft!.name).toBe("Superfriends");
  });
});
