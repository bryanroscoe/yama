//! An estimate on the older 1-10 power-level scale, on the server: the same rules as
//! packages/core/src/powerLevel.ts, which the deck page uses, for shared deck pages and the MCP
//! deck analysis. Both read packages/core/src/powerLevel.cases.json in their tests, so a change
//! to one that the other doesn't make fails. The starting bracket suggestion sets a two-point
//! band (2: 3-5, 3: 5-7, 4: 7-9) and capped, weighted factors from the card list move the score
//! inside it. Yama's own heuristic, not an official scale or a measure of how the deck plays.
//!
//! The patterns are JavaScript's, so they use `fancy_regex` for its lookaround; a pattern that
//! fails to run (a backtracking limit) counts as no match.

use crate::cards::Card;
use crate::deck_checks::CheckResult;
use crate::decks::{Board, DeckCard};
use fancy_regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::LazyLock;

/// One deck entry, as the estimate reads it (packages/core's StatCard).
#[derive(Debug, Clone)]
pub struct PowerCard {
    pub name: String,
    pub qty: i64,
    pub side: bool,
    /// Mana value; None when the card isn't in the card data.
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    /// Colors of mana the card makes; "" for none; None when not loaded.
    pub produced_mana: Option<String>,
    pub oracle_text: Option<String>,
}

