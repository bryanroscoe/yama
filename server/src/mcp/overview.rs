//! `overview`: the account at a glance, small whatever the account's size.
//!
//! The default answer counts everything and lists only the first few of each kind. `section`
//! lists one kind in full, `limit` rows at a time, with `next_cursor` for the page after. A row
//! is one line of bounded length (a deck or one of its configurations, a plan, a note's deck),
//! so a page has a size whatever the account holds: a note with a hundred decks is several
//! pages, not one. A deck's configurations are builds of that deck, so they're listed under it
//! and never as decks of their own. Every row is the caller's (`owner_id` is bound in each query).

use super::page;
use crate::advisor::context::plan_state_text;
use crate::error::{AppError, AppResult};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fmt::Write as _;

/// How many of each kind the default answer lists.
const SUMMARY_DECKS: usize = 20;
const SUMMARY_PLANS: usize = 12;
const SUMMARY_NOTES: usize = 5;
/// Note decks listed under those notes, across all of them.
const SUMMARY_NOTE_DECKS: usize = 6;
/// Builds named on each of those note decks.
const SUMMARY_BUILDS: usize = 3;
/// The longest a name people typed is shown, and the longest one line gets.
const NAME: usize = 80;
const LINE: usize = 320;
/// The longest row in a section's listing: a deck or plan, and a note deck with its builds.
const FULL_LINE: usize = 420;
const NOTE_DECK_LINE: usize = 900;
/// Builds named on a note deck in the notes section (a deck may have 12).
const SECTION_BUILDS: usize = 12;
/// Rows a section's page holds when `limit` is left out, and the most it may hold. The largest
/// page is still an answer a client accepts: 40 rows of at most `FULL_LINE` or 15 of
/// `NOTE_DECK_LINE` with their note lines.
const DECKS_PAGE: usize = 40;
const PLANS_PAGE: usize = 40;
const NOTES_PAGE: usize = 15;
const MAX_PAGE: usize = 100;
const MAX_NOTES_PAGE: usize = 40;

fn clip(text: &str, max: usize) -> String {
    let text = text.trim_end();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// One line of the default answer, never longer than `LINE`.
fn line(out: &mut String, text: &str) {
    let _ = writeln!(out, "{}", clip(text, LINE));
}

/// One row of a section's listing.
fn full_line(out: &mut String, text: &str) {
    let _ = writeln!(out, "{}", clip(text, FULL_LINE));
}

// ── decks ───────────────────────────────────────────────────────────────────

struct DeckRow {
    id: String,
    name: String,
    commanders: Vec<String>,
    configuration: Option<String>,
    /// The deck this one is a configuration of, when that deck is still theirs.
    parent: Option<String>,
    visibility: String,
    bracket: Option<i64>,
}

async fn load_decks(pool: &SqlitePool, owner: &str) -> AppResult<Vec<DeckRow>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, String, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.name,
           (SELECT json_group_array(json_extract(c.value, '$.name')) FROM deck_versions v, json_each(v.cards) c
            WHERE v.id = d.current_version_id AND json_extract(c.value, '$.board') = 'commander'),
           d.configuration,
           (SELECT p.id FROM decks p WHERE p.id = d.parent_id AND p.owner_id = d.owner_id AND p.archived = 0),
           d.visibility, d.bracket
         FROM decks d WHERE d.owner_id = ? AND d.archived = 0 ORDER BY lower(d.name), d.id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, commanders, configuration, parent, visibility, bracket)| DeckRow {
            id,
            name,
            commanders: commanders.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default(),
            configuration,
            parent,
            visibility,
            bracket,
        })
        .collect())
}

