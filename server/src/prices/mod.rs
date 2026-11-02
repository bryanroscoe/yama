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
//! - Days are written in order, never into the past ([`PRICE_WRITER`]), except the one replay of
//!   the old table into a feed with nothing observed yet ([`backfill`]).
//! - `price_snapshots` is still written beside these until a later migration drops it, so a
//!   rollback finds every day there; each import checks its day against it ([`backfill::verify`]).

pub mod backfill;
pub mod history;
pub mod write;
#[cfg(test)]
mod tests;

use sqlx::SqliteExecutor;

/// Scryfall's daily file, the one feed so far.
pub const SCRYFALL: &str = "scryfall";

/// Scryfall's series, by `price_series.id`, in the order [`write::ScryfallRow::cents`] holds them,
/// with the `price_latest` column each fills.
pub const SCRYFALL_SERIES: [(i64, &str); 7] = [(1, "usd"), (2, "usd_foil"), (3, "usd_etched"), (4, "eur"), (5, "eur_foil"), (6, "eur_etched"), (7, "tix")];

/// One price writer at a time (the import and the replay of the old table), so days are written
/// in order.
pub static PRICE_WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
