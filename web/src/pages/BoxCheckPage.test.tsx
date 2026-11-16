import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { CollectionItem, Container } from "../api";
import { BoxCheckPage } from "./BoxCheckPage";

const boxes: Container[] = [
  { id: "big", kind: "box", name: "Big box", copies: 1, parent_id: null, sections: 1, path: ["Big box"] },
  { id: "bb", kind: "box", name: "Bulk Basic", copies: 3, parent_id: "big", sections: 0, path: ["Big box", "Bulk Basic"] },
];
const row = (id: string, name: string, qty: number, container_id: string | null) =>
  ({ id, name, qty, container_id, container_kind: container_id ? "box" : null, proxy: false, scryfall_id: `s${id}`, set_code: "tst", collector_number: "1", finish: "nonfoil" }) as CollectionItem;

function render(path: string) {
  const client = new QueryClient();
  client.setQueryData(["containers"], boxes);
  client.setQueryData(["collection", "box-check"], [row("1", "Sol Ring", 1, "big"), row("2", "Plains", 3, "bb")]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/collection/check/:id" element={<BoxCheckPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("scanning a box", () => {
  it("names the box by its path and offers its sections", () => {
    const html = render("/collection/check/big");
    expect(html).toContain("Scan Big box</h1>");
    expect(html).toContain("Include its sections.");
    // Before anything is scanned, every card Yama has here (sections included) is not seen yet.
    expect(html).toContain("0 of 4 here");
    expect(html).toContain("Not seen yet: 4");
    expect(html).toContain('href="/collection?box=big"');
  });

  it("a section without sections has no toggle, and says so when gone", () => {
    expect(render("/collection/check/bb")).not.toContain("Include its sections.");
    expect(render("/collection/check/gone")).toContain("isn&#x27;t in your collection any more");
  });
});
