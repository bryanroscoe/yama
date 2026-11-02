use chrono::{SecondsFormat, Utc};

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 256 bits of randomness, hex encoded.
pub fn random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Short human-friendly code for invites and joining (no 0/O/1/I).
pub fn short_code(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = uuid::Uuid::new_v4().into_bytes();
    bytes.iter().take(len).map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect()
}

/// Whether a request's `If-None-Match` names `etag` (strong or weak, or `*`).
pub fn etag_matches(headers: &axum::http::HeaderMap, etag: &str) -> bool {
    headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').map(str::trim).any(|t| t == "*" || t == etag || t.strip_prefix("W/") == Some(etag)))
}

pub fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// For PATCH-style fields: absent → `None` (leave alone), `null` → `Some(None)` (clear),
/// a value → `Some(Some(v))`. Plain serde reads both absent and null as `None`.
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(d).map(Some)
}

/// How long a download may go without a byte before it counts as stalled.
pub const DOWNLOAD_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
/// The longest a big download (Scryfall's bulk files, the scanner bundle) may take in all.
pub const DOWNLOAD_TOTAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// The next piece of a download, or an error if none comes for [`DOWNLOAD_IDLE`], so a stalled
/// connection can't hold up whatever is waiting for the file (the hourly import loop).
pub async fn next_chunk<S, T>(stream: &mut S) -> anyhow::Result<Option<T>>
where
    S: futures_util::Stream<Item = reqwest::Result<T>> + Unpin,
{
    use futures_util::StreamExt;
    match tokio::time::timeout(DOWNLOAD_IDLE, stream.next()).await {
        Ok(Some(chunk)) => Ok(Some(chunk?)),
        Ok(None) => Ok(None),
        Err(_) => anyhow::bail!("the download stalled: nothing for {} s", DOWNLOAD_IDLE.as_secs()),
    }
}
