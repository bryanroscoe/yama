//! The one writer of price history, used by the import and the replay of the old table alike.
//!
//! A file's printings are staged as they're read ([`stage`]), then published with its
//! observation in one transaction ([`publish`]). A reader sees a file whole or not at all, and a
//! file that stops part way, a second one for a day already read included, changes nothing.

use super::{SCRYFALL, Writer};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

/// One printing's Scryfall prices in a file, in [`super::SCRYFALL_SERIES`] order; `None` is no
/// price.
#[derive(Clone, Debug)]
pub struct ScryfallRow {
    pub scryfall_id: String,
    pub cents: [Option<i64>; 7],
}

/// What a published day records about its file.
pub struct Observation {
    /// Which file this is (its import run, or the replayed day): its staged rows, and how
    /// `price_latest` tells the printings it left out from those it listed.
    pub file: String,
    pub file_updated_at: Option<String>,
    pub import_run: Option<String>,
    /// Printings in the file.
    pub printings: i64,
}

/// Stage one batch of a file's printings, inside the caller's transaction. Every printing in the
/// file is staged, priced or not, so the publish knows which it listed.
pub async fn stage(conn: &mut SqliteConnection, file: &str, rows: &[ScryfallRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let rows: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = vec![json!(r.scryfall_id)];
            v.extend(r.cents.iter().map(|c| json!(c)));
            Value::Array(v)
        })
        .collect();
    sqlx::query(
        "INSERT OR REPLACE INTO price_stage (file, scryfall_id, usd, usd_foil, usd_etched, eur, eur_foil, eur_etched, tix)
         SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6, j.value ->> 7
           FROM json_each(?2) j",
    )
    .bind(file)
    .bind(Value::Array(rows).to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A staged printing with any price.
pub const PRICED: &str = "(st.usd IS NOT NULL OR st.usd_foil IS NOT NULL OR st.usd_etched IS NOT NULL OR st.eur IS NOT NULL
     OR st.eur_foil IS NOT NULL OR st.eur_etched IS NOT NULL OR st.tix IS NOT NULL)";

/// Each staged printing's value for each Scryfall series. ?1 is the file.
const STAGED: &str = "staged AS (
       SELECT st.scryfall_id, s.id AS series,
              CASE s.id WHEN 1 THEN st.usd WHEN 2 THEN st.usd_foil WHEN 3 THEN st.usd_etched WHEN 4 THEN st.eur
                        WHEN 5 THEN st.eur_foil WHEN 6 THEN st.eur_etched ELSE st.tix END AS cents
         FROM price_stage st JOIN price_series s ON s.feed = 'scryfall' WHERE st.file = ?1)";

/// Printings the file left out: `price_latest` has them from an older file, or from another file
/// for the same day. ?1 is the file, ?3 its date.
const LEFT_OUT: &str = "left_out AS (
       SELECT k.id AS printing, s.id AS series FROM price_latest l JOIN price_printing k ON k.scryfall_id = l.scryfall_id
         JOIN price_series s ON s.feed = 'scryfall'
        WHERE l.date < ?3 OR (l.date = ?3 AND l.file IS NOT ?1))";

/// The value of series `v.series` for printing `v.printing` before day ?2.
const BEFORE: &str = "(SELECT pp.cents FROM price_point pp WHERE pp.printing = v.printing AND pp.series = v.series AND pp.day < ?2
       ORDER BY pp.day DESC LIMIT 1)";

/// Bound as ?1 file, ?2 day, ?3 date.
async fn run(conn: &mut SqliteConnection, template: &str, file: &str, day: i64, date: &str) -> sqlx::Result<()> {
    let sql = template.replace("{STAGED}", STAGED).replace("{LEFT_OUT}", LEFT_OUT).replace("{BEFORE}", BEFORE).replace("{PRICED}", PRICED);
    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(file).bind(day).bind(date).execute(&mut *conn).await?;
    Ok(())
}

