//! Real-card needs across saved main decks and approved upgrades, separate from store trips.
//! Pending proposals are included only for the owner or when the owner opts to publish them. Nothing here approves a plan.
use crate::error::AppResult;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};

type Counts = BTreeMap<String, (String, i64)>;
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn key(n: &str, ids: &HashMap<String, String>) -> String {
    ids.get(n).map(|id| format!("card:{id}")).unwrap_or_else(|| format!("name:{}", n.trim().to_lowercase()))
}
fn add(c: &mut Counts, n: &str, q: i64, ids: &HashMap<String, String>) {
    if !n.trim().is_empty() {
        let r = c.entry(key(n, ids)).or_insert((n.to_string(), 0));
        r.1 += q;
    }
}
fn qty(c: &Counts, n: &str, ids: &HashMap<String, String>) -> i64 {
    c.get(&key(n, ids)).map_or(0, |r| r.1)
}
fn list(v: &Value, ids: &HashMap<String, String>) -> Counts {
    let mut c = Counts::new();
    for r in v.as_array().into_iter().flatten() {
        if !matches!(text(r, "board"), "side" | "maybe") && r["maybe"] != true {
            add(&mut c, text(r, "name"), r["qty"].as_i64().unwrap_or(1).max(0), ids);
        }
    }
    c
}
#[derive(Default)]
struct Target {
    cards: Counts,
    pending: Counts,
    container: Option<String>,
}

/// Resolve every distinct written name in one statement, preserving the normal card-name
/// priority (real cards, exact full name, then popularity). No per-deck/per-name SQL awaits.
pub(super) async fn resolve_names(pool: &SqlitePool, names: &[String]) -> AppResult<HashMap<String, String>> {
    let names: std::collections::BTreeSet<&str> = names.iter().map(String::as_str).collect();
    let inputs: Vec<(&str, &str)> = names.into_iter().map(|name| (name, name.trim())).collect();
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT json_extract(j.value,'$[0]'), (SELECT n.oracle_id FROM card_names n JOIN cards c ON c.oracle_id=n.oracle_id
          WHERE n.name=json_extract(j.value,'$[1]')
          ORDER BY IFNULL(c.layout,'') IN ('token','double_faced_token','art_series'), c.name=n.name COLLATE NOCASE DESC,
                   IFNULL(c.edhrec_rank,1000000000) LIMIT 1)
         FROM json_each(?) j",
    )
    .bind(serde_json::to_string(&inputs).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(name, id)| id.map(|id| (name, id))).collect())
}

