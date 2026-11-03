//! Local buylist observations, separate from market/retail prices and collection writes.
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    routes::AppState,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use chrono::{Duration as Days, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};

const HOST: &str = "https://buylist.mothershipatx.com";
const STORE: &str = "C5kMb7b7HC";
const SOURCE: &str = "https://buylist.mothershipatx.com/retailer/buylist";
const PAGE: i64 = 200;
const MAX_PAGES: i64 = 5;
const MAX_BODY: usize = 4 << 20;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/sell/mothership/{printing}", get(history).post(check))
}

#[derive(Clone, Deserialize)]
struct Copy {
    finish: String,
    condition: String,
}
impl Copy {
    fn validate(&self) -> AppResult<()> {
        if !["nonfoil", "foil", "etched"].contains(&self.finish.as_str())
            || !["NM", "LP", "MP", "HP", "DMG"].contains(&self.condition.as_str())
        {
            return Err(AppError::bad("Unknown finish or condition"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Offer {
    checked_at: String,
    source: String,
    store: String,
    status: String,
    cash_usd: Option<f64>,
    credit_usd: Option<f64>,
    quantity_limit: Option<i64>,
    product_id: Option<String>,
    variant_id: Option<String>,
    title: Option<String>,
    note: String,
}
impl Offer {
    fn empty(status: &str, note: &str) -> Self {
        Self {
            checked_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source: SOURCE.into(),
            store: "Mothership ATX".into(),
            status: status.into(),
            cash_usd: None,
            credit_usd: None,
            quantity_limit: None,
            product_id: None,
            variant_id: None,
            title: None,
            note: note.into(),
        }
    }
}

async fn observations(
    pool: &sqlx::SqlitePool,
    owner: &str,
    id: &str,
    copy: &Copy,
) -> AppResult<Vec<Offer>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT observation FROM sell_offers WHERE owner_id=? AND scryfall_id=? AND finish=? AND condition=? ORDER BY checked_at DESC, id DESC LIMIT 50")
        .bind(owner).bind(id).bind(&copy.finish).bind(&copy.condition).fetch_all(pool).await?;
    rows.iter()
        .map(|s| serde_json::from_str(s).map_err(|e| AppError::Other(e.into())))
        .collect()
}

async fn history(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Query(copy): Query<Copy>,
) -> AppResult<Json<Vec<Offer>>> {
    copy.validate()?;
    Ok(Json(observations(&st.pool, &user.id, &id, &copy).await?))
}

async fn check(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(copy): Json<Copy>,
) -> AppResult<Json<Offer>> {
    copy.validate()?;
    let recent = observations(&st.pool, &user.id, &id, &copy).await?;
    // Reopening/checking twice reuses the actual observation date. Failures never replace it.
    if let Some(offer) = recent.first() {
        if chrono::DateTime::parse_from_rfc3339(&offer.checked_at)
            .is_ok_and(|t| t > Utc::now() - Days::hours(6))
        {
            return Ok(Json(offer.clone()));
        }
    }
    if st.cfg.offline {
        return Err(crate::error::offline("Mothership's buylist"));
    }
    st.limits.search.check_user(&user)?;
    let printing: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT name,set_code,collector_number,lang FROM printings WHERE scryfall_id=?",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await?;
    let (name, set, number, lang) = printing.ok_or(AppError::NotFound("printing"))?;
    if lang != "en" {
        return Err(AppError::bad(
            "Mothership lookup currently supports English printings only",
        ));
    }
    // One check per process at a time, with a short deadline rather than an unbounded queue.
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = tokio::time::timeout(Duration::from_secs(5), GATE.acquire())
        .await
        .map_err(|_| AppError::TooManyRequests {
            message: "Mothership is busy. Try again shortly.".into(),
            retry_after: 30,
        })?
        .map_err(|_| AppError::Unavailable("Mothership lookup unavailable".into()))?;
    // Another tab may have completed this same lookup while we waited.
    if let Some(offer) = observations(&st.pool, &user.id, &id, &copy).await?.first() {
        if chrono::DateTime::parse_from_rfc3339(&offer.checked_at)
            .is_ok_and(|t| t > Utc::now() - Days::hours(6))
        {
            return Ok(Json(offer.clone()));
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(60), fetch(&name, &set, &number, &copy))
        .await
        .map_err(|_| {
            AppError::Unavailable("Mothership lookup timed out; older offers are unchanged".into())
        })??;
    sqlx::query("INSERT INTO sell_offers(id,owner_id,scryfall_id,finish,condition,checked_at,observation) VALUES(?,?,?,?,?,?,?)")
        .bind(crate::util::new_id()).bind(&user.id).bind(&id).bind(&copy.finish).bind(&copy.condition).bind(&result.checked_at)
        .bind(serde_json::to_string(&result).map_err(|e| AppError::Other(e.into()))?).execute(&st.pool).await?;
    Ok(Json(result))
}

fn client() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; Yama buylist lookup)")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .expect("buylist HTTP client")
    })
}

async fn read(path: &str, params: &[(&str, &str)]) -> AppResult<Value> {
    tokio::time::sleep(Duration::from_millis(350)).await;
    let answer: anyhow::Result<Value> = async {
        let mut url = url::Url::parse(&format!("{HOST}{path}")).expect("fixed buylist URL");
        url.query_pairs_mut().extend_pairs(params.iter().copied());
        let mut response = client().get(url).send().await?.error_for_status()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(
                bytes.len() + chunk.len() <= MAX_BODY,
                "buylist response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    .await;
    answer.map_err(|e| {
        tracing::warn!(error=%e, "buylist provider failed");
        AppError::Unavailable(
            "Mothership didn't answer. Previous checks are unchanged; try again later.".into(),
        )
    })
}

async fn fetch(name: &str, set: &str, number: &str, copy: &Copy) -> AppResult<Offer> {
    let settings = read("/retailer/store-info", &[("store_id", STORE)]).await?;
    let settings = settings
        .pointer("/store/buylist_settings")
        .ok_or_else(|| AppError::Unavailable("Mothership's settings format changed".into()))?;
    let front = name.split(" // ").next().unwrap_or(name);
    let mut params = vec![
        ("store_id", STORE),
        ("product_line", "Magic: the Gathering"),
        ("mongo", "true"),
        ("sort", "Relevance"),
        ("name", front),
        ("set", set),
        ("buylist_products", "true"),
        ("ignore_is_hot_order", "true"),
        ("override_buylist_gt_price", "true"),
        ("buylist_setting_search", "true"),
        ("no_track", "true"),
        ("with_count", "true"),
    ];
    let count = read("/saas/search", &params)
        .await?
        .get("count")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Unavailable("Mothership's search format changed".into()))?;
    if !(0..=MAX_PAGES * PAGE).contains(&count) {
        return Err(AppError::Unavailable(
            "Mothership returned too many listings to match safely".into(),
        ));
    }
    params.pop();
    let mut products = Vec::new();
    for page in 1..=(count + PAGE - 1) / PAGE {
        let page_text = page.to_string();
        let mut query = params.clone();
        query.extend([("limit", "200"), ("page", page_text.as_str())]);
        let response = read("/saas/search", &query).await?;
        let rows = response
            .get("products")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Unavailable("Mothership's listings format changed".into()))?;
        // A truncated page is unknown, not a completed negative lookup.
        if (rows.len() as i64) < (count - (page - 1) * PAGE).min(PAGE) {
            return Err(AppError::Unavailable(
                "Mothership returned an incomplete page".into(),
            ));
        }
        products.extend(rows.iter().cloned());
    }
    match_products(name, set, number, copy, settings, &products)
}

fn normalized(s: &str) -> String {
    let s = s.trim().to_lowercase();
    let n = s.trim_start_matches('0');
    if n.is_empty() { "0".into() } else { n.into() }
}
fn text_id(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|n| n.to_string()))
}
fn amount(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
}
fn collector(p: &Value) -> Option<String> {
    let mut exact = std::collections::BTreeSet::new();
    if let Some(raw) = p
        .pointer("/product_data/collector_number")
        .and_then(text_id)
        .filter(|s| !s.is_empty())
    {
        exact.insert(normalized(&raw));
    }
    let title = p["display_name"].as_str().unwrap_or("");
    for piece in title.split('(').skip(1) {
        if let Some((number, _)) = piece.split_once(')') {
            if number.starts_with(|c: char| c.is_ascii_digit())
                && number
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '★')
            {
                exact.insert(normalized(number));
            }
        }
    }
    let set = p
        .pointer("/product_data/set")
        .and_then(Value::as_str)
        .unwrap_or("");
    for v in p["variant_info"].as_array().into_iter().flatten() {
        let pieces: Vec<_> = v["sku"].as_str().unwrap_or("").split('-').collect();
        if pieces.len() >= 3
            && pieces[0].eq_ignore_ascii_case(set)
            && pieces[1].starts_with(|c: char| c.is_ascii_digit())
        {
            exact.insert(normalized(pieces[1]));
        }
    }
    if exact.len() > 1 {
        return None;
    }
    let number = p
        .pointer("/product_data/collector_number_normalized")
        .and_then(text_id)
        .filter(|s| !s.is_empty())
        .map(|s| normalized(&s));
    let specific = exact.into_iter().next();
    if let (Some(s), Some(n)) = (&specific, &number) {
        // The normalized field may omit a suffix, but must agree on the numeric stem.
        let stem: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if (n.chars().all(|c| c.is_ascii_digit()) && *n != stem)
            || (!n.chars().all(|c| c.is_ascii_digit()) && n != s)
        {
            return None;
        }
    }
    specific.or(number)
}
/// A collector number does not identify the language. Resolve the exact retail variant's SKU,
/// taking the last language token (e.g. RAINBOW-EN-JA means Japanese), plus explicit metadata.
fn english(p: &Value, v: &Value) -> Option<bool> {
    let title = p["display_name"].as_str().unwrap_or("").to_lowercase();
    let qualifiers = title.split(" (").skip(1).collect::<Vec<_>>().join(" ");
    if [
        "japanese",
        "french",
        "german",
        "spanish",
        "italian",
        "portuguese",
        "russian",
        "korean",
        "chinese",
        "phyrexian",
        "foreign",
        "non-english",
    ]
    .iter()
    .any(|s| qualifiers.contains(*s))
    {
        return Some(false);
    }
    let declared = p
        .pointer("/product_data/lang")
        .or_else(|| p.pointer("/product_data/language"))
        .and_then(Value::as_str);
    if declared.is_some_and(|s| !s.eq_ignore_ascii_case("en") && !s.eq_ignore_ascii_case("english"))
    {
        return Some(false);
    }
    let retail = p["variant_info"]
        .as_array()?
        .iter()
        .find(|r| r["id"] == v["id"])?;
    let sku = retail["sku"].as_str().unwrap_or("").to_uppercase();
    let language = sku
        .split('-')
        .skip(2)
        .filter(|s| {
            [
                "EN", "JA", "JP", "JPN", "FR", "DE", "IT", "ES", "PT", "RU", "KO", "KR", "ZH",
                "ZHS", "ZHT", "CS", "CT",
            ]
            .contains(s)
        })
        .last();
    language
        .map(|s| s == "EN")
        .or_else(|| declared.map(|_| true))
}

