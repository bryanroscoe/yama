//! Bounded, paced public-data requests. No Yama credential, cookie or user text is forwarded.
//! Only GETs are cached; a deck sent to Spellbook is never put in a shared cache.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
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

    fn interval(self) -> Duration {
        Duration::from_millis(match self {
            Self::Scryfall => 110,
            Self::Spellbook => 4000,
            _ => 1000,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Document {
    pub bytes: Arc<Vec<u8>>,
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
        serde_json::json!({"source": self.source, "retrieved_at": self.fetched_at, "cached": self.cached})
    }
}

struct Cached {
    doc: Document,
    until: Instant,
}

pub struct Research {
    http: reqwest::Client,
    cache: Mutex<HashMap<String, Cached>>,
    lanes: HashMap<Provider, Mutex<Instant>>,
    #[cfg(test)]
    bases: HashMap<Provider, String>,
}

impl Default for Research {
    fn default() -> Self {
        Self {
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
            cache: Mutex::default(),
            lanes: [
                Provider::Scryfall,
                Provider::Spellbook,
                Provider::Edhrec,
                Provider::Moxfield,
                Provider::Archidekt,
                Provider::Rules,
            ]
            .into_iter()
            .map(|p| (p, Mutex::new(Instant::now())))
            .collect(),
            #[cfg(test)]
            bases: HashMap::new(),
        }
    }
}

impl Research {
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

    pub async fn get(
        &self,
        provider: Provider,
        path: &str,
        query: &[(&str, String)],
    ) -> AppResult<Document> {
        self.fetch(provider, self.url(provider, path, query), None)
            .await
    }

    pub async fn post(&self, provider: Provider, path: &str, body: Value) -> AppResult<Document> {
        self.fetch(provider, self.url(provider, path, &[]), Some(body))
            .await
    }

    pub async fn rules_document(&self, url: Url) -> AppResult<Document> {
        if !trusted_rules_url(&url) {
            return Err(AppError::bad(
                "The rules link is not an official Wizards HTTPS URL.",
            ));
        }
        self.fetch(Provider::Rules, url, None).await
    }

    async fn fetch(
        &self,
        provider: Provider,
        url: Url,
        body: Option<Value>,
    ) -> AppResult<Document> {
        let cacheable = body.is_none();
        let key = url.as_str().to_string();
        if cacheable {
            let mut cache = self.cache.lock().await;
            cache.retain(|_, c| c.until > Instant::now());
            if let Some(c) = cache.get(&key) {
                let mut doc = c.doc.clone();
                doc.cached = true;
                return Ok(doc);
            }
        }
        let lane = &self.lanes[&provider];
        {
            let mut next = lane.lock().await;
            let wait = next.saturating_duration_since(Instant::now());
            if wait > Duration::from_secs(8) {
                return Err(AppError::TooManyRequests {
                    message: "The research source is cooling down; try again later.".into(),
                    retry_after: wait.as_secs().max(1),
                });
            }
            tokio::time::sleep(wait).await;
            *next = Instant::now() + provider.interval();
        }
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
            *lane.lock().await = Instant::now() + Duration::from_secs(retry);
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
            fetched_at: crate::util::now(),
            source: key.clone(),
            cached: false,
        };
        if cacheable {
            let mut cache = self.cache.lock().await;
            // A small shared public cache, never a second card corpus or an unbounded download.
            let size: usize = cache.values().map(|c| c.doc.bytes.len()).sum();
            if cache.len() >= 16 || size + doc.bytes.len() > 8 * 1024 * 1024 {
                cache.clear();
            }
            cache.insert(
                key,
                Cached {
                    doc: doc.clone(),
                    until: Instant::now() + Duration::from_secs(3600),
                },
            );
        }
        Ok(doc)
    }

    #[cfg(test)]
    pub fn with_base(mut self, provider: Provider, base: String) -> Self {
        self.bases.insert(provider, base);
        self
    }
}

fn too_large() -> AppError {
    AppError::Unavailable(
        "The research response exceeded Yama's size limit; narrow the request.".into(),
    )
}

fn retry_after(s: &str) -> u64 {
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
