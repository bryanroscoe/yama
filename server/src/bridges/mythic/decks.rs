//! Decks both ways between Mythic Tools and Yama (ARCHITECTURE.md, "Mythic Tools bridge").
//!
//! - **Import.** The snippet's file also carries the person's Mythic decks with their lists. Each
//!   is linked to a Yama deck with the same commander, imported as a new deck in the "Mythic
//!   Tools" folder, or skipped. A linked deck whose Mythic list changed gets a new Yama version.
//! - **Send.** A Yama deck goes to Mythic through a second snippet the deck page makes, run on
//!   mythic.tools like the first, so Mythic's credentials still never reach Yama. It creates the
//!   Mythic deck, or brings the linked one up to date, then opens Yama again with the Mythic
//!   deck's id, which links them. The snippet carries a one-time code from `send`, so only a send
//!   this person started can link a deck.
//!
//! A deck link remembers the list both sides had when they last matched (`mythic_changed` is
//! "<list print> <Yama version id>"), so the next import can tell which side changed.

use super::{Applied, GameError, MAX_BYTES, clean, id_of, link_in, links};
use crate::auth::CurrentUser;
use crate::deck_import::DeckPrint;
use crate::decks::{Board, DeckCard, ParsedLine};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};

/// The folder imported decks go in.
const FOLDER: &str = "Mythic Tools";
const MAX_DECKS: usize = 1000;
/// How long a send's code waits for the snippet to come back.
const SEND_HOURS: i64 = 24;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bridges/mythic/decks/preview", post(preview).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/bridges/mythic/decks/apply", post(apply).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/bridges/mythic/decks/sent", post(sent))
        .route("/api/bridges/mythic/decks/{id}", get(status).delete(unlink))
        .route("/api/bridges/mythic/decks/{id}/send", post(send))
}

// ── the file ───────────────────────────────────────────────────────────────────────────────

/// The decks part of the snippet's file: `{decks: [{id, name, formatid, cards: [...]}]}`.
#[derive(Deserialize)]
struct DeckFile {
    #[serde(default)]
    decks: Vec<MList>,
}

#[derive(Deserialize)]
struct MList {
    id: Value,
    name: Option<String>,
    formatid: Option<i64>,
    #[serde(default)]
    cards: Vec<MCard>,
}

/// One pile of a Mythic deck's main list, as the snippet keeps it.
#[derive(Deserialize)]
struct MCard {
    name: Option<String>,
    oracle_id: Option<String>,
    set_code: Option<String>,
    collector_number: Option<String>,
    finish: Option<String>,
    quantity: Option<i64>,
    /// In the list's Commander group.
    #[serde(default)]
    commander: bool,
}

#[derive(Deserialize)]
struct DeckRequest {
    export: DeckFile,
    /// Per Mythic deck: "skip", "import" (a new Yama deck), "link:<Yama deck id>", or for a deck
    /// linked before, "update" (Mythic's list replaces Yama's) or "keep" (Yama's stays).
    #[serde(default)]
    choices: HashMap<String, String>,
}

/// What Yama compares of a list: commander and main deck, by card and count, sideboard aside.
pub(super) fn list_print(cards: &[DeckCard]) -> String {
    let mut rows: BTreeMap<(bool, &str), i64> = BTreeMap::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        *rows.entry((c.board == Board::Commander, c.oracle_id.as_str())).or_default() += c.qty;
    }
    // Sorted as text, as the send snippet sorts the list it prints in the browser.
    let mut text: Vec<String> = rows.into_iter().map(|((commander, oracle), qty)| format!("{}:{oracle}:{qty}", if commander { "c" } else { "m" })).collect();
    text.sort();
    crate::util::sha256_hex(&text.join("\n"))
}

fn commanders(cards: &[DeckCard]) -> Vec<&str> {
    let mut c: Vec<&str> = cards.iter().filter(|c| c.board == Board::Commander).map(|c| c.oracle_id.as_str()).collect();
    c.sort_unstable();
    c.dedup();
    c
}

