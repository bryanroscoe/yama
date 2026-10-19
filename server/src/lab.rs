//! Simulation lab: the Commander precon catalog, imported rating runs (commander-decks
//! scripts/sim/analyze.py summaries) and the read APIs over them.
//!
//! Every number from a run is simulated (phase's AI playing every seat) and travels with the run's
//! label: engine, card data, runner, AI level, games and date. Real-game numbers (playgroup.gg)
//! travel separately, with their own source and date, and are never mixed in.
//!
//! Visibility: the precon catalog and runs without an owner are global (everyone signed in reads
//! them); a run with an owner is only ever returned to that owner, and anyone else gets a 404.
//!
//! "Try a change" (a user's own paired experiments, played by the server) is in [`experiments`],
//! its games' worker in [`worker`], its schedule in [`pairing`] and its maths in [`stats`].

pub mod experiments;
pub mod pairing;
pub mod stats;
pub mod worker;
#[cfg(test)]
mod experiment_tests;

use crate::auth::CurrentUser;
use crate::cards::{CARD_COLUMNS, Card};
use crate::decks::{Board, DeckCard, Validation};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use anyhow::Context;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/precons", get(list_precons))
        .route("/api/precons/{id}", get(get_precon))
        .route("/api/precons/{id}/deck", post(create_precon_deck))
        .route("/api/lab/runs", get(list_runs))
        .route("/api/lab/runs/{id}", get(get_run))
        .merge(experiments::router())
}

/// Folder for decks made from a precon's stock list.
const PRECON_FOLDER: &str = "Precons";
/// `applied_ops.kind` for "make a deck from this precon", so a retried request makes one deck.
const PRECON_DECK_OP: &str = "precon_deck";

// ── precon catalog import ───────────────────────────────────────────────────

/// One card line of a precon's stock list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreconCard {
    pub name: String,
    /// `None` when Yama's card data doesn't know the name (yet).
    pub oracle_id: Option<String>,
    pub qty: u32,
    pub board: Board,
}

#[derive(Deserialize)]
struct Index {
    generated: Option<String>,
    decks: Vec<IndexDeck>,
    /// Precons that repeat an earlier precon's commander and 100 cards; not in `decks` and not
    /// imported (Bryan, 2026-10-19: ignore that they exist).
    #[serde(default)]
    left_out: Vec<Value>,
}

#[derive(Deserialize)]
struct IndexDeck {
    id: String,
    name: String,
    set: String,
    released: Option<String>,
    commanders: Vec<String>,
    #[serde(default)]
    color_identity: String,
    kind: String,
    playgroup_id: Option<i64>,
    playgroup_name: Option<String>,
    playgroup_tier: Option<String>,
    playgroup_win_rate_4p: Option<f64>,
    playgroup_games: Option<i64>,
    playgroup_url: Option<String>,
    mtgjson: Option<String>,
    same_list_as: Option<String>,
    #[serde(default)]
    notes: Vec<String>,
    phase_support: Option<Value>,
}

