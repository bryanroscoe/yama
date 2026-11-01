//! The store trip (docs/shopping-design.md), for Claude's `shopping_trip` tool, and the route that
//! sets a store preference.
//!
//! The plan itself is a port of `packages/core/src/plan/trip.ts`, which the web page uses; it reads
//! the same bundle (`bundle::load_bundle`) and both are checked against
//! `packages/core/src/plan/fixtures/trip.json`, so keep them in step. A listing is a dated quote,
//! not a purchase; a missing price is unknown, never $0.

use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

// ── preferences ─────────────────────────────────────────────────────────────
// Set with `shopping.rs` (the route and Claude's staged change); read here from the bundle.

fn rank(p: &str) -> u8 {
    match p {
        "favorite" => 0,
        "maybe" => 2,
        "never" => 3,
        _ => 1,
    }
}

pub fn preference_text(p: &str) -> &'static str {
    match p {
        "favorite" => "their favourite, to support",
        "maybe" => "maybe, one trip",
        "never" => "they won't go",
        _ => "fine to go",
    }
}

/// The owner's level for a store (`trip.ts` `storePreference`): "ok" when unset; "default" is the
/// name a favourite had before migration 0051.
pub fn store_preference(b: &Value, key: &str) -> &'static str {
    match b["store_prefs"][key]["preference"].as_str() {
        Some("favorite" | "default") => "favorite",
        Some("maybe") => "maybe",
        Some("never") => "never",
        _ => "ok",
    }
}

/// How much more a card may cost at this store and still come from it (0 when unset).
pub fn store_premium(b: &Value, key: &str) -> f64 {
    if store_preference(b, key) != "favorite" {
        return 0.0; // a premium kept from when it was a favourite
    }
    b["store_prefs"][key].get("premium_usd").and_then(num).filter(|v| *v > 0.0).unwrap_or(0.0)
}

/// Every store's place in the owner's order of how easy it is to get to, from 1 (`trip.ts`
/// `hassleOrder`): the stores they numbered, by number, then the rest in store order.
pub fn hassle_order(b: &Value) -> HashMap<String, usize> {
    let h = |k: &str| b["store_prefs"][k].get("hassle").and_then(num).unwrap_or(f64::MAX);
    let mut all: Vec<&Value> = arr(b, "stores").iter().filter(|x| x["retired"] != true && s(x, "kind") != Some("printer")).collect();
    all.sort_by(|x, y| {
        let (kx, ky) = (s(x, "key").unwrap_or_default(), s(y, "key").unwrap_or_default());
        h(kx).partial_cmp(&h(ky)).unwrap_or(std::cmp::Ordering::Equal).then(sort_of(x).cmp(&sort_of(y))).then(kx.cmp(ky))
    });
    all.iter().enumerate().filter_map(|(i, x)| Some((s(x, "key")?.to_string(), i + 1))).collect()
}

// ── the buy rule ────────────────────────────────────────────────────────────

const EPS: f64 = 1e-9;

#[derive(Clone, Debug, PartialEq)]
pub struct LocalBuyRule {
    pub max_usd: Option<f64>,
    pub always_ok_usd: Option<f64>,
    /// (market under, max multiple); `None` market under means any market.
    pub tiers: Vec<(Option<f64>, f64)>,
}

#[derive(Debug)]
pub struct TripRule {
    pub rule: Option<LocalBuyRule>,
    pub from: Option<String>,
    pub derived: bool,
    pub text: String,
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// Dollars with cents; "no price" for a missing one.
fn usd(v: Option<f64>) -> String {
    v.map_or_else(|| "no price".into(), |x| format!("${x:.2}"))
}

fn times(x: f64) -> String {
    let t = format!("{x:.2}");
    let t = t.trim_end_matches('0').trim_end_matches('.');
    format!("{t}×")
}

/// The rule set in force on `date`: the newest that starts on or before it.
pub fn rules_at<'a>(settings: &'a [Value], date: &str) -> Option<&'a Value> {
    let mut sorted: Vec<&Value> = settings.iter().collect();
    sorted.sort_by(|a, b| s(a, "effective_from").cmp(&s(b, "effective_from")));
    sorted.into_iter().rev().find(|x| s(x, "effective_from").is_some_and(|f| f <= date))
}

