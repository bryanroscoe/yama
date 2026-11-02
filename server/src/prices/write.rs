//! The one writer of price history, used by the import and the replay of the old table alike.

use super::{SCRYFALL, SCRYFALL_SERIES};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

/// One printing's Scryfall prices in a file, in [`SCRYFALL_SERIES`] order; `None` is no price.
#[derive(Clone, Debug)]
pub struct ScryfallRow {
    pub scryfall_id: String,
    pub cents: [Option<i64>; 7],
}

/// What a finished day records about its file.
pub struct Observation {
    /// Which file this is (its import run, or the replayed day): printings `price_latest` doesn't
    /// have from it were left out of it.
    pub file: String,
    pub file_updated_at: Option<String>,
    pub import_run: Option<String>,
    /// Printings in the file.
    pub printings: i64,
}

/// A change from the value before `day` (the newest row older than it).
const UPSERT: &str = "INSERT INTO price_point (printing, series, day, cents)
     SELECT k.id, j.value ->> 1, ?1, j.value ->> 2
       FROM json_each(?2) j JOIN price_printing k ON k.scryfall_id = j.value ->> 0
      WHERE (j.value ->> 2) IS NOT (SELECT pp.cents FROM price_point pp
                                    WHERE pp.printing = k.id AND pp.series = j.value ->> 1 AND pp.day < ?1
                                    ORDER BY pp.day DESC LIMIT 1)
     ON CONFLICT (printing, series, day) DO UPDATE SET cents = excluded.cents WHERE price_point.cents IS NOT excluded.cents";

/// A second file for the same day that went back to the value before it: that day's row is now
/// redundant. Driven from the batch, so each is a primary-key seek.
const DELETE_REDUNDANT: &str = "DELETE FROM price_point WHERE (printing, series, day) IN (
     SELECT k.id, j.value ->> 1, ?1
       FROM json_each(?2) j JOIN price_printing k ON k.scryfall_id = j.value ->> 0
      WHERE (j.value ->> 2) IS (SELECT pp.cents FROM price_point pp
                                WHERE pp.printing = k.id AND pp.series = j.value ->> 1 AND pp.day < ?1
                                ORDER BY pp.day DESC LIMIT 1))";

/// Each printing with a price now, or a row already, as of this file.
const LATEST: &str = "INSERT INTO price_latest (scryfall_id, date, file, usd, usd_foil, usd_etched, eur, eur_foil, eur_etched, tix)
     SELECT j.value ->> 0, ?2, ?3, (j.value ->> 1) / 100.0, (j.value ->> 2) / 100.0, (j.value ->> 3) / 100.0, (j.value ->> 4) / 100.0,
            (j.value ->> 5) / 100.0, (j.value ->> 6) / 100.0, (j.value ->> 7) / 100.0
       FROM json_each(?1) j
      WHERE (j.value ->> 1) IS NOT NULL OR (j.value ->> 2) IS NOT NULL OR (j.value ->> 3) IS NOT NULL OR (j.value ->> 4) IS NOT NULL
         OR (j.value ->> 5) IS NOT NULL OR (j.value ->> 6) IS NOT NULL OR (j.value ->> 7) IS NOT NULL
         OR EXISTS (SELECT 1 FROM price_latest l WHERE l.scryfall_id = j.value ->> 0)
     ON CONFLICT (scryfall_id) DO UPDATE SET date = excluded.date, file = excluded.file, usd = excluded.usd, usd_foil = excluded.usd_foil,
         usd_etched = excluded.usd_etched, eur = excluded.eur, eur_foil = excluded.eur_foil, eur_etched = excluded.eur_etched, tix = excluded.tix";

