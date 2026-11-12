import { safeUrl, type ResearchDocument } from "../research/api";
import { parseDeckList } from "@yama/core";

export interface SourceUse { id: string; deck: string; deck_name: string; category: string; build_match?: boolean; brackets?: number[] }
export interface SourceOffer { store: string; price: number | null; qty: number | null; condition: string; url: string; variant_id: string; checked_at: string; quantity_checked_at?: string; qualifies: boolean; rule_reason?: string; non_price_eligible?: boolean; eligibility_unknown?: boolean; title?: string; finish?: string; language?: string; market?: number | null; market_source?: string; market_checked_at?: string; market_match?: string; printing_id?: string; foil_alternative?: boolean }
export interface SourceCard { name: string; status: string; uses: SourceUse[]; offers: SourceOffer[] }
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Additional research JSON is untrusted: malformed rows and unsafe links never become offers. */
function normalizeSourceCards(value: unknown): SourceCard[] {
  return list(value).flatMap(raw => {
    const c = obj(raw), name = str(c.name);
    if (!name) return [];
    const uses = list(c.uses).flatMap(rawUse => {
      const u = obj(rawUse), id = str(u.id), deck = str(u.deck);
      if (!id || !deck) return [];
      return [{ id, deck, deck_name: str(u.deck_name) || deck, category: str(u.category) }];
    });
    // Foil copies of a card with a plain version come separately; they shop only when preferred.
    const offers = [...list(c.offers ?? c.best_offer_per_store), ...list(c.foil_offer_per_store).map(o => ({ ...obj(o), foil_alternative: true }))].flatMap(rawOffer => {
      const o = obj(rawOffer), url = safeUrl(str(o.url));
      if (!url || !str(o.store)) return [];
      const qty = number(o.qty);
      return [{ store: str(o.store), price: number(o.price), qty: qty == null ? null : Math.floor(qty), condition: str(o.condition), url, variant_id: str(o.variant_id), checked_at: str(o.checked_at), quantity_checked_at: str(o.quantity_checked_at) || undefined, qualifies: o.qualifies === true, rule_reason: str(o.rule_reason), non_price_eligible: typeof o.non_price_eligible === "boolean" ? o.non_price_eligible : undefined, title: str(o.title), finish: str(o.finish), language: str(o.language), market: number(o.market), market_source: safeUrl(str(o.market_source)) ?? undefined, market_checked_at: str(obj(o.market_evidence).checked_at), market_match: str(obj(o.market_evidence).matching), printing_id: str(obj(o.market_evidence).scryfall_id), ...(o.foil_alternative === true ? { foil_alternative: true } : {}) }];
    });
    return [{ name, status: str(c.status), uses, offers }];
  });
}

/** Conflicting physical-copy identities are quarantined across the whole report. */
export function sourceSnapshot(value: unknown): { cards: SourceCard[]; conflicts: string[] } {
  const cards = normalizeSourceCards(value), registry = new Map<string, Set<string>>();
  for (const c of cards) for (const u of c.uses) {
    const signatures = registry.get(u.id) ?? new Set<string>();
    signatures.add(JSON.stringify([c.name,u.deck,u.category])); registry.set(u.id,signatures);
  }
  const conflicts = [...registry].filter(([,s]) => s.size > 1).map(([id]) => id), rejected = new Set(conflicts), seen = new Set<string>();
  return { conflicts, cards: cards.map(c => ({ ...c, uses: c.uses.filter(u => !rejected.has(u.id) && !seen.has(u.id) && seen.add(u.id)) })) };
}
export const sourceCards = (value: unknown): SourceCard[] => sourceSnapshot(value).cards;

export const optionalUse = (u: SourceUse) => /optional|proxy|selected500/.test(u.category);

