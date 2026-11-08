use super::write::{Observation, ScryfallRow, publish, stage};
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

/// Stage a file's printings two to a transaction, as the import stages each batch. Returns the
/// file.
async fn stage_file(pool: &SqlitePool, rows: &[(&str, Cents)]) -> String {
    // Each file is a separate one, as two downloads for the same day are.
    let file = crate::util::new_id();
    let rows: Vec<ScryfallRow> = rows.iter().map(|(id, cents)| ScryfallRow { scryfall_id: id.to_string(), cents: *cents }).collect();
    for batch in rows.chunks(2) {
        let mut tx = pool.begin().await.unwrap();
        stage(&mut tx, &file, batch).await.unwrap();
        tx.commit().await.unwrap();
    }
    file
}

async fn publish_file(pool: &SqlitePool, writer: &Writer, date: &str, rows: &[(&str, Cents)]) -> anyhow::Result<()> {
    let file = stage_file(pool, rows).await;
    let mut tx = pool.begin().await?;
    publish(&mut tx, writer, day_of(date).unwrap(), date, &Observation { file, file_updated_at: None, import_run: None, printings: rows.len() as i64 }).await?;
    tx.commit().await?;
    Ok(())
}

/// Write one file: stage its printings, then publish it.
async fn file(pool: &SqlitePool, date: &str, rows: &[(&str, Cents)]) {
    let writer = Writer::acquire(pool).await.unwrap();
    publish_file(pool, &writer, date, rows).await.unwrap();
    writer.release().await;
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
    sqlx::query("INSERT OR IGNORE INTO price_dates (date) VALUES (?)").bind(date).execute(pool).await.unwrap();
}

/// An import of the day's file, started at `time`, that finished or stopped part way.
async fn import_run(pool: &SqlitePool, date: &str, time: &str, finished: bool) {
    sqlx::query("INSERT INTO import_runs (id, kind, source_updated_at, started_at, finished_at) VALUES (?, 'default_cards', ?, ?, ?)")
        .bind(crate::util::new_id())
        .bind(format!("{date}T09:05:00Z"))
        .bind(format!("{date}T{time}:00Z"))
        .bind(finished.then(|| format!("{date}T23:59:00Z")))
        .execute(pool)
        .await
        .unwrap();
}

async fn replay(pool: &SqlitePool) -> backfill::Replayed {
    let writer = Writer::acquire(pool).await.unwrap();
    let replayed = backfill::backfill_if_needed(pool, &writer).await.unwrap();
    writer.release().await;
    replayed
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
        import_run(&pool, date, "13:05", true).await;
    }
    assert_eq!(replay(&pool).await, backfill::Replayed { days: 3, skipped: vec![] });
    let v = backfill::verify(&pool, None).await.unwrap();
    assert_eq!((v.days, v.rows, v.mismatches, v.stale, v.unobserved_days), (3, 6, 0, 0, 0));
    assert!(v.clean());
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
    assert_eq!(replay(&pool).await, backfill::Replayed::default());
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
    let rows: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, feed, finish || ' ' || currency FROM price_series WHERE feed = 'scryfall' ORDER BY id").fetch_all(&pool).await.unwrap();
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    assert_eq!(ids, SCRYFALL_SERIES.iter().map(|s| s.0).collect::<Vec<_>>());
    let kinds: Vec<&str> = rows.iter().map(|r| r.2.as_str()).collect();
    assert_eq!(kinds, ["nonfoil USD", "foil USD", "etched USD", "nonfoil EUR", "foil EUR", "etched EUR", "nonfoil TIX"]);
    // MTGJSON's: each provider, kind and finish its own series, in the feed the code writes it to.
    let rows: Vec<(i64, String, String, String, String)> =
        sqlx::query_as("SELECT id, feed, provider, kind, finish FROM price_series WHERE feed != 'scryfall' ORDER BY id").fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 9);
    for (id, feed, provider, kind, finish) in rows {
        let mtgjson_kind = if kind == "listing" { "retail" } else { kind.as_str() };
        let i = ["nonfoil", "foil", "etched"].iter().position(|f| *f == finish).unwrap();
        assert_eq!(mtgjson::series_for_test(&provider, mtgjson_kind, i), Some(id));
        let (f, lo, hi) = mtgjson::FEEDS.into_iter().find(|f| (f.1..=f.2).contains(&id)).unwrap();
        assert_eq!((f, lo <= id, id <= hi), (feed.as_str(), true, true));
    }
}

