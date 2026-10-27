//! Source-backed editorial grades and separately scoped commander observations.
use crate::{decks::Board, lab::PreconCard};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock};

pub const METHOD: &str = "source-backed-upgradeability-v2";
pub const BASIS: &str = "Yama's editorial judgment of improvement options while retaining the catalog commander and main theme. Based on the cited guides, checked card examples and commander restrictions. No upgrade win-rate estimate is available.";
pub const RUBRIC: &str = "1 Minimal: changing individual cards does little for the main plan; its limiting mechanism remains. 2 Narrow: useful replacements exist, but the same commander or theme restriction blocks most further gains. 3 Workable: a documented upgrade package improves the plan, with a persistent setup, combat or card-pool limit. 4 Broad: several compatible packages improve the plan and its finish; important restrictions still apply. 5 Exceptional: the commander supplies repeatable resources and a direct finish; on-theme additions strengthen both. These are ordinal judgments, not measured power steps. Evidence missing means ungraded, not 1.";
pub const COMMANDER_CAVEAT: &str = "Playgroup commander results include stock and modified lists, mixed pod sizes and opponents. The raw rate is wins divided by games, not four-player normalised. Partner commanders are separate observations, not a pair's rate. Do not subtract a stock-precon rate to estimate upgrade gain.";

#[derive(Debug, Clone, Serialize)]
pub struct GradeLevel {
    pub score: u8,
    pub label: &'static str,
    pub meaning: &'static str,
}
pub fn levels() -> Vec<GradeLevel> {
    vec![
        GradeLevel {
            score: 1,
            label: "Minimal",
            meaning: "Individual replacements do little for the main plan; its limiting mechanism remains.",
        },
        GradeLevel {
            score: 2,
            label: "Narrow",
            meaning: "Useful replacements exist, but a commander or theme restriction blocks most further gains.",
        },
        GradeLevel {
            score: 3,
            label: "Workable",
            meaning: "A documented package improves the plan, with a persistent setup, combat or card-pool limit.",
        },
        GradeLevel {
            score: 4,
            label: "Broad",
            meaning: "Several compatible packages improve the plan and its finish; important restrictions still apply.",
        },
        GradeLevel {
            score: 5,
            label: "Exceptional",
            meaning: "The commander supplies repeatable resources and a direct finish; on-theme additions strengthen both.",
        },
    ]
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rationale {
    pub support: String,
    pub payoff: String,
    pub constraints: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub title: String,
    pub author: String,
    pub publisher: String,
    pub published_on: Option<String>,
    pub checked_on: String,
    pub accessed_on: String,
    pub url: String,
    pub summary: String,
    pub kind: String,
    pub rating: Option<String>,
    pub commander_configurations: Vec<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Example {
    pub name: String,
    pub role: String,
    pub url: String,
    pub oracle_id: String,
    pub color_identity: Vec<String>,
    pub legal_checked_on: String,
    pub basis: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommanderCard {
    pub name: String,
    pub url: String,
    pub checked_on: String,
    pub oracle_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommanderResult {
    pub name: String,
    pub commander_id: u64,
    pub url: String,
    pub api_url: String,
    pub fetched_at: String,
    pub provider_updated_at: Option<String>,
    pub games: u64,
    pub wins: u64,
    pub raw_win_rate_percent: Option<f64>,
    pub population: String,
    pub sha256: String,
}
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
    pub levels: Vec<GradeLevel>,
    pub rationale: Option<Rationale>,
    pub examples: Vec<Example>,
    pub sources: Vec<Source>,
    pub commander_cards: Vec<CommanderCard>,
    pub commander_results: Vec<CommanderResult>,
    pub commander_caveat: &'static str,
    pub attribution: &'static str,
    pub gap: Option<String>,
}
#[derive(Deserialize)]
struct Document {
    method: String,
    assessed_on: String,
    sources: BTreeMap<String, Source>,
    decks: BTreeMap<String, Entry>,
}
#[derive(Deserialize)]
struct Entry {
    score: Option<u8>,
    effort: Option<String>,
    path: Option<String>,
    limitation: Option<String>,
    rationale: Option<Rationale>,
    examples: Vec<Example>,
    sources: Vec<String>,
    gap: Option<String>,
    commander_cards: Vec<CommanderCard>,
    commanders: Vec<String>,
    source_url: String,
    stock: Vec<(String, String, u32)>,
}
#[derive(Deserialize)]
struct CommanderDocument {
    commanders: BTreeMap<String, CommanderResult>,
}
static DATA: LazyLock<Document> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/precon-upgradeability.json"))
        .expect("validated upgradeability document")
});
static COMMANDERS: LazyLock<CommanderDocument> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/commander-evidence.json"))
        .expect("validated commander observations")
});

