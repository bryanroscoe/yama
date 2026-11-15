//! Which Yama build each signed-in device runs (Bryan, 15 Nov 2026: agents must be able to tell
//! which build is on his Pixel without the phone in hand; until then the server logged nothing
//! about app versions).
//!
//! The web app sends `X-Yama-Client` on its API requests (`web/src/clientBuild.ts`): the Android
//! app `android/0.2.100 (100) web/638954329799 native/0123456789abcdef`, a browser
//! `web/638954329799`. On a request signed in with a session (the bearer token or the cookie;
//! `auth::signed_in`), [`note`] keeps the last client string per account and session, with a
//! device label read from the User-Agent and when that device first reported that string. A
//! device that reports a different string from before gets a log line. Writes are cheap: at most
//! one per device every [`WRITE_EVERY`], or at once when the string changes.
//!
//! The header is only ever data: bounded ([`MAX_CLIENT`]), limited to a few plain characters,
//! and ignored when it is anything else. The account's own devices are read back by the MCP tool
//! `list_devices` and by the admin People page; nothing else shows them. They go with the account
//! (`admin/delete.rs`).

use crate::error::AppResult;
use crate::util::sha256_hex;
use axum::http::HeaderMap;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// The request header the web app sends.
pub const HEADER: &str = "x-yama-client";

/// The longest client string kept, in bytes.
pub const MAX_CLIENT: usize = 160;

/// The longest device label kept, in characters.
const MAX_DEVICE: usize = 60;

/// How much of a User-Agent is read.
const MAX_AGENT: usize = 512;

/// How often an unchanged report is written again.
pub const WRITE_EVERY: Duration = Duration::from_secs(5 * 60);

/// Rows kept per account: its most recently seen devices.
pub const KEEP_PER_ACCOUNT: i64 = 20;

/// The client string a request carries, when it is one: trimmed, at most [`MAX_CLIENT`] bytes,
/// letters, digits, spaces and `._/()+-` only. Anything else is ignored rather than cleaned up.
pub fn parse_client(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(HEADER)?.to_str().ok()?.trim();
    let ok = !raw.is_empty() && raw.len() <= MAX_CLIENT && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b" ._/()+-".contains(&b));
    // One space between words, so the same build always reads the same.
    ok.then(|| raw.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// A short name for the device a User-Agent describes: "Pixel 10 Pro (Android 16)", "iPhone",
/// "Chrome on Mac". Empty when it says nothing useful.
pub fn device_label(agent: &str) -> String {
    let agent = match agent.char_indices().nth(MAX_AGENT) {
        Some((cut, _)) => &agent[..cut],
        None => agent,
    };
    let label = if let Some(at) = agent.find("Android") {
        android_label(&agent[at..])
    } else if agent.contains("iPhone") {
        "iPhone".to_string()
    } else if agent.contains("iPad") {
        "iPad".to_string()
    } else {
        let browser = [("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")].into_iter().find(|(m, _)| agent.contains(m)).map(|(_, n)| n);
        let os = [("Windows", "Windows"), ("Mac OS X", "Mac"), ("CrOS", "ChromeOS"), ("Linux", "Linux")].into_iter().find(|(m, _)| agent.contains(m)).map(|(_, n)| n);
        match (browser, os) {
            (Some(b), Some(o)) => format!("{b} on {o}"),
            (Some(b), None) => b.to_string(),
            (None, Some(o)) => o.to_string(),
            (None, None) => String::new(),
        }
    };
    let clean: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || " ._()+-".contains(*c)).take(MAX_DEVICE).collect();
    clean.trim().to_string()
}

/// "Android 16; Pixel 10 Pro Build/BD1A; wv)" → "Pixel 10 Pro (Android 16)". Chrome's reduced
/// User-Agent names the model "K"; that, WebView's "wv", Firefox's "Mobile" and "rv:…", and an
/// old browser's language ("en-us") aren't models.
fn android_label(from: &str) -> String {
    let inside = from.split(')').next().unwrap_or("");
    let mut parts = inside.split(';').map(str::trim);
    let version = parts.next().unwrap_or("Android").trim();
    let model = parts
        .map(|p| p.split(" Build/").next().unwrap_or("").trim())
        .find(|p| !p.is_empty() && !matches!(*p, "K" | "wv" | "U" | "Mobile" | "Tablet") && !p.starts_with("rv:") && !(p.len() <= 5 && p.contains('-')));
    match model {
        Some(m) => format!("{m} ({version})"),
        None => version.to_string(),
    }
}

