//! Store stock snapshots (docs/shopping-design.md, "Stock snapshots" and "Store queries"): dated
//! reads of a store's listings, fetched by the server only when the person asks (the Trip page's
//! "Check stores", or a `check_stores` change they apply), or imported as a `yama-store-snapshot/1`
//! file. A listing is a dated quote, never a purchase or a promise the card is still there.
//!
//! Hosts come from a fixed connector per store, never from a URL a person types: a Shopify store on
//! the list below, a `<name>.tcgplayerpro.com` storefront, or YesTCG's Austin search. One request
//! at a time per host with a pause between, a cap per account per day, and every response kept
//! (gzipped, for the newest snapshots of each store) so a parse bug can be fixed without fetching
//! again.
//!
//! The bundle carries the listings for the cards the plan wants as `store_quotes`, quotes like the
//! plan's own stock checks: for each card and store, the newest snapshot that answered for it. A
//! card it asked about and didn't find is "not in stock" at that store; a card whose request failed
//! is unknown, not absent. The trip (`trip.ts`, `trip.rs`) reads them beside `quotes`.

pub mod catalog;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::Json;
use axum::extract::State;
use chrono::{Duration as Days, Utc};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Shopify storefronts Yama will query. Others can still be imported.
pub const SHOPIFY_HOSTS: [&str; 2] = ["patsgames.com", "mothershipatx.com"];
pub const YESTCG: &str = "https://yestcg.com";
/// Stores answer scripts that look like a browser (a plain "Mozilla/5.0" gets 403 at TCGplayer Pro).
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/// At most this many cards in one check.
pub const MAX_CARDS: usize = 300;
/// At most this many fetched snapshots per account in 24 hours (imports don't count).
pub const DAILY_SNAPSHOTS: i64 = 24;
/// The newest this many snapshots of each store are kept; the newest `RAW_KEEP` keep their raw responses.
const KEEP: i64 = 20;
const RAW_KEEP: i64 = 10;
/// Raw responses kept per snapshot, before gzip; past this the bodies are left out (the listings stay).
const RAW_MAX: usize = 16 << 20;
/// A "running" snapshot this server isn't fetching, older than this, was cut off (a restart): it's
/// shown as failed. (Inserted rows are registered as active before they're written; the margin only
/// covers a clock step.)
const STALE_MINUTES: i64 = 2;

/// The snapshots this server process is fetching now. A restart empties it, so a row still
/// "running" that isn't here was cut off, however long a live check takes.
fn active() -> &'static std::sync::Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<std::sync::Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}
/// Storefront search pages read for one card when `suggest.json` is full, and products read for one card.
const SHOP_PAGES: usize = 12;
const SHOP_PRODUCTS: usize = 60;
/// Pages of 5,000 products read from a TCGplayer Pro catalog.
const PRO_PAGES: usize = 8;
/// Listings in an imported file.
pub const IMPORT_MAX_LISTINGS: usize = 20000;

/// Times to the millisecond, so two checks finishing in one second keep their order.
fn now() -> String {
    stamp(Utc::now())
}

fn stamp(t: chrono::DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The front face, trimmed and lowercased, with curly quotes straightened: how cards are matched.
pub fn card_key(name: &str) -> String {
    let front = name.split(" // ").next().unwrap_or(name);
    front.trim().replace(['’', '‘'], "'").to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── connectors ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Shopify,
    Pro,
    YesTcg,
}

impl Kind {
    pub fn source(self) -> &'static str {
        match self {
            Kind::Shopify => "shopify",
            Kind::Pro => "tcgplayer_pro",
            Kind::YesTcg => "yestcg",
        }
    }

    fn pause(self) -> Duration {
        match self {
            Kind::Shopify => Duration::from_millis(700),
            Kind::Pro => Duration::from_secs(2),
            Kind::YesTcg => Duration::from_millis(800),
        }
    }
}

/// The store's own connector, from its homepage: a Shopify store on the list, or a TCGplayer Pro
/// storefront. Returns the kind and the https origin to query.
pub fn direct_connector(homepage: Option<&str>) -> Option<(Kind, String)> {
    let u = url::Url::parse(homepage?).ok()?;
    if u.scheme() != "https" || u.port().is_some() {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    let bare = host.strip_prefix("www.").unwrap_or(&host);
    if SHOPIFY_HOSTS.contains(&bare) {
        return Some((Kind::Shopify, format!("https://{bare}")));
    }
    let label = host.strip_suffix(".tcgplayerpro.com")?;
    let ok = !label.is_empty() && label.len() <= 63 && label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !label.starts_with('-');
    ok.then(|| (Kind::Pro, format!("https://{host}")))
}

/// The host of a homepage, without `www.`, for matching YesTCG's store list.
fn bare_host(homepage: Option<&str>) -> Option<String> {
    let u = url::Url::parse(homepage?).ok()?;
    let h = u.host_str()?.to_ascii_lowercase();
    Some(h.strip_prefix("www.").unwrap_or(&h).to_string())
}

/// One store listing as parsed, before it's saved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub card: String,
    pub title: Option<String>,
    pub set_code: Option<String>,
    pub set_name: Option<String>,
    pub number: Option<String>,
    pub finish: Option<&'static str>,
    pub condition: Option<String>,
    pub language: Option<String>,
    pub price: Option<f64>,
    pub available: Option<bool>,
    pub qty: Option<i64>,
    pub quantity_checked_at: Option<String>,
    pub from_price: bool,
    pub variant: Option<String>,
    pub url: Option<String>,
}

/// A store's price as given: missing, or a sum of money. Anything else makes the answer unreadable.
fn price_ok(v: &Value) -> bool {
    v.is_null() || v.as_f64().is_some_and(|p| p.is_finite() && p >= 0.0)
}

/// A store's name or title: text that isn't blank.
fn text_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|t| !t.trim().is_empty())
}

/// A store's product title before ` [` or ` (`, without a "MTG - " prefix.
fn title_name(title: &str) -> &str {
    let t = title.trim();
    let t = t.strip_prefix("MTG - ").unwrap_or(t);
    // Card names have no " - "; a store's variant suffix ("Sol Ring - Foil") does.
    let end = [t.find(" ["), t.find(" ("), t.find(" - ")].into_iter().flatten().min().unwrap_or(t.len());
    t[..end].trim()
}

fn same_card(listed: &str, card: &str) -> bool {
    let (a, b) = (card_key(listed), card_key(card));
    a == b || listed.trim().to_lowercase() == card.trim().to_lowercase()
}

/// "[AVR - 226]" in a title: the set code (lowercased) and collector number.
fn set_and_number(title: &str) -> (Option<String>, Option<String>) {
    let Some(open) = title.rfind('[') else { return (None, None) };
    let inner = title[open + 1..].split(']').next().unwrap_or_default();
    let mut parts = inner.splitn(2, " - ");
    let (code, num) = (parts.next().unwrap_or_default().trim(), parts.next().map(str::trim));
    let code_ok = (2..=6).contains(&code.len()) && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    match num {
        Some(n) if code_ok && !n.is_empty() && !n.contains(' ') => (Some(code.to_lowercase()), Some(n.to_string())),
        _ => (None, None),
    }
}

const LANGUAGES: [&str; 12] = ["english", "japanese", "german", "french", "italian", "spanish", "portuguese", "korean", "chinese", "russian", "phyrexian", "foreign"];

/// A language other than English a word names, in full or abbreviated ("japanese", "jp"), capitalized.
fn foreign_language(word: &str) -> Option<String> {
    let w = word.trim().to_lowercase();
    let lang = match w.as_str() {
        "jp" | "jpn" | "ja" => Some("japanese"),
        "de" | "ger" => Some("german"),
        "fr" | "fre" => Some("french"),
        "it" | "ita" => Some("italian"),
        "es" | "sp" | "spa" => Some("spanish"),
        "pt" | "por" => Some("portuguese"),
        "ko" | "kor" => Some("korean"),
        "zh" | "cs" | "ct" | "chs" | "cht" => Some("chinese"),
        "ru" | "rus" => Some("russian"),
        w => LANGUAGES.iter().find(|l| **l == w && **l != "english").copied(),
    }?;
    let mut c = lang.chars();
    Some(c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default())
}

/// A language a store's title names in brackets or parentheses ("Sol Ring (Japanese)", "[JP]").
fn title_language(title: &str) -> Option<String> {
    for part in qualifiers(title) {
        for word in part.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()) {
            if let Some(l) = foreign_language(word) {
                return Some(l);
            }
        }
    }
    None
}

/// A title's qualifiers, lowercased: what's in brackets or parentheses, and a " - " suffix (a
/// variant's options). Never the card's name ("Etched Champion" is a card, not a finish).
fn qualifiers(title: &str) -> Vec<String> {
    let lower = title.to_lowercase();
    let mut parts = Vec::new();
    for (open, close) in [('(', ')'), ('[', ']')] {
        let mut rest = lower.as_str();
        while let Some(i) = rest.find(open) {
            let after = &rest[i + 1..];
            let Some(j) = after.find(close) else { break };
            parts.push(after[..j].to_string());
            rest = &after[j + 1..];
        }
    }
    // " - " segments outside brackets and parentheses, after the name ("Sol Ring - Foil [C21 - 263]"),
    // without a "MTG - " prefix.
    let bare = lower.trim_start().strip_prefix("mtg - ").unwrap_or(&lower);
    let mut outside = String::new();
    let mut depth = 0i32;
    for c in bare.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => outside.push(c),
            _ => {}
        }
    }
    parts.extend(outside.split(" - ").skip(1).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()));
    parts
}

/// A foil or etched finish a title's qualifiers name ("Sol Ring (Foil)", "[Etched Foil]"); "non-foil" isn't one.
fn title_finish(title: &str) -> Option<&'static str> {
    let lower = qualifiers(title).join(" ").replace("non-foil", " ").replace("nonfoil", " ");
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    if words.contains(&"etched") {
        Some("etched")
    } else if words.contains(&"foil") {
        Some("foil")
    } else {
        None
    }
}