/// The playgroup.gg tier list the index's real-game stats came from (for their source label).
#[derive(Deserialize, Default)]
struct PlaygroupSource {
    source: Option<String>,
    fetched: Option<String>,
    method: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct PreconImport {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    /// Index entries that aren't precons (Bryan's own lists); not imported.
    pub skipped: usize,
    /// Repeats of an earlier precon that the index leaves out.
    pub left_out: usize,
    /// "precon: card" for names Yama's card data doesn't know; kept with no oracle id.
    pub unresolved: Vec<String>,
    /// Precons already in Yama that this index doesn't list (left as they are).
    pub not_in_index: Vec<String>,
}

/// Lab deck ids of precons start with this; a user's lists have other prefixes ("bryan/").
const PRECON_PREFIX: &str = "precons/";

/// "precons/counterpunch" -> "counterpunch".
fn precon_slug(lab_id: &str) -> String {
    lab_id.strip_prefix(PRECON_PREFIX).unwrap_or(lab_id).replace('/', "-")
}

/// The newest playgroup tier list beside the decks folder (data/sim/playgroup-precon-tiers-*.json).
fn find_playgroup_file(index: &std::path::Path) -> Option<std::path::PathBuf> {
    let sim = index.parent()?.parent()?;
    let mut files: Vec<_> = std::fs::read_dir(sim)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("playgroup-precon-tiers-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    files.pop()
}

/// Import the precon catalog from commander-decks' `data/sim/decks/index.json` and the deck files
/// next to it (`<id>.txt`, the lab's deck format). Upserts by slug; a precon whose content hasn't
/// changed isn't touched, so importing the same index twice changes nothing. All or nothing: a deck
/// file that can't be read or parsed stops the import before anything is written.
pub async fn import_precons(pool: &SqlitePool, index_path: &std::path::Path, playgroup_path: Option<&std::path::Path>) -> anyhow::Result<PreconImport> {
    let text = std::fs::read_to_string(index_path).with_context(|| format!("reading {}", index_path.display()))?;
    let index: Index = serde_json::from_str(&text).with_context(|| format!("reading {}", index_path.display()))?;
    let root = index_path.parent().context("the index has no folder")?;
    let pg_path = playgroup_path.map(|p| p.to_path_buf()).or_else(|| find_playgroup_file(index_path));
    let pg_source: PlaygroupSource = match &pg_path {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?)
            .with_context(|| format!("reading {}", p.display()))?,
        None => PlaygroupSource::default(),
    };
    let mut report = PreconImport { left_out: index.left_out.len(), ..Default::default() };

    // Read and parse every deck first.
    let mut decks = Vec::new();
    for d in index.decks {
        if d.kind != "precon" {
            report.skipped += 1;
            continue;
        }
        let path = root.join(format!("{}.txt", d.id));
        let deck_text = std::fs::read_to_string(&path).with_context(|| format!("{}: reading {}", d.id, path.display()))?;
        let file = yama_play::lab::parse_deck(&deck_text).map_err(|e| anyhow::anyhow!("{}: {e}", d.id))?;
        decks.push((d, file));
    }

    // Names to oracle ids, each distinct name once.
    let names: Vec<String> = decks
        .iter()
        .flat_map(|(_, f)| f.commander.iter().chain(&f.main).map(|(_, n)| n.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let ids = crate::cards::resolve_names(pool, &names).await.map_err(|e| anyhow::anyhow!("{e}"))?;

    // Real-game rank among the precons playgroup.gg rates: 1 = highest 4-player win rate.
    let rates: Vec<f64> = decks.iter().filter_map(|(d, _)| d.playgroup_win_rate_4p).collect();
    let mut set_names: HashMap<String, Option<String>> = HashMap::new();
    let stamp = now();
    let mut seen = BTreeSet::new();
    let mut tx = pool.begin().await?;
    for (d, file) in decks {
        let id = precon_slug(&d.id);
        seen.insert(id.clone());
        let mut cards: Vec<PreconCard> = Vec::new();
        for (board, lines) in [(Board::Commander, &file.commander), (Board::Main, &file.main)] {
            for (qty, name) in lines {
                if let Some(c) = cards.iter_mut().find(|c| &c.name == name && c.board == board) {
                    c.qty += qty;
                    continue;
                }
                let oracle_id = ids.get(name).cloned();
                if oracle_id.is_none() {
                    report.unresolved.push(format!("{}: {name}", d.name));
                }
                cards.push(PreconCard { name: name.clone(), oracle_id, qty: *qty, board: board.clone() });
            }
        }
        let set_code = d.set.clone();
        let set_name = match set_names.get(&set_code) {
            Some(n) => n.clone(),
            None => {
                let n: Option<String> = sqlx::query_scalar("SELECT set_name FROM printings WHERE set_code = ? LIMIT 1")
                    .bind(set_code.to_lowercase())
                    .fetch_optional(&mut *tx)
                    .await?;
                set_names.insert(set_code.clone(), n.clone());
                n
            }
        };
        let playgroup = d.playgroup_win_rate_4p.map(|wr| {
            json!({
                "tier": d.playgroup_tier,
                "win_rate_4p": wr,
                "games": d.playgroup_games,
                "rank": 1 + rates.iter().filter(|r| **r > wr).count(),
                "of": rates.len(),
                "url": d.playgroup_url,
                "source": pg_source.source.as_deref().unwrap_or("playgroup.gg"),
                "fetched": pg_source.fetched,
                "method": pg_source.method,
            })
        });
        let source = match &d.mtgjson {
            Some(url) => format!("MTGJSON {url}, via commander-decks data/sim/decks/index.json ({})", index.generated.as_deref().unwrap_or("undated")),
            None => format!("commander-decks data/sim/decks/index.json ({})", index.generated.as_deref().unwrap_or("undated")),
        };
        let row = json!([
            d.id,
            d.name,
            set_code,
            set_name,
            d.released,
            d.commanders,
            d.color_identity,
            cards,
            d.same_list_as.as_deref().map(precon_slug),
            d.playgroup_id,
            d.playgroup_name,
            playgroup,
            d.phase_support,
            d.notes,
            source
        ]);
        let hash = sha256_hex(&row.to_string());
        let existing: Option<String> = sqlx::query_scalar("SELECT content_sha256 FROM precons WHERE id = ?").bind(&id).fetch_optional(&mut *tx).await?;
        match existing.as_deref() {
            Some(h) if h == hash => {
                report.unchanged += 1;
                continue;
            }
            Some(_) => report.updated += 1,
            None => report.added += 1,
        }
        let r = row.as_array().expect("row is an array");
        sqlx::query(
            "INSERT INTO precons (id, lab_id, name, set_code, set_name, released, commanders, color_identity, cards, same_list_as,
                playgroup_id, playgroup_name, playgroup, engine_support, notes, source, content_sha256, imported_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET lab_id = excluded.lab_id, name = excluded.name, set_code = excluded.set_code,
                set_name = excluded.set_name, released = excluded.released, commanders = excluded.commanders,
                color_identity = excluded.color_identity, cards = excluded.cards, same_list_as = excluded.same_list_as,
                playgroup_id = excluded.playgroup_id, playgroup_name = excluded.playgroup_name, playgroup = excluded.playgroup,
                engine_support = excluded.engine_support, notes = excluded.notes, source = excluded.source,
                content_sha256 = excluded.content_sha256, imported_at = excluded.imported_at",
        )
        .bind(&id)
        .bind(&d.id)
        .bind(&d.name)
        .bind(&set_code)
        .bind(&set_name)
        .bind(&d.released)
        .bind(r[5].to_string())
        .bind(&d.color_identity)
        .bind(r[7].to_string())
        .bind(d.same_list_as.as_deref().map(precon_slug))
        .bind(d.playgroup_id)
        .bind(&d.playgroup_name)
        .bind(playgroup_text(&r[11]))
        .bind(playgroup_text(&r[12]))
        .bind(r[13].to_string())
        .bind(&source)
        .bind(&hash)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    }
    let all: Vec<String> = sqlx::query_scalar("SELECT id FROM precons ORDER BY id").fetch_all(&mut *tx).await?;
    report.not_in_index = all.into_iter().filter(|id| !seen.contains(id)).collect();
    tx.commit().await?;
    Ok(report)
}

/// JSON text, or NULL for a JSON null.
fn playgroup_text(v: &Value) -> Option<String> {
    (!v.is_null()).then(|| v.to_string())
}

// ── run import ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct RunImport {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// "added", "updated" or "unchanged".
    pub outcome: &'static str,
    pub ratings: usize,
}

/// Python's json writes NaN and Infinity as bare words, which aren't JSON. Read them as null.
fn without_non_finite(text: &str) -> Cow<'_, str> {
    if !(text.contains("NaN") || text.contains("Infinity")) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
        } else if let Some(word) = ["-Infinity", "Infinity", "NaN"].iter().find(|w| rest.starts_with(**w)) {
            out.push_str("null");
            rest = &rest[word.len()..];
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    Cow::Owned(out)
}

/// Labels from a summary's `versions` map ({label: games}), most games first.
fn version_labels(summary: &Value, key: &str) -> Option<String> {
    let map = summary.pointer(&format!("/versions/{key}"))?.as_object()?;
    let mut labels: Vec<(&String, i64)> = map.iter().map(|(k, v)| (k, v.as_i64().unwrap_or(0))).collect();
    labels.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    (!labels.is_empty()).then(|| labels.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", "))
}

fn f(v: &Value, ptr: &str) -> Option<f64> {
    v.pointer(ptr).and_then(Value::as_f64)
}

/// Deck ids in a summary that aren't precons (a user's own lists), from everywhere analyze.py
/// writes deck ids: the ratings, the 1v1 matrix, the paired comparison and the run's settings.
fn non_precon_ids(summary: &Value) -> BTreeSet<String> {
    let list = |ptr: &str| summary.pointer(ptr).and_then(Value::as_array).into_iter().flatten();
    let mut ids: Vec<&Value> = Vec::new();
    ids.extend(list("/decks").filter_map(|d| d.get("id")));
    ids.extend(list("/matrix/ids"));
    ids.extend(list("/paired/variants").filter_map(|v| v.get("id")));
    ids.extend(list("/paired/comparisons").flat_map(|c| [c.get("base"), c.get("variant")]).flatten());
    ids.extend(list("/run_meta/paired/variants"));
    ids.extend(list("/run_meta/filter/ids"));
    ids.into_iter().filter_map(Value::as_str).filter(|id| !id.starts_with(PRECON_PREFIX)).map(str::to_string).collect()
}