/// Canonical name, missing copies, pending-only. Main decks count once, configurations never
/// add physical demand. Boxed copies satisfy only their own deck; spare copies are allocated
/// once. Purchase marks never stand in for physical collection records.
pub(super) async fn needs(pool: &SqlitePool, owner: &str, b: &Value, include_pending: bool) -> AppResult<Vec<(String, i64, bool)>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT d.id,v.cards,d.container_id FROM decks d JOIN deck_versions v ON v.id=d.current_version_id AND v.deck_id=d.id
         WHERE d.owner_id=? AND d.archived=0 AND d.parent_id IS NULL",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let rows: Vec<(String, Value, Option<String>)> = rows
        .into_iter()
        .map(|(id, cards, container)| (id, serde_json::from_str(&cards).unwrap_or_default(), container))
        .collect();
    let mut names = Vec::new();
    for (_, cards, _) in &rows {
        for c in cards.as_array().into_iter().flatten() {
            names.push(text(c, "name").to_string());
        }
    }
    for d in b["decks"].as_array().into_iter().flatten() {
        for c in d["states"]["stock"]["cards"].as_array().into_iter().flatten() {
            names.push(text(c, "name").to_string());
        }
        for c in d["owner_changes"].as_array().into_iter().flatten() {
            names.push(text(c, "in").to_string());
            names.push(text(c, "out").to_string());
        }
    }
    for c in b["swaps"].as_array().into_iter().flatten() {
        names.push(text(c, "in").to_string());
        names.push(text(c, "out").to_string());
    }
    for r in b["reviews"].as_object().into_iter().flat_map(|r| r.values()) {
        names.push(text(r, "cut").to_string());
    }
    names.retain(|n| !n.trim().is_empty());
    // Resolve before counting: face aliases can identify one oracle, while different cards
    // can share a first face. Only oracle IDs settle their identity.
    let resolved = resolve_names(pool, &names).await?;
    let mut targets: BTreeMap<String, Target> = rows
        .into_iter()
        .map(|(id, cards, container)| {
            (
                id,
                Target {
                    cards: list(&cards, &resolved),
                    container,
                    ..Default::default()
                },
            )
        })
        .collect();
    let live: HashSet<&str> = b["swaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["retired"] != true)
        .filter_map(|s| s["key"].as_str())
        .collect();
    let answers = crate::plan::trip::answers(b, &live);
    let roots: HashMap<String, String> = b["decks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            (
                text(d, "key").to_string(),
                d["yama_deck"]["id"].as_str().map(String::from).unwrap_or_else(|| format!("plan:{}", text(d, "key"))),
            )
        })
        .collect();
    let mut transfers: Vec<(String, String, String)> = Vec::new();
    for d in b["decks"].as_array().into_iter().flatten() {
        if d["status"] == "archived" || d["plan"]["state"] == "archived" {
            continue;
        }
        let id = d["yama_deck"]["id"].as_str().map(String::from).unwrap_or_else(|| format!("plan:{}", text(d, "key")));
        let mut stock = list(&d["states"]["stock"]["cards"], &resolved);
        // The physical pre-plan baseline includes the owner's substitutions, as spares does.
        // These are distinct from the generated now list, which may include pending proposals.
        for change in d["owner_changes"].as_array().into_iter().flatten() {
            let out = text(change, "out");
            if qty(&stock, out, &resolved) > 0 {
                add(&mut stock, out, -1, &resolved);
                add(&mut stock, text(change, "in"), 1, &resolved);
            }
        }
        let t = targets.entry(id.clone()).or_insert_with(|| Target {
            cards: stock.clone(),
            ..Default::default()
        });
        let has_stock = d["states"]["stock"]["cards"].is_array();
        let waiting: HashSet<&str> = d["plan"]["next"]["keys"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let skipped: HashSet<&str> = d["plan"]["next"]["skipped"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let mut adds = Counts::new();
        let mut cuts = Counts::new();
        let mut later = Counts::new();
        for s in b["swaps"].as_array().into_iter().flatten().filter(|s| s["deck"] == d["key"]) {
            if s["retired"] == true || s["deck_superseded"] == true || s["role"] != "swap" {
                continue;
            }
            let sk = text(s, "key");
            let r = answers.get(sk).copied().unwrap_or(&Value::Null);
            let fresh = r["at"].as_str().is_none_or(|at| s["updated_at"].as_str().is_none_or(|u| u <= at));
            let accepted = s["stage"] == "planned" || (fresh && r["decision"] == "want" && matches!(d["plan"]["state"].as_str(), Some("in_progress" | "done")));
            if accepted {
                let inn = text(s, "in");
                if s["src"] == "owned" && s["got"]["how"] == "deck" {
                    let donor = text(&s["got"], "deck");
                    transfers.push((id.clone(), roots.get(donor).cloned().unwrap_or_else(|| donor.to_string()), inn.to_string()));
                }
                add(&mut adds, inn, 1, &resolved);
                let cut = r["cut"].as_str().filter(|c| !c.is_empty()).or(s["out"].as_str());
                if let Some(cut) = cut {
                    add(&mut cuts, cut, 1, &resolved);
                }
            } else if include_pending && waiting.contains(sk) && !skipped.contains(sk) && !(fresh && r["decision"] == "no") {
                add(&mut later, text(s, "in"), 1, &resolved);
            }
        }
        // Apply all deltas together. A→B followed by B→C has only C as its final target,
        // regardless of bundle ordering or which intermediate cards are already in the deck.
        let touched: HashSet<String> = adds.keys().chain(cuts.keys()).cloned().collect();
        for k in touched {
            let n = adds.get(&k).or_else(|| cuts.get(&k)).unwrap().0.clone();
            let baseline = if has_stock {
                qty(&stock, &n, &resolved)
            } else {
                qty(&t.cards, &n, &resolved).max(qty(&adds, &n, &resolved)) - qty(&adds, &n, &resolved)
            };
            t.cards.insert(k, (n.clone(), (baseline + qty(&adds, &n, &resolved) - qty(&cuts, &n, &resolved)).max(0)));
        }
        for (k, row) in later {
            t.pending.insert(k, row);
        }
    }
    let mut cards: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT oracle_id,name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?)) AND type_line NOT LIKE 'Basic%'")
            .bind(serde_json::to_string(&resolved.values().collect::<Vec<_>>()).map_err(anyhow::Error::from)?)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    // A forthcoming or misspelled card is still a stated need. Keep its written name with
    // unknown details; the next card import can resolve it without losing it from this list.
    for name in &names {
        if !resolved.contains_key(name) {
            cards.entry(key(name, &resolved)).or_insert_with(|| name.trim().to_string());
        }
    }
    let canonical = |counts: &Counts| {
        let mut out = HashMap::<String, i64>::new();
        for (n, q) in counts.values() {
            let id = resolved.get(n).cloned().unwrap_or_else(|| key(n, &resolved));
            if cards.contains_key(&id) {
                *out.entry(id).or_default() += q;
            }
        }
        out
    };
    let rows: Vec<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT p.oracle_id,i.container_id,c.kind,SUM(i.qty) FROM collection_items i JOIN printings p ON p.scryfall_id=i.scryfall_id
         LEFT JOIN containers c ON c.id=i.container_id AND c.owner_id=i.owner_id
         WHERE i.owner_id=? AND i.proxy=0 AND i.qty>0 GROUP BY p.oracle_id,i.container_id,c.kind",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut free = HashMap::<String, i64>::new();
    let mut boxed = HashMap::<(String, String), i64>::new();
    for (id, container, kind, q) in rows {
        if kind.as_deref() == Some("deck") {
            if let Some(c) = container {
                boxed.insert((c, id), q);
            }
        } else {
            *free.entry(id).or_default() += q;
        }
    }
    // Only real collection copies fulfill physical demand. A purchase/order mark is not
    // an inventory entry and may describe the very same copy entered into this collection.
    let mut gaps = Vec::new();
    for (root, t) in &targets {
        for (id, q) in canonical(&t.cards) {
            let in_box = t.container.as_ref().and_then(|c| boxed.get_mut(&(c.clone(), id.clone()))).map_or(0, |n| {
                let used = (*n).min(q);
                *n -= used;
                used
            });
            gaps.push((root.clone(), id, q - in_box, false));
        }
    }
    // A donor's confirmed target keeps its copies first. Only a real copy left over after
    // that allocation can fulfill an explicitly approved transfer to another target.
    for (destination, donor, name) in transfers {
        let Some(card) = resolved.get(&name) else { continue };
        let Some(container) = targets.get(&donor).and_then(|t| t.container.as_ref()) else {
            continue;
        };
        let Some(available) = boxed.get_mut(&(container.clone(), card.clone())) else { continue };
        if *available <= 0 {
            continue;
        }
        if let Some(index) = gaps.iter().position(|(root, id, q, pending)| root == &destination && id == card && *q > 0 && !*pending) {
            gaps[index].2 -= 1;
            *available -= 1;
        }
    }
    for (root, t) in &targets {
        for (id, q) in canonical(&t.pending) {
            let in_box = t.container.as_ref().and_then(|c| boxed.get_mut(&(c.clone(), id.clone()))).map_or(0, |n| {
                let used = (*n).min(q);
                *n -= used;
                used
            });
            gaps.push((root.clone(), id, q - in_box, true));
        }
    }
    // Confirmed needs take spare copies before speculative upgrades do.
    gaps.sort_by_key(|(_, _, _, pending)| *pending);
    let mut missing = HashMap::<String, (i64, i64)>::new();
    for (_, id, q, pending) in gaps {
        let spare = free.entry(id.clone()).or_default();
        let used = q.min(*spare);
        *spare -= used;
        let r = missing.entry(id).or_default();
        if pending {
            r.1 += q - used;
        } else {
            r.0 += q - used;
        }
    }
    Ok(missing
        .into_iter()
        .flat_map(|(id, (now, later))| {
            [(now, false), (later, true)]
                .into_iter()
                .filter(|(qty, _)| *qty > 0)
                .map(move |(qty, pending)| (id.clone(), qty, pending))
        })
        .map(|(id, qty, pending)| (cards[&id].clone(), qty, pending))
        .collect())
}
