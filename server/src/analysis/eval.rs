//! `yama-server power-eval [--lists DIR] [--json]`: measures the power estimate against what is
//! known without it, so a change to the scoring is judged by numbers before it ships
//! (docs/deck-analysis.md, "Measuring the method"). It reads the card data and the public precon
//! catalog in the database, and optionally a folder of text lists. It calls no outside service
//! and no model, and changes no deck, check or catalog data. Like every server command it
//! first brings the database it is pointed at up to the current schema, so point it at a copy.
//!
//! - Stock precons: how each way of reading a bracket sorts them, and how well power (and plainer
//!   signals) rank them against the stock list's real win rate.
//! - Reference lists (`--lists`): files named `<deck>-<step>-<kind>.txt`. A kind ending
//!   `bracket-N` is a list built for Bracket N. Reported: each rule against those labels, how
//!   often power ± margin reaches the label, and whether the same deck's next bracket up scores
//!   higher.
use super::{Cache, DeckAnalysis, Entry, METHOD, add_unresolved, analyze, facts_for};
use crate::decks::{Board, DeckCard};
use anyhow::{Context, anyhow};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::fmt::Write;

/// One list to score, with what is known about it from outside the score.
#[derive(Default)]
struct Input {
    name: String,
    deck: Option<String>,
    step: Option<u32>,
    kind: String,
    label: Option<i64>,
    cards: Vec<DeckCard>,
    unresolved: Vec<String>,
    /// A stored Commander Spellbook answer for exactly this list.
    check: Option<crate::deck_checks::CheckResult>,
    real_rate: Option<f64>,
    real_games: u64,
    commander_rate: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Row {
    pub name: String,
    /// The deck a reference list is a build of, and its place in that deck's ladder.
    pub deck: Option<String>,
    pub step: Option<u32>,
    /// "precon" for the catalog, else the file name's kind ("stock", "proposed-bracket-3").
    pub kind: String,
    /// The bracket the list was built for, when its name says.
    pub label: Option<i64>,
    pub power: f64,
    pub margin: f64,
    /// `power_bracket`: the band the power number falls in.
    pub band: i64,
    /// `None` when the card data has no Game Changer flags yet.
    pub game_changers: Option<Vec<String>>,
    pub unscored_share: f64,
    pub unknown_cards: usize,
    /// Whether a stored Commander Spellbook answer was read, so combos counted.
    pub combo_check: bool,
    pub vectors: Vec<(&'static str, f64)>,
    /// The stock list's real win rate (percent) and games; precons only.
    pub real_rate: Option<f64>,
    pub real_games: u64,
    /// Every list under the commander (percent); precons only.
    pub commander_rate: Option<f64>,
}

/// The least bracket Wizards' Game Changer rule allows: none in Bracket 2, up to three in 3.
pub fn floor(game_changers: usize) -> i64 {
    match game_changers {
        0 => 2,
        1..=3 => 3,
        _ => 4,
    }
}

/// The band a power number falls in, as `analyze` cuts it.
fn band_of(power: f64) -> i64 {
    if power <= 5.0 {
        2
    } else if power <= 7.0 {
        3
    } else {
        4
    }
}

/// The ways of reading one bracket from a list that the report compares.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Rule {
    Band,
    Floor,
    Higher,
    Lower,
}

impl Rule {
    const ALL: [Rule; 4] = [Rule::Band, Rule::Floor, Rule::Higher, Rule::Lower];
    fn label(self) -> &'static str {
        match self {
            Rule::Band => "power band",
            Rule::Floor => "Game Changer rule",
            Rule::Higher => "higher of the two",
            Rule::Lower => "lower of the two",
        }
    }
    /// `None` when the rule needs Game Changer flags the card data lacks.
    fn read(self, r: &Row) -> Option<i64> {
        let rule = r.game_changers.as_ref().map(|g| floor(g.len()));
        match self {
            Rule::Band => Some(r.band),
            Rule::Floor => rule,
            Rule::Higher => rule.map(|f| f.max(r.band)),
            Rule::Lower => rule.map(|f| f.min(r.band)),
        }
    }
}

