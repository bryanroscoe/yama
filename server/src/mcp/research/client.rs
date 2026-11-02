//! Bounded, paced public-data requests. No Yama credential, cookie or user text is forwarded.
//! Only GETs are cached; a deck sent to Spellbook is never put in a shared cache.
//!
//! A GET's answer is kept in memory (least recently used out first) and in `research_cache`
//! (migration 0061) for as long as its provider's answers stay useful ([`Provider::ttl`]), so a
//! restart or another person reuses it, and every answer says which provider it came from and
//! when. Identical requests in flight share one fetch. Each provider's requests are paced
//! ([`Research::reserve`], shared with the deck checks for Spellbook), and a person's outside
//! requests have a budget of their own ([`BUDGET`]); answers from the cache cost nothing.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum Provider {
    Scryfall,
    Spellbook,
    Edhrec,
    Moxfield,
    Archidekt,
    Rules,
}

const PROVIDERS: [Provider; 6] =
    [Provider::Scryfall, Provider::Spellbook, Provider::Edhrec, Provider::Moxfield, Provider::Archidekt, Provider::Rules];

impl Provider {
    fn base(self) -> &'static str {
        match self {
            Self::Scryfall => "https://api.scryfall.com/",
            Self::Spellbook => "https://backend.commanderspellbook.com/",
            Self::Edhrec => "https://json.edhrec.com/",
            Self::Moxfield => "https://api2.moxfield.com/",
            Self::Archidekt => "https://archidekt.com/",
            Self::Rules => "https://magic.wizards.com/",
        }
    }

    /// Who it is, for "unavailable offline" and an answer's provenance.
    pub fn name(self) -> &'static str {
        match self {
            Self::Scryfall => "Scryfall",
            Self::Spellbook => "Commander Spellbook",
            Self::Edhrec => "EDHREC",
            Self::Moxfield => "Moxfield",
            Self::Archidekt => "Archidekt",
            Self::Rules => "Wizards of the Coast",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Scryfall => "scryfall",
            Self::Spellbook => "spellbook",
            Self::Edhrec => "edhrec",
            Self::Moxfield => "moxfield",
            Self::Archidekt => "archidekt",
            Self::Rules => "rules",
        }
    }

    fn interval(self) -> Duration {
        Duration::from_millis(match self {
            Self::Scryfall => 110,
            Self::Spellbook => 4000,
            _ => 1000,
        })
    }

    /// How long an answer stays useful. Scryfall's searches carry the day's prices; a public deck
    /// can be edited; recommendations and combos move slowly; the rules page is checked about
    /// daily for a new edition, and an edition's dated text never changes.
    fn ttl(self, url: &Url) -> Duration {
        const HOUR: u64 = 3600;
        Duration::from_secs(match self {
            Self::Scryfall => 6 * HOUR,
            Self::Moxfield | Self::Archidekt => 3 * HOUR,
            Self::Spellbook | Self::Edhrec => 24 * HOUR,
            Self::Rules if url.path().ends_with(".txt") => 30 * 24 * HOUR,
            Self::Rules => 24 * HOUR,
        })
    }
}

/// The longest a request waits for its provider's next turn before it's refused instead.
const MAX_WAIT: Duration = Duration::from_secs(8);
/// A person's requests to outside sources: this many per window. Answers from the cache don't
/// count.
pub const BUDGET: (usize, Duration) = (60, Duration::from_secs(15 * 60));
/// The memory cache, in front of the stored one.
const MEMORY_ENTRIES: usize = 32;
const MEMORY_BYTES: usize = 16 << 20;
/// The stored cache, all providers together.
const STORED_BYTES: i64 = 32 << 20;

#[derive(Clone, Debug)]
pub struct Document {
    pub bytes: Arc<Vec<u8>>,
    pub provider: Provider,
    pub fetched_at: String,
    pub source: String,
    pub cached: bool,
}