/// Write one batch of a file's printings for `day` (`date` is the same day as text, `file` the
/// file's [`Observation::file`]), inside the caller's transaction.
pub async fn record_batch(conn: &mut SqliteConnection, day: i64, date: &str, file: &str, rows: &[ScryfallRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let points: Vec<Value> = rows
        .iter()
        .flat_map(|r| SCRYFALL_SERIES.iter().zip(r.cents).map(move |((series, _), cents)| json!([r.scryfall_id, series, cents])))
        .collect();
    let points = Value::Array(points).to_string();
    sqlx::query("INSERT OR IGNORE INTO price_printing (scryfall_id) SELECT DISTINCT j.value ->> 0 FROM json_each(?1) j WHERE (j.value ->> 2) IS NOT NULL")
        .bind(&points)
        .execute(&mut *conn)
        .await?;
    sqlx::query(UPSERT).bind(day).bind(&points).execute(&mut *conn).await?;
    sqlx::query(DELETE_REDUNDANT).bind(day).bind(&points).execute(&mut *conn).await?;
    let latest: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = vec![json!(r.scryfall_id)];
            v.extend(r.cents.iter().map(|c| json!(c)));
            Value::Array(v)
        })
        .collect();
    sqlx::query(LATEST).bind(Value::Array(latest).to_string()).bind(date).bind(file).execute(&mut *conn).await?;
    Ok(())
}

/// Printings this file left out: `price_latest` has them from an older file, or from another file
/// for the same day.
const LEFT_OUT: &str = "(l.date < ?2 OR (l.date = ?2 AND l.file IS NOT ?3))";

/// The value of series `s.id` for printing `k.id` before day ?1.
const BEFORE: &str = "(SELECT pp.cents FROM price_point pp WHERE pp.printing = k.id AND pp.series = s.id AND pp.day < ?1 ORDER BY pp.day DESC LIMIT 1)";

/// After a file's last batch, in one transaction: every printing it left out has no price from
/// this day (a NULL row where the day before had a price, and no row for the day where it had
/// none; a NULL latest price dated with this file, the newest to find it missing), then the day
/// is recorded as observed, last,
/// so a crash part way leaves the day unobserved and the rerun completes it.
pub async fn finish_day(conn: &mut SqliteConnection, day: i64, date: &str, observation: &Observation) -> sqlx::Result<()> {
    let left_out = |sql: &str| sql.replace("{LEFT_OUT}", LEFT_OUT).replace("{BEFORE}", BEFORE);
    sqlx::query(sqlx::AssertSqlSafe(left_out(
        "INSERT INTO price_point (printing, series, day, cents)
         SELECT k.id, s.id, ?1, NULL
           FROM price_latest l JOIN price_printing k ON k.scryfall_id = l.scryfall_id JOIN price_series s ON s.feed = ?4
          WHERE {LEFT_OUT} AND {BEFORE} IS NOT NULL
         ON CONFLICT (printing, series, day) DO UPDATE SET cents = NULL",
    )))
    .bind(day)
    .bind(date)
    .bind(&observation.file)
    .bind(SCRYFALL)
    .execute(&mut *conn)
    .await?;
    // A same-day file listed it and this one doesn't, and the day before had no price: that
    // day's row goes.
    sqlx::query(sqlx::AssertSqlSafe(left_out(
        "DELETE FROM price_point WHERE day = ?1 AND (printing, series) IN (
           SELECT k.id, s.id FROM price_latest l JOIN price_printing k ON k.scryfall_id = l.scryfall_id JOIN price_series s ON s.feed = ?4
            WHERE l.date = ?2 AND l.file IS NOT ?3 AND {BEFORE} IS NULL)",
    )))
    .bind(day)
    .bind(date)
    .bind(&observation.file)
    .bind(SCRYFALL)
    .execute(&mut *conn)
    .await?;
    // Every left-out printing, priced or already without: its row says this file found it missing.
    sqlx::query(sqlx::AssertSqlSafe(left_out(
        "UPDATE price_latest AS l SET date = ?2, file = ?3, usd = NULL, usd_foil = NULL, usd_etched = NULL, eur = NULL, eur_foil = NULL, eur_etched = NULL, tix = NULL
          WHERE {LEFT_OUT}",
    )))
    .bind(day)
    .bind(date)
    .bind(&observation.file)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO price_observation (feed, day, file_updated_at, observed_at, import_run, printings) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (feed, day) DO UPDATE SET file_updated_at = excluded.file_updated_at, observed_at = excluded.observed_at,
             import_run = excluded.import_run, printings = excluded.printings",
    )
    .bind(SCRYFALL)
    .bind(day)
    .bind(&observation.file_updated_at)
    .bind(crate::util::now())
    .bind(&observation.import_run)
    .bind(observation.printings)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
