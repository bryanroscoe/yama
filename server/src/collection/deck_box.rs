//! "Add to my collection" for a deck: make the deck's box hold the deck's list.
//!
//! - **The box** is the container the deck is linked to (`decks.container_id`), or a new one of
//!   kind `deck` named after the deck (with " (2)" and so on when another live deck already has a
//!   box by that name), which the deck is then linked to. The deck's list is never changed, and
//!   nothing here makes a deck from its box (`decks::sync_deck_from_container` runs only for the
//!   deck containers a Mythic Tools file names).
//! - **What's missing:** for each card of the commander and main deck (not the sideboard), copies
//!   in the list minus copies of that card in the box, in any printing.
//! - **Which printing:** the one the deck names (`deck_prints`, from an import) if Yama has it,
//!   else [`crate::decks::collection_printing`]: English nonfoil, Scryfall's default, never a promo
//!   or gold-bordered copy. A card the deck marks as a proxy is added as a proxy.
//! - **Same printing elsewhere:** copies of exactly that printing, finish and proxy-ness in another
//!   box or binder, a list, or unfiled. Per run, [`SamePrinting`]: move them into the box (the web's
//!   default), leave them and add new copies, or leave them and don't add those. Copies in
//!   another deck's box (a `deck` container, or any container a live deck is linked to) are never
//!   moved. Basic lands work the same way, by exact printing.
//! - **Idempotent:** the target is a state, so a second run finds nothing missing. The ops carry
//!   ids made from the deck and [`super::op_stamp`], so a retried request applies once.
//!
//! `GET /api/decks/{id}/collect?same=` previews, `POST` (`{"same": …}`) applies; while an admin
//! views as someone the POST is refused like every write (`view_as::guard`).
//! `yama-server collection add-deck` does the same from the command line.

use super::{CopyKind, Op, OpKind, OwnedCopy, apply_op, en, nm, op_stamp, owned_copies};
use crate::auth::CurrentUser;
use crate::deck_import::DeckPrint;
use crate::decks::{Board, DeckCard, collection_printing, printing_choices};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::collections::{HashMap, HashSet};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/decks/{id}/collect", get(preview).post(apply))
}

/// What to do with copies of the same printing you already own outside deck boxes.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SamePrinting {
    /// Move them into the deck box.
    #[default]
    Move,
    /// Leave them where they are and add new copies.
    Add,
    /// Leave them where they are and don't add those cards.
    Skip,
}

/// What a new copy of a card would be.
#[derive(Serialize, Debug, Clone)]
pub struct Printing {
    pub scryfall_id: String,
    pub set_code: String,
    pub set_name: String,
    pub collector_number: String,
    /// nonfoil | foil | etched
    pub finish: String,
    /// "deck": the printing the deck names; "default": Yama's pick, as the deck names none (or
    /// one Yama doesn't have).
    pub from: &'static str,
    pub image_small: Option<String>,
}

/// Copies of exactly the printing to add, outside deck boxes.
#[derive(Serialize, Debug, Clone)]
pub struct Elsewhere {
    pub item_id: String,
    pub container_id: Option<String>,
    /// "box: Bulk", or "unfiled".
    pub place: String,
    pub qty: i64,
}

/// What one option does.
#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Copies moved into the box from elsewhere.
    pub moved: i64,
    /// New copies added.
    pub added: i64,
    /// Missing copies not added, because the same printing is elsewhere (or Yama has no printing).
    pub left_out: i64,
}

