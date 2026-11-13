import { plural } from "@yama/core";
import { safeUrl } from "../research/api";
import { knownRestrictionsPass } from "./source-pricing";
import { offerId, type SourceCard, type SourceChoice, type SourceOffer } from "./sourcing-model";

/** One in-stock listing as the store's site gave it (server/src/plan/stock/live.rs). */
export interface LiveListing { title: string | null; set: string | null; finish: string | null; condition: string | null; language: string | null; price: number | null; variant: string | null; url: string | null }
/** A store's newest answer for one card: every listing in stock then, or none. */
export interface LiveAnswer { origin: string; card: string; checked_at: string; listings: LiveListing[] }
export interface LiveStore { key: string; name: string; origin: string; wanted: number; read: number; fresh: number; hurrying: number; oldest: string | null; newest: string | null; failed: number; error: string | null; /** Cards whose newest read gave no answer. */ failed_cards: string[] }
/** The card's cheapest non-foil printing in Yama's price data. */
export interface LiveMarket { usd: number; date: string; printing: string; source: string }
export interface LiveStock { at: string; reread_hours: number; offline: boolean; /** Whether the server is rereading stores at all. */ reading: boolean; /** Read-first requests the account has left today. */ hurry_left: number; stores: LiveStore[]; answers: LiveAnswer[]; markets: Record<string, LiveMarket>; unknown: string[]; hurried: number }

/** What the page holds between asks: each store's newest answer per card. */
export interface LiveState { at: string | null; reread_hours: number; reading: boolean; hurry_left: number; stores: LiveStore[]; answers: Map<string, LiveAnswer>; markets: Map<string, LiveMarket>; unknown: string[] }
export const emptyLive: LiveState = { at: null, reread_hours: 8, reading: false, hurry_left: 0, stores: [], answers: new Map(), markets: new Map(), unknown: [] };
const answerKey = (origin: string, card: string) => `${origin}\n${card}`;

/** An ask returns only what was read since the last one: add it to what is already held. */
export function mergeLive(state: LiveState, next: LiveStock): LiveState {
  const answers = new Map(state.answers), markets = new Map(state.markets);
  for (const a of next.answers) {
    const held = answers.get(answerKey(a.origin, a.card));
    if (!held || held.checked_at <= a.checked_at) answers.set(answerKey(a.origin, a.card), a);
  }
  for (const [card, market] of Object.entries(next.markets)) markets.set(card, market);
  return { at: next.at, reread_hours: next.reread_hours, reading: next.reading, hurry_left: next.hurry_left, stores: next.stores, answers, markets, unknown: next.unknown };
}

const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ""; } };
const pageOf = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
const foilWords = (text: string) => /\b(foil|etched)\b/i.test(text.replace(/non-?foil/gi, " "));
const savedFoil = (o: SourceOffer) => !!o.foil_alternative || foilWords(`${o.finish ?? ""} ${o.condition}`);

/**
 * The saved report with each store's newer answer in place of what the report saved for that
 * store and card. An answer is everything the store had in stock, so a saved listing it doesn't
 * repeat has sold out. A listing keeps the saved link and printing market of the variant (or the
 * same product page and finish) it matches, so a selection made earlier still points at it;
 * otherwise it is judged against the card's cheapest non-foil printing. A store with no answer
 * yet, or a saved quote newer than the answer, keeps the report's listings.
 */
export function liveRows(cards: SourceCard[], live: LiveState): SourceCard[] {
  if (!live.answers.size) return cards;
  return cards.map(c => {
    const answers = live.stores.flatMap(s => { const a = live.answers.get(answerKey(s.origin, c.name)); return a ? [{ store: s, answer: a }] : []; });
    if (!answers.length) return c;
    // A card the report offers in foil as a normal offer has no plain version.
    const foilOnly = c.offers.some(o => !o.foil_alternative && foilWords(`${o.finish ?? ""} ${o.condition}`));
    const market = live.markets.get(c.name);
    let offers = c.offers;
    for (const { store, answer } of answers) {
      const saved = offers.filter(o => originOf(o.url) === answer.origin);
      if (saved.some(o => o.checked_at > answer.checked_at)) continue;
      const read = answer.listings.flatMap((l): SourceOffer[] => {
        const url = safeUrl(l.url ?? "");
        if (!url || l.price == null || !Number.isFinite(l.price) || l.price < 0) return [];
        const foil = foilWords(`${l.finish ?? ""}`), variant = l.variant ?? "";
        const same = (variant ? saved.find(o => o.variant_id === variant) : undefined) ?? saved.find(o => pageOf(o.url) === pageOf(url) && savedFoil(o) === foil);
        const exact = variant && same?.variant_id === variant;
        const words = { title: l.title ?? "", condition: l.condition ?? "", finish: foil ? "foil" : "nonfoil", language: l.language ?? "English" };
        return [{
          ...words, store: store.name, price: l.price, qty: null, url: exact ? same!.url : url, variant_id: variant, checked_at: answer.checked_at, live: true,
          qualifies: false, non_price_eligible: knownRestrictionsPass(words, c.name, foil),
          market: same?.market ?? (same ? null : market?.usd ?? null),
          market_source: same?.market_source, market_checked_at: same ? same.market_checked_at : market?.date,
          market_match: same ? same.market_match : market ? "cheapest non-foil printing" : undefined, printing_id: same?.printing_id,
          ...(foil && !foilOnly ? { foil_alternative: true } : {}),
        }];
      });
      // A saved listing without a variant id gets a new selection id once the store names its
      // variant. When exactly one live listing is that product, finish and condition, it stands
      // in for the saved one, so a selection made earlier follows it instead of reading as sold out.
      const ids = new Set(read.map(offerId));
      for (const o of saved) {
        if (ids.has(offerId(o))) continue;
        const heirs = read.filter(l => pageOf(l.url) === pageOf(o.url) && foilWords(l.finish ?? "") === savedFoil(o) && l.condition.trim().toLowerCase() === o.condition.trim().toLowerCase());
        if (heirs.length === 1) heirs[0]!.replaces = [...(heirs[0]!.replaces ?? []), offerId(o)];
      }
      offers = [...offers.filter(o => !saved.includes(o)), ...read];
    }
    return { ...c, offers };
  });
}