/// Condition, language and finish from a variant's options ("Near Mint / English / Foil").
fn variant_parts(text: &str) -> (Option<String>, Option<String>, &'static str) {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '-').collect();
    let finish = if words.contains(&"etched") {
        "etched"
    } else if words.contains(&"foil") && !lower.contains("non-foil") && !lower.contains("nonfoil") {
        "foil"
    } else {
        "nonfoil"
    };
    let mut condition = None;
    let mut language = None;
    for part in text.split(" / ").map(str::trim) {
        let l = part.to_lowercase();
        if LANGUAGES.iter().any(|x| l == *x || l.starts_with(&format!("{x} "))) {
            language = Some(part.to_string());
        } else if let Some(lang) = foreign_language(&l) {
            // An abbreviation ("JP") is a language too.
            language = Some(lang);
        } else if ["normal", "foil", "etched", "non-foil", "nonfoil"].contains(&l.as_str()) || l.ends_with(" foil") {
        } else if condition.is_none() && !part.is_empty() {
            condition = Some(part.to_string());
        }
    }
    (condition, language, finish)
}

/// The products a Shopify `suggest.json` answer lists under the card's exact name: (handle, title).
pub fn shopify_suggest(body: &Value, card: &str) -> Option<(usize, Vec<(String, String)>)> {
    // An answer without the product list isn't "none found": it's an answer we can't read.
    let items = body["resources"]["results"]["products"].as_array()?;
    // So is one whose products don't all have a title and a handle.
    if !items.iter().all(|p| text_ok(&p["title"]) && text_ok(&p["handle"])) {
        return None;
    }
    let found = items
        .iter()
        .filter_map(|p| {
            let title = p["title"].as_str()?;
            let handle = p["handle"].as_str()?;
            let ok = same_card(title_name(title), card) && !handle.is_empty() && handle.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            ok.then(|| (handle.to_string(), title.to_string()))
        })
        .collect();
    Some((items.len(), found))
}

/// The product handles a Shopify storefront search page links to whose handle holds the card's
/// name (as commander-decks' `search.py` reads them), in page order.
pub fn search_page_handles(html: &str, card: &str) -> Vec<String> {
    let front = card.split(" // ").next().unwrap_or(card).to_lowercase().replace(['\'', '’', ',', '.', '!'], "");
    let slug = front.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-");
    let mut out: Vec<String> = Vec::new();
    for part in html.split("href=\"/products/").skip(1) {
        let h: String = part.chars().take_while(|c| !matches!(c, '"' | '?' | '#' | '/')).collect();
        let ok = !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && h.contains(&slug);
        if ok && !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// Read a count only from the requested variant's main product form and inventory badge.
/// Search-card badges can combine conditions; never assign those totals to every variant.
fn shopify_variant_quantity(html: &str, variant: &str) -> Option<i64> {
    use fancy_regex::Regex;
    fn attr(tag: &str, key: &str) -> Option<String> {
        let re = Regex::new(r#"([\w-]+)\s*=\s*["']([^"']*)["']"#).ok()?;
        re.captures_iter(tag).filter_map(Result::ok).find_map(|c| (c.get(1)?.as_str() == key).then(|| c.get(2).unwrap().as_str().to_owned()))
    }
    let forms = Regex::new(r"(?s)<form\b([^>]*)>(.*?)</form>").ok()?;
    let inputs = Regex::new(r"(?s)<input\b([^>]*)>").ok()?;
    let inventory = Regex::new(r#"(?s)<div\b([^>]*\bid=["']Inventory-[^"']*["'][^>]*)>(.*?)</div>"#).ok()?;
    let count = Regex::new(r"(?i)\b(?:Only\s+([0-9][0-9,]*)\s+left|([0-9][0-9,]*)\s+in stock)\b").ok()?;
    let mut found = Vec::new();
    for block in inventory.captures_iter(html).filter_map(Result::ok) {
        let Some(id) = attr(block.get(1)?.as_str(), "id") else { continue };
        let Some(section) = id.strip_prefix("Inventory-") else { continue };
        let matching_form = forms.captures_iter(html).filter_map(Result::ok).any(|form| {
            attr(form.get(1).unwrap().as_str(), "id").as_deref() == Some(&format!("product-form-{section}"))
                && inputs.captures_iter(form.get(2).unwrap().as_str()).filter_map(Result::ok).any(|input| {
                    let tag = input.get(1).unwrap().as_str();
                    attr(tag, "name").as_deref() == Some("id") && attr(tag, "value").as_deref() == Some(variant)
                })
        });
        if !matching_form { continue; }
        if block.get(2)?.as_str().to_lowercase().contains("out of stock") { found.push(0); continue; }
        if let Some(c) = count.captures(block.get(2)?.as_str()).ok()? {
            let n = c.get(1).or_else(|| c.get(2))?.as_str().replace(',', "").parse::<i64>().ok()?;
            if (1..=100_000).contains(&n) { found.push(n); }
        }
    }
    // Contradictory or duplicate inventory blocks are not trustworthy variant evidence.
    if found.len() == 1 { found.first().copied() } else { None }
}

/// Every variant of a Shopify product (`/products/<handle>.js`) as listings for the card.
pub fn shopify_product(body: &Value, card: &str, base: &str, handle: &str) -> Vec<Listing> {
    let title = body["title"].as_str().unwrap_or_default();
    if !same_card(title_name(title), card) {
        return vec![];
    }
    let (set_code, number) = set_and_number(title);
    let title_finish = title_finish(title);
    let empty = vec![];
    body["variants"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|v| {
            let vt = [&v["title"], &v["public_title"]].into_iter().filter_map(Value::as_str).find(|t| !t.trim().is_empty()).unwrap_or_default();
            let (condition, language, mut finish) = variant_parts(vt);
            let language = language.or_else(|| title_language(title));
            if finish == "nonfoil" && let Some(f) = title_finish {
                finish = f;
            }
            Listing {
                card: card.to_string(),
                title: Some(format!("{title}{}", if vt.is_empty() { String::new() } else { format!(" - {vt}") })),
                set_code: set_code.clone(),
                set_name: body["vendor"].as_str().map(String::from),
                number: number.clone(),
                finish: Some(finish),
                condition,
                language,
                // Shopify's product .js gives cents.
                price: v["price"].as_f64().map(|c| (c / 100.0 * 100.0).round() / 100.0),
                available: v["available"].as_bool(),
                qty: None,
                quantity_checked_at: None,
                from_price: false,
                variant: v["id"].as_i64().map(|i| i.to_string()).or_else(|| v["id"].as_str().map(String::from)),
                url: Some(match v["id"].as_i64().map(|i|i.to_string()).or_else(||v["id"].as_str().map(String::from)) { Some(id) if !id.is_empty() && id.bytes().all(|c|c.is_ascii_digit()) => format!("{base}/products/{handle}?variant={id}"), _ => format!("{base}/products/{handle}") }),
            }
        })
        .collect()
}

/// A TCGplayer Pro catalog answer: (total products, listings, one per product at its lowest price).
pub fn pro_catalog(body: &Value, base: &str) -> Option<(i64, Vec<Listing>)> {
    // An answer without the catalog's fields isn't an empty catalog: it's one we can't read.
    let total = body["products"]["totalItems"].as_i64().filter(|t| *t >= 0)?;
    let items = body["products"]["items"].as_array()?;
    // So is a page with more products than the catalog's total, a product that has no name (it may
    // be the card wanted), or an unreadable price.
    if items.len() as i64 > total || !items.iter().all(|p| text_ok(&p["name"]) && price_ok(&p["lowestPrice"])) {
        return None;
    }
    let out = items
        .iter()
        .filter(|p| p["productLineName"].as_str().is_none_or(|l| l == "Magic: The Gathering"))
        .filter_map(|p| {
            let name = p["name"].as_str()?;
            let card = title_name(name);
            if card.is_empty() {
                return None;
            }
            let finish = title_finish(name);
            let url = match (p["setUrlName"].as_str(), p["productUrlName"].as_str(), p["id"].as_i64()) {
                (Some(s), Some(n), Some(id)) => Some(format!("{base}/catalog/magic/{s}/{n}/{id}")),
                _ => None,
            };
            Some(Listing {
                card: card.to_string(),
                title: Some(name.to_string()),
                set_name: p["setName"].as_str().map(String::from),
                language: title_language(name),
                finish,
                price: p["lowestPrice"].as_f64().filter(|x| x.is_finite() && *x >= 0.0),
                available: Some(true),
                from_price: true,
                url,
                ..Listing::default()
            })
        })
        .collect();
    Some((total, out))
}

/// One store's part of a YesTCG answer: `None` when YesTCG says that store failed (unknown stock).
pub fn yestcg_store(body: &Value, store_host: &str, card: &str) -> Option<Option<Vec<Listing>>> {
    let d = if body.get("results").is_some() { body } else { &body["data"] };
    let empty = vec![];
    let r = d["results"].as_array().unwrap_or(&empty).iter().find(|r| bare_host(r["base"].as_str()).as_deref() == Some(store_host))?;
    if r["ok"] != true {
        return Some(None);
    }
    // A hit list that's missing or not a list is an answer we can't read: unknown, not none.
    let Some(hits) = r["hits"].as_array() else { return Some(None) };
    // So is a hit without a name or a condition (finish and language are in it), with a price that
    // isn't a number, or with a bad quantity.
    // A quantity, when given, must be a whole number of copies: a bad one isn't "any number".
    let qty_ok = |q: &Value| q.is_null() || q.as_u64().is_some_and(|n| n <= 100_000);
    if !hits.iter().all(|h| text_ok(&h["name"]) && text_ok(&h["condition"]) && price_ok(&h["price"]) && qty_ok(&h["qty"])) {
        return Some(None);
    }
    let listings = hits
        .iter()
        .filter_map(|h| {
            let name = h["name"].as_str()?;
            if !same_card(title_name(name), card) {
                return None;
            }
            let cond = h["condition"].as_str().unwrap_or_default();
            let (condition, language, mut finish) = variant_parts(cond);
            let language = language.or_else(|| title_language(name));
            if finish == "nonfoil" && let Some(f) = title_finish(name) {
                finish = f;
            }
            Some(Listing {
                card: card.to_string(),
                title: Some(name.to_string()),
                set_name: h["set"].as_str().map(String::from),
                finish: Some(finish),
                condition,
                language,
                price: h["price"].as_f64().filter(|x| x.is_finite() && *x >= 0.0),
                available: Some(true),
                qty: h["qty"].as_i64(),
                url: h["url"].as_str().filter(|u| u.starts_with("https://")).map(String::from),
                ..Listing::default()
            })
        })
        .collect();
    Some(Some(listings))
}

// ── fetching ────────────────────────────────────────────────────────────────

/// The host (and port) a store's requests are paced by.
fn host_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    Some(format!("{}:{}", u.host_str()?, u.port_or_known_default()?))
}

/// One request at a time per host, `pause` apart, across every check on this server.
async fn pace(host: &str, pause: Duration) -> tokio::sync::OwnedMutexGuard<Instant> {
    static HOSTS: OnceLock<std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<Instant>>>>> = OnceLock::new();
    let lock = HOSTS.get_or_init(Default::default).lock().expect("hosts").entry(host.to_string()).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(60)))).clone();
    let guard = lock.lock_owned().await;
    let wait = (*guard + pause).saturating_duration_since(Instant::now());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    guard
}