/// One card the box is short of.
#[derive(Serialize, Debug, Clone)]
pub struct Line {
    pub oracle_id: String,
    pub name: String,
    /// Copies in the list.
    pub qty: i64,
    /// Copies of the card in the box already, any printing.
    pub in_box: i64,
    pub missing: i64,
    /// `None`: Yama has no printing of this card, so none is added.
    pub printing: Option<Printing>,
    /// The deck marks this card as a proxy: new copies are proxies.
    pub proxy: bool,
    pub elsewhere: Vec<Elsewhere>,
    /// What the chosen option does with this card.
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Options {
    #[serde(rename = "move")]
    pub move_: Outcome,
    pub add: Outcome,
    pub skip: Outcome,
}

#[derive(Serialize, Debug)]
pub struct Preview {
    pub deck_id: String,
    pub deck_name: String,
    pub version_id: Option<String>,
    /// `None` until the box is made (a preview of a deck without one).
    pub box_id: Option<String>,
    pub box_name: String,
    pub box_kind: String,
    /// The box exists already (linked, or a free deck container with the deck's name).
    pub box_exists: bool,
    pub same_printing: SamePrinting,
    /// Copies in the list (commander and main deck).
    pub cards: i64,
    /// Of those, copies the box holds already.
    pub in_box: i64,
    pub missing: i64,
    /// Missing copies you own in the same printing outside deck boxes.
    pub same_elsewhere: i64,
    /// Copies in the box that the list doesn't have (a card cut since). Adding never takes
    /// anything out, so they stay.
    pub not_in_list: i64,
    /// What each option would do, so the choice can say so.
    pub options: Options,
    /// What the chosen option does (or did).
    #[serde(flatten)]
    pub outcome: Outcome,
    /// New copies that are proxies.
    pub proxies: i64,
    /// Cards Yama has no printing of (left out).
    pub no_printing: Vec<String>,
    /// Cards the box is short of; cards it already holds aren't listed.
    pub lines: Vec<Line>,
    /// Copies were added or moved (false for a preview, or when there was nothing to add).
    pub applied: bool,
}

#[derive(Deserialize, Default)]
struct Choice {
    #[serde(default)]
    same: SamePrinting,
}

async fn preview(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Query(c): Query<Choice>) -> AppResult<Json<Preview>> {
    Ok(Json(add_deck(&st.pool, &user.id, &id, c.same, true).await?))
}

async fn apply(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(c): Json<Choice>) -> AppResult<Json<Preview>> {
    st.limits.imports.check_user(&user)?;
    Ok(Json(add_deck(&st.pool, &user.id, &id, c.same, false).await?))
}

/// The deck box, as it is or as it would be made.
struct DeckBox {
    id: Option<String>,
    name: String,
    kind: String,
    /// The deck isn't linked to it yet.
    link: bool,
}

/// Preview (`dry_run`) or make the deck's box hold its list. Everything is read and written in one
/// transaction, so what's applied is what was planned.
pub async fn add_deck(pool: &SqlitePool, owner: &str, deck_id: &str, same: SamePrinting, dry_run: bool) -> AppResult<Preview> {
    let mut tx = pool.begin().await?;
    let (deck_name, version_id, linked): (String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT name, current_version_id, container_id FROM decks WHERE id = ? AND owner_id = ?")
            .bind(deck_id)
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound("deck"))?;
    let Some(version) = version_id.clone() else { return Err(AppError::bad("the deck has no cards yet")) };
    let cards: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(&version).fetch_one(&mut *tx).await?;
    let cards: Vec<DeckCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
    let mut target = find_box(&mut tx, owner, deck_id, &deck_name, linked.as_deref()).await?;
    let box_existed = target.id.is_some();
    if !dry_run {
        if target.id.is_none() {
            let id = new_id();
            sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,'deck',?,?)")
                .bind(&id)
                .bind(owner)
                .bind(&target.name)
                .bind(now())
                .execute(&mut *tx)
                .await?;
            target.id = Some(id);
        }
        if target.link {
            sqlx::query("UPDATE decks SET container_id = ? WHERE id = ? AND owner_id = ?").bind(&target.id).bind(deck_id).bind(owner).execute(&mut *tx).await?;
        }
    }
    let prints: HashMap<String, DeckPrint> =
        sqlx::query_as::<_, DeckPrint>("SELECT oracle_id, set_code, collector_number, finish, proxy FROM deck_prints WHERE deck_id = ?")
            .bind(deck_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|p| (p.oracle_id.clone(), p))
            .collect();
    let copies = owned_copies(&mut tx, owner).await?;
    let deck_boxes: HashSet<String> = sqlx::query_scalar(
        "SELECT id FROM containers WHERE owner_id = ?1 AND kind = 'deck'
         UNION SELECT container_id FROM decks WHERE owner_id = ?1 AND archived = 0 AND container_id IS NOT NULL",
    )
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    let mut preview = Preview {
        deck_id: deck_id.to_string(),
        deck_name,
        version_id,
        box_id: target.id.clone(),
        box_name: target.name.clone(),
        box_kind: target.kind.clone(),
        box_exists: box_existed,
        same_printing: same,
        cards: 0,
        in_box: 0,
        missing: 0,
        same_elsewhere: 0,
        not_in_list: 0,
        options: Options::default(),
        outcome: Outcome::default(),
        proxies: 0,
        no_printing: vec![],
        lines: vec![],
        applied: false,
    };
    for card in merged(&cards) {
        let in_box: i64 = copies
            .iter()
            .filter(|c| target.id.is_some() && c.container_id == target.id && c.oracle_id.as_deref() == Some(card.oracle_id.as_str()))
            .map(|c| c.qty)
            .sum();
        preview.cards += card.qty;
        preview.in_box += in_box.min(card.qty);
        let missing = (card.qty - in_box).max(0);
        if missing == 0 {
            continue;
        }
        preview.missing += missing;
        let chosen = prints.get(&card.oracle_id);
        let proxy = chosen.is_some_and(|p| p.proxy);
        let printing = printing_for(&mut tx, &card.oracle_id, chosen).await?;
        let elsewhere: Vec<Elsewhere> = match &printing {
            Some(p) => copies
                .iter()
                .filter(|c| c.scryfall_id == p.scryfall_id && c.finish == p.finish && c.proxy == proxy)
                .filter(|c| c.container_id.is_none() || (c.container_id != target.id && !c.container_id.as_ref().is_some_and(|id| deck_boxes.contains(id))))
                .map(|c| Elsewhere { item_id: c.id.clone(), container_id: c.container_id.clone(), place: c.place(), qty: c.qty })
                .collect(),
            None => vec![],
        };
        let available: i64 = elsewhere.iter().map(|e| e.qty).sum();
        let cover = missing.min(available);
        let options = if printing.is_some() {
            Options {
                move_: Outcome { moved: cover, added: missing - cover, left_out: 0 },
                add: Outcome { moved: 0, added: missing, left_out: 0 },
                skip: Outcome { moved: 0, added: missing - cover, left_out: cover },
            }
        } else {
            preview.no_printing.push(card.name.clone());
            let none = Outcome { moved: 0, added: 0, left_out: missing };
            Options { move_: none, add: none, skip: none }
        };
        let outcome = pick(&options, same);
        preview.same_elsewhere += cover;
        for (total, o) in [(&mut preview.options.move_, options.move_), (&mut preview.options.add, options.add), (&mut preview.options.skip, options.skip)] {
            total.moved += o.moved;
            total.added += o.added;
            total.left_out += o.left_out;
        }
        if proxy {
            preview.proxies += outcome.added;
        }
        preview.lines.push(Line { oracle_id: card.oracle_id.clone(), name: card.name.clone(), qty: card.qty, in_box, missing, printing, proxy, elsewhere, outcome });
    }
    preview.outcome = pick(&preview.options, same);
    if let Some(box_id) = &target.id {
        let list = merged(&cards);
        let mut held: HashMap<&str, i64> = HashMap::new();
        for c in copies.iter().filter(|c| c.container_id.as_ref() == Some(box_id)) {
            *held.entry(c.oracle_id.as_deref().unwrap_or(c.scryfall_id.as_str())).or_insert(0) += c.qty;
        }
        preview.not_in_list = held.iter().map(|(o, n)| n - list.iter().find(|c| c.oracle_id == *o).map_or(0, |c| c.qty)).filter(|n| *n > 0).sum();
    }
    preview.lines.sort_by(|a, b| a.name.cmp(&b.name));
    if dry_run {
        return Ok(preview);
    }

