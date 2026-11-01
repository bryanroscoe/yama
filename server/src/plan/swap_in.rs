//! "Swap in the prints" for one plan deck: when printed proxies arrive, one action takes the deck
//! from its now list to its after-prints list everywhere Yama records it.
//!
//! - **The Yama deck** linked to the plan deck (or, unlinked, the one live deck with the plan
//!   deck's exact name) gets a new version: the plan's after-prints list.
//! - **The deck's box** (`decks.container_id`) gets each print as a proxy, in Yama's default
//!   printing, and the deck's printings mark those cards as proxies (`deck_prints.proxy`). A card
//!   moving in from another deck comes out of that deck's box (or, if it isn't there, from any
//!   copy outside a deck box).
//! - **Each card leaving** goes to the deck that takes it next (a plan move), else the deck's swap
//!   bag box ("<deck> swap bag", for the bracket bags' cards that go back in at a lower bracket),
//!   else a box called "Spares". Boxes that don't exist yet are made.
//! - **Each swap that put a card in** is ticked installed, with the same op a tap makes, so
//!   `pull.py` sees it like any other tick.
//!
//! The target is a state: a second run finds the cards where they belong and nothing to do. The
//! collection ops carry ids made from the plan deck and [`op_stamp`], so a retried request applies
//! once. `GET /api/plan/decks/{key}/swap-in` previews, `POST` applies; the MCP tool
//! `swap_in_prints` stages the same thing for the owner to apply.

use crate::collection::deck_box::printing_for;
use crate::collection::{CopyKind, Op, OpKind, OwnedCopy, apply_op, en, nm, op_stamp, owned_copies};
use crate::auth::CurrentUser;
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::Json;
use axum::extract::{Path, State};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::collections::{BTreeMap, HashMap, HashSet};

use super::model::Slot;

/// The box cards leave to when no deck takes them and they aren't in a swap bag.
pub const SPARES: &str = "Spares";

/// One card going into the deck.
#[derive(Serialize, Debug, Clone)]
pub struct PutIn {
    pub name: String,
    /// print | moved | other (a card the after list has that isn't a print or a move)
    pub kind: String,
    /// The deck it comes from (moves).
    pub from_deck: Option<String>,
    /// add_proxy | move | in_box (already there) | not_found
    pub action: String,
    /// "SET 123" of the proxy added, or where a moved copy is.
    pub detail: Option<String>,
    pub swap: Option<String>,
}

/// One card leaving the deck.
#[derive(Serialize, Debug, Clone)]
pub struct TakeOut {
    pub name: String,
    /// deck | swap_bag | spares
    pub to: String,
    /// The box it goes to.
    pub to_name: String,
    /// For `deck`: the card it replaces there.
    pub replaces: Option<String>,
    /// move | not_in_box (already gone from the deck's box)
    pub action: String,
}