// ── MTGJSON ────────────────────────────────────────────────────────────────────────────────

const D1: &str = "2026-10-30";
const D2: &str = "2026-10-31";
const D3: &str = "2026-11-01";

/// Three cards Yama has: s1, s2 (two faces, u2a and u2b) and s3; and u9, which it doesn't.
async fn mtgjson_printings(pool: &SqlitePool) {
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o', 'Sol Ring', 'Artifact', 'now')").execute(pool).await.unwrap();
    for id in ["s1", "s2", "s3"] {
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?, 'o', 'Sol Ring', 'cmm', 'Set', ?, 'en', '[\"nonfoil\"]', 'now')")
            .bind(id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }
}

/// MTGJSON's files in `dir`: the identifiers, and prices with these (uuid, provider, kind, finish,
/// [(date, dollars)]) values, as AllPrices (every day) or one day's AllPricesToday.
fn mtgjson_files(dir: &std::path::Path, name: &str, values: &[(&str, &str, &str, &str, &[(&str, f64)])], day: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf) {
    let ids = dir.join("ids.csv");
    std::fs::write(&ids, "uuid,scryfallId,other\nu1,s1,x\nu2a,s2,x\nu2b,s2,x\nu3,s3,x\nu9,s9,x\n").unwrap();
    let mut data = serde_json::Map::new();
    for (uuid, provider, kind, finish, dated) in values {
        let dated: serde_json::Map<String, serde_json::Value> =
            dated.iter().filter(|(d, _)| day.is_none_or(|x| x == *d)).map(|(d, v)| (d.to_string(), serde_json::json!(v))).collect();
        if dated.is_empty() {
            continue;
        }
        let card = data.entry(uuid.to_string()).or_insert_with(|| serde_json::json!({"paper": {}}));
        let p = card["paper"].as_object_mut().unwrap().entry(provider.to_string()).or_insert_with(|| serde_json::json!({"buylist": {}, "retail": {}, "currency": "USD"}));
        p[*kind][*finish] = serde_json::Value::Object(dated);
    }
    let prices = dir.join(format!("{name}.json"));
    std::fs::write(&prices, serde_json::json!({"meta": {"date": day.unwrap_or(D3)}, "data": data}).to_string()).unwrap();
    (prices, ids)
}

/// Card Kingdom on all three days; Mana Pool on the first and last only. s2's faces disagree on
/// the second day; s1 leaves Card Kingdom's buylist on the third; s3 leaves Mana Pool.
fn mtgjson_values() -> Vec<(&'static str, &'static str, &'static str, &'static str, &'static [(&'static str, f64)])> {
    vec![
        ("u1", "cardkingdom", "retail", "normal", &[(D1, 1.0), (D2, 1.0), (D3, 1.5)]),
        ("u1", "cardkingdom", "buylist", "normal", &[(D1, 0.5), (D2, 0.5)]),
        ("u1", "manapool", "retail", "normal", &[(D1, 0.9), (D3, 0.95)]),
        ("u2a", "cardkingdom", "retail", "normal", &[(D1, 2.0), (D2, 2.0), (D3, 2.0)]),
        ("u2b", "cardkingdom", "retail", "normal", &[(D1, 2.0), (D2, 3.0)]),
        ("u3", "manapool", "retail", "normal", &[(D1, 0.1)]),
        // MTGJSON's TCGplayer copy isn't read: Scryfall gives it.
        ("u3", "tcgplayer", "retail", "normal", &[(D1, 0.2), (D2, 0.2), (D3, 0.2)]),
        ("u9", "cardkingdom", "retail", "normal", &[(D1, 9.99), (D2, 9.99), (D3, 9.99)]),
    ]
}

