//! Owner-scoped changes expose presentation fields, never their raw execution payload.

use super::{CardRef, ChangeView};
use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct PreviewCard {
    pub oracle_id: Option<String>,
    pub name: String,
    pub qty: u32,
    pub image: Option<String>,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChangePreview {
    pub kind: &'static str,
    pub target: String,
    pub target_id: Option<String>,
    pub add: Vec<PreviewCard>,
    pub remove: Vec<PreviewCard>,
    pub explanation: Option<String>,
    pub checks: Option<String>,
}

fn cards(refs: Vec<CardRef>) -> Vec<PreviewCard> {
    let mut cards: Vec<PreviewCard> = Vec::new();
    for r in refs {
        if let Some(c) = cards
            .iter_mut()
            .find(|c| c.oracle_id.as_deref() == Some(&r.oracle_id))
        {
            c.qty += 1;
        } else {
            cards.push(PreviewCard {
                oracle_id: Some(r.oracle_id),
                name: r.name,
                qty: 1,
                image: None,
                mana_cost: None,
                type_line: None,
            });
        }
    }
    cards
}

fn named(name: &str) -> PreviewCard {
    PreviewCard {
        oracle_id: None,
        name: name.into(),
        qty: 1,
        image: None,
        mana_cost: None,
        type_line: None,
    }
}

/// Read only known fields. Old/unsupported kinds and malformed payloads keep the text fallback.
pub(super) fn from_payload(
    kind: &str,
    payload: &str,
    detail: Option<&str>,
) -> Option<ChangePreview> {
    let p: Value = serde_json::from_str(payload).ok()?;
    let text = |key: &str| {
        p[key]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
    };
    match kind {
        // save_deck uses the same change kind for a complete list, not a set of swaps.
        // Keep its full-list detail rather than implying additions/removals it never staged.
        "edit_deck" if p["complete_list"] == true => None,
        "edit_deck" => Some(ChangePreview {
            kind: "deck_edit",
            target: text("deck")?,
            target_id: text("deck_id"),
            add: cards(serde_json::from_value(p["add"].clone()).ok()?),
            remove: cards(serde_json::from_value(p["remove"].clone()).ok()?),
            explanation: text("note"),
            checks: detail
                .and_then(|d| d.split_once("The list after:\n"))
                .map(|(_, checks)| checks.trim().into()),
        }),
        "propose_swap" => Some(ChangePreview {
            kind: "plan_swap",
            target: text("deck")?,
            target_id: None,
            add: vec![named(&text("in")?)],
            remove: text("out")
                .map(|name| vec![named(&name)])
                .unwrap_or_default(),
            explanation: text("why"),
            checks: None,
        }),
        _ => None,
    }
}

/// Load shared card metadata in one batch. Images stay Scryfall runtime URLs.
pub(super) async fn enrich(pool: &SqlitePool, views: &mut [ChangeView]) -> AppResult<()> {
    let unresolved: Vec<_> = views
        .iter()
        .filter_map(|v| v.preview.as_ref())
        .flat_map(|p| p.add.iter().chain(&p.remove))
        .filter(|c| c.oracle_id.is_none())
        .map(|c| c.name.clone())
        .collect();
    let resolved = if unresolved.is_empty() {
        HashMap::new()
    } else {
        crate::cards::resolve_names(pool, &unresolved).await?
    };
    let mut ids = Vec::new();
    for p in views.iter_mut().filter_map(|v| v.preview.as_mut()) {
        for c in p.add.iter_mut().chain(&mut p.remove) {
            if c.oracle_id.is_none() {
                c.oracle_id = resolved.get(&c.name).cloned();
            }
            if let Some(id) = &c.oracle_id {
                ids.push(id.clone());
            }
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    ids.sort();
    ids.dedup();
    let rows: Vec<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT oracle_id, image_normal, mana_cost, type_line FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))",
    ).bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?).fetch_all(pool).await?;
    let info: HashMap<_, _> = rows
        .into_iter()
        .map(|(id, image, cost, ty)| (id, (image, cost, ty)))
        .collect();
    for p in views.iter_mut().filter_map(|v| v.preview.as_mut()) {
        for c in p.add.iter_mut().chain(&mut p.remove) {
            if let Some((image, cost, ty)) = c.oracle_id.as_ref().and_then(|id| info.get(id)) {
                c.image.clone_from(image);
                c.mana_cost.clone_from(cost);
                c.type_line = Some(ty.clone());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn existing_deck_payloads_preserve_quantities_and_do_not_guess_swap_pairs() {
        let p = json!({"deck":"Deck", "deck_id":"d1", "base_version":"private-version",
            "add":[{"oracle_id":"b","name":"Beta"},{"oracle_id":"b","name":"Beta"}],
            "remove":[{"oracle_id":"a","name":"Alpha"}], "note":"1. A reason\n2. Another reason", "secret":"never expose"});
        let v = from_payload(
            "edit_deck",
            &p.to_string(),
            Some("Why: old text\nThe list after:\nCards: 100\n"),
        )
        .unwrap();
        assert_eq!(v.add[0].qty, 2);
        assert_eq!(v.remove[0].name, "Alpha");
        assert_eq!(v.checks.as_deref(), Some("Cards: 100"));
        let serialized = serde_json::to_string(&v).unwrap();
        assert!(!serialized.contains("private-version") && !serialized.contains("secret"));
        assert!(from_payload("edit_deck", "{}", None).is_none());
        assert!(from_payload("unknown_future_kind", &p.to_string(), None).is_none());
    }

    #[test]
    fn a_plan_idea_can_add_a_card_without_a_cut() {
        let p = json!({"deck":"Deck", "deck_key":"deck", "in":"Beta", "out":null, "why":"Try it"});
        let v = from_payload("propose_swap", &p.to_string(), None).unwrap();
        assert_eq!(v.kind, "plan_swap");
        assert_eq!(v.add[0].name, "Beta");
        assert!(v.remove.is_empty());
    }

    #[test]
    fn complete_lists_keep_the_full_list_text_fallback() {
        let p = json!({"complete_list":true, "name":"Deck", "cards":[],
            "deck":"Deck", "add":[{"oracle_id":"b","name":"Beta"}], "remove":[]});
        assert!(from_payload("edit_deck", &p.to_string(), Some("Commander\n1 Alpha\n\nDeck\n99 Beta")).is_none());
    }
}