impl Document {
    pub fn json(&self) -> AppResult<Value> {
        serde_json::from_slice(&self.bytes).map_err(|_| {
            AppError::Unavailable("The source returned invalid JSON; try again later.".into())
        })
    }
    pub fn text(&self) -> AppResult<&str> {
        std::str::from_utf8(&self.bytes)
            .map_err(|_| AppError::Unavailable("The source returned invalid text.".into()))
    }
    pub fn provenance(&self) -> Value {
        serde_json::json!({"provider": self.provider.name(), "source": self.source, "retrieved_at": self.fetched_at, "cached": self.cached})
    }
}

/// Recent answers, least recently used out first.
#[derive(Default)]
struct Memory {
    entries: HashMap<String, (Document, Instant, u64)>,
    tick: u64,
}

impl Memory {
    fn get(&mut self, key: &str) -> Option<Document> {
        self.tick += 1;
        let tick = self.tick;
        match self.entries.get_mut(key) {
            Some((doc, until, used)) if *until > Instant::now() => {
                *used = tick;
                Some(doc.clone())
            }
            Some(_) => {
                self.entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&mut self, key: String, doc: Document, until: Instant) {
        self.tick += 1;
        self.entries.insert(key, (doc, until, self.tick));
        let now = Instant::now();
        self.entries.retain(|_, (_, until, _)| *until > now);
        while self.entries.len() > MEMORY_ENTRIES
            || self.entries.values().map(|(d, ..)| d.bytes.len()).sum::<usize>() > MEMORY_BYTES
        {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (.., used))| *used).map(|(k, _)| k.clone()) else { break };
            self.entries.remove(&oldest);
        }
    }
}

pub struct Research {
    /// YAMA_OFFLINE: answer from the cache or not at all.
    offline: bool,
    http: reqwest::Client,
    memory: Mutex<Memory>,
    /// The stored cache; none in most tests.
    store: Option<SqlitePool>,
    /// Requests in flight, by key: a second caller waits for the first's answer.
    flights: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Each provider's turns.
    lanes: HashMap<Provider, Mutex<Lane>>,
    /// Each person's recent outside requests.
    spent: Mutex<HashMap<String, VecDeque<Instant>>>,
    #[cfg(test)]
    bases: HashMap<Provider, String>,
}

impl Default for Research {
    fn default() -> Self {
        Self {
            offline: false,
            // Never follow a provider redirect to a caller-controlled or internal destination.
            http: reqwest::Client::builder()
                .user_agent(concat!(
                    "Yama/",
                    env!("CARGO_PKG_VERSION"),
                    " (Magic research)"
                ))
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(20))
                .build()
                .expect("research HTTP client"),
            memory: Mutex::default(),
            store: None,
            flights: Mutex::default(),
            lanes: PROVIDERS.into_iter().map(|p| (p, Mutex::new(Lane { next: Instant::now(), held: Instant::now() }))).collect(),
            spent: Mutex::default(),
            #[cfg(test)]
            bases: HashMap::new(),
        }
    }
}

/// A provider's turns: the next free one, and how long a 429 holds everybody off.
struct Lane {
    next: Instant,
    held: Instant,
}

/// One fetch of a key at a time: the turn, and the map entry it goes from when nobody else is
/// waiting.
struct Flight<'a> {
    research: &'a Research,
    key: String,
    turn: Option<tokio::sync::OwnedMutexGuard<()>>,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.turn.take();
        let mut flights = self.research.flights.lock().expect("flights");
        // Ours and the map's: nobody else is waiting for this key.
        if Arc::strong_count(&self.lock) <= 2 {
            flights.remove(&self.key);
        }
    }
}

impl Research {
    /// The research client for a server that may run offline (YAMA_OFFLINE), keeping answers in
    /// `pool`'s `research_cache`.
    pub fn new(offline: bool, pool: SqlitePool) -> Self {
        Self { offline, store: Some(pool), ..Self::default() }
    }

    pub fn url(&self, provider: Provider, path: &str, query: &[(&str, String)]) -> Url {
        let base = provider.base();
        #[cfg(test)]
        let base = self
            .bases
            .get(&provider)
            .map(String::as_str)
            .unwrap_or(base);
        let mut url = Url::parse(base).expect("compiled provider URL");
        url.set_path(path);
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        url
    }