/// A Mythic list in Yama's cards, by Scryfall oracle id (which Mythic keeps), else by name. Also
/// the printings Mythic names, to keep with the deck, and the names Yama doesn't know.
async fn resolve(pool: &SqlitePool, cards: &[MCard]) -> AppResult<(Vec<DeckCard>, Vec<DeckPrint>, Vec<String>)> {
    let mut rows: BTreeMap<(bool, String), (String, i64)> = BTreeMap::new();
    let (mut prints, mut unknown) = (Vec::new(), Vec::new());
    for c in cards {
        let qty = c.quantity.unwrap_or(1).clamp(1, 250);
        let known: Option<(String, String)> = match c.oracle_id.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
            Some(o) => sqlx::query_as("SELECT oracle_id, name FROM cards WHERE oracle_id = ?").bind(o).fetch_optional(pool).await?,
            None => None,
        };
        let (oracle, name) = match known {
            Some(k) => k,
            None => {
                let Some(name) = clean(&c.name) else { continue };
                let r = crate::decks::resolve(pool, vec![ParsedLine { qty, name: name.clone(), board: Board::Main }]).await?;
                match r.cards.into_iter().next() {
                    Some(card) => (card.oracle_id, card.name),
                    None => {
                        unknown.push(name);
                        continue;
                    }
                }
            }
        };
        if let Some(set_code) = clean(&c.set_code) {
            prints.push(DeckPrint {
                oracle_id: oracle.clone(),
                set_code,
                collector_number: clean(&c.collector_number),
                finish: c.finish.clone().unwrap_or_else(|| "nonfoil".into()),
                proxy: false,
            });
        }
        rows.entry((!c.commander, oracle)).or_insert((name, 0)).1 += qty;
    }
    let cards = rows
        .into_iter()
        .map(|((main, oracle_id), (name, qty))| DeckCard { oracle_id, name, qty, board: if main { Board::Main } else { Board::Commander } })
        .collect();
    Ok((cards, prints, unknown))
}

// ── preview and apply ──────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct DeckMatch {
    id: String,
    name: String,
}

struct Planned {
    mythic_id: String,
    name: String,
    status: &'static str,
    action: &'static str,
    yama_id: Option<String>,
    /// The Yama deck's version when previewed: Apply leaves a deck edited since then alone.
    seen_version: Option<String>,
    matches: Vec<DeckMatch>,
    cards: Vec<DeckCard>,
    prints: Vec<DeckPrint>,
    unknown: Vec<String>,
    print: String,
    reason: Option<String>,
}

#[derive(Serialize)]
struct DeckRow {
    mythic_id: String,
    name: String,
    status: &'static str,
    action: &'static str,
    yama_id: Option<String>,
    yama_name: Option<String>,
    matches: Vec<DeckMatch>,
    cards: i64,
    commanders: Vec<String>,
    unknown: Vec<String>,
    reason: Option<String>,
}

/// One of the person's Yama decks, to match or compare.
struct YamaDeck {
    id: String,
    name: String,
    version: Option<String>,
    cards: Vec<DeckCard>,
}

async fn yama_decks(pool: &SqlitePool, owner: &str) -> AppResult<HashMap<String, YamaDeck>> {
    let rows: Vec<(String, String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT d.id, d.name, d.current_version_id, v.cards, d.archived FROM decks d
           LEFT JOIN deck_versions v ON v.id = d.current_version_id WHERE d.owner_id = ?",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, version, cards, archived)| {
            let cards = cards.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
            // Archived decks stay linkable by an earlier link, but aren't offered as matches.
            let name = if archived != 0 { format!("{name} (archived)") } else { name };
            (id.clone(), YamaDeck { id, name, version, cards })
        })
        .collect())
}

