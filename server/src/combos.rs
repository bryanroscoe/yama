//! Commander Spellbook's combos, kept locally for the computer's seats.
//!
//! Spellbook publishes every combo ("variant") as one gzipped JSON document and asks tools that
//! want the whole set to fetch that file on a schedule of their own and read it locally, not to
//! page through the API (docs/api.md in SpaceCowMedia/commander-spellbook-backend, read
//! 13 Nov 2026: "Fetch it on a schedule of your own and read it locally"). With
//! `YAMA_AUTO_IMPORT=1` this module downloads it once a week, keeps of each combo only its id,
//! its popularity and the cards it is made of (`spellbook_combos`, migration 0089), and answers
//! one question: which combos are made only of cards on this list ([`in_list`]). No deck list
//! leaves Yama for that, and it works for a list nobody saved (a guest's, a pasted one).
//!
//! Kept: combos Spellbook marks OK and legal in Commander, made of named cards alone (none of
//! its templates, such as "a creature that taps for mana": the named cards alone aren't the
//! combo), one copy of each, none of which has to be the commander (about one in a hundred
//! does; Yama doesn't keep which card, so those are left out). What a combo does is not kept: the engine finds that out by
//! playing it (`yama_play::SeatCombo`). Credit and a link to commanderspellbook.com are on the
//! pages that show combos.

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::io::AsyncWriteExt;

use crate::decks::{Board, DeckCard};
use crate::util::{new_id, now};

/// Spellbook's whole set of combos, gzipped (33 MB on 13 Nov 2026; 742 MB as JSON).
pub const VARIANTS_URL: &str = "https://json.commanderspellbook.com/variants.json.gz";
/// `import_runs.kind` of these imports.
const KIND: &str = "spellbook_variants";
/// The file is fetched again once the last good import is this old.
const MAX_AGE_HOURS: i64 = 24 * 7;
/// After any try, good or bad, the next waits this long: a file that won't import isn't
/// downloaded every hour.
const RETRY_HOURS: i64 = 12;
/// A combo of more cards than this isn't kept (the longest on 21 Oct 2026 had ten).
const MAX_CARDS: usize = 10;
/// An export with fewer usable combos than this is taken for a broken file, and what is stored
/// stays (there were 107,454 on 21 Oct 2026).
const MIN_COMBOS: usize = 10_000;
/// Rows written per transaction, so the import never holds SQLite's one writer for long.
const CHUNK: usize = 1_000;

// ── the export ─────────────────────────────────────────────────────────────

/// One combo as kept: Spellbook's id, its popularity and its cards by Spellbook's card number.
#[derive(Debug, Clone, PartialEq)]
struct Kept {
    id: String,
    popularity: Option<i64>,
    cards: Vec<i64>,
}

/// The export's usable combos, and the oracle id of every card they use by Spellbook's number.
/// Read one variant at a time: the file is far larger than what is kept of it.
#[derive(Debug, Default)]
struct KeptVariants {
    combos: Vec<Kept>,
    cards: HashMap<i64, String>,
}

#[derive(Deserialize)]
struct Export {
    /// When Spellbook built the file.
    #[serde(default)]
    timestamp: Option<String>,
    variants: KeptVariants,
}

// Every field but the ids may be missing or null: one variant of an unexpected shape is left
// out, and doesn't fail the whole file.
#[derive(Deserialize)]
struct Variant {
    id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    uses: Option<Vec<Use>>,
    /// Templates: requirements that aren't a named card.
    #[serde(default)]
    requires: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default)]
    legalities: Option<Legalities>,
    #[serde(default)]
    popularity: Option<f64>,
}

#[derive(Deserialize)]
struct Use {
    card: UsedCard,
    #[serde(default)]
    quantity: Option<f64>,
    #[serde(rename = "mustBeCommander", default)]
    must_be_commander: Option<bool>,
}

#[derive(Deserialize)]
struct UsedCard {
    id: i64,
    #[serde(rename = "oracleId", default)]
    oracle_id: Option<String>,
}

#[derive(Deserialize)]
struct Legalities {
    #[serde(default)]
    commander: Option<bool>,
}