    /// A public GET. `who`: the person asking (their budget), or None for Yama itself.
    pub async fn get(
        &self,
        who: Option<&str>,
        provider: Provider,
        path: &str,
        query: &[(&str, String)],
    ) -> AppResult<Document> {
        self.fetch(who, provider, self.url(provider, path, query), None)
            .await
    }

    /// A POST, never cached or shared.
    pub async fn post(&self, who: Option<&str>, provider: Provider, path: &str, body: Value) -> AppResult<Document> {
        self.fetch(who, provider, self.url(provider, path, &[]), Some(body))
            .await
    }

    pub async fn rules_document(&self, who: Option<&str>, url: Url) -> AppResult<Document> {
        if !trusted_rules_url(&url) {
            return Err(AppError::bad(
                "The rules link is not an official Wizards HTTPS URL.",
            ));
        }
        self.fetch(who, Provider::Rules, url, None).await
    }

    /// Take `provider`'s next turn, refusing one more than `max_wait` away. Returns how long to
    /// wait for it; the caller sleeps without holding anything, then [`Research::take_turn`].
    pub fn reserve(&self, provider: Provider, max_wait: Option<Duration>) -> AppResult<Duration> {
        let mut lane = self.lanes[&provider].lock().expect("lane");
        let now = Instant::now();
        let start = lane.next.max(lane.held).max(now);
        let wait = start - now;
        if max_wait.is_some_and(|max| wait > max) {
            return Err(cooling(wait));
        }
        lane.next = start + provider.interval();
        Ok(wait)
    }

