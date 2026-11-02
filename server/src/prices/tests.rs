use super::write::{Observation, ScryfallRow, finish_day, record_batch};
use super::*;
use sqlx::SqlitePool;

#[test]
fn cents_come_from_the_text() {
    for (text, cents) in [("0.01", 1), ("12.34", 1234), ("12.3", 1230), ("7", 700), ("6400.00", 640_000)] {
        assert_eq!(parse_cents(text), Some(cents), "{text}");
    }
    for text in ["1.234", "1e3", "-1", "", "abc", "1.", ".5", "1,00", " 1.00"] {
        assert_eq!(parse_cents(text), None, "{text}");
    }
}

#[test]
fn days_and_dates_round_trip() {
    assert_eq!(day_of("1970-01-01"), Some(0));
    assert_eq!(day_of("2026-11-01"), Some(20758));
    assert_eq!(day_of("2026-11-01T22:06:28.662+00:00"), Some(20758));
    assert_eq!(day_of("nope"), None);
    for day in [0, 20758, day_of("2059-09-18").unwrap()] {
        assert_eq!(day_of(&date_of(day)), Some(day));
    }
    assert_eq!(date_of(20758), "2026-11-01");
}

/// One printing's seven series, as cents.
type Cents = [Option<i64>; 7];

const NONE: Cents = [None; 7];

fn usd(c: i64) -> Cents {
    let mut v = NONE;
    v[0] = Some(c);
    v
}

/// Write one file: its printings, then the sweep and the observation.
async fn file(pool: &SqlitePool, date: &str, rows: &[(&str, Cents)]) {
    let day = day_of(date).unwrap();
    let rows: Vec<ScryfallRow> = rows.iter().map(|(id, cents)| ScryfallRow { scryfall_id: id.to_string(), cents: *cents }).collect();
    // Each call is a separate file, as two downloads for the same day are.
    let file = crate::util::new_id();
    let mut tx = pool.begin().await.unwrap();
    record_batch(&mut tx, day, date, &file, &rows).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    finish_day(&mut tx, day, date, &Observation { file, file_updated_at: None, import_run: None, printings: rows.len() as i64 }).await.unwrap();
    tx.commit().await.unwrap();
}

async fn points(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM price_point").fetch_one(pool).await.unwrap()
}

/// A series' value for a printing as of a day: the newest row on or before it.
async fn as_of(pool: &SqlitePool, id: &str, series: i64, date: &str) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT pp.cents FROM price_point pp JOIN price_printing k ON k.id = pp.printing
          WHERE k.scryfall_id = ? AND pp.series = ? AND pp.day <= ? ORDER BY pp.day DESC LIMIT 1",
    )
    .bind(id)
    .bind(series)
    .bind(day_of(date).unwrap())
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

async fn latest(pool: &SqlitePool, id: &str) -> Option<(String, Option<f64>, Option<f64>)> {
    sqlx::query_as("SELECT date, usd, usd_foil FROM price_latest WHERE scryfall_id = ?").bind(id).fetch_optional(pool).await.unwrap()
}