/// The decks that aren't configurations of another, each with its configurations, in name order.
fn grouped(rows: &[DeckRow]) -> Vec<(&DeckRow, Vec<&DeckRow>)> {
    let by_id: HashMap<&str, &DeckRow> = rows.iter().map(|d| (d.id.as_str(), d)).collect();
    // A configuration of a configuration still belongs to the deck at the top.
    let top = |d: &DeckRow| -> String {
        let mut at = d;
        for _ in 0..8 {
            match at.parent.as_deref().and_then(|p| by_id.get(p)) {
                Some(p) => at = *p,
                None => break,
            }
        }
        at.id.clone()
    };
    let mut under: HashMap<String, Vec<&DeckRow>> = HashMap::new();
    for d in rows.iter().filter(|d| d.parent.is_some()) {
        under.entry(top(d)).or_default().push(d);
    }
    rows.iter().filter(|d| d.parent.is_none()).map(|d| (d, under.remove(&d.id).unwrap_or_default())).collect()
}

fn deck_facts(d: &DeckRow) -> Vec<String> {
    let mut facts = Vec::new();
    if !d.commanders.is_empty() {
        facts.push(format!("commander: {}", d.commanders.iter().map(|c| clip(c, NAME)).collect::<Vec<_>>().join(" and ")));
    }
    if let Some(b) = d.bracket {
        facts.push(format!("declared bracket {b}"));
    }
    match d.visibility.as_str() {
        "public" => facts.push("public on their profile".into()),
        "link" => facts.push("shared by link".into()),
        _ => {}
    }
    facts
}

fn configuration_label(d: &DeckRow) -> String {
    clip(d.configuration.as_deref().filter(|l| !l.trim().is_empty()).unwrap_or(&d.name), 40)
}

/// A deck in the default answer: one line, its configurations by label.
fn deck_summary(d: &DeckRow, configurations: &[&DeckRow]) -> String {
    let mut facts = deck_facts(d);
    if !configurations.is_empty() {
        const SHOWN: usize = 6;
        let mut labels: Vec<String> = configurations.iter().take(SHOWN).map(|c| configuration_label(c)).collect();
        if configurations.len() > SHOWN {
            labels.push(format!("{} more", configurations.len() - SHOWN));
        }
        facts.push(format!("{}: {}", plural(configurations.len(), "configuration", "configurations"), labels.join(", ")));
    }
    format!("- {}{}", clip(&d.name, NAME), if facts.is_empty() { String::new() } else { format!(" ({})", facts.join("; ")) })
}

/// The decks section's rows: each deck with its id, then each of its configurations with its
/// own name and id. A configuration names its deck, so a page that starts in the middle of a
/// deck's configurations still reads.
fn deck_rows(groups: &[(&DeckRow, Vec<&DeckRow>)]) -> Vec<String> {
    let mut rows = Vec::new();
    for (d, configurations) in groups {
        let mut facts = vec![format!("id {}", d.id)];
        facts.extend(deck_facts(d));
        rows.push(format!("- {} ({})", clip(&d.name, NAME), facts.join("; ")));
        for c in configurations {
            let mut facts = vec![format!("id {}", c.id)];
            facts.extend(deck_facts(c));
            rows.push(format!("  - configuration {:?} of {}: {} ({})", configuration_label(c), clip(&d.name, 40), clip(&c.name, NAME), facts.join("; ")));
        }
    }
    rows
}

fn decks_heading(groups: &[(&DeckRow, Vec<&DeckRow>)]) -> String {
    let configurations: usize = groups.iter().map(|(_, c)| c.len()).sum();
    match configurations {
        0 => format!("Decks: {}.", groups.len()),
        n => format!("Decks: {}, plus {} of them (other builds of a deck, listed under it).", groups.len(), plural(n, "configuration", "configurations")),
    }
}

// ── deck plans ──────────────────────────────────────────────────────────────

struct PlanRow {
    key: String,
    name: String,
    /// The note and build it was made from; none for a plan from a plan file.
    from: Option<(String, String)>,
    /// waiting | in_progress | done | archived | empty
    state: &'static str,
    words: String,
}

