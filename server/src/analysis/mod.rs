//! Deck analysis: five vectors (Speed, Consistency, Interaction, Mana base, Threats), the
//! deck's themes and an estimate on the older 1-10 power-level scale, with every card's points.
//!
//! The shape follows the published method of ScryCheck (scrycheck.com/docs): cards earn points
//! in categories, categories add up to vectors normalized to 0-100, combos from Commander
//! Spellbook add to Threats, and a weak mana base or a strategy without compact wins caps the
//! score. Every rule, point and threshold here is Yama's own, calibrated on 2026-11-08 against
//! 174 stock precons, Bryan's Bracket 2/3/4 builds and two cEDH lists (docs/deck-analysis.md).
//! It reads card text, not how the deck plays.

pub mod classify;
pub mod history;
pub mod lands;
mod text;
pub mod themes;
#[cfg(test)]
mod tests;

use crate::cards::Card;
use crate::deck_checks::CheckResult;
use crate::decks::{Board, DeckCard};
use classify::{Cat, Points, Vector};
use serde::Serialize;
use std::collections::HashMap;

/// Bumped whenever a rule or number changes, so a stored or cached result says which it was.
pub const METHOD: &str = "2026-11-08";

/// What the analysis reads of a card.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub name: String,
    pub cmc: f64,
    pub mana_cost: String,
    pub type_line: String,
    pub oracle_text: String,
    pub power: Option<String>,
    pub color_identity: String,
    pub produced_mana: Option<String>,
}