async fn mtgjson_rows(pool: &SqlitePool) -> Vec<(String, i64, String, Option<i64>)> {
    sqlx::query_as(
        "SELECT k.scryfall_id, pp.series, date(pp.day * 86400, 'unixepoch'), pp.cents FROM price_point pp JOIN price_printing k ON k.id = pp.printing
          WHERE pp.series >= 20 ORDER BY 1, 2, 3",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn mtgjson_days(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as("SELECT feed, date(day * 86400, 'unixepoch') FROM price_observation WHERE feed != 'scryfall' ORDER BY 1, 2").fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn mtgjsons_days_replay_as_changes_with_faces_merged_and_gaps_kept() {
    let pool = crate::db::test_pool().await;
    mtgjson_printings(&pool).await;
    let dir = tempfile::tempdir().unwrap();
    let (prices, ids) = mtgjson_files(dir.path(), "all", &mtgjson_values(), None);
    let writer = Writer::acquire(&pool).await.unwrap();
    let (rows, read) = mtgjson::backfill(&pool, &writer, &prices, &ids, "run").await.unwrap();
    assert_eq!((read.mapped, read.unmapped, read.disagreements), (4, 1, 1));
    let s = |id: &str, series: i64, date: &str, cents: Option<i64>| (id.to_string(), series, date.to_string(), cents);
    let want = vec![
        // Only changes: s1's retail held a day, then rose.
        s("s1", 20, D1, Some(100)),
        s("s1", 20, D3, Some(150)),
        // Card Kingdom stopped buying it: no price from that day, never the old one.
        s("s1", 23, D1, Some(50)),
        s("s1", 23, D3, None),
        // Mana Pool's missing day is a gap for Mana Pool alone, not a missing price.
        s("s1", 26, D1, Some(90)),
        s("s1", 26, D3, Some(95)),
        // The faces disagreed on the second day: no price that day, neither of theirs.
        s("s2", 20, D1, Some(200)),
        s("s2", 20, D2, None),
        s("s2", 20, D3, Some(200)),
        s("s3", 26, D1, Some(10)),
        s("s3", 26, D3, None),
    ];
    assert_eq!(mtgjson_rows(&pool).await, want);
    assert_eq!(rows, want.len());
    assert_eq!(
        mtgjson_days(&pool).await,
        [("mtgjson:cardkingdom", D1), ("mtgjson:cardkingdom", D2), ("mtgjson:cardkingdom", D3), ("mtgjson:manapool", D1), ("mtgjson:manapool", D3)]
            .map(|(f, d)| (f.to_string(), d.to_string()))
    );
    // Once the feeds have days, the replay leaves them alone.
    assert_eq!(mtgjson::backfill(&pool, &writer, &prices, &ids, "run").await.unwrap().0, 0);
    writer.release().await;
}

#[tokio::test]
async fn mtgjson_retry_discards_unpublished_changes_from_a_different_snapshot() {
    let pool = crate::db::test_pool().await;
    mtgjson_printings(&pool).await;
    let dir = tempfile::tempdir().unwrap();
    let (prices, ids) = mtgjson_files(dir.path(), "all", &mtgjson_values(), None);
    let writer = Writer::acquire(&pool).await.unwrap();
    // A crashed replay committed these changes but never published any observed days. The
    // rolling file no longer has either change: s1 holds $1 on D2, and s3 has no CK price at all.
    sqlx::query("INSERT INTO price_printing (scryfall_id) VALUES ('s1'), ('s3')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_point (printing, series, day, cents) SELECT id, 20, ?, 9999 FROM price_printing")
        .bind(day_of(D2).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert!(mtgjson_days(&pool).await.is_empty());
    mtgjson::backfill(&pool, &writer, &prices, &ids, "retry").await.unwrap();
    let changes = history::changes(&pool, "s1", 20, day_of(D1).unwrap(), day_of(D3).unwrap()).await.unwrap();
    assert_eq!(changes.changes, vec![(D3.to_string(), Some(1.5))]);
    assert!(!mtgjson_rows(&pool).await.iter().any(|r| r.3 == Some(9999)));
    writer.release().await;
}

#[tokio::test]
async fn mtgjson_first_daily_import_discards_an_abandoned_backfill() {
    let pool = crate::db::test_pool().await;
    mtgjson_printings(&pool).await;
    let dir = tempfile::tempdir().unwrap();
    let (prices, ids) = mtgjson_files(dir.path(), "daily", &mtgjson_values(), Some(D3));
    let writer = Writer::acquire(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_printing (scryfall_id) VALUES ('s3')").execute(&pool).await.unwrap();
    // The abandoned backfill contains a future value, which a daily import's missing-price sweep
    // wouldn't remove. It must not appear even if that future day is subsequently observed.
    sqlx::query("INSERT INTO price_point (printing, series, day, cents) SELECT id, 20, ?, 9999 FROM price_printing")
        .bind(day_of(D3).unwrap() + 1)
        .execute(&pool)
        .await
        .unwrap();
    mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "daily").await.unwrap();
    assert!(!mtgjson_rows(&pool).await.iter().any(|r| r.3 == Some(9999)));
    // A published feed is never cleared by a later import.
    mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "again").await.unwrap();
    assert!(mtgjson_rows(&pool).await.iter().any(|r| r.0 == "s1" && r.1 == 20 && r.3 == Some(150)));
    writer.release().await;
}

#[tokio::test]
async fn a_successful_file_with_a_missing_provider_is_not_downloaded_again_that_day() {
    let pool = crate::db::test_pool().await;
    assert!(mtgjson::needs_refresh(&pool, D3).await.unwrap());
    sqlx::query("INSERT INTO import_runs (id, kind, source_updated_at, started_at, finished_at, error) VALUES ('failed', 'mtgjson_prices', ?, 'now', 'now', 'connection lost')")
        .bind(D3)
        .execute(&pool)
        .await
        .unwrap();
    assert!(mtgjson::needs_refresh(&pool, D3).await.unwrap(), "failed imports remain retryable");
    sqlx::query("INSERT INTO import_runs (id, kind, source_updated_at, started_at, finished_at) VALUES ('success', 'mtgjson_prices', ?, 'now', 'now')")
        .bind(D3)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!mtgjson::needs_refresh(&pool, D3).await.unwrap());
    assert!(mtgjson::needs_refresh(&pool, "2026-11-02").await.unwrap(), "a new source day is checked normally");
}