fn matches_name(title: &str, name: &str) -> bool {
    let title = title
        .split(" [")
        .next()
        .unwrap_or(title)
        .split(" (")
        .next()
        .unwrap_or(title);
    title.eq_ignore_ascii_case(name)
        || title.eq_ignore_ascii_case(name.split(" // ").next().unwrap_or(name))
}

fn variant_finish(p: &Value, v: &Value) -> Option<&'static str> {
    let title = v["title"].as_str()?.to_lowercase();
    let product = p["display_name"]
        .as_str()
        .unwrap_or("")
        .split(" [")
        .next()
        .unwrap_or("");
    let qualifiers = product
        .split(" (")
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let sku = p["variant_info"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == v["id"])
        .and_then(|r| r["sku"].as_str())
        .unwrap_or("")
        .to_uppercase();
    let etched =
        qualifiers.contains("etched") || sku.split('-').skip(2).any(|s| s == "ETCHED" || s == "EF");
    let selected = v["selected_finish"].as_str().map(str::to_lowercase);
    if title.contains("etched") || selected.as_deref() == Some("etched") {
        return Some("etched");
    }
    if etched {
        return (title.contains("foil") || selected.as_deref() == Some("foil")).then_some("etched");
    }
    match selected.as_deref() {
        Some("foil") => Some("foil"),
        Some("nonfoil") if !title.contains("foil") => Some("nonfoil"),
        None => Some(if title.contains("foil") {
            "foil"
        } else {
            "nonfoil"
        }),
        _ => None,
    }
}