/// Signals from the bracket check (Commander Spellbook), with the cards behind them.
#[derive(Debug, Clone, Default)]
pub struct PowerSignals {
    /// The starting bracket suggestion. Only 2-4 get a score.
    pub bracket: Option<i64>,
    pub game_changers: Vec<String>,
    /// Definite two-card combos, one "A + B" label each.
    pub two_card_combos: Vec<String>,
    pub mass_land_denial: Vec<String>,
    pub extra_turns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PowerFactor {
    pub key: &'static str,
    pub label: &'static str,
    /// What counts, in a sentence.
    pub rule: String,
    /// Copies counted (the curve factor: the nonland average mana value).
    pub count: f64,
    /// The count at which the factor gives its full weight.
    pub cap: f64,
    /// Share of the band, 0-1; the weights add up to 1.
    pub weight: f64,
    /// Points added to the score, from 0 to weight times the band's width.
    pub points: f64,
    pub cards: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PowerEstimate {
    /// 1 decimal.
    pub score: f64,
    pub bracket: i64,
    pub band: [i64; 2],
    pub factors: Vec<PowerFactor>,
    /// Cards missing from the card data, which the card-text factors can't count.
    pub unknown_cards: Vec<String>,
}

pub fn band(bracket: i64) -> Option<[i64; 2]> {
    match bracket {
        2 => Some([3, 5]),
        3 => Some([5, 7]),
        4 => Some([7, 9]),
        _ => None,
    }
}

const CURVE_FULL: f64 = 2.5;
const CURVE_FLAT: f64 = 4.0;
const CHEAP: f64 = 2.0;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("power-level pattern")
}
fn test(r: &Regex, s: &str) -> bool {
    r.is_match(s).unwrap_or(false)
}
fn count(r: &Regex, s: &str) -> usize {
    r.find_iter(s).filter(|m| m.is_ok()).count()
}

static BASIC_OR_LAND: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:land|plains|island|swamp|mountain|forest|wastes)\b"));
static NONLAND_TYPE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:creature|artifact|enchantment|instant|sorcery|planeswalker|battle|equipment|aura)\b"));
static MAKES_MANA: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\badds? (?:\{|(?:one|two|three|x|an amount of) mana\b)"));
static INTERACTION: LazyLock<Regex> = LazyLock::new(|| {
    // "Target", or the optional "up to one target".
    let t = r"(?:up to (?:one|two|three|x) )?target";
    re(&format!(
        "(?i){}",
        [
            format!(r"\bcounter {t}\b"),
            format!(r"\bdestroy {t}\b"),
            format!(r"\bexile {t} (?!card from|cards from)"),
            format!(r"\breturn {t} (?:[^.]*?) to (?:its|their) owner'?s'? hands?\b"),
            format!(r"\bdeals? (?:\d+|x) damage to (?:any target|{t} (?:creature|planeswalker|player|opponent|attacking|blocking))"),
            format!(r"\bdeals? damage equal to [^.]*? to (?:any target|{t}\b)"),
            format!(r"\bput {t} (?:[^.]*?) (?:into|on (?:the )?(?:top|bottom) of) (?:its|their) owner'?s'? library"),
            r"\btarget (?:[^.]*?)\bgets? -(?:\d+|x)/-(?:\d+|x)".to_string(),
            format!(r"\bfights? {t}\b"),
            r"\b(?:target (?:player|opponent)|each opponent) sacrifices\b".to_string(),
        ]
        .join("|")
    ))
});
/// Targets limited to your own things (Ephemerate, Cloudshift) make a blink, not interaction;
/// a sentence counts while one target isn't yours (Prey Upon).
static OWN_TARGET: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\btarget (?:[\w'-]+,? ){0,4}?you (?:control|own)\b"));
static TARGET: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\btarget\b"));
/// An Aura that shuts a creature off (Pacifism, Darksteel Mutation, Lignify, Frogify).
static REMOVAL_AURA: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\benchanted (?:creature|permanent)\b[^.]*?(?:loses all (?:other )?abilities|can't attack or block|can't block|doesn't untap)"));
static LAND_SEARCH: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)search your library for [^.]*\b(?:land|plains|island|swamp|mountain|forest)s? cards?\b[^.]*onto the battlefield"));
static LAND_DROP: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\bput (?:a|an|all|up to \w+) (?:basic )?lands? cards? from [^.]*?onto the battlefield|\bplay (?:an|two|three|up to \w+) additional lands?\b")
});
static DRAW: LazyLock<Regex> = LazyLock::new(|| {
    // "Whenever an opponent draws a card" (Orcish Bowmasters) isn't this deck drawing.
    re(r"(?i)(?<!opponent )\bdraws? (?:a|an|one|two|three|four|five|x|that many) (?:additional )?cards?\b|(?<!opponent )\bdraws? cards? equal\b")
});
static TUTOR: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)search(?:es)? (?:your|their) (?:library|graveyard and/or library|library and/or graveyard) for ([^.]*?)\bcards?\b"));
static MANA_ABILITY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(.*?):\s*(?:[^.]*?\s)?adds? (.*)$"));
static SYMBOL: LazyLock<Regex> = LazyLock::new(|| re(r"\{([^}]+)\}"));
static COLORED: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[WUBRGC](?:/[WUBRGP])?$"));
static MADE_SYMBOL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\{[WUBRGC]\}"));
static MADE_WORDS: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(one|two|three|x) mana\b"));

fn front(s: &str) -> &str {
    s.split(" // ").next().unwrap_or("")
}
fn face_text(c: &PowerCard) -> &str {
    c.oracle_text.as_deref().unwrap_or("")
}
/// A multi-face card's rules text is joined with a "//" line; the mana value is the front
/// face's, so the cheap factors read only the front face.
fn front_text(c: &PowerCard) -> &str {
    face_text(c).split("\n//\n").next().unwrap_or("")
}
fn is_land(c: &PowerCard) -> bool {
    front(c.type_line.as_deref().unwrap_or("")).contains("Land")
}
fn has_land_back(c: &PowerCard) -> bool {
    c.type_line.as_deref().unwrap_or("").split(" // ").skip(1).any(|t| t.contains("Land"))
}
fn cheap(c: &PowerCard) -> bool {
    c.cmc.is_some_and(|v| v <= CHEAP) && !is_land(c)
}

