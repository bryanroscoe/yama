//! Importing a `yama-plan/1` document for one owner (docs/planner-design.md section 6.5).
//!
//! Parsing, checks, name resolution and hashing happen before the transaction, so the write lock
//! is held briefly. The transaction starts with `BEGIN IMMEDIATE`, so its reads and writes see one
//! state of the database. Every statement binds the owner.

use super::model::{self, Checked, Meta, Plan, Slot};
use crate::cards::{CARD_COLUMNS, Card};
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::util::{new_id, now, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;

/// Uploads (and CLI files) kept gzipped, newest first.
const KEEP_DOCUMENTS: i64 = 10;

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub dry_run: bool,
    pub force: bool,
    /// 'web' | 'token' | 'cli'
    pub via: &'static str,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    /// The import record; null for a dry run (nothing was kept) or when unchanged.
    pub import_id: Option<String>,
    pub unchanged: bool,
    pub dry_run: bool,
    pub forced: bool,
    /// SHA-256 of the exact bytes of `plan`. Pages show its first 12 digits.
    pub content_hash: String,
    pub app: Option<String>,
    pub guide_version: Option<i64>,
    pub guide_date: Option<String>,
    pub git_sha: Option<String>,
    pub dirty: Option<bool>,
    /// What Yama had before this upload, so a page can show the file next to the current plan.
    pub head_before: Option<HeadInfo>,
    pub counts: Counts,
    pub unknown_cards: Vec<UnknownCard>,
    pub unknown_printings: Vec<UnknownPrinting>,
    pub orphan_answers: Vec<Orphan>,
    pub reviews: ReviewCounts,
    pub existing_decks: Vec<ExistingDeck>,
    pub warnings: Vec<String>,
    /// The document's own `warnings`, as the writer gave them.
    pub export_warnings: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HeadInfo {
    pub content_hash: Option<String>,
    pub guide_version: Option<i64>,
    pub git_sha: Option<String>,
    pub imported_at: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Counts {
    pub decks: RowCounts,
    pub swaps: RowCounts,
    pub orders: RowCounts,
    pub stores: RowCounts,
    pub settings: i64,
    pub quotes: i64,
    pub aliases: i64,
    /// Lists with cards Yama hadn't stored before.
    pub states_new: i64,
    /// Stored lists with the same cards whose printings, sources or log changed.
    pub states_refreshed: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RowCounts {
    pub added: i64,
    pub changed: i64,
    pub unchanged: i64,
    pub retired: i64,
    pub restored: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownCard {
    pub name: String,
    #[serde(rename = "where")]
    pub places: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnknownPrinting {
    pub card: String,
    pub set: Option<String>,
    pub num: Option<String>,
    pub scryfall_id: Option<String>,
    #[serde(rename = "where")]
    pub places: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Orphan {
    pub swap_key: String,
    pub deck: Option<String>,
    pub card: Option<String>,
    pub decision: Option<String>,
    pub marks: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReviewCounts {
    pub from_document_applied: i64,
    pub yama_newer_kept: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ExistingDeck {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
}

/// Import one document as `owner`. With `dry_run`, everything runs and is rolled back.
pub async fn import_doc(pool: &SqlitePool, owner: &str, body: &[u8], opts: Options) -> AppResult<Report> {
    // 1. The envelope.
    let env = model::parse_envelope(body)?;
    match &env.format {
        Some(Value::String(f)) if f == model::FORMAT => {}
        Some(other) => return Err(AppError::bad(format!("format: expected \"{}\", got {other}", model::FORMAT))),
        None => return Err(AppError::bad(format!("format: missing; expected \"{}\"", model::FORMAT))),
    }
    let raw = env.plan.ok_or_else(|| AppError::bad("plan: missing"))?;
    let meta_value = env.meta.unwrap_or_else(|| json!({}));
    if !meta_value.is_object() {
        return Err(AppError::bad("meta: expected an object"));
    }
    let meta: Meta = model::parse_value(meta_value.clone(), "meta")?;

    // 2. Same content as the head: nothing to do.
    let content_hash = sha256_hex(raw.get());
    let head = head_info(pool, owner).await?;
    if !opts.force && head.content_hash.as_deref() == Some(content_hash.as_str()) {
        return unchanged_report(pool, owner, head, opts).await;
    }

    // 3. Typed parse and checks (400 naming the JSON path).
    let plan: Plan = model::parse_str(raw.get(), "plan")?;
    let checked = model::check(&plan)?;
    let origin = if meta.app.as_deref() == Some("yama") { "yama" } else { "import" };

    // 4. Cards: resolved for the report and the deck checks only. Rows keep names, never ids.
    let mentioned = model::card_names(&plan);
    let names: Vec<String> = mentioned.keys().cloned().collect();
    let resolved = super::resolve_names(pool, &names).await?;
    let info = card_info(pool, &resolved).await?;
    let mut report = Report {
        content_hash: content_hash.clone(),
        dry_run: opts.dry_run,
        forced: opts.force,
        app: meta.app.clone(),
        guide_version: meta.guide_version,
        guide_date: meta.guide_date.clone(),
        git_sha: meta.git_sha.clone(),
        dirty: meta.dirty,
        head_before: head.content_hash.is_some().then(|| head.clone()),
        export_warnings: plan.warnings.clone(),
        ..Default::default()
    };
    report.unknown_cards = mentioned
        .iter()
        .filter(|(n, _)| !resolved.contains_key(*n))
        .map(|(n, places)| UnknownCard { name: n.clone(), places: places.clone() })
        .collect();
    report.unknown_printings = unknown_printings(pool, &plan).await?;
    report.warnings = checked.warnings.clone();
    report.warnings.extend(state_warnings(&plan, &resolved, &info));
    if let (Some(new), Some(old)) = (meta.guide_version, head.guide_version)
        && new < old
    {
        report.warnings.push(format!("This file is guide v{new}; the plan already in Yama is guide v{old}. Importing it goes back to the older plan."));
    }

    // 5. One transaction.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let conn: &mut SqliteConnection = &mut tx;
    // Another upload may have landed while this one was being read.
    let head_now = head_info(&mut *conn, owner).await?;
    if !opts.force && head_now.content_hash.as_deref() == Some(content_hash.as_str()) {
        drop(tx);
        return unchanged_report(pool, owner, head_now, opts).await;
    }
    let stamp = now();
    let import_id = new_id();
    sqlx::query("INSERT INTO plan_meta (owner_id, updated_at) VALUES (?, ?) ON CONFLICT(owner_id) DO NOTHING")
        .bind(owner)
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO plan_imports (id, owner_id, content_hash, format, meta, via, forced, report, document_gz, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)",
    )
    .bind(&import_id)
    .bind(owner)
    .bind(&content_hash)
    .bind(model::FORMAT)
    .bind(meta_value.to_string())
    .bind(opts.via)
    .bind(opts.force)
    .bind(gzip(body)?)
    .bind(&stamp)
    .execute(&mut *conn)
    .await?;

    let w = Writer { owner, import_id: &import_id, stamp: &stamp, origin };
    w.settings(conn, &plan, &mut report).await?;
    let store_ids = w.stores(conn, &plan, &mut report.counts.stores).await?;
    let deck_ids = w.decks(conn, &plan, &mut report.counts.decks).await?;
    let (order_ids, item_ids) = w.orders(conn, &plan, &store_ids, &mut report.counts.orders).await?;
    let swap_ids = w.swaps(conn, &plan, &deck_ids, &order_ids, &item_ids, &mut report.counts.swaps).await?;
    report.counts.quotes = w.quotes(conn, &plan, &swap_ids, &store_ids).await?;
    let default_by = default_computed_by(&meta);
    w.states(conn, &plan, &deck_ids, &default_by, &mut report.counts).await?;
    report.counts.aliases = w.aliases(conn, &plan, &checked).await?;
    report.reviews = w.reviews(conn, &checked).await?;
    w.inbox_outcomes(conn, &checked).await?;
    // A Yama backup may hold an older copy of a plan made from a note: the note decides, so every
    // tracked note plan is derived again from its current note (swaps, quotes and lists).
    if origin == "yama" {
        super::notes::rederive_all(conn, owner).await?;
    }

    report.orphan_answers = orphans(conn, owner).await?;
    report.existing_decks = sqlx::query_as(
        "SELECT id, name, folder FROM decks WHERE owner_id = ? AND folder = 'commander-decks' AND archived = 0 ORDER BY name",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;

    // 6. The head moves; only the newest uploads keep their document.
    sqlx::query(
        "UPDATE plan_meta SET revision = revision + 1, head_import_id = ?, head_hash = ?, head_git_sha = ?,
                game_changers = ?, library = ?, notes = ?, updated_at = ? WHERE owner_id = ?",
    )
    .bind(&import_id)
    .bind(&content_hash)
    .bind(&meta.git_sha)
    .bind(plan.game_changers.as_ref().map(Value::to_string))
    .bind(plan.library.as_ref().map(Value::to_string))
    .bind(serde_json::to_string(&plan.notes).map_err(anyhow::Error::from)?)
    .bind(&stamp)
    .bind(owner)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE plan_imports SET document_gz = NULL WHERE owner_id = ?1 AND document_gz IS NOT NULL AND id NOT IN
           (SELECT id FROM plan_imports WHERE owner_id = ?1 ORDER BY imported_at DESC, rowid DESC LIMIT ?2)",
    )
    .bind(owner)
    .bind(KEEP_DOCUMENTS)
    .execute(&mut *conn)
    .await?;

    if opts.dry_run {
        tx.rollback().await?;
    } else {
        report.import_id = Some(import_id.clone());
        sqlx::query("UPDATE plan_imports SET report = ? WHERE id = ? AND owner_id = ?")
            .bind(serde_json::to_string(&report).map_err(anyhow::Error::from)?)
            .bind(&import_id)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(report)
}

/// CLI: `yama-server import-plan FILE --owner EMAIL [--dry-run] [--force]`. A local admin tool
/// run on the server itself, so the owner comes from the argument; the web route takes it from
/// the session. Both use `import_doc`.
pub async fn import_file(pool: &SqlitePool, path: &std::path::Path, owner_email: &str, dry_run: bool, force: bool) -> anyhow::Result<Report> {
    let owner: String = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(owner_email)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no user {owner_email}; sign in once first"))?;
    let body = std::fs::read(path).map_err(|e| anyhow::anyhow!("can't read {}: {e}", path.display()))?;
    import_doc(pool, &owner, &body, Options { dry_run, force, via: "cli" }).await.map_err(|e| anyhow::anyhow!("{e}"))
}

pub async fn head_info<'c, E>(db: E, owner: &str) -> AppResult<HeadInfo>
where
    E: sqlx::Executor<'c, Database = sqlx::Sqlite>,
{
    #[derive(sqlx::FromRow)]
    struct Row {
        revision: i64,
        head_hash: Option<String>,
        meta: Option<String>,
        imported_at: Option<String>,
    }
    let row: Option<Row> = sqlx::query_as(
        "SELECT m.revision, m.head_hash, i.meta, i.imported_at FROM plan_meta m
         LEFT JOIN plan_imports i ON i.id = m.head_import_id AND i.owner_id = m.owner_id
         WHERE m.owner_id = ?",
    )
    .bind(owner)
    .fetch_optional(db)
    .await?;
    let Some(Row { revision, head_hash: content_hash, meta, imported_at }) = row else {
        return Ok(HeadInfo::default());
    };
    let meta: Meta = meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or_default();
    Ok(HeadInfo { content_hash, guide_version: meta.guide_version, git_sha: meta.git_sha, imported_at, revision })
}

/// The head's own report, marked unchanged. Nothing is written.
async fn unchanged_report(pool: &SqlitePool, owner: &str, head: HeadInfo, opts: Options) -> AppResult<Report> {
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT i.report FROM plan_meta m JOIN plan_imports i ON i.id = m.head_import_id AND i.owner_id = m.owner_id WHERE m.owner_id = ?",
    )
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    let mut report: Report = stored.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
    report.content_hash = head.content_hash.clone().unwrap_or_default();
    report.unchanged = true;
    report.dry_run = opts.dry_run;
    report.forced = false;
    report.head_before = Some(head);
    Ok(report)
}

fn gzip(body: &[u8]) -> AppResult<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(body).map_err(anyhow::Error::from)?;
    Ok(enc.finish().map_err(anyhow::Error::from)?)
}

fn default_computed_by(meta: &Meta) -> String {
    let app = meta.app.clone().unwrap_or_else(|| "unknown writer".into());
    match meta.guide_version {
        Some(v) => format!("{app}, guide v{v}"),
        None => app,
    }
}

async fn card_info(pool: &SqlitePool, resolved: &HashMap<String, String>) -> AppResult<HashMap<String, Card>> {
    let ids: Vec<&String> = resolved.values().collect();
    let cards: Vec<Card> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))"
    )))
    .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    Ok(cards.into_iter().map(|c| (c.oracle_id.clone(), c)).collect())
}

/// Printings named by slots, order items and quotes that Yama's card data doesn't have.
async fn unknown_printings(pool: &SqlitePool, plan: &Plan) -> AppResult<Vec<UnknownPrinting>> {
    /// (card, set, num, scryfall_id)
    type PrintingRef = (String, Option<String>, Option<String>, Option<String>);
    let mut refs: BTreeMap<PrintingRef, Vec<String>> = BTreeMap::new();
    let mut add = |card: &str, set: &Option<String>, num: &Option<String>, id: &Option<String>, place: String| {
        let id = id.clone().filter(|s| !s.trim().is_empty());
        let (set, num) = (set.clone().filter(|s| !s.trim().is_empty()), num.clone().filter(|s| !s.trim().is_empty()));
        if id.is_none() && (set.is_none() || num.is_none()) {
            return;
        }
        let places = refs.entry((card.trim().to_string(), set, num, id)).or_default();
        if places.len() < 5 && !places.contains(&place) {
            places.push(place);
        }
    };
    for d in &plan.decks {
        for (state, st) in &d.states {
            for c in &st.cards {
                add(&c.name, &c.set, &c.num, &c.scryfall_id, format!("{}: {state} list", d.name));
            }
        }
    }
    for o in &plan.orders {
        for it in &o.items {
            add(&it.card, &it.set, &it.num, &it.scryfall_id, format!("order {} line {}", o.key, it.line));
        }
    }
    for q in &plan.quotes {
        add(&q.card, &q.set, &q.num, &q.scryfall_id, format!("quote for {}", q.swap.as_deref().unwrap_or(&q.card)));
    }
    let ids: Vec<&String> = refs.keys().filter_map(|(_, _, _, id)| id.as_ref()).collect();
    let known_ids: HashSet<String> = sqlx::query_scalar("SELECT scryfall_id FROM printings WHERE scryfall_id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let pairs: Vec<(String, String)> = refs
        .keys()
        .filter(|(_, _, _, id)| id.is_none())
        .filter_map(|(_, s, n, _)| Some((s.clone()?.trim().to_lowercase(), n.clone()?.trim().to_string())))
        .collect();
    let known_pairs: HashSet<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT p.set_code, p.collector_number FROM json_each(?) j
         JOIN printings p ON p.set_code = json_extract(j.value, '$[0]') AND p.collector_number = json_extract(j.value, '$[1]')",
    )
    .bind(serde_json::to_string(&pairs).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    Ok(refs
        .into_iter()
        .filter(|((_, set, num, id), _)| match id {
            Some(id) => !known_ids.contains(id),
            None => {
                let pair = (set.clone().unwrap_or_default().trim().to_lowercase(), num.clone().unwrap_or_default().trim().to_string());
                !known_pairs.contains(&pair)
            }
        })
        .map(|((card, set, num, scryfall_id), places)| UnknownPrinting { card, set, num, scryfall_id, places })
        .collect())
}

fn is_basic(name: &str) -> bool {
    crate::decks::BASICS.contains(&name)
}

/// 100 cards and singleton by name, then Yama's deck check (color identity, legality, commander)
/// on the resolved cards. Warnings only: the writer's own build already asserts its rules.
fn state_warnings(plan: &Plan, resolved: &HashMap<String, String>, info: &HashMap<String, Card>) -> Vec<String> {
    let mut out = Vec::new();
    for d in &plan.decks {
        let mut by_message: BTreeMap<String, Vec<&str>> = BTreeMap::new();
        for (state, st) in &d.states {
            let total: i64 = st.cards.iter().map(|c| c.qty).sum();
            if total != 100 {
                out.push(format!("{}: the {state} list has {total} cards, not 100", d.name));
            }
            let mut copies: BTreeMap<&str, i64> = BTreeMap::new();
            for c in &st.cards {
                *copies.entry(c.name.trim()).or_insert(0) += c.qty;
            }
            for (name, n) in copies {
                let any_number = resolved.get(name).and_then(|id| info.get(id)).is_some_and(|c| {
                    let t = c.oracle_text.to_lowercase();
                    t.contains("a deck can have any number of cards named") || t.contains("a deck can have up to")
                });
                if n > 1 && !is_basic(name) && !any_number {
                    out.push(format!("{}: the {state} list has {n} copies of {name}", d.name));
                }
            }
            let cards: Vec<DeckCard> = st
                .cards
                .iter()
                .filter_map(|c| {
                    let id = resolved.get(c.name.trim())?;
                    Some(DeckCard {
                        oracle_id: id.clone(),
                        name: c.name.clone(),
                        qty: c.qty,
                        board: if c.board == "commander" { Board::Commander } else { Board::Main },
                    })
                })
                .collect();
            let v = crate::decks::validate(&cards, info);
            for e in v.errors {
                // Size and singleton were checked by name above, unknown cards included.
                if e.contains("Commander decks have exactly 100") || e.contains("Commander is singleton") {
                    continue;
                }
                by_message.entry(e).or_default().push(state);
            }
        }
        for (msg, states) in by_message {
            out.push(format!("{} ({} {}): {msg}", d.name, join_and(&states), if states.len() == 1 { "list" } else { "lists" }));
        }
    }
    out
}

fn join_and(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Answers and ticks whose key matches no live swap, even through an alias. Kept, never dropped.
pub async fn orphans(conn: &mut SqliteConnection, owner: &str) -> AppResult<Vec<Orphan>> {
    let live = super::live_keys(&mut *conn, owner).await?;
    let aliases = super::aliases(&mut *conn, owner).await?;
    #[derive(sqlx::FromRow)]
    struct Answer {
        swap_key: String,
        decision: Option<String>,
        note: Option<String>,
        cut: Option<String>,
        deck_name: Option<String>,
        card: Option<String>,
    }
    let reviews: Vec<Answer> = sqlx::query_as(
        "SELECT swap_key, decision, note, cut, deck_name, card FROM plan_reviews WHERE owner_id = ? ORDER BY swap_key",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let marks: Vec<(String, String)> = sqlx::query_as("SELECT swap_key, kind FROM plan_marks WHERE owner_id = ? AND value = 1 ORDER BY swap_key, kind")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?;
    let mut out: BTreeMap<String, Orphan> = BTreeMap::new();
    for Answer { swap_key: key, decision, note, cut, deck_name: deck, card } in reviews {
        let tombstone = decision.is_none() && note.is_none() && cut.is_none();
        if tombstone || super::resolve_key(&key, &live, &aliases).is_some() {
            continue;
        }
        out.insert(key.clone(), Orphan { swap_key: key, deck, card, decision, marks: vec![] });
    }
    for (key, kind) in marks {
        if super::resolve_key(&key, &live, &aliases).is_some() {
            continue;
        }
        out.entry(key.clone())
            .or_insert_with(|| Orphan { swap_key: key, deck: None, card: None, decision: None, marks: vec![] })
            .marks
            .push(kind);
    }
    Ok(out.into_values().collect())
}

/// The table writes for one import.
struct Writer<'a> {
    owner: &'a str,
    import_id: &'a str,
    stamp: &'a str,
    /// 'import' for an outside export; 'yama' for a Yama backup being restored.
    origin: &'static str,
}

fn json_text<T: Serialize>(v: &T) -> AppResult<String> {
    Ok(serde_json::to_string(v).map_err(anyhow::Error::from)?)
}

#[derive(sqlx::FromRow)]
struct Existing {
    id: String,
    key: String,
    content_hash: Option<String>,
    retired: bool,
    origin: String,
}

/// Count one row against what was there: (write it?, count it).
fn compare(existing: Option<&Existing>, hash: &str, origin: &str, counts: &mut RowCounts) -> bool {
    match existing {
        None => {
            counts.added += 1;
            true
        }
        Some(e) if e.retired => {
            counts.restored += 1;
            true
        }
        Some(e) if e.content_hash.as_deref() == Some(hash) && e.origin == origin => {
            counts.unchanged += 1;
            false
        }
        Some(_) => {
            counts.changed += 1;
            true
        }
    }
}

impl Writer<'_> {
    /// Each date's imported rule set is replaced whole. A set made in Yama is never replaced: on the
    /// same date the imported one isn't applied, and an imported set dated after one made in Yama
    /// applies from its own date with a warning the first time it arrives or changes, so it never
    /// takes over silently (docs/shopping-design.md, "Account-level rules").
    async fn settings(&self, conn: &mut SqliteConnection, plan: &Plan, report: &mut Report) -> AppResult<()> {
        if self.origin != "import" {
            // A Yama backup being restored: its sets replace the sets on the same dates (the report
            // names each one that changes), and no set is deleted, so a backup without some
            // dates never silently removes a rule set made since.
            let existing: HashMap<String, (String, Option<String>, String)> =
                sqlx::query_as::<_, (String, String, Option<String>, String)>("SELECT effective_from, rules, note, origin FROM plan_settings WHERE owner_id = ?")
                    .bind(self.owner)
                    .fetch_all(&mut *conn)
                    .await?
                    .into_iter()
                    .map(|(d, r, n, o)| (d, (r, n, o)))
                    .collect();
            for s in &plan.settings {
                let incoming = (json_text(&s.rules)?, s.note.clone(), self.origin.to_string());
                if existing.get(&s.effective_from).is_some_and(|e| *e != incoming) {
                    report.warnings.push(format!("The rule set from {} was replaced by the restored one", s.effective_from));
                }
                sqlx::query(
                    "INSERT INTO plan_settings (owner_id, effective_from, rules, note, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(owner_id, effective_from) DO UPDATE SET rules = excluded.rules, note = excluded.note,
                       origin = excluded.origin, created_at = excluded.created_at",
                )
                .bind(self.owner)
                .bind(&s.effective_from)
                .bind(json_text(&s.rules)?)
                .bind(&s.note)
                .bind(self.origin)
                .bind(self.stamp)
                .execute(&mut *conn)
                .await?;
            }
            report.counts.settings = plan.settings.len() as i64;
            return Ok(());
        }
        let yama: Vec<String> = sqlx::query_scalar("SELECT effective_from FROM plan_settings WHERE owner_id = ? AND origin != ? ORDER BY effective_from")
            .bind(self.owner)
            .bind(self.origin)
            .fetch_all(&mut *conn)
            .await?;
        let before: HashMap<String, String> = sqlx::query_as::<_, (String, String)>("SELECT effective_from, rules FROM plan_settings WHERE owner_id = ? AND origin = ?")
            .bind(self.owner)
            .bind(self.origin)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
        sqlx::query("DELETE FROM plan_settings WHERE owner_id = ? AND origin = ?").bind(self.owner).bind(self.origin).execute(&mut *conn).await?;
        let mut applied: i64 = 0;
        for s in &plan.settings {
            if yama.contains(&s.effective_from) {
                report.warnings.push(format!(
                    "Kept the rule set from {} made in Yama; the imported one for that date wasn't applied",
                    s.effective_from
                ));
                continue;
            }
            let rules = json_text(&s.rules)?;
            if let Some(last) = yama.iter().rfind(|d| **d < s.effective_from)
                && before.get(&s.effective_from) != Some(&rules)
            {
                report.warnings.push(format!(
                    "The imported rule set from {} applies from that date, after the one made in Yama on {last}",
                    s.effective_from
                ));
            }
            sqlx::query("INSERT INTO plan_settings (owner_id, effective_from, rules, note, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(self.owner)
                .bind(&s.effective_from)
                .bind(&rules)
                .bind(&s.note)
                .bind(self.origin)
                .bind(self.stamp)
                .execute(&mut *conn)
                .await?;
            applied += 1;
        }
        report.counts.settings = applied;
        Ok(())
    }

    async fn stores(&self, conn: &mut SqliteConnection, plan: &Plan, counts: &mut RowCounts) -> AppResult<HashMap<String, String>> {
        let existing: Vec<Existing> = sqlx::query_as(
            "SELECT id, key, content_hash, retired_at IS NOT NULL AS retired, origin FROM plan_stores WHERE owner_id = ?",
        )
        .bind(self.owner)
        .fetch_all(&mut *conn)
        .await?;
        let by_key: HashMap<&str, &Existing> = existing.iter().map(|e| (e.key.as_str(), e)).collect();
        let mut ids: HashMap<String, String> = existing.iter().map(|e| (e.key.clone(), e.id.clone())).collect();
        for s in &plan.stores {
            let hash = model::row_hash(s);
            let e = by_key.get(s.key.as_str()).copied();
            if !compare(e, &hash, self.origin, counts) {
                continue;
            }
            let id = e.map_or_else(new_id, |e| e.id.clone());
            sqlx::query(
                "INSERT INTO plan_stores (id, owner_id, key, name, short_name, kind, cart_url_template, homepage, location, note,
                   print_tiers, sort, origin, content_hash, import_id, retired_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                 ON CONFLICT(owner_id, key) DO UPDATE SET name = excluded.name, short_name = excluded.short_name,
                   kind = excluded.kind, cart_url_template = excluded.cart_url_template, homepage = excluded.homepage,
                   location = excluded.location, note = excluded.note, print_tiers = excluded.print_tiers,
                   sort = excluded.sort, origin = excluded.origin, content_hash = excluded.content_hash,
                   import_id = excluded.import_id, retired_at = NULL, updated_at = excluded.updated_at",
            )
            .bind(&id)
            .bind(self.owner)
            .bind(&s.key)
            .bind(&s.name)
            .bind(&s.short)
            .bind(&s.kind)
            .bind(&s.cart_url_template)
            .bind(&s.homepage)
            .bind(&s.location)
            .bind(&s.note)
            .bind(s.print_tiers.as_ref().map(json_text).transpose()?)
            .bind(s.sort.unwrap_or(0))
            .bind(self.origin)
            .bind(&hash)
            .bind(self.import_id)
            .bind(self.stamp)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
            ids.insert(s.key.clone(), id);
        }
        if self.origin == "import" {
            let keys: Vec<&str> = plan.stores.iter().map(|s| s.key.as_str()).collect();
            counts.retired += sqlx::query(
                "UPDATE plan_stores SET retired_at = ?, updated_at = ? WHERE owner_id = ? AND origin = 'import' AND retired_at IS NULL
                   AND key NOT IN (SELECT value FROM json_each(?))",
            )
            .bind(self.stamp)
            .bind(self.stamp)
            .bind(self.owner)
            .bind(json_text(&keys)?)
            .execute(&mut *conn)
            .await?
            .rows_affected() as i64;
        }
        Ok(ids)
    }

    async fn decks(&self, conn: &mut SqliteConnection, plan: &Plan, counts: &mut RowCounts) -> AppResult<HashMap<String, String>> {
        // A plan tracking a note's build never blocks an outside export's key: it moves to a free
        // one first. A Yama backup restores onto its own Yama-made decks, so it moves nothing.
        let file_keys: Vec<&str> =
            plan.decks.iter().filter(|d| d.source.as_deref().unwrap_or(self.origin) == "import").map(|d| d.key.as_str()).collect();
        super::notes::make_room(conn, self.owner, &file_keys).await?;
        let existing: Vec<Existing> = sqlx::query_as(
            "SELECT id, key, content_hash, status = 'archived' AS retired, source AS origin FROM plan_decks WHERE owner_id = ?",
        )
        .bind(self.owner)
        .fetch_all(&mut *conn)
        .await?;
        let by_key: HashMap<&str, &Existing> = existing.iter().map(|e| (e.key.as_str(), e)).collect();
        let mut ids: HashMap<String, String> = existing.iter().map(|e| (e.key.clone(), e.id.clone())).collect();
        for (i, d) in plan.decks.iter().enumerate() {
            let source = d.source.as_deref().unwrap_or(self.origin);
            let e = by_key.get(d.key.as_str()).copied();
            if let Some(e) = e
                && e.origin != source
            {
                return Err(AppError::Conflict(if e.origin == "yama" {
                    format!("plan.decks[{i}].key: \"{}\" is a plan you made in Yama; this file would replace it with an imported one", d.key)
                } else {
                    format!("plan.decks[{i}].key: \"{}\" is managed by your export; this file would turn it into a Yama-made plan", d.key)
                }));
            }
            let status = d.status.as_deref().unwrap_or("active");
            let hash = model::row_hash(&json!({
                "name": d.name, "source": source, "status": status, "sort": d.sort, "product": d.product,
                "commander": d.commander, "color_identity": d.color_identity, "owner_changes": d.owner_changes,
                "bracket": d.bracket, "groups": d.groups, "notes": d.notes,
            }));
            if !compare(e, &hash, source, counts) {
                continue;
            }
            let id = e.map_or_else(new_id, |e| e.id.clone());
            sqlx::query(
                "INSERT INTO plan_decks (id, owner_id, key, name, source, status, product, commander, color_identity, owner_changes,
                   bracket, groups, notes, sort, content_hash, import_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(owner_id, key) DO UPDATE SET name = excluded.name, status = excluded.status,
                   product = excluded.product, commander = excluded.commander, color_identity = excluded.color_identity,
                   owner_changes = excluded.owner_changes, bracket = excluded.bracket, groups = excluded.groups,
                   notes = excluded.notes, sort = excluded.sort, content_hash = excluded.content_hash,
                   import_id = excluded.import_id, updated_at = excluded.updated_at",
            )
            .bind(&id)
            .bind(self.owner)
            .bind(&d.key)
            .bind(&d.name)
            .bind(source)
            .bind(status)
            .bind(&d.product)
            .bind(json_text(&d.commander)?)
            .bind(&d.color_identity)
            .bind(json_text(&d.owner_changes)?)
            .bind(d.bracket.as_ref().map(Value::to_string))
            .bind(json_text(&d.groups)?)
            .bind(json_text(&d.notes)?)
            .bind(d.sort.unwrap_or(0))
            .bind(&hash)
            .bind(self.import_id)
            .bind(self.stamp)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
            ids.insert(d.key.clone(), id);
        }
        if self.origin == "import" {
            let keys: Vec<&str> = plan.decks.iter().map(|d| d.key.as_str()).collect();
            counts.retired += sqlx::query(
                "UPDATE plan_decks SET status = 'archived', updated_at = ? WHERE owner_id = ? AND source = 'import'
                   AND status != 'archived' AND key NOT IN (SELECT value FROM json_each(?))",
            )
            .bind(self.stamp)
            .bind(self.owner)
            .bind(json_text(&keys)?)
            .execute(&mut *conn)
            .await?
            .rows_affected() as i64;
        }
        Ok(ids)
    }

    /// Orders and their items. Items keep their ids by (order, line), so swaps stay linked.
    async fn orders(
        &self,
        conn: &mut SqliteConnection,
        plan: &Plan,
        store_ids: &HashMap<String, String>,
        counts: &mut RowCounts,
    ) -> AppResult<(HashMap<String, String>, HashMap<(String, i64), String>)> {
        let existing: Vec<Existing> = sqlx::query_as(
            "SELECT id, ext_key AS key, content_hash, retired_at IS NOT NULL AS retired, origin FROM plan_orders WHERE owner_id = ?",
        )
        .bind(self.owner)
        .fetch_all(&mut *conn)
        .await?;
        let by_key: HashMap<&str, &Existing> = existing.iter().map(|e| (e.key.as_str(), e)).collect();
        let mut ids: HashMap<String, String> = existing.iter().map(|e| (e.key.clone(), e.id.clone())).collect();
        for o in &plan.orders {
            let hash = model::row_hash(o);
            let e = by_key.get(o.key.as_str()).copied();
            if !compare(e, &hash, self.origin, counts) {
                continue;
            }
            let id = e.map_or_else(new_id, |e| e.id.clone());
            sqlx::query(
                "INSERT INTO plan_orders (id, owner_id, ext_key, kind, status, vendor, store_id, order_number, date_ordered, placed_by,
                   date_fulfilled, fulfillment, currency, subtotal, subtotal_note, shipping, tax, total, card_stock, evidence,
                   issues, note, origin, content_hash, import_id, retired_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                 ON CONFLICT(owner_id, ext_key) DO UPDATE SET kind = excluded.kind, status = excluded.status,
                   vendor = excluded.vendor, store_id = excluded.store_id, order_number = excluded.order_number,
                   date_ordered = excluded.date_ordered, placed_by = excluded.placed_by, date_fulfilled = excluded.date_fulfilled,
                   fulfillment = excluded.fulfillment, currency = excluded.currency, subtotal = excluded.subtotal,
                   subtotal_note = excluded.subtotal_note, shipping = excluded.shipping, tax = excluded.tax,
                   total = excluded.total, card_stock = excluded.card_stock, evidence = excluded.evidence,
                   issues = excluded.issues, note = excluded.note, origin = excluded.origin,
                   content_hash = excluded.content_hash, import_id = excluded.import_id, retired_at = NULL,
                   updated_at = excluded.updated_at",
            )
            .bind(&id)
            .bind(self.owner)
            .bind(&o.key)
            .bind(&o.kind)
            .bind(&o.status)
            .bind(&o.vendor)
            .bind(o.store.as_ref().and_then(|s| store_ids.get(s)))
            .bind(&o.order_number)
            .bind(&o.date_ordered)
            .bind(&o.placed_by)
            .bind(&o.date_fulfilled)
            .bind(&o.fulfillment)
            .bind(o.currency.as_deref().unwrap_or("USD"))
            .bind(o.subtotal)
            .bind(&o.subtotal_note)
            .bind(o.shipping)
            .bind(o.tax)
            .bind(o.total)
            .bind(&o.card_stock)
            .bind(&o.evidence)
            .bind(json_text(&o.issues)?)
            .bind(&o.note)
            .bind(self.origin)
            .bind(&hash)
            .bind(self.import_id)
            .bind(self.stamp)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
            for it in &o.items {
                sqlx::query(
                    "INSERT INTO plan_order_items (id, owner_id, order_id, line, card_name, qty, listing, set_code, collector_number,
                       finish, scryfall_id, received_set_code, received_collector_number, received_note, deck_key, replaces,
                       role, unit_price, arrived)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(order_id, line) DO UPDATE SET card_name = excluded.card_name, qty = excluded.qty,
                       listing = excluded.listing, set_code = excluded.set_code, collector_number = excluded.collector_number,
                       finish = excluded.finish, scryfall_id = excluded.scryfall_id,
                       received_set_code = excluded.received_set_code,
                       received_collector_number = excluded.received_collector_number,
                       received_note = excluded.received_note, deck_key = excluded.deck_key, replaces = excluded.replaces,
                       role = excluded.role, unit_price = excluded.unit_price, arrived = excluded.arrived",
                )
                .bind(new_id())
                .bind(self.owner)
                .bind(&id)
                .bind(it.line)
                .bind(&it.card)
                .bind(it.qty)
                .bind(&it.listing)
                .bind(it.set.as_ref().map(|s| s.trim().to_lowercase()))
                .bind(&it.num)
                .bind(&it.finish)
                .bind(&it.scryfall_id)
                .bind(it.received.as_ref().and_then(|r| r.set.as_ref().map(|s| s.trim().to_lowercase())))
                .bind(it.received.as_ref().and_then(|r| r.num.clone()))
                .bind(it.received.as_ref().and_then(|r| r.note.clone()))
                .bind(&it.deck)
                .bind(&it.replaces)
                .bind(&it.role)
                .bind(it.unit_price)
                .bind(it.arrived)
                .execute(&mut *conn)
                .await?;
            }
            let lines: Vec<i64> = o.items.iter().map(|it| it.line).collect();
            sqlx::query("DELETE FROM plan_order_items WHERE order_id = ? AND owner_id = ? AND line NOT IN (SELECT value FROM json_each(?))")
                .bind(&id)
                .bind(self.owner)
                .bind(json_text(&lines)?)
                .execute(&mut *conn)
                .await?;
            ids.insert(o.key.clone(), id);
        }
        if self.origin == "import" {
            let keys: Vec<&str> = plan.orders.iter().map(|o| o.key.as_str()).collect();
            counts.retired += sqlx::query(
                "UPDATE plan_orders SET retired_at = ?, updated_at = ? WHERE owner_id = ? AND origin = 'import' AND retired_at IS NULL
                   AND ext_key NOT IN (SELECT value FROM json_each(?))",
            )
            .bind(self.stamp)
            .bind(self.stamp)
            .bind(self.owner)
            .bind(json_text(&keys)?)
            .execute(&mut *conn)
            .await?
            .rows_affected() as i64;
        }
        let items: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT i.id, o.ext_key, i.line FROM plan_order_items i JOIN plan_orders o ON o.id = i.order_id AND o.owner_id = i.owner_id
             WHERE i.owner_id = ?",
        )
        .bind(self.owner)
        .fetch_all(&mut *conn)
        .await?;
        Ok((ids, items.into_iter().map(|(id, order, line)| ((order, line), id)).collect()))
    }

    async fn swaps(
        &self,
        conn: &mut SqliteConnection,
        plan: &Plan,
        deck_ids: &HashMap<String, String>,
        order_ids: &HashMap<String, String>,
        item_ids: &HashMap<(String, i64), String>,
        counts: &mut RowCounts,
    ) -> AppResult<HashMap<String, String>> {
        let existing: Vec<Existing> = sqlx::query_as(
            "SELECT s.id, s.ext_key AS key, s.content_hash, s.retired_at IS NOT NULL AS retired, d.source AS origin
             FROM plan_swaps s JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id WHERE s.owner_id = ?",
        )
        .bind(self.owner)
        .fetch_all(&mut *conn)
        .await?;
        let by_key: HashMap<&str, &Existing> = existing.iter().map(|e| (e.key.as_str(), e)).collect();
        let mut ids: HashMap<String, String> = existing.iter().map(|e| (e.key.clone(), e.id.clone())).collect();
        let deck_source: HashMap<&str, &str> =
            plan.decks.iter().map(|d| (d.key.as_str(), d.source.as_deref().unwrap_or(self.origin))).collect();
        for s in &plan.swaps {
            let hash = model::row_hash(s);
            let e = by_key.get(s.key.as_str()).copied();
            let source = deck_source.get(s.deck.as_str()).copied().unwrap_or(self.origin);
            if !compare(e, &hash, source, counts) {
                continue;
            }
            let id = e.map_or_else(new_id, |e| e.id.clone());
            let deck_id = deck_ids.get(&s.deck).ok_or(AppError::NotFound("plan deck"))?;
            sqlx::query(
                "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, src_declared, store_label, out_name,
                   in_name, plan_card, later_out, after_print, tier, band, sort, game_changer, got, listing, group_label,
                   when_text, advice, why, why_out, note, upgrade, content_hash, import_id, retired_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                 ON CONFLICT(owner_id, ext_key) DO UPDATE SET plan_deck_id = excluded.plan_deck_id, stage = excluded.stage,
                   role = excluded.role, src = excluded.src, src_declared = excluded.src_declared,
                   store_label = excluded.store_label, out_name = excluded.out_name, in_name = excluded.in_name,
                   plan_card = excluded.plan_card, later_out = excluded.later_out, after_print = excluded.after_print,
                   tier = excluded.tier, band = excluded.band, sort = excluded.sort, game_changer = excluded.game_changer,
                   got = excluded.got, listing = excluded.listing, group_label = excluded.group_label,
                   when_text = excluded.when_text, advice = excluded.advice, why = excluded.why, why_out = excluded.why_out,
                   note = excluded.note, upgrade = excluded.upgrade, content_hash = excluded.content_hash,
                   import_id = excluded.import_id, retired_at = NULL, updated_at = excluded.updated_at",
            )
            .bind(&id)
            .bind(self.owner)
            .bind(deck_id)
            .bind(&s.key)
            .bind(&s.stage)
            .bind(&s.role)
            .bind(&s.src)
            .bind(&s.src_declared)
            .bind(&s.store_label)
            .bind(&s.out)
            .bind(&s.inn)
            .bind(&s.plan_card)
            .bind(&s.later_out)
            .bind(s.after_print)
            .bind(&s.tier)
            .bind(&s.band)
            .bind(s.sort.unwrap_or(0))
            .bind(s.game_changer)
            .bind(s.got.as_ref().map(Value::to_string))
            .bind(&s.listing)
            .bind(&s.group)
            .bind(&s.when)
            .bind(&s.advice)
            .bind(&s.why)
            .bind(&s.why_out)
            .bind(&s.note)
            .bind(s.upgrade.as_ref().map(Value::to_string))
            .bind(&hash)
            .bind(self.import_id)
            .bind(self.stamp)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
            ids.insert(s.key.clone(), id);
        }
        // Links by key, now that every row has its id. Only rows whose links differ are touched.
        for s in &plan.swaps {
            let parent = s.parent.as_ref().and_then(|k| ids.get(k));
            let item = s.order_item.as_ref().and_then(|r| item_ids.get(&(r.order.clone(), r.line)));
            let print_order = s.print_order.as_ref().and_then(|k| order_ids.get(k));
            sqlx::query(
                "UPDATE plan_swaps SET parent_id = ?1, order_item_id = ?2, print_order_id = ?3
                 WHERE id = ?4 AND owner_id = ?5
                   AND (parent_id IS NOT ?1 OR order_item_id IS NOT ?2 OR print_order_id IS NOT ?3)",
            )
            .bind(parent)
            .bind(item)
            .bind(print_order)
            .bind(&ids[&s.key])
            .bind(self.owner)
            .execute(&mut *conn)
            .await?;
        }
        if self.origin == "import" {
            let keys: Vec<&str> = plan.swaps.iter().map(|s| s.key.as_str()).collect();
            counts.retired += sqlx::query(
                "UPDATE plan_swaps SET retired_at = ?, updated_at = ? WHERE owner_id = ? AND retired_at IS NULL
                   AND plan_deck_id IN (SELECT id FROM plan_decks WHERE owner_id = ? AND source = 'import')
                   AND ext_key NOT IN (SELECT value FROM json_each(?))",
            )
            .bind(self.stamp)
            .bind(self.stamp)
            .bind(self.owner)
            .bind(self.owner)
            .bind(json_text(&keys)?)
            .execute(&mut *conn)
            .await?
            .rows_affected() as i64;
        }
        Ok(ids)
    }

    /// Imported quotes are replaced whole: nothing a user makes refers to them.
    async fn quotes(
        &self,
        conn: &mut SqliteConnection,
        plan: &Plan,
        swap_ids: &HashMap<String, String>,
        store_ids: &HashMap<String, String>,
    ) -> AppResult<i64> {
        // Quotes on a plan made from a note are rewritten from the note after a backup restore
        // (`notes::rederive_all`), so they go with the rest here.
        sqlx::query("DELETE FROM plan_quotes WHERE owner_id = ? AND origin = ?").bind(self.owner).bind(self.origin).execute(&mut *conn).await?;
        for q in &plan.quotes {
            sqlx::query(
                "INSERT INTO plan_quotes (id, owner_id, swap_id, card_name, kind, store_id, store_label, checked_on, result, in_stock,
                   price, price_from_text, currency, printing, set_code, collector_number, printing_from_text, scryfall_id,
                   variant, url, source, origin, import_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(self.owner)
            .bind(q.swap.as_ref().and_then(|k| swap_ids.get(k)))
            .bind(&q.card)
            .bind(&q.kind)
            .bind(q.store.as_ref().and_then(|k| store_ids.get(k)))
            .bind(&q.store_label)
            .bind(&q.checked)
            .bind(&q.result)
            .bind(q.in_stock)
            .bind(q.price)
            .bind(q.price_from_text)
            .bind(q.currency.as_deref().unwrap_or("USD"))
            .bind(&q.printing)
            .bind(q.set.as_ref().map(|s| s.trim().to_lowercase()))
            .bind(&q.num)
            .bind(q.printing_from_text)
            .bind(&q.scryfall_id)
            .bind(&q.variant)
            .bind(&q.url)
            .bind(&q.source)
            .bind(self.origin)
            .bind(self.import_id)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
        }
        Ok(plan.quotes.len() as i64)
    }

    /// A list with new cards is a new row; the same cards refresh the stored row's details.
    /// `current` moves to the document's list; a state the document leaves out has no current list.
    async fn states(
        &self,
        conn: &mut SqliteConnection,
        plan: &Plan,
        deck_ids: &HashMap<String, String>,
        default_by: &str,
        counts: &mut Counts,
    ) -> AppResult<()> {
        for d in &plan.decks {
            let deck_id = deck_ids.get(&d.key).ok_or(AppError::NotFound("plan deck"))?;
            for (state, st) in &d.states {
                let identity = model::list_identity(&st.cards);
                let cards = json_text::<Vec<Slot>>(&st.cards)?;
                let log = json_text(&st.log)?;
                let by = st.computed_by.clone().or_else(|| d.computed_by.clone()).unwrap_or_else(|| default_by.to_string());
                let found: Option<(String, String, String, String)> = sqlx::query_as(
                    "SELECT id, cards, log, computed_by FROM plan_states WHERE plan_deck_id = ? AND owner_id = ? AND state = ? AND content_hash = ?",
                )
                .bind(deck_id)
                .bind(self.owner)
                .bind(state)
                .bind(&identity)
                .fetch_optional(&mut *conn)
                .await?;
                let id = match found {
                    None => {
                        let id = new_id();
                        sqlx::query(
                            "INSERT INTO plan_states (id, owner_id, plan_deck_id, state, content_hash, cards, log, computed_by, current,
                               import_id, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                        )
                        .bind(&id)
                        .bind(self.owner)
                        .bind(deck_id)
                        .bind(state)
                        .bind(&identity)
                        .bind(&cards)
                        .bind(&log)
                        .bind(&by)
                        .bind(self.import_id)
                        .bind(self.stamp)
                        .bind(self.stamp)
                        .execute(&mut *conn)
                        .await?;
                        counts.states_new += 1;
                        id
                    }
                    Some((id, old_cards, old_log, old_by)) => {
                        if old_cards != cards || old_log != log || old_by != by {
                            sqlx::query("UPDATE plan_states SET cards = ?, log = ?, computed_by = ?, import_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
                                .bind(&cards)
                                .bind(&log)
                                .bind(&by)
                                .bind(self.import_id)
                                .bind(self.stamp)
                                .bind(&id)
                                .bind(self.owner)
                                .execute(&mut *conn)
                                .await?;
                            counts.states_refreshed += 1;
                        }
                        id
                    }
                };
                // The partial unique index allows one current row: clear the old one first.
                sqlx::query("UPDATE plan_states SET current = 0 WHERE plan_deck_id = ? AND owner_id = ? AND state = ? AND current = 1 AND id != ?")
                    .bind(deck_id)
                    .bind(self.owner)
                    .bind(state)
                    .bind(&id)
                    .execute(&mut *conn)
                    .await?;
                // A list made current again is current from now (shared pages compare it with when
                // a lab run was made), even though its row is older.
                sqlx::query("UPDATE plan_states SET current = 1, updated_at = ? WHERE id = ? AND owner_id = ? AND current = 0")
                    .bind(self.stamp)
                    .bind(&id)
                    .bind(self.owner)
                    .execute(&mut *conn)
                    .await?;
            }
            let present: Vec<&String> = d.states.keys().collect();
            sqlx::query(
                "UPDATE plan_states SET current = 0 WHERE plan_deck_id = ? AND owner_id = ? AND current = 1
                   AND state NOT IN (SELECT value FROM json_each(?))",
            )
            .bind(deck_id)
            .bind(self.owner)
            .bind(json_text(&present)?)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }

    /// Aliases are kept when a later document drops them, so an answer never loses its row. One
    /// whose old key is live again is removed: the live key wins.
    async fn aliases(&self, conn: &mut SqliteConnection, plan: &Plan, checked: &Checked) -> AppResult<i64> {
        for (old, new) in &checked.aliases {
            sqlx::query(
                "INSERT INTO plan_key_aliases (owner_id, old_key, new_key, import_id, created_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(owner_id, old_key) DO UPDATE SET new_key = excluded.new_key, import_id = excluded.import_id
                 WHERE new_key != excluded.new_key",
            )
            .bind(self.owner)
            .bind(old)
            .bind(new)
            .bind(self.import_id)
            .bind(self.stamp)
            .execute(&mut *conn)
            .await?;
        }
        let live: Vec<&str> = plan.swaps.iter().map(|s| s.key.as_str()).collect();
        sqlx::query("DELETE FROM plan_key_aliases WHERE owner_id = ? AND old_key IN (SELECT value FROM json_each(?))")
            .bind(self.owner)
            .bind(json_text(&live)?)
            .execute(&mut *conn)
            .await?;
        Ok(checked.aliases.len() as i64)
    }

    /// Last writer wins per key, tombstones included. Ties go to the answer made in Yama.
    async fn reviews(&self, conn: &mut SqliteConnection, checked: &Checked) -> AppResult<ReviewCounts> {
        let mut counts = ReviewCounts::default();
        for (key, r) in &checked.reviews {
            let existing: Option<(String, String)> = sqlx::query_as("SELECT at, origin FROM plan_reviews WHERE owner_id = ? AND swap_key = ?")
                .bind(self.owner)
                .bind(key)
                .fetch_optional(&mut *conn)
                .await?;
            match &existing {
                Some((at, origin)) if *at >= r.at => {
                    if origin == "yama" {
                        counts.yama_newer_kept += 1;
                    }
                    continue;
                }
                _ => {}
            }
            sqlx::query(
                "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, deck_name, card, at, origin, op_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', NULL)
                 ON CONFLICT(owner_id, swap_key) DO UPDATE SET decision = excluded.decision, note = excluded.note,
                   cut = excluded.cut, deck_name = excluded.deck_name, card = excluded.card, at = excluded.at,
                   origin = 'import', op_id = NULL",
            )
            .bind(self.owner)
            .bind(key)
            .bind(&r.decision)
            .bind(&r.note)
            .bind(&r.cut)
            .bind(&r.deck)
            .bind(&r.card)
            .bind(&r.at)
            .execute(&mut *conn)
            .await?;
            counts.from_document_applied += 1;
        }
        Ok(counts)
    }

    async fn inbox_outcomes(&self, conn: &mut SqliteConnection, checked: &Checked) -> AppResult<()> {
        for (op_id, outcome, at) in &checked.resolved {
            sqlx::query(
                "UPDATE plan_inputs SET outcome = ?1, outcome_at = ?2 WHERE owner_id = ?3 AND op_id = ?4
                   AND (outcome IS NOT ?1 OR outcome_at IS NOT ?2)",
            )
            .bind(outcome)
            .bind(at)
            .bind(self.owner)
            .bind(op_id)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }
}
