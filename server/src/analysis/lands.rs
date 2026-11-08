//! How good a land is for this deck, 0-1: untapped and making the deck's colors is best, a
//! basic in a two-color deck middling, an unconditional tapland poor. Lands are judged by what
//! they do (text and types), never by price or the Reserve List.

use super::Facts;
use super::text::{front, front_text, has, lines, rx};

const BASIC_TYPES: [&str; 5] = ["Plains", "Island", "Swamp", "Mountain", "Forest"];

/// (group label, quality) for a land in a deck of `colors` colors.
pub fn quality(c: &Facts, colors: usize) -> (&'static str, f64) {
    // Reminder text stays: an original dual's only text is "({T}: Add {R} or {W}.)".
    let t = super::text::clean_names(c, front_text(c));
    let tl = t.to_lowercase();
    let ty = front(&c.type_line);
    let basic_types = BASIC_TYPES.iter().filter(|b| ty.contains(*b)).count();
    let produced = c.produced_mana.as_deref().unwrap_or("");
    let colored = produced.chars().filter(|x| "WUBRG".contains(*x)).count();
    let k = colors;
    let before_tapped: String = {
        let head = tl.split("tapped").next().unwrap_or("");
        let n = head.chars().count();
        head.chars().skip(n.saturating_sub(80)).collect()
    };
    let tapped_always = has(rx!(r"cardname enters (?:the battlefield )?tapped\."), &tl)
        && !before_tapped.contains("unless")
        && !has(rx!(r"enters (?:the battlefield )?tapped unless|if you don't, it enters|you may pay \d life"), &tl);
    if ty.contains("Basic") {
        if c.name == "Wastes" {
            return ("Basic lands", if k == 0 { 0.5 } else { 0.2 });
        }
        return ("Basic lands", match k {
            0 => 0.9,
            1 => 0.92,
            2 => 0.6,
            _ => 0.45,
        });
    }
    if c.name == "Command Tower" {
        return ("Premium fixing", if k >= 2 { 1.0 } else { 0.85 });
    }
    if has(rx!(r"search your library for (?:an? )?(?:basic )?(?:land|plains|island|swamp|mountain|forest)[^.]*card"), &tl) && tl.contains("sacrifice cardname") {
        let after = tl.split_once("search").map(|(_, a)| a).unwrap_or("");
        if after.contains("tapped") {
            if tl.contains("then if you control four or more lands, untap") {
                return ("Fetch lands", if k >= 2 { 0.72 } else { 0.6 });
            }
            return ("Slow fetches", if k >= 2 { 0.42 } else { 0.3 });
        }
        return ("Fetch lands", if k >= 2 { 0.96 } else { 0.75 });
    }
    if basic_types >= 3 {
        return ("Triomes", if k >= 3 { 0.66 } else { 0.5 });
    }
    if basic_types == 2 {
        if tl.trim().is_empty() || has(rx!(r"^\(\{t\}: add \{\w\} or \{\w\}\.\)$"), tl.trim()) {
            return ("Original duals", 1.0);
        }
        if has(rx!(r"you may pay 2 life\. if you don't, it enters tapped"), &tl) {
            return ("Shock lands", 0.95);
        }
        if tapped_always {
            return ("Tapped duals", if k >= 2 { 0.46 } else { 0.2 });
        }
        return ("Dual lands", 0.88);
    }
    if has(rx!(r"enters (?:the battlefield )?tapped unless you control two or fewer other lands"), &tl) {
        return ("Fast lands", if colored >= 2 { 0.9 } else { 0.6 });
    }
    if has(rx!(r"enters (?:the battlefield )?tapped unless you control (?:a|an) (?:plains|island|swamp|mountain|forest)"), &tl) {
        return ("Check lands", 0.86);
    }
    if has(rx!(r"enters (?:the battlefield )?tapped unless you have two or more opponents"), &tl) {
        return ("Battlebond lands", 0.95);
    }
    if has(rx!(r"enters (?:the battlefield )?tapped unless you control two or more other lands"), &tl) {
        return ("Slow lands", 0.76);
    }
    if has(rx!(r"enters (?:the battlefield )?tapped unless"), &tl) {
        return ("Conditional duals", if colored >= 2 { 0.78 } else { 0.6 });
    }
    if tl.contains("return a land you control to its owner's hand") {
        return ("Bounce lands", 0.55);
    }
    let any_color = has(rx!(r"add one mana of any (?:color|type)"), &tl) || "WUBRG".chars().all(|x| produced.contains(x));
    if tapped_always {
        if colored >= 3 || any_color {
            return ("Tapped lands", if k >= 3 { 0.5 } else { 0.4 });
        }
        if colored >= 2 {
            return ("Tapped lands", if k >= 2 { 0.45 } else { 0.2 });
        }
        return ("Tapped lands", if k >= 2 { 0.2 } else { 0.3 });
    }
    if colored >= 2 || any_color {
        let mut q = 0.9;
        if has(rx!(r"deals 1 damage to you|lose 1 life|pay 1 life"), &tl) {
            q = 0.88;
        }
        if c.name.to_lowercase().contains("exotic orchard") || tl.contains("could produce") {
            q = 0.82;
        }
        if has(rx!(r"\{\d\}, \{t\}: add|\{t\}, pay \{\d\}|\{\w/\w\}, \{t\}: add"), &tl) {
            q = 0.85;
        }
        return ("Dual lands", q);
    }
    if colored == 1 {
        if k <= 1 {
            return ("Utility lands", 0.92);
        }
        return ("Utility lands", if lines(&t).len() > 1 { 0.62 } else { 0.58 });
    }
    ("Colorless lands", match k {
        0 => 0.9,
        1 => 0.55,
        2 => 0.38,
        _ => 0.28,
    })
}