/// Import an analysed run (`summary.json`). Global when `owner_email` is `None`, else visible to
/// that user only. Idempotent by name within its scope: importing the same summary again changes
/// nothing; a newer summary for the same name replaces the run's content and keeps its id.
///
/// A global run may only rate precons: everyone signed in reads it, so a run that rates someone's
/// own lists is refused unless it's imported with that owner.
pub async fn import_run(pool: &SqlitePool, summary_path: &std::path::Path, owner_email: Option<&str>, name: Option<&str>) -> anyhow::Result<RunImport> {
    let raw = std::fs::read_to_string(summary_path).with_context(|| format!("reading {}", summary_path.display()))?;
    let summary: Value = serde_json::from_str(&without_non_finite(&raw)).with_context(|| format!("reading {}", summary_path.display()))?;
    let decks = summary.get("decks").and_then(Value::as_array).context("the summary has no decks; is it an analyze.py summary.json?")?;
    let name = name
        .map(str::to_string)
        .or_else(|| summary.get("run").and_then(Value::as_str).map(str::to_string))
        .context("the summary names no run; pass --name")?;
    if owner_email.is_none() {
        let private = non_precon_ids(&summary);
        if !private.is_empty() {
            let shown: Vec<&str> = private.iter().take(3).map(String::as_str).collect();
            let more = if private.len() > shown.len() { format!(" and {} more", private.len() - shown.len()) } else { String::new() };
            anyhow::bail!(
                "run {name} rates decks that aren't precons ({}{more}); a global run is shown to everyone, so import it with --owner EMAIL",
                shown.join(", ")
            );
        }
    }
    let owner: Option<String> = match owner_email {
        Some(email) => Some(
            sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
                .bind(email)
                .fetch_optional(pool)
                .await?
                .with_context(|| format!("no user {email}; sign in once first"))?,
        ),
        None => None,
    };
    let kind = if summary.get("paired").is_some_and(|p| !p.is_null()) { "paired" } else { "precon-ratings" };
    let difficulty = summary.pointer("/run_meta/difficulty").and_then(Value::as_str).map(str::to_string).or_else(|| {
        let m = summary.pointer("/counts/difficulty")?.as_object()?;
        (!m.is_empty()).then(|| m.keys().cloned().collect::<Vec<_>>().join(", "))
    });
    let games = summary.pointer("/counts/games_in_model").and_then(Value::as_i64).unwrap_or(0);
    let analysed_at = summary.get("generated").and_then(Value::as_str).map(str::to_string);
    let created_at = summary.pointer("/run_meta/created").and_then(Value::as_str).map(str::to_string).or_else(|| analysed_at.clone()).unwrap_or_else(now);
    let text = summary.to_string();
    let hash = sha256_hex(&text);

    let mut tx = pool.begin().await?;
    let existing: Option<(String, String)> = sqlx::query_as("SELECT id, summary_sha256 FROM lab_runs WHERE name = ? AND owner_id IS ?")
        .bind(&name)
        .bind(&owner)
        .fetch_optional(&mut *tx)
        .await?;
    let (id, outcome) = match existing {
        Some((id, h)) if h == hash => {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_ratings WHERE run_id = ?").bind(&id).fetch_one(&mut *tx).await?;
            return Ok(RunImport { id, name, kind: kind.into(), outcome: "unchanged", ratings: n as usize });
        }
        Some((id, _)) => (id, "updated"),
        None => (new_id(), "added"),
    };
    sqlx::query(
        "INSERT INTO lab_runs (id, owner_id, name, kind, engine, card_data, runner, difficulty, games, created_at, analysed_at, imported_at, summary, summary_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, engine = excluded.engine, card_data = excluded.card_data,
            runner = excluded.runner, difficulty = excluded.difficulty, games = excluded.games, created_at = excluded.created_at,
            analysed_at = excluded.analysed_at, imported_at = excluded.imported_at, summary = excluded.summary,
            summary_sha256 = excluded.summary_sha256",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&name)
    .bind(kind)
    .bind(version_labels(&summary, "engine"))
    .bind(version_labels(&summary, "card_data"))
    .bind(version_labels(&summary, "runner"))
    .bind(&difficulty)
    .bind(games)
    .bind(&created_at)
    .bind(&analysed_at)
    .bind(now())
    .bind(&text)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM lab_ratings WHERE run_id = ?").bind(&id).execute(&mut *tx).await?;
    let mut ratings = 0;
    for d in decks {
        let Some(deck_ref) = d.get("id").and_then(Value::as_str) else { continue };
        sqlx::query(
            "INSERT INTO lab_ratings (run_id, deck_ref, strength, lo, hi, win_rate, wr_lo, wr_hi, games, avg_place, extra)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(deck_ref)
        .bind(f(d, "/strength"))
        .bind(f(d, "/strength_ci/0"))
        .bind(f(d, "/strength_ci/1"))
        .bind(f(d, "/main/win_rate"))
        .bind(f(d, "/main/wilson/0"))
        .bind(f(d, "/main/wilson/1"))
        .bind(d.get("games").and_then(Value::as_i64).unwrap_or(0))
        .bind(f(d, "/main/avg_place"))
        .bind(d.to_string())
        .execute(&mut *tx)
        .await?;
        ratings += 1;
    }
    tx.commit().await?;
    Ok(RunImport { id, name, kind: kind.into(), outcome, ratings })
}

// ── read side ───────────────────────────────────────────────────────────────

/// What every simulated number from a run is shown with.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RunLabel {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// True for a global run; false for the caller's own.
    pub global: bool,
    pub engine: Option<String>,
    pub card_data: Option<String>,
    pub runner: Option<String>,
    pub difficulty: Option<String>,
    pub games: i64,
    /// Players per pod in the run's main pod size.
    pub pod: Option<i64>,
    /// Interval level, e.g. 0.9 for 90% intervals.
    pub level: Option<f64>,
    pub model: Option<String>,
    pub created_at: String,
    pub analysed_at: Option<String>,
    pub imported_at: String,
    #[sqlx(json)]
    pub warnings: Vec<String>,
}

const RUN_COLUMNS: &str = "lab_runs.id, lab_runs.name, lab_runs.kind, lab_runs.owner_id IS NULL AS global, lab_runs.engine, \
    lab_runs.card_data, lab_runs.runner, lab_runs.difficulty, lab_runs.games, \
    json_extract(lab_runs.summary, '$.run_meta.pod') AS pod, json_extract(lab_runs.summary, '$.analysis.bootstrap.level') AS level, \
    json_extract(lab_runs.summary, '$.analysis.model') AS model, lab_runs.created_at, lab_runs.analysed_at, lab_runs.imported_at, \
    IFNULL(json_extract(lab_runs.summary, '$.warnings'), '[]') AS warnings";

/// One deck's simulated rating in a run. `None` fields weren't in the summary.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Rating {
    pub deck_ref: String,
    /// 1 = geometric mean of the run's field; `lo`/`hi` its interval.
    pub strength: Option<f64>,
    pub lo: Option<f64>,
    pub hi: Option<f64>,
    /// Raw win rate in the main pod size, with its Wilson interval.
    pub win_rate: Option<f64>,
    pub wr_lo: Option<f64>,
    pub wr_hi: Option<f64>,
    pub games: i64,
    pub avg_place: Option<f64>,
    pub rank: Option<i64>,
    pub rank_lo: Option<i64>,
    pub rank_hi: Option<i64>,
    /// The model's chance of winning a 4-player pod against the field, with its interval.
    pub p4_field: Option<f64>,
    pub p4_lo: Option<f64>,
    pub p4_hi: Option<f64>,
    #[sqlx(json)]
    pub flags: Vec<String>,
}

const RATING_COLUMNS: &str = "r.deck_ref, r.strength, r.lo, r.hi, r.win_rate, r.wr_lo, r.wr_hi, r.games, r.avg_place, \
    json_extract(r.extra, '$.rank') AS rank, json_extract(r.extra, '$.rank_ci[0]') AS rank_lo, json_extract(r.extra, '$.rank_ci[1]') AS rank_hi, \
    json_extract(r.extra, '$.p4_field') AS p4_field, json_extract(r.extra, '$.p4_field_ci[0]') AS p4_lo, \
    json_extract(r.extra, '$.p4_field_ci[1]') AS p4_hi, IFNULL(json_extract(r.extra, '$.flags'), '[]') AS flags";

/// The newest global precon-ratings run: the one the precon pages show.
pub async fn latest_global_ratings_run(pool: &SqlitePool) -> AppResult<Option<RunLabel>> {
    Ok(sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {RUN_COLUMNS} FROM lab_runs WHERE owner_id IS NULL AND kind = 'precon-ratings' ORDER BY created_at DESC, imported_at DESC LIMIT 1"
    )))
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn ratings_for(pool: &SqlitePool, run_id: &str) -> AppResult<HashMap<String, Rating>> {
    let rows: Vec<Rating> = sqlx::query_as(AssertSqlSafe(format!("SELECT {RATING_COLUMNS} FROM lab_ratings r WHERE r.run_id = ?")))
        .bind(run_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.deck_ref.clone(), r)).collect())
}