pub fn local_buy_rule(set: Option<&Value>) -> TripRule {
    let Some(set) = set else {
        return TripRule { rule: None, from: None, derived: false, text: "No shopping rules are in force, so every listed price counts.".into() };
    };
    let from = s(set, "effective_from").map(String::from);
    let r = &set["rules"];
    if let Some(lb) = r.get("local_buy").filter(|v| v.is_object()) {
        let tiers = lb
            .get("tiers")
            .and_then(Value::as_array)
            .map(|ts| {
                ts.iter()
                    .filter_map(|t| {
                        let m = t.get("max_multiple").and_then(num).filter(|m| *m > 0.0)?;
                        Some((t.get("market_under").and_then(num), m))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rule = LocalBuyRule { max_usd: lb.get("max_usd").and_then(num), always_ok_usd: lb.get("always_ok_usd").and_then(num), tiers };
        let text = rule_text(&rule);
        return TripRule { rule: Some(rule), from, derived: false, text };
    }
    let max = ["ceiling_other_usd", "ceiling_key_usd", "always_print_over_usd"].iter().find_map(|k| r.get(*k).and_then(num));
    let tiers = r.get("max_over_market_pct").and_then(num).map(|p| vec![(None, 1.0 + p / 100.0)]).unwrap_or_default();
    let rule = LocalBuyRule { max_usd: max, always_ok_usd: None, tiers };
    let text = format!("{} (from your ceiling and limit over market; this rule set has no local buy rule)", rule_text(&rule));
    TripRule { rule: Some(rule), from, derived: true, text }
}

pub fn rule_text(rule: &LocalBuyRule) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(m) = rule.max_usd {
        parts.push(format!("at most {}", usd(Some(m))));
    }
    if let Some(a) = rule.always_ok_usd {
        parts.push(format!("{} or less whatever the market", usd(Some(a))));
    }
    let mut low = 0.0;
    for (under, mult) in &rule.tiers {
        let range = match under {
            None if low > 0.0 => format!(" when market is {} or more", usd(Some(low))),
            None => String::new(),
            Some(u) if low > 0.0 => format!(" when market is {} to {}", usd(Some(low)), usd(Some(*u))),
            Some(u) => format!(" when market is under {}", usd(Some(*u))),
        };
        parts.push(format!("at most {} market{range}", times(*mult)));
        if let Some(u) = under {
            low = *u;
        }
    }
    if let Some(top) = rule.tiers.last().and_then(|t| t.0) {
        parts.push(format!("nothing qualifies when market is {} or more", usd(Some(top))));
    }
    if !rule.tiers.is_empty() {
        parts.push(match rule.always_ok_usd {
            Some(a) => format!("an unknown market qualifies only at {} or less", usd(Some(a))),
            None => "an unknown market doesn't qualify".into(),
        });
    }
    if parts.is_empty() { "Every listed price counts.".into() } else { format!("Buy locally: {}.", parts.join("; ")) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    OverMax,
    OverMarket,
    NoMarket,
}

impl Verdict {
    fn reason(self) -> &'static str {
        match self {
            Verdict::Ok => "ok",
            Verdict::OverMax => "over-max",
            Verdict::OverMarket => "over-market",
            Verdict::NoMarket => "no-market",
        }
    }
}

pub fn judge(rule: Option<&LocalBuyRule>, price: f64, market: Option<f64>) -> Verdict {
    let Some(rule) = rule else { return Verdict::Ok };
    if rule.max_usd.is_some_and(|m| price > m + EPS) {
        return Verdict::OverMax;
    }
    if rule.always_ok_usd.is_some_and(|a| price <= a + EPS) {
        return Verdict::Ok;
    }
    if rule.tiers.is_empty() {
        return Verdict::Ok;
    }
    let Some(market) = market else { return Verdict::NoMarket };
    // Above every range the rule names: it doesn't qualify.
    let Some(tier) = rule.tiers.iter().find(|(u, _)| u.is_none_or(|u| market < u)) else { return Verdict::OverMarket };
    if price <= tier.1 * market + EPS { Verdict::Ok } else { Verdict::OverMarket }
}

// ── the plan ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Want {
    pub id: String,
    pub card: String,
    /// "plan", "proposal" or "wishlist".
    pub source: &'static str,
    pub needed: bool,
    pub deck_name: Option<String>,
    pub replaces: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Market {
    pub usd: f64,
    pub date: Option<String>,
    /// "printing", "cheapest" or "recorded".
    pub kind: &'static str,
    pub printing: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Offer<'a> {
    pub quote: &'a Value,
    pub store: &'a Value,
    pub preference: &'a str,
    pub price: f64,
    pub market: Option<Market>,
    pub verdict: Verdict,
}

impl Offer<'_> {
    fn key(&self) -> &str {
        s(self.store, "key").unwrap_or_default()
    }
}

#[derive(Debug)]
pub struct Row<'a> {
    pub want: Want,
    pub offer: Offer<'a>,
}

#[derive(Debug)]
pub struct Stop<'a> {
    pub store: &'a Value,
    pub preference: &'a str,
    pub rows: Vec<Row<'a>>,
    pub along: Vec<Row<'a>>,
    pub total: f64,
    pub along_total: f64,
    pub cart_url: Option<String>,
    pub no_cart_line: usize,
    /// On a TCGplayer Pro storefront (no cart link): (card, search link) for each needed card.
    pub search: Vec<(String, String)>,
}

#[derive(Debug)]
pub struct PrintRow<'a> {
    pub want: Want,
    pub reason: &'static str,
    pub offer: Option<Offer<'a>>,
    pub stores: Vec<String>,
}

#[derive(Debug)]
pub struct WishTier {
    pub label: &'static str,
    pub items: Vec<(Want, Option<Market>)>,
    pub market: Option<f64>,
}

#[derive(Debug)]
pub struct Trip<'a> {
    pub today: String,
    pub rule: TripRule,
    pub stops: Vec<Stop<'a>>,
    pub needed: usize,
    pub covered: usize,
    pub total: Option<f64>,
    pub alternatives: Vec<(Vec<String>, usize, f64)>,
    /// Store names by key, for the alternatives (a smaller set can use a store the trip doesn't).
    pub names: HashMap<String, String>,
    pub print: Vec<PrintRow<'a>>,
    /// The cards to print as a TCGplayer Mass Entry link (None: none, or too long).
    pub print_mass_entry: Option<String>,
    pub elsewhere: Vec<(&'a Value, Vec<Row<'a>>)>,
    /// Stores off this trip with needed cards under the rule: their preference, how many cards,
    /// and why ("never", "not-local", "left-out").
    pub skipped: Vec<(&'a Value, &'a str, usize, &'static str)>,
    /// The stores they said they're going to this time; None: every store they'll go to.
    pub going: Option<Vec<String>>,
    pub checked_on: Vec<String>,
    pub wishlist: Vec<WishTier>,
}

const MAX_SEARCH: usize = 12;

fn norm(x: &str) -> String {
    x.trim().to_lowercase()
}

fn cents(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn arr<'a>(b: &'a Value, k: &str) -> &'a [Value] {
    b.get(k).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn obj<'a>(b: &'a Value, k: &str) -> Option<&'a Map<String, Value>> {
    b.get(k).and_then(Value::as_object)
}

/// Follow aliases to a live key, at most ten hops (`text.ts` `resolveKey`).
fn resolve<'a>(key: &'a str, live: &HashSet<&str>, aliases: Option<&'a Map<String, Value>>) -> Option<&'a str> {
    let mut k = key;
    for _ in 0..=10 {
        if live.contains(k) {
            return Some(k);
        }
        k = aliases?.get(k)?.as_str()?;
    }
    None
}

/// Each live swap's answer (`text.ts` `answerIndex`): the latest by time, an import losing a tie.
fn answers<'a>(b: &'a Value, live: &HashSet<&str>) -> HashMap<String, &'a Value> {
    let mut latest: HashMap<String, &Value> = HashMap::new();
    for (key, r) in obj(b, "reviews").into_iter().flatten() {
        let Some(to) = resolve(key, live, obj(b, "aliases")) else { continue };
        let at = s(r, "at").unwrap_or_default();
        let replace = match latest.get(to) {
            None => true,
            Some(p) => {
                let pat = s(p, "at").unwrap_or_default();
                at > pat || (at == pat && s(r, "origin") == Some("yama"))
            }
        };
        if replace {
            latest.insert(to.to_string(), r);
        }
    }
    let text = |r: &Value, k: &str| s(r, k).is_some_and(|t| !t.is_empty());
    latest.retain(|_, r| text(r, "decision") || s(r, "note").is_some_and(|n| !n.trim().is_empty()) || text(r, "cut"));
    latest
}