/// Net mana from the card's "cost: Add ..." abilities: the best of mana out minus mana in, or
/// None with no such ability. A filter puts in what it takes out; a Signet pays one for two.
fn net_mana_ability(text: &str) -> Option<i64> {
    let mut best: Option<i64> = None;
    for line in text.split('\n') {
        let Ok(Some(m)) = MANA_ABILITY.captures(line) else { continue };
        let mut cost = 0;
        for sym in SYMBOL.captures_iter(&m[1]).filter_map(|c| c.ok()) {
            let sym = &sym[1];
            if !sym.is_empty() && sym.bytes().all(|b| b.is_ascii_digit()) {
                cost += sym.parse::<i64>().unwrap_or(0);
            } else if test(&COLORED, sym) {
                cost += 1;
            }
        }
        let made = m[2].split('.').next().unwrap_or("");
        let symbols = count(&MADE_SYMBOL, made) as i64;
        let words = MADE_WORDS.captures(made).ok().flatten().map(|w| match w[1].to_lowercase().as_str() {
            "one" => 1,
            "three" => 3,
            _ => 2, // two, and X
        });
        let out = if symbols > 0 { symbols } else { words.unwrap_or(0) };
        best = Some(best.map_or(out - cost, |b| b.max(out - cost)));
    }
    best
}

/// A rock, dork or ritual, or a spell that puts a land onto the battlefield.
pub fn is_cheap_mana(c: &PowerCard) -> bool {
    if !cheap(c) {
        return false;
    }
    let text = front_text(c);
    if test(&LAND_SEARCH, text) || test(&LAND_DROP, text) {
        return true;
    }
    if let Some(net) = net_mana_ability(text) {
        return net > 0;
    }
    match &c.produced_mana {
        Some(made) if !has_land_back(c) => !made.is_empty(),
        _ => test(&MAKES_MANA, text),
    }
}

pub fn is_cheap_draw(c: &PowerCard) -> bool {
    cheap(c) && test(&DRAW, front_text(c))
}

fn only_own_targets(sentence: &str) -> bool {
    let targets = count(&TARGET, sentence);
    targets > 0 && count(&OWN_TARGET, sentence) >= targets
}

/// Removal, a counterspell or a bounce, at two mana or less.
pub fn is_cheap_interaction(c: &PowerCard) -> bool {
    if !cheap(c) {
        return false;
    }
    let text = front_text(c);
    if front(c.type_line.as_deref().unwrap_or("")).contains("Aura") && test(&REMOVAL_AURA, text) {
        return true;
    }
    text.split(['.', '\n']).any(|s| test(&INTERACTION, s) && !only_own_targets(s))
}