/// Store answers are public (a card's listings, not anybody's account), so one fetched for one
/// person's check serves anyone's for [`SHARED_TTL`], keyed by method, URL and body.
const SHARED_TTL: Duration = Duration::from_secs(45 * 60);
const SHARED_ENTRIES: usize = 2000;
const SHARED_BYTES: usize = 32 << 20;
/// The longest a store's Retry-After is waited out inside a check; longer, and it gives up.
const MAX_ASKED: Duration = Duration::from_secs(60);

/// How long each host asked every check to wait (its Retry-After), in full: a check that would
/// wait longer than [`MAX_ASKED`] stops without asking again.
fn holds() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static HOLDS: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    HOLDS.get_or_init(Default::default)
}

fn held(host: &str) -> Duration {
    holds().lock().expect("holds").get(host).map_or(Duration::ZERO, |until| until.saturating_duration_since(Instant::now()))
}

fn hold(host: &str, wait: Duration) {
    let mut holds = holds().lock().expect("holds");
    let until = Instant::now() + wait;
    let entry = holds.entry(host.to_string()).or_insert(until);
    *entry = (*entry).max(until);
}

/// Wait out a host's hold while it's short (it may be extended meanwhile); an error saying how
/// long once it isn't.
async fn wait_hold(host: &str, url: &str) -> Result<(), String> {
    loop {
        let left = held(host);
        if left.is_zero() {
            return Ok(());
        }
        if left > MAX_ASKED {
            return Err(format!("{url}: the store asked Yama to wait {} s", left.as_secs()));
        }
        tokio::time::sleep(left).await;
    }
}

/// This check's turn at a host: past any hold, then the host's pacing lock, and the hold checked
/// again once the lock is held, since a check ahead may have been told to wait while this one
/// queued. The lock is kept until the answer is read; a 429's hold is published before it goes.
async fn turn(host: &str, url: &str, pause: Duration) -> Result<tokio::sync::OwnedMutexGuard<Instant>, String> {
    loop {
        wait_hold(host, url).await?;
        let guard = pace(host, pause).await;
        if held(host).is_zero() {
            return Ok(guard);
        }
    }
}

/// How long a 429 without a usable Retry-After holds its host.
const UNSAID_HOLD: Duration = Duration::from_secs(60);

/// A 429's Retry-After, or [`UNSAID_HOLD`] when it gives none.
fn asked_wait(resp: &reqwest::Response) -> Duration {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map_or(UNSAID_HOLD, |v| Duration::from_secs(crate::mcp::research::client::retry_after(v.trim())))
}

struct Shared {
    text: std::sync::Arc<String>,
    at: Instant,
    fetched_at: String,
}

fn shared() -> &'static std::sync::Mutex<HashMap<String, Shared>> {
    static SHARED: OnceLock<std::sync::Mutex<HashMap<String, Shared>>> = OnceLock::new();
    SHARED.get_or_init(Default::default)
}

fn shared_key(method: &str, url: &str, body: Option<&Value>) -> String {
    format!("{method} {url}\n{}", body.map(Value::to_string).unwrap_or_default())
}