/// Live swaps with a set "bought it" mark (`marks.ts` `markIndex`, the newer mark winning).
fn bought(b: &Value, live: &HashSet<&str>) -> HashSet<String> {
    let mut best: HashMap<String, &Value> = HashMap::new();
    for (key, pair) in obj(b, "marks").into_iter().flatten() {
        let Some(m) = pair.get("bought").filter(|m| m.is_object()) else { continue };
        let Some(to) = resolve(key, live, obj(b, "aliases")) else { continue };
        let wins = match best.get(to) {
            None => true,
            Some(cur) => {
                let (a, c) = (s(m, "at").unwrap_or_default(), s(cur, "at").unwrap_or_default());
                if a != c { a > c } else { s(m, "op_id").unwrap_or_default() > s(cur, "op_id").unwrap_or_default() }
            }
        };
        if wins {
            best.insert(to.to_string(), m);
        }
    }
    best.into_iter().filter(|(_, m)| m.get("value").and_then(Value::as_bool) == Some(true)).map(|(k, _)| k).collect()
}

fn wants(b: &Value, answers: &HashMap<String, &Value>, bought: &HashSet<String>) -> Vec<Want> {
    let decks: HashMap<&str, &Value> = arr(b, "decks").iter().filter_map(|d| Some((s(d, "key")?, d))).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for sw in arr(b, "swaps") {
        if sw["retired"] == true || s(sw, "src") != Some("buy") {
            continue;
        }
        let Some(deck) = s(sw, "deck").and_then(|k| decks.get(k)) else { continue };
        if s(deck, "status") == Some("archived") {
            continue;
        }
        let key = s(sw, "key").unwrap_or_default();
        let planned = s(sw, "stage") == Some("planned");
        if (planned && !sw["order_item"].is_null()) || bought.contains(key) {
            continue;
        }
        let answer = answers.get(key);
        let decision = answer.and_then(|a| s(a, "decision"));
        if !planned && decision == Some("no") {
            continue;
        }
        let card = s(sw, "in").unwrap_or_default().to_string();
        let cut = answer.and_then(|a| s(a, "cut")).filter(|c| !c.is_empty());
        out.push(Want {
            id: key.to_string(),
            card: card.clone(),
            source: if planned { "plan" } else { "proposal" },
            needed: planned || decision == Some("want"),
            deck_name: s(deck, "name").map(String::from),
            replaces: cut.or_else(|| s(sw, "out").filter(|o| !o.is_empty())).map(String::from),
        });
        seen.insert(norm(&card));
    }
    for w in arr(b, "wishlist") {
        let Some(card) = s(w, "card") else { continue };
        if !seen.insert(norm(card)) {
            continue;
        }
        out.push(Want { id: format!("wish:{card}"), card: card.to_string(), source: "wishlist", needed: false, deck_name: None, replaces: None });
    }
    out
}

fn printing_market(q: &Value, b: &Value) -> Option<Market> {
    let id = s(q, "scryfall_id").filter(|x| !x.is_empty()).map(String::from).or_else(|| {
        let (set, n) = (s(q, "set").filter(|x| !x.is_empty())?, s(q, "num").filter(|x| !x.is_empty())?);
        s(&b["printing_ids"], &format!("{}/{n}", set.to_lowercase())).map(String::from)
    })?;
    let m = b["market_by_printing"].get(&id)?;
    let v = m.get("usd").and_then(num)?;
    Some(Market {
        usd: v,
        date: s(m, "date").map(String::from),
        kind: "printing",
        printing: Some(format!("{} #{}", s(m, "set").unwrap_or_default().to_uppercase(), s(m, "num").unwrap_or_default())),
    })
}

fn cheapest_market(card: &str, b: &Value) -> Option<Market> {
    let id = s(&b["names"], card.trim())?;
    let m = b["market"].get(id).filter(|m| m.is_object())?;
    Some(Market { usd: m.get("usd").and_then(num)?, date: s(m, "date").map(String::from), kind: "cheapest", printing: s(m, "printing").map(String::from) })
}

fn recorded_market(quotes: &[&Value]) -> Option<Market> {
    let q = quotes
        .iter()
        .filter(|q| s(q, "kind") == Some("market_benchmark") && q.get("price").and_then(num).is_some())
        .filter(|q| s(q, "currency").is_none_or(|c| c.eq_ignore_ascii_case("USD")))
        .max_by(|a, b| s(a, "checked").cmp(&s(b, "checked")))?;
    Some(Market { usd: q.get("price").and_then(num)?, date: s(q, "checked").map(String::from), kind: "recorded", printing: s(q, "printing").map(String::from) })
}

/// A foil or etched listing ("non-foil" doesn't count): the rule is for a plain copy.
pub fn foil_listing(text: Option<&str>) -> bool {
    let Some(t) = text else { return false };
    let t = t.to_lowercase().replace("non-foil", " ").replace("nonfoil", " ");
    t.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "foil" || w == "etched")
}

/// Each store's newest stock checks (`quotes.ts` `newestChecks`), in first-seen store order.
fn newest_checks<'a>(quotes: &[&'a Value]) -> Vec<&'a Value> {
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for q in quotes.iter().copied().filter(|q| s(q, "kind") == Some("stock_check")) {
        let k = s(q, "store").map_or_else(|| format!("label:{}", s(q, "store_label").unwrap_or_default()), String::from);
        match groups.iter_mut().find(|(g, _)| *g == k) {
            Some((_, list)) => list.push(q),
            None => groups.push((k, vec![q])),
        }
    }
    let mut out = Vec::new();
    for (_, list) in groups {
        let newest = list.iter().filter_map(|q| s(q, "checked")).max().unwrap_or_default().to_string();
        out.extend(list.into_iter().filter(|q| s(q, "checked") == Some(newest.as_str())));
    }
    out
}

fn sort_of(store: &Value) -> i64 {
    store.get("sort").and_then(Value::as_i64).unwrap_or(0)
}

