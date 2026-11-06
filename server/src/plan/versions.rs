//! One plan per deck, approved as a whole (Bryan, 2026-11-06, the plans redesign; ARCHITECTURE.md,
//! "Plans: one plan per deck"; migration 0068).
//!
//! A deck's plan is in one state:
//!
//! - **waiting**: waiting for your OK. Its changes are proposals (`plan_swaps.stage = 'proposed'`)
//!   and the deck has no approved version. Nothing in it is on a shopping list or a print order.
//! - **in_progress**: approved (a version, or planned swaps from before versions), with changes
//!   still to go in. It can also have a **next** version waiting for your OK: proposals that
//!   arrived since, nobody has answered yet. Until you approve it, the version before keeps going.
//! - **done**: approved, every change in the deck, nothing waiting.
//! - **archived**: the plan file archived the deck, or you did ("Not now"), or approving another
//!   plan for the same deck replaced it.
//! - **empty**: no changes at all yet ("No plan yet" on the Plans page).
//!
//! The changes in a plan are its planned swaps plus the proposals you approved. Approving writes
//! the answers Review always wrote (`plan_reviews`: "want" for each change you kept, "no" for each
//! one you skipped), so the shopping list, prints and the export side read them unchanged. For a
//! deck from a plan file, each answer is also an op in the export side's inbox, as a Review tap
//! was, and the plan op itself says which version you approved and how you answered its questions.
//!
//! The state is computed here, once, for the bundle and for the MCP tools.

use super::installed::Installs;
use crate::error::AppResult;
use crate::util::new_id;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::{BTreeSet, HashMap, HashSet};