#[tokio::test]
async fn mtgjson_stale_or_empty_daily_files_do_not_publish_a_new_day() {
    let pool = crate::db::test_pool().await;
    mtgjson_printings(&pool).await;
    let dir = tempfile::tempdir().unwrap();
    let (prices, ids) = mtgjson_files(dir.path(), "stale", &mtgjson_values(), Some(D2));
    let writer = Writer::acquire(&pool).await.unwrap();
    assert!(mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "stale").await.is_err());
    assert!(mtgjson_days(&pool).await.is_empty());
    std::fs::write(&prices, serde_json::json!({"meta": {"date": D3}, "data": {}}).to_string()).unwrap();
    assert!(mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "empty").await.is_err());
    assert!(mtgjson_days(&pool).await.is_empty());
    let (prices, ids) = mtgjson_files(dir.path(), "current", &mtgjson_values(), Some(D3));
    mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "current").await.unwrap();
    assert!(!mtgjson_days(&pool).await.is_empty());
    writer.release().await;
}

#[tokio::test]
async fn each_days_file_writes_what_the_replay_would() {
    let replayed = crate::db::test_pool().await;
    let daily = crate::db::test_pool().await;
    for pool in [&replayed, &daily] {
        mtgjson_printings(pool).await;
    }
    let dir = tempfile::tempdir().unwrap();
    let (prices, ids) = mtgjson_files(dir.path(), "all", &mtgjson_values(), None);
    let writer = Writer::acquire(&replayed).await.unwrap();
    mtgjson::backfill(&replayed, &writer, &prices, &ids, "run").await.unwrap();
    writer.release().await;
    let writer = Writer::acquire(&daily).await.unwrap();
    for day in [D1, D2, D3] {
        let (prices, ids) = mtgjson_files(dir.path(), day, &mtgjson_values(), Some(day));
        mtgjson::import_day(&daily, &writer, &prices, &ids, day, "run").await.unwrap();
    }
    // A day already in isn't written again.
    let (prices, ids) = mtgjson_files(dir.path(), "again", &mtgjson_values(), Some(D3));
    assert_eq!(mtgjson::import_day(&daily, &writer, &prices, &ids, D3, "run").await.unwrap().0, 0);
    writer.release().await;
    assert_eq!(mtgjson_rows(&daily).await, mtgjson_rows(&replayed).await);
    assert_eq!(mtgjson_days(&daily).await, mtgjson_days(&replayed).await);
}

