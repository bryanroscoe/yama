//! Mythic Tools CSV import: a file brings the collection up to date, never doubles it.
//!
//! Mythic Tools exports the whole collection each time, so a newer export repeats every card the
//! last one had. The import counts copies instead of replaying rows:
//!
//! - **A copy kind** is printing (Scryfall ID) + finish + language + proxy. Condition, altered,
//!   signed and misprint don't count: condition is noisy between scans (the same card is NM in one
//!   export and LP in the next), and the flags are rare enough that a re-scan disagreeing on them
//!   shouldn't double a card. A copy that is added takes the file row's condition and flags.
//! - **F** is the file's total of a copy kind across all its rows; **Y** is Yama's total across
//!   all the owner's containers and unfiled. If F > Y, F − Y copies are added to the containers
//!   the file puts them in (where the file has more than Yama, in the file's order). If F ≤ Y
//!   nothing is added: copies stay wherever Yama has them, so a card moved in Yama from Mythic's
//!   "bulk" box into a deck box is neither put back nor doubled.
//! - **Never removed on its own.** Copies in a container the file names, beyond what the file
//!   lists there, are reported as "no longer in this export". `remove_missing` (a checkbox on the
//!   web, `--remove-missing` on the command line) removes them; removal comes first, so a card
//!   Mythic moved from one named container to another moves in Yama too. Containers the file
//!   doesn't name, and unfiled copies, are never touched.
//! - **The same file again changes nothing:** files are remembered by hash (`mythic_imports`, and
//!   for files imported before that table, their `mythic:<hash>:<row>` op ids). Its removals can
//!   still be asked for.
//! - `dry_run` plans everything and writes nothing (not even new containers): the web's preview.
//!
//! Deck containers in the file become Yama decks, or update the decks they made
//! (`decks::sync_deck_from_container`). A deck made another way whose box the file names keeps
//! its list.

use super::{CopyKind, KINDS, Op, OpKind, OwnedCopy, apply_op, en, ensure_container, nm, nonfoil, op_stamp, owned_copies};
use crate::auth::CurrentUser;
use crate::decks::ContainerSync;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{now, sha256_hex};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/collection/import/mythic", post(import_mythic).layer(DefaultBodyLimit::max(MYTHIC_MAX_BYTES)))
}

/// One row of a Mythic Tools export. Column names are Mythic Tools' own.
#[derive(Debug, Deserialize)]
struct MythicRow {
    #[serde(rename = "Card Name")]
    name: String,
    #[serde(rename = "Set Code")]
    set_code: String,
    #[serde(rename = "Collector Number")]
    collector_number: String,
    #[serde(rename = "Language", default)]
    lang: String,
    #[serde(rename = "Quantity")]
    qty: i64,
    #[serde(rename = "Condition", default)]
    condition: String,
    #[serde(rename = "Finish", default)]
    finish: String,
    #[serde(rename = "Altered", default)]
    altered: Option<bool>,
    #[serde(rename = "Signed", default)]
    signed: Option<bool>,
    #[serde(rename = "Misprint", default)]
    misprint: Option<bool>,
    #[serde(rename = "Proxy", default)]
    proxy: Option<bool>,
    #[serde(rename = "Scryfall ID", default)]
    scryfall_id: String,
    #[serde(rename = "Container Type", default)]
    container_type: String,
    #[serde(rename = "Container Name", default)]
    container_name: String,
    #[serde(rename = "Purchase Price (USD)", default)]
    purchase_usd: Option<f64>,
}

/// Cards added, missing or kept elsewhere, as the preview lists them.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Change {
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: String,
    pub lang: String,
    pub proxy: bool,
    /// The container, as people read it ("box: bulk"), or "unfiled".
    pub place: String,
    pub qty: i64,
    /// For copies kept where they were moved: where Yama has them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub now_in: Vec<String>,
}