/// The commander's art, to show behind a deck (Scryfall `art_crop`, loaded by the browser).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Art {
    pub url: String,
    pub artist: Option<String>,
    pub card: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreconItem {
    pub id: String,
    pub lab_id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub released: Option<String>,
    pub commanders: Vec<String>,
    pub color_identity: String,
    pub same_list_as: Option<String>,
    pub card_count: i64,
    pub art: Option<Art>,
    /// Real games, from playgroup.gg (its own source and date); never mixed with `rating`.
    pub playgroup: Option<Value>,
    /// Simulated, from the run in the response's `run` label.
    pub rating: Option<Rating>,
}

#[derive(sqlx::FromRow)]
struct PreconRow {
    id: String,
    lab_id: String,
    name: String,
    set_code: String,
    set_name: Option<String>,
    released: Option<String>,
    #[sqlx(json)]
    commanders: Vec<String>,
    color_identity: String,
    same_list_as: Option<String>,
    card_count: i64,
    playgroup: Option<String>,
    art_url: Option<String>,
    art_artist: Option<String>,
    art_card: Option<String>,
}

const PRECON_COLUMNS: &str = "p.id, p.lab_id, p.name, p.set_code, p.set_name, p.released, p.commanders, p.color_identity, p.same_list_as, \
    IFNULL((SELECT SUM(json_extract(value, '$.qty')) FROM json_each(p.cards)), 0) AS card_count, p.playgroup, \
    c.image_art_crop AS art_url, c.artist AS art_artist, c.name AS art_card";
/// Commander lines come first in `cards`, so the first line's card is the art.
const PRECON_FROM: &str = "precons p LEFT JOIN cards c ON c.oracle_id = json_extract(p.cards, '$[0].oracle_id')";

impl PreconRow {
    fn item(self, ratings: &HashMap<String, Rating>) -> PreconItem {
        let rating = ratings.get(&self.lab_id).cloned();
        PreconItem {
            art: match (self.art_url, self.art_card) {
                (Some(url), Some(card)) => Some(Art { url, artist: self.art_artist, card }),
                _ => None,
            },
            playgroup: self.playgroup.and_then(|p| serde_json::from_str(&p).ok()),
            id: self.id,
            lab_id: self.lab_id,
            name: self.name,
            set_code: self.set_code,
            set_name: self.set_name,
            released: self.released,
            commanders: self.commanders,
            color_identity: self.color_identity,
            same_list_as: self.same_list_as,
            card_count: self.card_count,
            rating,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct PreconList {
    /// The run every `rating` comes from; `None` until a global precon-ratings run is imported.
    pub run: Option<RunLabel>,
    pub precons: Vec<PreconItem>,
}

pub async fn precon_list(pool: &SqlitePool) -> AppResult<PreconList> {
    let run = latest_global_ratings_run(pool).await?;
    let ratings = match &run {
        Some(r) => ratings_for(pool, &r.id).await?,
        None => HashMap::new(),
    };
    let rows: Vec<PreconRow> = sqlx::query_as(AssertSqlSafe(format!("SELECT {PRECON_COLUMNS} FROM {PRECON_FROM} ORDER BY p.name, p.id")))
        .fetch_all(pool)
        .await?;
    let mut precons: Vec<PreconItem> = rows.into_iter().map(|r| r.item(&ratings)).collect();
    // Strongest first; unrated precons after, by name.
    precons.sort_by(|a, b| {
        let key = |p: &PreconItem| p.rating.as_ref().and_then(|r| r.rank).unwrap_or(i64::MAX);
        key(a).cmp(&key(b)).then_with(|| a.name.cmp(&b.name))
    });
    Ok(PreconList { run, precons })
}

async fn list_precons(State(st): State<AppState>, _u: CurrentUser) -> AppResult<Json<PreconList>> {
    Ok(Json(precon_list(&st.pool).await?))
}

/// A card of a precon's list with what the deck list page shows about it.
#[derive(Debug, Serialize)]
pub struct PreconCardView {
    #[serde(flatten)]
    pub card: PreconCard,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub image_small: Option<String>,
    pub image_normal: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Matchup {
    /// The opponent's precon slug.
    pub id: String,
    pub lab_id: String,
    pub name: String,
    /// Chance this precon beats that one in a neutral 1v1, implied by the model.
    pub p: f64,
}

#[derive(Debug, Serialize)]
pub struct Matchups {
    pub note: Option<String>,
    /// Best first.
    pub rows: Vec<Matchup>,
}

#[derive(Debug, Serialize)]
pub struct PreconDetail {
    pub run: Option<RunLabel>,
    pub precon: PreconItem,
    pub notes: Vec<String>,
    pub engine_support: Option<Value>,
    pub source: String,
    pub imported_at: String,
    pub cards: Vec<PreconCardView>,
    pub matchups: Option<Matchups>,
}

#[derive(Deserialize)]
struct MatrixPart {
    matrix: Option<Matrix>,
}

#[derive(Deserialize)]
struct Matrix {
    ids: Vec<String>,
    p: Vec<Vec<Option<f64>>>,
    note: Option<String>,
}

/// The precon's row of the global run's 1v1 matrix, against the precons in the catalog only.
/// Anything else is skipped: precons the catalog no longer has (repeats of an earlier list, left
/// out of commander-decks' index on 2026-10-19, which older runs still rate on their own) and,
/// should a global run ever hold one, a user's own list, which no one else may see.
async fn matchups(pool: &SqlitePool, run_id: &str, lab_id: &str) -> AppResult<Option<Matchups>> {
    let text: String = sqlx::query_scalar("SELECT summary FROM lab_runs WHERE id = ?").bind(run_id).fetch_one(pool).await?;
    let part: MatrixPart = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    let Some(m) = part.matrix else { return Ok(None) };
    let Some(row) = m.ids.iter().position(|i| i == lab_id) else { return Ok(None) };
    let Some(ps) = m.p.get(row) else { return Ok(None) };
    let catalog: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>("SELECT lab_id, id, name FROM precons")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(lab, id, name)| (lab, (id, name)))
        .collect();
    let mut rows: Vec<Matchup> = m
        .ids
        .iter()
        .zip(ps)
        .filter(|(other, _)| *other != lab_id)
        .filter_map(|(other, p)| {
            let (id, name) = catalog.get(other)?;
            Some(Matchup { id: id.clone(), lab_id: other.clone(), name: name.clone(), p: (*p)? })
        })
        .collect();
    rows.sort_by(|a, b| b.p.total_cmp(&a.p).then_with(|| a.name.cmp(&b.name)));
    Ok(Some(Matchups { note: m.note, rows }))
}

pub async fn precon_detail(pool: &SqlitePool, id: &str) -> AppResult<PreconDetail> {
    let row: PreconRow = sqlx::query_as(AssertSqlSafe(format!("SELECT {PRECON_COLUMNS} FROM {PRECON_FROM} WHERE p.id = ?")))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("precon"))?;
    let (cards_json, notes, engine_support, source, imported_at): (String, String, Option<String>, String, String) =
        sqlx::query_as("SELECT cards, notes, engine_support, source, imported_at FROM precons WHERE id = ?").bind(id).fetch_one(pool).await?;
    let run = latest_global_ratings_run(pool).await?;
    let ratings = match &run {
        Some(r) => ratings_for(pool, &r.id).await?,
        None => HashMap::new(),
    };
    let lab_id = row.lab_id.clone();
    let precon = row.item(&ratings);

    let cards: Vec<PreconCard> = serde_json::from_str(&cards_json).map_err(anyhow::Error::from)?;
    type Info = (String, Option<String>, Option<String>, f64, Option<String>, Option<String>);
    let info: HashMap<String, Info> = sqlx::query_as::<_, Info>(
        "SELECT oracle_id, type_line, mana_cost, cmc, image_small, image_normal FROM cards
         WHERE oracle_id IN (SELECT json_extract(value, '$.oracle_id') FROM json_each(?))",
    )
    .bind(&cards_json)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|i| (i.0.clone(), i))
    .collect();
    let cards = cards
        .into_iter()
        .map(|c| {
            let i = c.oracle_id.as_ref().and_then(|o| info.get(o));
            PreconCardView {
                type_line: i.and_then(|i| i.1.clone()),
                mana_cost: i.and_then(|i| i.2.clone()),
                cmc: i.map(|i| i.3),
                image_small: i.and_then(|i| i.4.clone()),
                image_normal: i.and_then(|i| i.5.clone()),
                card: c,
            }
        })
        .collect();
    let matchups = match &run {
        Some(r) => matchups(pool, &r.id, &lab_id).await?,
        None => None,
    };
    Ok(PreconDetail {
        run,
        precon,
        notes: serde_json::from_str(&notes).unwrap_or_default(),
        engine_support: engine_support.and_then(|e| serde_json::from_str(&e).ok()),
        source,
        imported_at,
        cards,
        matchups,
    })
}

async fn get_precon(State(st): State<AppState>, _u: CurrentUser, Path(id): Path<String>) -> AppResult<Json<PreconDetail>> {
    Ok(Json(precon_detail(&st.pool, &id).await?))
}

// ── runs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct RunListItem {
    #[serde(flatten)]
    pub run: RunLabel,
    pub decks: i64,
}