/// The key a session's row is kept under. Derived from the token's hash, so it is neither the
/// token nor the session's key in `sessions`.
fn device_key(token: &str) -> String {
    sha256_hex(&format!("client-build:{}", sha256_hex(token)))[..16].to_string()
}

/// What was last written for each device in this process, so an unchanged report isn't written
/// more often than every [`WRITE_EVERY`].
static RECENT: LazyLock<Mutex<HashMap<String, (String, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Held across checking, writing and remembering a report, so two requests from one device can't
/// interleave: without it an older build's write could land after a newer one's while the cache
/// said the newer was written, and the row would stay wrong until the cache expired. Writes are
/// rare (one per device every [`WRITE_EVERY`], or on a change), so one lock for all is enough.
static WRITING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Whether this report needs writing now: not when the same report was written lately.
fn due(key: &str, seen: &str) -> bool {
    let recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    !matches!(recent.get(key), Some((last, at)) if last == seen && at.elapsed() < WRITE_EVERY)
}

/// Remember a report that was written.
fn written(key: &str, seen: String) {
    let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    // Bounded: one entry per live session, cleared wholesale if it ever grows past that.
    if recent.len() >= 10_000 {
        recent.clear();
    }
    recent.insert(key.to_string(), (seen, Instant::now()));
}

/// Note the client a signed-in request reports, if it reports one. Never fails the request: a
/// write that doesn't go through is logged and tried again on a later request.
pub async fn note(pool: &SqlitePool, user_id: &str, token: &str, headers: &HeaderMap) {
    let Some(client) = parse_client(headers) else { return };
    let agent = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let device = device_label(agent);
    let key = device_key(token);
    let slot = format!("{user_id}|{key}");
    let seen = format!("{client}|{device}");
    // Checked once without the lock, so the usual unchanged report costs nothing more.
    if !due(&slot, &seen) {
        return;
    }
    let _writing = WRITING.lock().await;
    if !due(&slot, &seen) {
        return;
    }
    match record(pool, user_id, &key, &client, &device, &crate::util::now()).await {
        Ok(()) => written(&slot, seen),
        Err(err) => tracing::warn!(error = %err, "couldn't record a device's Yama build"),
    }
}

/// Write one device's report. A device seen before that now reports a different client starts
/// that client's `first_seen_at` over and gets a log line; so does a new device.
pub async fn record(pool: &SqlitePool, user_id: &str, key: &str, client: &str, device: &str, now: &str) -> AppResult<()> {
    let before: Option<String> = sqlx::query_scalar("SELECT client FROM client_builds WHERE user_id = ? AND device_key = ?").bind(user_id).bind(key).fetch_optional(pool).await?;
    sqlx::query(
        "INSERT INTO client_builds (user_id, device_key, client, device, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (user_id, device_key) DO UPDATE SET
           first_seen_at = CASE WHEN client = excluded.client THEN first_seen_at ELSE excluded.first_seen_at END,
           client = excluded.client, device = excluded.device, last_seen_at = excluded.last_seen_at",
    )
    .bind(user_id)
    .bind(key)
    .bind(client)
    .bind(device)
    .bind(now)
    .execute(pool)
    .await?;
    if before.as_deref() != Some(client) {
        tracing::info!(user = %user_id, device = %device, client = %client, previous = %before.as_deref().unwrap_or("-"), "a device reports a new Yama build");
    }
    if before.is_none() {
        // A new device: keep only the account's most recently seen ones.
        sqlx::query(
            "DELETE FROM client_builds WHERE user_id = ?1 AND device_key NOT IN
               (SELECT device_key FROM client_builds WHERE user_id = ?1 ORDER BY last_seen_at DESC, device_key LIMIT ?2)",
        )
        .bind(user_id)
        .bind(KEEP_PER_ACCOUNT)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// One device, as `list_devices` and the admin page give it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Device {
    /// "Pixel 10 Pro (Android 16)", "Chrome on Mac"; empty when the User-Agent said nothing.
    pub device: String,
    /// The client string as sent.
    pub client: String,
    /// "android" or "web".
    pub app: String,
    /// The Android app's version name, "0.2.100".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// The Android app's version code, 100.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_code: Option<i64>,
    /// The commit the web build running was made from; "local" for a build that didn't know it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_build: Option<String>,
    /// The Android app's native code hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<String>,
    /// When this device first reported this exact client string.
    pub build_since: String,
    /// When this device last reported it (to within [`WRITE_EVERY`]).
    pub last_seen: String,
}

impl Device {
    fn new(device: String, client: String, build_since: String, last_seen: String) -> Device {
        let mut d = Device { device, app: String::new(), app_version: None, version_code: None, web_build: None, native: None, build_since, last_seen, client };
        for word in d.client.split_whitespace() {
            if let Some(code) = word.strip_prefix('(').and_then(|w| w.strip_suffix(')')) {
                d.version_code = code.parse().ok();
            } else if let Some((name, value)) = word.split_once('/') {
                match name {
                    "web" => d.web_build = Some(value.to_string()),
                    "native" => d.native = Some(value.to_string()),
                    _ if d.app.is_empty() => {
                        d.app = name.to_string();
                        d.app_version = Some(value.to_string());
                    }
                    _ => {}
                }
            }
        }
        if d.app.is_empty() && d.web_build.is_some() {
            d.app = "web".into();
        }
        d
    }
}

/// An account's devices, most recently seen first.
pub async fn list(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Device>> {
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT device, client, first_seen_at, last_seen_at FROM client_builds WHERE user_id = ? ORDER BY last_seen_at DESC, device_key LIMIT ?")
            .bind(user_id)
            .bind(KEEP_PER_ACCOUNT)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(device, client, since, seen)| Device::new(device, client, since, seen)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(client: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(HEADER, HeaderValue::from_str(client).unwrap());
        h
    }

    #[test]
    fn the_header_is_bounded_and_plain() {
        assert_eq!(parse_client(&headers("android/0.2.100 (100) web/638954329799 native/0123456789abcdef")).as_deref(), Some("android/0.2.100 (100) web/638954329799 native/0123456789abcdef"));
        assert_eq!(parse_client(&headers("  web/abc   1 ")).as_deref(), Some("web/abc 1"));
        assert_eq!(parse_client(&HeaderMap::new()), None);
        assert_eq!(parse_client(&headers("")), None);
        assert_eq!(parse_client(&headers("web/<script>")), None);
        assert_eq!(parse_client(&headers("web/a;b")), None);
        assert_eq!(parse_client(&headers(&"a".repeat(MAX_CLIENT))).map(|s| s.len()), Some(MAX_CLIENT));
        assert_eq!(parse_client(&headers(&"a".repeat(MAX_CLIENT + 1))), None);
    }

    #[test]
    fn devices_are_named_from_the_user_agent() {
        let pixel = "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro Build/BD1A.250805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
        assert_eq!(device_label(pixel), "Pixel 10 Pro (Android 16)");
        assert_eq!(device_label("Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36"), "Pixel 10 Pro (Android 16)");
        // Chrome's reduced User-Agent hides the model.
        assert_eq!(device_label("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), "Android 10");
        assert_eq!(device_label("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome on Mac");
        assert_eq!(device_label("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "Safari on Mac");
        assert_eq!(device_label("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"), "Firefox on Windows");
        assert_eq!(device_label("Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0"), "Android 14");
        assert_eq!(device_label("Mozilla/5.0 (Linux; U; Android 4.0.3; en-us; GT-I9100 Build/IML74K)"), "GT-I9100 (Android 4.0.3)");
        assert_eq!(device_label("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
        assert_eq!(device_label("curl/8.0"), "");
        assert_eq!(device_label(""), "");
        // Whatever it holds, the label is short and plain.
        let odd = device_label(&format!("Android 16; <b>{}</b>)", "x".repeat(400)));
        assert!(odd.chars().count() <= MAX_DEVICE && !odd.contains('<'), "{odd}");
    }

    #[test]
    fn a_client_string_reads_as_its_parts() {
        let d = Device::new("Pixel".into(), "android/0.2.100 (100) web/638954329799 native/0123456789abcdef".into(), "a".into(), "b".into());
        assert_eq!((d.app.as_str(), d.app_version.as_deref(), d.version_code, d.web_build.as_deref(), d.native.as_deref()), ("android", Some("0.2.100"), Some(100), Some("638954329799"), Some("0123456789abcdef")));
        let w = Device::new("Chrome on Mac".into(), "web/638954329799".into(), "a".into(), "b".into());
        assert_eq!((w.app.as_str(), w.app_version, w.web_build.as_deref()), ("web", None, Some("638954329799")));
    }

    #[tokio::test]
    async fn a_device_keeps_its_last_build_and_when_it_started() {
        let pool = crate::db::test_pool().await;
        let (me, _) = crate::testutil::user(&pool, "me@example.com").await;
        record(&pool, &me, "k1", "android/0.2.99 (99) web/aaa", "Pixel", "2026-11-15T10:00:00Z").await.unwrap();
        record(&pool, &me, "k1", "android/0.2.99 (99) web/aaa", "Pixel", "2026-11-15T11:00:00Z").await.unwrap();
        let mine = list(&pool, &me).await.unwrap();
        assert_eq!((mine.len(), mine[0].build_since.as_str(), mine[0].last_seen.as_str()), (1, "2026-11-15T10:00:00Z", "2026-11-15T11:00:00Z"));
        record(&pool, &me, "k1", "android/0.2.100 (100) web/bbb", "Pixel", "2026-11-15T12:00:00Z").await.unwrap();
        let mine = list(&pool, &me).await.unwrap();
        assert_eq!((mine[0].app_version.as_deref(), mine[0].build_since.as_str()), (Some("0.2.100"), "2026-11-15T12:00:00Z"));

        // Another account's devices are its own.
        let (other, _) = crate::testutil::user(&pool, "other@example.com").await;
        assert!(list(&pool, &other).await.unwrap().is_empty());

        // At most KEEP_PER_ACCOUNT devices, the most recently seen.
        for i in 0..KEEP_PER_ACCOUNT + 3 {
            record(&pool, &me, &format!("n{i:02}"), "web/ccc", "Chrome on Mac", &format!("2026-11-16T10:{i:02}:00Z")).await.unwrap();
        }
        let mine = list(&pool, &me).await.unwrap();
        assert_eq!(mine.len() as i64, KEEP_PER_ACCOUNT);
        assert!(mine.iter().all(|d| d.client == "web/ccc"), "the oldest went first");
    }

    #[tokio::test]
    async fn an_unchanged_report_is_written_at_most_every_few_minutes() {
        let pool = crate::db::test_pool().await;
        let (me, token) = crate::testutil::user(&pool, "me@example.com").await;
        let mut h = headers("web/aaa");
        h.insert(axum::http::header::USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36"));
        note(&pool, &me, &token, &h).await;
        let first: String = sqlx::query_scalar("SELECT last_seen_at FROM client_builds WHERE user_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        sqlx::query("UPDATE client_builds SET last_seen_at = '2000-01-01T00:00:00Z'").execute(&pool).await.unwrap();
        note(&pool, &me, &token, &h).await;
        let again: String = sqlx::query_scalar("SELECT last_seen_at FROM client_builds WHERE user_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(again, "2000-01-01T00:00:00Z", "the same report so soon isn't written again (first was {first})");
        // A new build is written at once.
        note(&pool, &me, &token, &headers("web/bbb")).await;
        let mine = list(&pool, &me).await.unwrap();
        assert_eq!((mine.len(), mine[0].client.as_str()), (1, "web/bbb"));
        // No header, or a bad one: nothing.
        note(&pool, &me, &token, &headers("web/<x>")).await;
        assert_eq!(list(&pool, &me).await.unwrap()[0].client, "web/bbb");
    }
}