fn cart_url(store: &Value, variants: &[&str]) -> Option<String> {
    let t = s(store, "cart_url_template")?;
    if !t.starts_with("https://") || !t.contains("{items}") || variants.is_empty() {
        return None;
    }
    let items: Vec<String> = variants.iter().map(|v| format!("{}:1", urlencoding(v))).collect();
    Some(t.replace("{items}", &items.join(",")))
}

/// Longest TCGplayer Mass Entry link built (`carts.ts` `MASS_ENTRY_MAX`); an 8.3 KB one was refused.
const MASS_ENTRY_MAX: usize = 7000;

fn front_face(card: &str) -> &str {
    card.split(" // ").next().unwrap_or(card).trim()
}

/// A TCGplayer Mass Entry link, "1 Name" a line (`carts.ts` `massEntryUrl`).
pub fn mass_entry_url(cards: &[&str]) -> Option<String> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for c in cards.iter().map(|c| front_face(c)) {
        match counts.iter_mut().find(|(n, _)| *n == c) {
            Some((_, k)) => *k += 1,
            None => counts.push((c, 1)),
        }
    }
    if counts.is_empty() {
        return None;
    }
    let lines: Vec<String> = counts.iter().map(|(c, n)| urlencoding(&format!("{n} {c}"))).collect();
    let url = format!("https://www.tcgplayer.com/massentry?productline=Magic&c={}", lines.join("||"));
    (url.len() <= MASS_ENTRY_MAX).then_some(url)
}

/// A card search on the store's TCGplayer Pro storefront, which has no cart link (`carts.ts`).
pub fn pro_search_url(store: &Value, card: &str) -> Option<String> {
    // The parsed host, as `carts.ts` reads `new URL(...).origin`: a path or query can't pose as one.
    let u = url::Url::parse(s(store, "homepage")?).ok()?;
    if u.scheme() != "https" || !u.host_str()?.ends_with(".tcgplayerpro.com") {
        return None;
    }
    let base = u.origin().ascii_serialization();
    Some(format!("{base}/search/products?q={}&productLineName={}&sort=price-asc", urlencoding(front_face(card)), urlencoding("Magic: The Gathering")))
}

