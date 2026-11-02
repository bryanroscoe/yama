//! The replay of `price_snapshots` into the history, through the same writer the import uses,
//! and the check that the two agree.

use super::write::{self, Observation};
use super::{SCRYFALL, Writer, date_of, day_of, newest_observation};
use anyhow::Context;
use serde::Serialize;
use sqlx::SqlitePool;

/// The old table's price columns, by series. It never kept Cardmarket's etched price.
const OLD_COLUMNS: [(i64, &str); 6] = [(1, "usd"), (2, "usd_foil"), (3, "usd_etched"), (4, "eur"), (5, "eur_foil"), (7, "tix")];

/// What a replay did.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Replayed {
    pub days: usize,
    /// Days the old table has with no import that finished: possibly part of a file, so left
    /// unobserved (a gap).
    pub skipped: Vec<String>,
}

/// Replay each day of the old table newer than the history's newest observed day, oldest first,
/// each published whole in one transaction, then check the result ([`verify`]) and record it in
/// `price_meta`. Only a day an import finished is replayed. Days already observed are skipped, so
/// it's safe to run again, and a stop part way resumes at the first unobserved day.
pub async fn backfill_if_needed(pool: &SqlitePool, writer: &Writer) -> anyhow::Result<Replayed> {
    let newest = newest_observation(pool, SCRYFALL).await?;
    let after = newest.map(date_of).unwrap_or_default();
    // Each date the old table has (0057, written with its prices), without scanning it.
    let dates: Vec<String> = sqlx::query_scalar("SELECT date FROM price_dates WHERE date > ? ORDER BY date").bind(&after).fetch_all(pool).await?;
    if dates.is_empty() {
        return Ok(Replayed::default());
    }
    let job = crate::perf::Job::start("price history replay", std::time::Duration::from_secs(300));
    let result = replay(pool, writer, &dates).await;
    job.finish(&result, format!("{} days", dates.len()));
    let replayed = result?;
    if !replayed.skipped.is_empty() {
        tracing::warn!(skipped = ?replayed.skipped, "old price days with no finished import weren't replayed; the history has a gap there");
    }
    if replayed.days == 0 {
        return Ok(replayed);
    }
    let report = verify(pool, None).await?;
    let text = serde_json::to_string(&report)?;
    sqlx::query("INSERT INTO price_meta (key, value) VALUES ('backfill', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(&text).execute(pool).await?;
    if report.clean() {
        tracing::info!(days = replayed.days, %text, "price history replayed from price_snapshots and verified");
    } else {
        tracing::error!(days = replayed.days, %text, "price history replay doesn't match price_snapshots");
    }
    Ok(replayed)
}

/// A whole number of cents, as an integer, from one of the old table's columns.
fn cents(column: &str) -> String {
    format!("CAST(round({column} * 100) AS INTEGER)")
}

async fn replay(pool: &SqlitePool, writer: &Writer, dates: &[String]) -> anyhow::Result<Replayed> {
    // The old table's values all came from Scryfall's two-decimal text, so anything else is
    // refused, never rounded.
    let odd = OLD_COLUMNS
        .iter()
        .map(|(_, c)| format!("({c} < 0 OR abs({c} * 100 - round({c} * 100)) > 1e-6)"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let stage = format!(
        "INSERT INTO price_stage (file, scryfall_id, usd, usd_foil, usd_etched, eur, eur_foil, eur_etched, tix)
         SELECT ?, scryfall_id, {}, {}, {}, {}, {}, NULL, {} FROM price_snapshots WHERE date = ?",
        cents("usd"),
        cents("usd_foil"),
        cents("usd_etched"),
        cents("eur"),
        cents("eur_foil"),
        cents("tix")
    );
    let mut out = Replayed::default();
    for date in dates {
        let day = day_of(date).filter(|d| date_of(*d) == *date).with_context(|| format!("price_dates has {date:?}, not a date"))?;
        // The import that finished this day's file. One that failed or stopped may have written
        // part of a file.
        let run: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, source_updated_at FROM import_runs WHERE kind = 'default_cards' AND error IS NULL AND finished_at IS NOT NULL
               AND substr(COALESCE(source_updated_at, started_at), 1, 10) = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(date)
        .fetch_optional(pool)
        .await?;
        let Some((import_run, file_updated_at)) = run else {
            out.skipped.push(date.clone());
            continue;
        };
        let bad: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT scryfall_id FROM price_snapshots WHERE date = ? AND ({odd}) LIMIT 1")))
            .bind(date)
            .fetch_optional(pool)
            .await?;
        if let Some(id) = bad {
            anyhow::bail!("price_snapshots has a price for {id} on {date} that isn't a whole number of cents; the replay stopped");
        }
        let file = format!("price_snapshots {date}");
        let mut tx = pool.begin().await?;
        let printings = sqlx::query(sqlx::AssertSqlSafe(stage.clone())).bind(&file).bind(date).execute(&mut *tx).await?.rows_affected();
        write::publish(&mut tx, writer, day, date, &Observation { file, file_updated_at, import_run: Some(import_run), printings: printings as i64 }).await?;
        tx.commit().await?;
        out.days += 1;
    }
    Ok(out)
}

/// Replay the old table before the server listens, so no request reads latest prices that are
/// days behind it. A failure stops the start rather than serve them; deploy/README.md has the
/// rollback.
pub async fn run_before_serving(pool: &SqlitePool) -> anyhow::Result<()> {
    let writer = Writer::acquire(pool).await?;
    let result = backfill_if_needed(pool, &writer).await;
    writer.release().await;
    let replayed = result.context("replaying price_snapshots into the price history")?;
    if replayed.days > 0 {
        tracing::info!(days = replayed.days, "price history replayed before serving");
    }
    Ok(())
}

/// How the history compares with `price_snapshots`, on every observed day or one.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Verified {
    /// Observed days compared.
    pub days: i64,
    /// Old rows compared, six values each.
    pub rows: i64,
    /// Old rows whose values the history doesn't give back as of their day.
    pub mismatches: i64,
    /// Observed (printing, day) pairs with no old row, where the old table had no price.
    pub pairs: i64,
    /// Those that read as a price in the history: a stale price carried forward.
    pub stale: i64,
    /// Days the old table has that the history never observed, and their rows (the whole
    /// check only).
    pub unobserved_days: i64,
    pub unobserved_rows: i64,
}

impl Verified {
    /// Something compared, all of it the same, and no day of the old table missing.
    pub fn clean(&self) -> bool {
        self.rows > 0 && self.mismatches == 0 && self.stale == 0 && self.unobserved_days == 0
    }
}

/// The value of `series` for printing `k.id` as of day `d.day`.
fn as_of(series: i64) -> String {
    format!("(SELECT pp.cents FROM price_point pp WHERE pp.printing = k.id AND pp.series = {series} AND pp.day <= d.day ORDER BY pp.day DESC LIMIT 1)")
}

/// Check the history against `price_snapshots` (read only): every old row's six values come back
/// as of its day, no observed day without an old row reads as a price, and every day of the old
/// table was observed. `date`: just that day, which must be an observed one.
pub async fn verify(pool: &SqlitePool, date: Option<&str>) -> anyhow::Result<Verified> {
    let day = match date {
        None => None,
        Some(date) => {
            let day = day_of(date).filter(|d| date_of(*d) == date).with_context(|| format!("{date:?} isn't a date (YYYY-MM-DD)"))?;
            let observed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM price_observation WHERE feed = ? AND day = ?)").bind(SCRYFALL).bind(day).fetch_one(pool).await?;
            anyhow::ensure!(observed, "the price history has no file for {date}");
            Some(day)
        }
    };
    let days = "(SELECT day, date(day * 86400, 'unixepoch') AS date FROM price_observation WHERE feed = 'scryfall' AND (?1 IS NULL OR day = ?1))";
    let compared: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {days}"))).bind(day).fetch_one(pool).await?;
    let differs = OLD_COLUMNS
        .iter()
        .map(|(series, col)| format!("{} IS NOT {}", as_of(*series), cents(&format!("ps.{col}"))))
        .collect::<Vec<_>>()
        .join(" OR ");
    let (rows, mismatches): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*), IFNULL(SUM(bad), 0) FROM (
           SELECT ({differs}) AS bad FROM price_snapshots ps JOIN {days} d ON d.date = ps.date
             LEFT JOIN price_printing k ON k.scryfall_id = ps.scryfall_id)"
    )))
    .bind(day)
    .fetch_one(pool)
    .await?;
    let priced = super::SCRYFALL_SERIES.iter().map(|(series, _)| format!("{} IS NOT NULL", as_of(*series))).collect::<Vec<_>>().join(" OR ");
    let (pairs, stale): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*), IFNULL(SUM({priced}), 0) FROM {days} d JOIN price_printing k
          WHERE NOT EXISTS (SELECT 1 FROM price_snapshots ps WHERE ps.scryfall_id = k.scryfall_id AND ps.date = d.date)
            AND EXISTS (SELECT 1 FROM price_point pp WHERE pp.printing = k.id AND pp.day <= d.day)"
    )))
    .bind(day)
    .fetch_one(pool)
    .await?;
    let (unobserved_days, unobserved_rows): (i64, i64) = if day.is_some() {
        (0, 0)
    } else {
        sqlx::query_as(
            "SELECT COUNT(DISTINCT date), COUNT(*) FROM price_snapshots
              WHERE date NOT IN (SELECT date(day * 86400, 'unixepoch') FROM price_observation WHERE feed = 'scryfall')",
        )
        .fetch_one(pool)
        .await?
    };
    Ok(Verified { days: compared, rows, mismatches, pairs, stale, unobserved_days, unobserved_rows })
}
