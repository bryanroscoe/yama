/// <reference types="node" />
// Local only: compares the buy list, print plan and spares with Bryan's real commander-decks guides.
// Reads ../commander-decks (next to this repo) or YAMA_COMMANDER_DECKS, and is skipped when the
// files aren't there, so his data never enters this repo or CI. The deliberate differences from the
// guides are spelled out in each test: no $0 totals, price flags, and for spares only the extras Yama
// shows that the guide has no section for. Dated whole-build audits and separate approved stock
// pickups stay outside the export; source records identify those guide-only rows explicitly.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  answerIndex,
  buyList,
  laterOutText,
  orderText,
  printPlan,
  spares,
  swapSheet,
  type Order,
  type PlanBundle,
  type PlanDeck,
  type Quote,
  type Store,
  type Swap,
} from "./index";

const REPO = process.env.YAMA_COMMANDER_DECKS ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../commander-decks");
const PLAN = join(REPO, "data/planner/yama-plan.json");
const present = existsSync(PLAN) && existsSync(join(REPO, "docs/buy-list.md"));
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

type Doc = { plan: Record<string, unknown> & { decks: Record<string, unknown>[]; swaps: Record<string, unknown>[] } };

/** The plan file shaped like the bundle the server would send for it, with no Yama card or price data. */
function bundleOf(doc: Doc): PlanBundle {
  const p = doc.plan as Record<string, any>;
  const decks: PlanDeck[] = p.decks.map((d: any) => ({
    ...d,
    source: "import",
    deck_id: null,
    updated_at: "",
    groups: d.groups ?? [],
    notes: d.notes ?? [],
    owner_changes: d.owner_changes ?? [],
    states: Object.fromEntries(
      Object.entries(d.states ?? {}).map(([k, v]: [string, any]) => [k, { id: k, content_hash: "", computed_by: "", updated_at: "", cards: v.cards, log: v.log ?? [], unresolved: [] }]),
    ),
  }));
  const swaps: Swap[] = p.swaps.map((s: any) => ({ ...s, retired: false, retired_at: null, updated_at: "", upgrade: s.upgrade ?? null }));
  const quotes: Quote[] = p.quotes.map((q: any) => ({ currency: "USD", origin: "import", scryfall_id: null, ...q }));
  const stores: Store[] = p.stores.map((s: any) => ({ origin: "import", retired: false, retired_at: null, ...s }));
  const orders: Order[] = p.orders.map((o: any) => ({ origin: "import", retired: false, retired_at: null, ...o }));
  return {
    rev: "", revision: 1, head: null, notes: p.notes ?? [], game_changers: null, library: p.library ?? null,
    settings: p.settings, stores, decks, swaps, aliases: {}, orders, quotes, reviews: p.reviews ?? {}, marks: {},
    inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
    names: {}, unresolved: [], cards: {}, market: {}, market_by_printing: {}, printing_ids: {}, prices_as_of: null,
  };
}

/** Rows of every markdown table under each "## " heading. */
function mdSections(md: string): { head: string; rows: string[][] }[] {
  const out: { head: string; rows: string[][] }[] = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) out.push({ head: line.slice(3), rows: [] });
    else if (line.startsWith("|") && out.length && !/^\|[-|: ]+\|$/.test(line)) {
      out[out.length - 1]!.rows.push(line.slice(1, -1).split(" | ").map((c) => c.trim().replace(/^\*\*(.*)\*\*$/, "$1")));
    }
  }
  return out.map((s) => ({ ...s, rows: s.rows.slice(1) })); // drop each table's header row
}