#[derive(Serialize, Debug, Default)]
pub struct DeckChange {
    pub deck_id: Option<String>,
    pub deck_name: Option<String>,
    /// The deck already holds the after list.
    pub already: bool,
    pub add: Vec<String>,
    pub remove: Vec<String>,
    /// Cards where the Yama deck differed from the plan's now list (the new version is the plan's
    /// after list all the same).
    pub differed: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Preview {
    pub plan_key: String,
    pub plan_name: String,
    pub box_name: Option<String>,
    pub puts_in: Vec<PutIn>,
    pub takes_out: Vec<TakeOut>,
    pub deck: DeckChange,
    /// Swap keys this ticks installed.
    pub ticks: Vec<String>,
    /// Swaps already ticked.
    pub ticked_already: usize,
    /// Proxies added, copies moved.
    pub proxies_added: i64,
    pub moved: i64,
    pub warnings: Vec<String>,
    /// Nothing left to do.
    pub done: bool,
    pub applied: bool,
}

impl Preview {
    /// Plain text for Claude and the change list.
    pub fn text(&self) -> String {
        use std::fmt::Write;
        let mut s = String::new();
        if self.done {
            let _ = writeln!(s, "{} already holds its after-prints list in Yama; nothing to do.", self.plan_name);
            return s;
        }
        let box_name = self.box_name.as_deref().unwrap_or("its box");
        let prints = self.puts_in.iter().filter(|p| p.action == "add_proxy").count();
        let _ = writeln!(s, "{}: {} prints added to {box_name} as proxies, {} cards moved, {} swaps ticked installed.", self.plan_name, prints, self.moved, self.ticks.len());
        if let Some(name) = &self.deck.deck_name {
            if self.deck.already {
                let _ = writeln!(s, "The Yama deck {name} already holds the after-prints list.");
            } else {
                let _ = writeln!(s, "The Yama deck {name} gets a new version: +{} / -{} cards.", self.deck.add.len(), self.deck.remove.len());
            }
        }
        for p in &self.puts_in {
            let what = match p.action.as_str() {
                "add_proxy" => format!("add a proxy{}", p.detail.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()),
                "move" => format!("move it in from {}", p.detail.as_deref().unwrap_or("another box")),
                "in_box" => "already in the box".into(),
                _ => "no copy found".into(),
            };
            let _ = writeln!(s, "  in: {} ({}) — {what}", p.name, p.kind);
        }
        for t in &self.takes_out {
            let what = if t.action == "move" { format!("to {}", t.to_name) } else { "not in the box".into() };
            let _ = writeln!(s, "  out: {} — {what}{}", t.name, t.replaces.as_deref().map(|r| format!(" (for {r})")).unwrap_or_default());
        }
        for w in &self.warnings {
            let _ = writeln!(s, "Note: {w}");
        }
        s
    }
}

pub async fn preview_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(key): Path<String>) -> AppResult<Json<Preview>> {
    Ok(Json(run(&st.pool, &user.id, &key, true).await?))
}

pub async fn apply_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(key): Path<String>) -> AppResult<Json<Preview>> {
    st.limits.deck_writes.check_user(&user)?;
    Ok(Json(run(&st.pool, &user.id, &key, false).await?))
}

/// Name -> copies in a list (every board).
fn counts(slots: &[Slot]) -> BTreeMap<String, i64> {
    let mut m = BTreeMap::new();
    for s in slots {
        *m.entry(s.name.trim().to_string()).or_insert(0) += s.qty;
    }
    m
}

async fn current_list(tx: &mut Transaction<'_, Sqlite>, owner: &str, plan_deck_id: &str, state: &str) -> AppResult<Option<Vec<Slot>>> {
    let cards: Option<String> = sqlx::query_scalar("SELECT cards FROM plan_states WHERE owner_id = ? AND plan_deck_id = ? AND state = ? AND current = 1")
        .bind(owner)
        .bind(plan_deck_id)
        .bind(state)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(match cards {
        Some(c) => Some(serde_json::from_str(&c).map_err(anyhow::Error::from)?),
        None => None,
    })
}

/// A plan deck's Yama deck, as `installed.rs` resolves it: the main deck of the linked deck's
/// configuration group (the list in the box), else the only live main deck with its exact name.
async fn yama_deck(tx: &mut Transaction<'_, Sqlite>, owner: &str, linked: Option<&str>, name: &str) -> AppResult<Option<(String, String, Option<String>, Option<String>)>> {
    type Row = (String, String, Option<String>, Option<String>);
    if let Some(id) = linked {
        let row: Option<Row> = sqlx::query_as(
            "SELECT p.id, p.name, p.current_version_id, p.container_id
             FROM decks d JOIN decks p ON p.id = COALESCE(d.parent_id, d.id) AND p.owner_id = d.owner_id
             WHERE d.id = ? AND d.owner_id = ? AND d.archived = 0 AND p.archived = 0",
        )
        .bind(id)
        .bind(owner)
        .fetch_optional(&mut **tx)
        .await?;
        if row.is_some() {
            return Ok(row);
        }
    }
    let rows: Vec<Row> = sqlx::query_as("SELECT id, name, current_version_id, container_id FROM decks WHERE owner_id = ? AND archived = 0 AND parent_id IS NULL AND lower(name) = lower(?)")
        .bind(owner)
        .bind(name.trim())
        .fetch_all(&mut **tx)
        .await?;
    Ok(if rows.len() == 1 { rows.into_iter().next() } else { None })
}

