//! Whether a planned swap is in the real deck, read from the deck itself (Bryan, 2026-10-28: "We
//! should definitely store them on the actual decks themselves").
//!
//! A plan deck's Yama deck is the main deck of the linked deck's group (`plan_decks.deck_id`; a
//! link to a configuration such as "stock" reads its main deck, because the main deck is the list
//! that's in the box), else the only live main deck with the plan deck's exact name. A planned
//! swap is installed when that deck's current list has its card in and its card out gone, counted
//! against the plan's stock list so basics and repeated cards work: more copies of the card in
//! than stock has, and fewer copies of the card out than stock has (none, if stock never had it).
//!
//! With no Yama deck, nothing is derived (`None`), and the plan's install record and the
//! owner's ticks (`plan_marks`) still decide, as before.

use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;

/// Copies by lower-case name. A double-faced card counts under its full name and its front face.
pub type Counts = HashMap<String, i64>;

fn norm(name: &str) -> String {
    name.trim().to_lowercase()
}

fn add(counts: &mut Counts, name: &str, qty: i64) {
    let full = norm(name);
    if let Some((front, _)) = full.split_once(" // ") {
        *counts.entry(front.trim().to_string()).or_default() += qty;
    }
    *counts.entry(full).or_default() += qty;
}

fn get(counts: &Counts, name: &str) -> i64 {
    let n = norm(name);
    counts.get(&n).copied().or_else(|| n.split_once(" // ").and_then(|(front, _)| counts.get(front.trim()).copied())).unwrap_or(0)
}

/// Commander and main-board copies of a list of `{name, qty, board}` (a deck version or a plan list).
pub fn counts(cards: &[Value]) -> Counts {
    let mut out = Counts::new();
    for c in cards {
        if c.get("board").and_then(Value::as_str).is_some_and(|b| b == "side" || b == "maybe") {
            continue;
        }
        if let Some(name) = c.get("name").and_then(Value::as_str) {
            add(&mut out, name, c.get("qty").and_then(Value::as_i64).unwrap_or(1));
        }
    }
    out
}

/// The rule: `inn` is in beyond its stock copies, and `out` (if any) is below its stock copies,
/// or gone when stock never had it.
pub fn in_deck(stock: &Counts, deck: &Counts, inn: &str, out: Option<&str>) -> bool {
    let has_in = get(deck, inn) > get(stock, inn);
    let out_gone = match out.map(str::trim).filter(|o| !o.is_empty()) {
        None => true,
        Some(o) => get(deck, o) < get(stock, o).max(1),
    };
    has_in && out_gone
}

/// The Yama deck a plan deck reads its installs from.
#[derive(Debug, Clone, Serialize)]
pub struct YamaDeck {
    pub id: String,
    pub name: String,
    /// The main deck's own label ("Main" when it has none); always a main deck.
    pub configuration: Option<String>,
    pub version_id: Option<String>,
    /// When its current list was saved.
    pub list_at: Option<String>,
    /// `true` when the plan deck is linked; `false` when it was found by name.
    pub linked: bool,
}

#[derive(Default)]
pub struct Installs {
    /// By plan deck id.
    pub decks: HashMap<String, YamaDeck>,
    /// By swap key, for planned swaps of plan decks with a Yama deck.
    pub swaps: HashMap<String, bool>,
    /// Stand-ins out of the deck because the print they held a slot for is in: done, not waiting.
    pub superseded: HashMap<String, bool>,
}

type DeckRow = (String, String, Option<String>, Option<String>, Option<String>);

async fn yama_deck(pool: &SqlitePool, owner: &str, linked: Option<&str>, name: &str) -> AppResult<Option<YamaDeck>> {
    if let Some(id) = linked {
        let row: Option<DeckRow> = sqlx::query_as(
            "SELECT p.id, p.name, p.configuration, p.current_version_id, v.created_at
             FROM decks d JOIN decks p ON p.id = COALESCE(d.parent_id, d.id) AND p.owner_id = d.owner_id
             LEFT JOIN deck_versions v ON v.id = p.current_version_id
             WHERE d.id = ? AND d.owner_id = ? AND d.archived = 0 AND p.archived = 0",
        )
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?;
        if let Some((id, name, configuration, version_id, list_at)) = row {
            return Ok(Some(YamaDeck { id, name, configuration, version_id, list_at, linked: true }));
        }
    }
    let rows: Vec<DeckRow> = sqlx::query_as(
        "SELECT d.id, d.name, d.configuration, d.current_version_id, v.created_at
         FROM decks d LEFT JOIN deck_versions v ON v.id = d.current_version_id
         WHERE d.owner_id = ? AND d.archived = 0 AND d.parent_id IS NULL AND lower(d.name) = lower(?)",
    )
    .bind(owner)
    .bind(name.trim())
    .fetch_all(pool)
    .await?;
    Ok(if rows.len() == 1 {
        rows.into_iter().next().map(|(id, name, configuration, version_id, list_at)| YamaDeck { id, name, configuration, version_id, list_at, linked: false })
    } else {
        None
    })
}