    /// Sleep `wait` for a reserved turn, then honour any 429 that came in meanwhile: wait it out
    /// too, or with `max_wait`, refuse if it's longer than that.
    async fn take_turn(&self, provider: Provider, mut wait: Duration, max_wait: Option<Duration>) -> AppResult<()> {
        loop {
            tokio::time::sleep(wait).await;
            wait = self.lanes[&provider].lock().expect("lane").held.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                return Ok(());
            }
            if max_wait.is_some_and(|max| wait > max) {
                return Err(cooling(wait));
            }
        }
    }

    /// Wait for `provider`'s next turn however far off, for a background job.
    pub async fn pace(&self, provider: Provider) {
        let wait = self.reserve(provider, None).unwrap_or_default();
        let _ = self.take_turn(provider, wait, None).await;
    }

    /// `provider` asked Yama to slow down: nobody's turn, even one already reserved, comes sooner
    /// than `wait` from now.
    pub fn hold_off(&self, provider: Provider, wait: Duration) {
        let mut lane = self.lanes[&provider].lock().expect("lane");
        lane.held = lane.held.max(Instant::now() + wait);
    }

    /// Count one outside request against `who`'s budget, or with `check_only`, just say whether
    /// there's room.
    fn spend(&self, who: &str, check_only: bool) -> AppResult<()> {
        let (limit, window) = BUDGET;
        let mut spent = self.spent.lock().expect("budget");
        let now = Instant::now();
        spent.retain(|_, times| {
            while times.front().is_some_and(|t| now.duration_since(*t) >= window) {
                times.pop_front();
            }
            !times.is_empty()
        });
        let times = spent.entry(who.to_string()).or_default();
        if times.len() >= limit {
            let retry = window.saturating_sub(now.duration_since(times[0]));
            return Err(AppError::TooManyRequests {
                message: format!("You've made {limit} requests to outside sources in {} minutes; answers Yama already has still work.", window.as_secs() / 60),
                retry_after: retry.as_secs().max(1),
            });
        }
        if !check_only {
            times.push_back(now);
        }
        Ok(())
    }

    fn remembered(&self, key: &str) -> Option<Document> {
        let mut doc = self.memory.lock().expect("memory").get(key)?;
        doc.cached = true;
        Some(doc)
    }

    /// An unexpired stored answer, brought into memory. A store that can't be read is no answer.
    async fn stored(&self, key: &str) -> Option<Document> {
        let pool = self.store.as_ref()?;
        let now = chrono::Utc::now().timestamp();
        let row: Option<(String, String, i64, Vec<u8>)> =
            match sqlx::query_as("SELECT provider, fetched_at, expires_at, body FROM research_cache WHERE key = ? AND expires_at > ?")
                .bind(key)
                .bind(now)
                .fetch_optional(pool)
                .await
            {
                Ok(row) => row,
                Err(e) => {
                    tracing::warn!(error = %e, "couldn't read the research cache");
                    return None;
                }
            };
        let (provider, fetched_at, expires_at, body) = row?;
        let provider = PROVIDERS.into_iter().find(|p| p.key() == provider)?;
        let _ = sqlx::query("UPDATE research_cache SET used_at = ? WHERE key = ?").bind(now).bind(key).execute(pool).await;
        let doc = Document { bytes: Arc::new(body), provider, fetched_at, source: key.to_string(), cached: true };
        let left = Duration::from_secs((expires_at - now).max(0) as u64);
        self.memory.lock().expect("memory").put(key.to_string(), Document { cached: false, ..doc.clone() }, Instant::now() + left);
        Some(doc)
    }

    /// Keep an answer, in memory and stored, then trim the store to its size.
    async fn keep(&self, key: &str, doc: &Document, ttl: Duration) {
        self.memory.lock().expect("memory").put(key.to_string(), doc.clone(), Instant::now() + ttl);
        let Some(pool) = &self.store else { return };
        let now = chrono::Utc::now().timestamp();
        let stored = async {
            sqlx::query(
                "INSERT INTO research_cache (key, provider, fetched_at, expires_at, used_at, body) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET provider = excluded.provider, fetched_at = excluded.fetched_at,
                     expires_at = excluded.expires_at, used_at = excluded.used_at, body = excluded.body",
            )
            .bind(key)
            .bind(doc.provider.key())
            .bind(&doc.fetched_at)
            .bind(now + ttl.as_secs() as i64)
            .bind(now)
            .bind(doc.bytes.as_slice())
            .execute(pool)
            .await?;
            sqlx::query("DELETE FROM research_cache WHERE expires_at <= ?").bind(now).execute(pool).await?;
            sqlx::query(
                "DELETE FROM research_cache WHERE key IN (
                   SELECT key FROM (SELECT key, SUM(length(body)) OVER (ORDER BY used_at DESC, key) AS kept FROM research_cache) WHERE kept > ?)",
            )
            .bind(STORED_BYTES)
            .execute(pool)
            .await?;
            Ok::<(), sqlx::Error>(())
        };
        if let Err(e) = stored.await {
            tracing::warn!(error = %e, "couldn't store a research answer");
        }
    }

    async fn fetch(
        &self,
        who: Option<&str>,
        provider: Provider,
        url: Url,
        body: Option<Value>,
    ) -> AppResult<Document> {
        let cacheable = body.is_none();
        let key = url.as_str().to_string();
        let mut flight = None;
        if cacheable {
            if let Some(doc) = self.remembered(&key) {
                return Ok(doc);
            }
            if let Some(doc) = self.stored(&key).await {
                return Ok(doc);
            }
            // One fetch per key: a second caller waits for it, then finds its answer.
            let lock = self.flights.lock().expect("flights").entry(key.clone()).or_default().clone();
            let turn = lock.clone().lock_owned().await;
            flight = Some(Flight { research: self, key: key.clone(), turn: Some(turn), lock });
            if let Some(doc) = self.remembered(&key) {
                return Ok(doc);
            }
        }
        if self.offline {
            return Err(crate::error::offline(provider.name()));
        }
        // Charged only once a turn is secured: a refusal sends nothing.
        if let Some(who) = who {
            self.spend(who, true)?;
        }
        let wait = self.reserve(provider, Some(MAX_WAIT))?;
        if let Some(who) = who {
            self.spend(who, false)?;
        }
        self.take_turn(provider, wait, Some(MAX_WAIT)).await?;
        let mut req = if let Some(body) = &body {
            self.http.post(url.clone()).json(body)
        } else {
            self.http.get(url.clone())
        };
        req = req.header(
            reqwest::header::ACCEPT,
            if provider == Provider::Rules {
                "text/html, text/plain"
            } else {
                "application/json"
            },
        );
        let mut response = req.send().await.map_err(|_| {
            AppError::Unavailable(
                "The research source did not respond in time; try again later.".into(),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|s| s.to_str().ok())
                .map(retry_after)
                .unwrap_or(60)
                .clamp(1, 3600);
            self.hold_off(provider, Duration::from_secs(retry));
            return Err(AppError::TooManyRequests {
                message: "The research source rate-limited Yama; no result was inferred.".into(),
                retry_after: retry,
            });
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::NotFound("public source result"));
        }
        if !status.is_success() {
            return Err(AppError::Unavailable(format!(
                "The research source returned HTTP {}. It may block automated access; no result was inferred.",
                status.as_u16()
            )));
        }
        let limit = if provider == Provider::Rules {
            4 * 1024 * 1024
        } else {
            2 * 1024 * 1024
        };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            AppError::Unavailable("The research source stopped sending its response.".into())
        })? {
            if bytes.len() + chunk.len() > limit {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        let doc = Document {
            bytes: Arc::new(bytes),
            provider,
            fetched_at: crate::util::now(),
            source: key.clone(),
            cached: false,
        };
        // Only an answer that reads as its provider's kind is kept: a maintenance page or a cut-off
        // body that came with a 200 would otherwise be served to everyone until its time ran out.
        if cacheable && readable(provider, &url, &doc) {
            self.keep(&key, &doc, provider.ttl(&url)).await;
        }
        drop(flight);
        Ok(doc)
    }

    #[cfg(test)]
    pub fn with_base(mut self, provider: Provider, base: String) -> Self {
        self.bases.insert(provider, base);
        self
    }

    #[cfg(test)]
    pub fn with_store(mut self, pool: SqlitePool) -> Self {
        self.store = Some(pool);
        self
    }
}