#[derive(Serialize, Debug, Default)]
pub struct MythicReport {
    /// A preview: nothing was written.
    pub dry_run: bool,
    pub remove_missing: bool,
    /// When this exact file was imported before. Nothing is added from it again.
    pub already_imported: Option<String>,
    pub rows: usize,
    /// Copies the file lists.
    pub copies: i64,
    /// Containers the file names, "bulk (box)", and those Yama doesn't have yet.
    pub containers: Vec<String>,
    pub new_containers: Vec<String>,
    /// Yama containers of the same name and another type that take the file's type: "bulk (list to box)".
    pub retyped_containers: Vec<String>,
    /// Copies added (to add, in a preview).
    pub added: i64,
    pub added_cards: Vec<Change>,
    /// Copies the file lists that Yama has already, wherever they are.
    pub already_in_yama: i64,
    /// Of those, copies Yama has somewhere other than where the file puts them (moved in Yama,
    /// into a deck box say, or filed elsewhere). They stay where they are.
    pub kept_where_moved: i64,
    pub kept_cards: Vec<Change>,
    /// Copies in the containers the file names that the file no longer lists there.
    pub missing: i64,
    pub missing_cards: Vec<Change>,
    /// Of those, copies removed (only with `remove_missing`).
    pub removed: i64,
    /// Rows whose Scryfall ID isn't in Yama's card data (yet). They're imported anyway.
    pub unknown_printings: Vec<String>,
    pub errors: Vec<String>,
    /// The file's deck containers, each a Yama deck.
    pub deck_containers: Vec<String>,
    pub decks_created: Vec<String>,
    pub decks_updated: Vec<String>,
    /// Deck containers whose Yama deck wasn't made from a Mythic Tools file (its box, from "Add
    /// to my collection"): the deck keeps its own list.
    pub decks_kept: Vec<String>,
}

/// Largest Mythic Tools CSV: about 20,000 rows (an export runs about 210 bytes a row). Larger
/// bodies get 413.
pub const MYTHIC_MAX_BYTES: usize = 4 << 20;
/// The same for an account that joined without an invite: about 5,000 rows.
pub const OPEN_MYTHIC_MAX_BYTES: usize = 1 << 20;

#[derive(Default, Clone, Copy, Debug)]
pub struct ImportOptions {
    pub dry_run: bool,
    pub remove_missing: bool,
}

/// `?dry_run=1&remove_missing=1` ("true" and "yes" work too).
#[derive(Deserialize)]
struct ImportQuery {
    dry_run: Option<String>,
    remove_missing: Option<String>,
}