async fn plan(pool: &SqlitePool, owner: &str, req: &DeckRequest) -> AppResult<Vec<Planned>> {
    if req.export.decks.len() > MAX_DECKS {
        return Err(AppError::bad(format!("an upload can hold at most {MAX_DECKS} decks")));
    }
    let deck_links = links(pool, owner, "deck").await?;
    let linked_yama: HashSet<&str> = deck_links.values().map(|(y, _)| y.as_str()).collect();
    let mine = yama_decks(pool, owner).await?;
    let archived: HashSet<String> =
        sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = ? AND archived != 0").bind(owner).fetch_all(pool).await?.into_iter().collect();
    let mut chosen: HashSet<String> = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut out = Vec::new();
    for m in &req.export.decks {
        let Some(mythic_id) = id_of(&m.id) else {
            return Err(AppError::bad("a deck in the file has no Mythic id"));
        };
        if !seen_ids.insert(mythic_id.clone()) {
            continue;
        }
        let choice = req.choices.get(&mythic_id).map(String::as_str);
        let (cards, prints, unknown) = resolve(pool, &m.cards).await?;
        let print = list_print(&cards);
        let name = clean(&m.name).unwrap_or_else(|| format!("Mythic deck {mythic_id}"));
        let mut p = Planned {
            mythic_id,
            name,
            status: "new",
            action: "import",
            yama_id: None,
            seen_version: None,
            matches: vec![],
            cards,
            prints,
            unknown,
            print,
            reason: None,
        };
        if m.formatid != Some(6) {
            (p.status, p.action, p.reason) = ("invalid", "skip", Some("only Commander decks are imported for now".into()));
            out.push(p);
            continue;
        }
        if p.cards.is_empty() {
            (p.status, p.action, p.reason) = ("invalid", "skip", Some("Yama knows none of its cards".into()));
            out.push(p);
            continue;
        }

        if let Some((yama, saved)) = deck_links.get(&p.mythic_id) {
            p.yama_id = Some(yama.clone());
            let Some(deck) = mine.get(yama) else {
                (p.status, p.action) = ("deleted", "skip");
                out.push(p);
                continue;
            };
            p.seen_version = deck.version.clone();
            let saved = saved.as_deref().and_then(|s| s.split(' ').next()).unwrap_or_default();
            let here = list_print(&deck.cards);
            let (mythic_changed, yama_changed) = (p.print != saved, here != saved);
            (p.status, p.action) = if p.print == here {
                ("unchanged", "skip")
            } else {
                match (mythic_changed, yama_changed) {
                    (true, false) if choice == Some("skip") => ("update", "skip"),
                    (true, false) => ("update", "update"),
                    // Changed in Yama only: the deck page sends it to Mythic. Taking Mythic's list
                    // instead is the person's choice.
                    (false, _) => ("yama_changed", if choice == Some("update") { "update" } else { "skip" }),
                    (true, true) => (
                        "conflict",
                        match choice {
                            Some("update") => "update",
                            Some("keep") => "keep",
                            _ => "skip",
                        },
                    ),
                }
            };
            out.push(p);
            continue;
        }

        // Yama decks with the same commanders, not linked to another Mythic deck: same name first.
        let theirs = commanders(&p.cards);
        let mut matches: Vec<&YamaDeck> = mine
            .values()
            .filter(|d| !archived.contains(&d.id) && !linked_yama.contains(d.id.as_str()) && !theirs.is_empty() && commanders(&d.cards) == theirs)
            .collect();
        matches.sort_by_key(|d| (d.name.trim().to_lowercase() != p.name.trim().to_lowercase(), d.name.clone()));
        p.matches = matches.iter().take(5).map(|d| DeckMatch { id: d.id.clone(), name: d.name.clone() }).collect();
        let link_to = |p: &mut Planned, target: &str, chosen: &mut HashSet<String>| -> AppResult<()> {
            if !chosen.insert(target.to_string()) {
                return Err(AppError::Conflict("that Yama deck is already chosen for another Mythic deck".into()));
            }
            (p.status, p.action, p.yama_id) = ("match", "link", Some(target.to_string()));
            p.seen_version = mine.get(target).and_then(|d| d.version.clone());
            Ok(())
        };
        match choice {
            Some("skip") => (p.status, p.action) = (if p.matches.is_empty() { "new" } else { "match" }, "skip"),
            Some("import") => (p.status, p.action) = (if p.matches.is_empty() { "new" } else { "match" }, "import"),
            Some(c) if c.starts_with("link:") => {
                let target = &c["link:".len()..];
                if !p.matches.iter().any(|m| m.id == target) {
                    return Err(AppError::Conflict("that Yama deck isn't a match for this Mythic deck any more; preview again".into()));
                }
                link_to(&mut p, target, &mut chosen)?;
            }
            Some(other) => return Err(AppError::bad(format!("unknown choice {other:?}"))),
            // One deck with the same commander: it's that deck, unless another Mythic deck in
            // this file was matched to it first.
            None if p.matches.len() == 1 && !chosen.contains(&p.matches[0].id) => {
                let target = p.matches[0].id.clone();
                link_to(&mut p, &target, &mut chosen)?;
            }
            None if !p.matches.is_empty() => (p.status, p.action) = ("match", "skip"),
            None => {}
        }
        out.push(p);
    }
    Ok(out)
}

