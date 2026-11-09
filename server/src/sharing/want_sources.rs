//! Real-card needs across saved main decks and their upgrade plans. This deliberately does not
//! use the store trip: a proxy upgrade still has a real-card need, and a saved deck may have no
//! shopping entry. Pending proposals are read only for the owner's private overlay.
use crate::error::AppResult;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};

type Counts = BTreeMap<String, (String, i64)>;
fn name(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}
fn key(n: &str) -> String {
    n.split(" // ").next().unwrap_or(n).trim().to_lowercase()
}
fn add(c: &mut Counts, n: &str, qty: i64) {
    if !n.trim().is_empty() {
        let row = c.entry(key(n)).or_insert((n.to_string(), 0));
        row.1 = (row.1 + qty).max(0);
    }
}
fn list(v: &Value) -> Counts {
    let mut c = Counts::new();
    for row in v.as_array().into_iter().flatten() {
        if matches!(row["board"].as_str(), Some("side" | "maybe")) || row["maybe"] == true {
            continue;
        }
        add(&mut c, &name(row, "name"), row["qty"].as_i64().unwrap_or(1).max(0));
    }
    c
}

/// (canonical card name, missing real copies, pending only). Each physical main deck counts
/// once; alternate saved configurations are not extra decks. Real copies are allocated once
/// across all targets, so one Sol Ring cannot satisfy two decks. Explicit shopping wants are
/// merged separately by the caller and never inferred to be fulfilled by owning an old copy.
pub(super) async fn needs(pool: &SqlitePool, owner: &str, b: &Value, pending: bool) -> AppResult<Vec<(String, i64, bool)>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT d.id, v.cards, d.container_id FROM decks d JOIN deck_versions v ON v.id = d.current_version_id AND v.deck_id = d.id
         WHERE d.owner_id = ? AND d.archived = 0 AND d.parent_id IS NULL",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let containers: Vec<&str> = rows.iter().filter_map(|r| r.2.as_deref()).collect();
    let containers = serde_json::to_string(&containers).map_err(anyhow::Error::from)?;
    let live: HashSet<&str> = b["swaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["retired"] != true)
        .filter_map(|s| s["key"].as_str())
        .collect();
    let answers = crate::plan::trip::answers(b, &live);
    let bought = crate::plan::trip::bought(b, &live);
    let mut acquired = Counts::new();
    let mut targets: HashMap<String, Counts> = rows
        .into_iter()
        .map(|(id, cards, _)| (id, list(&serde_json::from_str::<Value>(&cards).unwrap_or_default())))
        .collect();
    let mut future: HashMap<String, Counts> = HashMap::new();
    // A replacement plan for a deck is archived by versions.rs; only the live plan contributes.
    for d in b["decks"].as_array().into_iter().flatten() {
        if d["status"] == "archived" || d["plan"]["state"] == "archived" {
            continue;
        }
        let dk = name(d, "key");
        let id = d["yama_deck"]["id"].as_str().map(String::from).unwrap_or_else(|| format!("plan:{dk}"));
        let target = targets.entry(id.clone()).or_insert_with(|| list(&d["states"]["now"]["cards"]));
        let waiting: HashSet<&str> = d["plan"]["next"]["keys"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let skipped: HashSet<&str> = d["plan"]["next"]["skipped"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let stock = list(&d["states"]["stock"]["cards"]);
        let mut additions: HashMap<String, i64> = HashMap::new();
        let mut cuts: HashMap<String, i64> = HashMap::new();
        let before = target.clone();
        for s in b["swaps"].as_array().into_iter().flatten().filter(|s| s["deck"] == dk) {
            if s["retired"] == true || s["deck_superseded"] == true || s["role"] != "swap" || !matches!(s["src"].as_str(), Some("buy" | "print")) {
                continue;
            }
            let sk = name(s, "key");
            let review = answers.get(&sk).copied().unwrap_or(&Value::Null);
            let fresh = review["at"].as_str().is_none_or(|at| s["updated_at"].as_str().is_none_or(|u| u <= at));
            let accepted = s["stage"] == "planned" || (review["decision"] == "want" && fresh && matches!(d["plan"]["state"].as_str(), Some("in_progress" | "done")));
            let incoming = name(s, "in");
            if accepted {
                // Apply against stock, not by adding to the current list: an incoming card
                // can already be present while its cut remains. That isn't a second copy.
                let ik = key(&incoming);
                let n = additions.entry(ik.clone()).or_default();
                *n += 1;
                let desired = stock.get(&ik).map_or(0, |r| r.1) + *n;
                let row = target.entry(ik).or_insert((incoming.clone(), 0));
                row.1 = row.1.max(desired);
                let cut = review["cut"].as_str().filter(|c| !c.is_empty()).or(s["out"].as_str());
                if let Some(cut) = cut {
                    let ck = key(cut);
                    let n = cuts.entry(ck.clone()).or_default();
                    *n += 1;
                    let baseline = stock.get(&ck).or_else(|| before.get(&ck)).map_or(0, |r| r.1);
                    if let Some(row) = target.get_mut(&ck) {
                        row.1 = row.1.min((baseline - *n).max(0));
                    }
                }
                // Recorded real acquisitions are a coverage floor, never added to collection
                // totals (the same purchase may already have been entered there).
                if s["src"] == "buy" && (!s["order_item"].is_null() || bought.contains(&sk)) {
                    add(&mut acquired, &incoming, 1);
                }
            } else if pending && waiting.contains(sk.as_str()) && !skipped.contains(sk.as_str()) && review["decision"] != "no" {
                // Alternatives never remove a current card until approved. One copy of an idea
                // already in this deck's target isn't another acquisition.
                let c = future.entry(id.clone()).or_default();
                if target.get(&key(&incoming)).map_or(0, |r| r.1) == 0 {
                    c.entry(key(&incoming)).or_insert((incoming, 1));
                }
            }
        }
    }
    let mut confirmed = Counts::new();
    let mut proposed = Counts::new();
    for c in targets.values() {
        for (n, q) in c.values() {
            add(&mut confirmed, n, *q);
        }
    }
    for c in future.values() {
        for (n, q) in c.values() {
            add(&mut proposed, n, *q);
        }
    }
    let names: Vec<String> = confirmed.values().chain(proposed.values()).chain(acquired.values()).map(|(n, _)| n.clone()).collect();
    let resolved = crate::cards::resolve_names(pool, &names).await?;
    let owned: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
        "SELECT p.oracle_id, SUM(i.qty) FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
         LEFT JOIN containers box ON box.id = i.container_id AND box.owner_id = i.owner_id
         WHERE i.owner_id = ? AND i.proxy = 0 AND i.qty > 0
           AND (box.kind IS NULL OR box.kind != 'deck' OR box.id IN (SELECT value FROM json_each(?)))
         GROUP BY p.oracle_id",
    )
    .bind(owner)
    .bind(&containers)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let cards: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT oracle_id, name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?)) AND type_line NOT LIKE 'Basic%'")
            .bind(serde_json::to_string(&resolved.values().collect::<Vec<_>>()).map_err(anyhow::Error::from)?)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut demand: HashMap<String, (i64, i64)> = HashMap::new();
    for (c, p) in [(&confirmed, false), (&proposed, true)] {
        for (n, q) in c.values() {
            if let Some(id) = resolved.get(n).filter(|id| cards.contains_key(*id)) {
                let entry = demand.entry(id.clone()).or_default();
                if p {
                    entry.1 += q;
                } else {
                    entry.0 += q;
                }
            }
        }
    }
    let mut out = Vec::new();
    for (id, (confirmed, proposed)) in demand {
        let acquired = acquired.values().filter(|(n, _)| resolved.get(n) == Some(&id)).map(|r| r.1).sum::<i64>();
        let real = owned.get(&id).copied().unwrap_or(0).max(acquired);
        let missing = (confirmed - real).max(0);
        let later = (confirmed + proposed - real).max(0) - missing;
        if missing + later > 0 {
            out.push((cards[&id].clone(), missing + later, missing == 0));
        }
    }
    Ok(out)
}
