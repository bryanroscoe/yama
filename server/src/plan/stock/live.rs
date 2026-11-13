//! Store stock kept fresh in the background (docs/shopping-design.md, "Live stock"; Bryan,
//! 13 Nov 2026: "our own thing that slowly scrapes the sites without getting rate-limited ... It
//! can cache this aggressively too").
//!
//! The sourcing page names the cards it wants. They are remembered per store, and one slow reader
//! per store rereads each card every [`REREAD`] for as long as a page keeps asking
//! ([`WANTED_FOR`]). A card about to be ordered is read first, at the pace of a check a person
//! asks for. The answers are the store's public listings, so every account shares them, like the
//! catalog cache; which account wanted a card is never stored.
//!
//! However many people want cards, a store gets one request at a time from Yama, [`SLOW`] apart:
//! more wanted cards make a longer queue, never a faster one. Only stores read card by card
//! through their own connector are covered (Shopify's Storefront API). A TCGplayer Pro catalog
//! gives no conditions, and YesTCG is asked only when a person asks.

use super::*;

/// A wanted card is reread this often.
pub const REREAD: Duration = Duration::from_secs(8 * 3600);
/// A card no page has asked about for this long is no longer reread; its last answer stays.
const WANTED_FOR: Duration = Duration::from_secs(14 * 24 * 3600);
/// Between background requests to one store.
const SLOW: Duration = Duration::from_secs(4);
/// A hurried card is reread only when its answer is older than this.
const HURRY_OLDER: Duration = Duration::from_secs(30 * 60);
/// A card whose read failed is tried again after this.
const RETRY: Duration = Duration::from_secs(30 * 60);
/// Cards one request may name, and how many of them it may hurry.
pub const MAX_WANTED: usize = 2000;
pub const MAX_HURRIED: usize = 300;
/// Hurried reads per account per day (a check a person asks for allows about as many).
const HURRIED_DAILY: u64 = 6000;
/// How long a reader with nothing due waits before looking again.
const IDLE: Duration = Duration::from_secs(60);

fn ago(d: Duration) -> String {
    stamp(Utc::now() - Days::seconds(d.as_secs() as i64))
}

fn front_face(name: &str) -> &str {
    name.split(" // ").next().unwrap_or(name).trim()
}

/// Woken when a page names new or hurried cards, so a reader with nothing due starts at once.
fn wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// Hurried reads per account today, in memory: a restart forgets them.
fn hurried() -> &'static std::sync::Mutex<HashMap<String, (String, u64)>> {
    static HURRIED: OnceLock<std::sync::Mutex<HashMap<String, (String, u64)>>> = OnceLock::new();
    HURRIED.get_or_init(Default::default)
}

/// Take up to `reads` from the account's allowance for today, in one step so two requests can't
/// both spend what is left. Returns how many it got.
fn hurry_reserve(owner: &str, reads: u64) -> u64 {
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let mut map = hurried().lock().expect("hurried");
    map.retain(|_, (day, _)| *day == today);
    let used = map.entry(owner.to_string()).or_insert((today, 0));
    let granted = reads.min(HURRIED_DAILY.saturating_sub(used.1));
    used.1 += granted;
    granted
}

/// Give back reserved reads that weren't needed (their answers were new, or already waiting).
fn hurry_return(owner: &str, reads: u64) {
    if let Some(used) = hurried().lock().expect("hurried").get_mut(owner) {
        used.1 = used.1.saturating_sub(reads);
    }
}

/// Remember that these cards (key, name) are wanted at these stores, and mark the `hurry` keys
/// whose answer is older than [`HURRY_OLDER`] to be read first. Returns how many reads it hurried.
pub async fn want(pool: &SqlitePool, bases: &[String], cards: &[(String, String)], hurry: &[String]) -> AppResult<u64> {
    let named = serde_json::to_string(&cards.iter().map(|(key, name)| json!([key, name])).collect::<Vec<_>>()).map_err(anyhow::Error::from)?;
    let hurry_keys = serde_json::to_string(hurry).map_err(anyhow::Error::from)?;
    // A page asks again every time it looks; an hour-old mark is new enough.
    let (at, recent, old) = (now(), ago(Duration::from_secs(3600)), ago(HURRY_OLDER));
    let mut hurried = 0;
    let mut tx = pool.begin().await?;
    for base in bases {
        sqlx::query(
            "INSERT INTO store_live (base, card_key, card_name, wanted_at)
             SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?3 FROM json_each(?2) j WHERE true
             ON CONFLICT (base, card_key) DO UPDATE SET wanted_at = excluded.wanted_at WHERE store_live.wanted_at < ?4",
        )
        .bind(base)
        .bind(&named)
        .bind(&at)
        .bind(&recent)
        .execute(&mut *tx)
        .await?;
        if !hurry.is_empty() {
            // Not one already waiting to be read first.
            hurried += sqlx::query(
                "UPDATE store_live SET rush_at = ?1 WHERE base = ?2 AND card_key IN (SELECT value FROM json_each(?3))
                 AND (checked_at IS NULL OR checked_at < ?4) AND (rush_at IS NULL OR (checked_at IS NOT NULL AND rush_at <= checked_at))",
            )
            .bind(&at)
            .bind(base)
            .bind(&hurry_keys)
            .bind(&old)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        }
    }
    tx.commit().await?;
    wake().notify_waiters();
    Ok(hurried)
}