/** A copy appears once in a deck's union of alternatives, and once for every distinct recipient. */
export function portfolioRows(cards: SourceCard[], doc: ResearchDocument, decks: Set<string>, bracket: string, scope: string): SourceCard[] {
  const names = new Map<string, Set<string>>();
  for (const d of doc.decks) {
    // Older source checks explicitly label cEDH but omit its numeric bracket metadata.
    const builds = d.builds.filter(b => !bracket || String(b.bracket ?? (/\bcEDH\b/i.test(b.label) ? 5 : null)) === bracket);
    names.set(d.key, new Set(builds.flatMap(b => parseDeckList(b.list).filter(l => l.board !== "side" && l.board !== "maybe").map(l => l.name.split(" // ")[0]!.trim().toLowerCase()))));
  }
  const bracketsFor = (deck: string, card: string) => doc.decks.find(d => d.key === deck)?.builds.filter(b => parseDeckList(b.list).some(l => l.board !== "side" && l.board !== "maybe" && l.name.split(" // ")[0]!.trim().toLowerCase() === card.split(" // ")[0]!.trim().toLowerCase())).map(b => b.bracket ?? (/\bcEDH\b/i.test(b.label) ? 5 : 0)).filter(b => b > 0) ?? [];
  const groups = new Map<string, SourceCard>();
  for (const c of cards) {
    const uses = c.uses.flatMap(u => {
      const inBuild = names.get(u.deck)?.has(c.name.split(" // ")[0]!.trim().toLowerCase()) ?? false;
      // Permanent real-card wishes and bonus reservations are explicitly outside some builds.
      // They remain optional wishes, never unresolved target demand.
      const standalone = !bracket && ["arrived proxy: optional real-card wishlist", "reserved selected500 bonus: optional real substitute"].includes(u.category);
      return decks.has(u.deck) && (inBuild || standalone) && (scope === "all" || (scope === "optional") === optionalUse(u)) ? [{ ...u, build_match: inBuild, brackets: [...new Set(bracketsFor(u.deck,c.name))].filter(b => !bracket || String(b) === bracket) }] : [];
    });
    if (!uses.length) continue;
    const row = groups.get(c.name) ?? { ...c, uses: [], offers: [] };
    const ids = new Set(row.uses.map(u => u.id));
    row.uses.push(...uses.filter(u => !ids.has(u.id) && ids.add(u.id)));
    const urls = new Set(row.offers.map(offerId));
    row.offers.push(...c.offers.filter(o => !urls.has(offerId(o)) && urls.add(offerId(o))));
    groups.set(c.name, row);
  }
  return [...groups.values()].sort((a,b) => a.name.localeCompare(b.name));
}

export const offerId = (o: SourceOffer): string => o.variant_id ? `${o.url}#variant=${encodeURIComponent(o.variant_id)}` : `${o.url}#details=${encodeURIComponent(JSON.stringify([o.title,o.printing_id,o.finish,o.condition,o.language,o.price]))}`;

export interface SourceChoice { offer: string; qty: number }
export const choicesFor = (choices: Record<string, SourceChoice[]>, name: string): SourceChoice[] => Object.hasOwn(choices,name) && Array.isArray(choices[name]) ? choices[name]! : [];
export interface SourceCart { store: string; url?: string; rows: { card: string; qty: number; offer: SourceOffer }[]; total: number }
/** Only visible portfolio demand counts. Card-name search and pagination do not change that demand. */
export function sourceCarts(rows: SourceCard[], choices: Record<string, SourceChoice[]>, cartTemplates: Map<string, string>): SourceCart[] {
  const carts = new Map<string, SourceCart>();
  const stockUsed = new Map<string, number>();
  for (const row of rows) {
    let remaining = row.uses.length;
    const seen = new Set<string>();
    for (const choice of choicesFor(choices,row.name)) {
      const matches = row.offers.filter(o => offerId(o) === choice.offer || o.url === choice.offer);
      const offer = matches.length === 1 ? matches[0] : undefined;
      if (!offer?.qualifies || offer.price == null || !Number.isFinite(choice.qty) || seen.has(offerId(offer))) continue;
      seen.add(offerId(offer));
      const origin = new URL(offer.url).origin;
      const sku = `${origin}|${offer.variant_id || offerId(offer)}`;
      const available = offer.qty == null ? Infinity : Math.max(0, offer.qty - (stockUsed.get(sku) ?? 0));
      const qty = Math.max(0, Math.min(Math.floor(choice.qty), remaining, available));
      if (!qty) continue;
      remaining -= qty; stockUsed.set(sku, (stockUsed.get(sku) ?? 0) + qty);
      const cart = carts.get(origin) ?? { store: offer.store, rows: [], total: 0 };
      cart.rows.push({ card: row.name, qty, offer }); cart.total += qty * offer.price;
      carts.set(origin, cart);
    }
  }
  for (const [origin, cart] of carts) {
    const variants = new Map<string, number>();
    const template = cartTemplates.get(origin);
    if (template?.startsWith("https://") && template.includes("{items}") && cart.rows.every(r => /^\d+$/.test(r.offer.variant_id))) {
      for (const r of cart.rows) variants.set(r.offer.variant_id, (variants.get(r.offer.variant_id) ?? 0) + r.qty);
      cart.url = safeUrl(template.replace("{items}", [...variants].map(([v,q]) => `${v}:${q}`).join(",")));
    }
  }
  return [...carts.values()];
}