/// `encodeURIComponent`.
fn urlencoding(v: &str) -> String {
    let mut out = String::new();
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Plan the trip from a bundle (`bundle::load_bundle`). `today` is YYYY-MM-DD; `going` is the
/// stores they're going to this time (None: every store they'll go to).
pub fn plan<'a>(b: &'a Value, today: &str, going: Option<&[String]>) -> Trip<'a> {
    let live: HashSet<&str> = arr(b, "swaps").iter().filter(|x| x["retired"] != true).filter_map(|x| s(x, "key")).collect();
    let answers = answers(b, &live);
    let bought = bought(b, &live);
    let set = rules_at(arr(b, "settings"), today);
    let rule = local_buy_rule(set);
    let local_only = set.is_some_and(|x| x["rules"]["buy_local_only"] == true);
    let wants = wants(b, &answers, &bought);
    let stores: Vec<&Value> = arr(b, "stores").iter().filter(|x| x["retired"] != true).collect();
    let store = |k: &str| stores.iter().copied().find(|x| s(x, "key") == Some(k));
    let pref = |k: &str| -> &'static str { store_preference(b, k) };
    let skip_why = |st: &Value| -> Option<&'static str> {
        let k = s(st, "key").unwrap_or_default();
        if pref(k) == "never" {
            Some("never")
        } else if local_only && s(st, "kind") != Some("local") {
            Some("not-local")
        } else if going.is_some_and(|g| !g.iter().any(|x| x == k)) {
            Some("left-out")
        } else {
            None
        }
    };
    let eligible = |st: &Value| skip_why(st).is_none();
    // A card goes to its cheapest copy after each store's premium, then the preferred store, then
    // the easier one to get to (`trip.ts` `compareOffers`).
    let hassle = hassle_order(b);
    let place = |k: &str| hassle.get(k).copied().unwrap_or(usize::MAX);
    let premium_cents = |o: &Offer| -> i64 { ((o.price - store_premium(b, o.key())) * 100.0).round().max(0.0) as i64 };

    let mut by_card: HashMap<String, Vec<&Value>> = HashMap::new();
    for q in arr(b, "quotes") {
        by_card.entry(norm(s(q, "card").unwrap_or_default())).or_default().push(q);
    }
    let mut checked = BTreeSet::new();
    let mut offers_of: HashMap<String, Vec<Offer>> = HashMap::new();
    let mut seen_of: HashMap<String, (usize, Vec<String>, Vec<String>)> = HashMap::new();
    for w in &wants {
        let quotes = by_card.get(&norm(&w.card)).cloned().unwrap_or_default();
        let latest = newest_checks(&quotes);
        // The stores to ask about it: in stock without a usable USD price, or stock not stated.
        let (mut checks, mut unpriced, mut unknown) = (0, Vec::<String>::new(), Vec::<String>::new());
        let mut offers = Vec::new();
        for q in latest {
            let Some(st) = s(q, "store").and_then(|k| store(k)) else { continue };
            if s(st, "kind") == Some("printer") {
                continue;
            }
            checks += 1;
            if let Some(c) = s(q, "checked") {
                checked.insert(c.to_string());
            }
            if q["in_stock"] == false {
                continue;
            }
            // A check that didn't say whether it's in stock isn't a reason to go: ask the store.
            if q["in_stock"] != true {
                let name = store_name(st).to_string();
                if !unknown.contains(&name) {
                    unknown.push(name);
                }
                continue;
            }
            // A price in another currency can't be judged by the USD rule or summed with dollars.
            let usd_price = s(q, "currency").is_none_or(|c| c.eq_ignore_ascii_case("USD"));
            let Some(price) = q.get("price").and_then(num).filter(|_| usd_price) else {
                let name = store_name(st).to_string();
                if !unpriced.contains(&name) {
                    unpriced.push(name);
                }
                continue;
            };
            if foil_listing(s(q, "result")) {
                continue;
            }
            let has_ref = s(q, "scryfall_id").is_some_and(|x| !x.is_empty()) || (s(q, "set").is_some_and(|x| !x.is_empty()) && s(q, "num").is_some_and(|x| !x.is_empty()));
            let market = has_ref.then(|| printing_market(q, b)).flatten().or_else(|| cheapest_market(&w.card, b)).or_else(|| recorded_market(&quotes));
            let verdict = judge(rule.rule.as_ref(), price, market.as_ref().map(|m| m.usd));
            offers.push(Offer { quote: q, store: st, preference: pref(s(st, "key").unwrap_or_default()), price, market, verdict });
        }
        offers.sort_by(|x, y| {
            premium_cents(x)
                .cmp(&premium_cents(y))
                .then(rank(x.preference).cmp(&rank(y.preference)))
                .then(place(x.key()).cmp(&place(y.key())))
                .then(sort_of(x.store).cmp(&sort_of(y.store)))
                .then(x.key().cmp(y.key()))
        });
        offers_of.insert(w.id.clone(), offers);
        seen_of.insert(w.id.clone(), (checks, unpriced, unknown));
    }

    let needed: Vec<&Want> = wants.iter().filter(|w| w.needed).collect();
    // A "maybe" store is only for needed cards no other store they'll go to has under the rule
    // (`trip.ts` `usable`).
    let elsewhere_too: HashSet<String> = needed
        .iter()
        .filter(|w| offers_of[&w.id].iter().any(|o| o.verdict == Verdict::Ok && eligible(o.store) && o.preference != "maybe"))
        .map(|w| w.id.clone())
        .collect();
    let usable = |w: &Want, o: &Offer| o.verdict == Verdict::Ok && !(o.preference == "maybe" && elsewhere_too.contains(&w.id));
    let ok_at = |w: &Want, keys: &HashSet<String>| -> Option<Offer<'a>> {
        offers_of[&w.id].iter().find(|o| usable(w, o) && keys.contains(o.key())).cloned()
    };
    let mut coverage: HashMap<String, HashSet<&str>> = HashMap::new();
    for w in &needed {
        for o in offers_of[&w.id].iter().filter(|o| usable(w, o) && eligible(o.store)) {
            coverage.entry(o.key().to_string()).or_default().insert(&w.id);
        }
    }
    let key_of = |x: &Value| s(x, "key").unwrap_or_default().to_string();
    let by_order = |x: &&Value, y: &&Value| sort_of(x).cmp(&sort_of(y)).then(key_of(x).cmp(&key_of(y)));
    let covering: Vec<&Value> = coverage.keys().filter_map(|k| store(k)).collect();
    let mut forced: Vec<&Value> = covering.iter().copied().filter(|x| pref(&key_of(x)) == "favorite").collect();
    forced.sort_by(by_order);
    let mut pool: Vec<&Value> = covering.iter().copied().filter(|x| pref(&key_of(x)) != "favorite").collect();
    pool.sort_by(|x, y| {
        coverage[&key_of(y)]
            .len()
            .cmp(&coverage[&key_of(x)].len())
            .then(rank(pref(&key_of(x))).cmp(&rank(pref(&key_of(y)))))
            .then(by_order(x, y))
    });
    // Up to 12 other stores are searched exhaustively; with more, a greedy cover of the cards the
    // favourites don't have picks the stores searched first, and a cover longer than 12 puts its
    // later stores on every trip (`trip.ts`).
    if pool.len() > MAX_SEARCH {
        let mut left: HashSet<&str> = pool.iter().flat_map(|x| coverage[&key_of(x)].iter().copied()).collect();
        for f in &forced {
            for id in &coverage[&key_of(f)] {
                left.remove(id);
            }
        }
        let mut rest = pool.clone();
        let mut cover: Vec<&Value> = Vec::new();
        while !left.is_empty() {
            let mut best: Option<(usize, usize)> = None;
            for (i, st) in rest.iter().enumerate() {
                let n = coverage[&key_of(st)].iter().filter(|id| left.contains(*id)).count();
                if n > best.map_or(0, |b| b.1) {
                    best = Some((i, n));
                }
            }
            let Some((i, _)) = best else { break };
            let st = rest.remove(i);
            for id in &coverage[&key_of(st)] {
                left.remove(id);
            }
            cover.push(st);
        }
        forced.extend(cover.split_off(MAX_SEARCH.min(cover.len())));
        cover.extend(rest);
        cover.truncate(MAX_SEARCH);
        pool = cover;
    }
    forced.sort_by(by_order);
    pool.sort_by(by_order);

    // (keys, covered, maybes, hassle, total), the best of each size; every subset has the favourites.
    type Choice = (Vec<String>, usize, usize, usize, f64);
    let better = |a: &Choice, c: &Choice| -> bool {
        if a.1 != c.1 {
            a.1 > c.1
        } else if a.2 != c.2 {
            a.2 < c.2
        } else if a.3 != c.3 {
            a.3 < c.3
        } else if (a.4 - c.4).abs() > EPS {
            a.4 < c.4
        } else {
            a.0.join("|") < c.0.join("|")
        }
    };
    let mut best: HashMap<usize, Choice> = HashMap::new();
    for mask in (if forced.is_empty() { 1u32 } else { 0 })..(1u32 << pool.len()) {
        let mut picked: Vec<&Value> = forced.clone();
        picked.extend(pool.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, x)| *x));
        picked.sort_by(by_order);
        let keys: Vec<String> = picked.iter().map(|x| key_of(x)).collect();
        let set: HashSet<String> = keys.iter().cloned().collect();
        let (mut covered, mut total) = (0, 0.0);
        for w in &needed {
            if let Some(o) = ok_at(w, &set) {
                covered += 1;
                total += o.price;
            }
        }
        let maybes = keys.iter().filter(|k| pref(k) == "maybe").count();
        let ease = keys.iter().map(|k| place(k)).sum();
        let c: Choice = (keys, covered, maybes, ease, cents(total));
        let n = c.0.len();
        if best.get(&n).is_none_or(|cur| better(&c, cur)) {
            best.insert(n, c);
        }
    }
    let mut sizes: Vec<usize> = best.keys().copied().collect();
    sizes.sort_unstable();
    let most = best.values().map(|c| c.1).max().unwrap_or(0);
    let mut alternatives = Vec::new();
    let mut last: i64 = -1;
    for n in sizes {
        let c = &best[&n];
        if (c.1 as i64) <= last {
            continue;
        }
        alternatives.push((c.0.clone(), c.1, c.4));
        last = c.1 as i64;
        if c.1 == most {
            break;
        }
    }
    let chosen: HashSet<String> = alternatives.last().map(|a| a.0.iter().cloned().collect()).unwrap_or_default();

    let mut rows_of: HashMap<String, (Vec<Row>, Vec<Row>)> = chosen.iter().map(|k| (k.clone(), (vec![], vec![]))).collect();
    let mut print = Vec::new();
    let mut elsewhere: Vec<(String, Vec<Row>)> = Vec::new();
    for w in &wants {
        let offers = &offers_of[&w.id];
        if let Some(here) = ok_at(w, &chosen) {
            let slot = rows_of.get_mut(here.key()).unwrap();
            let row = Row { want: w.clone(), offer: here };
            if w.needed { slot.0.push(row) } else { slot.1.push(row) }
            continue;
        }
        if !w.needed {
            if let Some(there) = offers.iter().find(|o| o.verdict == Verdict::Ok && eligible(o.store)) {
                let k = there.key().to_string();
                let row = Row { want: w.clone(), offer: there.clone() };
                match elsewhere.iter_mut().find(|(g, _)| *g == k) {
                    Some((_, rows)) => rows.push(row),
                    None => elsewhere.push((k, vec![row])),
                }
            }
            continue;
        }
        // Off this trip: first the stores they left off today, then ones that aren't local when the
        // rule says buy local, then ones they won't go to (`trip.ts`).
        let off: Vec<&Offer> = offers.iter().filter(|o| o.verdict == Verdict::Ok && !eligible(o.store)).collect();
        let why = ["left-out", "not-local", "never"].into_iter().find(|r| off.iter().any(|o| skip_why(o.store) == Some(*r)));
        let banned: Vec<&Offer> = off.iter().copied().filter(|o| why.is_some() && skip_why(o.store) == why).collect();
        let reason = match why {
            Some("left-out") => "left-out",
            Some("not-local") => "not-local",
            _ => "never-store",
        };
        let first = |v: Verdict| offers.iter().find(|o| o.verdict == v && eligible(o.store)).cloned();
        let (checks, unpriced, unknown) = seen_of[&w.id].clone();
        let row = if let Some(o) = banned.first() {
            let mut names: Vec<String> = Vec::new();
            for x in &banned {
                let n = s(x.store, "name").unwrap_or_default().to_string();
                if !names.contains(&n) {
                    names.push(n);
                }
            }
            PrintRow { want: w.clone(), reason, offer: Some((*o).clone()), stores: names }
        } else if let Some(o) = first(Verdict::OverMax).or_else(|| first(Verdict::OverMarket)).or_else(|| first(Verdict::NoMarket)) {
            PrintRow { want: w.clone(), reason: o.verdict.reason(), offer: Some(o), stores: vec![] }
        } else if !unpriced.is_empty() {
            PrintRow { want: w.clone(), reason: "no-price", offer: None, stores: unpriced }
        } else if !unknown.is_empty() {
            PrintRow { want: w.clone(), reason: "unknown-stock", offer: None, stores: unknown }
        } else {
            PrintRow { want: w.clone(), reason: if checks > 0 { "not-stocked" } else { "no-check" }, offer: None, stores: vec![] }
        };
        print.push(row);
    }

    let by_card = |x: &Row, y: &Row| x.want.deck_name.as_deref().unwrap_or("").cmp(y.want.deck_name.as_deref().unwrap_or("")).then(x.want.card.cmp(&y.want.card));
    let mut chosen_stores: Vec<&Value> = chosen.iter().filter_map(|k| store(k)).collect();
    chosen_stores.sort_by(|x, y| rank(pref(&key_of(x))).cmp(&rank(pref(&key_of(y)))).then(place(&key_of(x)).cmp(&place(&key_of(y)))).then(by_order(x, y)));
    let stops: Vec<Stop> = chosen_stores
        .into_iter()
        .map(|st| {
            let (mut rows, mut along) = rows_of.remove(&key_of(st)).unwrap_or_default();
            rows.sort_by(by_card);
            along.sort_by(by_card);
            let lines: Vec<&str> = rows.iter().filter_map(|r| s(r.offer.quote, "variant").filter(|v| !v.is_empty())).collect();
            Stop {
                store: st,
                preference: pref(&key_of(st)),
                total: cents(rows.iter().map(|r| r.offer.price).sum()),
                along_total: cents(along.iter().map(|r| r.offer.price).sum()),
                cart_url: cart_url(st, &lines),
                no_cart_line: rows.len() - lines.len(),
                search: rows.iter().filter_map(|r| Some((r.want.card.clone(), pro_search_url(st, &r.want.card)?))).collect(),
                rows,
                along,
            }
        })
        .collect();
    let covered: usize = stops.iter().map(|x| x.rows.len()).sum();
    print.sort_by(|x, y| x.want.deck_name.as_deref().unwrap_or("").cmp(y.want.deck_name.as_deref().unwrap_or("")).then(x.want.card.cmp(&y.want.card)));

    let mut skipped: Vec<(&Value, &str, usize, &'static str)> = stores
        .iter()
        .copied()
        .filter(|st| s(st, "kind") != Some("printer"))
        .filter_map(|st| {
            let why = skip_why(st)?;
            let n = needed.iter().filter(|w| offers_of[&w.id].iter().any(|o| o.verdict == Verdict::Ok && o.key() == key_of(st))).count();
            Some((st, pref(&key_of(st)), n, why))
        })
        .filter(|x| x.2 > 0)
        .collect();
    skipped.sort_by(|x, y| sort_of(x.0).cmp(&sort_of(y.0)).then(key_of(x.0).cmp(&key_of(y.0))));
    let mut elsewhere: Vec<(&Value, Vec<Row>)> = elsewhere
        .into_iter()
        .filter_map(|(k, mut rows)| {
            rows.sort_by(by_card);
            Some((store(&k)?, rows))
        })
        .collect();
    elsewhere.sort_by(|x, y| sort_of(x.0).cmp(&sort_of(y.0)).then(key_of(x.0).cmp(&key_of(y.0))));
    let total = (covered > 0).then(|| cents(stops.iter().map(|x| x.total).sum()));
    // Every wishlist card once, also those the plan buys or proposes now (`trip.ts` `wishWants`).
    let mut seen_wish = HashSet::new();
    let wish_wants: Vec<Want> = arr(b, "wishlist")
        .iter()
        .filter_map(|w| s(w, "card"))
        .filter(|c| seen_wish.insert(norm(c)))
        .map(|c| Want { id: format!("wish:{c}"), card: c.to_string(), source: "wishlist", needed: false, deck_name: None, replaces: None })
        .collect();
    let wishlist = wish_tiers(wish_wants, b);
    Trip {
        today: today.to_string(),
        rule,
        stops,
        needed: needed.len(),
        covered,
        total,
        alternatives,
        names: stores.iter().filter_map(|x| Some((s(x, "key")?.to_string(), store_name(x).to_string()))).collect(),
        print_mass_entry: mass_entry_url(&print.iter().map(|p| p.want.card.as_str()).collect::<Vec<_>>()),
        print,
        elsewhere,
        skipped,
        going: going.map(<[String]>::to_vec),
        checked_on: checked.into_iter().collect(),
        wishlist,
    }
}