/// A box by name (not a deck's box), made when `make` and it doesn't exist. `None` in a dry run.
async fn named_box(tx: &mut Transaction<'_, Sqlite>, owner: &str, name: &str, make: bool) -> AppResult<Option<String>> {
    let found: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND name = ? AND kind != 'deck' ORDER BY created_at LIMIT 1")
        .bind(owner)
        .bind(name)
        .fetch_optional(&mut **tx)
        .await?;
    if found.is_some() || !make {
        return Ok(found);
    }
    let id = new_id();
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,'box',?,?)")
        .bind(&id)
        .bind(owner)
        .bind(name)
        .bind(now())
        .execute(&mut **tx)
        .await?;
    Ok(Some(id))
}

/// Move `qty` copies of `oracle_id` out of `from` (real copies first) into `to`. Returns how many
/// it found to move, pushing the ops.
fn move_ops(copies: &mut [OwnedCopy], from: &dyn Fn(&OwnedCopy) -> bool, oracle_id: &str, qty: i64, to: Option<&str>, ops: &mut Vec<OpKind>) -> (i64, Option<String>) {
    let mut idx: Vec<usize> = (0..copies.len()).filter(|&i| copies[i].oracle_id.as_deref() == Some(oracle_id) && copies[i].qty > 0 && from(&copies[i])).collect();
    idx.sort_by_key(|&i| copies[i].proxy);
    let mut left = qty;
    let mut place = None;
    for i in idx {
        if left == 0 {
            break;
        }
        let c = &mut copies[i];
        let take = left.min(c.qty);
        place.get_or_insert_with(|| c.place());
        if let Some(to) = to {
            if take == c.qty {
                ops.push(OpKind::Update {
                    item_id: c.id.clone(),
                    condition: None,
                    finish: None,
                    lang: None,
                    container_id: Some(Some(to.to_string())),
                    purchase_price: None,
                    note: None,
                    proxy: None,
                    scryfall_id: None,
                });
            } else {
                ops.push(OpKind::Adjust { item_id: c.id.clone(), delta: -take });
                ops.push(OpKind::Add {
                    scryfall_id: c.scryfall_id.clone(),
                    qty: take,
                    copy: c.copy_kind(),
                    container_id: Some(to.to_string()),
                    purchase_price: c.purchase_price,
                    purchase_currency: c.purchase_currency.clone(),
                });
            }
        }
        // The copy has left its box in this plan (a dry run too), so it isn't counted twice.
        c.qty -= take;
        left -= take;
    }
    (qty - left, place)
}