    let box_id = target.id.clone().expect("made above");
    let stamp = op_stamp(&mut tx, owner).await?;
    let mut ops = Vec::new();
    for line in &preview.lines {
        let Some(p) = &line.printing else { continue };
        let mut to_move = line.outcome.moved;
        for e in &line.elsewhere {
            if to_move == 0 {
                break;
            }
            let take = to_move.min(e.qty);
            to_move -= take;
            let source = copies.iter().find(|c| c.id == e.item_id).expect("listed from copies");
            if take == source.qty {
                // The whole row moves, keeping its id, note and purchase price.
                ops.push(OpKind::Update {
                    item_id: source.id.clone(),
                    condition: None,
                    finish: None,
                    lang: None,
                    container_id: Some(Some(box_id.clone())),
                    purchase_price: None,
                    note: None,
                    proxy: None,
                    scryfall_id: None,
                    split: None,
                });
            } else {
                ops.push(OpKind::Adjust { item_id: source.id.clone(), delta: -take });
                ops.push(add_op(source, take, &box_id));
            }
        }
        if line.outcome.added > 0 {
            ops.push(OpKind::Add {
                scryfall_id: p.scryfall_id.clone(),
                qty: line.outcome.added,
                copy: CopyKind { condition: nm(), finish: p.finish.clone(), lang: en(), proxy: line.proxy, ..Default::default() },
                container_id: Some(box_id.clone()),
                purchase_price: None,
                purchase_currency: None,
            });
        }
    }
    for (n, op) in ops.into_iter().enumerate() {
        let op = Op { op_id: format!("deckbox:{deck_id}:{stamp}:{n}"), device_id: Some("deck-box".into()), op };
        apply_op(&mut tx, owner, &op).await?;
    }
    tx.commit().await?;
    preview.box_id = Some(box_id);
    preview.applied = preview.outcome.added + preview.outcome.moved > 0;
    Ok(preview)
}