const WISH_TIERS: [(&str, f64); 5] = [("$200 and up", 200.0), ("$50 to $200", 50.0), ("$10 to $50", 10.0), ("$2 to $10", 2.0), ("Under $2", 0.0)];

fn wish_tiers(wants: Vec<Want>, b: &Value) -> Vec<WishTier> {
    let mut tiers: Vec<WishTier> = WISH_TIERS.iter().map(|(l, _)| WishTier { label: l, items: vec![], market: None }).collect();
    tiers.push(WishTier { label: "No market price", items: vec![], market: None });
    for w in wants {
        let m = cheapest_market(&w.card, b);
        let i = m.as_ref().map_or(WISH_TIERS.len(), |m| WISH_TIERS.iter().position(|(_, min)| m.usd >= *min).unwrap_or(WISH_TIERS.len()));
        tiers[i].items.push((w, m));
    }
    for t in &mut tiers {
        t.items.sort_by(|x, y| {
            let (a, c) = (x.1.as_ref().map_or(-1.0, |m| m.usd), y.1.as_ref().map_or(-1.0, |m| m.usd));
            c.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal).then(x.0.card.cmp(&y.0.card))
        });
        let known: Vec<f64> = t.items.iter().filter_map(|x| x.1.as_ref().map(|m| m.usd)).collect();
        t.market = (!known.is_empty()).then(|| cents(known.iter().sum()));
    }
    tiers.into_iter().filter(|t| !t.items.is_empty()).collect()
}