/// `ahoy-mateys-5-proposed-bracket-3` is deck "ahoy-mateys", step 5, kind "proposed-bracket-3",
/// built for Bracket 3. A name without a `-<number>-` part is a list on its own.
fn parse_name(stem: &str) -> (Option<String>, Option<u32>, String, Option<i64>) {
    let parts: Vec<&str> = stem.split('-').collect();
    let at = (1..parts.len().saturating_sub(1)).find(|i| !parts[*i].is_empty() && parts[*i].bytes().all(|b| b.is_ascii_digit()));
    let (deck, step, kind) = match at {
        Some(i) => (Some(parts[..i].join("-")), parts[i].parse().ok(), parts[i + 1..].join("-")),
        None => (None, None, stem.to_string()),
    };
    let label = kind.rsplit_once("bracket-").and_then(|(_, n)| n.parse::<i64>().ok()).filter(|n| (1..=5).contains(n));
    (deck, step, kind, label)
}

async fn score(pool: &SqlitePool, inputs: Vec<Input>) -> anyhow::Result<Vec<Row>> {
    let all: Vec<DeckCard> = inputs.iter().flat_map(|i| i.cards.iter().cloned()).collect();
    let info = crate::decks::card_info(pool, &all).await.map_err(|e| anyhow!("{e}"))?;
    let ids: Vec<&str> = all.iter().map(|c| c.oracle_id.as_str()).collect();
    let produced = crate::decks::produced_mana(pool, &ids).await.map_err(|e| anyhow!("{e}"))?;
    let facts = facts_for(&all, &info, &produced);
    let mut cache = Cache::default();
    cache.skip_themes = true;
    Ok(inputs
        .into_iter()
        .map(|i| {
            let entries: Vec<Entry> = i.cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
            let mut a: DeckAnalysis = analyze(&entries, i.check.as_ref(), &mut cache);
            add_unresolved(&mut a, &i.unresolved);
            Row {
                game_changers: crate::decks::game_changers(&i.cards, &info),
                name: i.name,
                deck: i.deck,
                step: i.step,
                kind: i.kind,
                label: i.label,
                power: a.power,
                margin: a.margin,
                band: a.power_bracket,
                unscored_share: if a.nonland > 0 { a.unscored as f64 / a.nonland as f64 } else { 0.0 },
                unknown_cards: a.unknown_cards.len(),
                combo_check: a.combos.checked,
                vectors: a.vectors.iter().map(|v| (v.label, v.score)).collect(),
                real_rate: i.real_rate,
                real_games: i.real_games,
                commander_rate: i.commander_rate,
            }
        })
        .collect())
}

async fn precon_rows(pool: &SqlitePool) -> anyhow::Result<Vec<Row>> {
    let catalog = crate::public_precons::catalog(pool).await.map_err(|e| anyhow!("{e}"))?;
    let mut inputs = Vec::new();
    for p in &catalog.precons {
        let cards = p.stock_list()?;
        if cards.iter().all(|c| c.oracle_id.is_empty() || c.board == Board::Side) {
            continue;
        }
        let real = p.stock_real();
        // No combo check: none is stored for a stock list yet, as on the public pages.
        inputs.push(Input {
            name: p.name.clone(),
            kind: "precon".into(),
            real_rate: real.as_ref().map(|r| r.rate),
            real_games: real.as_ref().map_or(0, |r| r.games),
            commander_rate: p.commander_rate(),
            cards,
            ..Input::default()
        });
    }
    score(pool, inputs).await
}

async fn list_rows(pool: &SqlitePool, dir: &std::path::Path) -> anyhow::Result<Vec<Row>> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("cannot read {}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "txt"))
        .collect();
    paths.sort();
    let mut inputs = Vec::new();
    for path in paths {
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let text = std::fs::read_to_string(&path)?;
        let file_name = path.file_name().map(|f| f.to_string_lossy().to_string());
        let Some(list) = crate::deck_import::read_list(pool, &text, file_name.as_deref()).await.map_err(|e| anyhow!("{e}"))?.into_iter().next() else {
            continue;
        };
        if list.cards.is_empty() {
            continue;
        }
        let (deck, step, kind, label) = parse_name(&stem);
        // A reference list is a file, not a saved deck, but the same list saved as a deck has
        // an answer that depends only on its cards. Nothing is asked of Spellbook here.
        let check = crate::deck_checks::stored_for_list(pool, &list.cards).await?;
        inputs.push(Input { name: stem, deck, step, kind, label, cards: list.cards, unresolved: list.unknown, check, ..Input::default() });
    }
    score(pool, inputs).await
}