fn pick(o: &Options, same: SamePrinting) -> Outcome {
    match same {
        SamePrinting::Move => o.move_,
        SamePrinting::Add => o.add,
        SamePrinting::Skip => o.skip,
    }
}

/// An `add` op for `qty` copies like `source` (condition, finish, language, flags, price paid).
fn add_op(source: &OwnedCopy, qty: i64, container: &str) -> OpKind {
    OpKind::Add {
        scryfall_id: source.scryfall_id.clone(),
        qty,
        copy: source.copy_kind(),
        container_id: Some(container.to_string()),
        purchase_price: source.purchase_price,
        purchase_currency: source.purchase_currency.clone(),
    }
}

/// The list's commander and main deck, one entry per card.
fn merged(cards: &[DeckCard]) -> Vec<DeckCard> {
    let mut out: Vec<DeckCard> = Vec::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        match out.iter_mut().find(|x| x.oracle_id == c.oracle_id) {
            Some(hit) => hit.qty += c.qty,
            None => out.push(c.clone()),
        }
    }
    out
}

/// The deck's box: the linked container if it still exists, else a `deck` container named after
/// the deck that no other live deck is linked to (reused if it exists), else "Name (2)" and so on.
async fn find_box(tx: &mut Transaction<'_, Sqlite>, owner: &str, deck_id: &str, deck_name: &str, linked: Option<&str>) -> AppResult<DeckBox> {
    if let Some(id) = linked {
        let found: Option<(String, String)> = sqlx::query_as("SELECT name, kind FROM containers WHERE id = ? AND owner_id = ?")
            .bind(id)
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await?;
        if let Some((name, kind)) = found {
            return Ok(DeckBox { id: Some(id.to_string()), name, kind, link: false });
        }
    }
    for n in 1.. {
        let name = if n == 1 { deck_name.trim().to_string() } else { format!("{} ({n})", deck_name.trim()) };
        let existing: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = 'deck' AND name = ?")
            .bind(owner)
            .bind(&name)
            .fetch_optional(&mut **tx)
            .await?;
        let Some(id) = existing else {
            return Ok(DeckBox { id: None, name, kind: "deck".into(), link: true });
        };
        let taken: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE owner_id = ? AND container_id = ? AND archived = 0 AND id != ?")
            .bind(owner)
            .bind(&id)
            .bind(deck_id)
            .fetch_one(&mut **tx)
            .await?;
        if taken == 0 {
            return Ok(DeckBox { id: Some(id), name, kind: "deck".into(), link: true });
        }
    }
    unreachable!()
}

/// The printing a new copy would be: the deck's named printing if Yama has it, else the default.
pub(crate) async fn printing_for(tx: &mut Transaction<'_, Sqlite>, oracle_id: &str, chosen: Option<&DeckPrint>) -> AppResult<Option<Printing>> {
    type Row = (String, String, String, String, Option<String>);
    if let Some(p) = chosen.filter(|p| !p.set_code.is_empty()) {
        let row: Option<Row> = sqlx::query_as(
            "SELECT scryfall_id, set_code, set_name, collector_number, image_small FROM printings
             WHERE oracle_id = ?1 AND set_code = ?2 AND (?3 IS NULL OR collector_number = ?3)
             ORDER BY lang = 'en' DESC, length(collector_number), collector_number LIMIT 1",
        )
        .bind(oracle_id)
        .bind(&p.set_code)
        .bind(&p.collector_number)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some((scryfall_id, set_code, set_name, collector_number, image_small)) = row {
            return Ok(Some(Printing { scryfall_id, set_code, set_name, collector_number, finish: p.finish.clone(), from: "deck", image_small }));
        }
    }
    let choices = printing_choices(&mut **tx, oracle_id).await?;
    let Some(best) = collection_printing(&choices) else { return Ok(None) };
    let (set_name, image_small): (String, Option<String>) =
        sqlx::query_as("SELECT set_name, image_small FROM printings WHERE scryfall_id = ?").bind(&best.scryfall_id).fetch_one(&mut **tx).await?;
    Ok(Some(Printing {
        scryfall_id: best.scryfall_id.clone(),
        set_code: best.set_code.clone(),
        set_name,
        collector_number: best.collector_number.clone(),
        finish: best.plain_finish().into(),
        from: "default",
        image_small,
    }))
}