fn shared_get(key: &str) -> Option<(std::sync::Arc<String>, String)> {
    let mut map = shared().lock().expect("shared answers");
    match map.get(key) {
        Some(s) if s.at.elapsed() < SHARED_TTL => Some((s.text.clone(), s.fetched_at.clone())),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

fn shared_put(key: String, text: &str) {
    let mut map = shared().lock().expect("shared answers");
    map.retain(|_, s| s.at.elapsed() < SHARED_TTL);
    map.insert(key, Shared { text: std::sync::Arc::new(text.to_string()), at: Instant::now(), fetched_at: now() });
    // Oldest out first.
    while map.len() > SHARED_ENTRIES || map.values().map(|s| s.text.len()).sum::<usize>() > SHARED_BYTES {
        let Some(oldest) = map.iter().min_by_key(|(_, s)| s.at).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
}

/// What one job fetched, kept as the snapshot's raw record.
#[derive(Default)]
struct Raw {
    items: Vec<Value>,
    size: usize,
}

impl Raw {
    fn add(&mut self, method: &str, url: &str, status: u16, body: &str) {
        let keep = self.size + body.len() <= RAW_MAX;
        self.size += body.len();
        self.items.push(json!({"method": method, "url": url, "status": status, "at": now(), "body": if keep { json!(body) } else { json!(null) }}));
    }

    /// An answer another check fetched at `at`, reused.
    fn add_shared(&mut self, method: &str, url: &str, at: &str, body: &str) {
        let keep = self.size + body.len() <= RAW_MAX;
        self.size += body.len();
        self.items.push(json!({"method": method, "url": url, "status": 200, "at": at, "shared": true, "body": if keep { json!(body) } else { json!(null) }}));
    }

    fn gz(&self) -> Option<Vec<u8>> {
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(Value::Array(self.items.clone()).to_string().as_bytes()).ok()?;
        e.finish().ok()
    }
}

pub struct Fetcher {
    http: reqwest::Client,
    pause: Duration,
    cookie: Option<String>,
    refresh: bool,
}

impl Fetcher {
    pub fn new(http: reqwest::Client, pause: Option<Duration>) -> Self {
        Fetcher { http, pause: pause.unwrap_or(Duration::ZERO), cookie: None, refresh: false }
    }

    /// GET or POST with a browser's headers, retrying 429 (as long as the store asks, up to
    /// [`MAX_ASKED`]) and 5xx twice. Records every answer; one fetched in the last
    /// [`SHARED_TTL`] by any check is reused. A fresh answer that reads as JSON is shared with
    /// other checks; a connector that then finds it isn't what it expected takes it back
    /// ([`Fetcher::forget`]).
    async fn send(&mut self, kind: Kind, method: &str, url: &str, body: Option<&Value>, raw: &mut Raw) -> Result<Value, String> {
        let (text, fresh) = self.fetch(kind, method, url, body, raw, "application/json").await?;
        let value = serde_json::from_str(&text).map_err(|_| format!("{url}: the answer wasn't JSON"))?;
        if fresh {
            shared_put(shared_key(method, url, body), &text);
        }
        Ok(value)
    }

    /// A page's text (a storefront's search page). Shared only when its reader found what it
    /// looks for ([`Fetcher::share_page`]): a challenge page and an empty one look alike.
    async fn page(&mut self, kind: Kind, url: &str, raw: &mut Raw) -> Result<String, String> {
        Ok(self.fetch(kind, "GET", url, None, raw, "text/html").await?.0)
    }

    fn share_page(&self, url: &str, html: &str) {
        let key = shared_key("GET", url, None);
        if shared_get(&key).is_none() {
            shared_put(key, html);
        }
    }

    /// An answer that turned out unreadable isn't served to other checks.
    fn forget(&self, method: &str, url: &str, body: Option<&Value>) {
        shared().lock().expect("shared answers").remove(&shared_key(method, url, body));
    }

    /// The answer's text, and whether it was fetched now (not another check's).
    async fn fetch(&mut self, kind: Kind, method: &str, url: &str, body: Option<&Value>, raw: &mut Raw, accept: &str) -> Result<(String, bool), String> {
        let host = host_of(url).ok_or("bad url")?;
        if let Some((text, at)) = (!self.refresh).then(|| shared_get(&shared_key(method, url, body))).flatten() {
            raw.add_shared(method, url, &at, &text);
            return Ok((text.to_string(), false));
        }
        let pause = if self.pause.is_zero() { Duration::ZERO } else { kind.pause().max(self.pause) };
        let mut last = String::new();
        for attempt in 0..3u32 {
            let guard = turn(&host, url, pause).await?;
            // A check ahead in the queue may have fetched this very answer meanwhile.
            if let Some((text, at)) = (!self.refresh).then(|| shared_get(&shared_key(method, url, body))).flatten() {
                drop(guard);
                raw.add_shared(method, url, &at, &text);
                return Ok((text.to_string(), false));
            }
            let mut req = if method == "POST" { self.http.post(url) } else { self.http.get(url) };
            req = req.header("User-Agent", BROWSER_UA).header("Accept", accept).timeout(Duration::from_secs(60));
            if let Some(b) = body {
                let origin = url::Url::parse(url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
                req = req.header("Content-Type", "application/json").header("Origin", &origin).header("Referer", format!("{origin}/")).body(b.to_string());
            }
            if kind == Kind::YesTcg {
                req = req.header("Referer", format!("{YESTCG}/")).header("X-Requested-With", "XMLHttpRequest");
                if let Some(c) = &self.cookie {
                    req = req.header("Cookie", c);
                }
            }
            // The host's lock is held until the whole answer is read, then the pause runs from there.
            let mut guard = guard;
            let sent = req.send().await;
            // A body that couldn't be read is a failed request (retried), never an empty answer.
            let read = match sent {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let asked = resp
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .map(|v| Duration::from_secs(crate::mcp::research::client::retry_after(v.trim())));
                    resp.text().await.map(|t| (status, asked, t))
                }
                Err(e) => Err(e),
            };
            // The next request to this host, from any check, waits its pause from now, and as long
            // as the store asked.
            let asked = match &read {
                Ok((429, asked, _)) => asked.unwrap_or(UNSAID_HOLD),
                _ => Duration::ZERO,
            };
            if !asked.is_zero() {
                hold(&host, asked);
            }
            *guard = Instant::now();
            drop(guard);
            match read {
                Ok((status, _, text)) => {
                    raw.add(method, url, status, &text);
                    if (200..300).contains(&status) {
                        return Ok((text, true));
                    }
                    last = format!("{url}: HTTP {status}");
                    if status == 429 && asked > MAX_ASKED {
                        return Err(format!("{url}: the store asked Yama to wait {} s", asked.as_secs()));
                    }
                    if status != 429 && status < 500 {
                        return Err(last);
                    }
                }
                Err(e) => {
                    raw.add(method, url, 0, "");
                    last = format!("{url}: {}", if e.is_timeout() { "timed out".to_string() } else { "couldn't connect".to_string() });
                }
            }
            if !pause.is_zero() {
                tokio::time::sleep(pause * (3 * (attempt + 1))).await;
            }
        }
        Err(last)
    }

    /// YesTCG answers its API only with the session cookie its home page sets.
    /// An error, and nothing more asked of the store, when it's holding Yama off or answers
    /// this with a 429.
    async fn yestcg_cookie(&mut self, base: &str, raw: &mut Raw) -> Result<(), String> {
        let host = host_of(base).unwrap_or_default();
        let mut guard = turn(&host, base, if self.pause.is_zero() { Duration::ZERO } else { Kind::YesTcg.pause() }).await?;
        let sent = self.http.get(format!("{base}/")).header("User-Agent", BROWSER_UA).timeout(Duration::from_secs(30)).send().await;
        if let Ok(resp) = &sent
            && resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            let asked = asked_wait(resp);
            hold(&host, asked);
            *guard = Instant::now();
            drop(guard);
            raw.add("GET", &format!("{base}/"), 429, "");
            return Err(format!("{base}/: the store asked Yama to wait {} s", asked.as_secs()));
        }
        // The next request waits its pause from now.
        *guard = Instant::now();
        drop(guard);
        if let Ok(resp) = sent {
            let cookies: Vec<String> = resp
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .filter_map(|v| v.split(';').next())
                .map(|v| v.trim().to_string())
                .filter(|v| v.contains('='))
                .collect();
            raw.add("GET", &format!("{base}/"), resp.status().as_u16(), "");
            if !cookies.is_empty() {
                self.cookie = Some(cookies.join("; "));
            }
        }
        Ok(())
    }
}

/// What a connector found: listings, the cards whose answer is unknown, and errors.
#[derive(Clone, Default)]
pub struct Found {
    pub listings: Vec<Listing>,
    pub failed: Vec<String>,
    pub errors: Vec<String>,
    pub total: Option<i64>,
    pub cached_at: Option<String>,
}

async fn fetch_shopify_catalog(pool: &SqlitePool, f: &mut Fetcher, base: &str, cards: &[String], refresh: bool, requested: &str, raw: &mut Raw) -> Found {
    match catalog::products(pool,f,base,refresh,requested,raw).await {
        Ok(None) => fetch_shopify(f,base,cards,raw).await,
        Err(e) => Found { failed: cards.to_vec(), errors: vec![format!("Catalog unavailable: {e}. Previous cache preserved.")], ..Default::default() },
        Ok(Some((at,products))) => {
            let mut found = Found { cached_at: Some(at), ..Default::default() };
            let wanted: HashMap<String,&String> = cards.iter().map(|c|(card_key(c),c)).collect();
            for product in products {
                let Some(title) = product["title"].as_str() else { continue };
                let Some(card) = wanted.get(&card_key(title_name(title))) else { continue };
                let Some(handle) = product["handle"].as_str() else { continue };
                let mut listings: Vec<_> = shopify_product(&product,card,base,handle).into_iter().filter(|l|l.available==Some(true)).collect();
                enrich_shopify_quantities(f,base,handle,&mut listings,raw).await;
                found.listings.extend(listings.into_iter().filter(|l| l.available==Some(true)));
            }
            found
        }
    }
}

async fn enrich_shopify_quantities(f: &mut Fetcher, base: &str, handle: &str, listings: &mut [Listing], raw: &mut Raw) {
    if base != "https://mothershipatx.com" { return; }
    for listing in listings {
        if let Some(variant) = listing.variant.as_deref().filter(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit())) {
            let url = format!("{base}/products/{handle}?variant={variant}");
            if let Ok(html) = f.page(Kind::Shopify,&url,raw).await {
                listing.qty = shopify_variant_quantity(&html,variant);
                if listing.qty.is_some() { listing.quantity_checked_at = Some(now()); }
                if listing.qty == Some(0) { listing.available = Some(false); }
            }
        }
    }
}

/// Every printing a Shopify store lists for each card: `suggest.json`, and when that's full (it
/// stops at 10 products) the storefront's search pages, then each product's variants. A card any of
/// whose reads failed, or with more printings than Yama reads, is unknown: a printing not read may
/// be the cheapest in stock.
async fn fetch_shopify(f: &mut Fetcher, base: &str, cards: &[String], raw: &mut Raw) -> Found {
    let mut out = Found::default();
    for card in cards {
        let front = card.split(" // ").next().unwrap_or(card).trim();
        let mut u = url::Url::parse(&format!("{base}/search/suggest.json")).expect("base");
        u.query_pairs_mut().append_pair("q", &format!("\"{front}\"")).append_pair("resources[type]", "product").append_pair("resources[limit]", "10");
        let (n, mut handles): (usize, Vec<String>) = match f.send(Kind::Shopify, "GET", u.as_str(), None, raw).await {
            Ok(body) => match shopify_suggest(&body, card) {
                Some((n, found)) => (n, found.into_iter().map(|h| h.0).collect()),
                None => {
                    f.forget("GET", u.as_str(), None);
                    out.errors.push(format!("{}: an answer without a product list", u.as_str()));
                    out.failed.push(card.clone());
                    continue;
                }
            },
            Err(e) => {
                out.errors.push(e);
                out.failed.push(card.clone());
                continue;
            }
        };
        let mut incomplete = false;
        if n >= 10 {
            // Suggest is full: read the storefront's search pages until one has none of the card's
            // printings or only repeats an earlier page (a page may repeat the suggestions and still
            // be followed by more).
            let mut done = false;
            let mut paged: Vec<String> = Vec::new();
            for page in 1..=SHOP_PAGES {
                let mut p = url::Url::parse(&format!("{base}/search")).expect("base");
                p.query_pairs_mut().append_pair("q", &format!("\"{front}\"")).append_pair("type", "product").append_pair("page", &page.to_string());
                match f.page(Kind::Shopify, p.as_str(), raw).await {
                    Ok(html) => {
                        let on_page = search_page_handles(&html, card);
                        if !on_page.is_empty() {
                            f.share_page(p.as_str(), &html);
                        }
                        if on_page.iter().all(|h| paged.contains(h)) {
                            done = true;
                            break;
                        }
                        for h in on_page {
                            if !paged.contains(&h) {
                                paged.push(h.clone());
                            }
                            if !handles.contains(&h) {
                                handles.push(h);
                            }
                        }
                    }
                    Err(e) => {
                        out.errors.push(e);
                        break;
                    }
                }
            }
            incomplete = !done;
        }
        if handles.len() > SHOP_PRODUCTS {
            incomplete = true;
        }
        let mut found = Vec::new();
        if !incomplete {
            for handle in &handles {
                match f.send(Kind::Shopify, "GET", &format!("{base}/products/{handle}.js"), None, raw).await {
                    // A title, and every variant's availability and price (a sum of money), or the product is unreadable.
                    Ok(body)
                        if text_ok(&body["title"])
                            && body["variants"].as_array().is_some_and(|v| v.iter().all(|x| x["available"].is_boolean() && (text_ok(&x["title"]) || text_ok(&x["public_title"])) && x["price"].is_number() && price_ok(&x["price"]))) =>
                    {
                        let mut listings: Vec<_> = shopify_product(&body, card, base, handle).into_iter().filter(|l| l.available == Some(true)).collect();
                        // The JSON feed says available, but Mothership exposes low-stock counts
                        // in variant-selected HTML instead. GET only; never probe a user's cart.
                        enrich_shopify_quantities(f,base,handle,&mut listings,raw).await;
                        found.extend(listings.into_iter().filter(|l| l.available==Some(true)));
                    }
                    Ok(_) => {
                        f.forget("GET", &format!("{base}/products/{handle}.js"), None);
                        out.errors.push(format!("{base}/products/{handle}.js: an answer without readable variants"));
                        incomplete = true;
                        break;
                    }
                    Err(e) => {
                        out.errors.push(e);
                        incomplete = true;
                        break;
                    }
                }
            }
        }
        if incomplete {
            if handles.len() > SHOP_PRODUCTS {
                out.errors.push(format!("{card}: more than {SHOP_PRODUCTS} printings listed; Yama didn't read them all"));
            }
            out.failed.push(card.clone());
        } else {
            out.listings.extend(found);
        }
    }
    out
}

/// A TCGplayer Pro storefront's whole in-stock Magic catalog, 5,000 products a page.
async fn fetch_pro(f: &mut Fetcher, base: &str, raw: &mut Raw) -> Found {
    let mut out = Found::default();
    let mut from = 0i64;
    let mut seen: HashSet<i64> = HashSet::new();
    for _ in 0..PRO_PAGES {
        let body = json!({"query": "", "context": {"productLineName": "Magic: The Gathering"}, "filters": {}, "from": from, "size": 5000});
        match f.send(Kind::Pro, "POST", &format!("{base}/api/catalog/search"), Some(&body), raw).await {
            Ok(answer) => {
                let Some((total, listings)) = pro_catalog(&answer, base) else {
                    f.forget("POST", &format!("{base}/api/catalog/search"), Some(&body));
                    out.errors.push(format!("{base}/api/catalog/search: an answer without the catalog"));
                    break;
                };
                // Every page must count the same catalog as the first, hold no more than is left, and
                // repeat no product an earlier page had.
                let n = answer["products"]["items"].as_array().map_or(0, Vec::len) as i64;
                let ids: Vec<i64> = answer["products"]["items"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_i64()).collect();
                let repeats = ids.len() as i64 != n || ids.iter().any(|id| !seen.insert(*id));
                if out.total.is_some_and(|t| t != total) || n > total - from || repeats {
                    f.forget("POST", &format!("{base}/api/catalog/search"), Some(&body));
                    out.errors.push(format!("{base}/api/catalog/search: the pages don't add up to one catalog"));
                    break;
                }
                out.total = Some(total);
                out.listings.extend(listings);
                from += n;
                if n == 0 || from >= total {
                    break;
                }
            }
            Err(e) => {
                out.errors.push(e);
                break;
            }
        }
    }
    // Stopped before the end (the page cap): the rest of the catalog is unknown, not absent.
    if out.errors.is_empty() && out.total.is_some_and(|t| from < t) {
        out.errors.push(format!("read {from} of {} products (at most {PRO_PAGES} pages)", out.total.unwrap_or(0)));
    }
    out
}

/// YesTCG's Austin search for each card, split by the person's stores it covers (by host).
async fn fetch_yestcg(f: &mut Fetcher, base: &str, cards: &[String], hosts: &[String], raw: &mut Raw) -> HashMap<String, Found> {
    let mut out: HashMap<String, Found> = hosts.iter().map(|h| (h.clone(), Found::default())).collect();
    if let Err(e) = f.yestcg_cookie(base, raw).await {
        for found in out.values_mut() {
            found.errors.push(e.clone());
            found.failed.extend(cards.iter().cloned());
        }
        return out;
    }
    for card in cards {
        let front = card.split(" // ").next().unwrap_or(card).trim();
        let mut u = url::Url::parse(&format!("{base}/api/decksearch")).expect("base");
        u.query_pairs_mut().append_pair("q", front).append_pair("market", "austin").append_pair("game", "mtg");
        match f.send(Kind::YesTcg, "GET", u.as_str(), None, raw).await {
            Ok(body) => {
                // An answer that names none of its stores isn't one to share.
                if hosts.iter().all(|h| yestcg_store(&body, h, card).is_none()) {
                    f.forget("GET", u.as_str(), None);
                }
                for h in hosts {
                    let found = out.get_mut(h).expect("host");
                    match yestcg_store(&body, h, card) {
                        Some(Some(l)) => found.listings.extend(l),
                        Some(None) => found.failed.push(card.clone()),
                        None => {
                            found.failed.push(card.clone());
                            if !found.errors.iter().any(|e| e.contains("isn't in YesTCG's answer")) {
                                found.errors.push("This store isn't in YesTCG's answer.".into());
                            }
                        }
                    }
                }
            }
            Err(e) => {
                for found in out.values_mut() {
                    found.failed.push(card.clone());
                    found.errors.push(e.clone());
                }
            }
        }
    }
    out
}

// ── saving ──────────────────────────────────────────────────────────────────

fn status_of(found: &Found, asked: Option<usize>) -> &'static str {
    let answered = match asked {
        Some(n) => n.saturating_sub(found.failed.len()),
        None => usize::from(found.errors.is_empty() || !found.listings.is_empty()),
    };
    if answered == 0 && (asked.is_none_or(|n| n > 0)) {
        "error"
    } else if !found.failed.is_empty() || !found.errors.is_empty() {
        "partial"
    } else {
        "ok"
    }
}