fn key<'a>(rows: impl Iterator<Item = (&'a str, &'a str, u32)>) -> BTreeMap<(String, String), u32> {
    let mut out = BTreeMap::new();
    for (board, name, qty) in rows {
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
fn supported_grade(entry: &Entry, sources: &[Source]) -> Option<u8> {
    let grade = entry.score?;
    let reason = entry.rationale.as_ref()?;
    // Absence is an evidence gap, never a low grade. A stock snapshot alone cannot justify a grade.
    ((1..=5).contains(&grade)
        && sources.iter().any(|s| {
            (s.kind == "upgrade_guide" || s.kind == "review_and_upgrade_guide")
                && s.commander_configurations
                    .iter()
                    .any(|c| c == &entry.commanders)
        })
        && entry.examples.len() >= 2
        && [&reason.support, &reason.payoff, &reason.constraints]
            .iter()
            .all(|s| !s.trim().is_empty())
        && entry.path.as_ref().is_some_and(|s| !s.trim().is_empty())
        && entry
            .limitation
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty()))
    .then_some(grade)
}
pub fn assess(id: &str, cards: &[PreconCard]) -> Assessment {
    let mut result = Assessment {
        score: None,
        label: "Ungraded",
        status: "not_assessed",
        effort: None,
        path: None,
        limitation: None,
        assessed_on: None,
        source_url: None,
        method: METHOD,
        basis: BASIS,
        rubric: RUBRIC,
        levels: levels(),
        rationale: None,
        examples: vec![],
        sources: vec![],
        commander_cards: vec![],
        commander_results: vec![],
        commander_caveat: COMMANDER_CAVEAT,
        attribution: "Playgroup.gg / Arcane Digital B.V., aggregate statistics licensed CC BY 4.0 (https://playgroup.gg/legal).",
        gap: Some("No source-backed upgrade assessment is recorded for this list.".into()),
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
        result.gap = Some("The catalog list or commander changed after this assessment.".into());
        return result;
    }
    result.sources = entry
        .sources
        .iter()
        .filter_map(|id| DATA.sources.get(id).cloned())
        .collect();
    result.commander_cards = entry.commander_cards.clone();
    result.commander_results = entry
        .commanders
        .iter()
        .filter_map(|n| COMMANDERS.commanders.get(n).cloned())
        .collect();
    result.gap = entry.gap.clone();
    result.score = supported_grade(entry, &result.sources);
    if let Some(score) = result.score {
        result.label = match score {
            1 => "Minimal",
            2 => "Narrow",
            3 => "Workable",
            4 => "Broad",
            5 => "Exceptional",
            _ => "Ungraded",
        };
        result.status = "reviewed";
        result.effort = entry.effort.clone();
        result.path = entry.path.clone();
        result.limitation = entry.limitation.clone();
        result.rationale = entry.rationale.clone();
        result.examples = entry.examples.clone();
    } else {
        result.status = "insufficient_evidence";
        result.gap.get_or_insert_with(|| {
            "The recorded evidence does not meet the grading requirements.".into()
        });
    }
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
                board: if b == "commander" {
                    Board::Commander
                } else {
                    Board::Main
                },
            })
            .collect()
    }
    #[test]
    fn audited_catalog_requires_evidence_and_does_not_carry_old_grades() {
        assert_eq!(DATA.method, METHOD);
        assert_eq!(DATA.decks.len(), 174);
        let mut graded = 0;
        for (id, e) in &DATA.decks {
            let cards = stock(id);
            assert_eq!(cards.iter().map(|c| c.qty).sum::<u32>(), 100, "{id}");
            let a = assess(id, &cards);
            assert_eq!(a.score, e.score, "{id}");
            assert_eq!(a.commander_results.len(), e.commanders.len(), "{id}");
            for s in &e.sources {
                assert!(DATA.sources.contains_key(s), "{id} {s}");
            }
            if e.score.is_some() {
                graded += 1;
                assert!(e.gap.is_none());
                for c in &e.examples {
                    assert_eq!(c.legal_checked_on, "2026-10-27");
                    assert!(c.url.starts_with("https://scryfall.com/card/"));
                    assert!(
                        !e.stock.iter().any(|(_, n, _)| n
                            .eq_ignore_ascii_case(c.name.split(" // ").next().unwrap())),
                        "{id} {} already stock",
                        c.name
                    );
                }
                assert_eq!(
                    supported_grade(e, &[]),
                    None,
                    "a stock list cannot justify a grade"
                );
            } else {
                assert!(e.gap.is_some());
                assert_eq!(a.status, "insufficient_evidence");
            }
        }
        assert_eq!(graded, 13);
        assert_eq!(
            assess("counter-intelligence", &stock("counter-intelligence")).score,
            None,
            "Kilo's guide cannot grade Inspirit"
        );
        assert_eq!(
            assess("the-fantastic-four", &stock("the-fantastic-four")).score,
            None,
            "Mister Fantastic's guide cannot grade Invisible Woman"
        );
    }
    #[test]
    fn guide_for_another_commander_cannot_support_a_grade() {
        let e = &DATA.decks["quantum-quandrix"];
        let mut sources: Vec<_> = e
            .sources
            .iter()
            .map(|id| DATA.sources[id].clone())
            .collect();
        for s in &mut sources {
            s.commander_configurations = vec![vec!["Esix, Fractal Bloom".into()]];
        }
        assert_eq!(supported_grade(e, &sources), None);
    }
    #[test]
    fn observations_are_raw_same_endpoint_counts_not_an_upgrade_delta() {
        for c in COMMANDERS.commanders.values() {
            assert!(c.wins <= c.games);
            assert!(c.provider_updated_at.is_none());
            if c.games == 0 {
                assert!(c.raw_win_rate_percent.is_none());
            } else {
                assert!(
                    (c.raw_win_rate_percent.unwrap() - 100. * c.wins as f64 / c.games as f64).abs()
                        < 0.006
                );
            }
        }
    }
    #[test]
    fn changed_lists_and_unknown_imports_never_inherit_evidence() {
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
        assert!(a.commander_results.is_empty());
        assert_eq!(assess("future-precon", &cards).score, None);
        cards = stock(id);
        cards[0].qty += 1;
        assert_eq!(assess(id, &cards).score, None);
    }
    #[test]
    fn printing_order_and_split_quantity_do_not_change_the_stock_identity() {
        let id = "quantum-quandrix";
        let mut cards = stock(id);
        cards.reverse();
        for c in &mut cards {
            c.oracle_id = Some("new-printing".into());
            if c.name == "Incubation" {
                c.name = "Incubation // Incongruity".into();
            }
        }
        assert_eq!(assess(id, &cards).score, Some(4));
        let i = cards.iter().position(|c| c.qty > 1).unwrap();
        let mut split = cards[i].clone();
        split.qty = 1;
        cards[i].qty -= 1;
        cards.push(split);
        assert_eq!(assess(id, &cards).score, Some(4));
    }
    #[tokio::test]
    async fn an_unknown_catalog_import_does_not_claim_a_completed_audit_or_source() {
        let pool = crate::db::test_pool().await;
        let cards = stock("quantum-quandrix");
        sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,notes) VALUES ('future-precon','precons/future-precon','Future precon','NEW',?,'GU',?,'MTGJSON','hash','2026-10-28','[]')")
            .bind(serde_json::to_string(&vec!["Adrix and Nev, Twincasters"]).unwrap())
            .bind(serde_json::to_string(&cards).unwrap()).execute(&pool).await.unwrap();
        let assessment = crate::lab::precon_detail(&pool, "future-precon")
            .await
            .unwrap()
            .precon
            .upgradeability;
        assert_eq!(assessment.status, "not_assessed");
        assert!(assessment.assessed_on.is_none());
        assert!(assessment.source_url.is_none());
        use tower::ServiceExt;
        let state = crate::testutil::state_with(crate::testutil::config(), pool).await;
        let response = crate::routes::app(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/precons/future-precon")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(html.contains("No source-backed upgrade assessment is recorded for this list."));
        assert!(!html.contains("Audited "));
        assert!(!html.contains(">Catalog list</a>"));
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
                        .uri(&path)
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
            assert!(html.contains("5/5 Exceptional"));
            assert!(html.contains("Substantial"));
            if path.starts_with("/precons/scions-") {
                assert!(html.contains("Audited 2026-10-27."));
                assert!(html.contains(">Catalog list</a>"));
                assert!(html.contains("Commander results"));
                assert!(html.contains("raw wins"));
                assert!(html.contains("Publisher") || html.contains("Tomer Abramovici"));
            }
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
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/precons/{id}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(html.contains("Prior audit 2026-10-27."));
        assert!(!html.contains("Audited 2026-10-27."));
    }
}
