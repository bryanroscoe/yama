// @vitest-environment jsdom
// A new box from the collection scanner's settings (Bryan, 23 Nov 2026: "I need the ability to add
// a new box"): "Put in" offers to make one, and the cards scanned next are filed into it. The
// scanner itself is faked: only its host's settings and what it files.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerViewProps } from "../scanner";

const got = vi.hoisted(() => ({ props: null as ScannerViewProps | null, ops: [] as unknown[][], made: [] as unknown[] }));
vi.mock("../scanner", async (original) => ({
  ...(await original<typeof import("../scanner")>()),
  ScannerView: (props: ScannerViewProps) => {
    got.props = props;
    return <div className="fake-scanner">{props.settings}</div>;
  },
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: async (path: string, init?: { method?: string; json?: unknown }) => {
    if (path === "/api/containers" && init?.method === "POST") {
      got.made.push(init.json);
      return { id: "c-new" };
    }
    if (path === "/api/collection/ops" && init?.method === "POST") {
      got.ops.push(init.json as unknown[]);
      return { applied: 1, skipped_duplicates: 0 };
    }
    if (path.startsWith("/api/collection")) return [];
    throw new Error(`offline: ${path}`);
  },
}));

const { ScanToCollection } = await import("./Collection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(got, { props: null, ops: [], made: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient();
  const router = createMemoryRouter([{ path: "/", element: <QueryClientProvider client={client}><ScanToCollection containers={[]} onClose={() => undefined} /></QueryClientProvider> }]);
  act(() => root.render(<RouterProvider router={router} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });

describe("a new box from the scanner's settings", () => {
  it("makes a box from Put in, and files the next cards into it", async () => {
    const select = await until(() => [...host.querySelectorAll<HTMLSelectElement>("select")].find((s) => [...s.options].some((o) => o.textContent === "Not filed anywhere")), "Put in");
    await setValue(select, "__new");
    const name = await until(() => host.querySelector<HTMLInputElement>('input[placeholder="Trade binder"]'), "the new box's name");
    expect(host.querySelector<HTMLSelectElement>("form select")?.value).toBe("box");
    await setValue(name, "Star Trek bulk");
    await act(async () => host.querySelector("form")!.requestSubmit());
    await until(() => got.made.length === 1, "the box made");
    expect(got.made[0]).toEqual({ kind: "box", name: "Star Trek bulk" });
    await until(() => (host.querySelector('input[placeholder="Trade binder"]') ? null : true), "the form closed");
    await act(async () => void (await got.props!.onAccept!({ name: "Arcane Signet", set: "woc", number: "145", scryfall_id: "p-a", oracle_id: "o", finishes: ["nonfoil"], confidence: 1, method: "art" }, 1, false)));
    await until(() => got.ops.length === 1, "the add");
    expect(got.ops[0]).toEqual([expect.objectContaining({ kind: "add", scryfall_id: "p-a", container_id: "c-new" })]);
  });
});
