//! Card text the classifier reads: self-references as `cardname`, no reminder text or ability
//! words, and a mode's bullets on the line that chooses them.

use super::Facts;
use fancy_regex::Regex;
use std::sync::LazyLock;

/// A regex compiled once, where it's used.
macro_rules! rx {
    ($p:expr) => {{
        static R: std::sync::LazyLock<fancy_regex::Regex> = std::sync::LazyLock::new(|| fancy_regex::Regex::new($p).expect($p));
        &*R
    }};
}
pub(crate) use rx;

pub(crate) fn has(r: &Regex, s: &str) -> bool {
    r.is_match(s).unwrap_or(false)
}

pub(crate) fn count(r: &Regex, s: &str) -> usize {
    r.find_iter(s).filter(|m| m.is_ok()).count()
}

pub(crate) fn caps<'a>(r: &Regex, s: &'a str) -> Option<fancy_regex::Captures<'a, str>> {
    r.captures(s).ok().flatten()
}

pub(crate) fn front(s: &str) -> &str {
    s.split(" // ").next().unwrap_or("")
}

pub(crate) fn is_land(c: &Facts) -> bool {
    front(&c.type_line).contains("Land")
}

/// The front face's rules text (the card data joins faces with a "//" line).
pub(crate) fn front_text(c: &Facts) -> &str {
    c.oracle_text.split("\n//\n").next().unwrap_or("")
}

/// Every face that isn't a land: an Adventure's spell counts, a land back doesn't.
pub(crate) fn spell_text(c: &Facts) -> String {
    let types: Vec<&str> = c.type_line.split(" // ").collect();
    c.oracle_text
        .split("\n//\n")
        .enumerate()
        .filter(|(i, _)| !types.get(*i).copied().unwrap_or(types[0]).contains("Land"))
        .map(|(_, f)| f)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The names a card's text uses for itself: its name, its front face, a legend's short name.
fn self_names(c: &Facts) -> Vec<String> {
    let mut names = vec![c.name.clone(), front(&c.name).to_string()];
    for n in names.clone() {
        if let Some((short, _)) = n.split_once(',') {
            names.push(short.to_string());
        }
        let first = n.split(' ').next().unwrap_or("");
        if c.type_line.starts_with("Legendary") && first.chars().count() > 3 {
            names.push(first.to_string());
        }
    }
    let mut names: Vec<String> = names.into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    names
}

static SELF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b[Tt]his (?:artifact|creature|land|enchantment|planeswalker|permanent|vehicle|equipment|aura|saga|class|battle|room)\b").unwrap()
});
static REMINDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\([^()]*\)").unwrap());
static ABILITY_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^(?!Choose )[A-Z][A-Za-z' -]{2,30} — (?=\S)").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n•\s*").unwrap());

/// Self-references as CARDNAME, the rest of the text as printed.
pub(crate) fn clean_names(c: &Facts, text: &str) -> String {
    let mut t = text.to_string();
    for n in self_names(c) {
        if !n.is_empty() {
            t = t.replace(&n, "CARDNAME");
        }
    }
    SELF.replace_all(&t, "CARDNAME").into_owned()
}

pub(crate) fn clean(c: &Facts, text: &str) -> String {
    let t = clean_names(c, text);
    let t = REMINDER.replace_all(&t, "");
    let t = ABILITY_WORD.replace_all(&t, "");
    BULLET.replace_all(&t, " • ").into_owned()
}

pub(crate) fn lines(text: &str) -> Vec<&str> {
    text.split('\n').filter(|l| !l.trim().is_empty()).collect()
}

/// Keywords printed on a line of their own ("Flying, trample"), lower case.
pub(crate) fn keyword_lines(c: &Facts) -> Vec<String> {
    let text = clean(c, &spell_text(c));
    let mut out = vec![];
    for l in lines(&text) {
        let l = l.trim();
        if l.len() < 60 && has(rx!(r"^[A-Za-z ]+(?:, [A-Za-z ]+)*$"), l) {
            out.extend(l.split(',').map(|w| w.trim().to_lowercase()));
        }
    }
    out
}

/// "a" 1, "two" 2 ... "x" and "that many" 3.
pub(crate) fn number(word: &str) -> f64 {
    match word.to_lowercase().as_str() {
        "a" | "an" | "one" => 1.0,
        "two" => 2.0,
        "three" => 3.0,
        "four" => 4.0,
        "five" => 5.0,
        "six" => 6.0,
        "seven" => 7.0,
        _ => 3.0,
    }
}

/// Points by mana value: the table's entry for the rounded value; above the table, `default`;
/// below it, the cheapest entry.
pub(crate) fn by_mv(table: &[(i64, f64)], m: f64, default: f64) -> f64 {
    let k = m.round_ties_even() as i64;
    if let Some((_, v)) = table.iter().find(|(key, _)| *key == k) {
        return *v;
    }
    let max = table.iter().map(|(k, _)| *k).max().unwrap_or(0);
    if m > max as f64 { default } else { table.iter().min_by_key(|(k, _)| *k).map(|(_, v)| *v).unwrap_or(default) }
}

/// Mana in a cost: generic numbers plus one per colored, hybrid or Phyrexian symbol; {T} and
/// {X} count nothing.
pub(crate) fn mana_in(cost: &str) -> f64 {
    let mut n = 0.0;
    for sym in rx!(r"\{([^}]+)\}").captures_iter(cost).filter_map(|c| c.ok()) {
        let s = &sym[1];
        if let Ok(v) = s.parse::<f64>() {
            n += v;
        } else if has(rx!(r"(?i)^[WUBRGC](?:/[WUBRGP])?$"), s) {
            n += 1.0;
        }
    }
    n
}

pub(crate) fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Every symbol in an activation cost but {T}: a number is its value, anything else one.
pub(crate) fn cost_symbols(cost: &str) -> f64 {
    rx!(r"\{([^}]+)\}")
        .captures_iter(cost)
        .filter_map(|c| c.ok())
        .map(|c| c[1].to_string())
        .filter(|s| !s.eq_ignore_ascii_case("T"))
        .map(|s| if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) { s.parse().unwrap_or(0.0) } else { 1.0 })
        .sum()
}
