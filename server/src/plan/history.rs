//! A plan's history: where it and its changes came from (Bryan, 2026-11-21, after asking why
//! three changes from an earlier request were in his Riders of Rohan plan: "record where these
//! plans came from ... so it can have the history of that and the ability to find it in the
//! future easily and quickly ... We've kind of got too messy in a lot of these").
//!
//! Two kinds of record make one timeline. Entries (`plan_history`) are what an assistant
//! recorded with `record_plan_history` or `track_build`: what happened, the person's request in
//! their own words, when, and where the conversation and the work are. Everything Yama did
//! itself is read from where it already lives and never copied here: the plan's first import or
//! note, each version and what it took in or left out (`plan_versions`), each answer
//! (`plan_inputs`, `plan_reviews`) and archiving (`plan_decks`).

use crate::error::{AppError, AppResult};
use crate::util::new_id;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fmt::Write as _;

/// The longest `what` an entry takes.
pub const WHAT_MAX: usize = 2000;
/// The longest `asked` (the person's own words) an entry takes.
pub const ASKED_MAX: usize = 4000;
/// The longest `conversation` or `work` pointer an entry takes.
pub const WHERE_MAX: usize = 500;
/// The most cards one entry names.
pub const CARDS_MAX: usize = 60;
/// The most entries one plan keeps: a plan's story, not a log.
pub const ENTRIES_MAX: i64 = 500;

/// What an assistant records about a plan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Entry {
    /// YYYY-MM-DD: when it happened.
    pub on: String,
    pub what: String,
    pub asked: Option<String>,
    pub conversation: Option<String>,
    pub work: Option<String>,
    /// The proposal group it is about; checked against the plan's groups.
    pub group: Option<String>,
    /// The changes it is about, by a card each puts in or takes out; checked against the plan.
    pub cards: Vec<String>,
}

/// What `record` stored.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub id: String,
    pub deck_key: String,
    pub deck: String,
    /// The same entry was already recorded (a retry, or the same op_id): nothing new was stored.
    pub again: bool,
    /// The group and cards as the plan names them.
    pub group: Option<String>,
    pub cards: Vec<String>,
}

/// One of the owner's plans by key or name, archived ones included (an archived plan's history
/// is still its history): (id, key, name). A key names one plan. A deck's name names its live
/// plan, or its only plan; several plans with the name and none live (one replaced another, then
/// that one was archived) need the key, as do several partial matches.
pub async fn plan_of(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String, String)> {
    type Row = (String, String, String, bool);
    const COLS: &str = "SELECT id, key, name, status = 'archived' OR archived_at IS NOT NULL FROM plan_decks WHERE owner_id = ?1";
    let several = |list: &[Row]| {
        AppError::bad(format!("Several plans match \"{wanted}\": {}. Give the plan key.", list.iter().map(|r| r.1.as_str()).collect::<Vec<_>>().join(", ")))
    };
    // A key first, then the exact name, then a part of a name: each found in full before the next.
    let by_key: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLS} AND key = ?2"))).bind(owner).bind(wanted).fetch_optional(pool).await?;
    if let Some(r) = by_key {
        return Ok((r.0, r.1, r.2));
    }
    let named: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLS} AND lower(name) = lower(?2) ORDER BY key")))
        .bind(owner)
        .bind(wanted)
        .fetch_all(pool)
        .await?;
    let live: Vec<&Row> = named.iter().filter(|r| !r.3).collect();
    let pick = |r: &Row| (r.0.clone(), r.1.clone(), r.2.clone());
    match (named.as_slice(), live.as_slice()) {
        (_, [one]) => return Ok(pick(one)),
        ([one], _) => return Ok(pick(one)),
        ([], _) => {}
        _ => return Err(several(&named)),
    }
    let partial: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLS} AND instr(lower(name), lower(?2)) > 0 ORDER BY key LIMIT 10")))
        .bind(owner)
        .bind(wanted)
        .fetch_all(pool)
        .await?;
    match partial.as_slice() {
        [] => Err(AppError::NotFound("plan deck")),
        [one] => Ok(pick(one)),
        _ => Err(several(&partial)),
    }
}