/// Whether an answer is what its provider sends: JSON, or for the rules, a page that names an
/// edition's text and a text that indexes as the rules.
fn readable(provider: Provider, url: &Url, doc: &Document) -> bool {
    match provider {
        Provider::Rules => doc.text().is_ok_and(|text| {
            if url.path().ends_with(".txt") {
                super::rules::parse(text).entries.len() >= 100
            } else {
                super::rules::discover(text).is_ok()
            }
        }),
        _ => serde_json::from_slice::<serde::de::IgnoredAny>(&doc.bytes).is_ok(),
    }
}

fn cooling(wait: Duration) -> AppError {
    AppError::TooManyRequests {
        message: "The research source is cooling down; try again later.".into(),
        retry_after: wait.as_secs().max(1),
    }
}

fn too_large() -> AppError {
    AppError::Unavailable(
        "The research response exceeded Yama's size limit; narrow the request.".into(),
    )
}

/// A Retry-After value, in seconds or as an HTTP date; 60 when it's neither.
pub fn retry_after(s: &str) -> u64 {
    s.parse().unwrap_or_else(|_| {
        chrono::DateTime::parse_from_rfc2822(s)
            .ok()
            .map(|at| (at.timestamp() - chrono::Utc::now().timestamp()).max(1) as u64)
            .unwrap_or(60)
    })
}