/// Publish a staged file for `day` (`date` the same day as text) inside the caller's transaction,
/// after checking `writer` still holds the lease: a key for each printing with a price, a row
/// for each value that differs from the one before the day and none for a value back where it
/// was, the latest prices, no price from this day for every printing the file left out, then the
/// observation; the stage is cleared.
pub async fn publish(conn: &mut SqliteConnection, writer: &Writer, day: i64, date: &str, observation: &Observation) -> anyhow::Result<()> {
    writer.fence(conn).await?;
    let file = observation.file.as_str();
    run(conn, "INSERT OR IGNORE INTO price_printing (scryfall_id) SELECT st.scryfall_id FROM price_stage st WHERE st.file = ?1 AND {PRICED}", file, day, date).await?;
    // Changes from the value before the day.
    run(
        conn,
        "WITH {STAGED}, v AS (SELECT k.id AS printing, staged.series, staged.cents FROM staged JOIN price_printing k ON k.scryfall_id = staged.scryfall_id)
         INSERT INTO price_point (printing, series, day, cents)
         SELECT v.printing, v.series, ?2, v.cents FROM v WHERE v.cents IS NOT {BEFORE}
         ON CONFLICT (printing, series, day) DO UPDATE SET cents = excluded.cents WHERE price_point.cents IS NOT excluded.cents",
        file,
        day,
        date,
    )
    .await?;
    // A second file for the day, back at the value before it: that day's row is redundant. Each
    // is a primary-key seek.
    run(
        conn,
        "WITH {STAGED}, v AS (SELECT k.id AS printing, staged.series, staged.cents FROM staged JOIN price_printing k ON k.scryfall_id = staged.scryfall_id)
         DELETE FROM price_point WHERE (printing, series, day) IN (SELECT v.printing, v.series, ?2 FROM v WHERE v.cents IS {BEFORE})",
        file,
        day,
        date,
    )
    .await?;
    // The latest prices of each listed printing with a price now, or a row already.
    run(
        conn,
        "INSERT INTO price_latest (scryfall_id, date, file, usd, usd_foil, usd_etched, eur, eur_foil, eur_etched, tix)
         SELECT st.scryfall_id, ?3, ?1, st.usd / 100.0, st.usd_foil / 100.0, st.usd_etched / 100.0, st.eur / 100.0,
                st.eur_foil / 100.0, st.eur_etched / 100.0, st.tix / 100.0
           FROM price_stage st
          WHERE st.file = ?1 AND ({PRICED} OR EXISTS (SELECT 1 FROM price_latest l WHERE l.scryfall_id = st.scryfall_id))
         ON CONFLICT (scryfall_id) DO UPDATE SET date = excluded.date, file = excluded.file, usd = excluded.usd, usd_foil = excluded.usd_foil,
             usd_etched = excluded.usd_etched, eur = excluded.eur, eur_foil = excluded.eur_foil, eur_etched = excluded.eur_etched, tix = excluded.tix",
        file,
        day,
        date,
    )
    .await?;
    // Every printing the file left out has no price from this day: a NULL row where the day
    // before had a price, and no row for the day where it had none (a same-day file listed it)...
    run(
        conn,
        "WITH {LEFT_OUT}
         INSERT INTO price_point (printing, series, day, cents)
         SELECT v.printing, v.series, ?2, NULL FROM left_out v WHERE {BEFORE} IS NOT NULL
         ON CONFLICT (printing, series, day) DO UPDATE SET cents = NULL",
        file,
        day,
        date,
    )
    .await?;
    run(
        conn,
        "WITH {LEFT_OUT}
         DELETE FROM price_point WHERE (printing, series, day) IN (SELECT v.printing, v.series, ?2 FROM left_out v WHERE {BEFORE} IS NULL)",
        file,
        day,
        date,
    )
    .await?;
    // ...and no latest price, dated with this file, the newest to find it missing.
    run(
        conn,
        "UPDATE price_latest AS l SET date = ?3, file = ?1, usd = NULL, usd_foil = NULL, usd_etched = NULL, eur = NULL, eur_foil = NULL,
             eur_etched = NULL, tix = NULL
          WHERE l.date < ?3 OR (l.date = ?3 AND l.file IS NOT ?1)",
        file,
        day,
        date,
    )
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
    sqlx::query("DELETE FROM price_stage WHERE file = ?").bind(file).execute(&mut *conn).await?;
    Ok(())
}
