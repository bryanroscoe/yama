//! Print-ready card images for a MakePlayingCards order (ARCHITECTURE.md, "Printing with
//! MakePlayingCards"). MPC Autofill (mpcfill.com) indexes community scans kept in Google Drive;
//! this asks its public search which images it has for each card name and returns their Drive
//! ids and what the index says about them. Yama stores no image: the web shows MPC Autofill's
//! own thumbnails, and Yama's Chrome extension downloads the full image from MPC Autofill's image
//! service into the person's own MakePlayingCards tab. Only card names are sent, never who asks.
//! mpcfill.com's API sends no CORS headers, which is why this goes through the server.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const MPCFILL: &str = "https://mpcfill.com";

/// MPC Autofill takes at most 300 queries in one search, and 1,000 cards in one lookup.
const MAX_QUERIES: usize = 300;
const MAX_LOOKUP: usize = 1000;
/// Images offered for each card, best first by MPC Autofill's own ranking.
const PER_CARD: usize = 12;
/// How long an answer is reused. The index changes slowly; a day keeps repeat visits off mpcfill.com.
const KEEP: Duration = Duration::from_secs(24 * 3600);
/// Cached card names before the oldest go.
const CACHE_MAX: usize = 5000;
const NAME_MAX: usize = 150;
/// A full 612-card project with a different back face on every card.
const MAX_NAMES: usize = 2 * 612;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/mpc/images", post(images_route))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Image {
    /// The Google Drive file id, which MPC Autofill uses as the image's id.
    pub id: String,
    pub name: String,
    pub source: String,
    pub dpi: Option<u32>,
    pub size: Option<u64>,
    pub ext: Option<String>,
}

#[derive(Deserialize)]
struct ImagesBody {
    cards: Vec<String>,
    #[serde(default)]
    cardbacks: bool,
}