#[tokio::test]
async fn a_decks_buylist_references_count_each_copy_once_without_a_saleable_total() {
    use crate::testutil::{app, send, user};
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "me@example.com").await;
    let names = [("ring", "Sol Ring"), ("isl", "Island"), ("bolt", "Lightning Bolt"), ("tomb", "Ancient Tomb"), ("bulk", "Arcane Signet"), ("unknown", "Command Tower")];
    for (oracle, name) in names {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES (?, ?, 'Artifact', 'now')").bind(oracle).bind(name).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name.to_lowercase()).bind(oracle).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?, ?, ?, 'cmm', 'Set', '1', 'en', '[\"nonfoil\"]', 'now')")
            .bind(format!("p-{oracle}")).bind(oracle).bind(name).execute(&pool).await.unwrap();
    }
    // A premium basic is the same oracle card, but keeps its own printing and reference price.
    sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES ('p-premium', 'isl', 'Island', 'lea', 'Limited Edition Alpha', '287', 'en', '[\"nonfoil\"]', 'now')")
        .execute(&pool).await.unwrap();
    let mut cards: Vec<_> = names.iter().map(|(o, n)| crate::decks::DeckCard {
        oracle_id: o.to_string(), name: n.to_string(), qty: if *o == "isl" { 31 } else { 1 }, board: crate::decks::Board::Main,
    }).collect();
    // The same oracle in two deck sections must not consume the same physical copy twice.
    cards.push(crate::decks::DeckCard { oracle_id: "ring".into(), name: "Sol Ring".into(), qty: 1, board: crate::decks::Board::Commander });
    let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Test", None, cards).await.unwrap();
    for (printing, condition, proxy, qty) in [("p-ring", "NM", 0, 1), ("p-isl", "NM", 0, 30), ("p-premium", "NM", 0, 1), ("p-bolt", "LP", 0, 1), ("p-tomb", "NM", 1, 1), ("p-bulk", "NM", 0, 1), ("p-unknown", "NM", 0, 1)] {
        sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'now', 'now')")
            .bind(printing).bind(&owner).bind(printing).bind(qty).bind(condition).bind(proxy).execute(&pool).await.unwrap();
    }
    let (_, before) = send(&app, axum::http::Method::GET, &format!("/api/decks/{deck}"), Some(&token), None).await;
    assert!(before["buylist"].is_null());
    let dir = tempfile::tempdir().unwrap();
    let ids = dir.path().join("ids.csv");
    std::fs::write(&ids, "uuid,scryfallId\nur,p-ring\nui,p-isl\nup,p-premium\nub,p-bolt\nuq,p-bulk\n").unwrap();
    let prices = dir.path().join("today.json");
    let ck = |buy: f64| serde_json::json!({"paper": {"cardkingdom": {"buylist": {"normal": {D3: buy}}, "currency": "USD"}}});
    std::fs::write(&prices, serde_json::json!({"meta": {"date": D3}, "data": {"ur": ck(1.25), "ui": ck(0.01), "up": ck(50.0), "ub": ck(0.5), "uq": ck(0.01)}}).to_string()).unwrap();
    let writer = Writer::acquire(&pool).await.unwrap();
    mtgjson::import_day(&pool, &writer, &prices, &ids, D3, "run").await.unwrap();
    writer.release().await;
    let (_, view) = send(&app, axum::http::Method::GET, &format!("/api/decks/{deck}"), Some(&token), None).await;
    let b = &view["buylist"];
    assert_eq!(b["provider"], "Card Kingdom buylist via MTGJSON");
    assert_eq!(b["date"], D3);
    assert_eq!((b["copies"].as_i64(), b["offered_copies"].as_i64(), b["unmatched_copies"].as_i64(), b["no_offer_copies"].as_i64()), (Some(35), Some(33), Some(1), Some(1)));
    assert!(b.get("cash_usd").is_none() && b.get("basics_cash_usd").is_none(), "no invented resale total");
    let references = b["cards"].as_array().unwrap();
    let premium = references.iter().find(|c| c["set_code"] == "lea").unwrap();
    assert_eq!((premium["name"].as_str(), premium["offer_usd"].as_f64()), (Some("Island"), Some(50.0)));
    assert_eq!(references.iter().find(|c| c["name"] == "Sol Ring").unwrap()["qty"], 1);
    assert_eq!(references.iter().find(|c| c["name"] == "Arcane Signet").unwrap()["offer_usd"], 0.01);
    assert_eq!(b["basics"], 31);
    assert!(view["singles_value"].is_object());
}

