//! Card-text estimates for public stock lists. Never reads private versions or checks.
use super::*;
use crate::analysis::{self, Cache, Entry};
use crate::decks::DeckCard;

#[derive(Clone, Serialize)]
pub struct Power {
    pub method: &'static str,
    pub level: f64,
    pub margin: f64,
    pub bracket: i64,
    pub unknown_cards: usize,
}

pub(super) async fn assign(pool: &SqlitePool, rows: &mut [Precon]) -> AppResult<()> {
    let lists: Vec<Vec<DeckCard>> = rows.iter().map(|p| {
        let cards: Vec<crate::lab::PreconCard> = serde_json::from_str(&p.stock_cards)?;
        Ok(cards.into_iter().map(|c| DeckCard {
            oracle_id: c.oracle_id.unwrap_or_default(), name: c.name,
            qty: i64::from(c.qty), board: c.board,
        }).collect())
    }).collect::<Result<_, serde_json::Error>>().map_err(anyhow::Error::from)?;
    let all: Vec<_> = lists.iter().flatten().cloned().collect();
    let info = crate::decks::card_info(pool, &all).await?;
    let produced = crate::decks::produced_mana(pool, &all.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = analysis::facts_for(&all, &info, &produced);
    let scores = tokio::task::spawn_blocking(move || {
        let mut cache = Cache::default();
        cache.skip_themes = true;
        lists.iter().map(|cards| {
            let entries: Vec<_> = cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
            if !entries.iter().any(|e| e.card.board != crate::decks::Board::Side && e.facts.is_some()) { return None; }
            // No private Spellbook result is reused for a public stock list.
            let a = analysis::analyze(&entries, None, &mut cache);
            Some(Power { method: a.method, level: a.power, margin: a.margin,
                bracket: a.power_bracket, unknown_cards: a.unknown_cards.len() })
        }).collect::<Vec<_>>()
    }).await.map_err(anyhow::Error::from)?;
    for (p, score) in rows.iter_mut().zip(scores) { p.power = score; }
    Ok(())
}

pub(super) fn cell(p: &Precon) -> String {
    match &p.power {
        Some(a) => format!("<strong>{:.1}/10</strong><small>±{:.1} / Estimated bracket {}</small>{}", a.level, a.margin, a.bracket,
            if a.unknown_cards > 0 { format!("<small>{} unknown cards</small>", a.unknown_cards) } else { String::new() }),
        None => "<span class=\"dim\">Not assessed</span>".into(),
    }
}

fn ranks(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|x| {
        xs.iter().filter(|y| *y < x).count() as f64 + (xs.iter().filter(|y| *y == x).count() as f64 - 1.0) / 2.0
    }).collect()
}
fn correlation(points: &[(f64, f64)]) -> Option<f64> {
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
    let mut out = String::from("<section class=\"public-panel\"><h2>Power and win rates</h2><details><summary>About this comparison</summary><p>Computed power reads card text using Yama’s deck-analysis method. It is not a game simulation. The estimated bracket is the score’s usual range, not an official assignment or a full bracket legality check. No stock-list combo check is available, so uncertainty is wider. These estimates do not change the rankings.</p><p>Each chart uses the full catalog, with complete card data and at least 20 games per source. Spearman ρ compares ordering, with ties averaged; it is descriptive, not held-out validation. Stock precons already helped calibrate the power scale. Different fields and engine limitations can explain disagreement.</p></details><div class=\"power-charts\">");
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