async fn load_plans(pool: &SqlitePool, owner: &str) -> AppResult<Vec<PlanRow>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, key, name, note_id, note_build_id FROM plan_decks WHERE owner_id = ?
         ORDER BY status = 'archived' OR archived_at IS NOT NULL, sort, key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let installs = crate::plan::installed::load(pool, owner).await?;
    let mut conn = pool.acquire().await?;
    let states = crate::plan::versions::load(&mut conn, owner, Some(&installs)).await?;
    Ok(rows
        .into_iter()
        .map(|(id, key, name, note, build)| {
            let plan = states.decks.get(&id);
            PlanRow {
                key,
                name,
                from: note.zip(build),
                state: plan.map_or("empty", |p| p.state),
                words: plan.map(plan_state_text).unwrap_or_else(|| "no changes yet".into()),
            }
        })
        .collect())
}

fn plan_line(p: &PlanRow) -> String {
    let from = match &p.from {
        Some((note, build)) => format!("; build {build} of note {note}"),
        None => "; from a plan file".into(),
    };
    format!("- {} (plan key {}{from}): {}", clip(&p.name, NAME), p.key, p.words)
}

fn plans_heading(plans: &[PlanRow]) -> String {
    let count = |state: &str| plans.iter().filter(|p| p.state == state).count();
    let parts: Vec<String> = [("waiting", "waiting for their OK"), ("in_progress", "in progress"), ("done", "done"), ("empty", "with no changes yet"), ("archived", "archived")]
        .iter()
        .filter_map(|(state, words)| match count(state) {
            0 => None,
            n => Some(format!("{n} {words}")),
        })
        .collect();
    if plans.is_empty() {
        return "Deck plans: none yet.".into();
    }
    format!(
        "Deck plans: {} ({}). A plan belongs to one deck; approving it is one decision for the whole plan (`approve_plan`), after skipping any \
         change and answering its open questions. Only approved plans feed the shopping list and prints.",
        plans.len(),
        parts.join(", ")
    )
}

// ── notes ───────────────────────────────────────────────────────────────────

/// One deck of one saved note, with its builds and the plan tracking it, if any.
struct NoteDeck {
    note: String,
    title: String,
    revision: i64,
    key: String,
    name: Option<String>,
    /// (id, label, bracket)
    builds: Vec<(String, String, Option<i64>)>,
    /// (build id, plan key) of the live plan made from this deck.
    tracking: Option<(String, String)>,
}

/// Every deck of every saved note, newest note first.
async fn note_decks(pool: &SqlitePool, owner: &str) -> AppResult<Vec<NoteDeck>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT r.id, r.title, r.revision, json_extract(d.value, '$.key'), json_extract(d.value, '$.name'),
           (SELECT json_group_array(json_object('id', json_extract(b.value, '$.id'), 'label', json_extract(b.value, '$.label'),
                                                'bracket', json_extract(b.value, '$.bracket')))
            FROM json_each(d.value, '$.builds') b)
         FROM research_reports r, json_each(r.document, '$.decks') d
         WHERE r.owner_id = ? AND json_type(d.value, '$.key') = 'text'
         ORDER BY r.updated_at DESC, r.id, d.key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let tracked: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT note_id, note_deck_key, note_build_id, key, status FROM plan_decks WHERE owner_id = ? AND note_id IS NOT NULL")
            .bind(owner)
            .fetch_all(pool)
            .await?;
    let mut tracked: HashMap<(String, String), (String, String)> =
        tracked.into_iter().filter(|t| t.4 != "archived").map(|(note, deck, build, key, _)| ((note, deck), (build, key))).collect();
    Ok(rows
        .into_iter()
        .map(|(note, title, revision, key, name, builds)| {
            let builds: Vec<Value> = serde_json::from_str(&builds).unwrap_or_default();
            let builds = builds
                .iter()
                .map(|b| (b["id"].as_str().unwrap_or("?").to_string(), b["label"].as_str().unwrap_or("").to_string(), b["bracket"].as_i64()))
                .collect();
            let tracking = tracked.remove(&(note.clone(), key.clone()));
            NoteDeck { note, title, revision, key, name, builds, tracking }
        })
        .collect())
}

