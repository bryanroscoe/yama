//! Card-text estimates for public stock lists. Never reads private versions or checks: the
//! combo check read here is the stock list's own (deck_checks/precons.rs).
use super::*;
use crate::analysis::{self, Cache, Entry};
use crate::decks::DeckCard;

#[derive(Clone, Serialize)]
pub struct Power {
    pub method: &'static str,
    pub level: f64,
    pub margin: f64,
    /// The band the power number falls in (2-4). Kept for older readers; `plays_like` is
    /// the same reading with the margin counted.
    pub bracket: i64,
    /// The lowest and highest bracket power ± margin reaches.
    pub plays_like: [i64; 2],
    /// The least bracket Wizards' card rules allow the list, when it can be read.
    pub rules: Option<i64>,
    /// What the rules look at that the list holds: Game Changers, and from a combo check mass
    /// land denial, extra turns and two-card combos.
    pub flags: Vec<String>,
    /// Whether the stock list's Commander Spellbook answer was there to read.
    pub combo_check: bool,
    pub unknown_cards: usize,
}

impl Power {
    /// "Bracket 2" or "Bracket 2 to 3".
    pub(super) fn plays(&self) -> String {
        let [low, high] = self.plays_like;
        if low == high { format!("Bracket {low}") } else { format!("Bracket {low} to {high}") }
    }
}