async fn preview(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<DeckRequest>) -> AppResult<Json<Value>> {
    st.limits.mythic_bridge.check_user(&user)?;
    let plan = plan(&st.pool, &user.id, &req).await?;
    let mine = yama_decks(&st.pool, &user.id).await?;
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    let decks: Vec<DeckRow> = plan
        .into_iter()
        .map(|p| {
            *counts.entry(p.status).or_default() += 1;
            let yama_name = p.yama_id.as_ref().and_then(|y| mine.get(y)).map(|d| d.name.clone());
            DeckRow {
                cards: p.cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum(),
                commanders: p.cards.iter().filter(|c| c.board == Board::Commander).map(|c| c.name.clone()).collect(),
                mythic_id: p.mythic_id,
                name: p.name,
                status: p.status,
                action: p.action,
                yama_id: p.yama_id,
                yama_name,
                matches: p.matches,
                unknown: p.unknown,
                reason: p.reason,
            }
        })
        .collect();
    Ok(Json(json!({ "decks": decks, "counts": counts })))
}

async fn apply(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<DeckRequest>) -> AppResult<Json<Applied>> {
    st.limits.mythic_bridge.check_user(&user)?;
    let pool = &st.pool;
    let owner = user.id.as_str();
    let mut out = Applied::default();
    for p in plan(pool, owner, &req).await? {
        let result = match p.action {
            "import" => import_deck(pool, owner, &p).await.map(|_| ()),
            "update" | "link" | "keep" => sync_deck(pool, owner, &p).await,
            _ => {
                out.skipped += 1;
                continue;
            }
        };
        match result {
            Ok(()) => match p.action {
                "import" => out.created += 1,
                "update" => out.updated += 1,
                "keep" => out.kept += 1,
                _ => out.linked += 1,
            },
            Err(e) => out.errors.push(GameError { mythic_id: p.mythic_id, error: e.to_string() }),
        }
    }
    crate::deck_checks::wake();
    Ok(Json(out))
}

/// A Mythic deck as a new Yama deck, linked, in one commit.
async fn import_deck(pool: &SqlitePool, owner: &str, p: &Planned) -> AppResult<String> {
    let mut tx = pool.begin().await?;
    let id = crate::decks::create_deck_in(&mut tx, owner, &p.name, Some(FOLDER), &p.cards, "Imported from Mythic Tools").await?;
    let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&id).fetch_one(&mut *tx).await?;
    link_in(&mut tx, owner, "deck", &p.mythic_id, &id, Some(&format!("{} {version}", p.print))).await?;
    tx.commit().await?;
    crate::deck_import::save_prints(pool, &id, &p.prints).await?;
    Ok(id)
}

/// A linked deck brought in step: "update" saves Mythic's list as a new Yama version; "link" and
/// "keep" leave the deck as it is and record Mythic's list as the one last seen, so the next
/// import asks again only about new changes.
async fn sync_deck(pool: &SqlitePool, owner: &str, p: &Planned) -> AppResult<()> {
    let yama = p.yama_id.as_deref().ok_or(AppError::NotFound("deck"))?;
    let mut tx = pool.begin().await?;
    let now_version: Option<Option<String>> =
        sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(yama).bind(owner).fetch_optional(&mut *tx).await?;
    let Some(now_version) = now_version else {
        return Err(AppError::NotFound("deck"));
    };
    if now_version != p.seen_version {
        return Err(AppError::Conflict("the Yama deck changed since the preview; preview again".into()));
    }
    let version = if p.action == "update" {
        Some(crate::decks::insert_version_in(&mut tx, yama, &p.cards, Some("Updated from Mythic Tools")).await?)
    } else {
        now_version
    };
    link_in(&mut tx, owner, "deck", &p.mythic_id, yama, Some(&format!("{} {}", p.print, version.unwrap_or_default()))).await?;
    tx.commit().await?;
    if p.action == "update" {
        crate::deck_import::save_prints(pool, yama, &p.prints).await?;
    }
    Ok(())
}

// ── sending a deck to Mythic ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SendRequest {
    /// The version the page shows, which the snippet carries.
    version_id: String,
}