/// The notes in order, each with its decks.
fn by_note(decks: &[NoteDeck]) -> Vec<Vec<&NoteDeck>> {
    let mut notes: Vec<Vec<&NoteDeck>> = Vec::new();
    for d in decks {
        match notes.last_mut() {
            Some(last) if last[0].note == d.note => last.push(d),
            _ => notes.push(vec![d]),
        }
    }
    notes
}

fn note_line(d: &NoteDeck) -> String {
    format!("- {} (note id {}, revision {}): /decks/plans/archived/{}", clip(&d.title, NAME), d.note, d.revision, d.note)
}

/// A note's deck with its tracked build and at most `shown` of its builds.
fn note_deck_line(d: &NoteDeck, shown: usize) -> String {
    let mut builds: Vec<String> = d
        .builds
        .iter()
        .take(shown)
        .map(|(id, label, bracket)| format!("{} ({}{})", clip(id, 40), clip(label, 40), bracket.map(|n| format!(", bracket {n}")).unwrap_or_default()))
        .collect();
    if d.builds.len() > shown {
        builds.push(format!("{} more", d.builds.len() - shown));
    }
    let state = match &d.tracking {
        Some((build, key)) => format!("tracking build {build} as plan key {key}"),
        None => "no build tracked".into(),
    };
    format!("  - {} (deck key {}): {state}. Builds: {}", clip(d.name.as_deref().unwrap_or(&d.key), NAME), d.key, builds.join("; "))
}

fn notes_heading(notes: &[Vec<&NoteDeck>]) -> String {
    let decks: usize = notes.iter().map(Vec::len).sum();
    let tracked = notes.iter().flatten().filter(|d| d.tracking.is_some()).count();
    format!(
        "Notes: {} with {}, {} tracked as a plan. Notes are saved research, kept for reference (`research` reads one; `track_build` makes one \
         build a deck's next plan version, waiting for their OK).",
        plural(notes.len(), "saved note", "saved notes"),
        plural(decks, "deck", "decks"),
        tracked
    )
}

/// What `plan_deck` says for a note deck that no plan tracks yet; empty when no note has one
/// with that key.
pub(super) async fn untracked_note_deck(pool: &SqlitePool, owner: &str, key: &str) -> AppResult<String> {
    let decks = note_decks(pool, owner).await?;
    let mut out = String::new();
    for d in decks.iter().filter(|d| d.key == key && d.tracking.is_none()) {
        if out.is_empty() {
            out.push_str("Not a plan yet. This deck is in their notes; `research` reads its builds and `track_build` makes one a plan version waiting for their OK:\n");
        }
        full_line(&mut out, &note_line(d));
        let _ = writeln!(out, "{}", clip(&note_deck_line(d, SECTION_BUILDS), NOTE_DECK_LINE));
    }
    Ok(out)
}

// ── the tool ────────────────────────────────────────────────────────────────

fn next_cursor(out: &mut String, cursor: Option<String>) {
    match cursor {
        Some(c) => {
            let _ = writeln!(out, "next_cursor: {c}");
        }
        None => out.push_str("That is all of them.\n"),
    }
}

