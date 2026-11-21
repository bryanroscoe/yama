//! One plan per deck (Bryan, 2026-11-06, the plans redesign; ARCHITECTURE.md, "Plans: one plan per
//! deck"; migration 0069), and since 20 Nov 2026 nobody approves it (Bryan: "I don't think myself
//! or anybody likes the approve options for the plans… Can the MCP just update the plans itself";
//! ARCHITECTURE.md, "Plans don't wait for approval"). Changes go into the plan when they arrive.
//!
//! A deck's plan is in one state:
//!
//! - **in_progress**: a version (or planned swaps from before versions), with changes still to go in.
//! - **done**: every change in the deck.
//! - **archived**: the plan file archived the deck, or you did, or a newer plan for the same deck
//!   replaced it.
//! - **empty**: no changes at all yet ("No plan yet" on the Plans page).
//! - **waiting**: proposals that arrived and haven't been settled yet. Every write that can bring
//!   one (a plan file, tracking or saving a note, a plan op) calls `settle` in its own transaction,
//!   and the server settles every account once at start, so no page sees it for long.
//!
//! The changes in a plan are its planned swaps plus the proposals it took in. Settling writes the
//! answers Review always wrote (`plan_reviews`: "want" for each change it takes in, "unsure" with
//! the reason for one it leaves out), so the shopping list, prints and the export side read them
//! unchanged. For a deck from a plan file, each answer is also an op in the export side's inbox, as
//! a Review tap was, with the plan op that says which version went in (`auto: true`).
//!
//! The state is computed here, once, for the bundle and for the MCP tools.

use super::installed::Installs;
use crate::error::AppResult;
use crate::util::new_id;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::{HashMap, HashSet};

/// Proposals not settled yet: a deck's first version, or the next one (`settle` takes them in).
#[derive(Debug, Clone, Serialize)]
pub struct Next {
    /// The version number it becomes when it's settled.
    pub n: i64,
    /// Every change in it, in plan order (keys of live proposals).
    pub keys: Vec<String>,
    /// Changes in it you already said no to, or weren't sure about (a first version only): settling
    /// leaves them out and their answers as they are.
    pub skipped: Vec<String>,
    /// When its first change arrived.
    pub proposed_at: Option<String>,
    /// Where it came from: `{kind: "plan_file", app, guide_version, imported_at}` or
    /// `{kind: "note", note, title}` or `{kind: "yama"}`.
    pub source: Value,
    /// What its changes say and how they're answered (content hash, decision and time, in order).
    /// The plan op `settle` records names it for the export side.
    pub hash: String,
    /// What each change in it takes out (swaps only; stand-ins and optional extras aren't
    /// checked), for the checks settling makes (`left_out`).
    pub cuts: Vec<Cut>,
}

/// One waiting change's cut: the card it takes out (your chosen cut, else the plan's), and the
/// change in the plan in force that already takes that card out, if one does.
#[derive(Debug, Clone, Serialize)]
pub struct Cut {
    pub key: String,
    #[serde(rename = "in")]
    pub card_in: String,
    pub out: Option<String>,
    /// The plan's own cut when its fallback (`later_out`) is used because the plan in force
    /// already takes this one out.
    pub instead_of: Option<String>,
    /// The card going in for the change in force that already cuts `out`.
    pub gone_for: Option<String>,
}

/// Basic lands: a deck holds several, so two changes can each take one out.
fn is_basic(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    let n = n.strip_prefix("snow-covered ").unwrap_or(&n);
    matches!(n, "plains" | "island" | "swamp" | "mountain" | "forest" | "wastes")
}

