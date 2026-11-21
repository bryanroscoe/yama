import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckEntry, DeckView } from "../api";
import { DeckCardsTab, type CardView, type useCardControls } from "./DeckCardsTab";

const entry = (name: string, type: string, cmc: number, o: Partial<DeckEntry> = {}): DeckEntry =>
  ({ name, oracle_id: `o-${name}`, board: "main", qty: 1, owned: 1, proxies: 0, needed: 0, cheapest_usd: 1, card: { type_line: type, cmc, image_normal: `https://img.test/${encodeURIComponent(name)}.jpg` }, ...o }) as never;

const creatures = Array.from({ length: 20 }, (_, i) => entry(`Bear ${i + 1}`, "Creature — Bear", 2));
const deck = {
  cards: [
    entry("Terra, Herald of Hope", "Legendary Creature — Human Wizard", 3, { board: "commander" }),
    ...creatures,
    entry("Sol Ring", "Artifact", 1, { owned: 0, proxies: 1 }),
    entry("Plains", "Basic Land — Plains", 0, { qty: 3, owned: 3 }),
  ],
  ownership: { price_date: "2026-11-11" },
} as unknown as DeckView;

const controls = (view: CardView) => ({ show: "all", setShow() {}, view, setView() {}, groupBy: "type", setGroupBy() {}, sort: "mv", setSort() {} }) as ReturnType<typeof useCardControls>;
const render = (view: CardView, outAt: ReadonlySet<string> = new Set()) =>
  renderToStaticMarkup(<DeckCardsTab deck={deck} controls={controls(view)} outAt={outAt} atBracket={outAt.size ? 3 : null} status={() => null} onOpen={() => {}} />);

describe("the Cards tab's Stacks view", () => {
  it("is offered beside Pictures, List and Table", () => {
    expect(render("list")).toMatch(/>Pictures<\/button><button[^>]*>Stacks<\/button><button[^>]*>List<\/button>/);
  });

  it("lays each group out as stacks of whole card pictures, a long group split in two", () => {
    const html = render("stacks");
    expect(html).toContain('class="cards-stacks"');
    const creaturesGroup = html.slice(html.indexOf('id="g-creatures"'), html.indexOf("</section>", html.indexOf('id="g-creatures"')));
    expect(creaturesGroup.match(/class="cards-stack"/g)).toHaveLength(2);
    expect(creaturesGroup.match(/class="cards-stack-card"/g)).toHaveLength(20);
    // Each card is one button named for what it is, with its count and copy marks over the name bar.
    expect(html).toContain('aria-label="3 Plains"');
    expect(html).toMatch(/aria-label="Sol Ring, proxy"[^]*?card-chip proxy">Proxy</);
    expect(html).toMatch(/qty-badge num">×3</);
  });

  it("shortens the bracket preview's chip to fit the name bar, keeping the whole of it in the label", () => {
    const html = render("stacks", new Set(["Sol Ring"]));
    expect(html).toMatch(/aria-label="Sol Ring, proxy, out at Bracket 3"[^]*?card-chip out">Out</);
    expect(render("pictures", new Set(["Sol Ring"]))).toContain('card-chip out">Out at Bracket 3<');
  });

  it("gives a marked card its own class, so its marks get room under the name bar", () => {
    const html = render("stacks");
    expect(html).toMatch(/class="cards-stack-card is-marked"[^>]*aria-label="Sol Ring, proxy"/);
    expect(html).toMatch(/class="cards-stack-card is-marked"[^>]*aria-label="3 Plains"/);
    expect(html).toMatch(/class="cards-stack-card"[^>]*aria-label="Bear 1"/);
  });

  it("keeps the other views out of the stacks wrapper", () => {
    expect(render("pictures")).not.toContain("cards-stacks");
  });
});

describe("the Cards tab's total", () => {
  const tab = (show: "all" | "need" | "proxy", valueShown = false) =>
    renderToStaticMarkup(<DeckCardsTab deck={deck} controls={{ ...controls("list"), show }} outAt={new Set()} atBracket={null} status={() => null} onOpen={() => {}} valueShown={valueShown} />);

  it("prices what is showing, with the source and date", () => {
    expect(tab("all")).toMatch(/class="cards-total"><b class="num">\$25\.00<\/b><span class="dim">TCGplayer market via Scryfall, Nov 11</);
    expect(tab("proxy")).toMatch(/class="cards-total"><b class="num">\$1\.00</);
  });

  it("isn't repeated while the page's own Value tile shows the whole deck", () => {
    expect(tab("all", true)).not.toContain("cards-total");
    expect(tab("proxy", true)).toContain("cards-total");
  });

  it("has no total for a view with no cards, where No price would read as unknown", () => {
    const html = tab("need");
    expect(html).toContain("Nothing to get.");
    expect(html).not.toContain("cards-total");
    expect(html).not.toContain("No price");
  });

  it("offers one View button for a phone to open the layout, grouping and sort", () => {
    expect(tab("all")).toMatch(/aria-expanded="false"[^>]*>View: List<\/button>/);
  });
});
