//! Source-backed editorial grades and separately scoped commander observations.
use crate::{decks::Board, lab::PreconCard};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock};

pub const METHOD: &str = "source-backed-upgradeability-v4";
pub const BASIS: &str = "Yama's editorial judgment of improvement options for the stated commander configuration while retaining the precon’s main theme. Based on the cited guides, checked card examples and commander restrictions. No upgrade win-rate estimate is available.";
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PathScope {
    Catalog,
    InBox,
    OnThemeSwap,
    SeparateBuild,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Continuity {
    pub theme: String,
    pub retains: String,
    pub changes: String,
}
#[derive(Clone, Deserialize)]
struct AlternativeEntry {
    key: String,
    scope: PathScope,
    continuity: Option<Continuity>,
    list_checked_on: String,
    validated_fingerprint: String,
    #[serde(flatten)]
    entry: Entry,
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
    pub variant_key: String,
    pub commanders: Vec<String>,
    pub scope: PathScope,
    pub continuity: Option<Continuity>,
    pub retained_cards: Option<u32>,
    pub list_checked_on: Option<String>,
    pub list_url: Option<String>,
    pub list_fingerprint: Option<String>,
    pub simulation_note: &'static str,
    pub alternatives: Vec<Assessment>,
    pub package: Option<PackageAssessment>,
}
#[derive(Debug, Clone, Serialize)]
pub struct PackageAssessment {
    pub checked_on: String,
    pub roster_complete: bool,
    pub configurations: usize,
    pub validated_configurations: usize,
    pub graded_configurations: usize,
    pub best_supported_score: Option<u8>,
    pub best_supported_label: &'static str,
    pub best_supported_commanders: Vec<Vec<String>>,
    pub featured_commanders: Vec<Vec<String>>,
    pub other_legends: Vec<String>,
    pub note: &'static str,
}
#[derive(Deserialize)]
struct RosterDocument {
    decks: BTreeMap<String, Roster>,
}
#[derive(Deserialize)]
struct Roster {
    reference_fingerprint: String,
    checked_on: String,
    complete: bool,
    options: Vec<RosterOption>,
    other_legends: Vec<String>,
}
#[derive(Deserialize)]
struct RosterOption {
    key: String,
    commanders: Vec<String>,
    fingerprint: Option<String>,
    list_problem: Option<String>,
    commander_cards: Vec<CommanderCard>,
    #[serde(default)]
    featured: bool,
}
static ROSTER: LazyLock<RosterDocument> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/precon-commander-roster.json"))
        .expect("validated package inventory")
});
#[derive(Deserialize)]
struct Document {
    method: String,
    assessed_on: String,
    sources: BTreeMap<String, Source>,
    decks: BTreeMap<String, Entry>,
}
#[derive(Clone, Deserialize)]
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
    #[serde(default)]
    alternatives: Vec<AlternativeEntry>,
    catalog_list_checked_on: Option<String>,
    catalog_validated_fingerprint: Option<String>,
    reviewed_on: Option<String>,
    #[serde(default)]
    inventory_only: bool,
}
#[derive(Deserialize)]
struct CommanderDocument {
    commanders: BTreeMap<String, CommanderResult>,
}
static DATA: LazyLock<Document> = LazyLock::new(|| {
    let mut doc: Document =
        serde_json::from_str(include_str!("../resources/precon-upgradeability.json"))
            .expect("validated upgradeability document");
    for (id, base) in &mut doc.decks {
        let Some(roster) = ROSTER
            .decks
            .get(id)
            .filter(|r| r.reference_fingerprint == fingerprint(base))
        else {
            continue;
        };
        for option in &roster.options {
            if commander_key(&option.commanders) == commander_key(&base.commanders) {
                base.catalog_validated_fingerprint = option.fingerprint.clone();
                base.catalog_list_checked_on = option
                    .fingerprint
                    .as_ref()
                    .map(|_| roster.checked_on.clone());
                continue;
            }
            if base.alternatives.iter().any(|a| {
                commander_key(&a.entry.commanders) == commander_key(&option.commanders)
                    && a.scope == PathScope::InBox
            }) {
                continue;
            }
            let mut entry = base.clone();
            entry.alternatives.clear();
            entry.commanders = option.commanders.clone();
            entry.commander_cards = option.commander_cards.clone();
            entry.stock = base
                .stock
                .iter()
                .map(|(_, n, q)| {
                    (
                        if option.commanders.contains(n) {
                            "commander"
                        } else {
                            "main"
                        }
                        .into(),
                        n.clone(),
                        *q,
                    )
                })
                .collect();
            entry.score = None;
            entry.effort = None;
            entry.path = None;
            entry.limitation = None;
            entry.rationale = None;
            entry.examples.clear();
            entry.sources.clear();
            entry.inventory_only = true;
            entry.reviewed_on = None;
            entry.gap = Some("Included commander option: leadership and colour compatibility checked. Theme fit and upgrade potential have not been assessed; no grade or simulation result is assigned.".into());
            if let Some(problem) = &option.list_problem {
                entry.gap = Some(format!(
                    "This configuration is not ready for simulation: {problem}. No validated simulation download is available."
                ));
            }
            base.alternatives.push(AlternativeEntry {
                key: option.key.clone(),
                scope: PathScope::InBox,
                continuity: None,
                list_checked_on: roster.checked_on.clone(),
                validated_fingerprint: option.fingerprint.clone().unwrap_or_default(),
                entry,
            });
        }
    }
    doc
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
fn commander_key(names: &[String]) -> std::collections::BTreeSet<String> {
    names
        .iter()
        .map(|n| n.split(" // ").next().unwrap_or(n).to_lowercase())
        .collect()
}
fn fingerprint(entry: &Entry) -> String {
    let normalized: Vec<_> = key(entry
        .stock
        .iter()
        .map(|(b, n, q)| (b.as_str(), n.as_str(), *q)))
    .into_iter()
    .collect();
    crate::util::sha256_hex(&serde_json::to_string(&normalized).expect("list identity serializes"))
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
fn empty(cards: &[PreconCard]) -> Assessment {
    Assessment {
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
        variant_key: "catalog".into(),
        commanders: cards
            .iter()
            .filter(|c| c.board == Board::Commander)
            .map(|c| c.name.clone())
            .collect(),
        scope: PathScope::Catalog,
        continuity: None,
        retained_cards: None,
        list_checked_on: None,
        list_url: None,
        list_fingerprint: None,
        simulation_note: "No matched simulation results are attached to this commander option.",
        alternatives: vec![],
        package: None,
    }
}
fn entry_cards(entry: &Entry) -> Vec<PreconCard> {
    entry
        .stock
        .iter()
        .map(|(b, n, q)| PreconCard {
            name: n.clone(),
            qty: *q,
            oracle_id: None,
            board: match b.as_str() {
                "commander" => Board::Commander,
                "main" => Board::Main,
                _ => Board::Side,
            },
        })
        .collect()
}
fn matches(entry: &Entry, cards: &[PreconCard]) -> bool {
    key(cards
        .iter()
        .map(|c| (board(&c.board), c.name.as_str(), c.qty)))
        == key(entry
            .stock
            .iter()
            .map(|(b, n, q)| (b.as_str(), n.as_str(), *q)))
}
fn evaluate(entry: &Entry) -> Assessment {
    let mut a = empty(&entry_cards(entry));
    a.assessed_on = (!entry.inventory_only).then(|| {
        entry
            .reviewed_on
            .clone()
            .unwrap_or_else(|| DATA.assessed_on.clone())
    });
    a.source_url = Some(entry.source_url.clone());
    a.sources = entry
        .sources
        .iter()
        .filter_map(|id| DATA.sources.get(id).cloned())
        .collect();
    a.commander_cards = entry.commander_cards.clone();
    a.commander_results = entry
        .commanders
        .iter()
        .filter_map(|n| COMMANDERS.commanders.get(n).cloned())
        .collect();
    a.gap = entry.gap.clone();
    a.score = supported_grade(entry, &a.sources);
    if let Some(score) = a.score {
        a.label = match score {
            1 => "Minimal",
            2 => "Narrow",
            3 => "Workable",
            4 => "Broad",
            5 => "Exceptional",
            _ => "Ungraded",
        };
        a.status = "reviewed";
        a.effort = entry.effort.clone();
        a.path = entry.path.clone();
        a.limitation = entry.limitation.clone();
        a.rationale = entry.rationale.clone();
        a.examples = entry.examples.clone();
    } else {
        a.status = "insufficient_evidence";
        a.gap.get_or_insert_with(|| {
            "The recorded evidence does not meet the grading requirements.".into()
        });
    }
    a
}
fn alternate(id: &str, base: &Entry, v: &AlternativeEntry) -> Assessment {
    let mut a = evaluate(&v.entry);
    a.variant_key = v.key.clone();
    a.scope = v.scope.clone();
    a.continuity = v.continuity.clone();
    let totals = |entry: &Entry| {
        let mut m = BTreeMap::new();
        for (_, n, q) in &entry.stock {
            *m.entry(n.to_lowercase()).or_insert(0u32) += q;
        }
        m
    };
    let original = totals(base);
    let variant = totals(&v.entry);
    a.retained_cards = Some(
        variant
            .iter()
            .map(|(n, q)| (*q).min(*original.get(n).unwrap_or(&0)))
            .sum(),
    );
    let normalized: Vec<_> = key(v
        .entry
        .stock
        .iter()
        .map(|(b, n, q)| (b.as_str(), n.as_str(), *q)))
    .into_iter()
    .collect();
    let fingerprint = crate::util::sha256_hex(
        &serde_json::to_string(&normalized).expect("list identity serializes"),
    );
    let stock_commanders: Vec<_> = v
        .entry
        .stock
        .iter()
        .filter(|(b, _, _)| b == "commander")
        .map(|(_, n, _)| n.clone())
        .collect();
    let valid_list = !v.list_checked_on.trim().is_empty()
        && fingerprint == v.validated_fingerprint
        && v.entry.stock.iter().map(|(_, _, q)| q).sum::<u32>() == 100
        && v.entry.stock.iter().all(|(_, _, q)| *q > 0)
        && stock_commanders == v.entry.commanders
        && (v.scope != PathScope::InBox || original == variant);
    let coherent = v.continuity.as_ref().is_some_and(|c| {
        [&c.theme, &c.retains, &c.changes]
            .iter()
            .all(|s| !s.trim().is_empty())
    });
    if v.scope == PathScope::SeparateBuild
        || v.scope == PathScope::Catalog
        || (v.scope == PathScope::OnThemeSwap && !coherent)
    {
        a.score = None;
        a.label = "Separate build";
        a.status = "separate_build";
        a.rationale = None;
        a.effort = None;
        a.path = None;
        a.limitation = None;
        a.examples.clear();
        a.gap=Some("A replacement strategy is a separate deck build, outside this precon's upgradeability grade.".into());
    } else if !valid_list {
        a.score = None;
        a.label = "Needs list validation";
        a.status = "list_needs_validation";
        a.rationale = None;
        a.effort = None;
        a.path = None;
        a.limitation = None;
        a.examples.clear();
        a.gap = if v.entry.inventory_only {
            v.entry.gap.clone()
        } else {
            Some("This commander option's list changed or has not passed validation.".into())
        };
    } else {
        a.list_checked_on = Some(v.list_checked_on.clone());
        a.list_url = Some(format!("/precons/{id}/commanders/{}/decklist.txt", v.key));
        a.list_fingerprint = Some(fingerprint);
    }
    if v.scope == PathScope::InBox && !coherent {
        a.score = None;
        if a.status != "list_needs_validation" {
            a.label = "Ungraded";
        }
        a.rationale = None;
        a.effort = None;
        a.path = None;
        a.limitation = None;
        a.examples.clear();
    }
    a
}
fn reference(id: &str, base: &Entry) -> Assessment {
    let mut a = evaluate(base);
    a.simulation_note = "Any stock results elsewhere on this page belong to the reference catalog snapshot, not to alternative commander lists.";
    let normalized: Vec<_> = key(base
        .stock
        .iter()
        .map(|(b, n, q)| (b.as_str(), n.as_str(), *q)))
    .into_iter()
    .collect();
    let hash = crate::util::sha256_hex(
        &serde_json::to_string(&normalized).expect("list identity serializes"),
    );
    if base.catalog_validated_fingerprint.as_deref() == Some(&hash)
        && base.catalog_list_checked_on.is_some()
    {
        a.list_checked_on = base.catalog_list_checked_on.clone();
        a.list_fingerprint = Some(hash);
        a.list_url = Some(format!("/precons/{id}/commanders/catalog/decklist.txt"));
        a.retained_cards = Some(100);
    }
    a
}

/// ID-only stock results may be attached only to the frozen reference in known families.
/// Unknown imports retain their existing source/publication checks; they gain no audit identity.
pub fn allows_reference_results(id: &str, cards: &[PreconCard]) -> bool {
    DATA.decks.get(id).is_none_or(|base| matches(base, cards))
}

pub fn assess(id: &str, cards: &[PreconCard]) -> Assessment {
    debug_assert_eq!(DATA.method, METHOD);
    let Some(base) = DATA.decks.get(id) else {
        return empty(cards);
    };
    let mut options = vec![reference(id, base)];
    options.extend(base.alternatives.iter().map(|v| alternate(id, base, v)));
    let selected = if matches(base, cards) {
        Some(0)
    } else {
        base.alternatives
            .iter()
            .position(|v| matches(&v.entry, cards))
            .map(|i| i + 1)
    };
    let Some(i) = selected else {
        let mut a = empty(cards);
        a.status = "stock_list_changed";
        a.label = "Needs reassessment";
        a.assessed_on = Some(DATA.assessed_on.clone());
        a.source_url = Some(base.source_url.clone());
        a.gap = Some("The catalog list or commander changed after this assessment.".into());
        return a;
    };
    let mut a = options.remove(i);
    if let Some(roster) = ROSTER
        .decks
        .get(id)
        .filter(|r| r.reference_fingerprint == fingerprint(base))
    {
        let included: Vec<_> = std::iter::once(&a)
            .chain(options.iter())
            .filter(|v| v.scope == PathScope::Catalog || v.scope == PathScope::InBox)
            .collect();
        let best = included.iter().filter_map(|v| v.score).max();
        a.package = Some(PackageAssessment {
            checked_on: roster.checked_on.clone(),
            roster_complete: roster.complete,
            configurations: roster.options.len(),
            validated_configurations: roster
                .options
                .iter()
                .filter(|o| o.fingerprint.is_some())
                .count(),
            graded_configurations: included.iter().filter(|v| v.score.is_some()).count(),
            best_supported_score: best,
            best_supported_label: best
                .map(|s| levels()[usize::from(s) - 1].label)
                .unwrap_or("Ungraded"),
            best_supported_commanders: included
                .iter()
                .filter(|v| v.score.is_some() && v.score == best)
                .map(|v| v.commanders.clone())
                .collect(),
            featured_commanders: roster
                .options
                .iter()
                .filter(|o| o.featured)
                .map(|o| o.commanders.clone())
                .collect(),
            other_legends: roster.other_legends.clone(),
            note: "This package includes every inventoried stock-compatible commander configuration. Highest supported upgrade grade describes the named assessed options, not overall deck power or a proven best commander. Unassessed options may be stronger. Outside commander swaps are excluded from the package summary.",
        });
    }
    a.alternatives = options;
    a
}
/// Returns only frozen, explicitly reviewed public stock-family inputs. Never reads private decks.
pub fn variant_deck(id: &str, variant: &str, current: &[PreconCard]) -> Option<String> {
    let base = DATA.decks.get(id)?;
    if !matches(base, current) && !base.alternatives.iter().any(|v| matches(&v.entry, current)) {
        return None;
    }
    let entry = if variant == "catalog" {
        reference(id, base).list_url.as_ref()?;
        base
    } else {
        let v = base
            .alternatives
            .iter()
            .find(|v| v.key == variant && v.scope != PathScope::SeparateBuild)?;
        alternate(id, base, v).list_url.as_ref()?;
        &v.entry
    };
    let mut text = String::new();
    for (b, label) in [
        ("commander", "Commander"),
        ("main", "Deck"),
        ("side", "Sideboard"),
    ] {
        let rows: Vec<_> = entry
            .stock
            .iter()
            .filter(|(board, _, _)| board == b)
            .collect();
        if rows.is_empty() {
            continue;
        }
        text.push_str(label);
        text.push('\n');
        for (_, name, qty) in rows {
            text.push_str(&format!("{qty} {name}\n"));
        }
        text.push('\n');
    }
    Some(text)
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
                    assert!(matches!(
                        c.legal_checked_on.as_str(),
                        "2026-10-27" | "2026-10-28"
                    ));
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
        assert_eq!(graded, 14);
        assert_eq!(
            assess("counter-intelligence", &stock("counter-intelligence")).score,
            None,
            "Kilo's guide cannot grade Inspirit"
        );
        assert_eq!(
            assess("the-fantastic-four", &stock("the-fantastic-four")).score,
            Some(3),
            "Invisible Woman now has her own covering guide and assessment"
        );
    }
    #[test]
    fn package_inventory_covers_all_leaders_and_does_not_hide_partial_grading() {
        assert_eq!(ROSTER.decks.len(), 174);
        assert_eq!(
            ROSTER
                .decks
                .values()
                .map(|r| r.options.len())
                .sum::<usize>(),
            619
        );
        let a = assess("the-fantastic-four", &stock("the-fantastic-four"));
        let p = a.package.as_ref().unwrap();
        assert_eq!((p.configurations, p.graded_configurations), (6, 4));
        assert_eq!(p.best_supported_score, Some(4));
        assert_eq!(p.featured_commanders.len(), 4);
        assert!(
            p.best_supported_commanders
                .contains(&vec!["Mister Fantastic".into()])
        );
        assert!(
            p.best_supported_commanders
                .contains(&vec!["Human Torch".into()])
        );
        for n in [
            "Mister Fantastic",
            "Human Torch",
            "The Thing",
            "Crystal, Inhuman Princess",
            "Power Pack",
        ] {
            assert!(
                a.alternatives.iter().any(|a| a.commanders == vec![n]),
                "{n}"
            );
        }
        for id in DATA.decks.keys() {
            let a = assess(id, &stock(id));
            assert!(a.package.as_ref().unwrap().roster_complete);
            assert_eq!(
                1 + a
                    .alternatives
                    .iter()
                    .filter(|a| a.scope == PathScope::InBox)
                    .count(),
                ROSTER.decks[id].options.len(),
                "{id}"
            );
        }
        let q = assess("quantum-quandrix", &stock("quantum-quandrix"));
        assert_eq!(q.package.as_ref().unwrap().configurations, 4);
        assert_eq!(
            q.alternatives.len(),
            4,
            "Koma is separate from the four in-box options"
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
    #[test]
    fn commander_options_have_separate_grades_lists_and_observations() {
        let id = "counter-intelligence";
        let base = &DATA.decks[id];
        let a = assess(id, &stock(id));
        assert_eq!(a.score, None);
        assert_eq!(a.commanders, vec!["Inspirit, Flagship Vessel"]);
        let kilo = &a.alternatives[0];
        assert_eq!(kilo.score, Some(4));
        assert_eq!(kilo.commanders, vec!["Kilo, Apogee Mind"]);
        assert_eq!(kilo.retained_cards, Some(100));
        assert!(kilo.list_url.is_some());
        assert_eq!(kilo.commander_results[0].name, "Kilo, Apogee Mind");
        assert_ne!(a.list_fingerprint, kilo.list_fingerprint);
        let selected = assess(id, &entry_cards(&base.alternatives[0].entry));
        assert_eq!(selected.score, Some(4));
        assert_eq!(selected.variant_key, "kilo-apogee-mind");
        assert_eq!(selected.alternatives[0].score, None);
        assert_eq!(
            selected.alternatives[0].commanders,
            vec!["Inspirit, Flagship Vessel"]
        );
        let lab = |e: &Entry| {
            crate::lab::experiments::normalize(
                entry_cards(e)
                    .into_iter()
                    .map(|c| crate::lab::experiments::LabCard {
                        name: c.name,
                        oracle_id: None,
                        qty: c.qty,
                        commander: c.board == Board::Commander,
                    })
                    .collect(),
            )
        };
        assert_ne!(
            crate::lab::experiments::list_text(&lab(base)),
            crate::lab::experiments::list_text(&lab(&base.alternatives[0].entry)),
            "same card pool with different command zones must remain distinct simulation inputs"
        );
    }
    #[test]
    fn replacement_strategies_and_changed_unvalidated_lists_never_inherit_grades() {
        let id = "counter-intelligence";
        let base = &DATA.decks[id];
        let mut v = base.alternatives[0].clone();
        v.scope = PathScope::SeparateBuild;
        let a = alternate(id, base, &v);
        assert_eq!(a.score, None);
        assert!(a.list_url.is_none());
        assert_eq!(a.status, "separate_build");
        v.scope = PathScope::OnThemeSwap;
        let a = alternate(id, base, &v);
        assert_eq!(a.score, Some(4));
        assert!(a.list_url.is_some());
        v.continuity.as_mut().unwrap().retains.clear();
        assert_eq!(alternate(id, base, &v).score, None);
        v = base.alternatives[0].clone();
        v.entry.stock[1].1 = "Unreviewed replacement".into();
        let a = alternate(id, base, &v);
        assert_eq!(a.score, None);
        assert_eq!(a.status, "list_needs_validation");
        assert!(a.list_url.is_none());
    }
    #[test]
    fn all_prepared_commander_lists_have_frozen_validated_identities() {
        let mut options = 0;
        let mut graded = 0;
        for (id, e) in &DATA.decks {
            for v in &e.alternatives {
                options += 1;
                assert!(v.entry.alternatives.is_empty());
                assert!(
                    v.key
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                );
                let a = alternate(id, e, v);
                if v.validated_fingerprint.is_empty() {
                    assert!(a.list_url.is_none(), "{id}");
                    assert_eq!(a.status, "list_needs_validation");
                    continue;
                }
                assert!(a.list_url.is_some(), "{id}");
                assert!(a.list_checked_on.is_some());
                assert!(
                    a.commander_results.len() <= v.entry.commanders.len(),
                    "{id}"
                );
                if a.score.is_some() {
                    graded += 1;
                }
                let text = variant_deck(id, &v.key, &stock(id)).unwrap();
                let parsed = crate::decks::parse_list(&text, false);
                assert_eq!(parsed.iter().map(|c| c.qty).sum::<i64>(), 100);
                assert_eq!(
                    parsed
                        .iter()
                        .filter(|c| c.board == Board::Commander)
                        .map(|c| c.name.clone())
                        .collect::<Vec<_>>(),
                    v.entry.commanders
                );
            }
        }
        assert_eq!((options, graded), (446, 4));
    }
    #[tokio::test]
    async fn public_commander_downloads_keep_their_command_zone_and_refuse_changed_catalogs() {
        let pool = crate::db::test_pool().await;
        let id = "counter-intelligence";
        sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,notes) VALUES (?,?,'Counter Intelligence','EOC',?,'WUR',?,'MTGJSON','hash','2026-10-27','[]')")
            .bind(id).bind(format!("precons/{id}")).bind(serde_json::to_string(&DATA.decks[id].commanders).unwrap()).bind(serde_json::to_string(&stock(id)).unwrap()).execute(&pool).await.unwrap();
        use tower::ServiceExt;
        let app = crate::routes::app(
            crate::testutil::state_with(crate::testutil::config(), pool.clone()).await,
        );
        let path = format!("/precons/{id}/commanders/kilo-apogee-mind/decklist.txt");
        let get = |path: String| {
            axum::http::Request::builder()
                .uri(path)
                .body(axum::body::Body::empty())
                .unwrap()
        };
        let response = app.clone().oneshot(get(path.clone())).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.starts_with("Commander\n1 Kilo, Apogee Mind\n"));
        assert!(text.contains("\n1 Inspirit, Flagship Vessel\n"));
        let reference = app
            .clone()
            .oneshot(get(format!(
                "/precons/{id}/commanders/catalog/decklist.txt"
            )))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(reference.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .starts_with("Commander\n1 Inspirit, Flagship Vessel\n")
        );
        let mut changed = stock(id);
        changed[1].name = "Changed card".into();
        sqlx::query("UPDATE precons SET cards=? WHERE id=?")
            .bind(serde_json::to_string(&changed).unwrap())
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(get(path)).await.unwrap().status(),
            axum::http::StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn public_search_finds_alternative_commanders_and_preserves_other_filters() {
        let pool = crate::db::test_pool().await;
        let id = "counter-intelligence";
        sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,notes) VALUES (?,?,'Counter Intelligence','EOC',?,'WU',?,'MTGJSON','hash','2026-10-27','[]')")
            .bind(id).bind(format!("precons/{id}"))
            .bind(serde_json::to_string(&DATA.decks[id].commanders).unwrap())
            .bind(serde_json::to_string(&stock(id)).unwrap()).execute(&pool).await.unwrap();
        use tower::ServiceExt;
        let app =
            crate::routes::app(crate::testutil::state_with(crate::testutil::config(), pool).await);
        for (query, count) in [
            ("Kilo%2C%20Apogee%20Mind", 1),
            ("KILO", 1),
            ("Inspirit", 1),
            ("unrelated", 0),
            ("kilo&c=G", 0),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(format!("/api/public/precons?q={query}"))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["precons"].as_array().unwrap().len(), count, "{query}");
        }
    }

    #[tokio::test]
    async fn selected_alternatives_never_inherit_reference_results_or_matchups() {
        use serde_json::json;
        let pool = crate::db::test_pool().await;
        let id = "counter-intelligence";
        let other = "quantum-quandrix";
        let summary = json!({"matrix": {"ids": [format!("precons/{id}"), format!("precons/{other}")], "p": [[0.5, 0.7], [0.3, 0.5]]}});
        sqlx::query("INSERT INTO lab_runs(id,name,kind,games,created_at,imported_at,summary,summary_sha256) VALUES ('reference','reference','precon-ratings',20,'2026-10-27','2026-10-27',?,'hash')")
            .bind(summary.to_string()).execute(&pool).await.unwrap();
        for slug in [id, other] {
            sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,cards,source,content_sha256,imported_at,notes,playgroup) VALUES (?,?,?,'TEST',?,?,'MTGJSON','hash','2026-10-27','[]',?)")
                .bind(slug).bind(format!("precons/{slug}")).bind(slug)
                .bind(json!(DATA.decks[slug].commanders).to_string())
                .bind(json!(stock(slug)).to_string())
                .bind(json!({"win_rate_4p":25.0,"games":20}).to_string())
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO lab_ratings(run_id,deck_ref,games,strength) VALUES ('reference',?,20,1.0)")
                .bind(format!("precons/{slug}")).execute(&pool).await.unwrap();
        }
        let before = crate::lab::precon_detail(&pool, id).await.unwrap();
        assert!(before.precon.rating.is_some());
        assert!(before.precon.playgroup.is_some());
        assert_eq!(before.matchups.unwrap().rows.len(), 1);
        assert!(
            crate::public_precons::catalog(&pool)
                .await
                .unwrap()
                .precons
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .real_games
                .is_some()
        );

        let mut kilo = entry_cards(&DATA.decks[id].alternatives[0].entry);
        for input in [&kilo, &{
            let mut changed = stock(id);
            changed[1].name = "Unreviewed change".into();
            changed
        }] {
            sqlx::query("UPDATE precons SET cards=? WHERE id=?")
                .bind(json!(input).to_string())
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            let detail = crate::lab::precon_detail(&pool, id).await.unwrap();
            assert!(detail.precon.rating.is_none());
            assert!(detail.precon.playgroup.is_none());
            assert!(detail.matchups.is_none());
            let list = crate::lab::precon_list(&pool).await.unwrap();
            let item = list.precons.iter().find(|p| p.id == id).unwrap();
            assert!(item.rating.is_none());
            assert!(item.playgroup.is_none());
            let public = crate::public_precons::catalog(&pool).await.unwrap();
            assert!(
                public
                    .precons
                    .iter()
                    .find(|p| p.id == id)
                    .unwrap()
                    .real_games
                    .is_none()
            );
            assert!(
                crate::lab::precon_detail(&pool, other)
                    .await
                    .unwrap()
                    .matchups
                    .unwrap()
                    .rows
                    .is_empty()
            );
        }
        // Restoring the reference identity restores its results, even after harmless reordering.
        kilo = stock(id);
        kilo.reverse();
        sqlx::query("UPDATE precons SET cards=? WHERE id=?")
            .bind(json!(kilo).to_string())
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let restored = crate::lab::precon_detail(&pool, id).await.unwrap();
        assert!(restored.precon.rating.is_some());
        assert!(restored.precon.playgroup.is_some());
        assert!(restored.matchups.is_some());
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
            if path.starts_with("/precons/scions-") {
                assert!(html.contains("Substantial"));
                assert!(html.contains("Audited 2026-10-27."));
                assert!(html.contains(">Catalog list</a>"));
                assert!(html.contains("Commander results"));
                assert!(html.contains("raw wins"));
                assert!(html.contains("Publisher") || html.contains("Tomer Abramovici"));
                let alternatives = &public.precons[0].upgradeability.alternatives;
                assert!(!alternatives.is_empty());
                for alternative in alternatives {
                    let start = format!("<details id=\"commander-{}\">", alternative.variant_key);
                    let disclosure = html
                        .split_once(&start)
                        .unwrap()
                        .1
                        .split_once("</details>")
                        .unwrap()
                        .0;
                    assert!(disclosure.contains(&crate::public_page::e(COMMANDER_CAVEAT)));
                    assert!(disclosure.contains("Playgroup.gg / Arcane Digital B.V."));
                    assert!(disclosure.contains("CC BY 4.0"));
                    assert!(disclosure.contains("Source refresh dates are not provided"));
                }
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