impl Facts {
    pub fn from_card(c: &Card, produced: Option<&str>) -> Facts {
        Facts {
            name: c.name.clone(),
            cmc: c.cmc,
            mana_cost: c.mana_cost.clone().unwrap_or_default(),
            type_line: c.type_line.clone(),
            oracle_text: c.oracle_text.clone(),
            power: c.power.clone(),
            color_identity: c.color_identity.clone(),
            produced_mana: produced.map(String::from),
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CardPoints {
    pub name: String,
    pub points: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Group {
    pub key: &'static str,
    pub label: &'static str,
    pub cards: Vec<CardPoints>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct VectorScore {
    pub key: Vector,
    pub label: &'static str,
    /// 0-100: about 40 is a typical stock precon, 75 a typical Bracket 4 build, 95 cEDH.
    pub score: f64,
    pub band: &'static str,
    pub groups: Vec<Group>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ComboLine {
    pub cards: Vec<String>,
    pub results: Vec<String>,
    /// 0-1: a two-card line that ends the game is 1.
    pub weight: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Combos {
    /// Whether a Commander Spellbook check was there to read.
    pub checked: bool,
    pub lines: Vec<ComboLine>,
    /// Families of lines that share a card, each scored by its best line plus a little for
    /// each other, best four added up.
    pub score: f64,
    pub families: usize,
    /// Families whose best line is compact and ends the game or nearly (weight 0.8 or more).
    pub compact: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Cap {
    pub at: f64,
    pub reason: &'static str,
    pub note: &'static str,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DeckAnalysis {
    pub method: &'static str,
    /// 1-10, one decimal.
    pub power: f64,
    /// The score's ± range, wider with unknown cards, no combo check or many cards the text
    /// rules don't recognize.
    pub margin: f64,
    pub confidence: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// The bracket whose usual power range holds the score: 2 up to 5, 3 up to 7, 4 above.
    /// Never 1 or 5: those depend on intent and the cEDH metagame, not card text.
    pub power_bracket: i64,
    pub vectors: Vec<VectorScore>,
    /// The caps that held the score down.
    pub caps: Vec<Cap>,
    pub combos: Combos,
    pub themes: Vec<themes::Theme>,
    /// Average mana value of nonland cards, the commander left out.
    pub average_mana_value: Option<f64>,
    pub lands: i64,
    /// Nonland copies that earned no points (for the margin).
    pub unscored: i64,
    pub nonland: i64,
    /// Cards missing from Yama's card data, which can't be scored.
    pub unknown_cards: Vec<String>,
}

/// Raw points to 0-100, anchored on the reference lists (see the module docs).
const ANCHORS: [(Vector, &[(f64, f64)]); 4] = [
    (Vector::Speed, &[(0.0, 0.0), (41.0, 40.0), (61.5, 75.0), (82.0, 95.0), (110.0, 100.0)]),
    (Vector::Consistency, &[(0.0, 0.0), (39.0, 40.0), (75.0, 75.0), (107.0, 95.0), (140.0, 100.0)]),
    (Vector::Interaction, &[(0.0, 0.0), (45.5, 40.0), (73.0, 75.0), (90.5, 95.0), (115.0, 100.0)]),
    (Vector::Threats, &[(0.0, 0.0), (30.0, 35.0), (55.0, 55.0), (80.0, 78.0), (110.0, 95.0), (150.0, 100.0)]),
];
/// Each next-best card in a vector counts a little less than the one before.
const DECAY: f64 = 0.965;
const WEIGHTS: [(Vector, f64); 4] = [(Vector::Speed, 0.30), (Vector::Consistency, 0.30), (Vector::Interaction, 0.28), (Vector::Threats, 0.12)];
/// The weighted vector score (0-100) to the 1-10 scale.
const CURVE: &[(f64, f64)] = &[(0.0, 1.0), (25.0, 1.8), (42.0, 3.4), (53.0, 4.8), (60.0, 5.8), (72.0, 7.2), (86.0, 9.0), (100.0, 10.0)];

fn interp(x: f64, pts: &[(f64, f64)]) -> f64 {
    for w in pts.windows(2) {
        let ((x0, y0), (x1, y1)) = (w[0], w[1]);
        if x <= x1 {
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    pts.last().map_or(0.0, |p| p.1)
}

fn band(score: f64) -> &'static str {
    match score {
        s if s >= 85.0 => "Very strong",
        s if s >= 65.0 => "Strong",
        s if s >= 45.0 => "Average",
        s if s >= 25.0 => "Light",
        _ => "Very light",
    }
}

const SCALE: [(&str, &str); 10] = [
    ("Unfocused", "Few cards work together; mana and card quality vary a lot."),
    ("Early build", "The plan is there, but ramp, draw and interaction need work."),
    ("Precon", "About where a stock preconstructed deck plays."),
    ("Upgraded precon", "Clear upgrades over a precon, with gaps left in speed or consistency."),
    ("Focused casual", "A steady plan with chosen cards, at a moderate speed."),
    ("Tuned", "A tuned shell that finds its pieces and lines up its turns."),
    ("Optimized", "Efficient cards in most slots: quick and hard to stop."),
    ("High power", "Fast, consistent and resilient, built to win early."),
    ("Fringe cEDH", "Close to competitive play, with compact wins and heavy interaction."),
    ("cEDH", "Built for the competitive metagame."),
];

/// Weight of a combo line by what it does: ending the game counts most, infinite resources
/// next, locks and loops of value least.
fn outcome_weight(results: &[String]) -> f64 {
    let r = results.join(" ").to_lowercase();
    let has = |p: &fancy_regex::Regex| p.is_match(&r).unwrap_or(false);
    if has(text::rx!(r"win the game|infinite damage|infinite lifeloss|infinite life loss|opponents? lose|infinite combat damage|infinite combat phases|infinite turns|lose the game|infinite mill|infinite poison")) {
        1.0
    } else if has(text::rx!(r"infinite (?:colored |colorless )?mana|infinite (?:creature )?(?:tokens|etb|ltb|death|sacrifice|cast|storm|magecraft|draw|card draw|untap)")) {
        0.6
    } else if has(text::rx!(r"lock|can't|skip")) {
        0.45
    } else {
        0.3
    }
}

pub fn combos(check: Option<&CheckResult>) -> Combos {
    let Some(r) = check else {
        return Combos { checked: false, lines: vec![], score: 0.0, families: 0, compact: 0 };
    };
    let lines: Vec<ComboLine> = r
        .combos
        .iter()
        .map(|x| {
            let size = if x.definitely_two_card {
                1.0
            } else if x.arguably_two_card {
                0.8
            } else if x.cards.len() + x.templates.len() <= 3 {
                0.55
            } else {
                0.35
            };
            ComboLine { cards: x.cards.clone(), results: x.results.clone(), weight: size * outcome_weight(&x.results) }
        })
        .collect();
    // Families: lines that share a card.
    let mut parent: Vec<usize> = (0..lines.len()).collect();
    fn find(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (i, l) in lines.iter().enumerate() {
        for n in &l.cards {
            match seen.get(n.as_str()) {
                Some(&j) => {
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    parent[a] = b;
                }
                None => {
                    seen.insert(n, i);
                }
            }
        }
    }
    let mut fams: Vec<(usize, Vec<f64>)> = vec![];
    for (i, l) in lines.iter().enumerate() {
        let root = find(&mut parent, i);
        match fams.iter_mut().find(|(r, _)| *r == root) {
            Some(f) => f.1.push(l.weight),
            None => fams.push((root, vec![l.weight])),
        }
    }
    let mut scores: Vec<f64> = fams
        .into_iter()
        .map(|(_, mut ws)| {
            ws.sort_by(|a, b| b.total_cmp(a));
            (ws[0] + 0.25 * ws[1..].iter().sum::<f64>()).min(1.5 * ws[0])
        })
        .collect();
    scores.sort_by(|a, b| b.total_cmp(a));
    let families = scores.len();
    let compact = scores.iter().filter(|s| **s >= 0.8).count();
    Combos { checked: true, lines, score: scores.iter().take(4).sum(), families, compact }
}

/// Reuses card scores across the versions and configurations one request reads.
#[derive(Default)]
pub struct Cache {
    points: HashMap<(String, bool), Points>,
    lands: HashMap<(String, usize), (&'static str, f64)>,
}

/// One deck entry with its card facts (None when the card data lacks it).
pub struct Entry<'a> {
    pub card: &'a DeckCard,
    pub facts: Option<&'a Facts>,
}

pub fn analyze(entries: &[Entry], check: Option<&CheckResult>, cache: &mut Cache) -> DeckAnalysis {
    let main: Vec<&Entry> = entries.iter().filter(|e| e.card.board != Board::Side && e.card.qty > 0).collect();
    let unknown_cards: Vec<String> = main.iter().filter(|e| e.facts.is_none()).map(|e| e.card.name.clone()).collect();
    let known: Vec<(&Entry, &Facts)> = main.iter().filter_map(|e| e.facts.map(|f| (*e, f))).collect();
    let mut colors: Vec<char> = vec![];
    for (e, f) in &known {
        if e.card.board == Board::Commander {
            for ch in f.color_identity.chars() {
                if !colors.contains(&ch) {
                    colors.push(ch);
                }
            }
        }
    }
    let ncol = colors.len();

    let mut per_vector: HashMap<Vector, Vec<f64>> = HashMap::new();
    let mut cat_cards: HashMap<Cat, Vec<CardPoints>> = HashMap::new();
    let (mut nonland, mut unscored, mut mv_sum, mut mv_n) = (0, 0, 0.0, 0);
    for (e, f) in &known {
        if text::is_land(f) {
            continue;
        }
        let commander = e.card.board == Board::Commander;
        nonland += e.card.qty;
        if !commander {
            mv_sum += f.cmc * e.card.qty as f64;
            mv_n += e.card.qty;
        }
        let pts = cache.points.entry((e.card.oracle_id.clone(), commander)).or_insert_with(|| classify::card_points(f, commander)).clone();
        if pts.is_empty() {
            unscored += e.card.qty;
        }
        for (cat, p) in &pts {
            cat_cards.entry(*cat).or_default().push(CardPoints { name: f.name.clone(), points: (p * 10.0).round() / 10.0 });
        }
        for (v, _) in WEIGHTS {
            let mut ps: Vec<f64> = pts.iter().filter(|(c, _)| c.vector() == v).map(|(_, p)| *p).collect();
            if ps.is_empty() {
                continue;
            }
            ps.sort_by(|a, b| b.total_cmp(a));
            let val = ps[0] + 0.3 * ps[1..].iter().sum::<f64>();
            per_vector.entry(v).or_default().extend(std::iter::repeat_n(val, e.card.qty.max(0) as usize));
        }
    }
    let combos = combos(check);
    if combos.score > 0.0 {
        per_vector.entry(Vector::Threats).or_default().push(14.0 * combos.score.min(3.0));
    }
    let mut scores: HashMap<Vector, f64> = HashMap::new();
    for (v, anchors) in ANCHORS {
        let mut ps = per_vector.remove(&v).unwrap_or_default();
        ps.sort_by(|a, b| b.total_cmp(a));
        let raw: f64 = ps.iter().enumerate().map(|(i, p)| p * DECAY.powi(i as i32)).sum();
        scores.insert(v, interp(raw, anchors));
    }

    // Mana base: the lands' average quality, then a land count that's too low (counting rocks,
    // dorks and ramp half) takes some off.
    let mut land_groups: Vec<Group> = vec![];
    let (mut nl, mut qsum) = (0, 0.0);
    for (e, f) in &known {
        if !text::is_land(f) {
            continue;
        }
        let (label, q) = *cache.lands.entry((e.card.oracle_id.clone(), ncol)).or_insert_with(|| lands::quality(f, ncol));
        nl += e.card.qty;
        qsum += q * e.card.qty as f64;
        let entry = CardPoints { name: if e.card.qty > 1 { format!("{} {}", e.card.qty, f.name) } else { f.name.clone() }, points: (q * 100.0).round() / 10.0 };
        match land_groups.iter_mut().find(|g| g.label == label) {
            Some(g) => g.cards.push(entry),
            None => land_groups.push(Group { key: label, label, cards: vec![entry] }),
        }
    }
    let q = if nl > 0 { qsum / nl as f64 } else { 0.0 };
    let ramp_n = [Cat::FastMana, Cat::Rocks, Cat::Dorks, Cat::LandRamp].iter().map(|c| cat_cards.get(c).map_or(0, |v| v.len())).sum::<usize>();
    let sources = nl as f64 + 0.5 * ramp_n as f64;
    let cf = if sources >= 36.0 {
        if sources <= 46.0 { 1.0 } else { 0.9 }
    } else if sources >= 33.0 {
        0.95
    } else if sources >= 30.0 {
        0.85
    } else {
        0.7
    };
    let mana = 100.0 * ((q - 0.38) / 0.52).clamp(0.0, 1.0) * cf;
    scores.insert(Vector::Mana, mana);
    let average_mana_value = (mv_n > 0).then(|| mv_sum / mv_n as f64);

    // Power.
    let s = |v: Vector| scores.get(&v).copied().unwrap_or(0.0);
    let core: f64 = WEIGHTS.iter().map(|(v, w)| w * s(*v)).sum();
    let mut pl = interp(core, CURVE) + 0.5 * combos.score.min(2.5);
    if mana < 60.0 {
        pl -= 0.6 * (60.0 - mana) / 60.0;
    }
    let mut caps: Vec<Cap> = vec![];
    if mana < 25.0 {
        caps.push(Cap { at: 6.5, reason: "mana", note: "Tapped and off-color lands keep this deck at 6.5 or below." });
    } else if mana < 45.0 {
        caps.push(Cap { at: 8.0, reason: "mana", note: "The mana base keeps this deck at 8 or below." });
    }
    if average_mana_value.is_some_and(|a| a > 4.0) {
        caps.push(Cap { at: 6.0, reason: "curve", note: "An average mana value over 4 keeps this deck at 6 or below." });
    }
    let fast = cat_cards.get(&Cat::FastMana).map_or(0, |v| v.len());
    let tutors = cat_cards.get(&Cat::Tutors).map_or(0, |v| v.iter().filter(|c| c.points >= 5.0).count());
    let counters = cat_cards.get(&Cat::Counters).map_or(0, |v| v.len());
    let compact = combos.compact;
    if !(compact >= 1 && tutors >= 3 && fast >= 3) {
        caps.push(Cap { at: 8.5, reason: "strategy", note: "Above 8.5 takes a compact combo plus tutors and fast mana to find and cast it." });
    } else if !(compact >= 2 && tutors >= 5 && fast >= 5 && counters >= 4) {
        caps.push(Cap { at: 9.4, reason: "strategy", note: "The top of the scale takes several compact wins, many tutors, fast mana and counterspells." });
    }
    let cap = caps.iter().map(|c| c.at).fold(10.0, f64::min);
    let uncapped = pl;
    pl = pl.clamp(1.0, cap.min(10.0));
    let power = (pl * 10.0).round() / 10.0;
    caps.retain(|c| c.at < uncapped);

    // The ± range.
    let mut margin = 0.3 + (0.1 * unknown_cards.len() as f64).min(0.5);
    if !combos.checked {
        margin += 0.2;
    }
    let share = if nonland > 0 { unscored as f64 / nonland as f64 } else { 0.0 };
    if share > 0.35 {
        margin += (share - 0.35).min(0.3);
    }
    let margin = (margin * 10.0).round() / 10.0;
    let confidence = if margin <= 0.4 {
        "high"
    } else if margin <= 0.6 {
        "medium"
    } else {
        "low"
    };
    let (label, description) = SCALE[(power.floor() as usize).clamp(1, 10) - 1];
    let power_bracket = if power <= 5.0 {
        2
    } else if power <= 7.0 {
        3
    } else {
        4
    };

    let mut vectors = vec![];
    for v in [Vector::Speed, Vector::Consistency, Vector::Interaction, Vector::Mana, Vector::Threats] {
        let groups = if v == Vector::Mana {
            std::mem::take(&mut land_groups)
        } else {
            Cat::ALL
                .iter()
                .filter(|c| c.vector() == v)
                .filter_map(|c| {
                    let mut cards = cat_cards.remove(c)?;
                    cards.sort_by(|a, b| b.points.total_cmp(&a.points).then(a.name.cmp(&b.name)));
                    Some(Group { key: c.key(), label: c.label(), cards })
                })
                .collect()
        };
        let score = s(v).round();
        vectors.push(VectorScore { key: v, label: v.label(), score, band: band(score), groups });
    }
    let facts: Vec<(&Facts, i64)> = known.iter().map(|(e, f)| (*f, e.card.qty)).collect();
    DeckAnalysis {
        method: METHOD,
        power,
        margin,
        confidence,
        label,
        description,
        power_bracket,
        vectors,
        caps,
        combos,
        themes: themes::themes(&facts),
        average_mana_value: average_mana_value.map(|a| (a * 100.0).round() / 100.0),
        lands: nl,
        unscored,
        nonland,
        unknown_cards,
    }
}

/// The facts for a list from loaded card data and produced mana.
pub fn facts_for(cards: &[DeckCard], info: &HashMap<String, Card>, produced: &HashMap<String, Option<String>>) -> HashMap<String, Facts> {
    cards
        .iter()
        .filter_map(|c| {
            let card = info.get(&c.oracle_id)?;
            Some((c.oracle_id.clone(), Facts::from_card(card, produced.get(&c.oracle_id).cloned().flatten().as_deref())))
        })
        .collect()
}