/**
 * Copies per uncounted variant beyond the one its in-stock listing proves, summed over cart rows,
 * so URL aliases of one variant share that single confirmed copy.
 */
export function uncountedExtras(carts: SourceCart[]): { total: number; skus: Map<string, number> } {
  const skus = new Map<string, number>();
  for (const r of carts.flatMap(c => c.rows)) if (r.offer.qty == null) {
    const sku = uncountedSku(r.offer);
    skus.set(sku, (skus.get(sku) ?? 0) + r.qty);
  }
  return { total: [...skus.values()].reduce((n, q) => n + Math.max(0, q - 1), 0), skus };
}
export const uncountedSku = (o: SourceOffer) => `${new URL(o.url).origin}|${o.variant_id || offerId(o)}`;

/** A bulk preview only allocates known stock, cheapest qualifying variant first. */
export function knownStockChoices(rows: SourceCard[]): Record<string, SourceChoice[]> {
  const choices: Record<string, SourceChoice[]> = Object.create(null);
  for (const row of rows) {
    let remaining = row.uses.length;
    choices[row.name] = [];
    for (const o of [...row.offers].filter(o => o.qualifies && o.price != null && o.qty != null && o.qty > 0).sort((a,b) => Number(nearMint(b.condition))-Number(nearMint(a.condition)) || a.price! - b.price!)) {
      const qty = Math.min(remaining, o.qty!);
      if (qty) choices[row.name]!.push({ offer: offerId(o), qty });
      remaining -= qty;
    }
  }
  return choices;
}

/** Near Mint is the shopping default; missing condition never silently counts as NM. */
export const nearMint = (condition: string) => /^(nm|near[ -]?mint)(?:$|\s|\/)/i.test(condition.trim());
export function offerRows(rows: SourceCard[], condition: string, store: string, recordedStockOnly = false): SourceCard[] {
  return rows.map(c => ({...c, offers:c.offers.filter(o => (!store || o.store === store) && (condition !== "nm" || nearMint(o.condition)) && (!recordedStockOnly || (o.qty != null && o.qty > 0)))}));
}
/**
 * Bulk selection, cheapest qualifying printing first (Near Mint before others). A recorded count
 * caps a variant. A listing without a count was in stock when checked, which proves one copy, so it
 * supplies one; any more stay a manual request. This prepares a cart, not a stock claim.
 */
export function allChoices(rows: SourceCard[], preferFoil = false): Record<string, SourceChoice[]> {
  const choices: Record<string, SourceChoice[]> = Object.create(null);
  const stockUsed = new Map<string,number>();
  const limits = new Map<string,number>();
  const skuOf = (o: SourceOffer) => `${new URL(o.url).origin}|${o.variant_id || offerId(o)}`;
  for (const row of rows) for (const o of row.offers) if(o.qty != null && o.qty >= 0) {
    const sku = skuOf(o);
    limits.set(sku,Math.min(limits.get(sku) ?? o.qty,o.qty));
  }
  for (const row of rows) {
    let remaining = row.uses.length;
    choices[row.name] = [];
    for (const o of [...row.offers].filter(o => o.qualifies && o.price != null && o.qty !== 0).sort((a,b) => Number(nearMint(b.condition))-Number(nearMint(a.condition)) || (preferFoil ? Number(!!b.foil_alternative)-Number(!!a.foil_alternative) : 0) || a.price!-b.price! || Number(b.qty != null)-Number(a.qty != null))) {
      const sku = skuOf(o);
      const qty = Math.min(remaining,Math.max(0,(limits.get(sku) ?? o.qty ?? 1)-(stockUsed.get(sku) ?? 0)));
      stockUsed.set(sku,(stockUsed.get(sku) ?? 0)+qty);
      if(qty > 0) choices[row.name]!.push({offer:offerId(o),qty});
      remaining -= qty;
      if(!remaining)break;
    }
  }
  return choices;
}