/// Write a finished snapshot's listings and status, and prune the store's older snapshots.
async fn finish(pool: &SqlitePool, owner: &str, id: &str, found: &Found, asked: Option<usize>, raw: Option<Vec<u8>>) -> AppResult<()> {
    let status = status_of(found, asked);
    let mut errors: Vec<&String> = Vec::new();
    for e in &found.errors {
        if !errors.contains(&e) {
            errors.push(e);
        }
    }
    let error = (!errors.is_empty()).then(|| errors.iter().take(5).map(|e| e.as_str()).collect::<Vec<_>>().join("; ").chars().take(1900).collect::<String>());
    let mut tx = pool.begin().await?;
    for l in &found.listings {
        save_listing(&mut tx, owner, id, l).await?;
    }
    let store: Option<String> = sqlx::query_scalar("SELECT store_key FROM store_snapshots WHERE id = ? AND owner_id = ?").bind(id).bind(owner).fetch_optional(&mut *tx).await?;
    sqlx::query("UPDATE store_snapshots SET status = ?, error = ?, fetched_at = ?, catalog_fetched_at = ?, failed = ?, raw_gz = ?, item_count = ? WHERE id = ? AND owner_id = ?")
        .bind(status)
        .bind(error)
        .bind(now())
        .bind(&found.cached_at)
        .bind((!found.failed.is_empty()).then(|| json!(found.failed).to_string()))
        .bind(raw)
        .bind(found.listings.len() as i64)
        .bind(id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    if let Some(store) = store {
        prune(&mut tx, owner, &store).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn save_listing(tx: &mut sqlx::SqliteConnection, owner: &str, id: &str, l: &Listing) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO store_listings (snapshot_id, owner_id, card_name, card_key, title, set_code, set_name, number, finish, condition, language,
                                     price, available, qty, quantity_checked_at, price_kind, variant, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(owner)
    .bind(&l.card)
    .bind(card_key(&l.card))
    .bind(&l.title)
    .bind(&l.set_code)
    .bind(&l.set_name)
    .bind(&l.number)
    .bind(l.finish)
    .bind(&l.condition)
    .bind(&l.language)
    .bind(l.price)
    .bind(l.available)
    .bind(l.qty)
    .bind(&l.quantity_checked_at)
    .bind(if l.from_price { "from" } else { "each" })
    .bind(&l.variant)
    .bind(&l.url)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Keep the newest `KEEP` snapshots of a store, and raw responses for the newest `RAW_KEEP`. Rows
/// from the last 24 hours always stay, since the daily cap counts them, and so do rows a pending
/// check_stores change started (they're how applying it again knows it already ran).
async fn prune(tx: &mut sqlx::SqliteConnection, owner: &str, store: &str) -> AppResult<()> {
    let day = stamp(Utc::now() - Days::hours(24));
    let old: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM (SELECT id, requested_at, change_id FROM store_snapshots WHERE owner_id = ? AND store_key = ? AND status != 'running'
                         ORDER BY requested_at DESC, id DESC LIMIT -1 OFFSET ?)
         WHERE requested_at < ?
           AND (change_id IS NULL OR change_id NOT IN (SELECT id FROM assistant_changes WHERE owner_id = ? AND status = 'pending'))",
    )
    .bind(owner)
    .bind(store)
    .bind(KEEP)
    .bind(&day)
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?;
    for id in old {
        sqlx::query("DELETE FROM store_listings WHERE snapshot_id = ? AND owner_id = ?").bind(&id).bind(owner).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM store_snapshots WHERE id = ? AND owner_id = ?").bind(&id).bind(owner).execute(&mut *tx).await?;
    }
    sqlx::query(
        "UPDATE store_snapshots SET raw_gz = NULL WHERE owner_id = ? AND store_key = ? AND raw_gz IS NOT NULL AND id NOT IN
           (SELECT id FROM store_snapshots WHERE owner_id = ? AND store_key = ? ORDER BY requested_at DESC, id DESC LIMIT ?)",
    )
    .bind(owner)
    .bind(store)
    .bind(owner)
    .bind(store)
    .bind(RAW_KEEP)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

// ── a check ─────────────────────────────────────────────────────────────────

/// One store to read in a check.
#[derive(Clone, Debug)]
pub struct Target {
    pub snapshot: String,
    pub store: String,
    pub kind: Kind,
    /// The origin queried: the store's own, or YesTCG's.
    pub base: String,
    /// For YesTCG: the store's host in YesTCG's list.
    pub host: Option<String>,
}

/// A started check: the cards and every store's snapshot.
#[derive(Clone, Debug)]
pub struct Job {
    pub refresh_catalog: bool,
    pub owner: String,
    pub cards: Vec<String>,
    pub targets: Vec<Target>,
}

/// Run a check: each direct store on its own (hosts differ), YesTCG once for all the stores it covers.
pub async fn run(pool: SqlitePool, http: reqwest::Client, job: Job, pause: Option<Duration>) {
    let timing = crate::perf::Job::start("store check", Duration::from_secs(180));
    let note = format!("{} stores, {} cards", job.targets.len(), job.cards.len());
    let mut tasks = tokio::task::JoinSet::new();
    let refresh_catalog = job.refresh_catalog;
    let requested = now();
    let yes: Vec<Target> = job.targets.iter().filter(|t| t.kind == Kind::YesTcg).cloned().collect();
    for t in job.targets.iter().filter(|t| t.kind != Kind::YesTcg).cloned() {
        let (pool, http, owner, cards) = (pool.clone(), http.clone(), job.owner.clone(), job.cards.clone());
        let requested = requested.clone();
        tasks.spawn(async move {
            let mut f = Fetcher::new(http, pause);
            let mut raw = Raw::default();
            let (found, asked) = match t.kind {
                Kind::Shopify => (fetch_shopify_catalog(&pool, &mut f, &t.base, &cards, refresh_catalog, &requested, &mut raw).await, Some(cards.len())),
                _ => (fetch_pro(&mut f, &t.base, &mut raw).await, None),
            };
            if let Err(e) = finish(&pool, &owner, &t.snapshot, &found, asked, raw.gz()).await {
                tracing::warn!(error = %e, "store snapshot not saved");
                return 1;
            }
            0
        });
    }
    if let Some(first) = yes.first().cloned() {
        let (pool, http, owner, cards) = (pool.clone(), http.clone(), job.owner.clone(), job.cards.clone());
        tasks.spawn(async move {
            let mut f = Fetcher::new(http, pause);
            let mut raw = Raw::default();
            let mut hosts: Vec<String> = yes.iter().filter_map(|t| t.host.clone()).collect();
            hosts.sort();
            hosts.dedup();
            let found = fetch_yestcg(&mut f, &first.base, &cards, &hosts, &mut raw).await;
            let gz = raw.gz();
            let mut unsaved = 0;
            for t in &yes {
                // Two stores with one homepage share YesTCG's answer for it.
                let one = t.host.as_ref().and_then(|h| found.get(h).cloned()).unwrap_or_default();
                // One YesTCG answer covers every store: the raw record goes with the first.
                let r = if t.snapshot == first.snapshot { gz.clone() } else { None };
                if let Err(e) = finish(&pool, &owner, &t.snapshot, &one, Some(cards.len()), r).await {
                    tracing::warn!(error = %e, "store snapshot not saved");
                    unsaved += 1;
                }
            }
            unsaved
        });
    }
    // Snapshots not saved; a task that panicked counts as one.
    let mut unsaved = 0;
    while let Some(done) = tasks.join_next().await {
        unsaved += done.unwrap_or(1);
    }
    // Finished, failed or panicked: no longer being fetched.
    {
        let mut a = active().lock().expect("active");
        for t in &job.targets {
            a.remove(&t.snapshot);
        }
    }
    let note = if unsaved > 0 { format!("{note}, {unsaved} not saved") } else { note };
    timing.done(unsaved == 0, note);
}

#[derive(Debug, Default, Deserialize)]
pub struct CheckBody {
    /// Store keys; default every store Yama can check that they'll go to.
    pub stores: Option<Vec<String>>,
    /// Card names; default every card the trip plans for.
    pub cards: Option<Vec<String>>,
    /// Also ask YesTCG (Austin) about the stores it covers.
    #[serde(default)]
    pub yestcg: bool,
    /// Rebuild complete public Shopify catalogs rather than reuse a saved catalog.
    #[serde(default)]
    pub refresh_catalog: bool,
}

/// The stores a check can read, with the connector each would use and why not when none.
pub async fn checkable(pool: &SqlitePool, owner: &str) -> AppResult<Vec<(String, String, Option<(Kind, String)>, Option<String>, String)>> {
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT s.key, s.name, s.homepage, p.preference FROM plan_stores s LEFT JOIN plan_store_prefs p ON p.owner_id = s.owner_id AND p.store_key = s.key
         WHERE s.owner_id = ? AND s.retired_at IS NULL AND s.kind != 'printer' ORDER BY s.sort, s.key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(key, name, homepage, pref)| {
            let direct = direct_connector(homepage.as_deref());
            let host = bare_host(homepage.as_deref());
            (key, name, direct, host, pref.unwrap_or_else(|| "ok".into()))
        })
        .collect())
}

/// Every card the trip would plan for, from the bundle (planned buys, proposals, the wishlist, wants).
pub fn trip_cards(bundle: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for c in super::trip::trip_wants(bundle).into_iter().map(|w| w.card) {
        if seen.insert(card_key(&c)) {
            out.push(c);
        }
    }
    out
}

/// Start a check for the owner: one snapshot per store (marked running), fetched in the background.
/// Returns the snapshot ids and anything that couldn't be checked.
/// With `change` (a staged check_stores), a check that change already started is returned as it
/// is, so applying it again reads nothing.
pub async fn start(st: &AppState, owner: &str, body: &CheckBody, via: &str, change: Option<&str>) -> AppResult<Value> {
    let pool = &st.pool;
    // One admission at a time, so two checks can't both see none running.
    static ADMIT: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _admit = ADMIT.get_or_init(Default::default).lock().await;
    if let Some(c) = change {
        let done: Vec<(String, String, String)> = sqlx::query_as("SELECT id, store_key, source FROM store_snapshots WHERE owner_id = ? AND change_id = ? ORDER BY id")
            .bind(owner)
            .bind(c)
            .fetch_all(pool)
            .await?;
        if !done.is_empty() {
            let ids: Vec<Value> = done.into_iter().map(|(id, store, source)| json!({"id": id, "store": store, "source": source})).collect();
            return Ok(json!({"snapshots": ids, "skipped": [], "cards": Value::Null, "already": true}));
        }
    }
    // A staged change already carried out answers above, offline too; a new check would fetch.
    if st.cfg.offline {
        return Err(crate::error::offline("the stores' sites"));
    }
    expire_stale(pool, owner).await?;
    let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ? AND status = 'running'").bind(owner).fetch_one(pool).await?;
    if running > 0 {
        return Err(AppError::Conflict("A store check is already running; wait for it to finish.".into()));
    }
    let cards: Vec<String> = match &body.cards {
        Some(c) => c.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        None if body.refresh_catalog => Vec::new(),
        None => {
            let bundle = super::bundle::load_bundle(pool, owner).await?;
            trip_cards(&bundle)
        }
    };
    let mut uniq = Vec::new();
    let mut seen = HashSet::new();
    for c in cards {
        if c.chars().count() > 200 {
            return Err(AppError::bad("A card name is at most 200 characters."));
        }
        if seen.insert(card_key(&c)) {
            uniq.push(c);
        }
    }
    if uniq.len() > MAX_CARDS {
        return Err(AppError::bad(format!("At most {MAX_CARDS} cards in one check ({} given).", uniq.len())));
    }
    let stores = checkable(pool, owner).await?;
    if let Some(keys) = &body.stores {
        for k in keys {
            if !stores.iter().any(|s| &s.0 == k) {
                return Err(AppError::bad(format!("No store with key \"{k}\"")));
            }
        }
    }
    let chosen: Vec<_> = stores
        .iter()
        .filter(|s| match &body.stores {
            Some(keys) => keys.contains(&s.0),
            None => s.4 != "never",
        })
        .collect();
    let mut targets: Vec<(String, Kind, String, Option<String>)> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for (key, name, direct, host, _) in &chosen {
        let mut any = false;
        if let Some((kind, base)) = direct {
            // A whole catalog doesn't need a card list; a card search does.
            if *kind == Kind::Pro || (*kind == Kind::Shopify && body.refresh_catalog) || !uniq.is_empty() {
                targets.push((key.clone(), *kind, base.clone(), None));
                any = true;
            }
        }
        if body.yestcg && !uniq.is_empty() && host.is_some() {
            targets.push((key.clone(), Kind::YesTcg, YESTCG.to_string(), host.clone()));
            any = true;
        }
        if !any {
            let why = if direct.is_none() && !body.yestcg {
                "Yama can't read this store's stock: record a stock check or import a snapshot"
            } else if uniq.is_empty() {
                "no cards to look for"
            } else {
                "Yama can't read this store's stock"
            };
            skipped.push(json!({"store": key, "name": name, "why": why}));
        }
    }
    if targets.is_empty() {
        return Ok(json!({"snapshots": [], "skipped": skipped, "cards": uniq.len()}));
    }
    let since = stamp(Utc::now() - Days::hours(24));
    let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ? AND source != 'import' AND requested_at >= ?")
        .bind(owner)
        .bind(&since)
        .fetch_one(pool)
        .await?;
    if used + targets.len() as i64 > DAILY_SNAPSHOTS {
        return Err(AppError::TooManyRequests {
            message: format!("At most {DAILY_SNAPSHOTS} store reads a day; {used} used in the last 24 hours. Try fewer stores, or later."),
            retry_after: 3600,
        });
    }
    let at = now();
    let check = crate::util::new_id();
    let mut job = Job { refresh_catalog: body.refresh_catalog, owner: owner.to_string(), cards: uniq.clone(), targets: Vec::new() };
    let mut tx = pool.begin().await?;
    for (key, kind, base, host) in targets {
        let id = crate::util::new_id();
        active().lock().expect("active").insert(id.clone());
        let query = match kind {
            Kind::Shopify if body.refresh_catalog => format!("Refresh full public catalog: GET {base}/products.json?limit=250&page=<page>; atomically cache after all pages"),
            Kind::Shopify => format!("Use dated catalog cache when available; otherwise GET {base}/search/suggest.json?q=\"<card>\"&resources[type]=product&resources[limit]=10, then /products/<handle>.js"),
            Kind::Pro => format!("POST {base}/api/catalog/search {{\"query\":\"\",\"context\":{{\"productLineName\":\"Magic: The Gathering\"}},\"size\":5000}}"),
            Kind::YesTcg => format!("GET {base}/api/decksearch?q=<card>&market=austin&game=mtg (this store's part, {})", host.as_deref().unwrap_or("?")),
        };
        let cards = (kind != Kind::Pro).then(|| json!(uniq).to_string());
        sqlx::query("INSERT INTO store_snapshots (id, owner_id, store_key, source, cards, query, requested_at, status, via, change_id, check_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
            .bind(&id)
            .bind(owner)
            .bind(&key)
            .bind(kind.source())
            .bind(cards)
            .bind(&query)
            .bind(&at)
            .bind(via)
            .bind(change)
            .bind(&check)
            .execute(&mut *tx)
            .await?;
        job.targets.push(Target { snapshot: id, store: key, kind, base, host });
    }
    tx.commit().await?;
    let ids: Vec<Value> = job.targets.iter().map(|t| json!({"id": t.snapshot, "store": t.store, "source": t.kind.source()})).collect();
    tokio::spawn(run(pool.clone(), st.http.clone(), job, Some(Duration::from_millis(1))));
    Ok(json!({"snapshots": ids, "skipped": skipped, "cards": uniq.len()}))
}

/// `POST /api/plan/stock/check`: read the stores' stock now, in the background.
pub async fn check_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<CheckBody>) -> AppResult<Json<Value>> {
    Ok(Json(start(&st, &user.id, &body, "page", None).await?))
}

/// A check cut off by a restart (or a task that died) is over: it shows as failed.
async fn expire_stale(pool: &SqlitePool, owner: &str) -> AppResult<()> {
    let stale = stamp(Utc::now() - Days::minutes(STALE_MINUTES));
    let running: Vec<String> = sqlx::query_scalar("SELECT id FROM store_snapshots WHERE owner_id = ? AND status = 'running' AND requested_at < ?")
        .bind(owner)
        .bind(&stale)
        .fetch_all(pool)
        .await?;
    let cut: Vec<String> = {
        let a = active().lock().expect("active");
        running.into_iter().filter(|id| !a.contains(id)).collect()
    };
    for id in cut {
        sqlx::query("UPDATE store_snapshots SET status = 'error', error = 'Cut off before it finished (the server restarted).' WHERE id = ? AND owner_id = ? AND status = 'running'")
            .bind(&id)
            .bind(owner)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// The owner's snapshots, newest first (without listings or raw responses).
pub async fn snapshots(pool: &SqlitePool, owner: &str, limit: i64) -> AppResult<Vec<Value>> {
    expire_stale(pool, owner).await?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, Option<String>, Option<String>, String, String, Option<String>, String, Option<String>, i64, String, bool)> = sqlx::query_as(
        "SELECT id, store_key, source, cards, failed, query, requested_at, fetched_at, status, error, item_count, via, raw_gz IS NOT NULL
         FROM store_snapshots WHERE owner_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?",
    )
    .bind(owner)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, store, source, cards, failed, query, requested, fetched, status, error, count, via, raw)| {
            let n = |s: &Option<String>| s.as_deref().and_then(|t| serde_json::from_str::<Vec<Value>>(t).ok()).map(|v| v.len());
            json!({
                "id": id, "store": store, "source": source, "cards": n(&cards), "failed": n(&failed).unwrap_or(0), "query": query,
                "requested_at": requested, "fetched_at": fetched, "status": status, "error": error, "listings": count, "via": via, "raw": raw,
            })
        })
        .collect())
}