#[tokio::test]
async fn the_writer_keeps_only_changes_and_missing_stays_missing() {
    let pool = crate::db::test_pool().await;
    let mut both = usd(100);
    both[1] = Some(900);
    // First day: one row per price.
    file(&pool, "2026-10-18", &[("a", usd(100)), ("b", both), ("c", NONE)]).await;
    assert_eq!(points(&pool).await, 3);
    assert_eq!(latest(&pool, "b").await, Some(("2026-10-18".into(), Some(1.0), Some(9.0))));
    assert_eq!(latest(&pool, "c").await, None, "a printing that never had a price gets no row");
    // Unchanged: nothing written; the latest prices are dated with the new file.
    file(&pool, "2026-10-19", &[("a", usd(100)), ("b", both), ("c", NONE)]).await;
    assert_eq!(points(&pool).await, 3);
    assert_eq!(latest(&pool, "a").await.unwrap().0, "2026-10-19");
    // One series changes: one row.
    file(&pool, "2026-10-20", &[("a", usd(150)), ("b", both)]).await;
    assert_eq!(points(&pool).await, 4);
    assert_eq!(as_of(&pool, "a", 1, "2026-10-19").await, Some(100));
    assert_eq!(as_of(&pool, "a", 1, "2026-10-20").await, Some(150));
    // A price goes away: a NULL row, never the old price carried forward.
    file(&pool, "2026-10-21", &[("a", usd(150)), ("b", usd(100))]).await;
    assert_eq!(as_of(&pool, "b", 2, "2026-10-21").await, None);
    assert_eq!(as_of(&pool, "b", 2, "2026-10-20").await, Some(900));
    assert_eq!(latest(&pool, "b").await, Some(("2026-10-21".into(), Some(1.0), None)));
    // A printing missing from the file: NULL rows, and no latest price, dated with this file.
    let before = points(&pool).await;
    file(&pool, "2026-10-22", &[("a", usd(150))]).await;
    assert_eq!(points(&pool).await, before + 1);
    assert_eq!(as_of(&pool, "b", 1, "2026-10-22").await, None);
    assert_eq!(latest(&pool, "b").await, Some(("2026-10-22".into(), None, None)));
    // It comes back: rows again.
    file(&pool, "2026-10-23", &[("a", usd(150)), ("b", usd(120))]).await;
    assert_eq!(as_of(&pool, "b", 1, "2026-10-23").await, Some(120));
    // A second file for the same day replaces its values...
    let before = points(&pool).await;
    file(&pool, "2026-10-23", &[("a", usd(170)), ("b", usd(120))]).await;
    assert_eq!(points(&pool).await, before + 1);
    assert_eq!(as_of(&pool, "a", 1, "2026-10-23").await, Some(170));
    // ...and one back at the day before's values leaves no row for the day.
    file(&pool, "2026-10-23", &[("a", usd(150)), ("b", usd(120))]).await;
    assert_eq!(points(&pool).await, before);
    assert_eq!(as_of(&pool, "a", 1, "2026-10-23").await, Some(150));
    // The same file again writes nothing.
    let before = points(&pool).await;
    file(&pool, "2026-10-23", &[("a", usd(150)), ("b", usd(120))]).await;
    assert_eq!(points(&pool).await, before);
    let observed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_observation").fetch_one(&pool).await.unwrap();
    assert_eq!(observed, 6);
    assert_eq!(latest_date(&pool).await.unwrap().as_deref(), Some("2026-10-23"));
}

/// A tiny deterministic generator, so the model test needs no new crate.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[tokio::test]
async fn as_of_any_observed_day_the_history_equals_a_full_daily_table() {
    let pool = crate::db::test_pool().await;
    let mut rng = Rng(0x5eed_cafe_f00d);
    let printings: Vec<String> = (0..30).map(|i| format!("p{i:02}")).collect();
    // The full table: (day, printing) -> the file's values, for the days observed last.
    let mut truth: std::collections::BTreeMap<(String, String), Cents> = Default::default();
    let mut current: Vec<Cents> = vec![NONE; printings.len()];
    for d in 0..40 {
        let date = date_of(day_of("2026-09-01").unwrap() + d);
        // A few days nobody read.
        if rng.below(8) == 0 {
            continue;
        }
        // One or two files for the day; the last one counts.
        for _refile in 0..1 + rng.below(4) / 3 {
            let mut rows = Vec::new();
            for (i, id) in printings.iter().enumerate() {
                // Sometimes missing from the file altogether.
                if rng.below(10) == 0 {
                    current[i] = NONE;
                    continue;
                }
                let mut v = current[i];
                for s in v.iter_mut() {
                    match rng.below(10) {
                        0 => *s = None,
                        1..=3 => *s = Some(1 + rng.below(5) as i64 * 25),
                        _ => {}
                    }
                }
                current[i] = v;
                rows.push((id.as_str(), v));
            }
            file(&pool, &date, &rows).await;
            for (i, id) in printings.iter().enumerate() {
                truth.insert((date.clone(), id.clone()), current[i]);
            }
        }
    }
    let mut checked = 0;
    for ((date, id), want) in &truth {
        for (i, (series, _)) in SCRYFALL_SERIES.iter().enumerate() {
            assert_eq!(as_of(&pool, id, *series, date).await, want[i], "{id} series {series} on {date}");
            checked += 1;
        }
    }
    assert!(checked > 5_000, "{checked}");
}