impl KeptVariants {
    /// Keep `v` if a computer's seat could be told about it (the module's rules).
    fn take(&mut self, v: Variant) {
        let legal = v.legalities.is_some_and(|l| l.commander == Some(true));
        let uses = v.uses.unwrap_or_default();
        if v.status.as_deref() != Some("OK") || !legal || v.requires.is_some_and(|r| !r.is_empty()) || uses.is_empty() || uses.len() > MAX_CARDS {
            return;
        }
        let mut cards: Vec<i64> = Vec::with_capacity(uses.len());
        for u in &uses {
            let known = u.card.oracle_id.as_deref().is_some_and(|o| !o.is_empty());
            if !known || u.quantity.unwrap_or(1.0) != 1.0 || u.must_be_commander == Some(true) || cards.contains(&u.card.id) {
                return;
            }
            cards.push(u.card.id);
        }
        for u in uses {
            if let Some(oracle) = u.card.oracle_id {
                self.cards.entry(u.card.id).or_insert(oracle);
            }
        }
        self.combos.push(Kept { id: v.id, popularity: v.popularity.map(|p| p as i64), cards });
    }
}

impl<'de> Deserialize<'de> for KeptVariants {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Variants;
        impl<'de> serde::de::Visitor<'de> for Variants {
            type Value = KeptVariants;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an array of Spellbook variants")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<KeptVariants, A::Error> {
                let mut kept = KeptVariants::default();
                while let Some(variant) = seq.next_element::<Variant>()? {
                    kept.take(variant);
                }
                Ok(kept)
            }
        }
        deserializer.deserialize_seq(Variants)
    }
}

/// Read Spellbook's export from a file, gzipped or not.
fn read_export(path: &Path) -> anyhow::Result<Export> {
    use std::io::BufRead as _;
    let mut file = BufReader::with_capacity(1 << 20, std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?);
    let gzipped = file.fill_buf()?.starts_with(&[0x1f, 0x8b]);
    let export: serde_json::Result<Export> = if gzipped {
        serde_json::from_reader(BufReader::with_capacity(1 << 20, flate2::bufread::GzDecoder::new(file)))
    } else {
        serde_json::from_reader(file)
    };
    export.with_context(|| format!("reading Spellbook's combos from {}", path.display()))
}

// ── importing ──────────────────────────────────────────────────────────────

/// Read the export at `path` and store its usable combos as import `run`. Combos the file no
/// longer has are deleted. Refuses a file with fewer than `at_least` usable combos, leaving
/// what is stored. Returns how many combos are stored now, and when Spellbook built the file.
async fn import_file(pool: &SqlitePool, path: PathBuf, run: &str, at_least: usize) -> anyhow::Result<(usize, Option<String>)> {
    let export = tokio::task::spawn_blocking(move || read_export(&path)).await.context("reading the export")??;
    let kept = export.variants;
    anyhow::ensure!(kept.combos.len() >= at_least, "the export has only {} usable combos; keeping what is stored", kept.combos.len());
    let known: Vec<String> = sqlx::query_scalar("SELECT id FROM spellbook_combos").fetch_all(pool).await?;
    let known: HashSet<String> = known.into_iter().collect();
    let cards: Vec<(i64, &str)> = kept.cards.iter().map(|(n, oracle)| (*n, oracle.as_str())).collect();
    for chunk in cards.chunks(CHUNK) {
        let mut tx = pool.begin().await?;
        for (n, oracle) in chunk {
            sqlx::query("INSERT OR REPLACE INTO spellbook_cards (n, oracle_id) VALUES (?, ?)").bind(*n).bind(*oracle).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    for chunk in kept.combos.chunks(CHUNK) {
        let mut tx = pool.begin().await?;
        for combo in chunk {
            let n: i64 = sqlx::query_scalar(
                "INSERT INTO spellbook_combos (id, cards, popularity, run) VALUES (?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET popularity = excluded.popularity, run = excluded.run
                 RETURNING n",
            )
            .bind(&combo.id)
            .bind(combo.cards.len() as i64)
            .bind(combo.popularity)
            .bind(run)
            .fetch_one(&mut *tx)
            .await?;
            // A combo's id names its cards, so one already stored has them.
            if !known.contains(&combo.id) {
                for card in &combo.cards {
                    sqlx::query("INSERT OR IGNORE INTO spellbook_combo_cards (card, combo) VALUES (?, ?)").bind(*card).bind(n).execute(&mut *tx).await?;
                }
            }
        }
        tx.commit().await?;
    }
    sqlx::query("DELETE FROM spellbook_combos WHERE run != ?").bind(run).execute(pool).await?;
    Ok((kept.combos.len(), export.timestamp))
}

/// The client the export is fetched with. Unlike the server's usual one it doesn't undo the
/// file's gzip encoding on the way in, so what lands on disk is the 33 MB file, not its 742 MB
/// of JSON.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Yama/", env!("CARGO_PKG_VERSION"), " (private Magic app)"))
        .no_gzip()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("http client")
}

/// Download Spellbook's export to `data_dir`, import it and delete the file. Each try is a row
/// in `import_runs`. Returns how many combos are stored.
pub async fn refresh(pool: &SqlitePool, http: &reqwest::Client, url: &str, data_dir: &Path) -> anyhow::Result<usize> {
    let run = new_id();
    sqlx::query("INSERT INTO import_runs (id, kind, source_url, started_at) VALUES (?, ?, ?, ?)").bind(&run).bind(KIND).bind(url).bind(now()).execute(pool).await?;
    let path = data_dir.join("spellbook-variants.json.gz");
    // A file a stopped server left behind.
    let _ = tokio::fs::remove_file(&path).await;
    let result = async {
        download(http, url, &path).await?;
        import_file(pool, path.clone(), &run, MIN_COMBOS).await
    }
    .await;
    let _ = tokio::fs::remove_file(&path).await;
    let (rows, error, built) = match &result {
        Ok((n, built)) => (Some(*n as i64), None, built.clone()),
        Err(e) => (None, Some(format!("{e:#}")), None),
    };
    sqlx::query("UPDATE import_runs SET finished_at = ?, rows = ?, error = ?, source_updated_at = ? WHERE id = ?")
        .bind(now())
        .bind(rows)
        .bind(error)
        .bind(built)
        .bind(&run)
        .execute(pool)
        .await?;
    result.map(|(n, _)| n)
}

async fn download(http: &reqwest::Client, url: &str, path: &Path) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let resp = http.get(url).timeout(crate::util::DOWNLOAD_TOTAL).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(path).await?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = crate::util::next_chunk(&mut stream).await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

/// Whether an import should run now: none has succeeded in [`MAX_AGE_HOURS`], and none was
/// tried in [`RETRY_HOURS`]. On a database error, not now.
async fn due(pool: &SqlitePool) -> bool {
    let tries: sqlx::Result<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT MAX(CASE WHEN error IS NULL AND finished_at IS NOT NULL THEN finished_at END), MAX(started_at) FROM import_runs WHERE kind = ?",
    )
    .bind(KIND)
    .fetch_one(pool)
    .await;
    let Ok((imported, tried)) = tries else { return false };
    let hours_since = |at: Option<String>| at.and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok()).map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours());
    hours_since(imported).is_none_or(|h| h >= MAX_AGE_HOURS) && hours_since(tried).is_none_or(|h| h >= RETRY_HOURS)
}

