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
fn key(n: &str) -> String {
    n.split(" // ").next().unwrap_or(n).trim().to_lowercase()
}
fn add(c: &mut Counts, n: &str, q: i64) {
    if !n.trim().is_empty() {
        let r = c.entry(key(n)).or_insert((n.to_string(), 0));
        r.1 += q;
    }
}
fn qty(c: &Counts, n: &str) -> i64 {
    c.get(&key(n)).map_or(0, |r| r.1)
}
fn list(v: &Value) -> Counts {
    let mut c = Counts::new();
    for r in v.as_array().into_iter().flatten() {
        if !matches!(text(r, "board"), "side" | "maybe") && r["maybe"] != true {
            add(&mut c, text(r, "name"), r["qty"].as_i64().unwrap_or(1).max(0));
        }
    }
    c
}
#[derive(Default)]
struct Target {
    cards: Counts,
    pending: Counts,
    acquired: Counts,
    container: Option<String>,
}

/// Canonical name, missing copies, pending-only. Main decks count once, configurations never
/// add physical demand. Boxed copies satisfy only their own deck; spare copies are allocated
/// once. Recorded acquisitions cover their target, without counting the same entered copy twice.
pub(super) async fn needs(pool: &SqlitePool, owner: &str, b: &Value, include_pending: bool) -> AppResult<Vec<(String, i64, bool)>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT d.id,v.cards,d.container_id FROM decks d JOIN deck_versions v ON v.id=d.current_version_id AND v.deck_id=d.id
         WHERE d.owner_id=? AND d.archived=0 AND d.parent_id IS NULL",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut targets: BTreeMap<String, Target> = rows
        .into_iter()
        .map(|(id, cards, container)| {
            (
                id,
                Target {
                    cards: list(&serde_json::from_str::<Value>(&cards).unwrap_or_default()),
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
    let bought = crate::plan::trip::bought(b, &live);
    for d in b["decks"].as_array().into_iter().flatten() {
        if d["status"] == "archived" || d["plan"]["state"] == "archived" {
            continue;
        }
        let id = d["yama_deck"]["id"].as_str().map(String::from).unwrap_or_else(|| format!("plan:{}", text(d, "key")));
        let t = targets.entry(id).or_insert_with(|| Target {
            cards: list(&d["states"]["now"]["cards"]),
            ..Default::default()
        });
        let stock = list(&d["states"]["stock"]["cards"]);
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
                add(&mut adds, inn, 1);
                let cut = r["cut"].as_str().filter(|c| !c.is_empty()).or(s["out"].as_str());
                if let Some(cut) = cut {
                    add(&mut cuts, cut, 1);
                }
                if s["src"] == "owned" || (s["src"] == "buy" && (!s["order_item"].is_null() || bought.contains(sk))) {
                    add(&mut t.acquired, inn, 1);
                }
            } else if include_pending && waiting.contains(sk) && !skipped.contains(sk) && !(fresh && r["decision"] == "no") {
                later.entry(key(text(s, "in"))).or_insert((text(s, "in").to_string(), 1));
            }
        }
        // Apply all deltas together. A→B followed by B→C has only C as its final target,
        // regardless of bundle ordering or which intermediate cards are already in the deck.
        let touched: HashSet<String> = adds.keys().chain(cuts.keys()).cloned().collect();
        for k in touched {
            let n = adds.get(&k).or_else(|| cuts.get(&k)).unwrap().0.clone();
            let baseline = if has_stock {
                qty(&stock, &n)
            } else {
                qty(&t.cards, &n).max(qty(&adds, &n)) - qty(&adds, &n)
            };
            t.cards.insert(k, (n.clone(), (baseline + qty(&adds, &n) - qty(&cuts, &n)).max(0)));
        }
        for (k, (n, q)) in later {
            if qty(&t.cards, &n) == 0 {
                t.pending.insert(k, (n, q));
            }
        }
    }
    let names: Vec<String> = targets
        .values()
        .flat_map(|t| t.cards.values().chain(t.pending.values()).chain(t.acquired.values()))
        .map(|r| r.0.clone())
        .collect();
    let resolved = crate::cards::resolve_names(pool, &names).await?;
    let cards: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT oracle_id,name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?)) AND type_line NOT LIKE 'Basic%'")
            .bind(serde_json::to_string(&resolved.values().collect::<Vec<_>>()).map_err(anyhow::Error::from)?)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let canonical = |counts: &Counts| {
        let mut out = HashMap::<String, i64>::new();
        for (n, q) in counts.values() {
            if let Some(id) = resolved.get(n).filter(|id| cards.contains_key(*id)) {
                *out.entry(id.clone()).or_default() += q;
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
    let mut gaps = Vec::new();
    for t in targets.values() {
        let acquired = canonical(&t.acquired);
        for (id, q) in canonical(&t.cards) {
            let in_box = t.container.as_ref().and_then(|c| boxed.get_mut(&(c.clone(), id.clone()))).map_or(0, |n| {
                let used = (*n).min(q);
                *n -= used;
                used
            });
            let credit = acquired.get(&id).copied().unwrap_or(0).min(q).max(in_box);
            // A recorded purchase might already be among loose collection copies. Consume
            // those first; physically distinct copies in another target's box are untouched.
            let spare = free.entry(id.clone()).or_default();
            *spare = (*spare - (credit - in_box)).max(0);
            gaps.push((id, q - credit, false));
        }
    }
    for t in targets.values() {
        for (id, q) in canonical(&t.pending) {
            let in_box = t.container.as_ref().and_then(|c| boxed.get_mut(&(c.clone(), id.clone()))).map_or(0, |n| {
                let used = (*n).min(q);
                *n -= used;
                used
            });
            gaps.push((id, q - in_box, true));
        }
    }
    // Confirmed needs take spare copies before speculative upgrades do.
    gaps.sort_by_key(|(_, _, pending)| *pending);
    let mut missing = HashMap::<String, (i64, i64)>::new();
    for (id, q, pending) in gaps {
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
        .filter_map(|(id, (now, later))| (now + later > 0).then(|| (cards[&id].clone(), now + later, later > 0)))
        .collect())
}
