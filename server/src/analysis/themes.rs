//! What the deck is about: a theme counts the cards whose text joins in (15 or more is the
//! deck's core, 10 a major theme, 6 a minor one), plus its biggest creature types.

use super::Facts;
use super::text::{clean, front, has, keyword_lines, rx, spell_text};
use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Theme {
    pub key: String,
    pub label: String,
    /// "core", "major" or "minor".
    pub strength: &'static str,
    pub count: usize,
    pub description: String,
    pub cards: Vec<String>,
}

type Test = fn(&str, &str) -> bool;

const THEMES: &[(&str, &str, Test, &str)] = &[
    ("tokens", "Tokens", |t, _| {
        (has(rx!(r"\bcreates? [^.]*\btokens?\b|\btokens? you control\b|whenever (?:a|one or more) tokens?"), t) && !has(rx!(r"\b(?:treasure|clue|food|blood|gold) token"), t))
            || has(rx!(r"twice that many [^.]*tokens|create twice"), t)
    }, "Makes and uses a wide board of tokens."),
    ("counters", "+1/+1 counters", |t, _| has(rx!(r"\+1/\+1 counters?"), t), "Grows creatures with +1/+1 counters."),
    ("graveyard", "Graveyard", |t, _| {
        has(rx!(r"\bfrom (?:your|a) graveyard\b|\bmill\b|\bcards? in your graveyard\b|leaves? your graveyard|\bdredge\b|\bflashback\b|\bescape\b|\bunearth\b|\bsurveil\b"), t)
    }, "Uses the graveyard as a second hand."),
    ("artifacts", "Artifacts", |t, _| {
        has(rx!(r"\bartifacts? you control\b|\bartifact spells?\b|whenever (?:an|another|one or more) (?:nontoken )?artifacts?\b|\bfor each artifact\b"), t)
    }, "Builds around artifacts."),
    ("enchantments", "Enchantments", |t, _| {
        has(rx!(r"\benchantments? you control\b|\benchantment spells?\b|whenever (?:an|another) enchantment|\bconstellation\b|\bfor each enchantment\b"), t)
    }, "Builds around enchantments."),
    ("spells", "Instants and sorceries", |t, _| {
        has(rx!(r"\binstant (?:or|and) sorcery spells?\b|\bwhenever you cast (?:an|a) (?:instant|sorcery|noncreature)\b|\bmagecraft\b|\bprowess\b|\bcopy target instant"), t)
    }, "Casts and rewards instants and sorceries."),
    ("lands", "Lands matter", |t, _| {
        has(rx!(r"\blandfall\b|whenever a land (?:you control )?enters|\bland cards? from your graveyard\b|play an additional land|\bfor each land you control\b|lands you control (?:have|are)"), t)
    }, "Plays extra lands and rewards land drops."),
    ("voltron", "Equipment and Auras", |t, ty| {
        ty.contains("Equipment") || (ty.contains("Aura") && has(rx!(r"enchanted creature gets \+"), t)) || has(rx!(r"\bequipped creatures?\b|\bwhenever (?:a|an) (?:equipment|aura)\b|for each (?:equipment|aura)"), t)
    }, "Suits up one creature with Equipment and Auras."),
    ("aristocrats", "Sacrifice", |t, _| {
        has(rx!(r"\bsacrifice (?:a|another|one or more) (?:creature|permanent|artifact)s?\b(?![^.]*\bdestroy)|whenever (?:a|another) creature (?:you control )?dies|\bwhenever you sacrifice\b"), t)
    }, "Sacrifices its own creatures for value."),
    ("lifegain", "Life gain", |t, _| has(rx!(r"\bwhenever you gain life\b|\byou gain \d+ life\b|\blifelink\b|\bgain life equal\b"), t), "Gains life and turns it into an advantage."),
    ("blink", "Flicker", |t, _| {
        has(rx!(r"\bexile (?:target|another target|up to \w+ (?:other )?target) [^.]*you (?:control|own)[^.]*\. return (?:it|that card|those cards)|\breturn (?:it|that card|those cards) to the battlefield under (?:its|their) owner'?s'? control\b"), t)
    }, "Exiles and returns its own creatures to reuse their abilities."),
    ("energy", "Energy", |t, _| has(rx!(r"\{e\}|energy counter"), t), "Gets and spends energy."),
    ("draw", "Card draw matters", |t, _| has(rx!(r"whenever you draw (?:a|your second) card|for each card you've drawn"), t), "Rewards drawing extra cards."),
    ("planeswalkers", "Planeswalkers", |t, ty| {
        ty.contains("Planeswalker") || // "You or planeswalkers you control" and "creature or planeswalker card" name them in
        // passing: pillow forts, removal and reanimation aren't a planeswalker deck.
        has(rx!(r"\bloyalty abilit|(?<!or )(?<!and )(?<!, )\bplaneswalkers? you control\b|(?<!or )\bplaneswalker (?:card|spell)s?\b"), t)
    }, "Fields planeswalkers and the cards that find them and work their loyalty."),
    ("legends", "Legends matter", |t, _| {
        // A spell that targets a legendary creature isn't rewarding them.
        has(rx!(r"(?<!target )(?<!targets a )\blegendary (?:creature|permanent|spell|card)s?\b|\bhistoric\b|\bfor each legendary\b|\banother legendary\b"), t)
    }, "Rewards playing legendary cards."),
    ("goad", "Goad and politics", |t, _| {
        has(rx!(r"\bgoad(?:ed|s)?\b|\battacks? (?:a player other than you|one of your opponents)\b|\bcan't attack you\b|\bthe monarch\b|\bcouncil's dilemma\b|\bwill of the council\b|\btempting offer\b"), t)
    }, "Turns opponents' creatures on each other, keeps them off you and makes deals at the table."),
    ("attack", "Go wide and attack", |t, _| {
        has(rx!(r"whenever (?:one or more|a) creatures? you control attacks?|creatures you control get \+\d/\+\d|attacking creatures you control"), t)
    }, "Attacks with many creatures at once."),
];