/// Background refresh for a running server (with `YAMA_AUTO_IMPORT=1`): wakes hourly and imports
/// when one is [`due`].
pub fn spawn_scheduler(pool: SqlitePool, data_dir: PathBuf) {
    tokio::spawn(async move {
        let http = client();
        loop {
            if due(&pool).await {
                let job = crate::perf::Job::start("Spellbook combos", Duration::from_secs(600));
                let result = refresh(&pool, &http, VARIANTS_URL, &data_dir).await;
                match &result {
                    Ok(n) => tracing::info!(combos = *n, "imported Commander Spellbook's combos"),
                    Err(e) => tracing::warn!(error = %format!("{e:#}"), "couldn't import Commander Spellbook's combos"),
                }
                job.finish(&result, "weekly import");
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

/// `yama-server import-combos`: the import once, now.
pub async fn run_once(pool: &SqlitePool, data_dir: &Path) -> anyhow::Result<()> {
    let n = refresh(pool, &client(), VARIANTS_URL, data_dir).await?;
    println!("Commander Spellbook combos stored: {n}");
    Ok(())
}

// ── asking ─────────────────────────────────────────────────────────────────

/// A stored combo found in a list: Spellbook's id, and its cards as the list names them.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub cards: Vec<String>,
}

/// The stored combos made only of cards in `cards`' commander and main boards, at most `limit`:
/// those of fewest cards first, then the most popular. `None` until an import has finished (a
/// first one still running, or stopped part-way, doesn't count), so a caller can tell "no
/// combos" from "not known yet".
pub async fn in_list(pool: &SqlitePool, cards: &[DeckCard], limit: usize) -> sqlx::Result<Option<Vec<Found>>> {
    let imported: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM import_runs WHERE kind = ? AND error IS NULL AND finished_at IS NOT NULL)")
        .bind(KIND)
        .fetch_one(pool)
        .await?;
    if !imported {
        return Ok(None);
    }
    // The list's own name for each card, by oracle id.
    let names: HashMap<&str, &str> =
        cards.iter().filter(|c| c.board != Board::Side && c.qty > 0 && !c.oracle_id.is_empty()).map(|c| (c.oracle_id.as_str(), c.name.as_str())).collect();
    if names.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let oracle_ids = serde_json::to_string(&names.keys().collect::<Vec<_>>()).unwrap_or_default();
    let combos: Vec<(i64, String)> = sqlx::query_as(
        "SELECT c.n, c.id FROM spellbook_combo_cards cc
           JOIN spellbook_cards sc ON sc.n = cc.card
           JOIN spellbook_combos c ON c.n = cc.combo
          WHERE sc.oracle_id IN (SELECT value FROM json_each(?))
          GROUP BY c.n HAVING COUNT(*) = c.cards
          ORDER BY c.cards, c.popularity DESC, c.id LIMIT ?",
    )
    .bind(&oracle_ids)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;
    if combos.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let numbers = serde_json::to_string(&combos.iter().map(|(n, _)| *n).collect::<Vec<_>>()).unwrap_or_default();
    let used: Vec<(i64, String)> = sqlx::query_as(
        "SELECT cc.combo, sc.oracle_id FROM spellbook_combo_cards cc JOIN spellbook_cards sc ON sc.n = cc.card
          WHERE cc.combo IN (SELECT value FROM json_each(?)) ORDER BY cc.combo, sc.oracle_id",
    )
    .bind(&numbers)
    .fetch_all(pool)
    .await?;
    let mut by_combo: HashMap<i64, Vec<String>> = HashMap::new();
    for (combo, oracle) in used {
        if let Some(name) = names.get(oracle.as_str()) {
            by_combo.entry(combo).or_default().push(name.to_string());
        }
    }
    Ok(Some(combos.into_iter().filter_map(|(n, id)| Some(Found { id, cards: by_combo.remove(&n)? })).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(oracle: &str, name: &str, board: Board) -> DeckCard {
        DeckCard { oracle_id: oracle.into(), name: name.into(), qty: 1, board }
    }

    fn variant(id: &str, cards: &[(i64, &str)], popularity: Option<i64>) -> serde_json::Value {
        let uses: Vec<serde_json::Value> =
            cards.iter().map(|(n, oracle)| serde_json::json!({ "card": { "id": n, "name": format!("Card {n}"), "oracleId": oracle }, "quantity": 1, "zoneLocations": ["B"] })).collect();
        serde_json::json!({ "id": id, "status": "OK", "uses": uses, "requires": [], "produces": [{ "feature": { "name": "Infinite mana" } }], "legalities": { "commander": true, "vintage": true }, "popularity": popularity })
    }

    /// Record a finished import, as [`refresh`] does around [`import_file`].
    async fn finished(pool: &SqlitePool, run: &str) {
        sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at) VALUES (?, ?, ?, ?)").bind(run).bind(KIND).bind(now()).bind(now()).execute(pool).await.unwrap();
    }

    /// Write an export of `variants` to a new gzipped file in `dir`.
    fn export(dir: &Path, variants: Vec<serde_json::Value>) -> PathBuf {
        use std::io::Write as _;
        let path = dir.join(format!("{}.json.gz", new_id()));
        let body = serde_json::json!({ "timestamp": "2026-11-13T09:00:00Z", "version": "7.3.0", "variants": variants, "aliases": [] });
        let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
        gz.write_all(body.to_string().as_bytes()).unwrap();
        gz.finish().unwrap();
        path
    }

    #[tokio::test]
    async fn the_export_is_kept_and_a_lists_combos_are_found() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let deck = vec![card("o-a", "Alpha", Board::Commander), card("o-b", "Beta // Back", Board::Main), card("o-c", "Gamma", Board::Main), card("o-d", "Delta", Board::Side)];
        // Before any import the answer is "not known", not "none".
        assert_eq!(in_list(&pool, &deck, 100).await.unwrap(), None);

        let mut with_template = variant("1-2-t", &[(1, "o-a"), (2, "o-b")], Some(900));
        with_template["requires"] = serde_json::json!([{ "template": { "id": 140, "name": "Mana Dork" }, "quantity": 1 }]);
        let mut not_legal = variant("1-3-x", &[(1, "o-a"), (3, "o-c")], Some(800));
        not_legal["legalities"]["commander"] = serde_json::json!(false);
        let mut two_copies = variant("1-1", &[(1, "o-a"), (2, "o-b")], Some(700));
        two_copies["uses"][1]["quantity"] = serde_json::json!(2);
        let mut needs_review = variant("2-3-r", &[(2, "o-b"), (3, "o-c")], Some(600));
        needs_review["status"] = serde_json::json!("NR");
        let mut as_commander = variant("3-1-c", &[(3, "o-c"), (1, "o-a")], Some(500));
        as_commander["uses"][0]["mustBeCommander"] = serde_json::json!(true);
        // A shape Spellbook doesn't send today: left out, and the rest still read.
        let mut odd = variant("9-9", &[(1, "o-a"), (2, "o-b")], Some(400));
        odd["legalities"] = serde_json::Value::Null;
        odd["uses"] = serde_json::Value::Null;
        let first = export(
            dir.path(),
            vec![
                variant("1-2", &[(1, "o-a"), (2, "o-b")], Some(10)),
                variant("2-3", &[(2, "o-b"), (3, "o-c")], Some(50)),
                variant("1-2-3", &[(1, "o-a"), (2, "o-b"), (3, "o-c")], None),
                // On the sideboard, and not on the list at all.
                variant("1-4", &[(1, "o-a"), (4, "o-d")], Some(999)),
                variant("1-5", &[(1, "o-a"), (5, "o-e")], Some(999)),
                with_template,
                not_legal,
                two_copies,
                needs_review,
                as_commander,
                odd,
            ],
        );
        let (stored, built) = import_file(&pool, first, "run-1", 1).await.unwrap();
        assert_eq!((stored, built.as_deref()), (5, Some("2026-11-13T09:00:00Z")));
        // Stored but not finished (a first import still running): still "not known".
        assert_eq!(in_list(&pool, &deck, 100).await.unwrap(), None);
        finished(&pool, "run-1").await;

        // Fewest cards first, then the most popular; each card as the list names it.
        let found = in_list(&pool, &deck, 100).await.unwrap().unwrap();
        let shown: Vec<(&str, Vec<&str>)> = found.iter().map(|f| (f.id.as_str(), f.cards.iter().map(String::as_str).collect())).collect();
        assert_eq!(shown, [("2-3", vec!["Beta // Back", "Gamma"]), ("1-2", vec!["Alpha", "Beta // Back"]), ("1-2-3", vec!["Alpha", "Beta // Back", "Gamma"])]);
        assert_eq!(in_list(&pool, &deck, 1).await.unwrap().unwrap().len(), 1);
        // A list with none of them, once imported, has none.
        assert_eq!(in_list(&pool, &[card("o-z", "Zeta", Board::Main)], 100).await.unwrap(), Some(vec![]));

        // A later export drops a combo and adds one; a file too small to trust changes nothing.
        let second = export(dir.path(), vec![variant("1-2", &[(1, "o-a"), (2, "o-b")], Some(11)), variant("1-3", &[(1, "o-a"), (3, "o-c")], Some(5))]);
        assert!(import_file(&pool, second.clone(), "run-2", 3).await.is_err());
        assert_eq!(in_list(&pool, &deck, 100).await.unwrap().unwrap().len(), 3);
        assert_eq!(import_file(&pool, second, "run-2", 1).await.unwrap().0, 2);
        let ids: Vec<String> = in_list(&pool, &deck, 100).await.unwrap().unwrap().into_iter().map(|f| f.id).collect();
        assert_eq!(ids, ["1-2", "1-3"]);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spellbook_combo_cards").fetch_one(&pool).await.unwrap();
        assert_eq!(left, 4, "the dropped combos' cards went with them");
    }

    #[tokio::test]
    async fn an_import_is_due_weekly_and_not_right_after_a_try() {
        let pool = crate::db::test_pool().await;
        assert!(due(&pool).await, "never imported");
        let run = |id: &'static str, started: String, finished: Option<String>, error: Option<&'static str>| {
            let pool = pool.clone();
            async move {
                sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?)").bind(id).bind(KIND).bind(started).bind(finished).bind(error).execute(&pool).await.unwrap();
            }
        };
        let ago = |hours: i64| (chrono::Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        // A failed try an hour ago: wait. One from yesterday: try again.
        run("a", ago(1), Some(ago(1)), Some("boom")).await;
        assert!(!due(&pool).await);
        sqlx::query("UPDATE import_runs SET started_at = ?").bind(ago(30)).execute(&pool).await.unwrap();
        assert!(due(&pool).await);
        // A good import two days ago: not for a week.
        run("b", ago(48), Some(ago(48)), None).await;
        assert!(!due(&pool).await);
        sqlx::query("UPDATE import_runs SET started_at = ?1, finished_at = ?1").bind(ago(24 * 8)).execute(&pool).await.unwrap();
        assert!(due(&pool).await);
    }
}