pub(super) async fn assign(pool: &SqlitePool, rows: &mut [Precon]) -> AppResult<()> {
    let lists: Vec<Vec<DeckCard>> = rows.iter().map(Precon::stock_list).collect::<anyhow::Result<_>>()?;
    let all: Vec<_> = lists.iter().flatten().cloned().collect();
    let info = crate::decks::card_info(pool, &all).await?;
    let produced = crate::decks::produced_mana(pool, &all.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = analysis::facts_for(&all, &info, &produced);
    let checks = crate::deck_checks::precons::results(pool).await?;
    let scores = tokio::task::spawn_blocking(move || {
        let mut cache = Cache::default();
        cache.skip_themes = true;
        lists.iter().map(|cards| {
            let entries: Vec<_> = cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
            if !entries.iter().any(|e| e.card.board != crate::decks::Board::Side && e.facts.is_some()) { return None; }
            // The stock list's own answer, by its cards. No person's check is read for it.
            let check = checks.get(&crate::deck_checks::list_hash(cards));
            let a = analysis::analyze(&entries, check, &mut cache);
            Some(Power { method: a.method, level: a.power, margin: a.margin,
                bracket: a.power_bracket, plays_like: a.bracket.plays_like, rules: a.bracket.rules,
                flags: a.bracket.flags, combo_check: a.combos.checked, unknown_cards: a.unknown_cards.len() })
        }).collect::<Vec<_>>()
    }).await.map_err(anyhow::Error::from)?;
    for (p, score) in rows.iter_mut().zip(scores) { p.power = score; }
    Ok(())
}

/// What a stock list's page shows under its evidence, the same panels as a shared deck's page
/// (public_page): the card-text analysis with themes, the list's own combo check, its Game
/// Changers and Reserve List cards, and its curve and colors.
pub(super) struct Breakdown {
    pub analysis: Option<analysis::DeckAnalysis>,
    pub check: Option<crate::deck_checks::CheckResult>,
    pub game_changers: Option<Vec<String>>,
    pub reserved: Option<Vec<String>>,
    pub stats: crate::deck_stats::DeckStats,
}

/// Same inputs as [`assign`]: the list and its own combo check, never a person's.
pub(super) async fn full(pool: &SqlitePool, p: &Precon) -> AppResult<Breakdown> {
    let cards = p.stock_list()?;
    let info = crate::decks::card_info(pool, &cards).await?;
    let produced = crate::decks::produced_mana(pool, &cards.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = analysis::facts_for(&cards, &info, &produced);
    let check = crate::deck_checks::precons::result(pool, &crate::deck_checks::list_hash(&cards)).await?;
    let game_changers = crate::decks::game_changers(&cards, &info);
    let reserved = crate::decks::reserved_list(&cards, &info);
    let stats = crate::deck_stats::stats(pool, &cards, &info).await?;
    let (analysis, check) = tokio::task::spawn_blocking(move || {
        let entries: Vec<_> = cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
        let assessed = entries.iter().any(|e| e.card.board != crate::decks::Board::Side && e.facts.is_some());
        (assessed.then(|| analysis::analyze(&entries, check.as_ref(), &mut Cache::default())), check)
    }).await.map_err(anyhow::Error::from)?;
    Ok(Breakdown { analysis, check, game_changers, reserved, stats })
}

pub(super) fn cell(p: &Precon) -> String {
    match &p.power {
        Some(a) => format!("<strong>{:.1}/10</strong><small>±{:.1} / Plays like {}</small>{}{}", a.level, a.margin, a.plays(), rules_line(a),
            if a.unknown_cards > 0 { format!("<small>{} unknown cards</small>", a.unknown_cards) } else { String::new() }),
        None => "<span class=\"dim\">Not assessed</span>".into(),
    }
}

/// The card rules' reading, shown only when it asks for more than the list plays like: one
/// Game Changer makes a precon a Bracket 3 list by the rules without making it play like one.
fn rules_line(a: &Power) -> String {
    match a.rules {
        Some(rules) if rules > a.plays_like[1] && a.flags.is_empty() => format!("<small>Bracket {rules} by the card rules</small>"),
        Some(rules) if rules > a.plays_like[1] => format!("<small>Bracket {rules} by the card rules: {}</small>", html::e(&a.flags.join("; "))),
        _ => String::new(),
    }
}

fn ranks(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|x| {
        xs.iter().filter(|y| *y < x).count() as f64 + (xs.iter().filter(|y| *y == x).count() as f64 - 1.0) / 2.0
    }).collect()
}
/// Spearman's rank correlation, ties averaged. `None` under four pairs or with no variation.
pub(crate) fn correlation(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 4 { return None; }
    let x = ranks(&points.iter().map(|p| p.0).collect::<Vec<_>>());
    let y = ranks(&points.iter().map(|p| p.1).collect::<Vec<_>>());
    let mean = (points.len() as f64 - 1.0) / 2.0;
    let xx: f64 = x.iter().map(|v| (v-mean).powi(2)).sum();
    let yy: f64 = y.iter().map(|v| (v-mean).powi(2)).sum();
    (xx * yy > 0.0).then(|| x.iter().zip(y.iter()).map(|(a,b)| (a-mean)*(b-mean)).sum::<f64>() / (xx*yy).sqrt())
}

/// Full catalog, before search and pagination; never mixes commander aggregates with stock.
pub(super) fn comparison(data: &Catalog) -> String {
    use std::fmt::Write;
    let mut out = String::from("<section class=\"public-panel\"><h2>Power and win rates</h2><details><summary>About this comparison</summary><p>Computed power reads card text using Yama’s deck-analysis method. It is not a game simulation. “Plays like” is the bracket whose usual range holds the score, give or take its margin. It is not an official assignment. Wizards’ card rules are read separately: a list with a Game Changer is a Bracket 3 list by those rules even when it plays like Bracket 2, and the precons with one have won about as often as the rest. Stock lists are checked for combos, mass land denial and extra turns with <a href=\"https://commanderspellbook.com/\">Commander Spellbook</a>; until a list’s answer is in, its margin is wider. These estimates do not change the rankings.</p><p>Each chart uses the full catalog, with complete card data and at least 20 games per source. Spearman ρ compares ordering, with ties averaged; it is descriptive, not held-out validation. Stock precons already helped calibrate the power scale. Different fields and engine limitations can explain disagreement.</p></details><div class=\"power-charts\">");
    let sources: Vec<_> = data.publication.iter().chain(data.comparisons.iter()).map(|s| (Some(s.id.as_str()), format!("{} model", consensus::engine_family(&s.engine)))).chain(std::iter::once((None, "Real games, stock lists".into()))).collect();
    for (id, label) in sources {
        let points: Vec<_> = data.precons.iter().filter_map(|p| {
            let a = p.power.as_ref().filter(|a| a.unknown_cards == 0)?;
            let rate = if let Some(id) = id {
                let r = &p.simulations.iter().find(|s| s.publication_id == id)?.rating;
                if r.games < 20 { return None; }
                r.model_win_rate? * 100.0
            } else {
                let r = p.stock_real()?;
                if r.games < 20 { return None; }
                r.rate
            };
            Some((p, a.level, rate))
        }).collect();
        let pairs: Vec<_> = points.iter().map(|(_,x,y)| (*x,*y)).collect();
        let rho = correlation(&pairs).map(|r| format!("{r:.2}")).unwrap_or_else(|| "not estimable".into());
        write!(out, "<figure><figcaption><strong>{}</strong><br>{} decks / Spearman ρ {rho}</figcaption><svg viewBox=\"0 0 400 250\" role=\"img\" aria-label=\"{}: computed power versus win rate\"><path d=\"M40 15V210H380\" fill=\"none\" stroke=\"currentColor\"/><path d=\"M40 162.5H380\" stroke=\"currentColor\" stroke-dasharray=\"4 4\" opacity=\"0.4\"/><text x=\"3\" y=\"20\">100%</text><text x=\"8\" y=\"166\">25%</text><text x=\"15\" y=\"212\">0%</text><text x=\"40\" y=\"230\">1</text><text x=\"365\" y=\"230\">10</text><text x=\"110\" y=\"247\">Computed power (1–10)</text>", html::e(&label), points.len(), html::e(&label)).unwrap();
        for (p,x,y) in points {
            write!(out, "<a href=\"/precons/{}\"><circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4\" fill=\"currentColor\" opacity=\"0.65\"><title>{}: {:.1}/10, {:.1}%</title></circle></a>", html::e(&p.id), 40.0+(x-1.0)/9.0*340.0, 210.0-y*1.9, html::e(&p.name), x, y).unwrap();
        }
        out.push_str("</svg></figure>");
    }
    out.push_str("</div></section>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rank_correlation_handles_ties_constant_and_sparse_data() {
        assert_eq!(correlation(&[(1.,1.),(2.,2.),(2.,2.),(4.,4.)]), Some(1.));
        assert_eq!(correlation(&[(1.,4.),(2.,3.),(3.,2.),(4.,1.)]), Some(-1.));
        assert_eq!(correlation(&[(1.,1.);4]), None);
        assert_eq!(correlation(&[(1.,2.)]), None);
    }
}