#[tokio::test]
async fn history_reads_each_observed_day_from_the_first_price() {
    let pool = crate::db::test_pool().await;
    file(&pool, "2026-10-18", &[("x", NONE), ("a", usd(100))]).await;
    file(&pool, "2026-10-19", &[("x", usd(250)), ("a", usd(100))]).await;
    // 20 Oct: nobody read the file (a gap).
    file(&pool, "2026-10-21", &[("x", usd(300)), ("a", usd(100))]).await;
    file(&pool, "2026-10-22", &[("a", usd(100))]).await;
    file(&pool, "2026-10-23", &[("x", usd(280)), ("a", usd(100))]).await;
    let all = history::history(&pool, "x", i64::MIN, i64::MAX).await.unwrap();
    let dates: Vec<&str> = all.iter().map(|p| p.date.as_str()).collect();
    // From its first price, without the unread day or the day it had none.
    assert_eq!(dates, ["2026-10-19", "2026-10-21", "2026-10-23"]);
    assert_eq!(all[0].usd, Some(2.5));
    let (from, to) = history::range(Some("2026-10-21"), Some("2026-10-21")).unwrap();
    let one = history::history(&pool, "x", from, to).await.unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].usd, Some(3.0));
    assert!(history::range(Some("21 Oct"), None).is_err());
    let c = history::changes(&pool, "x", 1, i64::MIN, i64::MAX).await.unwrap();
    assert_eq!(c.observed_days, 5);
    assert_eq!(c.first, Some(("2026-10-18".into(), None)));
    assert_eq!(c.last, Some(("2026-10-23".into(), Some(2.8))));
    assert_eq!(c.low, Some(("2026-10-19".into(), 2.5)));
    assert_eq!(c.high, Some(("2026-10-21".into(), 3.0)));
    let changes: Vec<(&str, Option<f64>)> = c.changes.iter().map(|(d, v)| (d.as_str(), *v)).collect();
    assert_eq!(changes, [("2026-10-19", Some(2.5)), ("2026-10-21", Some(3.0)), ("2026-10-22", None), ("2026-10-23", Some(2.8))]);
}