/// Every live plan deck's Yama deck, and the installed state of each planned swap it can judge.
pub async fn load(pool: &SqlitePool, owner: &str) -> AppResult<Installs> {
    let decks: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, name, deck_id FROM plan_decks WHERE owner_id = ? AND status != 'archived'").bind(owner).fetch_all(pool).await?;
    let mut out = Installs::default();
    let mut lists: HashMap<String, (Counts, Counts)> = HashMap::new();
    for (plan_id, name, linked) in decks {
        let Some(deck) = yama_deck(pool, owner, linked.as_deref(), &name).await? else { continue };
        let deck_cards: Vec<Value> = match &deck.version_id {
            Some(v) => {
                let text: Option<String> = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(v).fetch_optional(pool).await?;
                text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
            }
            None => vec![],
        };
        let stock: Option<String> = sqlx::query_scalar("SELECT cards FROM plan_states WHERE owner_id = ? AND plan_deck_id = ? AND state = 'stock' AND current = 1")
            .bind(owner)
            .bind(&plan_id)
            .fetch_optional(pool)
            .await?;
        let stock: Vec<Value> = stock.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        lists.insert(plan_id.clone(), (counts(&stock), counts(&deck_cards)));
        out.decks.insert(plan_id, deck);
    }
    let swaps: Vec<(String, String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT s.ext_key, s.plan_deck_id, s.in_name, s.out_name, s.role, p.ext_key
         FROM plan_swaps s LEFT JOIN plan_swaps p ON p.id = s.parent_id AND p.owner_id = s.owner_id
         WHERE s.owner_id = ? AND s.retired_at IS NULL AND s.stage = 'planned'",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut standins: Vec<(String, String)> = Vec::new();
    for (key, plan_id, inn, out_name, role, parent) in swaps {
        if let Some((stock, deck)) = lists.get(&plan_id) {
            let on = in_deck(stock, deck, &inn, out_name.as_deref());
            if role == "standin"
                && !on
                && let Some(p) = parent
            {
                standins.push((key.clone(), p));
            }
            out.swaps.insert(key, on);
        }
    }
    for (key, parent) in standins {
        if out.swaps.get(&parent).copied().unwrap_or(false) {
            out.superseded.insert(key, true);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list(cards: &[(&str, i64)]) -> Counts {
        counts(&cards.iter().map(|(n, q)| json!({"name": n, "qty": q, "board": "main"})).collect::<Vec<_>>())
    }

    #[test]
    fn a_swap_is_in_when_its_card_is_in_and_its_cut_is_gone() {
        let stock = list(&[("Old Card", 1), ("Plains", 9)]);
        assert!(in_deck(&stock, &list(&[("New Card", 1), ("Plains", 9)]), "New Card", Some("Old Card")));
        // The new card is in but the old one is still there: not installed.
        assert!(!in_deck(&stock, &list(&[("New Card", 1), ("Old Card", 1)]), "New Card", Some("Old Card")));
        // The old card is out but the new one isn't in yet.
        assert!(!in_deck(&stock, &list(&[("Plains", 9)]), "New Card", Some("Old Card")));
        // No card out (an optional extra): in is enough.
        assert!(in_deck(&stock, &list(&[("Extra", 1)]), "Extra", None));
    }

    #[test]
    fn basics_and_cards_stock_never_had_count_by_copies() {
        let stock = list(&[("Plains", 9), ("Island", 5)]);
        // Plateau for one of nine Plains: eight left means it's in.
        assert!(in_deck(&stock, &list(&[("Plateau", 1), ("Plains", 8), ("Island", 5)]), "Plateau", Some("Plains")));
        assert!(!in_deck(&stock, &list(&[("Plateau", 1), ("Plains", 9)]), "Plateau", Some("Plains")));
        // An Island added over stock's five.
        assert!(in_deck(&stock, &list(&[("Island", 6)]), "Island", Some("Field of Ruin")));
        assert!(!in_deck(&stock, &list(&[("Island", 5)]), "Island", Some("Field of Ruin")));
        // The card out came in later (an owner's own change), so stock never had it: gone means gone.
        assert!(in_deck(&stock, &list(&[("Volcanic Island", 1)]), "Volcanic Island", Some("Mount Doom")));
        assert!(!in_deck(&stock, &list(&[("Volcanic Island", 1), ("Mount Doom", 1)]), "Volcanic Island", Some("Mount Doom")));
    }

    #[test]
    fn names_match_without_case_and_by_front_face() {
        let stock = list(&[]);
        let deck = list(&[("Brazen Borrower // Petty Theft", 1)]);
        assert!(in_deck(&stock, &deck, "brazen borrower", None));
        assert!(in_deck(&stock, &deck, "Brazen Borrower // Petty Theft", None));
        // The side board doesn't count.
        let side = counts(&[json!({"name": "Spare", "qty": 1, "board": "side"})]);
        assert!(!in_deck(&stock, &side, "Spare", None));
    }
}
