//! Descriptive deck statistics on the server: the mana curve (creatures and other spells), lands,
//! average mana value, colored pips and the lands that can make each color. The same counting
//! rules as packages/core's deckStats, used by the MCP analysis and by shared deck pages. These
//! are counts, not a castability or power verdict.

use crate::cards::Card;
use crate::decks::{Board, DeckCard};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const BASIC_TYPES: [(&str, char); 5] = [("Plains", 'W'), ("Island", 'U'), ("Swamp", 'B'), ("Mountain", 'R'), ("Forest", 'G')];

/// Colored symbols in a mana cost; a hybrid symbol counts for each of its colors.
pub fn colored_pips(cost: &str) -> BTreeMap<char, i64> {
    let mut out = BTreeMap::new();
    for symbol in cost.split('{').skip(1).filter_map(|s| s.split_once('}').map(|(sym, _)| sym)) {
        let colors: BTreeSet<char> = symbol
            .split('/')
            .filter_map(|s| (s.len() == 1).then(|| s.chars().next().unwrap()))
            .filter(|c| "WUBRG".contains(*c))
            .collect();
        for color in colors {
            *out.entry(color).or_default() += 1;
        }
    }
    out
}

#[derive(Debug, Default, Clone)]
pub struct DeckStats {
    /// Commander and main deck copies, unknown cards included; the sideboard doesn't count.
    pub cards: i64,
    pub lands: i64,
    pub nonlands: i64,
    pub creatures: i64,
    /// Nonland spells by mana value 0 to 7+: (creatures, other spells).
    pub curve: [(i64, i64); 8],
    pub mana_value_total: f64,
    pub pips: BTreeMap<char, i64>,
    /// Lands that can make each color, or None while some land's mana isn't in the card data.
    pub sources: Option<BTreeMap<char, i64>>,
    pub lands_without_mana_data: Vec<String>,
    /// Cards not in the card data, left out of everything above but `cards`.
    pub unknown: Vec<String>,
}

impl DeckStats {
    pub fn average_mana_value(&self) -> Option<f64> {
        (self.lands + self.nonlands > 0).then(|| self.mana_value_total / (self.lands + self.nonlands) as f64)
    }
    pub fn average_nonland_mana_value(&self) -> Option<f64> {
        (self.nonlands > 0).then(|| self.mana_value_total / self.nonlands as f64)
    }
}

async fn produced(pool: &SqlitePool, oracle_id: &str) -> sqlx::Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, Option<String>>("SELECT produced_mana FROM cards WHERE oracle_id = ?")
        .bind(oracle_id)
        .fetch_optional(pool)
        .await?
        .flatten())
}

pub async fn stats(pool: &SqlitePool, cards: &[DeckCard], info: &HashMap<String, Card>) -> sqlx::Result<DeckStats> {
    let mut s = DeckStats::default();
    let mut sources = BTreeMap::<char, i64>::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        // Every copy counts toward the deck's size, as in packages/core; an unknown card is
        // only left out of the counts that need its data.
        s.cards += c.qty;
        let Some(card) = info.get(&c.oracle_id) else {
            s.unknown.push(c.name.clone());
            continue;
        };
        let front = card.type_line.split(" // ").next().unwrap_or("");
        if front.contains("Land") {
            s.lands += c.qty;
        } else {
            s.nonlands += c.qty;
            s.mana_value_total += card.cmc * c.qty as f64;
            let slot = &mut s.curve[(card.cmc.max(0.0).floor() as usize).min(7)];
            if front.contains("Creature") {
                s.creatures += c.qty;
                slot.0 += c.qty;
            } else {
                slot.1 += c.qty;
            }
            for (color, n) in colored_pips(card.mana_cost.as_deref().unwrap_or("").split(" // ").next().unwrap_or("")) {
                *s.pips.entry(color).or_default() += n * c.qty;
            }
        }
        if !card.type_line.split(" // ").any(|f| f.contains("Land")) {
            continue;
        }
        let Some(mana) = produced(pool, &c.oracle_id).await? else {
            s.lands_without_mana_data.push(c.name.clone());
            continue;
        };
        let mut colors: BTreeSet<char> = mana.chars().filter(|c| "WUBRG".contains(*c)).collect();
        // Fetch access is counted only for actual eligible targets in this list's commander and
        // main deck; a sideboard land can't be fetched.
        let text = card.oracle_text.to_lowercase();
        if colors.is_empty() && text.contains("search your library for") {
            for target in cards.iter().filter(|c| c.board != Board::Side).filter_map(|c| info.get(&c.oracle_id)) {
                let ty = target.type_line.split(" // ").next().unwrap_or("");
                if !ty.contains("Land") {
                    continue;
                }
                if text.contains("basic land card") && ty.contains("Basic") {
                    for (t, color) in BASIC_TYPES {
                        if ty.contains(t) {
                            colors.insert(color);
                        }
                    }
                } else if BASIC_TYPES.iter().any(|(t, _)| text.contains(&t.to_lowercase()) && ty.contains(t)) {
                    match produced(pool, &target.oracle_id).await? {
                        Some(mana) => colors.extend(mana.chars().filter(|c| "WUBRG".contains(*c))),
                        None => s.lands_without_mana_data.push(target.name.clone()),
                    }
                }
            }
        }
        for color in colors {
            *sources.entry(color).or_default() += c.qty;
        }
    }
    s.sources = s.lands_without_mana_data.is_empty().then_some(sources);
    Ok(s)
}