/// `yama-server collection add-deck --owner EMAIL --deck NAME [--move-same-printing |
/// --skip-same-printing] [--dry-run] [--json]`. Without a same-printing flag, copies of the same
/// printing elsewhere are left where they are and new copies are added: on the command line
/// nothing moves unless asked, since a box imported from elsewhere may hold other copies.
pub async fn cli(pool: &SqlitePool, args: &[String]) -> anyhow::Result<()> {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let usage = "usage: yama-server collection add-deck --owner EMAIL --deck NAME [--move-same-printing | --skip-same-printing] [--dry-run] [--json]";
    let (Some(email), Some(name)) = (value("--owner"), value("--deck")) else { anyhow::bail!(usage) };
    let same = match (flag("--move-same-printing"), flag("--skip-same-printing")) {
        (true, true) => anyhow::bail!("--move-same-printing and --skip-same-printing don't go together"),
        (true, false) => SamePrinting::Move,
        (false, true) => SamePrinting::Skip,
        (false, false) => SamePrinting::Add,
    };
    let owner = crate::decks::cli::owner_id(pool, &email).await?;
    let (deck_id, _) = crate::decks::cli::deck_id(pool, &owner, &name).await?;
    let dry_run = flag("--dry-run");
    let p = add_deck(pool, &owner, &deck_id, same, dry_run).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    if flag("--json") {
        println!("{}", serde_json::to_string_pretty(&p)?);
    } else {
        print!("{}", text(&p, dry_run));
    }
    Ok(())
}

fn new_copies(n: i64) -> String {
    format!("{n} new {}", if n == 1 { "copy" } else { "copies" })
}

/// The preview or result as the command line prints it.
pub fn text(p: &Preview, dry_run: bool) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let state = if p.box_exists { "" } else if dry_run { ", made on the real run" } else { ", new" };
    let _ = writeln!(out, "{}: deck box \"{}\" ({}{state})", p.deck_name, p.box_name, p.box_kind);
    let _ = writeln!(out, "{} cards in the list, {} in the box already, {} missing", p.cards, p.in_box, p.missing);
    if p.not_in_list > 0 {
        let _ = writeln!(out, "{} in the box {} in the list; {} there", super::mythic::copies(p.not_in_list), if p.not_in_list == 1 { "isn't" } else { "aren't" }, if p.not_in_list == 1 { "it stays" } else { "they stay" });
    }
    if p.same_elsewhere > 0 {
        let choice = match p.same_printing {
            SamePrinting::Move => "moved into the deck box",
            SamePrinting::Add => "left where they are, new copies added",
            SamePrinting::Skip => "left where they are, not added",
        };
        let _ = writeln!(out, "Same printing in another box or binder: {} of the missing, {choice}", p.same_elsewhere);
    }
    let proxies = if p.proxies > 0 { format!(" ({} proxies)", p.proxies) } else { String::new() };
    let (added, moved, left) = (p.outcome.added, p.outcome.moved, p.outcome.left_out);
    let _ = if dry_run {
        writeln!(out, "Would add {}{proxies}, move {moved}, leave out {left}", new_copies(added))
    } else {
        writeln!(out, "Added {}{proxies}, moved {moved}, left out {left}", new_copies(added))
    };
    for l in &p.lines {
        let Some(pr) = &l.printing else { continue };
        let print = format!(
            "{} {}{}{}, {}",
            pr.set_code.to_uppercase(),
            pr.collector_number,
            if pr.finish == "nonfoil" { String::new() } else { format!(" {}", pr.finish) },
            if l.proxy { " proxy" } else { "" },
            if pr.from == "deck" { "the deck's printing" } else { "default printing" }
        );
        if l.outcome.added > 0 {
            let _ = writeln!(out, "  + {} {} ({print})", l.outcome.added, l.name);
        }
        if l.outcome.moved > 0 {
            let from: Vec<&str> = l.elsewhere.iter().map(|e| e.place.as_str()).collect();
            let _ = writeln!(out, "  > {} {} ({print}) from {}", l.outcome.moved, l.name, from.join(", "));
        }
        if l.outcome.left_out > 0 {
            let _ = writeln!(out, "  = {} {} left out: you have it in {}", l.outcome.left_out, l.name, l.elsewhere.iter().map(|e| e.place.as_str()).collect::<Vec<_>>().join(", "));
        }
    }
    if !p.no_printing.is_empty() {
        let _ = writeln!(out, "No printing in Yama's card data (left out): {}", p.no_printing.join(", "));
    }
    let _ = writeln!(out, "{}", if dry_run { "Dry run: nothing changed." } else if p.applied { "Done." } else { "Nothing to do." });
    out
}

#[cfg(test)]
mod tests;
