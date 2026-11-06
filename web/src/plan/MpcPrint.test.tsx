import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { MpcImage } from "@yama/core/plan";
import { MpcPrint, mpcThumb, type MpcImages } from "./MpcPrint";

const lines = vi.hoisted(() => ({ value: [] as { card: string; back: string | null }[] }));
vi.mock("@yama/core/plan", async (orig) => ({ ...(await orig<typeof import("@yama/core/plan")>()), printPlan: () => ({ next: { lines: lines.value } }), inForceBundle: (b: unknown) => b }));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => ({ view: { b: {}, answers: {}, today: "2026-11-05" } }), PlansHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

const ID = (n: string) => `1${n.padEnd(32, "x")}`;
const img = (id: string, source = "MrTeferi"): MpcImage => ({ id, name: `${id}.png`, source, dpi: 1200, size: null, ext: "png" });

function page(answer: MpcImages | null) {
  const qc = new QueryClient();
  const names = [...new Set(lines.value.flatMap((l) => (l.back ? [l.card, l.back] : [l.card])))].sort();
  if (answer) qc.setQueryData(["mpc-images", names], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/decks/plans/get/mpc"]}>
        <MpcPrint />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Print with MakePlayingCards", () => {
  it("says so when nothing is waiting to print", () => {
    lines.value = [];
    expect(page(null)).toContain("No prints waiting.");
  });

  it("shows each card's best image with its source, double-faced backs, card backs and the order file", () => {
    lines.value = [
      { card: "Sol Ring", back: null },
      { card: "Sol Ring", back: null },
      { card: "Delver of Secrets", back: "Insectile Aberration" },
    ];
    const html = page({
      cards: { "Sol Ring": [img(ID("sol")), img(ID("sol2"), "JohnPrime")], "Delver of Secrets": [img(ID("delver"))], "Insectile Aberration": [img(ID("insect"))] },
      cardbacks: [img(ID("back"))],
      source: "MPC Autofill (mpcfill.com)",
      fetched_at: "2026-11-05T19:00:00Z",
    });
    expect(html).toContain(`src="${mpcThumb(ID("sol"))}"`);
    expect(html).toContain("Front, 2 copies. MrTeferi, 1200 dpi");
    expect(html).toContain("Other images (1)");
    expect(html).toContain("Back face. MrTeferi, 1200 dpi");
    expect(html).toContain("3 cards in a 18-card project.");
    expect(html).toMatch(/<button type="button" class="outline">Download order.xml<\/button>/);
    expect(html).toContain("Load unpacked");
    expect(html).toContain("Yama stores none of them.");
  });

  it("holds the order back while a card has no image", () => {
    lines.value = [{ card: "Sol Ring", back: null }, { card: "Obscure Card", back: null }];
    const html = page({ cards: { "Sol Ring": [img(ID("sol"))], "Obscure Card": [] }, cardbacks: [img(ID("back"))], source: "MPC Autofill (mpcfill.com)", fetched_at: "2026-11-05T19:00:00Z" });
    expect(html).toContain("MPC Autofill has no image for Obscure Card.");
    expect(html).toContain("No image chosen for Obscure Card.");
    expect(html).toMatch(/<button type="button" class="outline" disabled="">Download order.xml<\/button>/);
  });
});