async fn old_row(pool: &SqlitePool, id: &str, date: &str, usd: Option<f64>, foil: Option<f64>) {
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd, usd_foil) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(date)
        .bind(usd)
        .bind(foil)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_old_table_replays_once_and_matches_it_exactly() {
    let pool = crate::db::test_pool().await;
    for (date, keep, gone, back) in [("2026-10-18", 1.25, true, true), ("2026-10-19", 1.5, false, false), ("2026-10-20", 1.5, false, true)] {
        old_row(&pool, "keep", date, Some(keep), Some(9.99)).await;
        // Loses every price on the 19th (the old import then wrote no row) and stays without.
        if gone {
            old_row(&pool, "gone", date, Some(65.0), None).await;
        }
        // Leaves the file on the 19th and comes back on the 20th.
        if back {
            old_row(&pool, "back", date, None, Some(0.3)).await;
        }
    }
    let _writer = PRICE_WRITER.lock().await;
    assert_eq!(backfill::backfill_if_needed(&pool).await.unwrap(), 3);
    let v = backfill::verify(&pool, None).await.unwrap();
    assert_eq!((v.rows, v.mismatches, v.stale), (6, 0, 0));
    // gone on the 19th and the 20th, back on the 19th: no old row, and no price in the history.
    assert_eq!(v.pairs, 3);
    // The stale price the old table showed as current is gone, dated with the newest file that
    // found it missing.
    assert_eq!(latest(&pool, "gone").await, Some(("2026-10-20".into(), None, None)));
    assert_eq!(as_of(&pool, "back", 2, "2026-10-19").await, None);
    assert_eq!(as_of(&pool, "back", 2, "2026-10-20").await, Some(30));
    let stored: String = sqlx::query_scalar("SELECT value FROM price_meta WHERE key = 'backfill'").fetch_one(&pool).await.unwrap();
    assert!(stored.contains("\"mismatches\":0"), "{stored}");
    // Again: nothing to do.
    let before = points(&pool).await;
    assert_eq!(backfill::backfill_if_needed(&pool).await.unwrap(), 0);
    assert_eq!(points(&pool).await, before);
    // A newer day afterwards, by the import's writer, and checked against the old table too.
    old_row(&pool, "keep", "2026-10-21", Some(2.0), Some(9.99)).await;
    file(&pool, "2026-10-21", &[("keep", { let mut c = usd(200); c[1] = Some(999); c })]).await;
    let day = backfill::verify(&pool, Some("2026-10-21")).await.unwrap();
    assert_eq!((day.rows, day.mismatches, day.stale), (1, 0, 0));
}

#[tokio::test]
async fn the_series_match_the_code() {
    let pool = crate::db::test_pool().await;
    let rows: Vec<(i64, String, String)> = sqlx::query_as("SELECT id, feed, finish || ' ' || currency FROM price_series ORDER BY id").fetch_all(&pool).await.unwrap();
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    assert_eq!(ids, SCRYFALL_SERIES.iter().map(|s| s.0).collect::<Vec<_>>());
    assert!(rows.iter().all(|r| r.1 == SCRYFALL));
    let kinds: Vec<&str> = rows.iter().map(|r| r.2.as_str()).collect();
    assert_eq!(kinds, ["nonfoil USD", "foil USD", "etched USD", "nonfoil EUR", "foil EUR", "etched EUR", "nonfoil TIX"]);
}

#[tokio::test]
async fn a_printing_that_lost_its_price_shows_none_where_prices_are_read() {
    let pool = crate::db::test_pool().await;
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o', 'Sol Ring', 'Artifact', 'now')").execute(&pool).await.unwrap();
    for id in ["kept", "lost"] {
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?, 'o', 'Sol Ring', 'cmm', 'Set', ?, 'en', '[\"nonfoil\"]', 'now')")
            .bind(id)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    file(&pool, "2026-10-30", &[("kept", usd(500)), ("lost", usd(150))]).await;
    // Scryfall stops pricing the cheap printing.
    file(&pool, "2026-10-31", &[("kept", usd(500)), ("lost", NONE)]).await;
    let prices = crate::deck_prices::prices_for(&pool, &["o"]).await.unwrap();
    assert_eq!(prices.get("o"), Some(&(5.0, "2026-10-31".to_string())), "the cheapest price still listed, not the dropped one");
    let row: (Option<f64>, Option<String>) = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT x.usd, x.price_date FROM ({}) x WHERE x.scryfall_id = 'lost'", crate::cards::PRINTING_SELECT)))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row, (None, Some("2026-10-31".into())));
}

#[tokio::test]
async fn reading_a_day_changes_the_public_catalogs_fingerprint() {
    let pool = crate::db::test_pool().await;
    let before = crate::public_precons::fingerprint(&pool).await.unwrap();
    file(&pool, "2026-10-30", &[("a", usd(100))]).await;
    assert_ne!(crate::public_precons::fingerprint(&pool).await.unwrap(), before);
}