/// The deck's themes, biggest first, at most five. `cards`: (facts, copies) of the commander
/// and main deck.
pub fn themes(cards: &[(&Facts, i64)]) -> Vec<Theme> {
    // (key, label, description, (card, copies), a creature type)
    let mut found: Vec<(String, String, String, Vec<(String, i64)>, bool)> = vec![];
    let texts: Vec<String> = cards.iter().map(|(c, _)| clean(c, &spell_text(c)).to_lowercase()).collect();
    for (key, label, test, desc) in THEMES {
        let hits = cards
            .iter()
            .zip(&texts)
            .filter(|((c, _), _)| !super::text::is_land(c) || matches!(*key, "lands" | "graveyard"))
            .filter(|((c, _), t)| test(t, &c.type_line))
            .map(|((c, qty), _)| (c.name.clone(), *qty))
            .collect();
        found.push((key.to_string(), label.to_string(), desc.to_string(), hits, false));
    }
    // Creature types, in the order first seen; a changeling counts for every type.
    let changeling: Vec<bool> = cards.iter().map(|(c, _)| keyword_lines(c).iter().any(|k| k == "changeling")).collect();
    let mut types: Vec<(String, i64)> = vec![];
    for (c, qty) in cards {
        let tl = front(&c.type_line);
        if tl.contains("Creature")
            && let Some((_, subs)) = tl.split_once('—')
        {
            for sub in subs.split_whitespace() {
                match types.iter_mut().find(|(s, _)| s == sub) {
                    Some(e) => e.1 += qty,
                    None => types.push((sub.to_string(), *qty)),
                }
            }
        }
    }
    let mut ranked: Vec<(usize, &(String, i64))> = types.iter().enumerate().collect();
    ranked.sort_by(|a, b| b.1.1.cmp(&a.1.1).then(a.0.cmp(&b.0)));
    let top: Vec<(String, i64)> = ranked.iter().map(|(_, t)| (*t).clone()).collect();
    for (sub, _) in top.into_iter().take(2) {
        let names: Vec<(String, i64)> = cards
            .iter()
            .zip(&changeling)
            .filter(|((c, _), ch)| front(&c.type_line).contains(sub.as_str()) || **ch)
            .map(|((c, qty), _)| (c.name.clone(), *qty))
            .collect();
        let copies: i64 = names.iter().map(|(_, q)| q).sum();
        found.push((format!("tribe:{sub}"), format!("{sub} tribal"), format!("{copies} {sub} cards."), names, true));
    }
    let mut out: Vec<Theme> = found
        .into_iter()
        .filter_map(|(key, label, description, cards, tribe)| {
            // Copies, so 30 Relentless Rats count as 30.
            let n = cards.iter().map(|(_, q)| q.max(&0)).sum::<i64>() as usize;
            let cards: Vec<String> = cards.into_iter().map(|(c, _)| c).collect();
            let strength = if n >= 15 {
                "core"
            } else if n >= 10 {
                "major"
            } else if n >= 6 && !tribe {
                "minor"
            } else {
                return None;
            };
            Some(Theme { key, label, strength, count: n, description, cards })
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count));
    out.truncate(5);
    out
}