/// Finds a card other than a land from the library.
pub fn is_tutor(c: &PowerCard) -> bool {
    if is_land(c) {
        return false;
    }
    TUTOR.captures_iter(face_text(c)).filter_map(|m| m.ok()).any(|m| {
        // "A creature or land card" can still find a nonland card.
        let what = &m[1];
        !test(&BASIC_OR_LAND, what) || test(&NONLAND_TYPE, what)
    })
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

pub fn estimate(all: &[PowerCard], signals: &PowerSignals) -> Option<PowerEstimate> {
    let bracket = signals.bracket?;
    let band = band(bracket)?;
    let width = (band[1] - band[0]) as f64;
    let cards: Vec<&PowerCard> = all.iter().filter(|c| !c.side && c.qty > 0).collect();
    let known: Vec<&PowerCard> = cards.iter().copied().filter(|c| c.type_line.is_some() && c.cmc.is_some()).collect();
    let unknown_cards = cards.iter().filter(|c| c.type_line.is_none() || c.cmc.is_none()).map(|c| c.name.clone()).collect();

    let counted = |test: fn(&PowerCard) -> bool| {
        let hits: Vec<&&PowerCard> = known.iter().filter(|c| test(c)).collect();
        (hits.iter().map(|c| c.qty).sum::<i64>() as f64, hits.iter().map(|c| c.name.clone()).collect::<Vec<_>>())
    };
    let factor = |key, label, rule: &str, cap: f64, weight: f64, (count, cards): (f64, Vec<String>)| PowerFactor {
        key,
        label,
        rule: rule.to_string(),
        cap,
        weight,
        count,
        points: (count.min(cap) / cap) * weight * width,
        cards,
    };

    let nonland: Vec<&&PowerCard> = known.iter().filter(|c| !is_land(c)).collect();
    let copies: i64 = nonland.iter().map(|c| c.qty).sum();
    let average = (copies > 0).then(|| nonland.iter().map(|c| c.cmc.unwrap_or(0.0) * c.qty as f64).sum::<f64>() / copies as f64);
    let curve_share = average.map_or(0.0, |a| ((CURVE_FLAT - a) / (CURVE_FLAT - CURVE_FULL)).clamp(0.0, 1.0));
    let curve_weight = 0.15;
    let names = |v: &[String]| (v.len() as f64, v.to_vec());

    let factors = vec![
        factor("mana", "Cheap mana", "Rocks, dorks, rituals and land ramp at two mana or less", 8.0, 0.15, counted(is_cheap_mana)),
        factor("draw", "Cheap card draw", "Nonland cards at two mana or less that draw cards", 8.0, 0.1, counted(is_cheap_draw)),
        factor("interaction", "Cheap interaction", "Targeted removal, counterspells and bounce at two mana or less", 8.0, 0.15, counted(is_cheap_interaction)),
        factor("tutors", "Tutors", "Cards that search the library for something other than a land", 4.0, 0.1, counted(is_tutor)),
        PowerFactor {
            key: "curve",
            label: "Low curve",
            rule: "Nonland average mana value: full at 2.5 or less, nothing at 4 or more".into(),
            count: average.map_or(0.0, |a| (a * 100.0).round() / 100.0),
            cap: CURVE_FULL,
            weight: curve_weight,
            points: curve_share * curve_weight * width,
            cards: vec![],
        },
        factor("gameChangers", "Game Changers", "Cards on the official Game Changer list", 4.0, 0.15, names(signals.game_changers.as_slice())),
        factor("combos", "Two-card combos", "Commander Spellbook's definite two-card combos", 2.0, 0.15, names(signals.two_card_combos.as_slice())),
        factor(
            "denial",
            "Mass land denial and extra turns",
            "Cards Commander Spellbook flags for either",
            2.0,
            0.05,
            names([signals.mass_land_denial.as_slice(), signals.extra_turns.as_slice()].concat().as_slice()),
        ),
    ];
    let score = band[0] as f64 + factors.iter().fold(0.0, |n, f| n + f.points);
    Some(PowerEstimate { score: round1(score.min(band[1] as f64)), bracket, band, factors, unknown_cards })
}

/// The starting suggestion as a number, 2-4, when the check gives one (deckCheck.ts,
/// suggestedBracket): E is the provisional Core starting point; None for a banned card or a
/// tag Yama doesn't know.
pub fn suggested_bracket(r: &CheckResult) -> Option<i64> {
    match (r.bracket_tag.as_str(), r.bracket) {
        ("E", _) => Some(2),
        (tag, Some(b)) if ["C", "O", "P", "S", "R"].contains(&tag) && (2..=4).contains(&b) => Some(b),
        _ => None,
    }
}

/// The estimate for a stored deck list and its stored bracket check, as the deck page works
/// it out (components/Bracket.tsx): None without a check or a 2-4 suggestion.
pub fn for_deck(
    list: &[DeckCard],
    info: &HashMap<String, Card>,
    produced: &HashMap<String, Option<String>>,
    check: Option<&CheckResult>,
) -> Option<PowerEstimate> {
    let r = check?;
    let cards: Vec<PowerCard> = list
        .iter()
        .map(|c| {
            let card = info.get(&c.oracle_id);
            PowerCard {
                name: c.name.clone(),
                qty: c.qty,
                side: c.board == Board::Side,
                cmc: card.map(|k| k.cmc),
                type_line: card.map(|k| k.type_line.clone()),
                produced_mana: produced.get(&c.oracle_id).cloned().flatten(),
                oracle_text: card.map(|k| k.oracle_text.clone()),
            }
        })
        .collect();
    estimate(
        &cards,
        &PowerSignals {
            bracket: suggested_bracket(r),
            game_changers: r.game_changers.clone(),
            two_card_combos: r.combos.iter().filter(|x| x.definitely_two_card).map(|x| x.cards.join(" + ")).collect(),
            mass_land_denial: r.mld.clone(),
            extra_turns: r.extra_turns.clone(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../packages/core/src/powerLevel.cases.json");

    fn card(v: &Value) -> PowerCard {
        let s = |k: &str| v[k].as_str().map(String::from);
        PowerCard {
            name: s("name").unwrap(),
            qty: v["qty"].as_i64().unwrap(),
            side: v["board"] == "side",
            cmc: v["cmc"].as_f64(),
            type_line: s("typeLine"),
            produced_mana: s("producedMana"),
            oracle_text: s("oracleText"),
        }
    }
    fn strings(v: &Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn classifies_each_shared_case_as_the_web_does() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        for c in cases["classify"].as_array().unwrap() {
            let k = card(&c["card"]);
            let got = [is_cheap_mana(&k), is_cheap_draw(&k), is_cheap_interaction(&k), is_tutor(&k)];
            let want = ["mana", "draw", "interaction", "tutor"].map(|f| c[f].as_bool().unwrap());
            assert_eq!(got, want, "{} (mana, draw, interaction, tutor)", k.name);
        }
    }

    #[test]
    fn gives_each_shared_estimate_as_the_web_does() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        for c in cases["estimates"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let cards: Vec<PowerCard> = c["cards"].as_array().unwrap().iter().map(card).collect();
            let s = &c["signals"];
            let signals = PowerSignals {
                bracket: s["bracket"].as_i64(),
                game_changers: strings(&s["gameChangers"]),
                two_card_combos: strings(&s["twoCardCombos"]),
                mass_land_denial: strings(&s["massLandDenial"]),
                extra_turns: strings(&s["extraTurns"]),
            };
            let got = estimate(&cards, &signals);
            let want = &c["expected"];
            let Some(got) = got else {
                assert!(want.is_null(), "{name}: no estimate here, one on the web");
                continue;
            };
            assert!(!want.is_null(), "{name}: an estimate here, none on the web");
            assert_eq!(got.score, want["score"].as_f64().unwrap(), "{name}: score");
            assert_eq!(got.bracket, want["bracket"].as_i64().unwrap(), "{name}: bracket");
            assert_eq!(serde_json::to_value(got.band).unwrap(), want["band"], "{name}: band");
            assert_eq!(got.unknown_cards, strings(&want["unknownCards"]), "{name}: unknown cards");
            let factors = want["factors"].as_array().unwrap();
            assert_eq!(got.factors.len(), factors.len(), "{name}: factors");
            for (g, w) in got.factors.iter().zip(factors) {
                let at = format!("{name}: {}", g.key);
                assert_eq!(g.key, w["key"], "{at}");
                assert_eq!(g.label, w["label"], "{at}");
                assert_eq!(g.rule, w["rule"], "{at}");
                assert_eq!(g.cards, strings(&w["cards"]), "{at}");
                for (field, v) in [("count", g.count), ("cap", g.cap), ("weight", g.weight), ("points", g.points)] {
                    assert!((v - w[field].as_f64().unwrap()).abs() < 1e-9, "{at}: {field} {v} vs {}", w[field]);
                }
            }
        }
    }

    #[test]
    fn suggests_a_scoring_bracket_only_from_a_usable_tag() {
        let r = |tag: &str, bracket: Option<i64>| CheckResult {
            checked_at: String::new(),
            bracket_tag: tag.into(),
            bracket_label: "",
            bracket,
            game_changers: vec![],
            mld: vec![],
            extra_turns: vec![],
            combos: vec![],
            unrecognized: vec![],
        };
        assert_eq!(suggested_bracket(&r("E", None)), Some(2));
        assert_eq!(suggested_bracket(&r("O", Some(4))), Some(4));
        assert_eq!(suggested_bracket(&r("R", Some(5))), None);
        assert_eq!(suggested_bracket(&r("B", Some(3))), None);
        assert_eq!(suggested_bracket(&r("Z", Some(3))), None);
    }
}
