//! The one replay of `price_snapshots` into the history, through the same writer the import uses,
//! and the check that the two agree.

use super::write::{self, Observation, ScryfallRow};
use super::{PRICE_WRITER, SCRYFALL, date_of, day_of, newest_observation};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sqlx::SqlitePool;

/// Printings per transaction.
const BATCH: i64 = 500;

/// A stored price as whole cents. The old table's values all came from Scryfall's two-decimal
/// text, so anything else is refused, never rounded.
fn cents(x: Option<f64>) -> AppResult<Option<i64>> {
    let Some(x) = x else { return Ok(None) };
    let c = (x * 100.0).round();
    if (x * 100.0 - c).abs() > 1e-6 || c < 0.0 {
        return Err(AppError::Other(anyhow::anyhow!("price_snapshots holds {x}, not a whole number of cents; the replay stopped")));
    }
    Ok(Some(c as i64))
}

/// Replay every day of `price_snapshots` newer than the history's newest observed day, oldest
/// first, 500 printings a transaction, then check the result ([`verify`]) and record it in
/// `price_meta`. Days already observed are skipped, so it's safe to run again, and a stop part way
/// resumes at the first unobserved day. The caller holds [`PRICE_WRITER`]. Returns the days replayed.
pub async fn backfill_if_needed(pool: &SqlitePool) -> AppResult<usize> {
    let newest = newest_observation(pool, SCRYFALL).await?;
    let after = newest.map(date_of).unwrap_or_default();
    let dates: Vec<String> = sqlx::query_scalar("SELECT DISTINCT date FROM price_snapshots WHERE date > ? ORDER BY date").bind(&after).fetch_all(pool).await?;
    if dates.is_empty() {
        return Ok(0);
    }
    let job = crate::perf::Job::start("price history replay", std::time::Duration::from_secs(300));
    let result = replay(pool, &dates).await;
    job.finish(&result, format!("{} days", dates.len()));
    result?;
    let report = verify(pool, None).await?;
    let text = serde_json::to_string(&report).map_err(anyhow::Error::from)?;
    sqlx::query("INSERT INTO price_meta (key, value) VALUES ('backfill', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(&text).execute(pool).await?;
    if report.mismatches > 0 || report.stale > 0 {
        tracing::error!(days = dates.len(), %text, "price history replay doesn't match price_snapshots");
    } else {
        tracing::info!(days = dates.len(), %text, "price history replayed from price_snapshots and verified");
    }
    Ok(dates.len())
}

async fn replay(pool: &SqlitePool, dates: &[String]) -> AppResult<()> {
    for date in dates {
        let day = day_of(date).ok_or_else(|| AppError::Other(anyhow::anyhow!("price_snapshots has a date that isn't one: {date:?}")))?;
        let file = format!("price_snapshots {date}");
        let mut last = String::new();
        let mut printings = 0;
        loop {
            type Row = (String, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
            let rows: Vec<Row> = sqlx::query_as(
                "SELECT scryfall_id, usd, usd_foil, usd_etched, eur, eur_foil, tix FROM price_snapshots
                  WHERE scryfall_id > ? AND date = ? ORDER BY scryfall_id LIMIT ?",
            )
            .bind(&last)
            .bind(date)
            .bind(BATCH)
            .fetch_all(pool)
            .await?;
            let Some(end) = rows.last() else { break };
            last = end.0.clone();
            printings += rows.len() as i64;
            let batch = rows
                .into_iter()
                .map(|(id, usd, usd_foil, usd_etched, eur, eur_foil, tix)| {
                    // The old table never kept Cardmarket's etched price.
                    Ok(ScryfallRow { scryfall_id: id, cents: [cents(usd)?, cents(usd_foil)?, cents(usd_etched)?, cents(eur)?, cents(eur_foil)?, None, cents(tix)?] })
                })
                .collect::<AppResult<Vec<_>>>()?;
            let mut tx = pool.begin().await?;
            write::record_batch(&mut tx, day, date, &file, &batch).await?;
            tx.commit().await?;
        }
        // The import run that wrote this day, when import_runs still has it.
        let run: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, source_updated_at FROM import_runs WHERE kind = 'default_cards' AND error IS NULL AND finished_at IS NOT NULL
               AND substr(COALESCE(source_updated_at, started_at), 1, 10) = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(date)
        .fetch_optional(pool)
        .await?;
        let (import_run, file_updated_at) = run.map_or((None, None), |(id, at)| (Some(id), at));
        let mut tx = pool.begin().await?;
        write::finish_day(&mut tx, day, date, &Observation { file, file_updated_at, import_run, printings }).await?;
        tx.commit().await?;
    }
    Ok(())
}

/// Run the replay in the background once the server starts (it waits for an import in progress).
pub fn spawn(pool: SqlitePool) {
    tokio::spawn(async move {
        let _writer = PRICE_WRITER.lock().await;
        if let Err(e) = backfill_if_needed(&pool).await {
            tracing::error!(error = %e, "replaying price_snapshots into the price history failed; the next start or import tries again");
        }
    });
}

/// How the history compares with `price_snapshots`, on every observed day or one.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Verified {
    /// Old rows compared, six values each.
    pub rows: i64,
    /// Old rows whose values the history doesn't give back as of their day.
    pub mismatches: i64,
    /// Observed (printing, day) pairs with no old row, where the old table had no price.
    pub pairs: i64,
    /// Those that read as a price in the history: a stale price carried forward.
    pub stale: i64,
}

/// The value of `series` for printing `k.id` as of day `d.day`.
fn as_of(series: i64) -> String {
    format!("(SELECT pp.cents FROM price_point pp WHERE pp.printing = k.id AND pp.series = {series} AND pp.day <= d.day ORDER BY pp.day DESC LIMIT 1)")
}

/// Check the history against `price_snapshots` (read only): every old row's six values come back
/// as of its day, and no observed day without an old row reads as a price. `date`: just that day.
pub async fn verify(pool: &SqlitePool, date: Option<&str>) -> AppResult<Verified> {
    let column = [(1, "usd"), (2, "usd_foil"), (3, "usd_etched"), (4, "eur"), (5, "eur_foil"), (7, "tix")];
    let differs = column
        .iter()
        .map(|(series, col)| format!("{} IS NOT CAST(round(ps.{col} * 100) AS INTEGER)", as_of(*series)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let days = "(SELECT day, date(day * 86400, 'unixepoch') AS date FROM price_observation WHERE feed = 'scryfall' AND (?1 IS NULL OR day = ?2))";
    let (rows, mismatches): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*), IFNULL(SUM(bad), 0) FROM (
           SELECT ({differs}) AS bad FROM price_snapshots ps JOIN {days} d ON d.date = ps.date
             LEFT JOIN price_printing k ON k.scryfall_id = ps.scryfall_id)"
    )))
    .bind(date)
    .bind(date.and_then(day_of))
    .fetch_one(pool)
    .await?;
    let priced = super::SCRYFALL_SERIES.iter().map(|(series, _)| format!("{} IS NOT NULL", as_of(*series))).collect::<Vec<_>>().join(" OR ");
    let (pairs, stale): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*), IFNULL(SUM({priced}), 0) FROM {days} d JOIN price_printing k
          WHERE NOT EXISTS (SELECT 1 FROM price_snapshots ps WHERE ps.scryfall_id = k.scryfall_id AND ps.date = d.date)
            AND EXISTS (SELECT 1 FROM price_point pp WHERE pp.printing = k.id AND pp.day <= d.day)"
    )))
    .bind(date)
    .bind(date.and_then(day_of))
    .fetch_one(pool)
    .await?;
    Ok(Verified { rows, mismatches, pairs, stale })
}
