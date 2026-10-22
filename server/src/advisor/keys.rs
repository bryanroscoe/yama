//! Users' own Anthropic API keys, encrypted at rest. A key is written, used by the server to ask
//! the sidecar, and deleted; it is never read back by any route.
//!
//! ChaCha20-Poly1305 with a fresh random nonce per key. The encryption key is SHA-256 of a fixed
//! label and YAMA_ADVISOR_KEY_SECRET (a random server secret), and the user id is the associated
//! data, so a ciphertext copied to another account's row doesn't decrypt.

use crate::error::{AppError, AppResult};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

fn cipher(secret: &str) -> ChaCha20Poly1305 {
    let mut h = Sha256::new();
    h.update(b"yama-advisor-key-v1:");
    h.update(secret.as_bytes());
    let digest = h.finalize();
    ChaCha20Poly1305::new_from_slice(digest.as_slice()).expect("SHA-256 is 32 bytes, the key size")
}

/// Anthropic API keys start with `sk-ant-`, with no spaces, at a sane length. Checked before a key
/// is stored so a pasted sentence or another service's key is refused with a clear message.
pub fn looks_like_api_key(s: &str) -> bool {
    s.starts_with("sk-ant-") && (23..=407).contains(&s.len()) && s[7..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// (ciphertext, nonce)
pub fn encrypt(secret: &str, user_id: &str, api_key: &str) -> AppResult<(Vec<u8>, Vec<u8>)> {
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher(secret)
        .encrypt(&nonce, Payload { msg: api_key.as_bytes(), aad: user_id.as_bytes() })
        .map_err(|_| AppError::Other(anyhow::anyhow!("couldn't encrypt the key")))?;
    Ok((ct, nonce.to_vec()))
}

pub fn decrypt(secret: &str, user_id: &str, ciphertext: &[u8], nonce: &[u8]) -> AppResult<String> {
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| AppError::Other(anyhow::anyhow!("stored key has a bad nonce")))?;
    let pt = cipher(secret)
        .decrypt(&Nonce::from(nonce), Payload { msg: ciphertext, aad: user_id.as_bytes() })
        .map_err(|_| AppError::Conflict("Your saved API key can't be read on this server any more (its encryption secret changed). Remove it and add it again.".into()))?;
    String::from_utf8(pt).map_err(|_| AppError::Other(anyhow::anyhow!("stored key isn't text")))
}

/// The last four characters, for "the key ending abcd".
pub fn hint(api_key: &str) -> String {
    let n = api_key.chars().count();
    api_key.chars().skip(n.saturating_sub(4)).collect()
}

pub async fn save(pool: &SqlitePool, secret: &str, user_id: &str, api_key: &str) -> AppResult<String> {
    let (ct, nonce) = encrypt(secret, user_id, api_key)?;
    let h = hint(api_key);
    sqlx::query(
        "INSERT INTO advisor_keys (user_id, ciphertext, nonce, hint, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, hint = excluded.hint,
           created_at = excluded.created_at",
    )
    .bind(user_id)
    .bind(ct)
    .bind(nonce)
    .bind(&h)
    .bind(crate::util::now())
    .execute(pool)
    .await?;
    Ok(h)
}

pub async fn remove(pool: &SqlitePool, user_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM advisor_keys WHERE user_id = ?").bind(user_id).execute(pool).await?;
    Ok(())
}

/// The key's hint, when the user has saved one.
pub async fn hint_for(pool: &SqlitePool, user_id: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT hint FROM advisor_keys WHERE user_id = ?").bind(user_id).fetch_optional(pool).await?)
}

/// The decrypted key, for a request to the sidecar only.
pub async fn load(pool: &SqlitePool, secret: &str, user_id: &str) -> AppResult<Option<String>> {
    let row: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT ciphertext, nonce FROM advisor_keys WHERE user_id = ?").bind(user_id).fetch_optional(pool).await?;
    match row {
        None => Ok(None),
        Some((ct, nonce)) => decrypt(secret, user_id, &ct, &nonce).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const KEY: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

    #[test]
    fn a_key_round_trips_only_for_its_own_user_and_secret() {
        let (ct, nonce) = encrypt(SECRET, "user-a", KEY).unwrap();
        assert!(!ct.windows(KEY.len()).any(|w| w == KEY.as_bytes()), "the ciphertext doesn't contain the key");
        assert_eq!(decrypt(SECRET, "user-a", &ct, &nonce).unwrap(), KEY);
        assert!(decrypt(SECRET, "user-b", &ct, &nonce).is_err(), "moved to another account, it doesn't decrypt");
        assert!(decrypt("another secret that is long enough!!", "user-a", &ct, &nonce).is_err());
        let (ct2, nonce2) = encrypt(SECRET, "user-a", KEY).unwrap();
        assert_ne!(nonce, nonce2, "every encryption gets a fresh nonce");
        assert_ne!(ct, ct2);
    }

    #[test]
    fn only_anthropic_shaped_keys_pass() {
        assert!(looks_like_api_key(KEY));
        assert!(!looks_like_api_key("sk-ant-short"));
        assert!(!looks_like_api_key("sk-proj-abcdefghijklmnopqrstuvwxyz"));
        assert!(!looks_like_api_key(&format!("{KEY} trailing")));
        assert_eq!(hint(KEY), "6789");
    }
}