/** A selection whose saved listing a live one now stands in for points at the live one. */
export function migrateChoices(choices: Record<string, SourceChoice[]>, cards: SourceCard[]): Record<string, SourceChoice[]> {
  const byName = new Map(cards.map(c => [c.name, c]));
  let moved = false;
  const next: Record<string, SourceChoice[]> = Object.create(null);
  for (const name of Object.keys(choices)) {
    const row = byName.get(name);
    let movedHere = false;
    const list = (choices[name] ?? []).map(choice => {
      if (!row || row.offers.some(o => offerId(o) === choice.offer || o.url === choice.offer)) return choice;
      const heirs = row.offers.filter(o => o.replaces?.includes(choice.offer));
      if (heirs.length !== 1) return choice;
      movedHere = true;
      return { ...choice, offer: offerId(heirs[0]!) };
    });
    if (!movedHere) { next[name] = list; continue; }
    moved = true;
    // A pick that moved may land on a listing with a pick of its own: they are one listing now,
    // so one entry holds the copies asked of both. A count set back to zero asks for nothing.
    const copies = new Map<string, number>();
    for (const choice of list) copies.set(choice.offer, (copies.get(choice.offer) ?? 0) + (Number.isFinite(choice.qty) ? Math.max(0, choice.qty) : 0));
    next[name] = [...copies].map(([offer, qty]) => ({ offer, qty }));
  }
  return moved ? next : choices;
}

/** How long a read counts as having checked a cart's card. The server rereads a cart's card older than half that. */
export const CART_CHECKED_MS = 60 * 60_000;
/**
 * A cart's listings at a store Yama rereads: which cards' newest read failed (however recent
 * their last answer), and how many other listings were not read within the hour.
 */
export function cartCheck(rows: { card: string; offer: SourceOffer }[], store: LiveStore, now: number): { waiting: number; failed: string[] } {
  const failed = [...new Set(rows.filter(r => store.failed_cards.includes(r.card)).map(r => r.card))].sort((a, b) => a.localeCompare(b));
  const waiting = rows.filter(r => !failed.includes(r.card) && !(r.offer.live && now - Date.parse(r.offer.checked_at) <= CART_CHECKED_MS)).length;
  return { waiting, failed };
}

/** What is happening to a cart's listings that were not read within the hour: only what is true. */
export function waitingText(waiting: number, store: LiveStore, live: Pick<LiveState, "reading" | "hurry_left" | "reread_hours">): string {
  const listings = plural(waiting, "listing"), were = waiting === 1 ? "was" : "were";
  if (!live.reading) return `${listings} here ${were} not read in the last hour, and this server is not rereading stores, so nothing newer is coming.`;
  if (!store.hurrying && live.hurry_left <= 0) return `${listings} here ${were} not read in the last hour. Today’s read-first requests are used up, so the store is reread on the regular round, about every ${live.reread_hours} hours.`;
  return `Rechecking ${listings} with the store before you open the cart. This page updates as each is read.`;
}

/** Cards in a selection whose chosen listing the stores no longer have. */
export function soldOut(cards: SourceCard[], choices: Record<string, { offer: string; qty: number }[]>): string[] {
  const byName = new Map(cards.map(c => [c.name, c]));
  return Object.keys(choices).filter(name => {
    const row = byName.get(name);
    return !!row && (choices[name] ?? []).some(choice => choice.qty > 0 && !row.offers.some(o => offerId(o) === choice.offer || o.url === choice.offer));
  }).sort((a, b) => a.localeCompare(b));
}

/** How far a store's reader has got, in a sentence. */
export function storeProgress(s: LiveStore, when: (at: string) => string): string {
  if (!s.wanted) return `${s.name}: no cards to read.`;
  if (!s.read) return `${s.name}: not read yet. ${s.wanted} cards are waiting their turn.`;
  const span = s.oldest && s.newest && s.oldest !== s.newest ? `the oldest ${when(s.oldest)}, the newest ${when(s.newest)}` : s.newest ? `${when(s.newest)}` : "";
  const waiting = s.wanted - s.read;
  return [
    `${s.name}: ${s.read} of ${s.wanted} cards read${span ? `, ${span}` : ""}.`,
    waiting > 0 ? `${waiting} still waiting for a first read.` : "",
    s.hurrying > 0 ? `Rechecking ${s.hurrying} in your carts first.` : "",
    s.failed > 0 ? `${s.failed} could not be read on the last try and will be tried again.` : "",
  ].filter(Boolean).join(" ");
}