fn listing_json(l: &Listing) -> Value {
    json!({
        "title": l.title, "set": l.set_name, "set_code": l.set_code, "number": l.number, "finish": l.finish,
        "condition": l.condition, "language": l.language, "price": l.price, "variant": l.variant, "url": l.url,
    })
}

/// What one turn of a store's reader did.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    /// A card was read and its answer saved.
    Read,
    /// A card's read gave no answer; its last answer stays.
    Failed,
    /// Nothing is due.
    Idle,
    /// The store doesn't answer card searches.
    Unsupported,
}

/// Read the store's next due card: a hurried one first, then one never read, then the one read
/// longest ago. A card whose last read failed waits [`RETRY`]. `slow` is the pause before a
/// background read; a hurried one waits only the store kind's own pause.
pub(super) async fn step(pool: &SqlitePool, f: &mut Fetcher, base: &str, slow: Duration) -> AppResult<Step> {
    let due: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT card_key, card_name, (rush_at IS NOT NULL AND rush_at > IFNULL(checked_at, '')) AS hurried FROM store_live
         WHERE base = ?1 AND wanted_at >= ?2
           AND (checked_at IS NULL OR checked_at < ?3 OR (rush_at IS NOT NULL AND rush_at > checked_at))
           AND (tried_at IS NULL OR tried_at <= IFNULL(checked_at, '') OR tried_at < ?4)
         ORDER BY hurried DESC, checked_at IS NOT NULL, checked_at, card_key LIMIT 1",
    )
    .bind(base)
    .bind(ago(WANTED_FOR))
    .bind(ago(REREAD))
    .bind(ago(RETRY))
    .fetch_optional(pool)
    .await?;
    let Some((key, name, hurried)) = due else { return Ok(Step::Idle) };
    f.pause = if hurried != 0 { slow.min(Duration::from_millis(1)) } else { slow };
    let mut raw = Raw::default();
    let (listings, error, step) = match storefront_card(f, base, &name, &mut raw).await {
        Storefront::Found(listings) => (Some(listings), None, Step::Read),
        Storefront::Unknown(e) => (None, Some(e), Step::Failed),
        Storefront::Unsupported => (None, Some(format!("{base}{STOREFRONT_PATH}: the store doesn't answer card searches")), Step::Unsupported),
    };
    let at = now();
    match listings {
        Some(listings) => {
            let text = Value::Array(listings.iter().map(listing_json).collect()).to_string();
            sqlx::query("UPDATE store_live SET checked_at = ?1, tried_at = ?1, error = NULL, listings = ?2 WHERE base = ?3 AND card_key = ?4")
                .bind(&at)
                .bind(text)
                .bind(base)
                .bind(&key)
                .execute(pool)
                .await?;
        }
        None => {
            sqlx::query("UPDATE store_live SET tried_at = ?1, error = ?2 WHERE base = ?3 AND card_key = ?4")
                .bind(&at)
                .bind(error.map(|e| e.chars().take(300).collect::<String>()))
                .bind(base)
                .bind(&key)
                .execute(pool)
                .await?;
        }
    }
    Ok(step)
}

/// One store's reader, for as long as the server runs. A failed read backs off (a minute, doubling
/// to sixteen); a 429 is never asked again within the attempt, since that only lengthens the hold
/// the store puts on every other request from Yama.
async fn read_store(pool: SqlitePool, http: reqwest::Client, base: String, slow: Duration) {
    let mut f = Fetcher::new(http, Some(slow));
    // The store's answer now, not one another check fetched most of an hour ago.
    f.refresh = true;
    f.first_429 = true;
    let mut failures: u32 = 0;
    loop {
        let wait = match step(&pool, &mut f, &base, slow).await {
            Ok(Step::Read) => {
                failures = 0;
                continue;
            }
            Ok(Step::Idle) => {
                tokio::select! {
                    _ = tokio::time::sleep(IDLE) => {}
                    _ = wake().notified() => {}
                }
                continue;
            }
            Ok(Step::Failed) => {
                failures = (failures + 1).min(5);
                Duration::from_secs(60 << (failures - 1))
            }
            Ok(Step::Unsupported) => Duration::from_secs(6 * 3600),
            Err(e) => {
                tracing::warn!(error = %e, store = %base, "live store stock not saved");
                Duration::from_secs(300)
            }
        };
        tokio::time::sleep(wait).await;
    }
}

