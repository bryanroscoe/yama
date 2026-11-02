//! Price history (2026-11-02; ARCHITECTURE.md, "Price history"; migration 0060).
//!
//! Each Scryfall printings import is one observed day. A series (TCGplayer market nonfoil, foil,
//! etched; Cardmarket nonfoil, foil, etched; Cardhoarder tickets) gets a row in `price_point` only
//! when its value changes, including a change to "no price" (NULL), as whole cents. The value on an
//! observed day is the newest row on or before it; a day nobody read is a gap. `price_latest` keeps
//! each printing's prices as of the newest file, for the pages to join.
//!
//! - Missing stays missing: a printing that drops out of the file, or loses a price, gets a NULL
//!   row and a NULL latest price, dated with the file that showed it (the old table showed its
//!   last price as current).
//! - A file is published whole, in one transaction, or not at all ([`write`]).
//! - Days are written in order, never into the past, by one writer at a time across processes
//!   ([`Writer`]), except the replay of the old table's newer days ([`backfill`]).
//! - `price_snapshots` is still written beside these until a later migration drops it, so a
//!   rollback finds every day there; each import checks its day against it ([`backfill::verify`]).

pub mod backfill;
pub mod history;
pub mod write;
#[cfg(test)]
mod tests;

use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use std::time::Duration;

/// Scryfall's daily file, the one feed so far.
pub const SCRYFALL: &str = "scryfall";

/// Scryfall's series, by `price_series.id`, in the order [`write::ScryfallRow::cents`] holds them,
/// with the `price_latest` column each fills.
pub const SCRYFALL_SERIES: [(i64, &str); 7] = [(1, "usd"), (2, "usd_foil"), (3, "usd_etched"), (4, "eur"), (5, "eur_foil"), (6, "eur_etched"), (7, "tix")];

/// This process's price writer; [`Writer`] holds it with the lease.
static PRICE_WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Seconds a writer's lease lasts unless renewed; the holder renews it every [`RENEW`].
const LEASE_SECS: i64 = 60;
const RENEW: Duration = Duration::from_secs(20);
/// How long a writer waits for another process to finish.
const WAIT: Duration = Duration::from_secs(20 * 60);

/// The one price writer, so days are written in order: this process's lock, then a lease in
/// `price_meta` that a writer in another process (`yama-server import-cards` or `prices backfill`
/// beside the server) waits for. A writer that stops without releasing it holds it for a minute
/// at most. [`write::publish`] checks the lease in its transaction, so a writer that lost it
/// publishes nothing.
pub struct Writer {
    id: String,
    pool: SqlitePool,
    heartbeat: tokio::task::JoinHandle<()>,
    _local: tokio::sync::MutexGuard<'static, ()>,
}

impl Writer {
    pub async fn acquire(pool: &SqlitePool) -> anyhow::Result<Writer> {
        let local = PRICE_WRITER.lock().await;
        let id = crate::util::new_id();
        let deadline = tokio::time::Instant::now() + WAIT;
        while !take_lease(pool, &id).await? {
            anyhow::ensure!(tokio::time::Instant::now() < deadline, "another process has held the price writer for {} minutes", WAIT.as_secs() / 60);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let heartbeat = tokio::spawn({
            let (pool, id) = (pool.clone(), id.clone());
            async move {
                loop {
                    tokio::time::sleep(RENEW).await;
                    match take_lease(&pool, &id).await {
                        Ok(true) => {}
                        Ok(false) => return tracing::error!("another process took the price writer's lease"),
                        Err(e) => tracing::warn!(error = %e, "couldn't renew the price writer's lease"),
                    }
                }
            }
        });
        let writer = Writer { id, pool: pool.clone(), heartbeat, _local: local };
        // What a writer that stopped part way staged is abandoned.
        sqlx::query("DELETE FROM price_stage").execute(pool).await?;
        Ok(writer)
    }

    /// Inside a write transaction: an error unless the lease is still this writer's.
    pub async fn fence(&self, conn: &mut SqliteConnection) -> anyhow::Result<()> {
        let holder: Option<String> = sqlx::query_scalar("SELECT value ->> 'id' FROM price_meta WHERE key = 'writer'").fetch_optional(&mut *conn).await?.flatten();
        anyhow::ensure!(holder.as_deref() == Some(self.id.as_str()), "another process took the price writer's lease; nothing was published");
        Ok(())
    }

    pub async fn release(self) {
        self.heartbeat.abort();
        let released = sqlx::query("DELETE FROM price_meta WHERE key = 'writer' AND value ->> 'id' = ?").bind(&self.id).execute(&self.pool).await;
        if let Err(e) = released {
            tracing::warn!(error = %e, "couldn't release the price writer's lease; it lapses in a minute");
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.heartbeat.abort();
    }
}

/// Take or renew the lease: free, lapsed, or already this writer's.
async fn take_lease(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let done = sqlx::query(
        "INSERT INTO price_meta (key, value) VALUES ('writer', json_object('id', ?1, 'until', ?2))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value
          WHERE price_meta.value ->> 'id' = ?1 OR price_meta.value ->> 'until' < ?3",
    )
    .bind(id)
    .bind(now + LEASE_SECS)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

fn epoch() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch")
}

/// `2026-11-01` (or the start of an RFC 3339 time) as days since 1970-01-01.
pub fn day_of(date: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(date.get(..10)?, "%Y-%m-%d").ok()?;
    Some((d - epoch()).num_days())
}

/// Days since 1970-01-01 as `YYYY-MM-DD`.
pub fn date_of(day: i64) -> String {
    (epoch() + chrono::Duration::days(day)).to_string()
}

/// A price as Scryfall writes it ("12.34") in whole cents, read from the text, never a float.
/// Anything but digits with up to two decimals is no price.
pub fn parse_cents(s: &str) -> Option<i64> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(frac) || frac.len() > 2 || (s.contains('.') && frac.is_empty()) {
        return None;
    }
    let cents = match frac.len() {
        0 => 0,
        1 => frac.parse::<i64>().ok()? * 10,
        _ => frac.parse::<i64>().ok()?,
    };
    whole.parse::<i64>().ok()?.checked_mul(100)?.checked_add(cents)
}

/// The newest day a feed was observed.
pub async fn newest_observation<'c>(conn: impl SqliteExecutor<'c>, feed: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT MAX(day) FROM price_observation WHERE feed = ?").bind(feed).fetch_one(conn).await
}

/// The newest day with Scryfall prices (YYYY-MM-DD).
pub async fn latest_date<'c>(conn: impl SqliteExecutor<'c>) -> sqlx::Result<Option<String>> {
    Ok(newest_observation(conn, SCRYFALL).await?.map(date_of))
}