#[tokio::test]
async fn a_decks_cards_name_the_cheapest_printing_behind_each_price() {
    use crate::testutil::{app, send, user};
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "me@example.com").await;
    for (oracle, name) in [("tomb", "Ancient Tomb"), ("free", "Command Tower")] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES (?, ?, 'Land', 'now')").bind(oracle).bind(name).execute(&pool).await.unwrap();
    }
    for (id, oracle, set, set_name, number) in [("t-uma", "tomb", "uma", "Ultimate Masters", "236"), ("t-tmp", "tomb", "tmp", "Tempest", "315"), ("c-cmm", "free", "cmm", "Commander Masters", "1")] {
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?, ?, 'x', ?, ?, ?, 'en', '[\"nonfoil\"]', 'now')")
            .bind(id).bind(oracle).bind(set).bind(set_name).bind(number).execute(&pool).await.unwrap();
    }
    // Command Tower has no price at all: it stays unknown, with no printing named.
    file(&pool, "2026-10-31", &[("t-uma", usd(6500)), ("t-tmp", usd(5900))]).await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "tomb".into(), name: "Ancient Tomb".into(), qty: 1, board: crate::decks::Board::Main },
        crate::decks::DeckCard { oracle_id: "free".into(), name: "Command Tower".into(), qty: 1, board: crate::decks::Board::Main },
    ];
    let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Test", None, cards).await.unwrap();
    sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, proxy, created_at, updated_at) VALUES ('i', ?, 't-uma', 1, 'NM', 1, 'now', 'now')")
        .bind(&owner).execute(&pool).await.unwrap();
    let (_, view) = send(&app, axum::http::Method::GET, &format!("/api/decks/{deck}"), Some(&token), None).await;
    let entry = |name: &str| view["cards"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
    let tomb = entry("Ancient Tomb");
    assert_eq!(tomb["proxies"], 1);
    assert_eq!(tomb["cheapest_usd"], 59.0);
    assert_eq!(tomb["cheapest_printing"], serde_json::json!({"scryfall_id": "t-tmp", "set_code": "tmp", "set_name": "Tempest", "collector_number": "315", "date": "2026-10-31"}));
    let tower = entry("Command Tower");
    assert!(tower["cheapest_usd"].is_null() && tower["cheapest_printing"].is_null(), "a missing price stays missing");
    assert_eq!(view["ownership"]["proxy_value_usd"], 59.0);
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
    // The deck page names that printing beside its price.
    let cheapest = crate::deck_prices::cheapest_for(&pool, &["o"]).await.unwrap();
    let c = cheapest.get("o").unwrap();
    assert_eq!((c.usd, c.scryfall_id.as_str(), c.set_code.as_str(), c.collector_number.as_str()), (5.0, "kept", "cmm", "kept"));
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

#[tokio::test]
async fn a_file_that_stops_part_way_changes_nothing() {
    let pool = crate::db::test_pool().await;
    file(&pool, "2026-10-30", &[("a", usd(100)), ("b", usd(200)), ("c", usd(300))]).await;
    let before = points(&pool).await;
    // A second file for the same day, staged in part, then the import stops.
    stage_file(&pool, &[("a", usd(900)), ("b", NONE)]).await;
    assert_eq!(as_of(&pool, "a", 1, "2026-10-30").await, Some(100));
    assert_eq!(as_of(&pool, "c", 1, "2026-10-30").await, Some(300), "c isn't swept as left out");
    assert_eq!(latest(&pool, "b").await, Some(("2026-10-30".into(), Some(2.0), None)));
    assert_eq!(points(&pool).await, before);
    // The next writer clears what it staged.
    let writer = Writer::acquire(&pool).await.unwrap();
    let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_stage").fetch_one(&pool).await.unwrap();
    assert_eq!(staged, 0);
    // A writer whose lease another process took publishes nothing.
    sqlx::query("UPDATE price_meta SET value = json_object('id', 'elsewhere', 'until', 0) WHERE key = 'writer'").execute(&pool).await.unwrap();
    let err = publish_file(&pool, &writer, "2026-10-31", &[("a", usd(500))]).await.unwrap_err();
    assert!(err.to_string().contains("lease"), "{err}");
    assert_eq!(latest_date(&pool).await.unwrap().as_deref(), Some("2026-10-30"));
    assert_eq!(points(&pool).await, before);
    writer.release().await;
}

#[tokio::test]
async fn a_second_writer_waits_for_the_lease() {
    let pool = crate::db::test_pool().await;
    // Another process holds it, renewed a moment ago.
    let until = chrono::Utc::now().timestamp() + 3;
    sqlx::query("INSERT INTO price_meta (key, value) VALUES ('writer', json_object('id', 'elsewhere', 'until', ?))").bind(until).execute(&pool).await.unwrap();
    let started = std::time::Instant::now();
    let writer = Writer::acquire(&pool).await.unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    let holder: String = sqlx::query_scalar("SELECT value ->> 'id' FROM price_meta WHERE key = 'writer'").fetch_one(&pool).await.unwrap();
    assert_ne!(holder, "elsewhere");
    writer.release().await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_meta WHERE key = 'writer'").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn the_replay_leaves_out_a_day_no_import_finished() {
    let pool = crate::db::test_pool().await;
    for (date, runs) in [
        ("2026-10-26", &[("13:05", true), ("21:16", true)][..]),
        // Its only import stopped part way, so its rows may be part of a file...
        ("2026-10-27", &[("13:05", false)][..]),
        // ...and here a second file's import stopped part way over the first's finished one.
        ("2026-10-28", &[("13:05", true), ("18:41", false)][..]),
        ("2026-10-29", &[("13:05", false), ("16:44", true)][..]),
    ] {
        old_row(&pool, "a", date, Some(1.0), None).await;
        for (time, finished) in runs {
            import_run(&pool, date, time, *finished).await;
        }
    }
    assert_eq!(replay(&pool).await, backfill::Replayed { days: 2, skipped: vec!["2026-10-27".into(), "2026-10-28".into()] });
    let observed: Vec<i64> = sqlx::query_scalar("SELECT day FROM price_observation ORDER BY day").fetch_all(&pool).await.unwrap();
    assert_eq!(observed, [day_of("2026-10-26").unwrap(), day_of("2026-10-29").unwrap()]);
    // The check counts them as missing from the history.
    let v = backfill::verify(&pool, None).await.unwrap();
    assert_eq!((v.days, v.rows, v.mismatches, v.unobserved_days, v.unobserved_rows), (2, 2, 0, 2, 2));
    assert!(!v.clean());
    // A day not observed, or not a date, isn't checked as if it matched.
    assert!(backfill::verify(&pool, Some("2026-10-27")).await.is_err());
    assert!(backfill::verify(&pool, Some("28 Oct")).await.is_err());
    assert!(backfill::verify(&pool, Some("2026-10-29T00:00")).await.is_err());
    assert!(backfill::verify(&pool, Some("2026-10-29")).await.unwrap().clean());
}

#[tokio::test]
async fn an_empty_check_is_not_a_clean_one() {
    let pool = crate::db::test_pool().await;
    let v = backfill::verify(&pool, None).await.unwrap();
    assert_eq!(v.rows, 0);
    assert!(!v.clean());
}

#[tokio::test]
async fn the_replay_refuses_a_price_that_isnt_whole_cents() {
    let pool = crate::db::test_pool().await;
    old_row(&pool, "a", "2026-10-27", Some(1.234), None).await;
    import_run(&pool, "2026-10-27", "13:05", true).await;
    let writer = Writer::acquire(&pool).await.unwrap();
    let err = backfill::backfill_if_needed(&pool, &writer).await.unwrap_err();
    writer.release().await;
    assert!(err.to_string().contains("whole number of cents"), "{err}");
    assert_eq!(latest_date(&pool).await.unwrap(), None);
}

#[tokio::test]
async fn a_replayed_day_that_doesnt_match_is_not_published() {
    let pool = crate::db::test_pool().await;
    // A history out of step with the latest prices: z has a price from the 20th that nothing
    // marks gone, so it would read as a price on the 27th, when the old table has none.
    sqlx::query("INSERT INTO price_printing (scryfall_id) VALUES ('z')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_point (printing, series, day, cents) SELECT id, 1, ?, 300 FROM price_printing WHERE scryfall_id = 'z'")
        .bind(day_of("2026-10-20").unwrap())
        .execute(&pool)
        .await
        .unwrap();
    old_row(&pool, "a", "2026-10-27", Some(1.0), None).await;
    import_run(&pool, "2026-10-27", "13:05", true).await;
    for _start in 0..2 {
        let writer = Writer::acquire(&pool).await.unwrap();
        let err = backfill::backfill_if_needed(&pool, &writer).await.unwrap_err();
        writer.release().await;
        assert!(err.to_string().contains("doesn't match"), "{err}");
        // Nothing from the day (z's row is the one seeded), so the next start stops at it again.
        assert_eq!(latest_date(&pool).await.unwrap(), None);
        assert_eq!(points(&pool).await, 1);
        let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_stage").fetch_one(&pool).await.unwrap();
        assert_eq!(staged, 0);
    }
}

#[tokio::test]
async fn nobody_else_commits_between_the_lease_check_and_the_writes() {
    // A file and two connections: the in-memory test pool has one, so it can't show this.
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::connect(&format!("sqlite://{}", dir.path().join("t.db").display()), std::time::Duration::from_millis(crate::perf::SLOW_QUERY_MS)).await.unwrap();
    let writer = Writer::acquire(&pool).await.unwrap();
    let mut tx = writer.begin(&pool).await.unwrap();
    // Another request writes meanwhile (as the lease's heartbeat does): it waits for the
    // writer's transaction instead of committing under it...
    let other = tokio::spawn({
        let pool = pool.clone();
        async move { sqlx::query("INSERT INTO price_meta (key, value) VALUES ('other', 'x')").execute(&pool).await.map(|_| ()) }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!other.is_finished(), "another connection committed inside the price writer's transaction");
    // ...so the writer's first write succeeds, where a deferred transaction's would fail.
    sqlx::query("INSERT INTO price_printing (scryfall_id) VALUES ('a')").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    other.await.unwrap().unwrap();
    writer.release().await;
}