/// The changes waiting for your OK: a deck's first version, or the next one.
#[derive(Debug, Clone, Serialize)]
pub struct Next {
    /// The version number it becomes when you approve it.
    pub n: i64,
    /// Every change in it, in plan order (keys of live proposals).
    pub keys: Vec<String>,
    /// Changes in it you already said no to (in Review, before plans were approved whole): they
    /// start skipped.
    pub skipped: Vec<String>,
    /// When its first change arrived.
    pub proposed_at: Option<String>,
    /// Where it came from: `{kind: "plan_file", app, guide_version, imported_at}` or
    /// `{kind: "note", note, title}` or `{kind: "yama"}`.
    pub source: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeckPlan {
    /// waiting | in_progress | done | archived | empty
    pub state: &'static str,
    /// The approved version in force; null before the first approval.
    pub version: Option<i64>,
    pub approved_at: Option<String>,
    /// Waiting for your OK: the first version (state waiting) or a new one (state in_progress).
    pub next: Option<Next>,
    /// Changes in the plan in force (swaps, not stand-ins or optional extras) and how many are in the deck.
    pub changes: usize,
    pub installed: usize,
    /// The deck's open questions: each needs an answer before you approve.
    pub questions: Vec<String>,
    /// You archived it in Yama (or another plan for the deck replaced it), and why.
    pub archived_at: Option<String>,
    pub archived_note: Option<String>,
}

/// One decided version, for Archived ("Earlier versions") and a plan's history.
#[derive(Debug, Clone, Serialize)]
pub struct Version {
    pub deck: String,
    pub deck_name: String,
    pub n: i64,
    /// approved | kept (you kept the version before it)
    pub status: String,
    pub changes: Value,
    pub skipped: Value,
    pub answers: Value,
    pub source: Value,
    pub proposed_at: Option<String>,
    pub decided_at: String,
    pub superseded_at: Option<String>,
}

#[derive(Default)]
pub struct Plans {
    /// By plan deck id.
    pub decks: HashMap<String, DeckPlan>,
    /// Newest first.
    pub versions: Vec<Version>,
}

#[derive(sqlx::FromRow)]
struct DeckRow {
    id: String,
    key: String,
    name: String,
    source: String,
    status: String,
    notes: String,
    note_id: Option<String>,
    import_id: Option<String>,
    archived_at: Option<String>,
    archived_note: Option<String>,
}

#[derive(sqlx::FromRow)]
struct SwapRow {
    key: String,
    plan_deck_id: String,
    stage: String,
    role: String,
    src: String,
    in_name: String,
    out_name: Option<String>,
    why: Option<String>,
    upgrade: Option<String>,
    import_id: Option<String>,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    plan_deck_id: String,
    deck_key: Option<String>,
    deck_name: String,
    n: i64,
    status: String,
    changes: String,
    skipped: String,
    answers: String,
    source: String,
    proposed_at: Option<String>,
    decided_at: String,
    superseded_at: Option<String>,
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The newest decision per live swap key, aliases followed: `want`, `unsure`, `no` or none.
async fn decisions(conn: &mut SqliteConnection, owner: &str, live: &HashSet<String>) -> AppResult<HashMap<String, Option<String>>> {
    let aliases = super::aliases(&mut *conn, owner).await?;
    let rows: Vec<(String, Option<String>, String)> =
        sqlx::query_as("SELECT swap_key, decision, at FROM plan_reviews WHERE owner_id = ? ORDER BY at, swap_key").bind(owner).fetch_all(&mut *conn).await?;
    let mut out: HashMap<String, (String, Option<String>)> = HashMap::new();
    for (key, decision, at) in rows {
        let Some(live_key) = super::resolve_key(&key, live, &aliases) else { continue };
        // The answer under the live key itself wins over one that reached it through an alias.
        let direct = key == live_key;
        match out.get(&live_key) {
            Some((old_at, _)) if !direct && old_at.as_str() >= at.as_str() => {}
            _ => {
                out.insert(live_key, (at, decision));
            }
        }
    }
    Ok(out.into_iter().map(|(k, (_, d))| (k, d)).collect())
}

/// Every plan deck's state and every decided version, for one owner.
pub async fn load(conn: &mut SqliteConnection, owner: &str, installs: Option<&Installs>) -> AppResult<Plans> {
    let decks: Vec<DeckRow> = sqlx::query_as(
        "SELECT id, key, name, source, status, notes, note_id, import_id, archived_at, archived_note FROM plan_decks WHERE owner_id = ?",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let swaps: Vec<SwapRow> = sqlx::query_as(
        "SELECT ext_key AS key, plan_deck_id, stage, role, src, in_name, out_name, why, upgrade, import_id, created_at
         FROM plan_swaps WHERE owner_id = ? AND retired_at IS NULL ORDER BY sort, ext_key",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let live: HashSet<String> = swaps.iter().map(|s| s.key.clone()).collect();
    let answers = decisions(&mut *conn, owner, &live).await?;
    let marks: HashMap<String, bool> = sqlx::query_as::<_, (String, i64)>("SELECT swap_key, value FROM plan_marks WHERE owner_id = ? AND kind = 'installed'")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(|(k, v)| (k, v == 1))
        .collect();
    let version_rows: Vec<VersionRow> = sqlx::query_as(
        "SELECT v.plan_deck_id, d.key AS deck_key, v.deck_name, v.n, v.status, v.changes, v.skipped, v.answers, v.source, v.proposed_at,
                v.decided_at, v.superseded_at
         FROM plan_versions v LEFT JOIN plan_decks d ON d.id = v.plan_deck_id AND d.owner_id = v.owner_id
         WHERE v.owner_id = ? ORDER BY v.decided_at DESC, v.n DESC",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let imports: HashMap<String, Value> = sqlx::query_as::<_, (String, String, String)>("SELECT id, imported_at, meta FROM plan_imports WHERE owner_id = ?")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(|(id, at, meta)| {
            let m = parse(&meta);
            (id, json!({"kind": "plan_file", "app": m.get("app"), "guide_version": m.get("guide_version"), "imported_at": at}))
        })
        .collect();
    let notes: HashMap<String, String> = sqlx::query_as::<_, (String, String)>("SELECT id, title FROM research_reports WHERE owner_id = ?")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();

    // Version numbers count per deck name, so a note's build taking over a plan file's deck goes on
    // from the plan file's number.
    let mut top_by_name: HashMap<String, i64> = HashMap::new();
    let name_of: HashMap<&str, &str> = decks.iter().map(|d| (d.id.as_str(), d.name.as_str())).collect();
    for v in &version_rows {
        let name = name_of.get(v.plan_deck_id.as_str()).copied().unwrap_or(v.deck_name.as_str());
        let e = top_by_name.entry(name_key(name)).or_insert(0);
        *e = (*e).max(v.n);
    }

    let mut out = Plans::default();
    for d in &decks {
        let mine: Vec<&SwapRow> = swaps.iter().filter(|s| s.plan_deck_id == d.id).collect();
        let approved: Vec<&VersionRow> = version_rows.iter().filter(|v| v.plan_deck_id == d.id && v.status == "approved").collect();
        let planned = mine.iter().any(|s| s.stage == "planned" && s.role != "standin");
        // A deck from a plan file that already has planned swaps was approved there: version 1.
        let implicit = approved.is_empty() && planned;
        let has_version = !approved.is_empty() || implicit;
        let current = approved.iter().max_by_key(|v| v.n);
        let version = current.map(|v| v.n).or(implicit.then_some(1));
        let decision = |k: &str| answers.get(k).cloned().flatten();
        let proposals: Vec<&&SwapRow> = mine.iter().filter(|s| s.stage == "proposed").collect();
        let (keys, skipped): (Vec<String>, Vec<String>) = if has_version {
            // A new version: proposals nobody has answered (or answered "unsure").
            (proposals.iter().filter(|s| matches!(decision(&s.key).as_deref(), None | Some("unsure"))).map(|s| s.key.clone()).collect(), vec![])
        } else {
            // The first version: every proposal, the ones you said no to already skipped.
            (
                proposals.iter().map(|s| s.key.clone()).collect(),
                proposals.iter().filter(|s| decision(&s.key).as_deref() == Some("no")).map(|s| s.key.clone()).collect(),
            )
        };
        let top = top_by_name.get(&name_key(&d.name)).copied().unwrap_or(0).max(version.unwrap_or(0));
        let next = (!keys.is_empty()).then(|| {
            let first: Vec<&&&SwapRow> = proposals.iter().filter(|s| keys.contains(&s.key)).collect();
            let proposed_at = first.iter().map(|s| s.created_at.clone()).min();
            let import = first.iter().filter_map(|s| s.import_id.as_deref()).next().or(d.import_id.as_deref());
            let source = match (&d.note_id, d.source.as_str()) {
                (Some(id), _) => json!({"kind": "note", "note": id, "title": notes.get(id)}),
                (None, "import") => import.and_then(|i| imports.get(i)).cloned().unwrap_or(json!({"kind": "plan_file"})),
                _ => json!({"kind": "yama"}),
            };
            Next { n: top + 1, keys: keys.clone(), skipped, proposed_at, source }
        });
        // The plan in force: planned swaps and approved proposals.
        let in_plan: Vec<&&SwapRow> = mine
            .iter()
            .filter(|s| s.role == "swap" && (s.stage == "planned" || (has_version && decision(&s.key).as_deref() == Some("want"))))
            .collect();
        let installed = in_plan
            .iter()
            .filter(|s| {
                if let Some(on) = installs.and_then(|i| i.swaps.get(&s.key)) {
                    return *on;
                }
                if let Some(on) = marks.get(&s.key) {
                    return *on;
                }
                s.upgrade.as_deref().map(parse).and_then(|u| u.get("status").and_then(Value::as_str).map(|x| x == "installed")).unwrap_or(false)
            })
            .count();
        let archived = d.status == "archived" || d.archived_at.is_some();
        let state = if archived {
            "archived"
        } else if has_version {
            if next.is_none() && !in_plan.is_empty() && installed == in_plan.len() { "done" } else { "in_progress" }
        } else if next.is_some() {
            "waiting"
        } else {
            "empty"
        };
        let questions = parse(&d.notes)
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n.get("kind").and_then(Value::as_str) == Some("open_question"))
            .filter_map(|n| n.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        out.decks.insert(
            d.id.clone(),
            DeckPlan {
                state,
                version,
                approved_at: current.map(|v| v.decided_at.clone()),
                next,
                changes: in_plan.len(),
                installed,
                questions,
                archived_at: d.archived_at.clone(),
                archived_note: d.archived_note.clone(),
            },
        );
    }
    out.versions = version_rows
        .into_iter()
        .map(|v| Version {
            deck: v.deck_key.unwrap_or_default(),
            deck_name: v.deck_name,
            n: v.n,
            status: v.status,
            changes: parse(&v.changes),
            skipped: parse(&v.skipped),
            answers: parse(&v.answers),
            source: parse(&v.source),
            proposed_at: v.proposed_at,
            decided_at: v.decided_at,
            superseded_at: v.superseded_at,
        })
        .collect();
    Ok(out)
}

// ── the plan op ────────────────────────────────────────────────────────────

/// A checked `plan` op (inputs.rs parses it): what to do to one deck's plan.
#[derive(Debug, Clone)]
pub struct PlanOp {
    pub action: String,
    pub version: Option<i64>,
    pub keys: Vec<String>,
    pub skip: Vec<String>,
    /// (question, answer)
    pub answers: Vec<(String, String)>,
}

pub const ACTIONS: [&str; 5] = ["approve", "keep", "undo", "archive", "restore"];

/// One answer this op writes, for the export side's inbox too.
struct Write {
    key: String,
    decision: Option<String>,
    note: Option<String>,
    cut: Option<String>,
}

#[derive(sqlx::FromRow, Serialize, serde::Deserialize, Clone)]
struct Prior {
    decision: Option<String>,
    note: Option<String>,
    cut: Option<String>,
    at: String,
    origin: String,
    op_id: Option<String>,
}

async fn prior(conn: &mut SqliteConnection, owner: &str, key: &str) -> AppResult<Option<Prior>> {
    Ok(sqlx::query_as("SELECT decision, note, cut, at, origin, op_id FROM plan_reviews WHERE owner_id = ? AND swap_key = ?")
        .bind(owner)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?)
}

/// Write the answers and, for a deck from a plan file, put each in the export side's inbox as a
/// review op (`<plan op id>/<n>`), as a Review tap would. The approval is the newest word on each
/// change, so it replaces whatever answer was there.
#[allow(clippy::too_many_arguments)]
async fn write_answers(
    conn: &mut SqliteConnection,
    owner: &str,
    deck_key: &str,
    deck_name: &str,
    for_export: bool,
    writes: &[Write],
    cards: &HashMap<String, String>,
    op_id: &str,
    at: &str,
    received_at: &str,
) -> AppResult<()> {
    for (i, w) in writes.iter().enumerate() {
        let sub = format!("{op_id}/{}", i + 1);
        sqlx::query(
            "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, deck_name, card, at, origin, op_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yama', ?)
             ON CONFLICT(owner_id, swap_key) DO UPDATE SET decision = excluded.decision, note = excluded.note, cut = excluded.cut,
               deck_name = excluded.deck_name, card = COALESCE(excluded.card, plan_reviews.card), at = excluded.at, origin = 'yama',
               op_id = excluded.op_id",
        )
        .bind(owner)
        .bind(&w.key)
        .bind(&w.decision)
        .bind(&w.note)
        .bind(&w.cut)
        .bind(deck_name)
        .bind(cards.get(&w.key))
        .bind(at)
        .bind(&sub)
        .execute(&mut *conn)
        .await?;
        let payload = json!({"op_id": sub, "kind": "review", "swap_key": w.key, "deck_key": deck_key, "decision": w.decision,
                             "note": w.note, "cut": w.cut, "at": at, "from_plan_op": op_id});
        sqlx::query(
            "INSERT INTO plan_inputs (owner_id, op_id, device_id, kind, swap_key, deck_key, payload, status, error, for_export, client_at, received_at)
             VALUES (?, ?, NULL, 'review', ?, ?, ?, 'applied', NULL, ?, ?, ?)",
        )
        .bind(owner)
        .bind(&sub)
        .bind(&w.key)
        .bind(deck_key)
        .bind(payload.to_string())
        .bind(for_export)
        .bind(at)
        .bind(received_at)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Apply a plan op to `deck_key`. `Ok(Err(..))` rejects it with a reason the page can show.
/// Returns whether the export side should see it.
pub async fn apply(conn: &mut SqliteConnection, owner: &str, deck_key: &str, op: &PlanOp, op_id: &str, at: &str, received_at: &str) -> AppResult<Result<bool, String>> {
    let row: Option<(String, String, String, String, Option<String>)> =
        sqlx::query_as("SELECT id, name, source, status, archived_at FROM plan_decks WHERE owner_id = ? AND key = ?")
            .bind(owner)
            .bind(deck_key)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((plan_id, name, source, status, archived_at)) = row else {
        return Ok(Err(format!("deck_key: there's no plan \"{deck_key}\"")));
    };
    let for_export = source != "yama";
    let plans = load(&mut *conn, owner, None).await?;
    let Some(plan) = plans.decks.get(&plan_id).cloned() else { return Ok(Err("deck_key: that plan isn't there".into())) };
    let swaps: Vec<(String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT ext_key, in_name, out_name, src, why FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ? AND retired_at IS NULL ORDER BY sort, ext_key",
    )
    .bind(owner)
    .bind(&plan_id)
    .fetch_all(&mut *conn)
    .await?;
    let cards: HashMap<String, String> = swaps.iter().map(|(k, i, ..)| (k.clone(), i.clone())).collect();
    let change = |k: &str| {
        swaps.iter().find(|s| s.0 == k).map(|(k, i, o, src, why)| json!({"key": k, "in": i, "out": o, "src": src, "why": why})).unwrap_or(json!({"key": k}))
    };
    match op.action.as_str() {
        "archive" | "restore" => {
            if op.action == "restore" && status == "archived" {
                return Ok(Err("Your plan file archived this deck; it comes back when the plan file has it again.".into()));
            }
            let (when, note) = if op.action == "archive" { (Some(at), Some("Archived by you")) } else { (None, None) };
            if (op.action == "archive") != archived_at.is_some() {
                sqlx::query("UPDATE plan_decks SET archived_at = ?, archived_note = ? WHERE id = ? AND owner_id = ?")
                    .bind(when)
                    .bind(note)
                    .bind(&plan_id)
                    .bind(owner)
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(Ok(for_export))
        }
        "approve" | "keep" => {
            if plan.state == "archived" {
                return Ok(Err("This plan is archived. Bring it back first.".into()));
            }
            let Some(next) = plan.next.clone() else { return Ok(Err("Nothing in this plan is waiting for your OK.".into())) };
            if op.version != Some(next.n) {
                return Ok(Err(format!("The plan changed since you opened it: version {} is waiting now. Reload it and look again.", next.n)));
            }
            if op.action == "keep" && plan.version.is_none() {
                return Ok(Err("There's no earlier version to keep. Archive the plan instead.".into()));
            }
            let sent: BTreeSet<&String> = op.keys.iter().chain(op.skip.iter()).collect();
            let want: BTreeSet<&String> = next.keys.iter().collect();
            if op.keys.iter().any(|k| op.skip.contains(k)) {
                return Ok(Err("A change can't be both kept and skipped.".into()));
            }
            if op.action == "approve" && sent != want {
                return Ok(Err("The plan's changes changed since you opened it. Reload it and look again.".into()));
            }
            if op.action == "approve" {
                if op.keys.is_empty() {
                    return Ok(Err("Every change is skipped. Archive the plan instead, or keep at least one change.".into()));
                }
                for q in &plan.questions {
                    if !op.answers.iter().any(|(qq, a)| qq == q && !a.trim().is_empty()) {
                        return Ok(Err(format!("Answer this question first: {q}")));
                    }
                }
            }
            // Answers before, for Undo.
            let mut before = serde_json::Map::new();
            let mut writes = Vec::new();
            for k in &next.keys {
                let p = prior(&mut *conn, owner, k).await?;
                let (note, cut) = p.as_ref().map(|p| (p.note.clone(), p.cut.clone())).unwrap_or_default();
                let decision = if op.action == "approve" && op.keys.contains(k) { "want" } else { "no" };
                before.insert(k.clone(), serde_json::to_value(&p).unwrap_or(Value::Null));
                writes.push(Write { key: k.clone(), decision: Some(decision.into()), note, cut });
            }
            write_answers(&mut *conn, owner, deck_key, &name, for_export, &writes, &cards, op_id, at, received_at).await?;
            // Approving a plan replaces every other live plan for the same deck.
            let mut replaced: Vec<String> = Vec::new();
            if op.action == "approve" {
                let others: Vec<String> = sqlx::query_scalar(
                    "SELECT id FROM plan_decks WHERE owner_id = ? AND id != ? AND lower(trim(name)) = ? AND status != 'archived' AND archived_at IS NULL",
                )
                .bind(owner)
                .bind(&plan_id)
                .bind(name_key(&name))
                .fetch_all(&mut *conn)
                .await?;
                for o in others {
                    sqlx::query("UPDATE plan_decks SET archived_at = ?, archived_note = ? WHERE id = ? AND owner_id = ?")
                        .bind(at)
                        .bind(format!("Replaced by version {}", next.n))
                        .bind(&o)
                        .bind(owner)
                        .execute(&mut *conn)
                        .await?;
                    replaced.push(o);
                }
                sqlx::query(
                    "UPDATE plan_versions SET superseded_at = ? WHERE owner_id = ? AND status = 'approved' AND superseded_at IS NULL
                     AND (plan_deck_id = ? OR plan_deck_id IN (SELECT value FROM json_each(?)))",
                )
                .bind(at)
                .bind(owner)
                .bind(&plan_id)
                .bind(serde_json::to_string(&replaced).unwrap_or_default())
                .execute(&mut *conn)
                .await?;
            }
            let kept: Vec<Value> = if op.action == "approve" { op.keys.iter().map(|k| change(k)).collect() } else { next.keys.iter().map(|k| change(k)).collect() };
            let skipped: Vec<Value> = if op.action == "approve" { op.skip.iter().map(|k| change(k)).collect() } else { vec![] };
            let answers: Vec<Value> = op.answers.iter().map(|(q, a)| json!({"question": q, "answer": a})).collect();
            sqlx::query(
                "INSERT INTO plan_versions (id, owner_id, plan_deck_id, deck_name, n, status, changes, skipped, answers, prior, source,
                   proposed_at, decided_at, op_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(owner)
            .bind(&plan_id)
            .bind(&name)
            .bind(next.n)
            .bind(if op.action == "approve" { "approved" } else { "kept" })
            .bind(Value::Array(kept).to_string())
            .bind(Value::Array(skipped).to_string())
            .bind(Value::Array(answers).to_string())
            .bind(json!({"answers": before, "replaced": replaced}).to_string())
            .bind(next.source.to_string())
            .bind(&next.proposed_at)
            .bind(at)
            .bind(op_id)
            .execute(&mut *conn)
            .await?;
            Ok(Ok(for_export))
        }
        "undo" => {
            let last: Option<(String, i64, String, String)> = sqlx::query_as(
                "SELECT id, n, status, prior FROM plan_versions WHERE owner_id = ? AND plan_deck_id = ? ORDER BY n DESC LIMIT 1",
            )
            .bind(owner)
            .bind(&plan_id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((vid, n, vstatus, prior_text)) = last else { return Ok(Err("There's no decision to undo.".into())) };
            if op.version != Some(n) {
                return Ok(Err(format!("Only the newest decision can be undone: version {n}.")));
            }
            let p = parse(&prior_text);
            let mut writes = Vec::new();
            for (k, v) in p.get("answers").and_then(Value::as_object).into_iter().flatten() {
                let old: Option<Prior> = serde_json::from_value(v.clone()).ok();
                // An answer that wasn't there becomes a cleared answer (a tombstone), as a Review clear is.
                writes.push(Write {
                    key: k.clone(),
                    decision: old.as_ref().and_then(|o| o.decision.clone()),
                    note: old.as_ref().and_then(|o| o.note.clone()),
                    cut: old.as_ref().and_then(|o| o.cut.clone()),
                });
            }
            write_answers(&mut *conn, owner, deck_key, &name, for_export, &writes, &cards, op_id, at, received_at).await?;
            let replaced: Vec<String> =
                p.get("replaced").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
            if vstatus == "approved" {
                let decided: Option<String> = sqlx::query_scalar("SELECT decided_at FROM plan_versions WHERE id = ?").bind(&vid).fetch_one(&mut *conn).await?;
                sqlx::query(
                    "UPDATE plan_versions SET superseded_at = NULL WHERE owner_id = ? AND superseded_at = ?
                     AND (plan_deck_id = ? OR plan_deck_id IN (SELECT value FROM json_each(?)))",
                )
                .bind(owner)
                .bind(&decided)
                .bind(&plan_id)
                .bind(serde_json::to_string(&replaced).unwrap_or_default())
                .execute(&mut *conn)
                .await?;
                for o in &replaced {
                    sqlx::query("UPDATE plan_decks SET archived_at = NULL, archived_note = NULL WHERE id = ? AND owner_id = ? AND archived_note LIKE 'Replaced by version %'")
                        .bind(o)
                        .bind(owner)
                        .execute(&mut *conn)
                        .await?;
                }
            }
            sqlx::query("DELETE FROM plan_versions WHERE id = ? AND owner_id = ?").bind(&vid).bind(owner).execute(&mut *conn).await?;
            Ok(Ok(for_export))
        }
        other => Ok(Err(format!("action: \"{other}\" isn't one of {}", ACTIONS.join(", ")))),
    }
}