/// Which plan an entry goes on: as a caller names it (a key or a deck's name), or by its row's id,
/// which never changes (a tool that just tracked a note's build knows its plan by the note's link).
#[derive(Debug, Clone, Copy)]
pub enum PlanRef<'a> {
    Named(&'a str),
    Id(&'a str),
}

async fn resolve(pool: &SqlitePool, owner: &str, plan: PlanRef<'_>) -> AppResult<(String, String, String)> {
    match plan {
        PlanRef::Named(wanted) => plan_of(pool, owner, wanted).await,
        PlanRef::Id(id) => sqlx::query_as("SELECT id, key, name FROM plan_decks WHERE id = ? AND owner_id = ?")
            .bind(id)
            .bind(owner)
            .fetch_optional(pool)
            .await?
            .ok_or(AppError::NotFound("plan deck")),
    }
}

/// The plan's proposal groups, in its order: the groups it declares, then any other a swap names.
async fn group_labels(pool: &SqlitePool, owner: &str, plan_id: &str) -> AppResult<Vec<String>> {
    let declared: String = sqlx::query_scalar("SELECT groups FROM plan_decks WHERE id = ? AND owner_id = ?").bind(plan_id).bind(owner).fetch_one(pool).await?;
    let mut labels: Vec<String> = serde_json::from_str::<Vec<Value>>(&declared)
        .unwrap_or_default()
        .iter()
        .filter_map(|g| g["label"].as_str().map(String::from))
        .collect();
    let used: Vec<String> = sqlx::query_scalar(
        "SELECT group_label FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ? AND group_label IS NOT NULL GROUP BY group_label ORDER BY MIN(sort), group_label",
    )
    .bind(owner)
    .bind(plan_id)
    .fetch_all(pool)
    .await?;
    for l in used {
        if !labels.contains(&l) {
            labels.push(l);
        }
    }
    Ok(labels)
}

fn today() -> chrono::NaiveDate {
    chrono::Utc::now().date_naive()
}

/// Record an entry in a plan's history. `replaces` names an earlier entry of the same plan that
/// this one corrects: it goes, in the same transaction.
pub async fn record(pool: &SqlitePool, owner: &str, plan: PlanRef<'_>, e: &Entry, op_id: Option<&str>, replaces: Option<&str>, via: &str) -> AppResult<Recorded> {
    if !super::model::is_date(&e.on) {
        return Err(AppError::bad(format!("on: \"{}\" isn't a YYYY-MM-DD date", e.on)));
    }
    let on = chrono::NaiveDate::parse_from_str(&e.on, "%Y-%m-%d").map_err(|_| AppError::bad("on isn't a date"))?;
    // A day's grace for a caller ahead of UTC.
    if on > today() + chrono::Duration::days(1) {
        return Err(AppError::bad(format!("on: {} is in the future; give the day it happened", e.on)));
    }
    let what = e.what.trim();
    if what.is_empty() {
        return Err(AppError::bad("what is missing: say what happened"));
    }
    // A correction deletes the entry it replaces: only its op_id can tell a retry after a lost
    // reply from a correction of an entry that's gone.
    if replaces.is_some() && op_id.is_none() {
        return Err(AppError::bad("replaces needs an op_id, so a retry of the correction is recognised"));
    }
    // A retry with its op_id is the entry already stored, even if the plan has changed since and
    // would no longer take its key, group or cards as given (they were checked the first time):
    // an import can move a plan to another key (`notes::make_room`) or rename a card.
    if let Some(op) = op_id {
        #[allow(clippy::type_complexity)]
        let stored: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>)> =
            sqlx::query_as(
                "SELECT id, plan_deck_id, on_date, what, asked, conversation, work, group_label, cards, replaces FROM plan_history WHERE owner_id = ? AND op_id = ?",
            )
            .bind(owner)
            .bind(op)
            .fetch_optional(pool)
            .await?;
        if let Some((id, p, on_date, w, asked, conversation, work, g, c, replaced)) = stored {
            let (deck_key, deck): (String, String) =
                sqlx::query_as("SELECT key, name FROM plan_decks WHERE id = ? AND owner_id = ?").bind(&p).bind(owner).fetch_one(pool).await?;
            // The stored plan is the one it was recorded on: the key given may name another plan
            // now (an import can take a moved plan's old key), so it isn't looked up again.
            let given_group = e.group.as_deref().map(str::trim).filter(|g| !g.is_empty());
            let same_group = match (given_group, g.as_deref()) {
                (None, None) => true,
                (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                _ => false,
            };
            let stored_cards: Vec<String> = serde_json::from_str(&c).unwrap_or_default();
            let mut given: Vec<String> = e.cards.iter().map(|c| c.trim().to_lowercase()).collect();
            given.dedup();
            let mut kept: Vec<String> = stored_cards.iter().map(|c| c.to_lowercase()).collect();
            given.sort();
            given.dedup();
            kept.sort();
            let same = replaced.as_deref() == replaces
                && on_date == e.on
                && w == e.what.trim()
                && asked == e.asked
                && conversation == e.conversation
                && work == e.work
                && same_group
                && given == kept;
            if !same {
                return Err(AppError::Conflict(format!("op_id {op} was used for another entry; use a new op_id for a new one")));
            }
            return Ok(Recorded { id, deck_key, deck, again: true, group: g, cards: stored_cards });
        }
    }
    let (plan_id, deck_key, deck) = resolve(pool, owner, plan).await?;
    let group = match e.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        None => None,
        Some(g) => {
            let labels = group_labels(pool, owner, &plan_id).await?;
            match labels.iter().find(|l| l.eq_ignore_ascii_case(g)) {
                Some(l) => Some(l.clone()),
                None if labels.is_empty() => return Err(AppError::bad(format!("group: {deck}'s plan has no proposal groups; leave group out"))),
                None => return Err(AppError::bad(format!("group: {deck}'s plan has no group \"{g}\"; its groups are {}", labels.join("; ")))),
            }
        }
    };
    let mut cards: Vec<String> = Vec::new();
    // The keys of the changes the cards name, kept with the entry: a later plan file can rename a
    // change's cards under the same key.
    let mut swap_keys: Vec<String> = Vec::new();
    if !e.cards.is_empty() {
        let names: Vec<(String, String, Option<String>)> =
            sqlx::query_as("SELECT ext_key, in_name, out_name FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ? ORDER BY sort, ext_key")
                .bind(owner)
                .bind(&plan_id)
                .fetch_all(pool)
                .await?;
        let mut unknown = Vec::new();
        for c in &e.cards {
            let c = c.trim();
            let found = names
                .iter()
                .find_map(|(_, i, _)| i.eq_ignore_ascii_case(c).then(|| i.clone()))
                .or_else(|| names.iter().find_map(|(_, _, o)| o.as_ref().filter(|o| o.eq_ignore_ascii_case(c)).cloned()));
            match found {
                Some(n) => {
                    for (k, i, o) in &names {
                        if (i.eq_ignore_ascii_case(c) || o.as_deref().is_some_and(|o| o.eq_ignore_ascii_case(c))) && !swap_keys.contains(k) {
                            swap_keys.push(k.clone());
                        }
                    }
                    if !cards.contains(&n) {
                        cards.push(n);
                    }
                }
                None => unknown.push(c.to_string()),
            }
        }
        if !unknown.is_empty() {
            return Err(AppError::bad(format!("cards: no change in {deck}'s plan puts in or takes out {}", unknown.join(", "))));
        }
    }
    let cards_json = Value::from(cards.clone()).to_string();
    // A write from the start, so a retry racing the first call waits for it and finds its row.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    #[allow(clippy::type_complexity)]
    let same: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>)> = match op_id {
        Some(op) => {
            sqlx::query_as(
                "SELECT id, plan_deck_id, on_date, what, asked, conversation, work, group_label, cards, replaces FROM plan_history WHERE owner_id = ? AND op_id = ?",
            )
            .bind(owner)
            .bind(op)
            .fetch_optional(&mut *tx)
            .await?
        }
        // A correction always goes in: the entry it replaces may say the same.
        None if replaces.is_some() => None,
        None => {
            sqlx::query_as(
                "SELECT id, plan_deck_id, on_date, what, asked, conversation, work, group_label, cards, replaces FROM plan_history
                 WHERE owner_id = ? AND plan_deck_id = ? AND on_date = ? AND what = ? AND IFNULL(asked, '') = IFNULL(?, '')
                   AND IFNULL(conversation, '') = IFNULL(?, '') AND IFNULL(work, '') = IFNULL(?, '')
                   AND IFNULL(group_label, '') = IFNULL(?, '') AND cards = ?",
            )
            .bind(owner)
            .bind(&plan_id)
            .bind(&e.on)
            .bind(what)
            .bind(&e.asked)
            .bind(&e.conversation)
            .bind(&e.work)
            .bind(&group)
            .bind(&cards_json)
            .fetch_optional(&mut *tx)
            .await?
        }
    };
    // Checked again under the write lock: a call racing the same op_id saw no row before.
    if let Some((id, p, on_date, w, asked, conversation, work, g, c, replaced)) = same {
        // Without an op_id this is the same words found again (no correction comes this way).
        let matches = (op_id.is_none() || replaced.as_deref() == replaces)
            && p == plan_id
            && on_date == e.on && w == what && asked == e.asked && conversation == e.conversation && work == e.work && g == group && c == cards_json;
        if !matches {
            return Err(AppError::Conflict(format!("op_id {} was used for another entry; use a new op_id for a new one", op_id.unwrap_or_default())));
        }
        return Ok(Recorded { id, deck_key, deck, again: true, group, cards });
    }
    if let Some(old) = replaces {
        let gone = sqlx::query("DELETE FROM plan_history WHERE id = ? AND owner_id = ? AND plan_deck_id = ?")
            .bind(old)
            .bind(owner)
            .bind(&plan_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if gone == 0 {
            return Err(AppError::bad(format!("replaces: {deck}'s history has no entry {old}")));
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_history WHERE owner_id = ? AND plan_deck_id = ?")
        .bind(owner)
        .bind(&plan_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= ENTRIES_MAX {
        return Err(AppError::bad(format!("{deck}'s history already has {ENTRIES_MAX} entries; correct one with replaces instead of adding more")));
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO plan_history (id, owner_id, plan_deck_id, on_date, what, asked, conversation, work, group_label, cards, swap_keys, via, op_id, replaces,
           recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(owner)
    .bind(&plan_id)
    .bind(&e.on)
    .bind(what)
    .bind(&e.asked)
    .bind(&e.conversation)
    .bind(&e.work)
    .bind(&group)
    .bind(&cards_json)
    .bind(Value::from(swap_keys).to_string())
    .bind(via)
    .bind(op_id)
    .bind(replaces)
    .bind(crate::util::now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Recorded { id, deck_key, deck, again: false, group, cards })
}

/// How long a tool's own entry counts as a retry of an identical one (`record_once`).
const RETRY_WINDOW_MINUTES: i64 = 60;

/// Record an entry a tool writes itself (`track_build`) unless the plan got the same one in the
/// last hour: a retry after a lost reply has no op_id of its own and can come after midnight, so
/// it can't be found by its day. Later, the same words are a new event (tracked again after a
/// stop) and are recorded with their own day.
pub async fn record_once(pool: &SqlitePool, owner: &str, plan: PlanRef<'_>, e: &Entry, via: &str) -> AppResult<Recorded> {
    let (plan_id, deck_key, deck) = resolve(pool, owner, plan).await?;
    let since = (chrono::Utc::now() - chrono::Duration::minutes(RETRY_WINDOW_MINUTES)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let found: Option<String> = sqlx::query_scalar(
        "SELECT id FROM plan_history WHERE owner_id = ? AND plan_deck_id = ? AND what = ? AND IFNULL(asked, '') = IFNULL(?, '')
           AND IFNULL(conversation, '') = IFNULL(?, '') AND IFNULL(work, '') = IFNULL(?, '') AND group_label IS NULL AND cards = '[]'
           AND recorded_at >= ?
         ORDER BY recorded_at DESC LIMIT 1",
    )
    .bind(owner)
    .bind(&plan_id)
    .bind(e.what.trim())
    .bind(&e.asked)
    .bind(&e.conversation)
    .bind(&e.work)
    .bind(&since)
    .fetch_optional(pool)
    .await?;
    match found {
        Some(id) => Ok(Recorded { id, deck_key, deck, again: true, group: None, cards: vec![] }),
        None => record(pool, owner, PlanRef::Id(&plan_id), e, None, None, via).await,
    }
}

/// How many entries the plan's history has.
pub async fn count(pool: &SqlitePool, owner: &str, plan_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM plan_history WHERE owner_id = ? AND plan_deck_id = ?").bind(owner).bind(plan_id).fetch_one(pool).await?)
}

// ── reading ────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct EntryRow {
    id: String,
    on_date: String,
    what: String,
    asked: Option<String>,
    conversation: Option<String>,
    work: Option<String>,
    group_label: Option<String>,
    cards: String,
    swap_keys: String,
    recorded_at: String,
}

impl EntryRow {
    fn swap_keys(&self) -> Vec<String> {
        serde_json::from_str(&self.swap_keys).unwrap_or_default()
    }

    fn cards(&self) -> Vec<String> {
        serde_json::from_str(&self.cards).unwrap_or_default()
    }

    /// "2026-10-18 (recorded 2026-11-21, entry <id>): <body>".
    fn line(&self) -> String {
        format!("{} (recorded {}, entry {}): {}", self.on_date, day(&self.recorded_at), self.id, self.body())
    }

    /// What happened, what they asked, where the conversation and the work are, what it's about.
    fn body(&self) -> String {
        let mut s = self.what.trim().to_string();
        if let Some(a) = &self.asked {
            let _ = write!(s, " They asked: \"{}\"", a.trim());
        }
        if let Some(c) = &self.conversation {
            let _ = write!(s, " Conversation: {c}.");
        }
        if let Some(w) = &self.work {
            let _ = write!(s, " Work: {w}.");
        }
        let cards = self.cards();
        match (&self.group_label, cards.is_empty()) {
            (Some(g), true) => {
                let _ = write!(s, " About the group \"{g}\".");
            }
            (Some(g), false) => {
                let _ = write!(s, " About the group \"{g}\": {}.", cards.join(", "));
            }
            (None, false) => {
                let _ = write!(s, " About: {}.", cards.join(", "));
            }
            (None, true) => {}
        }
        s
    }
}

#[derive(sqlx::FromRow)]
struct SwapRow {
    ext_key: String,
    stage: String,
    role: String,
    in_name: String,
    out_name: Option<String>,
    group_label: Option<String>,
    when_text: Option<String>,
    created_at: String,
    updated_at: String,
    retired_at: Option<String>,
}

impl SwapRow {
    fn label(&self) -> String {
        match &self.out_name {
            Some(o) => format!("{} for {o}", self.in_name),
            None => format!("{} (nothing named to cut)", self.in_name),
        }
    }
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    n: i64,
    status: String,
    changes: String,
    skipped: String,
    source: String,
    decided_at: String,
}

/// A JSON list column.
fn list(s: &str) -> Vec<Value> {
    serde_json::from_str(s).unwrap_or_default()
}

/// The answer that stands for a change now: one given after it last changed.
/// A change's newest answer: decision, note, time and origin (`import`: the plan file's own).
/// The last part is the key it was saved under, so one answer reaching two rows (a retired one
/// and the live change it was renamed to) is still one answer.
type Answer = (Option<String>, Option<String>, String, String, String);

fn standing(answers: &HashMap<String, Answer>, s: &SwapRow) -> Option<String> {
    match answers.get(&s.ext_key) {
        Some((d, _, at, _, _)) if s.updated_at.as_str() <= at.as_str() => d.clone(),
        _ => None,
    }
}

/// The date part of a timestamp.
fn day(at: &str) -> &str {
    at.get(..10).unwrap_or(at)
}

fn short_sha(sha: &str) -> &str {
    sha.get(..9).unwrap_or(sha)
}

/// The owner's plan file imports: each one's meta by its id, and by the second it arrived, for
/// rows that kept only the time (a swap's or deck's first import, versions from before 21 Nov
/// 2026). Two imports in one second can't be told apart by time: that time names neither.
struct Imports {
    by_id: HashMap<String, Value>,
    by_time: HashMap<String, Option<Value>>,
}

impl Imports {
    fn at(&self, at: &str) -> Option<&Value> {
        self.by_time.get(at).and_then(Option::as_ref)
    }
}

async fn imports(pool: &SqlitePool, owner: &str) -> AppResult<Imports> {
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT id, imported_at, meta FROM plan_imports WHERE owner_id = ?").bind(owner).fetch_all(pool).await?;
    let mut out = Imports { by_id: HashMap::new(), by_time: HashMap::new() };
    for (id, at, meta) in rows {
        let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
        out.by_time.entry(at).and_modify(|m| *m = None).or_insert_with(|| Some(meta.clone()));
        out.by_id.insert(id, meta);
    }
    Ok(out)
}

/// "the commander-decks plan file, guide version 35 (commit abc123456)" from an import's meta.
fn plan_file_words(meta: &Value) -> String {
    let mut s = format!("the {} plan file", meta["app"].as_str().unwrap_or("commander-decks"));
    if let Some(v) = meta["guide_version"].as_i64() {
        let _ = write!(s, ", guide version {v}");
    }
    let mut extra = Vec::new();
    if let Some(d) = meta["guide_date"].as_str() {
        extra.push(format!("dated {d}"));
    }
    if let Some(sha) = meta["git_sha"].as_str() {
        extra.push(format!("commit {}", short_sha(sha)));
    }
    if !extra.is_empty() {
        let _ = write!(s, " ({})", extra.join(", "));
    }
    s
}

/// Where a version came from, in words.
fn source_words(source: &Value, imports: &Imports) -> String {
    match source["kind"].as_str() {
        Some("plan_file") => {
            // By the import's id when the version kept it, else by the time it arrived.
            let meta = source["import_id"]
                .as_str()
                .and_then(|id| imports.by_id.get(id))
                .or_else(|| source["imported_at"].as_str().and_then(|at| imports.at(at)))
                .cloned()
                .unwrap_or_else(|| source.clone());
            let mut s = format!("from {}", plan_file_words(&meta));
            if let Some(at) = source["imported_at"].as_str() {
                let _ = write!(s, ", imported {}", day(at));
            }
            s
        }
        Some("note") => format!(
            "from the note \"{}\" ({})",
            source["title"].as_str().unwrap_or("untitled"),
            source["note"].as_str().unwrap_or("unknown id")
        ),
        Some("before_versions") => "the plan as it stood before plans had versions".into(),
        Some("yama") => "made in Yama".into(),
        _ => "from a source Yama didn't record".into(),
    }
}

fn names_of(list: &[Value], at_most: usize) -> String {
    let mut names: Vec<String> = list
        .iter()
        .take(at_most)
        .map(|c| match (c["in"].as_str(), c["out"].as_str()) {
            (Some(i), Some(o)) => format!("{i} for {o}"),
            (Some(i), None) => i.to_string(),
            _ => c["key"].as_str().unwrap_or("?").to_string(),
        })
        .collect();
    if list.len() > at_most {
        names.push(format!("and {} more", list.len() - at_most));
    }
    names.join(", ")
}

/// The plan's whole story, or with `card` the story of each change that puts that card in or
/// takes it out. Text for assistants (`get_plan_history`).
pub async fn text(pool: &SqlitePool, owner: &str, plan: &str, card: Option<&str>) -> AppResult<String> {
    let (plan_id, key, name) = plan_of(pool, owner, plan).await?;
    #[allow(clippy::type_complexity)]
    let (source, status, created_at, archived_at, archived_note, note_id, note_deck, note_build, updated_at): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    ) = sqlx::query_as(
        "SELECT source, status, created_at, archived_at, archived_note, note_id, note_deck_key, note_build_id, updated_at FROM plan_decks
         WHERE id = ? AND owner_id = ?",
    )
    .bind(&plan_id)
    .bind(owner)
    .fetch_one(pool)
    .await?;
    let entries: Vec<EntryRow> = sqlx::query_as(
        "SELECT id, on_date, what, asked, conversation, work, group_label, cards, swap_keys, recorded_at FROM plan_history
         WHERE owner_id = ? AND plan_deck_id = ? ORDER BY on_date, recorded_at, id",
    )
    .bind(owner)
    .bind(&plan_id)
    .fetch_all(pool)
    .await?;
    let swaps: Vec<SwapRow> = sqlx::query_as(
        "SELECT ext_key, stage, role, in_name, out_name, group_label, when_text, created_at, updated_at, retired_at FROM plan_swaps
         WHERE owner_id = ? AND plan_deck_id = ? ORDER BY sort, ext_key",
    )
    .bind(owner)
    .bind(&plan_id)
    .fetch_all(pool)
    .await?;
    let versions: Vec<VersionRow> = sqlx::query_as(
        "SELECT n, status, changes, skipped, source, decided_at FROM plan_versions WHERE owner_id = ? AND plan_deck_id = ? ORDER BY n",
    )
    .bind(owner)
    .bind(&plan_id)
    .fetch_all(pool)
    .await?;
    // Each change's newest answer, followed through renamed keys as the plan's state reads them
    // (`versions::answers`): on a tie one made in Yama wins, then the larger op id.
    // Live keys only, as the state reads them: a renamed change's old row stays, retired, and an
    // answer under its key reaches the live change through the alias. A retired change keeps the
    // answers saved under its own key.
    let live_keys: std::collections::HashSet<String> = swaps.iter().filter(|s| s.retired_at.is_none()).map(|s| s.ext_key.clone()).collect();
    let retired: std::collections::HashSet<&str> = swaps.iter().filter(|s| s.retired_at.is_some()).map(|s| s.ext_key.as_str()).collect();
    let aliases = super::aliases(pool, owner).await?;
    let mut answers: HashMap<String, Answer> = HashMap::new();
    let rows: Vec<(String, Option<String>, Option<String>, String, String)> = sqlx::query_as(
        "SELECT swap_key, decision, note, at, origin FROM plan_reviews WHERE owner_id = ? ORDER BY at, origin = 'yama', IFNULL(op_id, ''), swap_key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    for (key, decision, note, at, origin) in rows {
        // A retired row keeps what was said under its own key, and the live change it was renamed
        // to inherits it too.
        if retired.contains(key.as_str()) {
            answers.insert(key.clone(), (decision.clone(), note.clone(), at.clone(), origin.clone(), key.clone()));
        }
        if let Some(k) = super::resolve_key(&key, &live_keys, &aliases) {
            answers.insert(k, (decision, note, at, origin, key));
        }
    }
    let imports = imports(pool, owner).await?;
    let archived = status == "archived" || archived_at.is_some();

    let mut out = format!(
        "History of {name}'s plan (plan key {key}{}). Entries marked \"recorded\" were written by an assistant (`record_plan_history`, \
         `track_build`) and say what the person asked and where the conversation is; the rest is Yama's own record of the plan.\n",
        if archived { ", archived" } else { "" }
    );

    if let Some(card) = card.map(str::trim).filter(|c| !c.is_empty()) {
        let exact: Vec<&SwapRow> = swaps
            .iter()
            .filter(|s| s.in_name.eq_ignore_ascii_case(card) || s.out_name.as_deref().is_some_and(|o| o.eq_ignore_ascii_case(card)))
            .collect();
        let lower = card.to_lowercase();
        let found: Vec<&SwapRow> = if exact.is_empty() {
            swaps
                .iter()
                .filter(|s| s.in_name.to_lowercase().contains(&lower) || s.out_name.as_deref().is_some_and(|o| o.to_lowercase().contains(&lower)))
                .collect()
        } else {
            exact
        };
        if found.is_empty() {
            return Err(AppError::bad(format!("No change in {name}'s plan puts in or takes out \"{card}\"")));
        }
        for s in found.iter().take(10) {
            let kind = if s.stage == "planned" { "planned swap" } else { "proposal" };
            let role = match s.role.as_str() {
                "standin" => ", a stand-in",
                "optional" => ", an optional extra",
                _ => "",
            };
            let _ = write!(out, "\n{} ({kind}{role}", s.label());
            if let Some(g) = &s.group_label {
                let _ = write!(out, ", group \"{g}\"");
            }
            if let Some(r) = &s.retired_at {
                let _ = write!(out, ", gone from the plan since {}", day(r));
            }
            out.push_str("):\n");
            let first = imports.at(&s.created_at).map(|m| format!(", from {}", plan_file_words(m))).unwrap_or_default();
            let _ = writeln!(out, "- First in Yama {}{first}; last changed {}.", day(&s.created_at), day(&s.updated_at));
            if let Some(w) = &s.when_text {
                let _ = writeln!(out, "- When (as the plan says): {}", w.trim());
            }
            // The change's keys: its own and every older one an alias brings to it.
            let own_keys: Vec<String> = sqlx::query_scalar(
                "WITH RECURSIVE keys(k) AS (SELECT ?2 UNION SELECT a.old_key FROM plan_key_aliases a JOIN keys ON a.owner_id = ?1 AND a.new_key = keys.k)
                 SELECT k FROM keys",
            )
            .bind(owner)
            .bind(&s.ext_key)
            .fetch_all(pool)
            .await?;
            for v in &versions {
                let has = |l: Vec<Value>| l.into_iter().find(|c| c["key"].as_str().is_some_and(|k| own_keys.iter().any(|o| o == k)));
                if v.status == "approved" && has(list(&v.changes)).is_some() {
                    let _ = writeln!(out, "- Version {} ({}) took it in, {}.", v.n, day(&v.decided_at), source_words(&serde_json::from_str(&v.source).unwrap_or(Value::Null), &imports));
                } else if let Some(c) = has(list(&v.skipped)) {
                    let why = c["left_out"].as_str().map(|w| format!(": {w}")).unwrap_or_else(|| ".".into());
                    let _ = writeln!(out, "- Version {} ({}) left it out{why}", v.n, day(&v.decided_at));
                }
            }
            // Its answers, oldest first, as they arrived (under this key or an older one).
            let trail: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
                "SELECT i.op_id, i.device_id, i.payload, i.client_at FROM plan_inputs i
                 WHERE i.owner_id = ? AND i.kind = 'review' AND i.status = 'applied' AND i.swap_key IN (SELECT value FROM json_each(?))
                 ORDER BY i.client_at, i.seq",
            )
            .bind(owner)
            .bind(Value::from(own_keys.clone()).to_string())
            .fetch_all(pool)
            .await?;
            let current = answers.get(&s.ext_key);
            if trail.is_empty() {
                match current {
                    Some((Some(d), note, at, origin, _)) => {
                        let note = note.as_deref().map(|n| format!(", note \"{n}\"")).unwrap_or_default();
                        let whose = if origin == "import" { "The plan file's answer" } else { "Their answer" };
                        let _ = writeln!(out, "- {whose}: {d}{note} ({}).", day(at));
                    }
                    _ if s.stage == "proposed" => out.push_str("- No answer yet.\n"),
                    _ => {}
                }
            } else {
                let mut said: Vec<String> = trail
                    .iter()
                    .map(|(op, device, payload, at)| {
                        let p: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
                        let decision = p["decision"].as_str().unwrap_or("cleared");
                        let note = p["note"].as_str().filter(|n| !n.trim().is_empty()).map(|n| format!(" \"{n}\"")).unwrap_or_default();
                        let who = if op.starts_with(super::versions::SETTLE_OP) {
                            "Yama, taking a version in"
                        } else if device.as_deref() == Some("claude") {
                            "through an assistant"
                        } else {
                            "in Yama"
                        };
                        format!("{} {decision}{note} ({who})", day(at))
                    })
                    .collect();
                // A plan file's own answer (its review site's) is written straight to the answers,
                // never as an op: when it's the one that stands, it comes last.
                if let Some((d, note, at, origin, _)) = current
                    && origin == "import"
                {
                    let note = note.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(" \"{n}\"")).unwrap_or_default();
                    said.push(format!("{} {}{note} (from the plan file)", day(at), d.as_deref().unwrap_or("cleared")));
                }
                let _ = writeln!(out, "- Answers, oldest first: {}.", said.join("; "));
            }
            let about: Vec<&EntryRow> = entries
                .iter()
                .filter(|e| {
                    // A card recorded is the one a change puts in or the one it takes out; the change's
                    // key (or an older one) finds it after a plan file renames its cards.
                    let names = |c: &String| c.eq_ignore_ascii_case(&s.in_name) || s.out_name.as_deref().is_some_and(|o| c.eq_ignore_ascii_case(o));
                    e.swap_keys().iter().any(|k| own_keys.contains(k))
                        || e.cards().iter().any(names)
                        || (e.group_label.is_some() && e.group_label == s.group_label && e.cards().is_empty())
                })
                .collect();
            if about.is_empty() {
                let whose = if s.group_label.is_some() { "this change or its group" } else { "this change" };
                let _ = writeln!(out, "- Nobody has recorded where {whose} came from.");
            }
            for e in about {
                let _ = writeln!(out, "- Recorded {}", e.line());
            }
        }
        if found.len() > 10 {
            let _ = writeln!(out, "\nAnd {} more changes name \"{card}\"; give the exact card name.", found.len() - 10);
        }
        return Ok(out);
    }

    // Where it came from.
    out.push_str("\nWhere it came from: ");
    match (&note_id, source.as_str()) {
        (Some(n), _) => {
            let title: Option<String> = sqlx::query_scalar("SELECT title FROM research_reports WHERE owner_id = ? AND id = ?").bind(owner).bind(n).fetch_optional(pool).await?;
            let _ = write!(
                out,
                "build {} of deck {} in the note \"{}\" ({n}).",
                note_build.as_deref().unwrap_or("?"),
                note_deck.as_deref().unwrap_or("?"),
                title.as_deref().unwrap_or("untitled")
            );
        }
        (None, "import") => {
            let first = imports.at(&created_at).map(plan_file_words).unwrap_or_else(|| "a plan file".into());
            let _ = write!(out, "{first}, first imported {}.", day(&created_at));
        }
        _ => {
            let _ = write!(out, "made in Yama on {}.", day(&created_at));
        }
    }
    // Other plans for the same deck (one replaced another, or a note's took over a plan file's):
    // their history is under their own keys.
    let others: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT key, status, archived_at, archived_note FROM plan_decks WHERE owner_id = ? AND lower(name) = lower(?) AND id != ? ORDER BY created_at, key",
    )
    .bind(owner)
    .bind(&name)
    .bind(&plan_id)
    .fetch_all(pool)
    .await?;
    if !others.is_empty() {
        let said: Vec<String> = others
            .iter()
            .map(|(k, status, at, note)| match (status.as_str(), at, note) {
                (_, Some(_), Some(n)) | ("archived", _, Some(n)) => format!("{k} ({n})"),
                ("archived", _, None) | (_, Some(_), None) => format!("{k} (archived)"),
                _ => k.clone(),
            })
            .collect();
        let _ = write!(out, " Other plans for {name}, with their own history: {}.", said.join(", "));
    }
    let plan_level: Vec<&EntryRow> = entries.iter().filter(|e| e.group_label.is_none() && e.cards().is_empty()).collect();
    match plan_level.first() {
        Some(e) => {
            let _ = write!(out, " The request behind it: {}", e.line());
        }
        None => out.push_str(
            " Nobody has recorded the request behind it. If you know it (from them, the conversation or the plan's source repository), \
             record it with `record_plan_history`.",
        ),
    }
    out.push('\n');

    // Its groups of proposals, each with what's recorded about it.
    let labels = group_labels(pool, owner, &plan_id).await?;
    let live: Vec<&SwapRow> = swaps.iter().filter(|s| s.retired_at.is_none()).collect();
    if !labels.is_empty() {
        out.push_str("\nGroups of proposals:\n");
        let declared: String = sqlx::query_scalar("SELECT groups FROM plan_decks WHERE id = ? AND owner_id = ?").bind(&plan_id).bind(owner).fetch_one(pool).await?;
        let notes: HashMap<String, String> = list(&declared)
            .iter()
            .filter_map(|g| Some((g["label"].as_str()?.to_string(), g["note"].as_str()?.to_string())))
            .collect();
        for l in &labels {
            let in_group: Vec<&SwapRow> = live.iter().copied().filter(|s| s.group_label.as_deref() == Some(l.as_str())).collect();
            let wanted = in_group.iter().filter(|s| s.stage == "planned" || standing(&answers, s).as_deref() == Some("want")).count();
            let out_n = in_group.iter().filter(|s| s.stage != "planned" && matches!(standing(&answers, s).as_deref(), Some("no" | "unsure"))).count();
            let open = in_group.len() - wanted - out_n;
            let _ = write!(out, "- {l}: {} change{}, {wanted} in the plan, {out_n} left out", in_group.len(), if in_group.len() == 1 { "" } else { "s" });
            if open > 0 {
                let _ = write!(out, ", {open} not taken in yet");
            }
            if let Some(n) = notes.get(l) {
                let _ = write!(out, ". Its note: {}", n.trim());
            }
            let recorded = entries.iter().filter(|e| e.group_label.as_deref() == Some(l.as_str())).count();
            match recorded {
                0 => out.push_str(". Nobody has recorded where it came from.\n"),
                n => {
                    let _ = writeln!(out, ". {n} recorded entr{} below.", if n == 1 { "y" } else { "ies" });
                }
            }
        }
        let ungrouped = live.iter().filter(|s| s.group_label.is_none()).count();
        if ungrouped > 0 {
            let _ = writeln!(out, "- No group: {ungrouped} change{}.", if ungrouped == 1 { "" } else { "s" });
        }
    }

    // The timeline: Yama's own record and the recorded entries, by date.
    let mut events: Vec<(String, u8, String)> = Vec::new();
    let came = match (&note_id, source.as_str()) {
        (Some(_), _) => "The plan was made from a note's build.".to_string(),
        (None, "import") => format!("The plan came into Yama from {}.", imports.at(&created_at).map(plan_file_words).unwrap_or_else(|| "a plan file".into())),
        _ => "The plan was made in Yama.".to_string(),
    };
    events.push((day(&created_at).to_string(), 0, came));
    // The newest 20 versions: a plan saved again and again would otherwise fill the answer.
    const VERSIONS_SHOWN: usize = 20;
    let older = versions.len().saturating_sub(VERSIONS_SHOWN);
    if older > 0 {
        events.push((String::new(), 0, format!("{older} earlier versions aren't listed here; call again with card for one change's.")));
    }
    for v in versions.iter().skip(older) {
        let changes = list(&v.changes);
        let skipped = list(&v.skipped);
        let src: Value = serde_json::from_str(&v.source).unwrap_or(Value::Null);
        let source = source_words(&src, &imports);
        let mut s = if v.status == "kept" {
            format!("Version {}: the version before was kept ({source}).", v.n)
        } else if src["kind"] == "before_versions" {
            format!("Version {}: {source}, {} change{}.", v.n, changes.len(), if changes.len() == 1 { "" } else { "s" })
        } else {
            format!("Version {} went in, {source}: {} change{} ({}).", v.n, changes.len(), if changes.len() == 1 { "" } else { "s" }, names_of(&changes, 12))
        };
        if !skipped.is_empty() {
            let left: Vec<String> = skipped
                .iter()
                .take(12)
                .map(|c| {
                    let what = names_of(std::slice::from_ref(c), 1);
                    // `left_out` is why it was left out; `why` is the change's own reason.
                    match c["left_out"].as_str() {
                        Some(w) => format!("{what} ({})", w.trim_end_matches('.')),
                        None => what,
                    }
                })
                .collect();
            let _ = write!(s, " Left out: {}{}.", left.join("; "), if skipped.len() > 12 { format!("; and {} more", skipped.len() - 12) } else { String::new() });
        }
        events.push((day(&v.decided_at).to_string(), 1, s));
    }
    // Recorded entries, the newest 40 and each cut to 500 characters, so a busy plan's timeline
    // stays readable; one change's story (`card`) gives what's recorded about it in full.
    const ENTRIES_SHOWN: usize = 40;
    const ENTRY_CHARS: usize = 500;
    let skipped = entries.len().saturating_sub(ENTRIES_SHOWN);
    let mut by_recency: Vec<&EntryRow> = entries.iter().collect();
    by_recency.sort_by(|a, b| (b.on_date.as_str(), b.recorded_at.as_str()).cmp(&(a.on_date.as_str(), a.recorded_at.as_str())));
    for e in by_recency.into_iter().take(ENTRIES_SHOWN) {
        let body = e.body();
        let body = if body.chars().count() > ENTRY_CHARS { format!("{}…", body.chars().take(ENTRY_CHARS).collect::<String>()) } else { body };
        events.push((e.on_date.clone(), 2, format!("Recorded (entry {}, recorded {}): {body}", e.id, day(&e.recorded_at))));
    }
    if skipped > 0 {
        events.push((String::new(), 0, format!("{skipped} older recorded entries aren't listed here; call again with card for what's recorded about one change.")));
    }
    // Answers as they arrived, by people (Yama's own, taking a version in, are the versions
    // above), and the plan file's own answer where it stands: each with the change it's on.
    let label_of: HashMap<&str, String> = swaps.iter().map(|s| (s.ext_key.as_str(), s.label())).collect();
    let ops: Vec<(Option<String>, String, String, String)> = sqlx::query_as(
        "SELECT device_id, swap_key, payload, client_at FROM plan_inputs
         WHERE owner_id = ? AND kind = 'review' AND status = 'applied' AND substr(op_id, 1, 8) != '!settle-' ORDER BY client_at, seq",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut said: Vec<(String, String)> = Vec::new();
    for (device, key, payload, at) in ops {
        let change = match label_of.get(key.as_str()) {
            Some(l) => l.clone(),
            None => match super::resolve_key(&key, &live_keys, &aliases).and_then(|k| label_of.get(k.as_str()).cloned()) {
                Some(l) => l,
                None => continue,
            },
        };
        let p: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let note = p["note"].as_str().filter(|n| !n.trim().is_empty()).map(|n| format!(": \"{n}\"")).unwrap_or_default();
        let who = if device.as_deref() == Some("claude") { "through an assistant" } else { "in Yama" };
        let what = match p["decision"].as_str() {
            Some(d) => format!("Answered {d} on {change}{note} ({who})."),
            None => format!("Cleared the answer on {change} ({who})."),
        };
        said.push((day(&at).to_string(), what));
    }
    let mut told: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for s in &swaps {
        // Each plan file answer once, on the live change when it reaches one.
        if let Some((d, note, at, origin, from)) = answers.get(&s.ext_key)
            && origin == "import"
            && (s.retired_at.is_none() || !answers.iter().any(|(k, a)| a.4 == *from && k != &s.ext_key && live_keys.contains(k)))
            && told.insert(from.as_str())
        {
            let note = note.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(" \"{n}\"")).unwrap_or_default();
            said.push((day(at).to_string(), format!("The plan file's answer on {}: {}{note}.", s.label(), d.as_deref().unwrap_or("cleared"))));
        }
    }
    said.sort_by(|a, b| a.0.cmp(&b.0));
    const ANSWERS_SHOWN: usize = 60;
    let more = said.len().saturating_sub(ANSWERS_SHOWN);
    // The newest ones, when there are many.
    for (on, what) in said.into_iter().skip(more) {
        events.push((on, 2, what));
    }
    if more > 0 {
        events.push((String::new(), 0, format!("{more} earlier answers aren't listed here; call again with card for one change's.")));
    }
    // Archive and Bring it back pressed on the plan's page, each time (plan ops); the archive in
    // force now, when no press explains it. Ops name the plan by its key, which can pass to
    // another plan (an import taking a moved note plan's key): only presses since this plan was
    // made are its own.
    let presses: Vec<(String, String)> = sqlx::query_as(
        "SELECT payload, client_at FROM plan_inputs WHERE owner_id = ? AND kind = 'plan' AND status = 'applied' AND deck_key = ? AND client_at >= ?
         ORDER BY client_at, seq",
    )
    .bind(owner)
    .bind(&key)
    .bind(&created_at)
    .fetch_all(pool)
    .await?;
    let mut pressed = false;
    for (payload, at) in presses {
        let p: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        match p["action"].as_str() {
            Some("archive") => {
                pressed = true;
                events.push((day(&at).to_string(), 3, "Archived in Yama.".into()));
            }
            Some("restore") => events.push((day(&at).to_string(), 3, "Brought back in Yama.".into())),
            _ => {}
        }
    }
    if let Some(at) = &archived_at {
        if !pressed || archived_note.as_deref() != Some("Archived by you") {
            events.push((day(at).to_string(), 3, format!("Archived{}.", archived_note.as_deref().map(|n| format!(": {n}")).unwrap_or_default())));
        }
    } else if status == "archived" {
        // Archived by its status alone, which nothing dates: a note's build stopped being tracked
        // or the note dropped it, or the plan file dropped it or marked it archived. The day is
        // when the plan last changed.
        let why = if note_id.is_some() { "its note's build stopped being tracked, or the note no longer has it" } else { "by its plan file" };
        events.push((day(&updated_at).to_string(), 3, format!("Archived: {why} (the day the plan last changed).")));
    }
    events.sort_by(|a, b| (a.0.as_str(), a.1).cmp(&(b.0.as_str(), b.1)));
    out.push_str("\nTimeline, oldest first:\n");
    for (on, _, what) in &events {
        if on.is_empty() {
            let _ = writeln!(out, "- {what}");
        } else {
            let _ = writeln!(out, "- {on}: {what}");
        }
    }
    let unanswered = live.iter().filter(|s| s.stage == "proposed" && standing(&answers, s).is_none()).count();
    if unanswered > 0 {
        let _ = writeln!(out, "\n{unanswered} proposal{} not taken in yet.", if unanswered == 1 { " is" } else { "s are" });
    }
    out.push_str("\nFor one change's story (its group, when it arrived, which version took it in, every answer), call again with card.\n");
    Ok(out)
}