fn variant_matches(p: &Value, v: &Value, copy: &Copy, condition: &str) -> bool {
    let title = v["title"]
        .as_str()
        .unwrap_or("")
        .replace(['-', '(', ')'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let condition = condition.to_lowercase();
    let Some(rest) = title.strip_prefix(&condition) else {
        return false;
    };
    ["", "foil", "etched", "foil etched", "etched foil"].contains(&rest.trim())
        && variant_finish(p, v) == Some(copy.finish.as_str())
}

fn match_products(
    name: &str,
    set: &str,
    number: &str,
    copy: &Copy,
    settings: &Value,
    products: &[Value],
) -> AppResult<Offer> {
    let condition = match copy.condition.as_str() {
        "NM" => "Near Mint",
        "LP" => "Lightly Played",
        "MP" => "Moderately Played",
        "HP" => "Heavily Played",
        _ => "Damaged",
    };
    let mut candidates = Vec::new();
    let mut unnumbered = false;
    let mut language_unknown = false;
    let mut language_candidates = Vec::new();
    for p in products {
        if !matches_name(p["display_name"].as_str().unwrap_or(""), name)
            || !p
                .pointer("/product_data/set")
                .and_then(Value::as_str)
                .is_some_and(|s| s.eq_ignore_ascii_case(set))
        {
            continue;
        }
        let vs: Vec<_> = p["store_pass_variant_info"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| variant_matches(p, v, copy, condition))
            .collect();
        if vs.len() != 1 {
            continue;
        }
        match english(p, vs[0]) {
            Some(true) => {}
            Some(false) => continue,
            None => {
                if collector(p).as_deref() == Some(normalized(number).as_str()) {
                    language_unknown = true;
                    language_candidates.push((p, vs[0]));
                }
                continue;
            }
        }
        match collector(p) {
            Some(n) if n == normalized(number) => candidates.push((p, vs[0])),
            None => unnumbered = true,
            _ => {}
        }
    }
    if candidates.len() > 1 {
        return Ok(Offer::empty(
            "ambiguous",
            "Multiple store listings match; check the printing with Mothership.",
        ));
    }
    let Some((p, v)) = candidates.first() else {
        if language_candidates.len() == 1 {
            let (p, v) = language_candidates[0];
            let mut result = Offer::empty(
                "check_printing",
                "Store language is unverified. These prices are conditional and excluded from the total.",
            );
            result.cash_usd = amount(&v["offer_price"]);
            result.credit_usd = amount(&v["offer_price_credit"]);
            result.product_id = p.get("id").and_then(text_id);
            result.variant_id = v.get("id").and_then(text_id);
            result.title = p["display_name"].as_str().map(str::to_owned);
            return Ok(result);
        }
        return Ok(Offer::empty(
            if unnumbered || language_unknown {
                "check_printing"
            } else {
                "unmatched"
            },
            if language_unknown {
                "The store does not identify the language. No offer counted."
            } else if unnumbered {
                "Store collector numbers are missing or conflicting. No offer counted."
            } else {
                "No exact printing, finish and condition match found. Value remains unknown."
            },
        ));
    };
    if [
        "threshold",
        "price_under_threshold",
        "price_over_threshold",
        "offer_price_quantity_threshold",
    ]
    .iter()
    .any(|k| v.get(*k).is_some())
    {
        return Ok(Offer::empty(
            "unknown",
            "This offer has quantity-based pricing; check it with Mothership.",
        ));
    }
    let floor = amount(&settings["do_not_accept_at_or_below_price"])
        .ok_or_else(|| AppError::Unavailable("Mothership's acceptance settings changed".into()))?;
    let visible = settings["product_lines"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|l| l["name"] == "Magic: the Gathering" && l["is_hidden"].as_bool() != Some(true))
        .and_then(|l| l["possible_conditions"].as_array())
        .and_then(|cs| cs.iter().find(|c| c["label"] == condition))
        .is_some_and(|c| c["visibility"].as_str().unwrap_or("All") != "Staff Only");
    let retail = p["variant_info"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == v["id"])
        .and_then(|r| amount(&r["price"]));
    let cash = amount(&v["offer_price"]);
    let credit = amount(&v["offer_price_credit"]);
    let status = match (cash, retail) {
        (Some(c), Some(r)) if c > floor && r >= c && visible => "accepting",
        (Some(_), Some(_)) => "not_accepting",
        _ => "unknown",
    };
    let mut out = Offer::empty(
        status,
        "Online indication only; Mothership confirms quantity, grading and acceptance.",
    );
    out.cash_usd = cash;
    out.credit_usd = credit;
    out.quantity_limit = settings["quantity_limit"]
        .as_i64()
        .or_else(|| settings["quantity_limit"].as_str()?.parse().ok())
        .filter(|n| *n > 0);
    // A missing limit cannot safely produce a sellable total.
    if out.quantity_limit.is_none() {
        out.status = "unknown".into();
        out.note = "Store quantity limit unavailable; check with Mothership.".into();
    }
    out.product_id = p.get("id").and_then(text_id);
    out.variant_id = v.get("id").and_then(text_id);
    out.title = p["display_name"].as_str().map(str::to_owned);
    if out.product_id.is_none() || out.variant_id.is_none() {
        out.status = "unknown".into();
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