/// The compact form `trip.ts` `tripSummary` gives, for the shared fixture.
pub fn summary(t: &Trip) -> Value {
    let rows = |rs: &[Row]| rs.iter().map(|r| json!([r.want.card, r.offer.price])).collect::<Vec<_>>();
    json!({
        "rule_from": t.rule.from, "derived": t.rule.derived,
        "stops": t.stops.iter().map(|x| json!({"store": s(x.store, "key"), "rows": rows(&x.rows), "along": rows(&x.along), "total": x.total})).collect::<Vec<_>>(),
        "needed": t.needed, "covered": t.covered, "total": t.total,
        "alternatives": t.alternatives.iter().map(|a| json!([a.0, a.1, a.2])).collect::<Vec<_>>(),
        "print": t.print.iter().map(|p| json!([p.want.card, p.reason])).collect::<Vec<_>>(),
        "print_mass_entry": t.print_mass_entry,
        "search": t.stops.iter().map(|x| x.search.iter().map(|(_, u)| u.clone()).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "elsewhere": t.elsewhere.iter().map(|(st, rs)| json!([s(st, "key"), rs.iter().map(|r| r.want.card.clone()).collect::<Vec<_>>()])).collect::<Vec<_>>(),
        "skipped": t.skipped.iter().map(|(st, _, n, why)| json!([s(st, "key"), n, why])).collect::<Vec<_>>(),
        "wishlist": t.wishlist.iter().map(|w| json!([w.label, w.items.iter().map(|i| i.0.card.clone()).collect::<Vec<_>>()])).collect::<Vec<_>>(),
    })
}

// ── words, for Claude ───────────────────────────────────────────────────────

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn date(d: &str) -> String {
    let p: Vec<&str> = d.get(..10).unwrap_or(d).split('-').collect();
    match (p.first(), p.get(1).and_then(|m| m.parse::<usize>().ok()), p.get(2).and_then(|x| x.parse::<u32>().ok())) {
        (Some(y), Some(m), Some(day)) if (1..=12).contains(&m) => format!("{day} {} {y}", MONTHS[m - 1]),
        _ => d.to_string(),
    }
}

fn market_words(m: &Option<Market>) -> String {
    match m {
        None => "market unknown".into(),
        Some(m) => {
            let what = match m.kind {
                "printing" => "that printing",
                "cheapest" => "cheapest non-foil",
                _ => "recorded benchmark",
            };
            let printing = m.printing.as_deref().map(|p| format!(", {p}")).unwrap_or_default();
            format!("market {} ({what}{printing}{})", usd(Some(m.usd)), m.date.as_deref().map(|d| format!(", {}", date(d))).unwrap_or_default())
        }
    }
}

fn store_name(st: &Value) -> &str {
    s(st, "name").unwrap_or_default()
}

fn row_line(r: &Row) -> String {
    let what = match r.want.source {
        "wishlist" => " (real-card wishlist)".to_string(),
        "proposal" if !r.want.needed => format!(" (proposal for {}, not decided)", r.want.deck_name.as_deref().unwrap_or("?")),
        _ => format!(" for {}", r.want.deck_name.as_deref().unwrap_or("?")),
    };
    let replaces = r.want.replaces.as_deref().map(|x| format!(", replacing {x}")).unwrap_or_default();
    let listing = s(r.offer.quote, "result").filter(|x| !x.is_empty()).map(|x| format!(", \"{x}\"")).unwrap_or_default();
    format!(
        "- {}{what}{replaces}: {}, checked {}{listing}; {}",
        r.want.card,
        usd(Some(r.offer.price)),
        date(s(r.offer.quote, "checked").unwrap_or_default()),
        market_words(&r.offer.market)
    )
}

/// The trip in words, for the `shopping_trip` tool.
pub fn text(t: &Trip) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Store trip, planned {}.", date(&t.today));
    if let Some(g) = &t.going {
        let names: Vec<&str> = g.iter().map(|k| t.names.get(k).map_or(k.as_str(), String::as_str)).collect();
        let _ = writeln!(out, "Going this time: {}.", if names.is_empty() { "no stores".to_string() } else { names.join(", ") });
    }
    let _ = writeln!(
        out,
        "Rule{}: {}",
        t.rule.from.as_deref().map(|f| format!(" (your rule set from {})", date(f))).unwrap_or_default(),
        t.rule.text
    );
    match (t.checked_on.first(), t.checked_on.last()) {
        (Some(a), Some(z)) if a == z => {
            let _ = writeln!(out, "Store listings checked {}.", date(a));
        }
        (Some(a), Some(z)) => {
            let _ = writeln!(out, "Store listings checked {} to {}.", date(a), date(z));
        }
        _ => out.push_str("No store stock checks in the plan.\n"),
    }
    out.push_str(
        "A listing is a dated quote, not a purchase or a promise the card is still there; recheck before going. Prices are before tax. \
         Needed cards are planned buys with no order yet and proposals they said they want; undecided proposals and the real-card wishlist only come along from stores already on the trip.\n",
    );
    let _ = writeln!(
        out,
        "\nNeeded: {} cards. {} covered by {} store{}, {} before tax.",
        t.needed,
        t.covered,
        t.stops.len(),
        if t.stops.len() == 1 { "" } else { "s" },
        usd(t.total)
    );
    for (i, st) in t.stops.iter().enumerate() {
        let loc = s(st.store, "location").map(|l| format!(", {l}")).unwrap_or_default();
        let _ = writeln!(
            out,
            "\n{}. {} ({}{loc}): {} card{}, {}",
            i + 1,
            store_name(st.store),
            preference_text(st.preference),
            st.rows.len(),
            if st.rows.len() == 1 { "" } else { "s" },
            usd(Some(st.total))
        );
        if let Some(u) = &st.cart_url {
            let _ = writeln!(out, "Cart link (fills that store's cart with these; check it before paying): {u}");
        }
        if !st.search.is_empty() {
            out.push_str("No cart link on this store's site; a search for each card:\n");
            for (card, url) in &st.search {
                let _ = writeln!(out, "  {card}: {url}");
            }
        } else if st.no_cart_line > 0 {
            let _ = writeln!(out, "{} without a cart line: ask at the counter.", st.no_cart_line);
        }
        for r in &st.rows {
            let _ = writeln!(out, "{}", row_line(r));
        }
        if !st.along.is_empty() {
            let _ = writeln!(out, "Also here under the rule, if wanted ({}):", usd(Some(st.along_total)));
            for r in &st.along {
                let _ = writeln!(out, "{}", row_line(r));
            }
        }
    }
    if t.alternatives.len() > 1 {
        out.push_str("\nWith fewer stores:\n");
        for (keys, covered, total) in &t.alternatives[..t.alternatives.len() - 1] {
            let names: Vec<&str> = keys.iter().map(|k| t.names.get(k).map_or(k.as_str(), String::as_str)).collect();
            let _ = writeln!(out, "- {}: {covered} cards, {}", names.join(" and "), usd(Some(*total)));
        }
    }
    if !t.print.is_empty() {
        let _ = writeln!(out, "\nNot covered ({}): print these, or check the stores by hand.", t.print.len());
        for p in &t.print {
            let at = p.offer.as_ref().map(|o| format!("{} at {}", usd(Some(o.price)), store_name(o.store))).unwrap_or_default();
            let why = match p.reason {
                "never-store" => format!("only at {}, where they won't go ({at})", p.stores.join(", ")),
                "not-local" => format!("only at {}, which isn't local, and their rule is to buy locally ({at})", p.stores.join(", ")),
                "left-out" => format!("only at {}, which they left off this trip ({at})", p.stores.join(", ")),
                "over-max" => format!("over the rule's limit ({at}): print it, and keep it on the real-card wishlist"),
                "over-market" => format!("above the rule for its market ({at}; {})", market_words(&p.offer.as_ref().and_then(|o| o.market.clone()))),
                "no-market" => format!("no market price to judge it by ({at})"),
                "no-price" => format!("in stock with no listed price at {}: ask the store", p.stores.join(", ")),
                "unknown-stock" => format!("listed at {}, but the check didn't say whether it's in stock: ask the store", p.stores.join(", ")),
                "not-stocked" => "not in stock at the last check".into(),
                _ => "no store check recorded".into(),
            };
            let _ = writeln!(out, "- {} for {}: {why}", p.want.card, p.want.deck_name.as_deref().unwrap_or("?"));
        }
        if let Some(u) = &t.print_mass_entry {
            let _ = writeln!(out, "To compare online prices for these, TCGplayer Mass Entry: {u}");
        }
    }
    for (st, _, n, why) in &t.skipped {
        let why = match *why {
            "never" => "they won't go",
            "left-out" => "left off this trip",
            _ => "not a local store, and their rule is to buy locally",
        };
        let _ = writeln!(out, "\nSkipped: {} ({why}) has {n} needed card{} under the rule.", store_name(st), if *n == 1 { "" } else { "s" });
    }
    if !t.elsewhere.is_empty() {
        out.push_str("\nOnly at stores not on this trip (undecided proposals and wishlist):\n");
        for (st, rows) in &t.elsewhere {
            let cards: Vec<String> = rows.iter().map(|r| format!("{} {}", r.want.card, usd(Some(r.offer.price)))).collect();
            let _ = writeln!(out, "- {}: {}", store_name(st), cards.join(", "));
        }
    }
    if !t.wishlist.is_empty() {
        out.push_str("\nReal-card wishlist by cheapest non-foil market (a watchlist, not a purchase quantity):\n");
        for w in &t.wishlist {
            let cards: Vec<String> = w.items.iter().map(|(x, m)| m.as_ref().map_or_else(|| x.card.clone(), |m| format!("{} {}", x.card, usd(Some(m.usd))))).collect();
            let sum = w.market.map(|m| format!(", {} at market", usd(Some(m)))).unwrap_or_default();
            let _ = writeln!(out, "- {} ({}{sum}): {}", w.label, w.items.len(), cards.join("; "));
        }
    }
    out
}

#[cfg(test)]
mod tests;