/// `GET /api/plan/stock`: the newest snapshots, for the Trip page to follow a check.
pub async fn list_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    Ok(Json(json!({"snapshots": snapshots(&st.pool, &user.id, 60).await?})))
}

// ── import ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ImportListing {
    card: String,
    title: Option<String>,
    set: Option<String>,
    set_name: Option<String>,
    number: Option<String>,
    finish: Option<String>,
    condition: Option<String>,
    language: Option<String>,
    price: Option<f64>,
    available: Option<bool>,
    qty: Option<i64>,
    #[serde(default)]
    price_is_lowest: bool,
    variant: Option<Value>,
    url: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportFile {
    format: String,
    store: String,
    source: Option<String>,
    fetched_at: String,
    query: Option<String>,
    /// The cards asked about; missing or null: the store's whole catalog.
    cards: Option<Vec<String>>,
    listings: Vec<ImportListing>,
}

/// Save a `yama-store-snapshot/1` file as a snapshot of one of the owner's stores.
pub async fn import(pool: &SqlitePool, owner: &str, f: ImportFile) -> AppResult<Value> {
    if f.format != "yama-store-snapshot/1" {
        return Err(AppError::bad("format must be \"yama-store-snapshot/1\""));
    }
    let known: Option<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ? AND key = ? AND kind != 'printer'").bind(owner).bind(&f.store).fetch_optional(pool).await?;
    if known.is_none() {
        return Err(AppError::bad(format!("No store with key \"{}\"", f.store)));
    }
    let fetched = chrono::DateTime::parse_from_rfc3339(&f.fetched_at).map_err(|_| AppError::bad("fetched_at: an RFC 3339 time, e.g. 2026-11-01T16:24:00Z"))?.with_timezone(&Utc);
    if fetched > Utc::now() + Days::minutes(10) {
        return Err(AppError::bad("fetched_at is in the future"));
    }
    if f.listings.len() > IMPORT_MAX_LISTINGS {
        return Err(AppError::bad(format!("At most {IMPORT_MAX_LISTINGS} listings in one file.")));
    }
    if f.cards.as_ref().is_some_and(|c| c.len() > 5000) {
        return Err(AppError::bad("At most 5,000 cards asked about."));
    }
    let short = |v: &Option<String>, n: usize| v.as_ref().map(|s| s.trim().chars().take(n).collect::<String>()).filter(|s| !s.is_empty());
    let mut listings = Vec::new();
    for (i, l) in f.listings.iter().enumerate() {
        if l.card.trim().is_empty() || l.card.chars().count() > 200 {
            return Err(AppError::bad(format!("listings[{i}].card: a card name, at most 200 characters")));
        }
        if l.price.is_some_and(|p| !(p.is_finite() && (0.0..=100000.0).contains(&p))) {
            return Err(AppError::bad(format!("listings[{i}].price: $0 to $100,000, or null when unknown")));
        }
        let finish = match l.finish.as_deref() {
            None => None,
            Some("nonfoil") => Some("nonfoil"),
            Some("foil") => Some("foil"),
            Some("etched") => Some("etched"),
            Some(x) => return Err(AppError::bad(format!("listings[{i}].finish: nonfoil, foil or etched, not \"{x}\""))),
        };
        if l.qty.is_some_and(|q| !(0..=100000).contains(&q)) {
            return Err(AppError::bad(format!("listings[{i}].qty: 0 to 100,000, or null when the store didn't say")));
        }
        let url = short(&l.url, 1000).filter(|u| u.starts_with("https://"));
        listings.push(Listing {
            card: l.card.trim().to_string(),
            title: short(&l.title, 300),
            set_code: short(&l.set, 12).map(|s| s.to_lowercase()),
            set_name: short(&l.set_name, 200),
            number: short(&l.number, 20),
            // A file that leaves finish or language out may still name them in the title.
            finish: finish.or_else(|| l.title.as_deref().and_then(title_finish)),
            condition: short(&l.condition, 60),
            language: short(&l.language, 40).or_else(|| l.title.as_deref().and_then(title_language)),
            price: l.price,
            available: l.available,
            qty: l.qty,
            quantity_checked_at: None,
            from_price: l.price_is_lowest,
            variant: l.variant.as_ref().and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|i| i.to_string()))).filter(|v| v.len() <= 40),
            url,
        });
    }
    let id = crate::util::new_id();
    let at = stamp(fetched);
    let query = format!("Imported ({}): {}", short(&f.source, 200).unwrap_or_else(|| "a file".into()), short(&f.query, 800).unwrap_or_default());
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO store_snapshots (id, owner_id, store_key, source, cards, query, requested_at, fetched_at, status, item_count, via)
         VALUES (?, ?, ?, 'import', ?, ?, ?, ?, 'ok', ?, 'import')",
    )
    .bind(&id)
    .bind(owner)
    .bind(&f.store)
    .bind(f.cards.as_ref().map(|c| json!(c).to_string()))
    .bind(&query)
    .bind(&at)
    .bind(&at)
    .bind(listings.len() as i64)
    .execute(&mut *tx)
    .await?;
    for l in &listings {
        save_listing(&mut tx, owner, &id, l).await?;
    }
    prune(&mut tx, owner, &f.store).await?;
    tx.commit().await?;
    Ok(json!({"id": id, "store": f.store, "fetched_at": at, "listings": listings.len()}))
}