pub(super) async fn overview(pool: &SqlitePool, owner: &str, args: &Value) -> AppResult<String> {
    let section = match args.get("section").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::String(s)) if ["decks", "plans", "notes"].contains(&s.as_str()) => Some(s.as_str()),
        Some(_) => return Err(AppError::bad("section is decks, plans or notes")),
    };
    let mut out = String::new();
    match section {
        Some("decks") => {
            let page = page::page(args, "overview.decks", DECKS_PAGE, MAX_PAGE)?;
            let decks = load_decks(pool, owner).await?;
            let groups = grouped(&decks);
            let rows = deck_rows(&groups);
            full_line(&mut out, &decks_heading(&groups));
            for row in rows.iter().skip(page.offset).take(page.limit) {
                full_line(&mut out, row);
            }
            next_cursor(&mut out, page.next("overview.decks", rows.len()));
        }
        Some("plans") => {
            let page = page::page(args, "overview.plans", PLANS_PAGE, MAX_PAGE)?;
            let plans = load_plans(pool, owner).await?;
            full_line(&mut out, &plans_heading(&plans));
            for p in plans.iter().skip(page.offset).take(page.limit) {
                full_line(&mut out, &plan_line(p));
            }
            next_cursor(&mut out, page.next("overview.plans", plans.len()));
        }
        Some(_) => {
            // A row is one note deck; its note's line goes above the first of them on a page.
            let page = page::page(args, "overview.notes", NOTES_PAGE, MAX_NOTES_PAGE)?;
            let decks = note_decks(pool, owner).await?;
            let notes = by_note(&decks);
            full_line(&mut out, &notes_heading(&notes));
            let mut note = "";
            for d in decks.iter().skip(page.offset).take(page.limit) {
                if note != d.note {
                    full_line(&mut out, &note_line(d));
                    note = &d.note;
                }
                let _ = writeln!(out, "{}", clip(&note_deck_line(d, SECTION_BUILDS), NOTE_DECK_LINE));
            }
            next_cursor(&mut out, page.next("overview.notes", decks.len()));
        }
        None => {
            if args.get("cursor").is_some_and(|c| !c.is_null()) {
                return Err(AppError::bad("cursor needs the section it came from: decks, plans or notes"));
            }
            summary(pool, owner, &mut out).await?;
        }
    }
    Ok(out)
}

/// The default answer: counts, and the first few of each kind.
async fn summary(pool: &SqlitePool, owner: &str, out: &mut String) -> AppResult<()> {
    out.push_str(
        "Their Yama account at a glance. To list one kind in full, call `overview` again with section \"decks\", \"plans\" or \"notes\" \
         (each takes limit and cursor).\n\n",
    );
    let rows = load_decks(pool, owner).await?;
    let groups = grouped(&rows);
    full_line(out, &decks_heading(&groups));
    if groups.is_empty() {
        out.push_str("- none yet\n");
    }
    for (d, configurations) in groups.iter().take(SUMMARY_DECKS) {
        line(out, &deck_summary(d, configurations));
    }
    if groups.len() > SUMMARY_DECKS {
        // The decks section's rows are decks and their configurations: start after the ones listed.
        let listed: usize = groups.iter().take(SUMMARY_DECKS).map(|(_, configurations)| 1 + configurations.len()).sum();
        let _ = writeln!(out, "({} more: call `overview` with section \"decks\" and cursor \"{}\".)", groups.len() - SUMMARY_DECKS, page::cursor("overview.decks", listed));
    }

    let plans = load_plans(pool, owner).await?;
    if !plans.is_empty() {
        out.push('\n');
        full_line(out, &plans_heading(&plans));
        // Archived plans sort last and are only counted here.
        let live = plans.iter().filter(|p| p.state != "archived").count();
        for p in plans.iter().filter(|p| p.state != "archived").take(SUMMARY_PLANS) {
            line(out, &plan_line(p));
        }
        let listed = live.min(SUMMARY_PLANS);
        if listed < plans.len() {
            let _ = writeln!(out, "({} more, archived ones included: call `overview` with section \"plans\".)", plans.len() - listed);
        }
    }

    let decks = note_decks(pool, owner).await?;
    let notes = by_note(&decks);
    if !notes.is_empty() {
        out.push('\n');
        full_line(out, &notes_heading(&notes));
        let mut deck_lines = 0;
        let mut complete = notes.len() <= SUMMARY_NOTES;
        for note in notes.iter().take(SUMMARY_NOTES) {
            line(out, &note_line(note[0]));
            for d in note {
                if deck_lines == SUMMARY_NOTE_DECKS {
                    complete = false;
                    break;
                }
                line(out, &note_deck_line(d, SUMMARY_BUILDS));
                deck_lines += 1;
            }
        }
        if !complete {
            let _ = writeln!(out, "(Not every note and note deck is listed: call `overview` with section \"notes\" for all {}.)", notes.len());
        }
    }
    Ok(())
}