/// Spearman's rank correlation with a 95% interval from 2,000 resamples of the decks. The
/// resampling is seeded and the decks are put in a fixed order first, so the same data prints
/// the same interval whatever order it was read in.
fn spearman(points: &[(f64, f64)]) -> Option<(f64, f64, f64)> {
    let mut points = points.to_vec();
    points.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let points = &points[..];
    let rho = crate::public_precons::correlation(points)?;
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % points.len() as u64) as usize
    };
    let mut rs: Vec<f64> = (0..2000)
        .filter_map(|_| {
            let sample: Vec<(f64, f64)> = (0..points.len()).map(|_| points[next()]).collect();
            crate::public_precons::correlation(&sample)
        })
        .collect();
    if rs.is_empty() {
        return None;
    }
    rs.sort_by(f64::total_cmp);
    let at = |q: f64| rs[((rs.len() - 1) as f64 * q).round() as usize];
    Some((rho, at(0.025), at(0.975)))
}

fn rho_cell(points: &[(f64, f64)]) -> String {
    match spearman(points) {
        Some((r, lo, hi)) => format!("{r:+.2} ({lo:+.2} to {hi:+.2}, {} decks)", points.len()),
        None => format!("not estimable ({} decks)", points.len()),
    }
}

fn median(xs: &mut [f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(f64::total_cmp);
    let m = xs.len() / 2;
    Some(if xs.len() % 2 == 1 { xs[m] } else { (xs[m - 1] + xs[m]) / 2.0 })
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// Whether power ± `margin` reaches the label's band. The band never says 1 or 5, so those
/// labels count as the nearest band it can say.
fn holds(r: &Row, label: i64, margin: f64) -> bool {
    let l = label.clamp(2, 4);
    band_of(r.power - margin) <= l && l <= band_of(r.power + margin)
}

/// Pairs of builds of one deck where the first was built for a lower bracket than the second:
/// keyed by the two labels, the second's power less the first's.
fn ladder_gaps(rows: &[Row]) -> BTreeMap<(i64, i64), Vec<f64>> {
    let mut out: BTreeMap<(i64, i64), Vec<f64>> = BTreeMap::new();
    for a in rows {
        for b in rows {
            if let (Some(da), Some(db), Some(la), Some(lb)) = (&a.deck, &b.deck, a.label, b.label)
                && da == db
                && la < lb
            {
                out.entry((la, lb)).or_default().push(b.power - a.power);
            }
        }
    }
    out
}

/// Each build's power less its own deck's stock list's.
fn stock_gaps(rows: &[Row]) -> Vec<f64> {
    let mut out = Vec::new();
    for s in rows.iter().filter(|r| r.kind == "stock" && r.deck.is_some()) {
        out.extend(rows.iter().filter(|r| r.deck == s.deck && r.kind != "stock").map(|r| r.power - s.power));
    }
    out
}

fn counts(rows: &[Row], rule: Rule) -> Option<[usize; 3]> {
    let mut n = [0; 3];
    for r in rows {
        n[(rule.read(r)?.clamp(2, 4) - 2) as usize] += 1;
    }
    Some(n)
}

fn gap_line(out: &mut String, name: &str, gaps: &[f64]) {
    let higher = gaps.iter().filter(|g| **g > 0.0).count();
    let mid = median(&mut gaps.to_vec()).unwrap_or(0.0);
    writeln!(out, "  {name:<22} {higher} of {} score higher, median gap {mid:+.1}", gaps.len()).unwrap();
}

pub fn report(precons: &[Row], lists: &[Row]) -> String {
    let mut out = format!("Power estimate check, method {METHOD}\n");

    writeln!(out, "\nStock precons: {} scored, {} with a stored combo check", precons.len(), precons.iter().filter(|r| r.combo_check).count()).unwrap();
    let mut powers: Vec<f64> = precons.iter().map(|r| r.power).collect();
    powers.sort_by(f64::total_cmp);
    if !powers.is_empty() {
        writeln!(out, "  power median {:.1}, 10th to 90th {:.1} to {:.1}, range {:.1} to {:.1}", median(&mut powers.clone()).unwrap_or(0.0), quantile(&powers, 0.1), quantile(&powers, 0.9), powers[0], powers[powers.len() - 1]).unwrap();
    }
    writeln!(out, "  {:<22} {:>9} {:>9} {:>9}", "bracket read by", "Bracket 2", "Bracket 3", "Bracket 4").unwrap();
    for rule in Rule::ALL {
        match counts(precons, rule) {
            Some(n) => writeln!(out, "  {:<22} {:>9} {:>9} {:>9}", rule.label(), n[0], n[1], n[2]).unwrap(),
            None => writeln!(out, "  {:<22} needs Game Changer flags the card data lacks", rule.label()).unwrap(),
        }
    }

    writeln!(out, "\nStock precons against real games (rank correlation with the stock list's win rate, 95% interval)").unwrap();
    for min in [40, 100, 200] {
        let rated: Vec<&Row> = precons.iter().filter(|r| r.real_games >= min && r.real_rate.is_some()).collect();
        let pairs = |f: &dyn Fn(&Row) -> Option<f64>| -> Vec<(f64, f64)> { rated.iter().filter_map(|r| Some((f(r)?, r.real_rate?))).collect() };
        writeln!(out, "  {min}+ games").unwrap();
        writeln!(out, "    {:<18} {}", "power", rho_cell(&pairs(&|r| Some(r.power)))).unwrap();
        writeln!(out, "    {:<18} {}", "Game Changers", rho_cell(&pairs(&|r| r.game_changers.as_ref().map(|g| g.len() as f64)))).unwrap();
        writeln!(out, "    {:<18} {}", "commander's record", rho_cell(&pairs(&|r| r.commander_rate))).unwrap();
        if min == 40 {
            for (i, (label, _)) in rated.first().map(|r| r.vectors.clone()).unwrap_or_default().iter().enumerate() {
                writeln!(out, "    {:<18} {}", label, rho_cell(&pairs(&|r| r.vectors.get(i).map(|v| v.1)))).unwrap();
            }
            for (name, with) in [("with a Game Changer", true), ("without one", false)] {
                let group: Vec<&&Row> = rated.iter().filter(|r| r.game_changers.as_ref().is_some_and(|g| g.is_empty() != with)).collect();
                let games: u64 = group.iter().map(|r| r.real_games).sum();
                if games > 0 {
                    let rate = group.iter().map(|r| r.real_rate.unwrap_or(0.0) * r.real_games as f64).sum::<f64>() / games as f64;
                    writeln!(out, "    {name:<20} {} decks, {rate:.1}% over {games} games", group.len()).unwrap();
                }
            }
        }
    }

    if lists.is_empty() {
        writeln!(out, "\nNo reference lists (pass --lists DIR).").unwrap();
        return out;
    }
    let labelled: Vec<&Row> = lists.iter().filter(|r| r.label.is_some()).collect();
    writeln!(out, "\nReference lists: {} scored, {} built for a named bracket, {} with a stored combo check", lists.len(), labelled.len(), lists.iter().filter(|r| r.combo_check).count()).unwrap();
    let mut by_label: BTreeMap<i64, Vec<&Row>> = BTreeMap::new();
    for r in &labelled {
        by_label.entry(r.label.unwrap_or(0)).or_default().push(r);
    }
    writeln!(out, "  {:<22} {:>5} {:>13} {:>14} {:>15}", "built for", "lists", "power median", "10th to 90th", "Game Changers").unwrap();
    for (label, rows) in &by_label {
        let mut p: Vec<f64> = rows.iter().map(|r| r.power).collect();
        p.sort_by(f64::total_cmp);
        let gc: Vec<usize> = rows.iter().filter_map(|r| r.game_changers.as_ref().map(Vec::len)).collect();
        let gcs = match (gc.iter().min(), gc.iter().max()) {
            (Some(a), Some(b)) if a == b => a.to_string(),
            (Some(a), Some(b)) => format!("{a} to {b}"),
            _ => "unknown".into(),
        };
        writeln!(out, "  {:<22} {:>5} {:>13.1} {:>14} {:>15}", format!("Bracket {label}"), rows.len(), median(&mut p.clone()).unwrap_or(0.0), format!("{:.1} to {:.1}", quantile(&p, 0.1), quantile(&p, 0.9)), gcs).unwrap();
    }

    if !labelled.is_empty() {
        writeln!(out, "\n  {:<22} {:>7} {:>11}", "bracket read by", "exact", "within one").unwrap();
        for rule in Rule::ALL {
            let read: Vec<(i64, i64)> = labelled.iter().filter_map(|r| Some((rule.read(r)?, r.label?))).collect();
            if read.len() < labelled.len() {
                writeln!(out, "  {:<22} needs Game Changer flags the card data lacks", rule.label()).unwrap();
                continue;
            }
            let exact = read.iter().filter(|(a, b)| a == b).count();
            let near = read.iter().filter(|(a, b)| (a - b).abs() <= 1).count();
            writeln!(out, "  {:<22} {:>6.0}% {:>10.0}%", rule.label(), 100.0 * exact as f64 / read.len() as f64, 100.0 * near as f64 / read.len() as f64).unwrap();
        }
        writeln!(out, "  The Game Changer rule agrees with labels that were themselves set by counting Game Changers.").unwrap();

        writeln!(out, "\n  Power ± margin reaches the bracket the list was built for").unwrap();
        let share = |m: &dyn Fn(&Row) -> f64| 100.0 * labelled.iter().filter(|r| holds(r, r.label.unwrap_or(0), m(r))).count() as f64 / labelled.len() as f64;
        let mut margins: Vec<f64> = labelled.iter().map(|r| r.margin).collect();
        writeln!(out, "    {:<22} {:>4.0}%", format!("today's (median ±{:.1})", median(&mut margins).unwrap_or(0.0)), share(&|r| r.margin)).unwrap();
        for m in [0.5, 0.7, 1.0, 1.5] {
            writeln!(out, "    {:<22} {:>4.0}%", format!("±{m:.1}"), share(&|_| m)).unwrap();
        }
    }

    writeln!(out, "\n  The same deck, built for a higher bracket").unwrap();
    for ((a, b), gaps) in ladder_gaps(lists) {
        gap_line(&mut out, &format!("Bracket {a} to {b}"), &gaps);
    }
    let stock = stock_gaps(lists);
    if !stock.is_empty() {
        gap_line(&mut out, "stock to any build", &stock);
    }
    out
}

pub async fn cli(pool: &SqlitePool, args: &[String]) -> anyhow::Result<()> {
    let dir = args.iter().position(|a| a == "--lists").map(|i| args.get(i + 1).context("--lists takes a folder")).transpose()?;
    let precons = precon_rows(pool).await?;
    let lists = match dir {
        Some(d) => list_rows(pool, std::path::Path::new(d)).await?,
        None => vec![],
    };
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string(&serde_json::json!({ "method": METHOD, "precons": precons, "lists": lists }))?);
    } else {
        print!("{}", report(&precons, &lists));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(deck: &str, kind: &str, label: Option<i64>, power: f64, game_changers: usize) -> Row {
        Row {
            name: format!("{deck}-{kind}"),
            deck: Some(deck.into()),
            kind: kind.into(),
            label,
            power,
            margin: 0.5,
            band: band_of(power),
            game_changers: Some(vec!["x".to_string(); game_changers]),
            ..Row::default()
        }
    }

    #[test]
    fn file_names_give_the_deck_the_step_and_the_bracket() {
        assert_eq!(parse_name("ahoy-mateys-5-proposed-bracket-3"), (Some("ahoy-mateys".into()), Some(5), "proposed-bracket-3".into(), Some(3)));
        assert_eq!(parse_name("scions-&-spellcraft-1-stock"), (Some("scions-&-spellcraft".into()), Some(1), "stock".into(), None));
        assert_eq!(parse_name("multiverse-reforged-3-proposed-bracket-3").3, Some(3));
        assert_eq!(parse_name("some-list"), (None, None, "some-list".into(), None));
        // A trailing number is part of the name, not a step, and 9 is not a bracket.
        assert_eq!(parse_name("deck-7"), (None, None, "deck-7".into(), None));
        assert_eq!(parse_name("deck-1-bracket-9").3, None);
    }

    #[test]
    fn rules_read_the_band_the_game_changer_count_or_both() {
        assert_eq!([floor(0), floor(1), floor(3), floor(4)], [2, 3, 3, 4]);
        // A weak list holding one Game Changer: the rule says 3, the band 2.
        let weak = row("a", "stock", None, 3.8, 1);
        assert_eq!(Rule::ALL.map(|r| r.read(&weak)), [Some(2), Some(3), Some(3), Some(2)]);
        // A tuned list with none: the band says 4, the rule 2.
        let tuned = row("a", "x", None, 7.4, 0);
        assert_eq!(Rule::ALL.map(|r| r.read(&tuned)), [Some(4), Some(2), Some(4), Some(2)]);
        // Without flags only the band can be read.
        let blind = Row { game_changers: None, ..weak.clone() };
        assert_eq!(Rule::ALL.map(|r| r.read(&blind)), [Some(2), None, None, None]);
        assert_eq!(counts(&[weak, tuned], Rule::Higher), Some([0, 1, 1]));
    }

    #[test]
    fn the_margin_reaches_a_label_only_when_it_crosses_into_its_band() {
        let r = row("a", "x", Some(3), 4.6, 0);
        assert!(!holds(&r, 3, 0.3));
        assert!(holds(&r, 3, 0.5));
        assert!(holds(&r, 2, 0.0));
        // Bracket 5 counts as the top band; Bracket 1 as the bottom one.
        assert!(holds(&row("a", "x", Some(5), 8.0, 0), 5, 0.0));
        assert!(holds(&r, 1, 0.0));
    }

    #[test]
    fn ladders_compare_builds_of_one_deck_only() {
        let rows = [
            row("a", "stock", None, 3.0, 0),
            row("a", "bracket-2", Some(2), 4.5, 0),
            row("a", "bracket-3", Some(3), 5.0, 3),
            row("a", "bracket-4", Some(4), 7.5, 9),
            row("b", "bracket-3", Some(3), 4.0, 3),
        ];
        let gaps = ladder_gaps(&rows);
        assert_eq!(gaps.keys().copied().collect::<Vec<_>>(), [(2, 3), (2, 4), (3, 4)]);
        assert_eq!(gaps[&(2, 3)], [0.5]);
        assert_eq!(stock_gaps(&rows), [1.5, 2.0, 4.5]);
        let text = report(&[], &rows);
        assert!(text.contains("1 of 1 score higher, median gap +0.5"), "{text}");
        assert!(text.contains("Game Changer rule"), "{text}");
        // An even group's median is the mean of its middle pair: Bracket 3 here is 4.0 and 5.0.
        assert!(text.contains(&format!("{:<22} {:>5} {:>13.1}", "Bracket 3", 2, 4.5)), "{text}");
    }

    #[test]
    fn rank_correlation_comes_with_a_repeatable_interval() {
        let points: Vec<(f64, f64)> = (0..30).map(|i| (i as f64, ((i * 7) % 11) as f64 + i as f64 / 3.0)).collect();
        let (rho, lo, hi) = spearman(&points).unwrap();
        assert!(lo <= rho && rho <= hi, "{lo} {rho} {hi}");
        assert_eq!(spearman(&points), Some((rho, lo, hi)));
        let mut shuffled = points.clone();
        shuffled.reverse();
        shuffled.swap(3, 17);
        assert_eq!(spearman(&shuffled), Some((rho, lo, hi)));
        assert_eq!(spearman(&[(1.0, 1.0); 5]), None);
    }
}