describe.skipIf(!present)("Bryan's real plan (local only)", () => {
  const doc = present ? (JSON.parse(readFileSync(PLAN, "utf8")) as Doc) : null;
  const b = doc ? bundleOf(doc) : (null as unknown as PlanBundle);
  const live = b ? b.swaps.map((s) => s.key) : [];
  const { answers } = b ? answerIndex(b.reviews, b.aliases, live) : { answers: new Map() };
  const deckName = (k: string) => b.decks.find((d) => d.key === k)?.name ?? k;
  type Candidate = { id: string; inn: string; deck: string; src: Swap["src"]; audit_only?: boolean };
  const candidates: Candidate[] = present ? JSON.parse(read("data/shopping/candidates.json")).candidates : [];
  const pair = (card: string, deck: string) => JSON.stringify([card, deck]);
  // Exporter v16 keeps dated, whole-build audits out of the cumulative planner. Keep a
  // cumulative proposal for the same card/deck/source in scope when an audit also names it.
  // A planned card or a buy proposal does not imply a proposed use of someone's spare.
  const guideOnlyAuditPairs = (src: "buy" | "owned") => {
    const exported = new Set(b ? b.swaps.filter((s) => s.stage === "proposed" && s.src === src).map((s) => pair(s.in, deckName(s.deck))) : []);
    return new Set(candidates.filter((c) => c.audit_only && c.src === src && !exported.has(pair(c.inn, c.deck))).map((c) => pair(c.inn, c.deck)));
  };
  const guideOnlyBuyAudits = guideOnlyAuditPairs("buy");
  const guideOnlySpareAudits = guideOnlyAuditPairs("owned");

  it("imports every cumulative candidate and excludes audit-only research", () => {
    const ids = new Set(candidates.map((c) => c.id));
    expect(b.swaps.filter((s) => ids.has(s.key)).map((s) => s.key).sort()).toEqual(candidates.filter((c) => !c.audit_only).map((c) => c.id).sort());
  });

  it("printPlan's placed order is the frozen MakePlayingCards order and the print list, card for card", () => {
    const plan = printPlan(b, { answers, today: "2026-10-19" });
    expect(plan.placed).toHaveLength(1);
    const placed = plan.placed[0]!;
    expect(placed.count).toBe(180);
    expect(placed.missing).toEqual([]);
    expect(placed.extra).toEqual([]);
    const text = orderText(placed.lines.map((l) => ({ card: l.card, qty: 1 })));
    expect(text).toBe(read("docs/shopping/mtg-print-order.txt"));
    const frozen = read("data/planner/mpc-order-placed-2026-10-15.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")).join("\n") + "\n";
    expect(text).toBe(frozen);
    // Nothing is waiting for a next order until a print is added or a proposed print gets a want.
    expect(plan.next.lines.filter((l) => !l.proposed)).toEqual([]);
    // Stand-ins: the print takes out the stand-in, as the print list's "Takes out" column says.
    const withStandin = placed.lines.filter((l) => l.standin);
    expect(withStandin).toHaveLength(21);
    for (const l of withStandin) expect(l.takesOut).toBe(l.standin!.in);
  });

  it("swapSheet matches the print swap sheet (docs/shopping/mtg-print-swaps.html), row for row", () => {
    const sheet = swapSheet(b);
    expect(sheet.prints).toBe(180);
    expect(sheet.decks.slice(0, 2).map((d) => d.deck.name)).toEqual(["Fantastic Four", "Lorehold Spirit"]);
    expect(sheet.moves.map((m) => `${m.card}: ${m.from.name} → ${m.to.name}`).sort()).toEqual([
      "Karmic Guide: Lorehold Spirit → Revival Trance",
      "Sodden Verdure: Fantastic Four → Tricky Terrain",
      "The Scarlet Witch: Fantastic Four → Prismari Artistry",
    ]);
    // The guide's rows: deck, card in, card out, where it goes.
    const dec = (t: string) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const html = read("docs/shopping/mtg-print-swaps.html");
    const guide: string[] = [];
    for (const sec of html.split("<section>").slice(1)) {
      const deck = dec(/<h1>(.*?) <span>/.exec(sec)![1]!);
      for (const tr of sec.split("<tr>").slice(2)) {
        const names = [...tr.matchAll(/<b[^>]*>(.*?)<\/b>/g)].map((m) => dec(m[1]!));
        const to = tr.includes('class="go"') ? "deck" : tr.includes('class="bag"') ? "bag" : tr.includes("back to your basics") ? "basics" : "spares";
        guide.push(`${deck} | ${names[0]} | ${names[1]} | ${to}`);
      }
    }
    const mine = sheet.decks.flatMap((d) => d.steps.map((s) => `${d.deck.name} | ${s.in} | ${s.out} | ${s.to}`));
    expect(mine.sort()).toEqual(guide.sort());
  });

  it("buyList matches docs/buy-list.md store by store", () => {
    const list = buyList(b, { answers });
    const pickupFile = "data/shopping/approved-pickups.json";
    const pickups: { store: string; approved?: string | boolean; items: { card: string }[] }[] = existsSync(join(REPO, pickupFile)) ? JSON.parse(read(pickupFile)).pickups : [];
    const md = mdSections(read("docs/buy-list.md")).filter((sec) => {
      if (!sec.head.includes(": approved pickups")) return true;
      // This separate Card/Qty/Use table describes stock pickups, not planner swaps.
      // Every omitted row must have an independent approved-pickup source record.
      const pickupCards = new Set(pickups.filter((p) => p.approved && sec.head.startsWith(`${p.store}:`)).flatMap((p) => p.items.map((i) => i.card)));
      for (const row of sec.rows) {
        const card = row[0]!.replace(/^\[([^\]]+)\]\(.*\)$/, "$1");
        expect(pickupCards.has(card), `approved pickup source for ${card}`).toBe(true);
      }
      return false;
    }).map((sec) => {
      const rows = sec.rows.filter((r) => !guideOnlyBuyAudits.has(pair(r[0]!, r[1]!)));
      // Keep the exact whole-cart and headline checks below. A future mixed cart needs
      // an independently sourced per-row cart projection instead of a weaker subset check.
      if (/ cards, \$/.test(sec.head)) expect(rows.length === 0 || rows.length === sec.rows.length, `mixed audit/planner cart: ${sec.head}`).toBe(true);
      return { ...sec, rows };
    });
    for (const g of list.stores) {
      const sec = md.find((s) => s.rows.length && s.head.startsWith(`${g.store.name}:`));
      expect(sec, `section for ${g.store.name}`).toBeTruthy();
      const want = sec!.rows.map((r) => [r[0], r[1], r[2], r[4]]).sort();
      const got = g.rows.map((r) => [r.swap.in, deckName(r.swap.deck), r.replaces ?? "", r.price == null ? "no price" : `$${r.price.toFixed(2)}`]).sort();
      expect(got).toEqual(want);
      // Totals: every row in a store group has a price (Yama keeps unpriced listings out of carts), so
      // the guide's total (which counts a missing price as $0) agrees.
      expect(sec!.head).toContain(`${g.rows.length} cards, $${g.total.toFixed(2)} before tax`);
      const cart = read("docs/buy-list.md").match(new RegExp(`\\[Fill the cart\\]\\((https://${new URL(g.store.homepage!).host}/cart/[^)]+)\\)`))?.[1];
      expect(new Set(g.cartUrl!.split("/cart/")[1]!.split(","))).toEqual(new Set(cart!.split("/cart/")[1]!.split(",")));
    }
    expect(md.filter((s) => s.rows.length && / cards, \$/.test(s.head))).toHaveLength(list.stores.length);
    // Every real listing with a variant has a price, so nothing waits in "In stock, no listed price".
    expect(list.noPrice).toEqual([]);
    const elsewhere = md.find((s) => s.head.startsWith("Not in stock at") || s.head.startsWith("Unavailable or outside the shopping rules"))!;
    expect(list.elsewhere.map((r) => [r.swap.in, deckName(r.swap.deck)]).sort()).toEqual(elsewhere.rows.map((r) => [r[0], r[1]]).sort());
    // Price-rule flags use fixed synthetic listings in shop.test.ts. This live guide comparison
    // follows current stock; a card becoming unavailable must not require an old store quote.
  });

  it("spares match docs/spares.md (both follow library.build()), apart from the explained extras", () => {
    const sp = spares(b, answers);
    const md = mdSections(read("docs/spares.md"));
    const guide = (prefix: string) => new Set(md.find((s) => s.head.startsWith(prefix))!.rows.map((r) => `${r[0]} (${r[1]})`));
    const mine = (list: typeof sp.now) => new Set(list.map((s) => `${s.card} (${s.from.name})`));
    const gNow = guide("Out of a deck now");
    const gLater = guide("Will be spare once prints arrive");
    const yNow = mine([...sp.now, ...sp.extras]);
    const yLater = mine(sp.after);
    const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
    const report = {
      "Out now in Yama, later in the guide": diff(yNow, gNow).filter((x) => gLater.has(x)),
      "Later in Yama, out now in the guide": diff(yLater, gLater).filter((x) => gNow.has(x)),
      "Only in Yama (now)": diff(yNow, gNow).filter((x) => !gLater.has(x)),
      "Only in Yama (later)": diff(yLater, gLater).filter((x) => !gNow.has(x)),
      "Only in the guide (now)": diff(gNow, yNow).filter((x) => !yLater.has(x)),
      "Only in the guide (later)": diff(gLater, yLater).filter((x) => !yNow.has(x)),
      "Taken out before the plans (Yama only)": sp.before.map((s) => `${s.card} (${s.from.name})`),
    };
    console.log("Spares: Yama (library model) vs docs/spares.md\n" + JSON.stringify(report, null, 2));
    const all = [...sp.now, ...sp.after, ...sp.extras];
    const find = (label: string) => all.find((s) => `${s.card} (${s.from.name})` === label)!;
    // Since guide v7 spares.py reads library.build()'s now list too, so now and later agree card for
    // card. Nothing the guide lists is missing, and nothing is out now in one and later in the other.
    expect(report["Out now in Yama, later in the guide"]).toEqual([]);
    expect(report["Later in Yama, out now in the guide"]).toEqual([]);
    expect(report["Only in the guide (now)"]).toEqual([]);
    expect(report["Only in the guide (later)"]).toEqual([]);
    expect(report["Only in Yama (later)"]).toEqual([]);
    // The explained extras: Yama also lists a card bought for a deck with no slot (library.py keeps it
    // as a spare; the guide has no section for it), and the cards your own change took out before the plans.
    expect(report["Only in Yama (now)"]).toEqual(["Ride the Shoopuf (World Shaper)"]);
    for (const x of report["Only in Yama (now)"]) expect(find(x).when).toBe("extra");
    // "Now used in": the same decks as the guide, for every spare both list.
    const onOneCopy = new Set<string>();
    const guideUse = new Map(md.slice(0, 2).flatMap((sec) => sec.rows.map((r) => [`${r[0]} (${r[1]})`, r[3] ?? ""] as const)));
    for (const sp1 of all) {
      const g = guideUse.get(`${sp1.card} (${sp1.from.name})`);
      if (g == null) continue;
      const used = g.split(", ").filter((x) => x && !x.startsWith("proposed for")).sort();
      const proposed = [...g.matchAll(/proposed for ([^,(]+) \(not decided\)/g)].map((m) => m[1]!.trim())
        .filter((deck) => !guideOnlySpareAudits.has(pair(sp1.card, deck))).sort();
      expect(sp1.usedIn.map((u) => u.deck?.name).sort(), `${sp1.card} used in`).toEqual(used);
      // Deliberate difference: a proposal that names which deck's copy it uses (its `got`) marks only
      // that copy; the guide marks every copy with the name. Some copy always carries the mark.
      const mine = sp1.proposedFor.map((u) => u.deck?.name);
      for (const m of mine) expect(proposed, `${sp1.card} proposed for`).toContain(m);
      for (const deck of proposed.filter((x) => !mine.includes(x))) {
        expect(all.some((o) => o.card === sp1.card && o.proposedFor.some((u) => u.deck?.name === deck)), `${sp1.card}: some copy proposed for ${deck}`).toBe(true);
        onOneCopy.add(`${sp1.card} (${sp1.from.name}): proposed for ${deck} only on the copy the proposal names`);
      }
    }
    console.log("Proposal marks on one copy only:\n" + [...onOneCopy].join("\n"));
    // The two the critique named, now the same in both: a move that waits for the giving deck keeps
    // the card until prints arrive, and a fill takes the card out now.
    expect(gLater.has("Sepulchral Primordial (Revival Trance)")).toBe(true);
    expect(find("Sepulchral Primordial (Revival Trance)").why).toMatch(/moves in from Lorehold Spirit, once your prints arrive/);
    expect(gNow.has("Mount Doom (Riders of Rohan)")).toBe(true);
    expect(find("Mount Doom (Riders of Rohan)").why).toMatch(/^A basic land holds the slot until the Volcanic Island print arrives/);
    const sepulchral = sp.after.find((s) => s.card === "Sepulchral Primordial")!;
    expect(sepulchral.proposedFor.map((u) => u.deck?.name)).toContain("Multiverse Reforged");
    // Stand-ins leave when their prints arrive; a later cut is shown as a suggestion only.
    const standins = sp.after.filter((s) => s.standin);
    expect(standins.length).toBe(21);
    expect(standins.filter((s) => laterOutText(s)).length).toBe(19);
  });
});