/// MPC Autofill's search key for a card name, as `mpcQuery` in packages/core makes it.
fn query(card: &str) -> String {
    card.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[derive(Default)]
struct Cache {
    cards: HashMap<String, (Instant, Vec<Image>)>,
    sources: HashMap<String, (Instant, Vec<i64>)>,
    cardbacks: HashMap<String, (Instant, Vec<Image>)>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

fn fresh<T: Clone>(m: &HashMap<String, (Instant, T)>, key: &str) -> Option<T> {
    m.get(key).filter(|(at, _)| at.elapsed() < KEEP).map(|(_, v)| v.clone())
}

fn keep<T>(m: &mut HashMap<String, (Instant, T)>, key: String, v: T) {
    if m.len() >= CACHE_MAX {
        m.retain(|_, (at, _)| at.elapsed() < KEEP);
        if m.len() >= CACHE_MAX {
            if let Some(oldest) = m.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                m.remove(&oldest);
            }
        }
    }
    m.insert(key, (Instant::now(), v));
}

fn lock() -> std::sync::MutexGuard<'static, Cache> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

fn upstream(what: &str, e: impl std::fmt::Display) -> AppError {
    tracing::warn!("MPC Autofill {what}: {e}");
    AppError::Unavailable(format!("MPC Autofill (mpcfill.com) didn't answer the {what}. Try again in a minute."))
}

async fn get_json(http: &reqwest::Client, url: String, what: &str) -> AppResult<Value> {
    let res = http.get(&url).header("accept", "application/json").timeout(Duration::from_secs(30)).send().await.map_err(|e| upstream(what, e))?;
    let res = res.error_for_status().map_err(|e| upstream(what, e))?;
    res.json().await.map_err(|e| upstream(what, e))
}

async fn post_json(http: &reqwest::Client, url: String, body: &Value, what: &str) -> AppResult<Value> {
    let res = http.post(&url).header("accept", "application/json").json(body).timeout(Duration::from_secs(60)).send().await.map_err(|e| upstream(what, e))?;
    let res = res.error_for_status().map_err(|e| upstream(what, e))?;
    res.json().await.map_err(|e| upstream(what, e))
}

/// Every source in MPC Autofill's own default order (by its key), all switched on, as its editor starts.
async fn sources(http: &reqwest::Client, base: &str) -> AppResult<Vec<i64>> {
    if let Some(s) = fresh(&lock().sources, base) {
        return Ok(s);
    }
    let v = get_json(http, format!("{base}/2/sources/"), "list of sources").await?;
    let mut pks: Vec<i64> = v["results"].as_object().map(|m| m.values().filter_map(|s| s["pk"].as_i64()).collect()).unwrap_or_default();
    pks.sort_unstable();
    pks.dedup();
    if pks.is_empty() {
        return Err(upstream("list of sources", "no sources"));
    }
    keep(&mut lock().sources, base.to_string(), pks.clone());
    Ok(pks)
}

/// MPC Autofill's default search settings: every source, any DPI, up to 30 MB, no NSFW.
fn settings(sources: &[i64]) -> Value {
    json!({
        "filterSettings": {"excludesTags": ["NSFW"], "includesTags": [], "languages": [], "maximumDPI": 1500, "maximumSize": 30, "minimumDPI": 0},
        "searchTypeSettings": {"filterCardbacks": false, "fuzzySearch": false},
        "sourceSettings": {"sources": sources.iter().map(|pk| json!([pk, true])).collect::<Vec<_>>()},
    })
}

fn image(id: &str, v: &Value) -> Option<Image> {
    let s = |k: &str| v[k].as_str().map(str::to_string);
    let valid = !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (valid && v["sourceType"].as_str().is_none_or(|t| t == "Google Drive")).then(|| Image {
        id: id.to_string(),
        name: s("name").unwrap_or_default(),
        source: s("sourceVerbose").or_else(|| s("sourceName")).or_else(|| s("source")).unwrap_or_default(),
        dpi: v["dpi"].as_u64().and_then(|d| u32::try_from(d).ok()),
        size: v["size"].as_u64(),
        ext: s("extension"),
    })
}

/// What the index says about each of `ids`, in the order given; ids it doesn't know are left out.
async fn details(http: &reqwest::Client, base: &str, ids: &[String]) -> AppResult<HashMap<String, Image>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(MAX_LOOKUP) {
        let v = post_json(http, format!("{base}/2/cards/"), &json!({"cardIdentifiers": chunk}), "image lookup").await?;
        if let Some(m) = v["results"].as_object() {
            for (id, c) in m {
                if let Some(img) = image(id, c) {
                    out.insert(id.clone(), img);
                }
            }
        }
    }
    Ok(out)
}

/// The images MPC Autofill has for each card name (by its search key), best first.
pub async fn search(http: &reqwest::Client, base: &str, cards: &[String]) -> AppResult<HashMap<String, Vec<Image>>> {
    let mut found = HashMap::new();
    let mut wanted = Vec::new();
    {
        let cache = lock();
        for q in cards.iter().map(|c| query(c)) {
            if found.contains_key(&q) || wanted.contains(&q) {
                continue;
            }
            match fresh(&cache.cards, &format!("{base}\n{q}")) {
                Some(hit) => {
                    found.insert(q, hit);
                }
                None => wanted.push(q),
            }
        }
    }
    if wanted.is_empty() {
        return Ok(found);
    }
    let settings = settings(&sources(http, base).await?);
    for chunk in wanted.chunks(MAX_QUERIES) {
        let queries: Vec<Value> = chunk.iter().map(|q| json!({"query": q, "cardType": "CARD"})).collect();
        let v = post_json(http, format!("{base}/2/editorSearch/"), &json!({"queries": queries, "searchSettings": settings}), "image search").await?;
        let mut ids: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for q in chunk {
            let hits = v["results"][q.as_str()]["CARD"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(PER_CARD).collect()).unwrap_or_default();
            ids.insert(q, hits);
        }
        let all: Vec<String> = ids.values().flatten().cloned().collect();
        let known = details(http, base, &all).await?;
        let mut cache = lock();
        for (q, hits) in ids {
            let imgs: Vec<Image> = hits.iter().filter_map(|id| known.get(id).cloned()).collect();
            keep(&mut cache.cards, format!("{base}\n{q}"), imgs.clone());
            found.insert(q.to_string(), imgs);
        }
    }
    Ok(found)
}