fn truthy(v: &Option<String>) -> bool {
    v.as_deref().is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

async fn import_mythic(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<ImportQuery>, body: String) -> AppResult<Json<MythicReport>> {
    let opts = ImportOptions { dry_run: truthy(&q.dry_run), remove_missing: truthy(&q.remove_missing) };
    st.limits.imports.check_user(&user)?;
    if user.limited && body.len() > OPEN_MYTHIC_MAX_BYTES {
        return Err(AppError::bad(format!(
            "That file is {} KB. Accounts that joined without an invite can import up to {} KB at a time.",
            body.len() / 1024,
            OPEN_MYTHIC_MAX_BYTES / 1024
        )));
    }
    Ok(Json(import_mythic_csv(&st.pool, &user.id, &body, opts).await?))
}

/// What makes copies interchangeable for counting: printing, finish, language, proxy.
type Key = (String, String, String, bool);

/// A file row, read and resolved.
struct FileCopy {
    key: Key,
    name: String,
    set_code: String,
    collector_number: String,
    copy: CopyKind,
    /// Index into the file's containers; `None` for unfiled.
    place: Option<usize>,
    qty: i64,
    purchase_price: Option<f64>,
}

/// Import (or with `dry_run`, preview) a Mythic Tools CSV export. See the module notes.
pub async fn import_mythic_csv(pool: &SqlitePool, owner: &str, text: &str, opts: ImportOptions) -> AppResult<MythicReport> {
    let text = text.trim_start_matches('\u{feff}');
    let file_hash = sha256_hex(text);
    let short = &file_hash[..16];
    let mut report = MythicReport { dry_run: opts.dry_run, remove_missing: opts.remove_missing, ..Default::default() };
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for (i, rec) in reader.deserialize::<MythicRow>().enumerate() {
        match rec {
            Ok(r) => rows.push((i, r)),
            Err(e) => report.errors.push(format!("row {}: {e}", i + 2)),
        }
    }
    report.rows = rows.len();

    report.already_imported = sqlx::query_scalar(
        "SELECT MIN(at) FROM (SELECT imported_at AS at FROM mythic_imports WHERE owner_id = ?1 AND file_hash = ?2
         UNION ALL SELECT applied_at FROM applied_ops WHERE owner_id = ?1 AND op_id LIKE 'mythic:' || ?3 || ':%')",
    )
    .bind(owner)
    .bind(&file_hash)
    .bind(short)
    .fetch_one(pool)
    .await?;

    // The file's containers, in file order. A preview makes none: one Yama doesn't have yet gets a
    // stand-in id that matches nothing.
    let kind_of = |r: &MythicRow| {
        let k = r.container_type.to_lowercase();
        if KINDS.contains(&k.as_str()) { k } else { "list".to_string() }
    };
    let mut places: Vec<(String, String)> = Vec::new();
    for (_, r) in &rows {
        let name = r.container_name.trim();
        if !name.is_empty() && !places.iter().any(|(k, n)| *k == kind_of(r) && n == name) {
            places.push((kind_of(r), name.to_string()));
        }
    }
    let mut place_ids: Vec<String> = Vec::new();
    for (i, (kind, name)) in places.iter().enumerate() {
        let mut existing: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = ? AND name = ?")
            .bind(owner)
            .bind(kind)
            .bind(name)
            .fetch_optional(pool)
            .await?;
        // Mythic Tools lets a container change type (Bryan's "bulk" was a list on 2026-10-09 and a
        // box by 10-18). The one container of that name and another type is the same place: it
        // takes the file's type. Decks are left out both ways, as a deck container makes a deck.
        if existing.is_none() && kind != "deck" {
            let others: Vec<(String, String)> = sqlx::query_as("SELECT id, kind FROM containers WHERE owner_id = ? AND name = ? AND kind != 'deck'")
                .bind(owner)
                .bind(name)
                .fetch_all(pool)
                .await?;
            if let [(id, was)] = &others[..]
                && !places.iter().any(|(k, n)| n == name && k == was)
            {
                report.retyped_containers.push(format!("{name} ({was} to {kind})"));
                if !opts.dry_run {
                    sqlx::query("UPDATE containers SET kind = ? WHERE id = ? AND owner_id = ?").bind(kind).bind(id).bind(owner).execute(pool).await?;
                }
                existing = Some(id.clone());
            }
        }
        report.containers.push(format!("{name} ({kind})"));
        if existing.is_none() {
            report.new_containers.push(format!("{name} ({kind})"));
        }
        if kind == "deck" {
            report.deck_containers.push(name.clone());
        }
        place_ids.push(match (existing, opts.dry_run) {
            (Some(id), _) => id,
            (None, true) => format!("new:{i}"),
            (None, false) => ensure_container(pool, owner, kind, name).await?,
        });
    }
    let place_label = |p: Option<usize>| p.map_or("unfiled".to_string(), |i| format!("{}: {}", places[i].0, places[i].1));

    let mut tx = pool.begin().await?;
    let mut file: Vec<FileCopy> = Vec::new();
    for (i, r) in rows {
        if r.qty <= 0 {
            continue;
        }
        let scryfall_id = if !r.scryfall_id.trim().is_empty() {
            r.scryfall_id.trim().to_string()
        } else {
            // Fall back to set + number.
            let found: Option<String> = sqlx::query_scalar(
                "SELECT scryfall_id FROM printings WHERE set_code = ? AND collector_number = ? ORDER BY (lang = ?) DESC LIMIT 1",
            )
            .bind(r.set_code.to_lowercase())
            .bind(&r.collector_number)
            .bind(&r.lang)
            .fetch_optional(&mut *tx)
            .await?;
            match found {
                Some(id) => id,
                None => {
                    report.errors.push(format!("row {}: {} ({} {}) has no Scryfall ID and isn't in our card data", i + 2, r.name, r.set_code, r.collector_number));
                    continue;
                }
            }
        };
        let known: Option<String> = sqlx::query_scalar("SELECT scryfall_id FROM printings WHERE scryfall_id = ?").bind(&scryfall_id).fetch_optional(&mut *tx).await?;
        if known.is_none() {
            report.unknown_printings.push(format!("{} ({} #{})", r.name, r.set_code.to_uppercase(), r.collector_number));
        }
        let copy = CopyKind {
            condition: if r.condition.is_empty() { nm() } else { r.condition.to_uppercase() },
            finish: match r.finish.to_lowercase().as_str() {
                "foil" => "foil".into(),
                "etched" => "etched".into(),
                _ => nonfoil(),
            },
            lang: if r.lang.is_empty() { en() } else { r.lang.to_lowercase() },
            altered: r.altered.unwrap_or(false),
            signed: r.signed.unwrap_or(false),
            misprint: r.misprint.unwrap_or(false),
            proxy: r.proxy.unwrap_or(false),
        };
        let name = r.container_name.trim();
        let place = (!name.is_empty()).then(|| places.iter().position(|(k, n)| *k == kind_of(&r) && n == name).expect("collected above"));
        report.copies += r.qty;
        file.push(FileCopy {
            key: (scryfall_id, copy.finish.clone(), copy.lang.clone(), copy.proxy),
            name: r.name,
            set_code: r.set_code.to_lowercase(),
            collector_number: r.collector_number,
            copy,
            place,
            qty: r.qty,
            // Mythic writes 0 when no purchase price was entered; that's unknown, not free.
            purchase_price: r.purchase_usd.filter(|p| *p > 0.0),
        });
    }

    // Where things are: the file by place index, Yama by container id. `loc` is a container id
    // (or a preview's stand-in), `None` for unfiled.
    let loc_of = |p: Option<usize>| p.map(|i| place_ids[i].clone());
    let copies = owned_copies(&mut tx, owner).await?;
    let key_of = |c: &OwnedCopy| (c.scryfall_id.clone(), c.finish.clone(), c.lang.clone(), c.proxy);
    let mut file_total: HashMap<Key, i64> = HashMap::new();
    let mut file_at: HashMap<(Key, Option<String>), i64> = HashMap::new();
    // Rows and copies by kind, so a 20,000-row file isn't searched once per card.
    let mut rows_of: HashMap<Key, Vec<usize>> = HashMap::new();
    let mut keys: Vec<Key> = Vec::new();
    for (i, f) in file.iter().enumerate() {
        if !file_total.contains_key(&f.key) {
            keys.push(f.key.clone());
        }
        *file_total.entry(f.key.clone()).or_insert(0) += f.qty;
        *file_at.entry((f.key.clone(), loc_of(f.place))).or_insert(0) += f.qty;
        rows_of.entry(f.key.clone()).or_default().push(i);
    }
    let mut copies_of: HashMap<Key, Vec<usize>> = HashMap::new();
    for (i, c) in copies.iter().enumerate() {
        copies_of.entry(key_of(c)).or_default().push(i);
    }
    // Yama's rows, with what's left of each after removals.
    let mut left: Vec<i64> = copies.iter().map(|c| c.qty).collect();
    let mut ops: Vec<(String, OpKind)> = Vec::new();
    let stamp = op_stamp(&mut tx, owner).await?;

    // No longer in this export: in a container the file names, more copies than the file lists
    // there. Row by row, so the list can say which.
    let named: Vec<String> = place_ids.clone();
    let mut surplus_at: HashMap<(Key, String), i64> = HashMap::new();
    for c in &copies {
        if let Some(id) = &c.container_id
            && named.contains(id)
        {
            *surplus_at.entry((key_of(c), id.clone())).or_insert(0) += c.qty;
        }
    }
    for ((key, id), have) in surplus_at.iter_mut() {
        *have -= file_at.get(&(key.clone(), Some(id.clone()))).copied().unwrap_or(0);
    }
    for (i, c) in copies.iter().enumerate() {
        let Some(id) = &c.container_id else { continue };
        let Some(surplus) = surplus_at.get_mut(&(key_of(c), id.clone())) else { continue };
        if *surplus <= 0 {
            continue;
        }
        let take = (*surplus).min(c.qty);
        *surplus -= take;
        report.missing += take;
        report.missing_cards.push(Change {
            name: c.name.clone().unwrap_or_else(|| format!("Unknown printing {}", c.scryfall_id)),
            set_code: c.set_code.clone().unwrap_or_default(),
            collector_number: c.collector_number.clone().unwrap_or_default(),
            finish: c.finish.clone(),
            lang: c.lang.clone(),
            proxy: c.proxy,
            place: c.place(),
            qty: take,
            now_in: vec![],
        });
        if opts.remove_missing {
            left[i] -= take;
            report.removed += take;
            ops.push((format!("mythic:{short}:remove:{stamp}:{}", ops.len()), OpKind::Adjust { item_id: c.id.clone(), delta: -take }));
        }
    }

    // Adds: F − Y copies of each kind, where the file has more than Yama.
    let mut yama_total: HashMap<Key, i64> = HashMap::new();
    let mut yama_at: HashMap<(Key, Option<String>), i64> = HashMap::new();
    for (i, c) in copies.iter().enumerate() {
        *yama_total.entry(key_of(c)).or_insert(0) += left[i];
        *yama_at.entry((key_of(c), c.container_id.clone())).or_insert(0) += left[i];
    }
    for key in &keys {
        let f = file_total[key];
        let y = yama_total.get(key).copied().unwrap_or(0);
        report.already_in_yama += f.min(y);
        let mut need = if report.already_imported.is_some() { 0 } else { (f - y).max(0) };
        let mut short_by = 0;
        let mut first_short: Option<Option<usize>> = None;
        let rows = &rows_of[key];
        let mine_all: &[usize] = copies_of.get(key).map_or(&[], Vec::as_slice);
        let mut locs: Vec<Option<usize>> = Vec::new();
        for &r in rows {
            if !locs.contains(&file[r].place) {
                locs.push(file[r].place);
            }
        }
        for place in locs {
            let loc = loc_of(place);
            let here = yama_at.get(&(key.clone(), loc.clone())).copied().unwrap_or(0);
            let deficit = file_at[&(key.clone(), loc.clone())] - here;
            if deficit <= 0 {
                continue;
            }
            short_by += deficit;
            first_short.get_or_insert(place);
            let take = deficit.min(need);
            if take == 0 {
                continue;
            }
            need -= take;
            // Which rows: Yama's copies here stand for the file's rows of the same condition
            // first, then any; the copies added are what's left.
            let rows_here: Vec<&FileCopy> = rows.iter().map(|&r| &file[r]).filter(|fc| fc.place == place).collect();
            let mut open: Vec<i64> = rows_here.iter().map(|r| r.qty).collect();
            let mine: Vec<(usize, &OwnedCopy)> = mine_all.iter().map(|&i| (i, &copies[i])).filter(|(_, c)| c.container_id == loc).collect();
            let mut have: Vec<i64> = mine.iter().map(|(i, _)| left[*i]).collect();
            for same_condition in [true, false] {
                for (m, (_, c)) in mine.iter().enumerate() {
                    for (r, row) in rows_here.iter().enumerate() {
                        if same_condition && row.copy.condition != c.condition {
                            continue;
                        }
                        let t = have[m].min(open[r]);
                        open[r] -= t;
                        have[m] -= t;
                    }
                }
            }
            let mut to_add = take;
            for (r, row) in rows_here.iter().enumerate() {
                let n = open[r].min(to_add);
                if n == 0 {
                    continue;
                }
                to_add -= n;
                report.added += n;
                report.added_cards.push(Change {
                    name: row.name.clone(),
                    set_code: row.set_code.clone(),
                    collector_number: row.collector_number.clone(),
                    finish: row.copy.finish.clone(),
                    lang: row.copy.lang.clone(),
                    proxy: row.copy.proxy,
                    place: place_label(place),
                    qty: n,
                    now_in: vec![],
                });
                ops.push((
                    format!("mythic:{short}:add:{}", ops.len()),
                    OpKind::Add {
                        scryfall_id: key.0.clone(),
                        qty: n,
                        copy: row.copy.clone(),
                        container_id: loc.clone(),
                        purchase_price: row.purchase_price,
                        purchase_currency: row.purchase_price.map(|_| "USD".into()),
                    },
                ));
            }
        }
        // Short where the file puts them, but Yama has them elsewhere: kept where they are.
        let kept = short_by - ((f - y).max(0)).min(short_by);
        if kept > 0 && report.already_imported.is_none() {
            let sample = &file[rows[0]];
            let mut now_in: Vec<String> = mine_all
                .iter()
                .filter(|&&i| left[i] > 0 && !file_at.contains_key(&(key.clone(), copies[i].container_id.clone())))
                .map(|&i| copies[i].place())
                .collect();
            now_in.sort();
            now_in.dedup();
            report.kept_where_moved += kept;
            report.kept_cards.push(Change {
                name: sample.name.clone(),
                set_code: sample.set_code.clone(),
                collector_number: sample.collector_number.clone(),
                finish: key.1.clone(),
                lang: key.2.clone(),
                proxy: key.3,
                place: place_label(first_short.flatten()),
                qty: kept,
                now_in,
            });
        }
    }

    if opts.dry_run {
        return Ok(report);
    }
    for (op_id, op) in ops {
        apply_op(&mut tx, owner, &Op { op_id, device_id: Some("mythic-import".into()), op }).await?;
    }
    let summary = serde_json::json!({ "rows": report.rows, "copies": report.copies, "added": report.added, "removed": report.removed });
    sqlx::query("INSERT INTO mythic_imports (owner_id, file_hash, imported_at, report) VALUES (?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(&file_hash)
        .bind(now())
        .bind(summary.to_string())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Mythic Tools keeps decks as containers of kind "deck": make each one a real Yama deck too.
    for (i, (kind, name)) in places.iter().enumerate() {
        if kind == "deck" {
            match crate::decks::sync_deck_from_container(pool, owner, &place_ids[i], name).await? {
                ContainerSync::Created => report.decks_created.push(name.clone()),
                ContainerSync::Updated => report.decks_updated.push(name.clone()),
                ContainerSync::NotFromMythic => report.decks_kept.push(name.clone()),
                ContainerSync::Unchanged => {}
            }
        }
    }
    Ok(report)
}

/// The report as the command line prints it.
pub fn text(r: &MythicReport) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "{} rows, {} copies in the file{}", r.rows, r.copies, if r.dry_run { " (dry run: nothing changed)" } else { "" });
    if let Some(at) = &r.already_imported {
        let _ = writeln!(out, "This exact file was imported on {}; nothing is added from it again.", &at[..at.len().min(10)]);
    }
    if !r.containers.is_empty() {
        let _ = writeln!(out, "Containers: {}", r.containers.join(", "));
    }
    if !r.new_containers.is_empty() {
        let _ = writeln!(out, "New containers: {}", r.new_containers.join(", "));
    }
    if !r.retyped_containers.is_empty() {
        let _ = writeln!(out, "Same container, new type as in the file: {}", r.retyped_containers.join(", "));
    }
    let _ = writeln!(out, "{} {}", if r.dry_run { "To add:" } else { "Added:" }, copies(r.added));
    for c in &r.added_cards {
        let _ = writeln!(out, "  + {} {}", c.qty, line(c));
    }
    let _ = writeln!(out, "Already in Yama: {}", copies(r.already_in_yama));
    if r.kept_where_moved > 0 {
        let _ = writeln!(out, "Somewhere else in Yama than the file says, kept there: {}", copies(r.kept_where_moved));
        for c in &r.kept_cards {
            let _ = writeln!(out, "  = {} {} (now in {})", c.qty, line(c), c.now_in.join(", "));
        }
    }
    if r.missing > 0 {
        let what = if r.remove_missing {
            if r.dry_run { "removing" } else { "removed" }
        } else {
            "kept; --remove-missing removes them"
        };
        let _ = writeln!(out, "No longer in this export: {} ({what})", copies(r.missing));
        for c in &r.missing_cards {
            let _ = writeln!(out, "  - {} {}", c.qty, line(c));
        }
    }
    if !r.deck_containers.is_empty() {
        let _ = writeln!(out, "Deck containers (each a Yama deck): {}", r.deck_containers.join(", "));
    }
    for (label, list) in [
        ("New decks", &r.decks_created),
        ("Updated decks", &r.decks_updated),
        ("Decks made in Yama keep their lists", &r.decks_kept),
        ("Not in Yama's card data (kept anyway)", &r.unknown_printings),
    ] {
        if !list.is_empty() {
            let _ = writeln!(out, "{label}: {}", list.join(", "));
        }
    }
    for e in &r.errors {
        let _ = writeln!(out, "error: {e}");
    }
    out
}

/// "1 copy", "3 copies".
pub(crate) fn copies(n: i64) -> String {
    format!("{n} {}", if n == 1 { "copy" } else { "copies" })
}

fn line(c: &Change) -> String {
    let mut s = format!("{} ({} {}", c.name, c.set_code.to_uppercase(), c.collector_number);
    if c.finish != "nonfoil" {
        s.push_str(&format!(", {}", c.finish));
    }
    if c.lang != "en" {
        s.push_str(&format!(", {}", c.lang));
    }
    if c.proxy {
        s.push_str(", proxy");
    }
    s.push_str(&format!(") in {}", c.place));
    s
}

#[cfg(test)]
mod tests;