/// A swap's copies (`key#2`, `key#3`) are one change: they never clash with each other.
fn base_key(key: &str) -> &str {
    match key.rsplit_once('#') {
        Some((base, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => base,
        _ => key,
    }
}

/// The changes in `next` that settling leaves out, in plan order, each with why: the checks the
/// page made you settle before you could approve (the plans redesign's New version board, 6 Nov
/// 2026). A change that names no card to cut; a cut the plan in force already makes; and the later
/// of two changes cutting the same card, so the first in plan order goes in and nothing is bought
/// twice for one slot. Basic lands and the copies of one note swap never clash. Changes you already
/// answered (`next.skipped`) aren't here: they stay as you answered them.
pub fn left_out(next: &Next) -> Vec<(String, String)> {
    let mut out = Vec::new();
    // Each card cut so far, by name: the change (base key) cutting it and the card going in.
    let mut taken: HashMap<String, (String, String)> = HashMap::new();
    for c in next.cuts.iter().filter(|c| !next.skipped.contains(&c.key)) {
        let Some(o) = c.out.as_deref().filter(|o| !o.trim().is_empty()) else {
            out.push((c.key.clone(), format!("{} names no card to cut.", c.card_in)));
            continue;
        };
        if is_basic(o) {
            continue;
        }
        if let Some(g) = &c.gone_for {
            out.push((c.key.clone(), format!("{o} already goes out for {g}.")));
            continue;
        }
        match taken.get(&name_key(o)) {
            Some((base, first)) if base != base_key(&c.key) => out.push((c.key.clone(), format!("{first} already takes out {o}."))),
            Some(_) => {}
            None => {
                taken.insert(name_key(o), (base_key(&c.key).to_string(), c.card_in.clone()));
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct DeckPlan {
    /// waiting | in_progress | done | archived | empty
    pub state: &'static str,
    /// The version in force; null before the first.
    pub version: Option<i64>,
    /// When the version in force went in.
    pub approved_at: Option<String>,
    /// Proposals not settled yet: the first version (state waiting) or a new one (state
    /// in_progress). `settle` takes them in, so it's null once a write is done.
    pub next: Option<Next>,
    /// Changes in the plan in force (swaps, not stand-ins or optional extras) and how many are in the deck.
    pub changes: usize,
    pub installed: usize,
    /// The deck's open questions, for their assistant to settle.
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
    /// approved (it went in) | kept (before 20 Nov 2026: you kept the version before it)
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
    in_name: String,
    out_name: Option<String>,
    later_out: Option<String>,
    upgrade: Option<String>,
    import_id: Option<String>,
    content_hash: Option<String>,
    created_at: String,
    updated_at: String,
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
async fn decisions(conn: &mut SqliteConnection, owner: &str, live: &HashSet<String>) -> AppResult<HashMap<String, (Option<String>, String)>> {
    Ok(answers(conn, owner, live).await?.into_iter().map(|(k, (d, at, _))| (k, (d, at))).collect())
}

/// The newest answer per live swap key, aliases followed: decision, time and the cut you chose.
async fn answers(conn: &mut SqliteConnection, owner: &str, live: &HashSet<String>) -> AppResult<HashMap<String, (Option<String>, String, Option<String>)>> {
    let aliases = super::aliases(&mut *conn, owner).await?;
    // The newest answer reaching a key wins; on a tie one made in Yama, then the larger op id (so a
    // person's answer beats settling's `!settle-` ops), also across an alias and its live key: as
    // the pages read them (core `answerIndex`). Rows come oldest first, so a later one replaces an
    // earlier one.
    let rows: Vec<(String, Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT swap_key, decision, at, cut FROM plan_reviews WHERE owner_id = ? ORDER BY at, origin = 'yama', IFNULL(op_id, ''), swap_key")
            .bind(owner)
            .fetch_all(&mut *conn)
            .await?;
    let mut out = HashMap::new();
    for (key, decision, at, cut) in rows {
        if let Some(live_key) = super::resolve_key(&key, live, &aliases) {
            out.insert(live_key, (decision, at, cut.filter(|c| !c.trim().is_empty())));
        }
    }
    Ok(out)
}

/// Live proposals in their plan: a want, reached through aliases as the state reads it, given after
/// the proposal last changed. Installed states are read for these as for planned swaps.
pub async fn approved_proposals(conn: &mut SqliteConnection, owner: &str) -> AppResult<HashSet<String>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT ext_key, stage, updated_at FROM plan_swaps WHERE owner_id = ? AND retired_at IS NULL")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?;
    let live: HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
    let answers = decisions(&mut *conn, owner, &live).await?;
    Ok(rows
        .into_iter()
        .filter(|(k, stage, updated)| {
            stage == "proposed" && answers.get(k).is_some_and(|(d, at)| d.as_deref() == Some("want") && updated.as_str() <= at.as_str())
        })
        .map(|(k, ..)| k)
        .collect())
}

/// One plan deck's proposals that aren't in its plan: answered no or unsure since they last changed
/// (aliases followed). A note plan's now and after lists leave them out (`notes::derive`).
pub async fn kept_out(conn: &mut SqliteConnection, owner: &str, plan_id: &str) -> AppResult<HashSet<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT ext_key, updated_at FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ? AND retired_at IS NULL AND stage = 'proposed'",
    )
    .bind(owner)
    .bind(plan_id)
    .fetch_all(&mut *conn)
    .await?;
    let live: HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
    let answers = decisions(&mut *conn, owner, &live).await?;
    Ok(rows
        .into_iter()
        .filter(|(k, updated)| answers.get(k).is_some_and(|(d, at)| matches!(d.as_deref(), Some("no" | "unsure")) && updated.as_str() <= at.as_str()))
        .map(|(k, _)| k)
        .collect())
}

/// Every plan deck's state and every decided version, for one owner.
pub async fn load(conn: &mut SqliteConnection, owner: &str, installs: Option<&Installs>) -> AppResult<Plans> {
    let decks: Vec<DeckRow> = sqlx::query_as(
        "SELECT id, name, source, status, notes, note_id, import_id, archived_at, archived_note FROM plan_decks WHERE owner_id = ?",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let swaps: Vec<SwapRow> = sqlx::query_as(
        "SELECT ext_key AS key, plan_deck_id, stage, role, in_name, out_name, later_out, upgrade, import_id, content_hash, created_at, updated_at
         FROM plan_swaps WHERE owner_id = ? AND retired_at IS NULL ORDER BY sort, ext_key",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let live: HashSet<String> = swaps.iter().map(|s| s.key.clone()).collect();
    let answers = answers(&mut *conn, owner, &live).await?;
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
        // A proposal changed after it was answered (a later plan file or note save edited it under
        // the same key) is unanswered again: its new content is a new version, and the old answer
        // doesn't stand for what you never saw.
        let decision = |sw: &SwapRow| match answers.get(&sw.key) {
            Some((d, at, _)) if sw.stage != "proposed" || sw.updated_at.as_str() <= at.as_str() => d.clone(),
            _ => None,
        };
        let proposals: Vec<&&SwapRow> = mine.iter().filter(|s| s.stage == "proposed").collect();
        let (keys, skipped): (Vec<String>, Vec<String>) = if has_version {
            // A new version: proposals nobody has answered. Unsure is an answer: out of the plan
            // until someone says want.
            (proposals.iter().filter(|s| decision(s).is_none()).map(|s| s.key.clone()).collect(), vec![])
        } else {
            // The first version: every proposal, the ones you said no to or weren't sure about left
            // as they are.
            (
                proposals.iter().map(|s| s.key.clone()).collect(),
                proposals.iter().filter(|s| matches!(decision(s).as_deref(), Some("no" | "unsure"))).map(|s| s.key.clone()).collect(),
            )
        };
        // The plan in force: planned swaps and approved proposals.
        let in_plan: Vec<&&SwapRow> = mine
            .iter()
            .filter(|s| s.role == "swap" && (s.stage == "planned" || (has_version && decision(s).as_deref() == Some("want"))))
            .collect();
        // Each card the plan in force takes out, and the card going in for it.
        let cut_of = |sw: &SwapRow| answers.get(&sw.key).and_then(|a| a.2.clone()).or_else(|| sw.out_name.clone());
        let in_force_cuts: HashMap<String, String> =
            in_plan.iter().filter_map(|s| cut_of(s).map(|o| (name_key(&o), s.in_name.clone()))).collect();
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
            // Each change's content and the answer it has now.
            let mut parts: Vec<String> = first
                .iter()
                .map(|s| {
                    let (d, at) = answers.get(&s.key).map(|(d, at, _)| (d.as_deref().unwrap_or("-"), at.as_str())).unwrap_or(("-", "-"));
                    format!("{}={}|{d}|{at}", s.key, s.content_hash.as_deref().unwrap_or(&s.updated_at))
                })
                .collect();
            let cuts: Vec<Cut> = first
                .iter()
                .filter(|s| s.role == "swap")
                .map(|s| {
                    // A deck holds several of a basic land, so a basic the plan in force cuts is
                    // never "already gone" for another change.
                    let gone = |o: &str| if is_basic(o) { None } else { in_force_cuts.get(&name_key(o)).cloned() };
                    let chosen = answers.get(&s.key).and_then(|a| a.2.clone());
                    // The plan file's fallback (`later_out`, "the cut to use if `out` has already
                    // left") takes over when the plan in force already takes `out` out, as the
                    // proposal's list does (core `proposalBuild`). A cut you chose stays yours.
                    let fallback = s.later_out.clone().filter(|l| !l.trim().is_empty() && gone(l).is_none());
                    let (out, instead_of) = match (chosen, s.out_name.clone()) {
                        (Some(c), _) => (Some(c), None),
                        (None, Some(o)) if gone(&o).is_some() && fallback.is_some() => (fallback, Some(o)),
                        (None, o) => (o, None),
                    };
                    let gone_for = out.as_deref().and_then(gone);
                    Cut { key: s.key.clone(), card_in: s.in_name.clone(), out, instead_of, gone_for }
                })
                .collect();
            // And the cut each change makes as the page showed it: it depends on the plan in
            // force too (a fallback, an "already goes out"), which can change on another device.
            parts.extend(cuts.iter().map(|c| format!("cut:{}={}|{}", c.key, c.out.as_deref().unwrap_or("-"), c.gone_for.as_deref().unwrap_or("-"))));
            let hash = crate::util::sha256_hex(&parts.join("\n"))[..16].to_string();
            Next { n: top + 1, keys: keys.clone(), skipped, proposed_at, source, hash, cuts }
        });
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

/// A checked `plan` op (inputs.rs parses it): what to do to one deck's plan. Its other fields
/// (version, keys, skips, hash, answers) are only for the export side's record now.
#[derive(Debug, Clone)]
pub struct PlanOp {
    pub action: String,
}

/// Every action a plan op has had, so the export side can still read older ones. Only archive and
/// restore are taken from a page now (`apply`); approve is what `settle` records.
pub const ACTIONS: [&str; 5] = ["approve", "keep", "undo", "archive", "restore"];

/// What a page that still offers Approve, Keep or Undo is told.
const NO_APPROVAL: &str = "Plans don't wait for approval any more: changes go into the plan when they arrive. Reload the page.";

/// One answer this op writes, for the export side's inbox too.
struct Write {
    key: String,
    decision: Option<String>,
    note: Option<String>,
    cut: Option<String>,
}

#[derive(Serialize, serde::Deserialize, Clone)]
struct Prior {
    decision: Option<String>,
    note: Option<String>,
    cut: Option<String>,
    at: String,
    origin: String,
    op_id: Option<String>,
    /// It's held under another key (an alias), not the live key settling writes over.
    #[serde(skip)]
    aliased: bool,
}

/**
 * The answer in force for each live key, aliases followed the way the state is (`decisions`): the
 * newest one that reaches it. Settling keeps its note and cut, and the version keeps it as `prior`.
 */
async fn priors(conn: &mut SqliteConnection, owner: &str, keys: &[String]) -> AppResult<HashMap<String, Prior>> {
    let live: HashSet<String> = sqlx::query_scalar("SELECT ext_key FROM plan_swaps WHERE owner_id = ? AND retired_at IS NULL")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    let aliases = super::aliases(&mut *conn, owner).await?;
    #[derive(sqlx::FromRow)]
    struct Row {
        swap_key: String,
        decision: Option<String>,
        note: Option<String>,
        cut: Option<String>,
        at: String,
        origin: String,
        op_id: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as("SELECT swap_key, decision, note, cut, at, origin, op_id FROM plan_reviews WHERE owner_id = ? ORDER BY at, origin = 'yama', IFNULL(op_id, ''), swap_key")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?;
    let wanted: HashSet<&String> = keys.iter().collect();
    let mut out: HashMap<String, Prior> = HashMap::new();
    for r in rows {
        let Some(k) = super::resolve_key(&r.swap_key, &live, &aliases) else { continue };
        if wanted.contains(&k) {
            let aliased = r.swap_key != k;
            out.insert(k, Prior { decision: r.decision, note: r.note, cut: r.cut, at: r.at, origin: r.origin, op_id: r.op_id, aliased });
        }
    }
    Ok(out)
}

/// Write the answers and, for a deck from a plan file, put each in the export side's inbox as a
/// review op (`<plan op id>/<n>`), as a Review tap would. Settling is the newest word on each
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
        .bind(at)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Apply a plan op to `deck_key`. `Ok(Err(..))` rejects it with a reason the page can show.
/// Returns whether the export side should see it.
pub async fn apply(conn: &mut SqliteConnection, owner: &str, deck_key: &str, op: &PlanOp, at: &str) -> AppResult<Result<bool, String>> {
    let row: Option<(String, String, String, Option<String>)> =
        sqlx::query_as("SELECT id, source, status, archived_at FROM plan_decks WHERE owner_id = ? AND key = ?")
            .bind(owner)
            .bind(deck_key)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((plan_id, source, status, archived_at)) = row else {
        return Ok(Err(format!("deck_key: there's no plan \"{deck_key}\"")));
    };
    let for_export = source != "yama";
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
        "approve" | "keep" | "undo" => Ok(Err(NO_APPROVAL.into())),
        other => Ok(Err(format!("action: \"{other}\" isn't one of {}", ACTIONS.join(", ")))),
    }
}

// ── settling ───────────────────────────────────────────────────────────────

/// What settling took into one deck's plan.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
pub struct Settled {
    pub deck_key: String,
    pub deck: String,
    pub version: i64,
    /// How many changes went in.
    pub kept: usize,
    /// The changes it left out, each as "<card in> for <cut>: why".
    pub left_out: Vec<String>,
    /// Other live plans for the same deck this one replaced, by key.
    pub replaced: Vec<String>,
}

/// Take every unsettled version into its plan: the changes go in, except the ones `left_out`
/// names and the ones you already said no to or weren't sure about. One deck at a time, newest
/// proposals first. Taking a plan in replaces any other live plan for the same deck (archived as
/// "Replaced by version N"), so the newest plan for a deck is the one in force. Called in the
/// transaction of every write that can bring proposals: a plan file, tracking or saving a note, and
/// plan ops (a restore, or an answer cleared).
pub async fn settle(conn: &mut SqliteConnection, owner: &str) -> AppResult<Vec<Settled>> {
    let decks: Vec<(String, String, String, String)> = sqlx::query_as("SELECT id, key, name, source FROM plan_decks WHERE owner_id = ?")
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?;
    let mut out = Vec::new();
    let mut done: HashSet<String> = HashSet::new();
    // Taking one version in can archive another deck's, so the state is read again each time.
    loop {
        let plans = load(&mut *conn, owner, None).await?;
        let pick = decks
            .iter()
            .filter(|d| !done.contains(&d.0))
            .filter_map(|d| {
                let plan = plans.decks.get(&d.0).filter(|p| p.state != "archived")?;
                Some((d, plan.next.clone()?))
            })
            .max_by(|a, b| a.1.proposed_at.cmp(&b.1.proposed_at).then_with(|| b.0.1.cmp(&a.0.1)));
        let Some(((id, key, name, source), next)) = pick else { break };
        done.insert(id.clone());
        if let Some(done) = take_in(&mut *conn, owner, id, key, name, source, &next).await? {
            // A note plan's now and after lists (what Swap in the prints puts in the deck) follow
            // what just went in or was left out.
            super::notes::restate_deck(&mut *conn, owner, key).await?;
            out.push(done);
        }
    }
    // The caller's write moves the plan revision (an import's head, a note's bump, a batch of ops),
    // so the pages fetch again; `settle_all` moves it itself.
    Ok(out)
}

/// Settle every account with proposals, each in its own transaction: run as the server starts, for
/// plans that were waiting for an OK before 20 Nov 2026 and anything a failed write left. Returns
/// how many versions went in.
pub async fn settle_all(pool: &sqlx::SqlitePool) -> AppResult<usize> {
    // Only accounts with something to settle, so a start reads nobody's whole plans for nothing: a
    // live proposal on a live deck with no answer since it last changed, one an older key's answer
    // outranks, or a deck that has proposals and no version yet. (A false positive costs a read
    // that finds nothing to settle; settled answers are written under the live key.)
    let owners: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE chain(owner_id, old_key, live_key) AS (
           SELECT owner_id, old_key, new_key FROM plan_key_aliases
           UNION
           SELECT c.owner_id, a.old_key, c.live_key FROM plan_key_aliases a JOIN chain c ON a.owner_id = c.owner_id AND a.new_key = c.old_key
         )
         SELECT DISTINCT s.owner_id FROM plan_swaps s JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
         WHERE s.retired_at IS NULL AND s.stage = 'proposed' AND d.status != 'archived' AND d.archived_at IS NULL
           AND (NOT EXISTS (SELECT 1 FROM plan_reviews r WHERE r.owner_id = s.owner_id AND r.swap_key = s.ext_key
                              AND r.decision IS NOT NULL AND r.at >= s.updated_at)
                -- An answer under an older key (any step of its alias chain) newer than the live one
                -- is the newest word on it (a clear that waited for a fast device's clock to pass).
                -- Ranked as `answers` ranks them: time, made in Yama, then op id.
                OR EXISTS (SELECT 1 FROM chain a JOIN plan_reviews o ON o.owner_id = a.owner_id AND o.swap_key = a.old_key
                           WHERE a.owner_id = s.owner_id AND a.live_key = s.ext_key
                             AND NOT EXISTS (SELECT 1 FROM plan_reviews r WHERE r.owner_id = s.owner_id AND r.swap_key = s.ext_key
                                               AND (r.at, r.origin = 'yama', IFNULL(r.op_id, '')) >= (o.at, o.origin = 'yama', IFNULL(o.op_id, ''))))
                OR (NOT EXISTS (SELECT 1 FROM plan_versions v WHERE v.owner_id = d.owner_id AND v.plan_deck_id = d.id)
                    AND NOT EXISTS (SELECT 1 FROM plan_swaps p WHERE p.owner_id = d.owner_id AND p.plan_deck_id = d.id
                                      AND p.retired_at IS NULL AND p.stage = 'planned' AND p.role != 'standin')))
         ORDER BY s.owner_id",
    )
    .fetch_all(pool)
    .await?;
    let mut n = 0;
    for owner in owners {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let settled = settle(&mut tx, &owner).await?.len();
        if settled > 0 {
            let at = crate::util::now();
            sqlx::query("INSERT INTO plan_meta (owner_id, updated_at) VALUES (?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(&owner).bind(&at).execute(&mut *tx).await?;
            sqlx::query("UPDATE plan_meta SET revision = revision + 1, updated_at = ? WHERE owner_id = ?").bind(&at).bind(&owner).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        n += settled;
    }
    Ok(n)
}

/// Take one deck's unsettled version in: a want for each change that goes in, unsure with the reason
/// for each one `left_out` names (your note, if you wrote one, is kept), the version recorded, and for
/// a plan file's deck the answers and the plan op in the export side's inbox.
async fn take_in(conn: &mut SqliteConnection, owner: &str, plan_id: &str, deck_key: &str, name: &str, source: &str, next: &Next) -> AppResult<Option<Settled>> {
    let op_id = format!("{SETTLE_OP}{}", new_id());
    let for_export = source != "yama";
    let rows: Vec<(String, String, Option<String>, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT ext_key, in_name, out_name, src, why, updated_at, role FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ? AND retired_at IS NULL ORDER BY sort, ext_key",
    )
    .bind(owner)
    .bind(plan_id)
    .fetch_all(&mut *conn)
    .await?;
    let found = priors(&mut *conn, owner, &next.keys).await?;
    // The answers have to count as given after each change last changed, so they're stamped now,
    // or at the change's last edit: never later, so a settled answer never outranks the next one a
    // person gives (a device's clock may run a few minutes ahead). An answer on the live key is
    // written over. One held under an alias that is newer than that (a clear from a fast clock)
    // would still be the newest word, so that change waits for a later write instead of being
    // answered every time.
    let parse = |t: &str| chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&chrono::Utc));
    let at = {
        let mut at = chrono::Utc::now();
        for (.., updated, _) in rows.iter().filter(|r| next.keys.contains(&r.0)) {
            if let Some(u) = parse(updated) {
                at = at.max(u);
            }
        }
        at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    };
    // A want under an alias is in force whatever settling writes, so it never waits: it's taken in
    // now and keeps its cut (below).
    let later: HashSet<&String> = next
        .keys
        .iter()
        .filter(|k| {
            found.get(*k).is_some_and(|p| {
                p.aliased && p.decision.as_deref() != Some("want") && parse(&p.at).zip(parse(&at)).is_some_and(|(a, now)| a >= now)
            })
        })
        .collect();
    if next.keys.iter().all(|k| later.contains(k)) {
        return Ok(None);
    }
    // Optional extras: changes that take nothing out (a note swap with no card_out).
    let extras: HashSet<String> = rows.iter().filter(|r| r.6 == "optional").map(|r| r.0.clone()).collect();
    // When each change last changed, for whether an answer was given since.
    let edited: HashMap<String, String> = rows.iter().map(|r| (r.0.clone(), r.5.clone())).collect();
    let swaps: Vec<(String, String, Option<String>, String, Option<String>)> = rows.into_iter().map(|(k, i, o, src, w, ..)| (k, i, o, src, w)).collect();
    let cards: HashMap<String, String> = swaps.iter().map(|(k, i, ..)| (k.clone(), i.clone())).collect();
    let cut_of = |k: &str| next.cuts.iter().find(|c| c.key == k).and_then(|c| c.out.clone());
    let change = |k: &str, why: Option<&str>| {
        let mut v = swaps
            .iter()
            .find(|s| s.0 == k)
            .map(|(k, i, o, src, w)| json!({"key": k, "in": i, "out": cut_of(k).or_else(|| o.clone()), "src": src, "why": w}))
            .unwrap_or(json!({"key": k}));
        if let Some(w) = why {
            v["left_out"] = json!(w);
        }
        v
    };
    let label = |k: &str| {
        let card = cards.get(k).cloned().unwrap_or_else(|| k.to_string());
        match cut_of(k).or_else(|| swaps.iter().find(|s| s.0 == k).and_then(|s| s.2.clone())) {
            Some(o) => format!("{card} for {o}"),
            None => card,
        }
    };
    // A no or unsure a person gave stays, even when the change was edited after it (a plan file's
    // new wording, a note saved again): nobody looks at it before it goes in now, so it never goes
    // in over their word. Only Yama's own left-outs (settle's ops) are looked at again.
    let theirs = |k: &String| {
        found.get(k).is_some_and(|p| {
            matches!(p.decision.as_deref(), Some("no" | "unsure")) && !p.op_id.as_deref().is_some_and(|o| o.starts_with(SETTLE_OP))
        })
    };
    let held: Vec<String> = next.keys.iter().filter(|k| next.skipped.contains(k) || theirs(k)).cloned().collect();
    // A want a person gave since the change last changed stands too (a deck's first version lists
    // every proposal, answered ones included): no check leaves it out, and it takes its cut first.
    let wanted: HashSet<String> = next
        .keys
        .iter()
        .filter(|k| {
            found.get(*k).is_some_and(|p| {
                p.decision.as_deref() == Some("want")
                    && !p.op_id.as_deref().is_some_and(|o| o.starts_with(SETTLE_OP))
                    && edited.get(*k).is_some_and(|u| u.as_str() <= p.at.as_str())
            })
        })
        .cloned()
        .collect();
    // What's held, or waits for a later write, takes no cut now.
    let aside: Vec<String> = held.iter().cloned().chain(later.iter().map(|k| (*k).clone())).collect();
    let first: Vec<Cut> = next.cuts.iter().filter(|c| wanted.contains(&c.key)).chain(next.cuts.iter().filter(|c| !wanted.contains(&c.key))).cloned().collect();
    let mut why: HashMap<String, String> = left_out(&Next { skipped: aside, cuts: first, ..next.clone() }).into_iter().filter(|(k, _)| !wanted.contains(k)).collect();
    // An optional extra names no card to cut either: it would buy a card with no slot, so it's left
    // out the same way until someone answers want.
    for k in next.keys.iter().filter(|k| extras.contains(*k) && !held.contains(k) && !wanted.contains(*k)) {
        why.entry(k.clone()).or_insert_with(|| format!("{} is an optional extra: it names no card to cut.", cards.get(k).map_or(k.as_str(), String::as_str)));
    }
    let mut before = serde_json::Map::new();
    let (mut writes, mut kept, mut skipped, mut skip_keys, mut said) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for k in next.keys.iter().filter(|k| !later.contains(k)) {
        let p = found.get(k).cloned();
        if held.contains(k) {
            let unsure = p.as_ref().and_then(|p| p.decision.as_deref()) == Some("unsure");
            skipped.push(change(k, Some(if unsure { "You weren't sure about it." } else { "You said no to it." })));
            skip_keys.push(k.clone());
            // Edited since: the same answer again, so it counts for what the change says now.
            if !next.skipped.contains(k)
                && let Some(p) = &p
            {
                before.insert(k.clone(), serde_json::to_value(p).unwrap_or(Value::Null));
                writes.push(Write { key: k.clone(), decision: p.decision.clone(), note: p.note.clone(), cut: p.cut.clone() });
            }
            continue;
        }
        let (note, mut cut) = p.as_ref().map(|p| (p.note.clone(), p.cut.clone())).unwrap_or_default();
        before.insert(k.clone(), serde_json::to_value(&p).unwrap_or(Value::Null));
        // Your note stays; the reason Yama wrote when it left this out before goes.
        let ours = p.as_ref().is_some_and(|p| p.op_id.as_deref().is_some_and(|o| o.starts_with(SETTLE_OP)));
        let note = note.filter(|n| !n.trim().is_empty() && !(ours && n.starts_with(LEFT_OUT)));
        if let Some(w) = why.get(k) {
            let note = note.or_else(|| Some(format!("{LEFT_OUT}{w}")));
            writes.push(Write { key: k.clone(), decision: Some("unsure".into()), note, cut });
            skipped.push(change(k, Some(w)));
            skip_keys.push(k.clone());
            said.push(format!("{}: {w}", label(k)));
            continue;
        }
        // A change kept on the plan's fallback cut keeps it as its cut, as a cut you chose is
        // kept: the plan in force, the shopping list and prints then read the card it really
        // takes out.
        if cut.is_none()
            && let Some(c) = next.cuts.iter().find(|c| &c.key == k && c.instead_of.is_some())
        {
            cut = c.out.clone();
        }
        writes.push(Write { key: k.clone(), decision: Some("want".into()), note, cut });
        kept.push(k.clone());
    }
    write_answers(&mut *conn, owner, deck_key, name, for_export, &writes, &cards, &op_id, &at).await?;
    // The newest plan for a deck replaces every other live plan for it.
    let others = replace_others(&mut *conn, owner, plan_id, name, &format!("Replaced by version {}", next.n), &at).await?;
    let replaced: Vec<&String> = others.iter().map(|(id, _)| id).collect();
    // And this deck's version before is history now.
    sqlx::query("UPDATE plan_versions SET superseded_at = ? WHERE owner_id = ? AND plan_deck_id = ? AND status = 'approved' AND superseded_at IS NULL")
        .bind(&at)
        .bind(owner)
        .bind(plan_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO plan_versions (id, owner_id, plan_deck_id, deck_name, n, status, changes, skipped, answers, prior, source,
           proposed_at, decided_at, op_id)
         VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, '[]', ?, ?, ?, ?, ?)",
    )
    .bind(new_id())
    .bind(owner)
    .bind(plan_id)
    .bind(name)
    .bind(next.n)
    .bind(Value::Array(kept.iter().map(|k| change(k, None)).collect()).to_string())
    .bind(Value::Array(skipped).to_string())
    .bind(json!({"answers": before, "replaced": replaced}).to_string())
    .bind(next.source.to_string())
    .bind(&next.proposed_at)
    .bind(&at)
    .bind(&op_id)
    .execute(&mut *conn)
    .await?;
    // The plan op itself, for the export side (pull.py lists plan decisions): the same shape a
    // page's Approve sent, marked as Yama's own.
    let payload = json!({"op_id": op_id, "kind": "plan", "at": at, "deck_key": deck_key, "action": "approve", "version": next.n,
                         "keys": kept, "skip": skip_keys, "answers": [], "hash": next.hash, "auto": true});
    sqlx::query(
        "INSERT INTO plan_inputs (owner_id, op_id, device_id, kind, swap_key, deck_key, payload, status, error, for_export, client_at, received_at)
         VALUES (?, ?, NULL, 'plan', NULL, ?, ?, 'applied', NULL, ?, ?, ?)",
    )
    .bind(owner)
    .bind(&op_id)
    .bind(deck_key)
    .bind(payload.to_string())
    .bind(for_export)
    .bind(&at)
    .bind(&at)
    .execute(&mut *conn)
    .await?;
    Ok(Some(Settled {
        deck_key: deck_key.to_string(),
        deck: name.to_string(),
        version: next.n,
        kept: kept.len(),
        left_out: said,
        replaced: others.into_iter().map(|(_, k)| k).collect(),
    }))
}

/// The note Yama writes on a change it leaves out, before the reason.
const LEFT_OUT: &str = "Yama left this out: ";

/// How settle's ops are named. Answers made in Yama at the same second go to the larger op id
/// (`inputs.rs`, core `wins`); `!` sorts before any id a page or an assistant sends, so a person's
/// answer at the same second as settling wins it.
pub const SETTLE_OP: &str = "!settle-";

/// Archive every other live plan for the deck called `name` (`note` says why), and mark their
/// versions superseded. Returns the plans it archived, as (id, key).
pub async fn replace_others(conn: &mut SqliteConnection, owner: &str, plan_id: &str, name: &str, note: &str, at: &str) -> AppResult<Vec<(String, String)>> {
    let others: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, key FROM plan_decks WHERE owner_id = ? AND id != ? AND lower(trim(name)) = ? AND status != 'archived' AND archived_at IS NULL",
    )
    .bind(owner)
    .bind(plan_id)
    .bind(name_key(name))
    .fetch_all(&mut *conn)
    .await?;
    for (o, _) in &others {
        sqlx::query("UPDATE plan_decks SET archived_at = ?, archived_note = ? WHERE id = ? AND owner_id = ?")
            .bind(at)
            .bind(note)
            .bind(o)
            .bind(owner)
            .execute(&mut *conn)
            .await?;
    }
    let ids: Vec<&String> = others.iter().map(|(id, _)| id).collect();
    sqlx::query(
        "UPDATE plan_versions SET superseded_at = ? WHERE owner_id = ? AND status = 'approved' AND superseded_at IS NULL
         AND plan_deck_id IN (SELECT value FROM json_each(?))",
    )
    .bind(at)
    .bind(owner)
    .bind(serde_json::to_string(&ids).unwrap_or_default())
    .execute(&mut *conn)
    .await?;
    Ok(others)
}