/// `POST /api/plan/stock/import`: a `yama-store-snapshot/1` file.
pub async fn import_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, body: axum::body::Bytes) -> AppResult<Json<Value>> {
    // Imports share the account's import allowance (plan files, Mythic Tools CSVs), checked before
    // the file is parsed.
    st.limits.imports.check_user(&user)?;
    let f: ImportFile = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("not a yama-store-snapshot/1 file: {e}")))?;
    Ok(Json(import(&st.pool, &user.id, f).await?))
}

// ── for the bundle ──────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct SnapRow {
    id: String,
    store_key: String,
    source: String,
    cards: Option<String>,
    failed: Option<String>,
    fetched_at: String,
    catalog_fetched_at: Option<String>,
    status: String,
    requested_at: String,
    check_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ListRow {
    snapshot_id: String,
    card_key: String,
    title: Option<String>,
    set_code: Option<String>,
    set_name: Option<String>,
    number: Option<String>,
    finish: Option<String>,
    condition: Option<String>,
    language: Option<String>,
    price: Option<f64>,
    available: Option<bool>,
    qty: Option<i64>,
    quantity_checked_at: Option<String>,
    price_kind: String,
    variant: Option<String>,
    url: Option<String>,
}

const SOURCE_TEXT: [(&str, &str); 4] =
    [("shopify", "the store's website"), ("tcgplayer_pro", "the store's TCGplayer Pro catalog"), ("yestcg", "YesTCG's Austin search"), ("import", "an imported snapshot")];

fn english(lang: Option<&str>) -> bool {
    lang.is_none_or(|l| l.to_lowercase().starts_with("english") || l.eq_ignore_ascii_case("en"))
}