pub fn trusted_rules_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| h == "wizards.com" || h.ends_with(".wizards.com"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_turn_is_reserved_without_holding_the_lane_and_a_far_one_is_refused() {
        let research = Research::default();
        // Spellbook every 4 s: turns now, in 4 s and in 8 s are taken at once, with nobody
        // waiting on a lock; the next, 12 s off, is refused.
        let waits: Vec<_> = (0..3).map(|_| research.reserve(Provider::Spellbook, Some(MAX_WAIT)).unwrap()).collect();
        assert!(waits[0] < Duration::from_millis(100) && waits[2] > Duration::from_secs(7), "{waits:?}");
        let err = research.reserve(Provider::Spellbook, Some(MAX_WAIT)).unwrap_err();
        assert!(matches!(err, AppError::TooManyRequests { retry_after, .. } if retry_after >= 11), "{err}");
        // A background job still gets a turn, however far.
        assert!(research.reserve(Provider::Spellbook, None).unwrap() > Duration::from_secs(11));
        // Other providers are their own lanes.
        assert!(research.reserve(Provider::Scryfall, Some(MAX_WAIT)).unwrap() < Duration::from_millis(100));
        // A 429 holds everybody off, and a turn reserved before it waits it out or is refused.
        let reserved = research.reserve(Provider::Scryfall, Some(MAX_WAIT)).unwrap();
        research.hold_off(Provider::Scryfall, Duration::from_secs(30));
        assert!(research.reserve(Provider::Scryfall, Some(MAX_WAIT)).is_err());
        assert!(research.take_turn(Provider::Scryfall, reserved, Some(MAX_WAIT)).await.is_err());
        research.hold_off(Provider::Edhrec, Duration::from_millis(300));
        let started = Instant::now();
        research.take_turn(Provider::Edhrec, Duration::ZERO, Some(MAX_WAIT)).await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(250));
    }

    #[test]
    fn only_an_answer_that_reads_as_its_providers_is_kept() {
        let research = Research::default();
        let at = |p: Provider, path: &str| research.url(p, path, &[]);
        let doc = |text: &str| Document { bytes: Arc::new(text.as_bytes().to_vec()), provider: Provider::Scryfall, fetched_at: "now".into(), source: "x".into(), cached: false };
        assert!(readable(Provider::Scryfall, &at(Provider::Scryfall, "/cards/search"), &doc(r#"{"data":[]}"#)));
        assert!(!readable(Provider::Scryfall, &at(Provider::Scryfall, "/cards/search"), &doc("<html>down for maintenance</html>")));
        assert!(!readable(Provider::Edhrec, &at(Provider::Edhrec, "/pages/x.json"), &doc(r#"{"cut": "of"#)));
        assert!(!readable(Provider::Rules, &at(Provider::Rules, "/en/rules"), &doc("<html>no link here</html>")));
        assert!(readable(Provider::Rules, &at(Provider::Rules, "/en/rules"), &doc(r#"<a href="https://media.wizards.com/2026/MagicCompRules 20260925.txt">"#)));
        assert!(!readable(Provider::Rules, &Url::parse("https://media.wizards.com/2026/MagicCompRules.txt").unwrap(), &doc("Magic\n100.1. Too short.")));
    }

    #[test]
    fn each_person_has_a_budget_of_outside_requests() {
        let research = Research::default();
        // Checking costs nothing.
        for _ in 0..BUDGET.0 * 2 {
            research.spend("a", true).unwrap();
        }
        for _ in 0..BUDGET.0 {
            research.spend("a", false).unwrap();
        }
        assert!(matches!(research.spend("a", true), Err(AppError::TooManyRequests { .. })));
        research.spend("b", false).unwrap();
    }

    fn doc(n: usize) -> Document {
        Document { bytes: Arc::new(vec![0; n]), provider: Provider::Scryfall, fetched_at: "now".into(), source: "x".into(), cached: false }
    }

    #[test]
    fn the_memory_cache_drops_the_least_recently_used() {
        let mut memory = Memory::default();
        let later = Instant::now() + Duration::from_secs(60);
        for i in 0..MEMORY_ENTRIES {
            memory.put(format!("k{i}"), doc(10), later);
        }
        // k0 used again, so k1 is the oldest when one more arrives.
        assert!(memory.get("k0").is_some());
        memory.put("new".into(), doc(10), later);
        assert!(memory.get("k0").is_some() && memory.get("k1").is_none() && memory.get("new").is_some());
        assert_eq!(memory.entries.len(), MEMORY_ENTRIES);
        // Too many bytes: the oldest go until it fits, not everything.
        memory.put("big".into(), doc(MEMORY_BYTES - 50), later);
        assert!(memory.get("big").is_some());
        assert!(memory.entries.len() > 1 && memory.entries.values().map(|(d, ..)| d.bytes.len()).sum::<usize>() <= MEMORY_BYTES);
        // An expired answer isn't one.
        memory.put("old".into(), doc(1), Instant::now());
        assert!(memory.get("old").is_none());
    }
}