/// A one-time code for the send snippet, and the Mythic deck it updates if the deck is linked.
async fn send(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(req): Json<SendRequest>) -> AppResult<Json<Value>> {
    st.limits.mythic_bridge.check_user(&user)?;
    let (_, version, _) = crate::decks::owned_deck(&st.pool, &user.id, &id).await?;
    if version.as_deref() != Some(req.version_id.as_str()) {
        return Err(AppError::Conflict("the deck changed since this page loaded; reload it".into()));
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::hours(SEND_HOURS)).to_rfc3339();
    sqlx::query("DELETE FROM mythic_pushes WHERE owner_id = ? AND created_at < ?").bind(&user.id).bind(&cutoff).execute(&st.pool).await?;
    let code = crate::util::random_token();
    sqlx::query("INSERT INTO mythic_pushes (code, owner_id, deck_id, version_id, created_at) VALUES (?,?,?,?,?)")
        .bind(&code)
        .bind(&user.id)
        .bind(&id)
        .bind(&req.version_id)
        .bind(now())
        .execute(&st.pool)
        .await?;
    let mythic: Option<String> = sqlx::query_scalar("SELECT mythic_id FROM mythic_links WHERE owner_id = ? AND kind = 'deck' AND yama_id = ?")
        .bind(&user.id)
        .bind(&id)
        .fetch_optional(&st.pool)
        .await?;
    Ok(Json(json!({ "code": code, "mythic_id": mythic })))
}

#[derive(Deserialize)]
struct Sent {
    code: String,
    mythic_id: Value,
    /// The Mythic list the snippet left, printed as `list_print` does. A card Mythic refused
    /// leaves it different from Yama's, so the next import says the deck differs.
    print: Option<String>,
}

/// The send snippet came back: link the deck to the Mythic deck it made or updated.
async fn sent(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<Sent>) -> AppResult<Json<Value>> {
    let Some(mythic) = id_of(&req.mythic_id) else {
        return Err(AppError::bad("no Mythic deck id"));
    };
    let row: Option<(String, String, String)> = sqlx::query_as("SELECT deck_id, version_id, created_at FROM mythic_pushes WHERE code = ? AND owner_id = ?")
        .bind(&req.code)
        .bind(&user.id)
        .fetch_optional(&st.pool)
        .await?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::hours(SEND_HOURS)).to_rfc3339();
    let Some((deck, version, _)) = row.filter(|(_, _, at)| *at >= cutoff) else {
        return Err(AppError::NotFound("send (it's older than a day, or was already used): send the deck again"));
    };
    crate::decks::owned_deck(&st.pool, &user.id, &deck).await?;
    let print = match req.print.filter(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit())) {
        Some(p) => p,
        None => list_print(&crate::decks::load_version_cards(&st.pool, &version).await?),
    };
    let mut tx = st.pool.begin().await?;
    link_in(&mut tx, &user.id, "deck", &mythic, &deck, Some(&format!("{print} {version}"))).await?;
    sqlx::query("DELETE FROM mythic_pushes WHERE code = ?").bind(&req.code).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "deck_id": deck })))
}

/// Whether a deck is linked to a Mythic deck, and whether Yama's list is still the one synced.
async fn status(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let (_, version, _) = crate::decks::owned_deck(&st.pool, &user.id, &id).await?;
    let row: Option<(String, Option<String>, String)> =
        sqlx::query_as("SELECT mythic_id, mythic_changed, synced_at FROM mythic_links WHERE owner_id = ? AND kind = 'deck' AND yama_id = ?")
            .bind(&user.id)
            .bind(&id)
            .fetch_optional(&st.pool)
            .await?;
    let Some((mythic, saved, synced_at)) = row else {
        return Ok(Json(json!({ "mythic_id": null })));
    };
    let saved = saved.as_deref().and_then(|s| s.split(' ').next()).unwrap_or_default().to_string();
    let here = match &version {
        Some(v) => list_print(&crate::decks::load_version_cards(&st.pool, v).await?),
        None => String::new(),
    };
    Ok(Json(json!({ "mythic_id": mythic, "synced_at": synced_at, "same": here == saved })))
}

async fn unlink(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    crate::decks::owned_deck(&st.pool, &user.id, &id).await?;
    sqlx::query("DELETE FROM mythic_links WHERE owner_id = ? AND kind = 'deck' AND yama_id = ?").bind(&user.id).bind(&id).execute(&st.pool).await?;
    Ok(Json(json!({ "ok": true })))
}
