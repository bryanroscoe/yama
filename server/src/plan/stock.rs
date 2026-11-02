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
/// Pages of 5,000 products read from a TCGplayer Pro catalog.
const PRO_PAGES: usize = 8;
/// Listings in an imported file.
pub const IMPORT_MAX_LISTINGS: usize = 20000;

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
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
    pub from_price: bool,
    pub variant: Option<String>,
    pub url: Option<String>,
}

/// A store's product title before ` [` or ` (`, without a "MTG - " prefix.
fn title_name(title: &str) -> &str {
    let t = title.trim();
    let t = t.strip_prefix("MTG - ").unwrap_or(t);
    let end = [t.find(" ["), t.find(" (")].into_iter().flatten().min().unwrap_or(t.len());
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
    if !items.iter().all(|p| p["title"].is_string() && p["handle"].is_string()) {
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

/// Every variant of a Shopify product (`/products/<handle>.js`) as listings for the card.
pub fn shopify_product(body: &Value, card: &str, base: &str, handle: &str) -> Vec<Listing> {
    let title = body["title"].as_str().unwrap_or_default();
    if !same_card(title_name(title), card) {
        return vec![];
    }
    let (set_code, number) = set_and_number(title);
    let lower = title.to_lowercase();
    let style_foil = lower.contains("etched") || lower.contains(" foil");
    let empty = vec![];
    body["variants"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|v| {
            let vt = v["title"].as_str().or_else(|| v["public_title"].as_str()).unwrap_or_default();
            let (condition, language, mut finish) = variant_parts(vt);
            if finish == "nonfoil" && style_foil {
                finish = if lower.contains("etched") { "etched" } else { "foil" };
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
                from_price: false,
                variant: v["id"].as_i64().map(|i| i.to_string()).or_else(|| v["id"].as_str().map(String::from)),
                url: Some(format!("{base}/products/{handle}")),
            }
        })
        .collect()
}

/// A TCGplayer Pro catalog answer: (total products, listings, one per product at its lowest price).
pub fn pro_catalog(body: &Value, base: &str) -> Option<(i64, Vec<Listing>)> {
    // An answer without the catalog's fields isn't an empty catalog: it's one we can't read.
    let total = body["products"]["totalItems"].as_i64()?;
    let items = body["products"]["items"].as_array()?;
    // So is a page with a product that has no name: it may be the card wanted.
    if !items.iter().all(|p| p["name"].is_string()) {
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
            let lower = name.to_lowercase();
            let finish = if lower.contains("etched") {
                Some("etched")
            } else if lower.contains("(foil") || lower.contains(" foil)") {
                Some("foil")
            } else {
                None
            };
            let url = match (p["setUrlName"].as_str(), p["productUrlName"].as_str(), p["id"].as_i64()) {
                (Some(s), Some(n), Some(id)) => Some(format!("{base}/catalog/magic/{s}/{n}/{id}")),
                _ => None,
            };
            Some(Listing {
                card: card.to_string(),
                title: Some(name.to_string()),
                set_name: p["setName"].as_str().map(String::from),
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
    // So is a hit without a name, or with a price that isn't a number.
    if !hits.iter().all(|h| h["name"].is_string() && (h["price"].is_number() || h["price"].is_null())) {
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
            if finish == "nonfoil" && name.to_lowercase().contains("foil") {
                finish = "foil";
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
}

impl Fetcher {
    pub fn new(http: reqwest::Client, pause: Option<Duration>) -> Self {
        Fetcher { http, pause: pause.unwrap_or(Duration::ZERO), cookie: None }
    }

    /// GET or POST with a browser's headers, retrying 429 and 5xx twice. Records every answer.
    async fn send(&mut self, kind: Kind, method: &str, url: &str, body: Option<&Value>, raw: &mut Raw) -> Result<Value, String> {
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).ok_or("bad url")?;
        let pause = if self.pause.is_zero() { Duration::ZERO } else { kind.pause().max(self.pause) };
        let mut last = String::new();
        for attempt in 0..3u32 {
            let guard = pace(&host, pause).await;
            let mut req = if method == "POST" { self.http.post(url) } else { self.http.get(url) };
            req = req.header("User-Agent", BROWSER_UA).header("Accept", "application/json").timeout(Duration::from_secs(60));
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
            let sent = req.send().await;
            let mut guard = guard;
            *guard = Instant::now();
            drop(guard);
            match sent {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    raw.add(method, url, status, &text);
                    if (200..300).contains(&status) {
                        return serde_json::from_str(&text).map_err(|_| format!("{url}: the answer wasn't JSON"));
                    }
                    last = format!("{url}: HTTP {status}");
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
    async fn yestcg_cookie(&mut self, base: &str, raw: &mut Raw) {
        let host = url::Url::parse(base).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let _g = pace(&host, if self.pause.is_zero() { Duration::ZERO } else { Kind::YesTcg.pause() }).await;
        if let Ok(resp) = self.http.get(format!("{base}/")).header("User-Agent", BROWSER_UA).timeout(Duration::from_secs(30)).send().await {
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
    }
}

/// What a connector found: listings, the cards whose answer is unknown, and errors.
#[derive(Default)]
pub struct Found {
    pub listings: Vec<Listing>,
    pub failed: Vec<String>,
    pub errors: Vec<String>,
    pub total: Option<i64>,
}

/// Every printing a Shopify store lists for each card.
async fn fetch_shopify(f: &mut Fetcher, base: &str, cards: &[String], raw: &mut Raw) -> Found {
    let mut out = Found::default();
    for card in cards {
        let front = card.split(" // ").next().unwrap_or(card).trim();
        let mut handles: Vec<(String, String)> = Vec::new();
        let mut ok = false;
        let mut missed = false;
        let mut saturated = false;
        let mut queries = vec![format!("\"{front}\"")];
        let mut i = 0;
        while i < queries.len() {
            let mut u = url::Url::parse(&format!("{base}/search/suggest.json")).expect("base");
            u.query_pairs_mut().append_pair("q", &queries[i]).append_pair("resources[type]", "product").append_pair("resources[limit]", "10");
            match f.send(Kind::Shopify, "GET", u.as_str(), None, raw).await {
                Ok(body) => {
                    let Some((n, found)) = shopify_suggest(&body, card) else {
                        out.errors.push(format!("{}: an answer without a product list", u.as_str()));
                        missed = true;
                        i += 1;
                        continue;
                    };
                    ok = true;
                    for h in found {
                        if !handles.iter().any(|x| x.0 == h.0) {
                            handles.push(h);
                        }
                    }
                    // Suggest stops at 10 products; ask again for those in stock only. If that's
                    // full too, some in-stock printings may be missing.
                    if i == 0 && n >= 10 {
                        queries.push(format!("title:\"{front}\" available:true"));
                    } else if n >= 10 {
                        saturated = true;
                    }
                }
                Err(e) => {
                    out.errors.push(e);
                    missed = true;
                }
            }
            i += 1;
        }
        if !ok {
            out.failed.push(card.clone());
            continue;
        }
        // A search or printing that couldn't be read may be the one in stock: the card is unknown
        // unless a copy was found anyway.
        let mut product_failed = missed;
        for (handle, _) in &handles {
            match f.send(Kind::Shopify, "GET", &format!("{base}/products/{handle}.js"), None, raw).await {
                // Every variant must say whether it's available and its price, or the product is unreadable.
                Ok(body) if body["title"].is_string() && body["variants"].as_array().is_some_and(|v| v.iter().all(|x| x["available"].is_boolean() && x["price"].is_number())) => out.listings.extend(shopify_product(&body, card, base, handle).into_iter().filter(|l| l.available == Some(true))),
                Ok(_) => {
                    out.errors.push(format!("{base}/products/{handle}.js: an answer without readable variants"));
                    product_failed = true;
                }
                Err(e) => {
                    out.errors.push(e);
                    product_failed = true;
                }
            }
        }
        let found_any = out.listings.iter().any(|l| l.card == *card);
        if (product_failed || saturated) && !found_any {
            out.failed.push(card.clone());
        } else if saturated {
            // The copies found are real; a cheaper printing may be among those not shown.
            out.errors.push(format!("{card}: more than 10 printings in stock; Yama read the first 10"));
        }
    }
    out
}

/// A TCGplayer Pro storefront's whole in-stock Magic catalog, 5,000 products a page.
async fn fetch_pro(f: &mut Fetcher, base: &str, raw: &mut Raw) -> Found {
    let mut out = Found::default();
    let mut from = 0i64;
    for _ in 0..PRO_PAGES {
        let body = json!({"query": "", "context": {"productLineName": "Magic: The Gathering"}, "filters": {}, "from": from, "size": 5000});
        match f.send(Kind::Pro, "POST", &format!("{base}/api/catalog/search"), Some(&body), raw).await {
            Ok(answer) => {
                let Some((total, listings)) = pro_catalog(&answer, base) else {
                    out.errors.push(format!("{base}/api/catalog/search: an answer without the catalog"));
                    break;
                };
                let n = answer["products"]["items"].as_array().map_or(0, Vec::len) as i64;
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
    f.yestcg_cookie(base, raw).await;
    for card in cards {
        let front = card.split(" // ").next().unwrap_or(card).trim();
        let mut u = url::Url::parse(&format!("{base}/api/decksearch")).expect("base");
        u.query_pairs_mut().append_pair("q", front).append_pair("market", "austin").append_pair("game", "mtg");
        match f.send(Kind::YesTcg, "GET", u.as_str(), None, raw).await {
            Ok(body) => {
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
    sqlx::query("UPDATE store_snapshots SET status = ?, error = ?, fetched_at = ?, failed = ?, raw_gz = ?, item_count = ? WHERE id = ? AND owner_id = ?")
        .bind(status)
        .bind(error)
        .bind(now())
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
                                     price, available, qty, price_kind, variant, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(if l.from_price { "from" } else { "each" })
    .bind(&l.variant)
    .bind(&l.url)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Keep the newest `KEEP` snapshots of a store, and raw responses for the newest `RAW_KEEP`. Rows
/// from the last 24 hours always stay, since the daily cap counts them.
async fn prune(tx: &mut sqlx::SqliteConnection, owner: &str, store: &str) -> AppResult<()> {
    let day = (Utc::now() - Days::hours(24)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let old: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM (SELECT id, requested_at FROM store_snapshots WHERE owner_id = ? AND store_key = ? AND status != 'running'
                         ORDER BY requested_at DESC, id DESC LIMIT -1 OFFSET ?)
         WHERE requested_at < ?",
    )
    .bind(owner)
    .bind(store)
    .bind(KEEP)
    .bind(&day)
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
    pub owner: String,
    pub cards: Vec<String>,
    pub targets: Vec<Target>,
}

/// Run a check: each direct store on its own (hosts differ), YesTCG once for all the stores it covers.
pub async fn run(pool: SqlitePool, http: reqwest::Client, job: Job, pause: Option<Duration>) {
    let mut tasks = tokio::task::JoinSet::new();
    let yes: Vec<Target> = job.targets.iter().filter(|t| t.kind == Kind::YesTcg).cloned().collect();
    for t in job.targets.iter().filter(|t| t.kind != Kind::YesTcg).cloned() {
        let (pool, http, owner, cards) = (pool.clone(), http.clone(), job.owner.clone(), job.cards.clone());
        tasks.spawn(async move {
            let mut f = Fetcher::new(http, pause);
            let mut raw = Raw::default();
            let (found, asked) = match t.kind {
                Kind::Shopify => (fetch_shopify(&mut f, &t.base, &cards, &mut raw).await, Some(cards.len())),
                _ => (fetch_pro(&mut f, &t.base, &mut raw).await, None),
            };
            if let Err(e) = finish(&pool, &owner, &t.snapshot, &found, asked, raw.gz()).await {
                tracing::warn!(error = %e, "store snapshot not saved");
            }
        });
    }
    if let Some(first) = yes.first().cloned() {
        let (pool, http, owner, cards) = (pool.clone(), http.clone(), job.owner.clone(), job.cards.clone());
        tasks.spawn(async move {
            let mut f = Fetcher::new(http, pause);
            let mut raw = Raw::default();
            let hosts: Vec<String> = yes.iter().filter_map(|t| t.host.clone()).collect();
            let mut found = fetch_yestcg(&mut f, &first.base, &cards, &hosts, &mut raw).await;
            let gz = raw.gz();
            for t in &yes {
                let one = t.host.as_ref().and_then(|h| found.remove(h)).unwrap_or_default();
                // One YesTCG answer covers every store: the raw record goes with the first.
                let r = if t.snapshot == first.snapshot { gz.clone() } else { None };
                if let Err(e) = finish(&pool, &owner, &t.snapshot, &one, Some(cards.len()), r).await {
                    tracing::warn!(error = %e, "store snapshot not saved");
                }
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    // Finished, failed or panicked: no longer being fetched.
    let mut a = active().lock().expect("active");
    for t in &job.targets {
        a.remove(&t.snapshot);
    }
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
    expire_stale(pool, owner).await?;
    let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ? AND status = 'running'").bind(owner).fetch_one(pool).await?;
    if running > 0 {
        return Err(AppError::Conflict("A store check is already running; wait for it to finish.".into()));
    }
    let cards: Vec<String> = match &body.cards {
        Some(c) => c.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
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
            if *kind == Kind::Pro || !uniq.is_empty() {
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
    let since = (Utc::now() - Days::hours(24)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
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
    let mut job = Job { owner: owner.to_string(), cards: uniq.clone(), targets: Vec::new() };
    let mut tx = pool.begin().await?;
    for (key, kind, base, host) in targets {
        let id = crate::util::new_id();
        active().lock().expect("active").insert(id.clone());
        let query = match kind {
            Kind::Shopify => format!("GET {base}/search/suggest.json?q=\"<card>\"&resources[type]=product&resources[limit]=10, then /products/<handle>.js"),
            Kind::Pro => format!("POST {base}/api/catalog/search {{\"query\":\"\",\"context\":{{\"productLineName\":\"Magic: The Gathering\"}},\"size\":5000}}"),
            Kind::YesTcg => format!("GET {base}/api/decksearch?q=<card>&market=austin&game=mtg (this store's part, {})", host.as_deref().unwrap_or("?")),
        };
        let cards = (kind != Kind::Pro).then(|| json!(uniq).to_string());
        sqlx::query("INSERT INTO store_snapshots (id, owner_id, store_key, source, cards, query, requested_at, status, via, change_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)")
            .bind(&id)
            .bind(owner)
            .bind(&key)
            .bind(kind.source())
            .bind(cards)
            .bind(&query)
            .bind(&at)
            .bind(via)
            .bind(change)
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
    let stale = (Utc::now() - Days::minutes(STALE_MINUTES)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
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
            finish,
            condition: short(&l.condition, 60),
            language: short(&l.language, 40),
            price: l.price,
            available: l.available,
            qty: l.qty,
            from_price: l.price_is_lowest,
            variant: l.variant.as_ref().and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|i| i.to_string()))).filter(|v| v.len() <= 40),
            url,
        });
    }
    let id = crate::util::new_id();
    let at = fetched.format("%Y-%m-%dT%H:%M:%SZ").to_string();
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
pub async fn import_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(f): Json<ImportFile>) -> AppResult<Json<Value>> {
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
    status: String,
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
    let snaps: Vec<SnapRow> = sqlx::query_as(
        "SELECT id, store_key, source, cards, failed, fetched_at, status FROM store_snapshots
         WHERE owner_id = ? AND status IN ('ok', 'partial') AND fetched_at IS NOT NULL
         ORDER BY requested_at DESC, source = 'yestcg' DESC, fetched_at DESC, id DESC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    // A whole catalog read only in part (a later page failed) answers only for the cards it listed:
    // a card missing from it is unknown, not out of stock.
    let partial: Vec<&String> = snaps.iter().filter(|s| s.cards.is_none() && s.status == "partial").map(|s| &s.id).collect();
    let listed: HashSet<(String, String)> = if partial.is_empty() {
        HashSet::new()
    } else {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT DISTINCT snapshot_id, card_key FROM store_listings WHERE owner_id = ? AND snapshot_id IN (SELECT value FROM json_each(?))")
            .bind(owner)
            .bind(serde_json::to_string(&partial).map_err(anyhow::Error::from)?)
            .fetch_all(pool)
            .await?;
        rows.into_iter().collect()
    };
    // For each (store, card): the newest snapshot that answered for it, by the check it came from;
    // when one check read a store both directly and through YesTCG (which they asked for, and which
    // gives condition and quantity), YesTCG's answer comes first, the store's own for the rest.
    let mut pick: HashMap<(String, String), usize> = HashMap::new();
    for (i, s) in snaps.iter().enumerate() {
        let failed: HashSet<String> = s.failed.as_deref().and_then(|t| serde_json::from_str::<Vec<String>>(t).ok()).unwrap_or_default().iter().map(|c| card_key(c)).collect();
        let asked: Option<HashSet<String>> = s.cards.as_deref().and_then(|t| serde_json::from_str::<Vec<String>>(t).ok()).map(|v| v.iter().map(|c| card_key(c)).collect());
        for k in names.keys() {
            let in_part = !(s.cards.is_none() && s.status == "partial") || listed.contains(&(s.id.clone(), k.clone()));
            let covers = asked.as_ref().is_none_or(|a| a.contains(k)) && !failed.contains(k) && in_part;
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
        "SELECT snapshot_id, card_key, title, set_code, set_name, number, finish, condition, language, price, available, qty, price_kind, variant, url
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
            s.fetched_at
        );
        let base = json!({
            "swap": null, "card": card, "kind": "stock_check", "store": store, "store_label": null, "checked": s.fetched_at,
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
            out.push(q);
        }
    }
    Ok(out)
}

/// `store_stock`: one store's newest answers for the given cards, in words.
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
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "stock/tests.rs"]
mod tests;
