//! Versioned editorial assessments, shared by public, signed-in and MCP precon views.
//! This is deliberately independent of prices, simulation strength and commander popularity.
use crate::{decks::Board, lab::PreconCard};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock};

pub const METHOD: &str = "editorial-upgradeability-v1";
pub const BASIS: &str = "Provisional editorial assessment of upgrade potential while keeping the stock commander and deck identity. Not a tested upgrade list, commander ranking, price rating or predicted win rate.";
pub const RUBRIC: &str = "1 Limited: few coherent routes without changing identity. 2 Constrained: structural commander or theme limits. 3 Good: clear improvements with setup or pool constraints. 4 High: a well-supported engine with several useful packages. 5 Very high: a deep, scalable engine with substantial room for focused optimization. Effort describes refocusing work, not spending: Targeted refines the existing engine; Moderate replaces several packages; Substantial rebuilds much of the shell.";

#[derive(Debug, Clone, Serialize)]
pub struct Assessment {
    pub score: Option<u8>,
    pub label: &'static str,
    pub status: &'static str,
    pub effort: Option<String>,
    pub path: Option<String>,
    pub limitation: Option<String>,
    pub assessed_on: Option<String>,
    pub source_url: Option<String>,
    pub method: &'static str,
    pub basis: &'static str,
    pub rubric: &'static str,
}

#[derive(Deserialize)]
struct Document {
    method: String,
    assessed_on: String,
    decks: BTreeMap<String, Entry>,
}
#[derive(Deserialize)]
struct Entry {
    score: u8,
    effort: String,
    path: String,
    limitation: String,
    source_url: String,
    stock: Vec<(String, String, u32)>,
}
static DATA: LazyLock<Document> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/precon-upgradeability.json"))
        .expect("validated upgradeability document")
});

fn key<'a>(rows: impl Iterator<Item = (&'a str, &'a str, u32)>) -> BTreeMap<(String, String), u32> {
    let mut out = BTreeMap::new();
    for (board, name, qty) in rows {
        // The catalog resolves double-faced names to their front face. Printings do not matter.
        let name = name.split(" // ").next().unwrap_or(name).to_lowercase();
        *out.entry((board.into(), name)).or_default() += qty;
    }
    out
}
fn board(b: &Board) -> &'static str {
    match b {
        Board::Commander => "commander",
        Board::Main => "main",
        Board::Side => "side",
    }
}