/// Global runs and the caller's own, newest first.
pub async fn runs_for(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<RunListItem>> {
    let runs: Vec<RunLabel> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {RUN_COLUMNS} FROM lab_runs WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at DESC, imported_at DESC"
    )))
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(runs.len());
    for run in runs {
        let decks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_ratings WHERE run_id = ?").bind(&run.id).fetch_one(pool).await?;
        out.push(RunListItem { run, decks });
    }
    Ok(out)
}

async fn list_runs(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<RunListItem>>> {
    Ok(Json(runs_for(&st.pool, &user.id).await?))
}

#[derive(Debug, Serialize)]
pub struct RunRating {
    #[serde(flatten)]
    pub rating: Rating,
    /// The precon's slug, when the deck is a precon in the catalog.
    pub precon_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct RunDetail {
    pub run: RunLabel,
    /// Best first.
    pub ratings: Vec<RunRating>,
    /// The summary without its per-deck entries and matrices: counts, warnings, seat effect,
    /// calibration against real games, paired comparisons, the run's settings.
    pub summary: Value,
}

/// One run, if it is global or the caller's own; anyone else's is "not found".
pub async fn run_for(pool: &SqlitePool, user_id: &str, run_id: &str) -> AppResult<RunDetail> {
    let run: RunLabel = sqlx::query_as(AssertSqlSafe(format!("SELECT {RUN_COLUMNS} FROM lab_runs WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)")))
        .bind(run_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("run"))?;
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT r.deck_ref, p.id, IFNULL(p.name, json_extract(r.extra, '$.name')) FROM lab_ratings r
         LEFT JOIN precons p ON p.lab_id = r.deck_ref WHERE r.run_id = ?",
    )
    .bind(&run.id)
    .fetch_all(pool)
    .await?;
    let mut ratings_by_ref = ratings_for(pool, &run.id).await?;
    let mut ratings: Vec<RunRating> = rows
        .into_iter()
        .filter_map(|(deck_ref, precon_id, name)| {
            let rating = ratings_by_ref.remove(&deck_ref)?;
            Some(RunRating { name: name.unwrap_or_else(|| deck_ref.clone()), precon_id, rating })
        })
        .collect();
    ratings.sort_by(|a, b| {
        let rank = |r: &RunRating| r.rating.rank.unwrap_or(i64::MAX);
        rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name))
    });
    let summary: String = sqlx::query_scalar("SELECT json_remove(summary, '$.decks', '$.matrix', '$.observed_pairs') FROM lab_runs WHERE id = ?")
        .bind(&run.id)
        .fetch_one(pool)
        .await?;
    Ok(RunDetail { run, ratings, summary: serde_json::from_str(&summary).map_err(anyhow::Error::from)? })
}