/// Start a reader for each store Yama reads card by card.
pub fn spawn(pool: SqlitePool, http: reqwest::Client) {
    for host in SHOPIFY_HOSTS {
        tokio::spawn(read_store(pool.clone(), http.clone(), format!("https://{host}"), SLOW));
    }
}

#[derive(sqlx::FromRow)]
struct LiveRow {
    base: String,
    card_key: String,
    checked_at: Option<String>,
    tried_at: Option<String>,
    rush_at: Option<String>,
    error: Option<String>,
    /// Left out when the answer is older than the request's `since`.
    listings: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct LiveBody {
    /// The cards the page wants, as it names them.
    pub cards: Vec<String>,
    /// Cards about to be ordered: read first when their answer is older than half an hour.
    #[serde(default)]
    pub hurry: Vec<String>,
    /// Only answers read at or after this time (the `at` of an earlier answer); none: every answer.
    #[serde(default)]
    pub since: Option<String>,
}

/// `POST /api/plan/stock/live`: the newest answers Yama holds for these cards at the person's
/// stores, and how far the readers have got. Asking is what keeps the cards being reread.
pub async fn live_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<LiveBody>) -> AppResult<Json<Value>> {
    Ok(Json(live(&st.pool, &user.id, &body, st.cfg.offline).await?))
}