pub fn assess(id: &str, cards: &[PreconCard]) -> Assessment {
    let mut result = Assessment {
        score: None,
        label: "Not assessed",
        status: "not_assessed",
        effort: None,
        path: None,
        limitation: None,
        assessed_on: None,
        source_url: None,
        method: METHOD,
        basis: BASIS,
        rubric: RUBRIC,
    };
    debug_assert_eq!(DATA.method, METHOD);
    let Some(entry) = DATA.decks.get(id) else {
        return result;
    };
    result.assessed_on = Some(DATA.assessed_on.clone());
    result.source_url = Some(entry.source_url.clone());
    if key(cards
        .iter()
        .map(|c| (board(&c.board), c.name.as_str(), c.qty)))
        != key(entry
            .stock
            .iter()
            .map(|(b, n, q)| (b.as_str(), n.as_str(), *q)))
    {
        result.status = "stock_list_changed";
        result.label = "Needs reassessment";
        return result;
    }
    result.score = Some(entry.score);
    result.label = match entry.score {
        1 => "Limited",
        2 => "Constrained",
        3 => "Good",
        4 => "High",
        5 => "Very high",
        _ => "Not assessed",
    };
    result.status = "provisional";
    result.effort = Some(entry.effort.clone());
    result.path = Some(entry.path.clone());
    result.limitation = Some(entry.limitation.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stock(id: &str) -> Vec<PreconCard> {
        DATA.decks[id]
            .stock
            .iter()
            .map(|(b, n, q)| PreconCard {
                name: n.clone(),
                qty: *q,
                oracle_id: None,
                board: match b.as_str() {
                    "commander" => Board::Commander,
                    "main" => Board::Main,
                    _ => panic!("unexpected board"),
                },
            })
            .collect()
    }
    #[test]
    fn complete_dated_stock_assessments() {
        assert_eq!(DATA.method, METHOD);
        assert_eq!(DATA.decks.len(), 174);
        for (id, e) in &DATA.decks {
            assert!((1..=5).contains(&e.score), "{id}");
            assert!(["Targeted", "Moderate", "Substantial"].contains(&e.effort.as_str()));
            assert!(!e.path.is_empty() && !e.limitation.is_empty());
            assert!(
                e.source_url
                    .starts_with("https://mtgjson.com/api/v5/decks/")
            );
            let cards = stock(id);
            assert_eq!(cards.iter().map(|c| c.qty).sum::<u32>(), 100, "{id}");
            assert_eq!(assess(id, &cards).score, Some(e.score));
        }
    }
    #[test]
    fn changed_list_or_commander_never_inherits_a_grade() {
        let id = "quantum-quandrix";
        let mut cards = stock(id);
        cards
            .iter_mut()
            .find(|c| c.board == Board::Commander)
            .unwrap()
            .name = "Esix, Fractal Bloom".into();
        let a = assess(id, &cards);
        assert_eq!(a.score, None);
        assert_eq!(a.status, "stock_list_changed");
        assert_eq!(assess("future-precon", &cards).score, None);
        cards = stock(id);
        cards[0].qty += 1;
        assert_eq!(assess(id, &cards).score, None);
    }
    #[test]
    fn ordering_printings_and_front_face_spelling_do_not_change_assessment() {
        let id = "quantum-quandrix";
        let mut cards = stock(id);
        cards.reverse();
        for c in &mut cards {
            c.oracle_id = Some("different-printing".into());
            if c.name == "Incubation" {
                c.name = "Incubation // Incongruity".into();
            }
        }
        assert_eq!(assess(id, &cards).score, Some(5));
        let i = cards.iter().position(|c| c.qty > 1).unwrap();
        let mut split = cards[i].clone();
        split.qty = 1;
        cards[i].qty -= 1;
        cards.push(split);
        assert_eq!(assess(id, &cards).score, Some(5));
    }
    #[tokio::test]
    async fn public_and_private_views_share_assessments_without_inheriting_to_changed_lists() {
        let pool = crate::db::test_pool().await;
        let id = "scions-spellcraft-final-fantasy-xiv";
        let cards = stock(id);
        sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,notes) VALUES (?,?,'Scions & Spellcraft','FIC',?,'WUB',?,'MTGJSON','hash','2026-10-27','[]')")
            .bind(id).bind(format!("precons/{id}"))
            .bind(serde_json::to_string(&vec!["Y'shtola, Night's Blessed"]).unwrap())
            .bind(serde_json::to_string(&cards).unwrap()).execute(&pool).await.unwrap();
        let private = crate::lab::precon_detail(&pool, id).await.unwrap();
        let public = crate::public_precons::catalog(&pool).await.unwrap();
        assert_eq!(private.precon.upgradeability.score, Some(5));
        assert_eq!(
            serde_json::to_value(&private.precon.upgradeability).unwrap(),
            serde_json::to_value(&public.precons[0].upgradeability).unwrap()
        );
        assert_eq!(
            crate::lab::precon_list(&pool).await.unwrap().precons[0]
                .upgradeability
                .score,
            Some(5)
        );
        // Public HTML uses the same data and escapes authored text; no sign-in is required.
        use tower::ServiceExt;
        let state = crate::testutil::state_with(crate::testutil::config(), pool.clone()).await;
        let app = crate::routes::app(state);
        for path in [format!("/precons/{id}"), "/precons?s=upgradeability".into()] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let html = String::from_utf8(body.to_vec()).unwrap();
            assert!(html.contains("5/5 Very high"));
            assert!(html.contains("Substantial"));
            assert!(html.contains("Provisional editorial"));
        }
        let mut changed = cards;
        changed[0].name = "Different card".into();
        sqlx::query("UPDATE precons SET cards=? WHERE id=?")
            .bind(serde_json::to_string(&changed).unwrap())
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            crate::lab::precon_detail(&pool, id)
                .await
                .unwrap()
                .precon
                .upgradeability
                .score,
            None
        );
        assert_eq!(
            crate::public_precons::catalog(&pool).await.unwrap().precons[0]
                .upgradeability
                .status,
            "stock_list_changed"
        );
    }
}