async fn get_run(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<RunDetail>> {
    Ok(Json(run_for(&st.pool, &user.id, &id).await?))
}

// ── a Yama deck from a precon ───────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct NewPreconDeck {
    /// Defaults to the precon's name.
    name: Option<String>,
    /// Client-generated: a retried request returns the deck the first one made.
    op_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreconDeckCreated {
    pub id: String,
    pub name: String,
    /// Card names Yama's card data doesn't know; left out of the deck.
    pub unknown: Vec<String>,
    pub validation: Value,
}

/// Make a Yama deck for `owner` from the precon's stock list, through the decks module (same
/// version creation and Commander validation as any deck). With `op_id`, idempotent per owner.
///
/// The op record, the deck, its first version and the op's result are written in one
/// transaction, as collection ops are, so a request that dies part way leaves nothing behind
/// and its retry starts over.
pub async fn create_deck_from_precon(pool: &SqlitePool, owner: &str, precon_id: &str, name: Option<&str>, op_id: Option<&str>) -> AppResult<PreconDeckCreated> {
    let (precon_name, cards_json): (String, String) = sqlx::query_as("SELECT name, cards FROM precons WHERE id = ?")
        .bind(precon_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("precon"))?;
    // Reads first: the test pool has one connection, and the transaction below holds it.
    let deck = precon_deck_cards(pool, &precon_name, &cards_json, name).await?;
    let mut tx = pool.begin().await?;
    if let Some(op) = op_id {
        // Writing first takes SQLite's write lock, so a concurrent request with the same op
        // waits here until this one commits or rolls back.
        let claimed = sqlx::query("INSERT INTO applied_ops (owner_id, op_id, kind, payload, applied_at) VALUES (?,?,?,'{}',?) ON CONFLICT DO NOTHING")
            .bind(owner)
            .bind(op)
            .bind(PRECON_DECK_OP)
            .bind(now())
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if claimed == 0 {
            let (kind, payload): (String, String) = sqlx::query_as("SELECT kind, payload FROM applied_ops WHERE owner_id = ? AND op_id = ?")
                .bind(owner)
                .bind(op)
                .fetch_one(&mut *tx)
                .await?;
            if kind != PRECON_DECK_OP {
                return Err(AppError::Conflict("that op id was used for something else".into()));
            }
            if let Ok(done) = serde_json::from_str::<PreconDeckCreated>(&payload) {
                return Ok(done);
            }
            // A claim with no result can't be in progress (claim and result commit together);
            // only an earlier build, which wrote them separately, could leave one. Finish it.
        }
    }
    let id = crate::decks::create_deck_in(&mut tx, owner, &deck.name, Some(PRECON_FOLDER), &deck.cards).await?;
    let created = PreconDeckCreated { id, name: deck.name, unknown: deck.unknown, validation: deck.validation };
    if let Some(op) = op_id {
        sqlx::query("UPDATE applied_ops SET payload = ? WHERE owner_id = ? AND op_id = ?")
            .bind(serde_json::to_string(&created).map_err(anyhow::Error::from)?)
            .bind(owner)
            .bind(op)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(created)
}

/// A precon's stock list as deck cards, with the deck's name and its Commander validation.
struct PreconDeckCards {
    name: String,
    cards: Vec<DeckCard>,
    unknown: Vec<String>,
    validation: Value,
}

async fn precon_deck_cards(pool: &SqlitePool, precon_name: &str, cards_json: &str, name: Option<&str>) -> AppResult<PreconDeckCards> {
    let lines: Vec<PreconCard> = serde_json::from_str(cards_json).map_err(anyhow::Error::from)?;
    let info: HashMap<String, Card> = sqlx::query_as::<_, Card>(AssertSqlSafe(format!(
        "SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id IN (SELECT json_extract(value, '$.oracle_id') FROM json_each(?))"
    )))
    .bind(cards_json)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|c| (c.oracle_id.clone(), c))
    .collect();
    let mut cards: Vec<DeckCard> = Vec::new();
    let mut unknown = Vec::new();
    for l in lines {
        let Some(card) = l.oracle_id.as_ref().and_then(|o| info.get(o)) else {
            unknown.push(l.name);
            continue;
        };
        if let Some(c) = cards.iter_mut().find(|c| c.oracle_id == card.oracle_id && c.board == l.board) {
            c.qty += i64::from(l.qty);
        } else {
            cards.push(DeckCard { oracle_id: card.oracle_id.clone(), name: card.name.clone(), qty: i64::from(l.qty), board: l.board });
        }
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(precon_name).to_string();
    let validation: Validation = crate::decks::validate(&cards, &info);
    Ok(PreconDeckCards { name, cards, unknown, validation: serde_json::to_value(&validation).map_err(anyhow::Error::from)? })
}

async fn create_precon_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, body: Bytes) -> AppResult<Json<PreconDeckCreated>> {
    let req: NewPreconDeck = if body.iter().all(u8::is_ascii_whitespace) {
        NewPreconDeck::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("bad request body: {e}")))?
    };
    Ok(Json(create_deck_from_precon(&st.pool, &user.id, &id, req.name.as_deref(), req.op_id.as_deref()).await?))
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    async fn user(pool: &SqlitePool, id: &str, email: &str) {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?, 'now')")
            .bind(id)
            .bind(email)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn card(pool: &SqlitePool, oid: &str, name: &str, type_line: &str, ci: &str) {
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, image_art_crop, artist, updated_at)
             VALUES (?,?,?,?, '{\"commander\":\"legal\"}', ?, 'An Artist', 'now')",
        )
        .bind(oid)
        .bind(name)
        .bind(type_line)
        .bind(ci)
        .bind(format!("https://cards.scryfall.io/art_crop/{oid}.jpg"))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?,?)").bind(name).bind(oid).execute(pool).await.unwrap();
    }

    /// Two precons, one of Bryan's lists and a left-out repeat (as commander-decks' index has
    /// them since 2026-10-19), and the cards they use; "Mystery Card" isn't in the card data.
    async fn fixture(pool: &SqlitePool) -> tempfile::TempDir {
        user(pool, "bryan", "bryan@example.com").await;
        user(pool, "other", "debug@example.com").await;
        card(pool, "o-ghave", "Ghave, Guru of Spores", "Legendary Creature — Fungus Shaman", "WBG").await;
        card(pool, "o-sol", "Sol Ring", "Artifact", "").await;
        card(pool, "o-forest", "Forest", "Basic Land — Forest", "G").await;
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('p1','o-sol','Sol Ring','cmd','Commander 2011','1','en','now')")
            .execute(pool)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let decks = dir.path().join("decks");
        std::fs::create_dir_all(decks.join("precons")).unwrap();
        std::fs::create_dir_all(decks.join("bryan")).unwrap();
        let list = "Commander\n1 Ghave, Guru of Spores\n\nDeck\n1 Sol Ring\n1 Mystery Card\n97 Forest\n";
        std::fs::write(decks.join("precons/counterpunch.txt"), list).unwrap();
        std::fs::write(decks.join("precons/spore-tide.txt"), "Commander\n1 Ghave, Guru of Spores\nDeck\n1 Sol Ring\n98 Forest\n").unwrap();
        std::fs::write(decks.join("bryan/mine.txt"), list).unwrap();
        let index = json!({
            "generated": "2026-10-18",
            "decks": [
                {"id": "precons/counterpunch", "name": "Counterpunch", "set": "CMD", "released": "2011-06-17",
                 "commanders": ["Ghave, Guru of Spores"], "color_identity": "WBG", "kind": "precon",
                 "playgroup_id": 7, "playgroup_name": "Counterpunch", "playgroup_tier": "B", "playgroup_win_rate_4p": 24.5,
                 "playgroup_games": 40, "playgroup_url": "https://playgroup.gg/x",
                 "mtgjson": "https://mtgjson.com/api/v5/decks/Counterpunch_CMD.json", "notes": [], "phase_support": {"partly_unimplemented": []}},
                {"id": "precons/spore-tide", "name": "Spore Tide", "set": "ZZZ", "released": "2030-01-01",
                 "commanders": ["Ghave, Guru of Spores"], "color_identity": "WBG", "kind": "precon",
                 "playgroup_id": null, "playgroup_name": null, "notes": ["EXCEPTION renamed"]},
                {"id": "bryan/mine", "name": "Mine", "set": "CMD", "released": null, "commanders": ["Ghave, Guru of Spores"],
                 "color_identity": "WBG", "kind": "bryan", "playgroup_id": null, "playgroup_name": null,
                 "same_list_as": "precons/counterpunch"}
            ],
            "left_out": [{"id": "precons/counterpunch-ce", "name": "Counterpunch", "set": "ZZZ", "same_as": "precons/counterpunch"}]
        });
        std::fs::write(decks.join("index.json"), index.to_string()).unwrap();
        std::fs::write(
            dir.path().join("playgroup-precon-tiers-2026-10-17.json"),
            r#"{"source": "https://playgroup.gg/commander/precons", "fetched": "2026-10-17", "method": "stock lists", "precons": []}"#,
        )
        .unwrap();
        dir
    }

    /// A run's summary. Precons only, as a global run must be; with `mine`, one of Bryan's lists
    /// is rated too and compared with the precon, as his own runs do.
    fn summary(run: &str, created: &str, strength: f64, mine: bool) -> String {
        let mut decks = vec![json!(
            {"id": "precons/counterpunch", "name": "Counterpunch", "games": 3, "strength": strength, "strength_ci": [0.5, 2.0],
             "main": {"win_rate": 0.33, "wilson": [0.06, 0.79], "avg_place": 2.1}, "rank": 1, "rank_ci": [1, 2],
             "p4_field": 0.3, "p4_field_ci": [0.2, 0.4], "flags": ["few games: 3 usable"]}
        )];
        // An older run still rates the left-out repeat on its own.
        let mut matrix = json!({"ids": ["precons/counterpunch", "precons/counterpunch-ce", "precons/spore-tide"],
                                "p": [[0.5, 0.5, 0.7], [0.5, 0.5, 0.7], [0.3, 0.3, 0.5]],
                                "note": "P(row beats column)"});
        let mut paired = Value::Null;
        if mine {
            decks.push(json!(
                {"id": "bryan/mine", "name": "Mine (Bryan)", "games": 3, "strength": 0.8, "strength_ci": [0.4, 1.5],
                 "main": {"win_rate": 0.0, "wilson": [0.0, 0.56], "avg_place": 3.0}, "rank": 2, "rank_ci": [1, 2]}
            ));
            matrix = json!({"ids": ["precons/counterpunch", "bryan/mine", "precons/counterpunch-ce", "precons/spore-tide"],
                            "p": [[0.5, 0.6, 0.5, 0.7], [0.4, 0.5, 0.4, 0.5], [0.5, 0.6, 0.5, 0.7], [0.3, 0.5, 0.3, 0.5]],
                            "note": "P(row beats column)"});
            paired = json!({"variants": [{"id": "precons/counterpunch"}, {"id": "bryan/mine"}],
                            "comparisons": [{"base": "precons/counterpunch", "variant": "bryan/mine", "delta_win_rate": -0.33}]});
        }
        // A NaN as Python's json writes it, to check it reads as null.
        json!({
            "run": run, "generated": "2026-10-19T05:04:42Z",
            "run_meta": {"created": created, "difficulty": "Easy", "pod": 4},
            "versions": {"engine": {"phase-rs v0.113.0": 3}, "card_data": {"eb309108eb0df708": 3}, "runner": {"e56dbe8": 3}},
            "analysis": {"model": "Plackett-Luce", "bootstrap": {"level": 0.9}},
            "counts": {"games_in_model": 3},
            "warnings": ["few games"],
            "decks": decks,
            "matrix": matrix,
            "calibration": {"spearman": "NAN_HERE"},
            "paired": paired
        })
        .to_string()
        .replace("\"NAN_HERE\"", "NaN")
    }

    #[tokio::test]
    async fn precon_import_is_idempotent() {
        let pool = crate::db::test_pool().await;
        let dir = fixture(&pool).await;
        let index = dir.path().join("decks/index.json");
        let first = import_precons(&pool, &index, None).await.unwrap();
        assert_eq!((first.added, first.updated, first.unchanged, first.skipped, first.left_out), (2, 0, 0, 1, 1));
        assert_eq!(first.unresolved, vec!["Counterpunch: Mystery Card".to_string()]);
        let rows = || async {
            sqlx::query_as::<_, (String, String, Option<String>, String, Option<String>, Option<String>, String)>(
                "SELECT id, lab_id, set_name, cards, same_list_as, playgroup, imported_at FROM precons ORDER BY id",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
        };
        let before = rows().await;
        assert_eq!(before.len(), 2);
        assert_eq!(before[0].0, "counterpunch");
        assert_eq!(before[0].1, "precons/counterpunch");
        assert_eq!(before[0].2.as_deref(), Some("Commander 2011"));
        assert_eq!((before[1].0.as_str(), before[1].2.as_deref()), ("spore-tide", None)); // set unknown to Yama
        assert_eq!(before[0].4, None);
        let cards: Vec<PreconCard> = serde_json::from_str(&before[0].3).unwrap();
        assert_eq!(cards[0], PreconCard { name: "Ghave, Guru of Spores".into(), oracle_id: Some("o-ghave".into()), qty: 1, board: Board::Commander });
        assert_eq!(cards.iter().map(|c| c.qty).sum::<u32>(), 100);
        assert!(cards.iter().any(|c| c.name == "Mystery Card" && c.oracle_id.is_none()));
        let pg: Value = serde_json::from_str(before[0].5.as_deref().unwrap()).unwrap();
        assert_eq!((pg["rank"].as_i64(), pg["fetched"].as_str()), (Some(1), Some("2026-10-17")));

        // The same index again changes nothing, not even the import time.
        let again = import_precons(&pool, &index, None).await.unwrap();
        assert_eq!((again.added, again.updated, again.unchanged), (0, 0, 2));
        assert_eq!(rows().await, before);

        // A changed list updates that precon only.
        std::fs::write(dir.path().join("decks/precons/counterpunch.txt"), "Commander\n1 Ghave, Guru of Spores\nDeck\n99 Forest\n").unwrap();
        let changed = import_precons(&pool, &index, None).await.unwrap();
        assert_eq!((changed.added, changed.updated, changed.unchanged), (0, 1, 1));
        assert!(changed.unresolved.is_empty());
    }

    #[tokio::test]
    async fn run_import_is_idempotent_and_owned_runs_stay_private() {
        let pool = crate::db::test_pool().await;
        let dir = fixture(&pool).await;
        import_precons(&pool, &dir.path().join("decks/index.json"), None).await.unwrap();
        let global = dir.path().join("pilot.json");
        std::fs::write(&global, summary("pilot-2", "2026-10-19T04:15:40Z", 2.5, false)).unwrap();

        let a = import_run(&pool, &global, None, None).await.unwrap();
        assert_eq!((a.outcome, a.kind.as_str(), a.name.as_str(), a.ratings), ("added", "precon-ratings", "pilot-2", 1));
        let b = import_run(&pool, &global, None, None).await.unwrap();
        assert_eq!((b.outcome, b.id.as_str()), ("unchanged", a.id.as_str()));
        // A newer analysis of the same run replaces it in place.
        std::fs::write(&global, summary("pilot-2", "2026-10-19T04:15:40Z", 3.0, false)).unwrap();
        let c = import_run(&pool, &global, None, None).await.unwrap();
        assert_eq!((c.outcome, c.id.as_str()), ("updated", a.id.as_str()));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_runs").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);

        // A run that rates Bryan's list can't be global: everyone would see his list. Refused
        // before anything is written, saying how to import it.
        let own = dir.path().join("own.json");
        std::fs::write(&own, summary("bryan-test", "2026-10-20T00:00:00Z", 9.0, true)).unwrap();
        let refused = import_run(&pool, &own, None, None).await.unwrap_err().to_string();
        assert!(refused.contains("bryan/mine") && refused.contains("--owner"), "{refused}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_runs").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);

        // As Bryan's own run (newer, and named like the global one): a separate run only he sees.
        let mine = import_run(&pool, &own, Some("bryan@example.com"), Some("pilot-2")).await.unwrap();
        assert_ne!(mine.id, a.id);
        assert_eq!((mine.kind.as_str(), mine.ratings), ("paired", 2));
        assert!(import_run(&pool, &own, Some("nobody@example.com"), None).await.is_err());

        let ids = |runs: Vec<RunListItem>| runs.into_iter().map(|r| r.run.id).collect::<Vec<_>>();
        assert_eq!(ids(runs_for(&pool, "bryan").await.unwrap()), vec![mine.id.clone(), a.id.clone()]);
        assert_eq!(ids(runs_for(&pool, "other").await.unwrap()), vec![a.id.clone()]);
        let own_detail = run_for(&pool, "bryan", &mine.id).await.unwrap();
        assert!(!own_detail.run.global);
        assert_eq!(own_detail.ratings.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["Counterpunch", "Mine (Bryan)"]);
        assert_eq!(own_detail.summary["paired"]["comparisons"][0]["variant"], "bryan/mine");
        assert!(matches!(run_for(&pool, "other", &mine.id).await, Err(AppError::NotFound(_))));
        let detail = run_for(&pool, "other", &a.id).await.unwrap();
        assert!(detail.run.global);
        assert_eq!(detail.run.warnings, vec!["few games".to_string()]);
        assert_eq!((detail.run.pod, detail.run.level), (Some(4), Some(0.9)));
        assert_eq!(detail.ratings.iter().map(|r| r.precon_id.as_deref()).collect::<Vec<_>>(), vec![Some("counterpunch")]);
        assert!(detail.summary["paired"].is_null());
        assert!(detail.summary.get("matrix").is_none() && detail.summary.get("decks").is_none());
        assert!(detail.summary["calibration"]["spearman"].is_null());

        // Precon pages use the newest global run, never someone's own.
        let list = precon_list(&pool).await.unwrap();
        assert_eq!(list.run.as_ref().map(|r| r.id.as_str()), Some(a.id.as_str()));
        let cp = list.precons.iter().find(|p| p.id == "counterpunch").unwrap();
        let r = cp.rating.as_ref().unwrap();
        assert_eq!((r.strength, r.rank, r.lo, r.wr_hi), (Some(3.0), Some(1), Some(0.5), Some(0.79)));
        assert_eq!(cp.art.as_ref().map(|a| a.card.as_str()), Some("Ghave, Guru of Spores"));
        assert_eq!(cp.card_count, 100);
        // A precon the run didn't rate is listed without a rating, after the rated ones.
        assert_eq!(list.precons.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["counterpunch", "spore-tide"]);
        assert!(list.precons[1].rating.is_none());

        // Matchups: catalog precons only, best first; the left-out repeat the catalog lacks drops out.
        let d = precon_detail(&pool, "counterpunch").await.unwrap();
        let m = d.matchups.unwrap();
        let rows: Vec<(&str, &str, f64)> = m.rows.iter().map(|r| (r.id.as_str(), r.name.as_str(), r.p)).collect();
        assert_eq!(rows, vec![("spore-tide", "Spore Tide", 0.7)]);
        // Even a global run that holds someone's list (imported before that was refused) doesn't
        // show it as a matchup.
        sqlx::query("UPDATE lab_runs SET summary = ? WHERE id = ?")
            .bind(summary("pilot-2", "2026-10-19T04:15:40Z", 3.0, true).replace("NaN", "null"))
            .bind(&a.id)
            .execute(&pool)
            .await
            .unwrap();
        let m = precon_detail(&pool, "counterpunch").await.unwrap().matchups.unwrap();
        assert_eq!(m.rows.iter().map(|r| r.lab_id.as_str()).collect::<Vec<_>>(), vec!["precons/spore-tide"]);
        assert_eq!(d.cards.len(), 4);
        assert_eq!(d.cards[0].type_line.as_deref(), Some("Legendary Creature — Fungus Shaman"));
        assert!(d.cards.iter().any(|c| c.card.name == "Mystery Card" && c.type_line.is_none()));
        assert!(precon_detail(&pool, "spore-tide").await.unwrap().matchups.is_some());
        assert!(matches!(precon_detail(&pool, "nope").await, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn a_precon_becomes_a_deck_once_per_op() {
        let pool = crate::db::test_pool().await;
        let dir = fixture(&pool).await;
        import_precons(&pool, &dir.path().join("decks/index.json"), None).await.unwrap();

        let made = create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-1")).await.unwrap();
        assert_eq!(made.name, "Counterpunch");
        assert_eq!(made.unknown, vec!["Mystery Card".to_string()]);
        // 99 known cards: the validation says so rather than the deck pretending to be complete.
        assert_eq!(made.validation["total"], 99);
        assert_eq!(made.validation["color_identity"], "WBG");
        let (owner, folder, version): (String, String, String) =
            sqlx::query_as("SELECT owner_id, folder, current_version_id FROM decks WHERE id = ?").bind(&made.id).fetch_one(&pool).await.unwrap();
        assert_eq!((owner.as_str(), folder.as_str()), ("bryan", PRECON_FOLDER));
        let cards = crate::decks::load_version_cards(&pool, &version).await.unwrap();
        assert!(cards.iter().any(|c| c.oracle_id == "o-ghave" && c.board == Board::Commander));
        assert_eq!(cards.iter().map(|c| c.qty).sum::<i64>(), 99);

        // A retry with the same op makes no second deck; another user's same op id is theirs.
        let again = create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-1")).await.unwrap();
        assert_eq!(again.id, made.id);
        let theirs = create_deck_from_precon(&pool, "other", "counterpunch", Some("My Ghave"), Some("op-1")).await.unwrap();
        assert_ne!(theirs.id, made.id);
        assert_eq!(theirs.name, "My Ghave");
        let counts: Vec<(String, i64)> = sqlx::query_as("SELECT owner_id, COUNT(*) FROM decks GROUP BY owner_id ORDER BY owner_id").fetch_all(&pool).await.unwrap();
        assert_eq!(counts, vec![("bryan".into(), 1), ("other".into(), 1)]);

        // Without an op id each request is a new deck; an unknown precon is not found.
        create_deck_from_precon(&pool, "bryan", "counterpunch", None, None).await.unwrap();
        assert!(matches!(create_deck_from_precon(&pool, "bryan", "nope", None, Some("op-2")).await, Err(AppError::NotFound(_))));
        // An op id already used for something else is a conflict.
        sqlx::query("INSERT INTO applied_ops (owner_id, op_id, kind, payload, applied_at) VALUES ('bryan','op-3','add','{}','now')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-3")).await, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn a_precon_deck_op_that_fails_part_way_leaves_nothing_and_its_retry_works() {
        let pool = crate::db::test_pool().await;
        let dir = fixture(&pool).await;
        import_precons(&pool, &dir.path().join("decks/index.json"), None).await.unwrap();
        let count = |sql: &'static str| {
            let pool = pool.clone();
            async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&pool).await.unwrap() }
        };

        // The deck row is written, then its first version fails: the claim and the deck roll back.
        sqlx::query("CREATE TRIGGER fail_versions BEFORE INSERT ON deck_versions BEGIN SELECT RAISE(ABORT, 'disk full'); END")
            .execute(&pool)
            .await
            .unwrap();
        assert!(create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-1")).await.is_err());
        assert_eq!(count("SELECT COUNT(*) FROM applied_ops").await, 0);
        assert_eq!(count("SELECT COUNT(*) FROM decks").await, 0);
        sqlx::query("DROP TRIGGER fail_versions").execute(&pool).await.unwrap();
        let made = create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-1")).await.unwrap();
        assert_eq!(create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-1")).await.unwrap().id, made.id);
        assert_eq!(count("SELECT COUNT(*) FROM decks").await, 1);

        // A claim with no result (only the earlier build, which claimed and finished in separate
        // writes, could leave one) is finished by the next retry, which then stays the answer.
        sqlx::query("INSERT INTO applied_ops (owner_id, op_id, kind, payload, applied_at) VALUES ('bryan','op-old','precon_deck','{}','now')")
            .execute(&pool)
            .await
            .unwrap();
        let finished = create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-old")).await.unwrap();
        assert_eq!(create_deck_from_precon(&pool, "bryan", "counterpunch", None, Some("op-old")).await.unwrap().id, finished.id);
        assert_eq!(count("SELECT COUNT(*) FROM decks").await, 2);
    }

    #[test]
    fn a_users_list_is_found_wherever_a_summary_names_decks() {
        let only_precons = json!({"decks": [{"id": "precons/a"}], "matrix": {"ids": ["precons/a", "precons/b"]}, "paired": null,
                                  "run_meta": {"filter": {"ids": []}}});
        assert!(non_precon_ids(&only_precons).is_empty());
        for (summary, id) in [
            (json!({"decks": [{"id": "precons/a"}, {"id": "bryan/x"}]}), "bryan/x"),
            (json!({"matrix": {"ids": ["precons/a", "bryan/x"]}}), "bryan/x"),
            (json!({"paired": {"variants": [{"id": "bryan/x"}], "comparisons": []}}), "bryan/x"),
            (json!({"paired": {"comparisons": [{"base": "precons/a", "variant": "bryan/y"}]}}), "bryan/y"),
            (json!({"paired": {"comparisons": [{"base": "bryan/z", "variant": "precons/a"}]}}), "bryan/z"),
            (json!({"run_meta": {"paired": {"variants": ["bryan/x"]}}}), "bryan/x"),
            (json!({"run_meta": {"filter": {"ids": ["bryan/x"]}}}), "bryan/x"),
        ] {
            assert_eq!(non_precon_ids(&summary).into_iter().collect::<Vec<_>>(), vec![id.to_string()], "{summary}");
        }
    }

    #[test]
    fn non_finite_numbers_read_as_null_outside_strings() {
        let text = r#"{"a": NaN, "b": [-Infinity, Infinity], "c": "NaN and Infinity stay", "d": "\"NaN\""}"#;
        let v: Value = serde_json::from_str(&without_non_finite(text)).unwrap();
        assert!(v["a"].is_null() && v["b"][0].is_null() && v["b"][1].is_null());
        assert_eq!(v["c"], "NaN and Infinity stay");
        assert_eq!(v["d"], "\"NaN\"");
    }
}