/// The answers for `body.cards` at the owner's stores (not ones marked never), with each card's
/// cheapest non-foil market for the buying rule. Only cards in Yama's card data are remembered,
/// so nothing but a card's name is ever asked of a store. Offline, it reads what is held and
/// remembers nothing new.
pub async fn live(pool: &SqlitePool, owner: &str, body: &LiveBody, offline: bool) -> AppResult<Value> {
    if body.cards.len() > MAX_WANTED {
        return Err(AppError::bad(format!("At most {MAX_WANTED} cards ({} given).", body.cards.len())));
    }
    let mut names: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for card in &body.cards {
        let card = card.trim();
        if card.is_empty() {
            continue;
        }
        if card.chars().count() > 200 {
            return Err(AppError::bad("A card name is at most 200 characters."));
        }
        if seen.insert(card_key(card)) {
            names.push((card_key(card), card.to_string()));
        }
    }
    let since = body.since.as_deref().map(str::trim).filter(|s| s.len() <= 40).unwrap_or("");
    let mut lookups: Vec<String> = Vec::new();
    for (_, name) in &names {
        lookups.push(name.clone());
        if front_face(name) != name.as_str() {
            lookups.push(front_face(name).to_string());
        }
    }
    let resolved = crate::plan::resolve_names(pool, &lookups).await?;
    let oracle = |name: &str| resolved.get(name).or_else(|| resolved.get(front_face(name)));
    let (known, unknown): (Vec<(String, String)>, Vec<(String, String)>) = names.into_iter().partition(|(_, name)| oracle(name.as_str()).is_some());
    let mut stores: Vec<(String, String, String)> = Vec::new();
    for (key, name, direct, _, preference) in checkable(pool, owner).await? {
        if let Some((Kind::Shopify, base)) = direct
            && preference != "never"
            && !stores.iter().any(|s| s.2 == base)
        {
            stores.push((key, name, base));
        }
    }
    let bases: Vec<String> = stores.iter().map(|s| s.2.clone()).collect();
    // Before the read below, so the next `since` misses nothing saved meanwhile.
    let at = now();
    let mut hurried_now = 0;
    if !offline && !bases.is_empty() && !known.is_empty() {
        let mut hurry: Vec<String> = Vec::new();
        for card in &body.hurry {
            let key = card_key(card);
            if hurry.len() < MAX_HURRIED && known.iter().any(|(k, _)| *k == key) && !hurry.contains(&key) {
                hurry.push(key);
            }
        }
        // A hurried card is one read at every store: no more cards than today's allowance covers.
        let stores_each = bases.len() as u64;
        let reserved = hurry_reserve(owner, hurry.len() as u64 * stores_each);
        hurry.truncate((reserved / stores_each) as usize);
        let wanted = want(pool, &bases, &known, &hurry).await;
        hurry_return(owner, reserved.saturating_sub(*wanted.as_ref().unwrap_or(&0)));
        hurried_now = wanted?;
    }
    let keys: Vec<&String> = known.iter().map(|(key, _)| key).collect();
    let rows: Vec<LiveRow> = sqlx::query_as(
        "SELECT base, card_key, checked_at, tried_at, rush_at, error, CASE WHEN checked_at >= ?3 THEN listings END AS listings FROM store_live
         WHERE base IN (SELECT value FROM json_each(?1)) AND card_key IN (SELECT value FROM json_each(?2))",
    )
    .bind(serde_json::to_string(&bases).map_err(anyhow::Error::from)?)
    .bind(serde_json::to_string(&keys).map_err(anyhow::Error::from)?)
    .bind(since)
    .fetch_all(pool)
    .await?;
    let fresh_from = ago(REREAD);
    let name_of: HashMap<&str, &str> = known.iter().map(|(key, name)| (key.as_str(), name.as_str())).collect();
    let mut store_rows = Vec::new();
    for (key, name, base) in &stores {
        let mine: Vec<&LiveRow> = rows.iter().filter(|r| r.base == *base).collect();
        let read: Vec<&String> = mine.iter().filter_map(|r| r.checked_at.as_ref()).collect();
        // Asked to be read first and not read or tried since.
        let hurrying = mine.iter().filter(|r| r.rush_at.as_ref().is_some_and(|rush| r.checked_at.as_ref().is_none_or(|c| rush > c) && r.tried_at.as_ref().is_none_or(|t| t < rush))).count();
        // The newest try gave no answer.
        let failed: Vec<&LiveRow> = mine.iter().copied().filter(|r| r.tried_at.as_ref().is_some_and(|t| r.checked_at.as_ref().is_none_or(|c| t > c))).collect();
        store_rows.push(json!({
            "key": key, "name": name, "origin": base, "wanted": known.len(), "read": read.len(),
            "fresh": read.iter().filter(|c| ***c >= fresh_from).count(), "hurrying": hurrying,
            "oldest": read.iter().min(), "newest": read.iter().max(),
            "failed": failed.len(), "error": failed.iter().find_map(|r| r.error.as_ref()),
            "failed_cards": failed.iter().filter_map(|r| name_of.get(r.card_key.as_str())).collect::<Vec<_>>(),
        }));
    }
    let mut answers = Vec::new();
    let mut answered: Vec<&str> = Vec::new();
    for r in &rows {
        let (Some(checked), Some(text), Some(name)) = (&r.checked_at, &r.listings, name_of.get(r.card_key.as_str()).copied()) else { continue };
        // An answer that can't be read back is unknown, never "not in stock".
        let Ok(listings) = serde_json::from_str::<Value>(text) else { continue };
        if !listings.is_array() {
            continue;
        }
        answers.push(json!({"origin": r.base, "card": name, "checked_at": checked, "listings": listings}));
        if !answered.contains(&name) {
            answered.push(name);
        }
    }
    let mut markets = serde_json::Map::new();
    if !answered.is_empty() {
        let ids: std::collections::BTreeSet<&String> = answered.iter().filter_map(|name| oracle(*name)).collect();
        let found = crate::plan::bundle::cheapest_markets(pool, &serde_json::to_string(&ids).map_err(anyhow::Error::from)?).await?;
        let by_card: HashMap<&str, &crate::plan::bundle::MarketRow> = found.iter().map(|m| (m.oracle_id.as_str(), m)).collect();
        for name in answered {
            if let Some(m) = oracle(name).and_then(|id| by_card.get(id.as_str())) {
                markets.insert(
                    name.to_string(),
                    json!({
                        "usd": m.usd, "date": m.date, "printing": format!("{} ({}) #{}", m.set_name, m.set_code.to_uppercase(), m.collector_number),
                        "source": crate::plan::bundle::MARKET_SOURCE,
                    }),
                );
            }
        }
    }
    Ok(json!({
        "at": at, "reread_hours": REREAD.as_secs() / 3600, "offline": offline, "stores": store_rows, "answers": answers, "markets": markets,
        "unknown": unknown.iter().map(|(_, name)| name).collect::<Vec<_>>(), "hurried": hurried_now,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What is left of the day's allowance is taken in one step, never spent twice.
    #[test]
    fn the_hurried_allowance_is_reserved_whole() {
        let owner = "allowance-test-account";
        assert_eq!(hurry_reserve(owner, HURRIED_DAILY - 1), HURRIED_DAILY - 1);
        assert_eq!(hurry_reserve(owner, 600), 1, "one read left, however many were asked for");
        assert_eq!(hurry_reserve(owner, 600), 0);
        hurry_return(owner, 10);
        assert_eq!(hurry_reserve(owner, 600), 10);
        assert_eq!(hurry_reserve("another-test-account", 5), 5);
    }
}