/// Quotes from the newest snapshot of each store for each wanted card (names as the plan writes
/// them), shaped like the plan's stock checks: in stock with each listing, or not in stock when it
/// asked and found none. Unknown answers give nothing. Non-English listings are left out.
pub async fn store_quotes(pool: &SqlitePool, owner: &str, wanted: &[String]) -> AppResult<Vec<Value>> {
    let mut names: HashMap<String, &String> = HashMap::new();
    for w in wanted {
        names.entry(card_key(w)).or_insert(w);
    }
    if names.is_empty() {
        return Ok(vec![]);
    }
    let mut snaps: Vec<SnapRow> = sqlx::query_as(
        "SELECT id, store_key, source, cards, failed, fetched_at, catalog_fetched_at, status, requested_at, check_id FROM store_snapshots
         WHERE owner_id = ? AND status IN ('ok', 'partial') AND fetched_at IS NOT NULL",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    // Newest answer first, by when each store was read. One check that read a store both directly
    // and through YesTCG counts once, from the later of the two, with YesTCG's answer first. Other
    // stores in the same check don't matter: they say nothing about this store's stock.
    // A check is its check_id (rows from before it was recorded: their request time), per store.
    let group = |s: &SnapRow| format!("{}|{}", s.check_id.clone().unwrap_or_else(|| format!("at:{}", s.requested_at)), s.store_key);
    let mut check_done: HashMap<String, String> = HashMap::new();
    for s in snaps.iter().filter(|s| s.source != "import") {
        let e = check_done.entry(group(s)).or_default();
        if s.fetched_at > *e {
            *e = s.fetched_at.clone();
        }
    }
    let answered = |s: &SnapRow| if s.source == "import" { s.fetched_at.clone() } else { check_done[&group(s)].clone() };
    snaps.sort_by(|a, b| {
        answered(b)
            .cmp(&answered(a))
            .then((b.source == "yestcg").cmp(&(a.source == "yestcg")))
            .then(b.fetched_at.cmp(&a.fetched_at))
            .then(b.id.cmp(&a.id))
    });
    // A whole catalog read only in part (a page failed) answers for nothing: a page not read may
    // hold another printing of a card, or the card itself, so an older full read still counts.
    // For each (store, card): the newest snapshot that answered for it, by the check it came from;
    // when one check read a store both directly and through YesTCG (which they asked for, and which
    // gives condition and quantity), YesTCG's answer comes first, the store's own for the rest.
    let mut pick: HashMap<(String, String), usize> = HashMap::new();
    for (i, s) in snaps.iter().enumerate() {
        let failed: HashSet<String> = s.failed.as_deref().and_then(|t| serde_json::from_str::<Vec<String>>(t).ok()).unwrap_or_default().iter().map(|c| card_key(c)).collect();
        let asked: Option<HashSet<String>> = s.cards.as_deref().and_then(|t| serde_json::from_str::<Vec<String>>(t).ok()).map(|v| v.iter().map(|c| card_key(c)).collect());
        for k in names.keys() {
            let whole_in_part = s.cards.is_none() && s.status == "partial";
            let covers = asked.as_ref().is_none_or(|a| a.contains(k)) && !failed.contains(k) && !whole_in_part;
            if covers {
                pick.entry((s.store_key.clone(), k.clone())).or_insert(i);
            }
        }
    }
    let used: Vec<&String> = {
        let mut ids: Vec<usize> = pick.values().copied().collect();
        ids.sort_unstable();
        ids.dedup();
        ids.into_iter().map(|i| &snaps[i].id).collect()
    };
    let keys: Vec<&String> = names.keys().collect();
    let rows: Vec<ListRow> = sqlx::query_as(
        "SELECT snapshot_id, card_key, title, set_code, set_name, number, finish, condition, language, price, available, qty, quantity_checked_at, price_kind, variant, url
         FROM store_listings WHERE owner_id = ? AND snapshot_id IN (SELECT value FROM json_each(?)) AND card_key IN (SELECT value FROM json_each(?))
         ORDER BY snapshot_id, card_key, price IS NULL, price, title",
    )
    .bind(owner)
    .bind(serde_json::to_string(&used).map_err(anyhow::Error::from)?)
    .bind(serde_json::to_string(&keys).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let mut by: HashMap<(&str, &str), Vec<&ListRow>> = HashMap::new();
    for r in &rows {
        by.entry((r.snapshot_id.as_str(), r.card_key.as_str())).or_default().push(r);
    }
    let mut picks: Vec<(&(String, String), &usize)> = pick.iter().collect();
    picks.sort();
    let mut out = Vec::new();
    for ((store, key), i) in picks {
        let s = &snaps[*i];
        let card = names[key];
        let source = format!(
            "{} ({}), read {}",
            SOURCE_TEXT.iter().find(|x| x.0 == s.source).map_or(s.source.as_str(), |x| x.1),
            if s.source == "import" { "imported" } else { "fetched by Yama" },
            s.catalog_fetched_at.as_deref().unwrap_or(&s.fetched_at)
        );
        let base = json!({
            "swap": null, "card": card, "kind": "stock_check", "store": store, "store_label": null, "checked": s.catalog_fetched_at.as_deref().unwrap_or(&s.fetched_at),
            "price_from_text": false, "currency": "USD", "printing_from_text": false, "scryfall_id": null,
            "source": source, "origin": format!("snapshot:{}", s.id),
        });
        let listed: Vec<&&ListRow> = by.get(&(s.id.as_str(), key.as_str())).map(|v| v.iter().filter(|r| r.available != Some(false) && r.qty != Some(0) && english(r.language.as_deref())).collect()).unwrap_or_default();
        if listed.is_empty() {
            let mut q = base.clone();
            q["result"] = json!(if s.cards.is_none() { "Not in the store's catalog" } else { "Not found in stock" });
            q["in_stock"] = json!(false);
            for k in ["price", "printing", "set", "num", "variant", "url"] {
                q[k] = Value::Null;
            }
            out.push(q);
            continue;
        }
        for r in listed {
            let mut q = base.clone();
            let mut words: Vec<String> = Vec::new();
            if let Some(c) = &r.condition {
                words.push(c.clone());
            }
            match r.finish.as_deref() {
                Some("foil") => words.push("foil".into()),
                Some("etched") => words.push("etched foil".into()),
                Some(_) => words.push("non-foil".into()),
                None => {}
            }
            if let Some(n) = r.qty {
                words.push(format!("{n} in stock"));
                if let Some(at) = &r.quantity_checked_at { words.push(format!("quantity checked {at}")); }
            }
            if r.price_kind == "from" {
                words.push("lowest listed price; condition and finish not given".into());
            }
            let title = r.title.clone().unwrap_or_else(|| card.clone());
            q["result"] = json!(if words.is_empty() { title } else { format!("{title} ({})", words.join(", ")) });
            // A listing that didn't say whether it's available is unknown stock: ask the store.
            q["in_stock"] = json!(r.available);
            q["price"] = json!(r.price);
            q["printing"] = json!(match (&r.set_code, &r.number) {
                (Some(c), Some(n)) => Some(format!("{} {n}", c.to_uppercase())),
                _ => r.set_name.clone(),
            });
            q["set"] = json!(r.set_code);
            q["num"] = json!(r.number.as_ref().filter(|_| r.set_code.is_some()));
            q["variant"] = json!(r.variant);
            q["url"] = json!(r.url);
            q["qty"] = json!(r.qty);
            if let Some(at) = &r.quantity_checked_at { q["quantity_checked_at"] = json!(at); }
            out.push(q);
        }
    }
    Ok(out)
}

/// `get_store_stock`: one store's newest answers for the given cards, in words.
pub async fn stock_text(pool: &SqlitePool, owner: &str, store: &str, store_name: &str, cards: &[String]) -> AppResult<String> {
    use std::fmt::Write as _;
    let quotes = store_quotes(pool, owner, cards).await?;
    let mut out = String::new();
    let snaps = snapshots(pool, owner, 200).await?;
    let mine: Vec<&Value> = snaps.iter().filter(|s| s["store"] == store).collect();
    match mine.first() {
        None => {
            let _ = writeln!(out, "No stock snapshot of {store_name} yet. Stage check_stores to read it (they apply it in Yama).");
        }
        Some(s) => {
            let _ = writeln!(
                out,
                "Newest snapshot of {store_name}: {} ({}), {} listings{}.",
                s["fetched_at"].as_str().or_else(|| s["requested_at"].as_str()).unwrap_or("?"),
                s["status"].as_str().unwrap_or("?"),
                s["listings"],
                s["error"].as_str().map(|e| format!("; problems: {e}")).unwrap_or_default()
            );
        }
    }
    out.push_str("A listing is a dated quote, not a purchase or proof it's still there. A missing price is unknown.\n");
    for c in cards {
        let k = card_key(c);
        let mine: Vec<&Value> = quotes.iter().filter(|q| q["store"] == store && card_key(q["card"].as_str().unwrap_or_default()) == k).collect();
        if mine.is_empty() {
            let _ = writeln!(out, "- {c}: no answer from this store (not checked, or the check failed).");
            continue;
        }
        for q in mine {
            let price = q["price"].as_f64().map_or("price unknown".to_string(), |p| format!("${p:.2}"));
            if q["in_stock"] == true {
                let _ = writeln!(out, "- {c}: {price}, {} [{}]", q["result"].as_str().unwrap_or_default(), q["checked"].as_str().unwrap_or_default());
            } else if q["in_stock"].is_null() {
                let _ = writeln!(
                    out,
                    "- {c}: {price}, {}; the listing didn't say whether it's in stock, so ask the store [{}]",
                    q["result"].as_str().unwrap_or_default(),
                    q["checked"].as_str().unwrap_or_default()
                );
            } else {
                let _ = writeln!(out, "- {c}: {} [{}]", q["result"].as_str().unwrap_or("not in stock"), q["checked"].as_str().unwrap_or_default());
            }
            // Explicit-card checks also serve unapproved build previews, outside trip demand.
            // Preserve the exact listing identity so clients need not invent links or variants.
            if let Some(link) = q["url"].as_str().filter(|u| url::Url::parse(u).is_ok_and(|u| u.scheme() == "https")) {
                let _ = writeln!(out, "  Listing: {link}");
            }
            if let Some(variant) = q["variant"].as_str() {
                let _ = writeln!(out, "  Cart variant: {variant}");
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "stock/tests.rs"]
mod tests;
