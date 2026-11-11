import { safeUrl, type ResearchDocument } from "../research/api";
import { parseDeckList } from "@yama/core";

export interface SourceUse { id: string; deck: string; deck_name: string; category: string; build_match?: boolean }
export interface SourceOffer { store: string; price: number | null; qty: number | null; condition: string; url: string; variant_id: string; checked_at: string; qualifies: boolean }
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
    const offers = list(c.best_offer_per_store).flatMap(rawOffer => {
      const o = obj(rawOffer), url = safeUrl(str(o.url));
      if (!url || !str(o.store)) return [];
      const qty = number(o.qty);
      return [{ store: str(o.store), price: number(o.price), qty: qty == null ? null : Math.floor(qty), condition: str(o.condition), url, variant_id: str(o.variant_id), checked_at: str(o.checked_at), qualifies: o.qualifies === true }];
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
    names.set(d.key, new Set(builds.flatMap(b => parseDeckList(b.list).filter(l => l.board !== "side").map(l => l.name.split(" // ")[0]!.trim().toLowerCase()))));
  }
  const groups = new Map<string, SourceCard>();
  for (const c of cards) {
    const uses = c.uses.flatMap(u => {
      const inBuild = names.get(u.deck)?.has(c.name.split(" // ")[0]!.trim().toLowerCase()) ?? false;
      // Permanent real-card wishes and bonus reservations are explicitly outside some builds.
      // They remain optional wishes, never unresolved target demand.
      const standalone = !bracket && ["arrived proxy: optional real-card wishlist", "reserved selected500 bonus: optional real substitute"].includes(u.category);
      return decks.has(u.deck) && (inBuild || standalone) && (scope === "all" || (scope === "optional") === optionalUse(u)) ? [{ ...u, build_match: inBuild }] : [];
    });
    if (!uses.length) continue;
    const row = groups.get(c.name) ?? { ...c, uses: [], offers: [] };
    const ids = new Set(row.uses.map(u => u.id));
    row.uses.push(...uses.filter(u => !ids.has(u.id) && ids.add(u.id)));
    const urls = new Set(row.offers.map(o => o.url));
    row.offers.push(...c.offers.filter(o => !urls.has(o.url) && urls.add(o.url)));
    groups.set(c.name, row);
  }
  return [...groups.values()].sort((a,b) => a.name.localeCompare(b.name));
}

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
      const offer = row.offers.find(o => o.url === choice.offer);
      if (!offer?.qualifies || offer.price == null || !Number.isFinite(choice.qty) || seen.has(offer.url)) continue;
      seen.add(offer.url);
      const origin = new URL(offer.url).origin;
      const sku = `${origin}|${offer.variant_id || offer.url}`;
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

/** A bulk preview only allocates known stock, cheapest qualifying variant first. */
export function knownStockChoices(rows: SourceCard[]): Record<string, SourceChoice[]> {
  const choices: Record<string, SourceChoice[]> = Object.create(null);
  for (const row of rows) {
    let remaining = row.uses.length;
    choices[row.name] = [];
    for (const o of [...row.offers].filter(o => o.qualifies && o.price != null && o.qty != null && o.qty > 0).sort((a,b) => a.price! - b.price!)) {
      const qty = Math.min(remaining, o.qty!);
      if (qty) choices[row.name]!.push({ offer: o.url, qty });
      remaining -= qty;
    }
  }
  return choices;
}