pub async fn run(pool: &SqlitePool, owner: &str, key: &str, dry_run: bool) -> AppResult<Preview> {
    let mut tx = pool.begin().await?;
    let (plan_id, plan_name, linked, bracket): (String, String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT id, name, deck_id, bracket FROM plan_decks WHERE owner_id = ? AND key = ? AND status = 'active'")
            .bind(owner)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound("plan deck"))?;
    let now_list = current_list(&mut tx, owner, &plan_id, "now").await?.ok_or_else(|| AppError::bad(format!("{plan_name} has no now list")))?;
    let after_list = current_list(&mut tx, owner, &plan_id, "after").await?.ok_or_else(|| AppError::bad(format!("{plan_name} has no after-prints list")))?;
    let (now_n, after_n) = (counts(&now_list), counts(&after_list));
    let ins: Vec<(String, i64)> = after_n.iter().map(|(n, q)| (n.clone(), q - now_n.get(n).copied().unwrap_or(0))).filter(|(_, q)| *q > 0).collect();
    let outs: Vec<(String, i64)> = now_n.iter().map(|(n, q)| (n.clone(), q - after_n.get(n).copied().unwrap_or(0))).filter(|(_, q)| *q > 0).collect();

    let (deck_id, deck_name, version, box_id) = yama_deck(&mut tx, owner, linked.as_deref(), &plan_name)
        .await?
        .ok_or_else(|| AppError::bad(format!("{plan_name} isn't linked to one of your Yama decks. Link it on the plan's page first.")))?;
    let box_id = box_id.ok_or_else(|| AppError::bad(format!("Your deck {deck_name} has no box in your collection yet. Use \"Add to my collection\" on the deck first.")))?;
    let box_name: String = sqlx::query_scalar("SELECT name FROM containers WHERE id = ?").bind(&box_id).fetch_one(&mut *tx).await?;

    let mut names: Vec<String> = after_n.keys().chain(now_n.keys()).cloned().collect();
    names.sort();
    names.dedup();
    let ids = super::resolve_names(&mut *tx, &names).await?;
    let mut warnings = Vec::new();
    let unknown: Vec<&str> = names.iter().filter(|n| !ids.contains_key(*n)).map(String::as_str).collect();
    if !unknown.is_empty() {
        return Err(AppError::bad(format!("Yama's card data doesn't have {} yet, so {plan_name} can't be swapped in.", unknown.join(", "))));
    }

    // Other plan decks: their boxes, and which of this deck's cards they take next.
    let others: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT d.key, d.name, d.deck_id, s.cards FROM plan_decks d
         JOIN plan_states s ON s.plan_deck_id = d.id AND s.owner_id = d.owner_id AND s.state = 'after' AND s.current = 1
         WHERE d.owner_id = ? AND d.id != ? AND d.status != 'archived'",
    )
    .bind(owner)
    .bind(&plan_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut other_box: HashMap<String, (String, Option<String>)> = HashMap::new(); // key -> (name, box)
    let mut taken_by: HashMap<String, (String, Option<String>)> = HashMap::new(); // card -> (deck key, replaces)
    for (k, n, linked, cards) in &others {
        let b = yama_deck(&mut tx, owner, linked.as_deref(), n).await?.and_then(|d| d.3);
        other_box.insert(k.clone(), (n.clone(), b));
        let slots: Vec<Slot> = serde_json::from_str(cards).map_err(anyhow::Error::from)?;
        for s in slots.iter().filter(|s| s.kind.as_deref() == Some("moved") && s.from_deck.as_deref() == Some(key)) {
            taken_by.insert(s.name.trim().to_string(), (k.clone(), s.replaces.clone()));
        }
    }
    let bag: HashSet<String> = bracket
        .as_deref()
        .and_then(|b| serde_json::from_str::<Value>(b).ok())
        .and_then(|b| b.get("bags").cloned())
        .and_then(|b| b.as_object().cloned())
        .map(|bags| bags.values().filter_map(Value::as_array).flatten().filter_map(|s| s["in"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let deck_boxes: HashSet<String> = sqlx::query_scalar(
        "SELECT id FROM containers WHERE owner_id = ?1 AND kind = 'deck'
         UNION SELECT container_id FROM decks WHERE owner_id = ?1 AND archived = 0 AND container_id IS NOT NULL",
    )
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    let mut copies = owned_copies(&mut tx, owner).await?;
    let mut ops: Vec<OpKind> = Vec::new();
    let mut proxy_prints = Vec::new();
    let (mut proxies_added, mut moved) = (0i64, 0i64);
    let in_box = |copies: &[OwnedCopy], oid: &str| -> i64 { copies.iter().filter(|c| c.container_id.as_deref() == Some(&box_id) && c.oracle_id.as_deref() == Some(oid)).map(|c| c.qty).sum() };

    // Out first, so a card leaving and a copy of it coming back (basics) don't cancel out.
    let mut takes_out = Vec::new();
    let spares = named_box(&mut tx, owner, SPARES, false).await?;
    let bag_name = format!("{plan_name} swap bag");
    let bag_box = named_box(&mut tx, owner, &bag_name, false).await?;
    let (mut spares_new, mut bag_new) = (spares.is_none(), bag_box.is_none());
    let mut spares = spares;
    let mut bag_box = bag_box;
    for (name, qty) in &outs {
        let oid = &ids[name];
        let (to, to_name, to_box, replaces) = if let Some((k, replaces)) = taken_by.get(name) {
            let (n, b) = other_box.get(k).cloned().unwrap_or_default();
            if b.is_none() {
                warnings.push(format!("{n} has no box yet, so {name} goes to {SPARES} instead."));
                ("spares", SPARES.to_string(), None, None)
            } else {
                ("deck", n, b, replaces.clone())
            }
        } else if bag.contains(name) {
            ("swap_bag", bag_name.clone(), None, None)
        } else {
            ("spares", SPARES.to_string(), None, None)
        };
        let to_box = match to {
            "deck" => to_box,
            "swap_bag" => {
                if bag_box.is_none() && !dry_run {
                    bag_box = named_box(&mut tx, owner, &bag_name, true).await?;
                }
                bag_box.clone()
            }
            _ => {
                if spares.is_none() && !dry_run {
                    spares = named_box(&mut tx, owner, SPARES, true).await?;
                }
                spares.clone()
            }
        };
        let from_box = |c: &OwnedCopy| c.container_id.as_deref() == Some(box_id.as_str());
        // In a dry run a box that doesn't exist yet has no id; the ops aren't applied then.
        let dest = to_box.unwrap_or_else(|| "(new box)".into());
        let (n, _) = move_ops(&mut copies, &from_box, oid, *qty, Some(&dest), &mut ops);
        moved += n;
        takes_out.push(TakeOut { name: name.clone(), to: to.into(), to_name, replaces, action: if n > 0 { "move" } else { "not_in_box" }.into() });
        if n < *qty && n > 0 {
            warnings.push(format!("Only {n} of {qty} {name} were in {box_name}."));
        }
    }
    spares_new &= takes_out.iter().any(|t| t.to == "spares" && t.action == "move");
    bag_new &= takes_out.iter().any(|t| t.to == "swap_bag" && t.action == "move");

    let mut puts_in = Vec::new();
    let after_slot = |name: &str| after_list.iter().find(|s| s.name.trim() == name).cloned();
    for (name, qty) in &ins {
        let oid = &ids[name];
        let slot = after_slot(name);
        let kind = match slot.as_ref().and_then(|s| s.kind.as_deref()) {
            Some("print") => "print",
            Some("moved") => "moved",
            _ => "other",
        };
        let from_deck = slot.as_ref().and_then(|s| s.from_deck.clone());
        let swap = slot.as_ref().and_then(|s| s.swap.clone());
        let need = qty - in_box(&copies, oid).min(*qty);
        if need == 0 {
            puts_in.push(PutIn { name: name.clone(), kind: kind.into(), from_deck: from_deck.and_then(|k| other_box.get(&k).map(|o| o.0.clone())), action: "in_box".into(), detail: None, swap });
            continue;
        }
        if kind == "print" {
            let p = printing_for(&mut tx, oid, None).await?;
            let Some(p) = p else {
                warnings.push(format!("Yama has no printing of {name} to add as a proxy."));
                puts_in.push(PutIn { name: name.clone(), kind: kind.into(), from_deck: None, action: "not_found".into(), detail: None, swap });
                continue;
            };
            ops.push(OpKind::Add {
                scryfall_id: p.scryfall_id.clone(),
                qty: need,
                copy: CopyKind { condition: nm(), finish: p.finish.clone(), lang: en(), proxy: true, ..Default::default() },
                container_id: Some(box_id.clone()),
                purchase_price: None,
                purchase_currency: None,
            });
            proxy_prints.push((oid.clone(), p.set_code.clone(), p.collector_number.clone(), p.finish.clone()));
            proxies_added += need;
            puts_in.push(PutIn {
                name: name.clone(),
                kind: kind.into(),
                from_deck: None,
                action: "add_proxy".into(),
                detail: Some(format!("{} {}", p.set_code.to_uppercase(), p.collector_number)),
                swap,
            });
        } else {
            // A move (or any other card the plan has in hand): the giving deck's box first, then any
            // copy outside a deck box.
            let giver_box = from_deck.as_ref().and_then(|k| other_box.get(k)).and_then(|o| o.1.clone());
            let giver = |c: &OwnedCopy| giver_box.is_some() && c.container_id == giver_box;
            let mut found = move_ops(&mut copies, &giver, oid, need, Some(&box_id), &mut ops);
            if found.0 < need {
                let loose = |c: &OwnedCopy| c.container_id.as_ref().is_none_or(|id| !deck_boxes.contains(id));
                let more = move_ops(&mut copies, &loose, oid, need - found.0, Some(&box_id), &mut ops);
                found = (found.0 + more.0, found.1.or(more.1));
            }
            moved += found.0;
            let from_name = from_deck.and_then(|k| other_box.get(&k).map(|o| o.0.clone()));
            if found.0 < need {
                warnings.push(format!(
                    "No copy of {name} to move into {box_name}{}.",
                    from_name.as_deref().map(|n| format!(" (it should come out of {n})")).unwrap_or_default()
                ));
            }
            puts_in.push(PutIn {
                name: name.clone(),
                kind: kind.into(),
                from_deck: from_name,
                action: if found.0 > 0 { "move" } else { "not_found" }.into(),
                detail: found.1,
                swap,
            });
        }
    }

    // The Yama deck's list: the plan's after list.
    // Read inside the transaction: a second connection could wait on this one.
    let current: Vec<DeckCard> = match &version {
        Some(v) => {
            let cards: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(v).fetch_one(&mut *tx).await?;
            serde_json::from_str(&cards).map_err(anyhow::Error::from)?
        }
        None => vec![],
    };
    let mut target: Vec<DeckCard> = Vec::new();
    for s in &after_list {
        let oid = ids[s.name.trim()].clone();
        let board = if s.board == "commander" { Board::Commander } else { Board::Main };
        match target.iter_mut().find(|c| c.oracle_id == oid && c.board == board) {
            Some(c) => c.qty += s.qty,
            None => target.push(DeckCard { oracle_id: oid, name: s.name.trim().to_string(), qty: s.qty, board }),
        }
    }
    let by_oid = |cards: &[DeckCard]| -> BTreeMap<String, (String, i64)> {
        let mut m: BTreeMap<String, (String, i64)> = BTreeMap::new();
        for c in cards.iter().filter(|c| c.board != Board::Side) {
            m.entry(c.oracle_id.clone()).or_insert_with(|| (c.name.clone(), 0)).1 += c.qty;
        }
        m
    };
    let (cur, tgt) = (by_oid(&current), by_oid(&target));
    let diff = |a: &BTreeMap<String, (String, i64)>, b: &BTreeMap<String, (String, i64)>| -> Vec<String> {
        a.iter().filter_map(|(o, (n, q))| (q - b.get(o).map_or(0, |x| x.1) > 0).then(|| n.clone())).collect()
    };
    let mut now_target: Vec<DeckCard> = Vec::new();
    for s in &now_list {
        let oid = ids[s.name.trim()].clone();
        match now_target.iter_mut().find(|c| c.oracle_id == oid) {
            Some(c) => c.qty += s.qty,
            None => now_target.push(DeckCard { oracle_id: oid, name: s.name.trim().to_string(), qty: s.qty, board: Board::Main }),
        }
    }
    let nowm = by_oid(&now_target);
    let already = cur == tgt;
    let mut differed: Vec<String> = if already { vec![] } else { [diff(&cur, &nowm), diff(&nowm, &cur)].concat() };
    differed.sort();
    if !differed.is_empty() {
        warnings.push(format!(
            "Your Yama deck {deck_name} wasn't the plan's now list ({}); the new version is the plan's after-prints list all the same.",
            differed.join(", ")
        ));
    }
    let deck = DeckChange {
        deck_id: Some(deck_id.clone()),
        deck_name: Some(deck_name.clone()),
        already,
        add: if already { vec![] } else { diff(&tgt, &cur) },
        remove: if already { vec![] } else { diff(&cur, &tgt) },
        differed,
    };

    // Installed ticks for the swaps that put the new cards in.
    let in_names: HashSet<&str> = ins.iter().map(|(n, _)| n.as_str()).collect();
    let keys: Vec<String> = after_list.iter().filter(|s| in_names.contains(s.name.trim())).filter_map(|s| s.swap.clone()).collect();
    let ticked: HashSet<String> = sqlx::query_scalar("SELECT swap_key FROM plan_marks WHERE owner_id = ? AND kind = 'installed' AND value = 1")
        .bind(owner)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
    let (ticked_already, ticks): (Vec<String>, Vec<String>) = keys.into_iter().partition(|k| ticked.contains(k));

    if spares_new && dry_run {
        warnings.push(format!("A box called {SPARES} will be made for the cards leaving."));
    }
    if bag_new && dry_run {
        warnings.push(format!("A box called {bag_name} will be made for the cards that go back in at a lower bracket."));
    }
    let mut preview = Preview {
        plan_key: key.to_string(),
        plan_name: plan_name.clone(),
        box_name: Some(box_name),
        done: ops.is_empty() && proxies_added == 0 && moved == 0 && already && ticks.is_empty(),
        puts_in,
        takes_out,
        deck,
        ticks,
        ticked_already: ticked_already.len(),
        proxies_added,
        moved,
        warnings,
        applied: false,
    };
    if dry_run || preview.done {
        return Ok(preview);
    }

    let stamp = op_stamp(&mut tx, owner).await?;
    for (n, op) in ops.into_iter().enumerate() {
        let op = Op { op_id: format!("swapin:{plan_id}:{stamp}:{n}"), device_id: Some("swap-in".into()), op };
        apply_op(&mut tx, owner, &op).await?;
    }
    for (oid, set, num, finish) in &proxy_prints {
        sqlx::query(
            "INSERT INTO deck_prints (deck_id, oracle_id, set_code, collector_number, finish, proxy) VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT (deck_id, oracle_id) DO UPDATE SET set_code = excluded.set_code, collector_number = excluded.collector_number,
               finish = excluded.finish, proxy = 1",
        )
        .bind(&deck_id)
        .bind(oid)
        .bind(set)
        .bind(num)
        .bind(finish)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    if !preview.deck.already {
        let note = format!("Prints swapped in: the plan's after-prints list for {plan_name}.");
        crate::decks::insert_version(pool, &deck_id, &target, Some(&note)).await?;
    }
    if !preview.ticks.is_empty() {
        let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let tick_ops: Vec<Value> = preview
            .ticks
            .iter()
            .enumerate()
            .map(|(n, k)| json!({"op_id": format!("swapin-{plan_id}-{stamp}-{n}"), "device_id": "swap-in", "at": at, "kind": "installed", "swap_key": k, "value": true}))
            .collect();
        let reply = super::inputs::apply_ops(pool, owner, tick_ops, Utc::now()).await?;
        for r in reply.results.iter().filter(|r| r.status == "rejected") {
            preview.warnings.push(format!("A tick wasn't saved: {}", r.error.clone().unwrap_or_default()));
        }
    }
    preview.applied = true;
    Ok(preview)
}

#[cfg(test)]
mod tests;