/// Card backs MPC Autofill offers, its own order.
pub async fn cardbacks(http: &reqwest::Client, base: &str) -> AppResult<Vec<Image>> {
    if let Some(c) = fresh(&lock().cardbacks, base) {
        return Ok(c);
    }
    let settings = settings(&sources(http, base).await?);
    let v = post_json(http, format!("{base}/2/cardbacks/"), &json!({"searchSettings": settings}), "card back search").await?;
    let ids: Vec<String> = v["cardbacks"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(PER_CARD).collect()).unwrap_or_default();
    let known = details(http, base, &ids).await?;
    let backs: Vec<Image> = ids.iter().filter_map(|id| known.get(id).cloned()).collect();
    keep(&mut lock().cardbacks, base.to_string(), backs.clone());
    Ok(backs)
}

fn first_half(name: &str) -> Option<String> {
    name.split_once(" // ").map(|(a, _)| a.trim().to_string()).filter(|a| !a.is_empty())
}

/// The answer for `cards` (each name as sent) and, when asked, the card backs.
pub async fn answer(http: &reqwest::Client, base: &str, body_cards: &[String], want_backs: bool) -> AppResult<Value> {
    let mut names: Vec<String> = Vec::new();
    for c in body_cards {
        let c = c.trim();
        if c.is_empty() || c.chars().count() > NAME_MAX {
            return Err(AppError::BadRequest(format!("Card names are 1 to {NAME_MAX} characters.")));
        }
        if !names.iter().any(|n| n == c) {
            names.push(c.to_string());
        }
    }
    if names.len() > MAX_NAMES {
        return Err(AppError::BadRequest(format!("At most {MAX_NAMES} different cards at once.")));
    }
    // A split or adventure card ("Fire // Ice") may be indexed by its first half alone.
    let mut asked = names.clone();
    asked.extend(names.iter().filter_map(|n| first_half(n)));
    let found = if names.is_empty() { HashMap::new() } else { search(http, base, &asked).await? };
    let none = Vec::new();
    let cards: BTreeMap<&str, &Vec<Image>> = names
        .iter()
        .map(|n| {
            let whole = found.get(&query(n)).filter(|v| !v.is_empty());
            let half = first_half(n).and_then(|h| found.get(&query(&h)));
            (n.as_str(), whole.or(half).unwrap_or(&none))
        })
        .collect();
    let backs = if want_backs { cardbacks(http, base).await? } else { Vec::new() };
    Ok(json!({
        "cards": cards,
        "cardbacks": backs,
        "source": "MPC Autofill (mpcfill.com)",
        "fetched_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }))
}

/// `POST /api/mpc/images` `{cards: [name], cardbacks?: bool}`: MPC Autofill's images for each name.
async fn images_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<ImagesBody>) -> AppResult<Json<Value>> {
    if st.cfg.offline {
        return Err(crate::error::offline("MPC Autofill"));
    }
    st.limits.mpc_images.check_user(&user)?;
    Ok(Json(answer(&st.http, MPCFILL, &body.cards, body.cardbacks).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get as axum_get;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SOL: &str = "1O6s0C_XyLXsrGQEhg04kSPnWhjqMMBCE";
    const SOL2: &str = "1OL6SMZsPWYv3z-9P29HOrW1F0dqOUwVC";
    const BACK: &str = "1LrVX0pUcye9n_0RtaDNVl2xPrQgn7CYf";

    /// A local stand-in for mpcfill.com that counts searches.
    async fn fake() -> (String, Arc<AtomicUsize>) {
        let searches = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let count = searches.clone();
        let app = axum::Router::new()
            .route("/2/sources/", axum_get(|| async { Json(json!({"results": {"2": {"pk": 2}, "1": {"pk": 1}}})) }))
            .route(
                "/2/editorSearch/",
                post(move |Json(b): Json<Value>| {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(b["searchSettings"]["sourceSettings"]["sources"], json!([[1, true], [2, true]]));
                        assert_eq!(b["searchSettings"]["filterSettings"]["excludesTags"], json!(["NSFW"]));
                        let mut results = serde_json::Map::new();
                        for q in b["queries"].as_array().unwrap() {
                            let q = q["query"].as_str().unwrap();
                            let hits = match q {
                                "sol ring" => json!([SOL, SOL2, "not/an id"]),
                                "fire" => json!([SOL2]),
                                _ => json!([]),
                            };
                            results.insert(q.to_string(), json!({"CARD": hits}));
                        }
                        Json(json!({"results": results}))
                    }
                }),
            )
            .route(
                "/2/cards/",
                post(|Json(b): Json<Value>| async move {
                    let mut results = serde_json::Map::new();
                    for id in b["cardIdentifiers"].as_array().unwrap() {
                        let id = id.as_str().unwrap();
                        let name = match id {
                            SOL => "Sol Ring (Dom).png",
                            SOL2 => "Sol Ring.jpg",
                            BACK => "Cardback.png",
                            _ => "Junk",
                        };
                        results.insert(id.into(), json!({"name": name, "sourceVerbose": "MrTeferi", "dpi": 1200, "size": 12652704, "extension": "png", "sourceType": "Google Drive"}));
                    }
                    Json(json!({"results": results}))
                }),
            )
            .route("/2/cardbacks/", post(|| async { Json(json!({"cardbacks": [BACK]})) }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, searches)
    }

    #[tokio::test]
    async fn finds_images_by_name_ranks_them_and_caches_the_answer() {
        let (base, searches) = fake().await;
        let http = crate::routes::http_client();
        let cards = vec!["Sol Ring".to_string(), "  sol   RING ".to_string(), "Unknown Card".to_string(), "Fire // Ice".to_string()];
        let v = answer(&http, &base, &cards, true).await.unwrap();
        let sol = v["cards"]["Sol Ring"].as_array().unwrap();
        assert_eq!(sol.iter().map(|i| i["id"].as_str().unwrap()).collect::<Vec<_>>(), [SOL, SOL2], "ranked as mpcfill gave them; a bad id is dropped");
        assert_eq!(sol[0]["name"], "Sol Ring (Dom).png");
        assert_eq!(sol[0]["source"], "MrTeferi");
        assert_eq!(sol[0]["dpi"], 1200);
        assert_eq!(v["cards"]["sol   RING"].as_array().unwrap().len(), 2, "the same search key answers both spellings");
        assert_eq!(v["cards"]["Unknown Card"], json!([]));
        assert_eq!(v["cards"]["Fire // Ice"][0]["id"], SOL2, "a split card falls back to its first half");
        assert_eq!(v["cardbacks"][0]["id"], BACK);
        assert_eq!(v["source"], "MPC Autofill (mpcfill.com)");
        assert_eq!(searches.load(Ordering::SeqCst), 1);
        answer(&http, &base, &cards, false).await.unwrap();
        assert_eq!(searches.load(Ordering::SeqCst), 1, "a repeat comes from the cache");
    }

    #[tokio::test]
    async fn refuses_bad_names() {
        let http = crate::routes::http_client();
        let long = "x".repeat(NAME_MAX + 1);
        assert!(matches!(answer(&http, "http://127.0.0.1:9", &[long], false).await, Err(AppError::BadRequest(_))));
        assert!(matches!(answer(&http, "http://127.0.0.1:9", &[" ".into()], false).await, Err(AppError::BadRequest(_))));
    }
}
