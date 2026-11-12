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

  it("keeps the other views out of the stacks wrapper", () => {
    expect(render("pictures")).not.toContain("cards-stacks");
  });
});
