//! Local, owner-scoped deck work. Descriptive statistics and simplified models are labeled;
//! neither an EDHREC ranking nor a pip count is treated as a castability or power verdict.

use super::super::tools::{card_info, deck_id};
use super::super::args as arg;
use crate::auth::User;
use crate::cards::Card;
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub struct List {
    pub cards: Vec<DeckCard>,
    pub unknown: Vec<String>,
    pub deck_id: Option<String>,
    pub version: Option<String>,
}

pub async fn load(st: &AppState, user: &User, args: &Value) -> AppResult<List> {
    match (
        arg::opt_text(args, "deck", 200)?,
        arg::opt_text(args, "list", 30000)?,
    ) {
        (Some(wanted), None) => {
            let id = deck_id(&st.pool, &user.id, wanted).await?;
            let version: Option<String> = sqlx::query_scalar(
                "SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?",
            )
            .bind(&id)
            .bind(&user.id)
            .fetch_one(&st.pool)
            .await?;
            if let Some(v) = arg::opt_text(args, "version", 100)? {
                let found: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM deck_versions WHERE id = ? AND deck_id = ?)",
                )
                .bind(v)
                .bind(&id)
                .fetch_one(&st.pool)
                .await?;
                if !found {
                    return Err(AppError::NotFound("version"));
                }
                return Ok(List {
                    cards: crate::decks::load_version_cards(&st.pool, v).await?,
                    unknown: vec![],
                    deck_id: Some(id),
                    version: Some(v.into()),
                });
            }
            let cards = if let Some(v) = &version {
                crate::decks::load_version_cards(&st.pool, v).await?
            } else {
                vec![]
            };
            Ok(List {
                cards,
                unknown: vec![],
                deck_id: Some(id),
                version,
            })
        }
        (None, Some(list)) => {
            if args.get("version").is_some() {
                return Err(AppError::bad("version needs a saved deck"));
            }
            if list.lines().count() > 300 {
                return Err(AppError::bad("A list may contain at most 300 lines."));
            }
            let first = arg::flag(args, "first_is_commander", true)?;
            let parsed = crate::decks::parse_list(list, first);
            if parsed.iter().any(|c| c.qty < 1 || c.qty > 250)
                || parsed.iter().map(|c| c.qty).sum::<i64>() > 250
            {
                return Err(AppError::bad(
                    "A research list may contain at most 250 copies, with positive quantities.",
                ));
            }
            let parsed = crate::decks::resolve(&st.pool, parsed).await?;
            Ok(List {
                cards: parsed.cards,
                unknown: parsed.unknown,
                deck_id: None,
                version: None,
            })
        }
        _ => Err(AppError::bad(
            "Give either deck (your saved deck) or list (a pasted list), exactly one.",
        )),
    }
}

pub fn exported(cards: &[DeckCard]) -> String {
    let mut lines = Vec::new();
    for (board, heading) in [
        (Board::Commander, "Commander"),
        (Board::Main, "Deck"),
        (Board::Side, "Sideboard"),
    ] {
        let entries: Vec<_> = cards.iter().filter(|c| c.board == board).collect();
        if entries.is_empty() {
            continue;
        }
        lines.push(heading.into());
        lines.extend(entries.into_iter().map(|c| format!("{} {}", c.qty, c.name)));
        lines.push(String::new());
    }
    lines.join("\n")
}

pub async fn analyze(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let list = load(st, user, args).await?;
    let info = card_info(&st.pool, &list.cards).await?;
    let items = crate::collection::items_for_owner(&st.pool, &user.id).await?;
    let mut rows = Vec::new();
    let stats = crate::deck_stats::stats(&st.pool, &list.cards, &info).await?;
    let mut roles = BTreeMap::<&str, Vec<String>>::new();
    let (mut priced, mut missing, mut needed_priced, mut needed_missing) = (0, 0, 0, 0);
    let (mut total, mut needed_total) = (0.0, 0.0);
    let mut dates = BTreeSet::new();
    let mut real_remaining = HashMap::<String, i64>::new();
    let mut proxy_remaining = HashMap::<String, i64>::new();
    for i in &items {
        if let Some(id) = &i.oracle_id {
            let target = if i.proxy {
                &mut proxy_remaining
            } else {
                &mut real_remaining
            };
            *target.entry(id.clone()).or_default() += i.qty;
        }
    }
    for c in list.cards.iter().filter(|c| c.board != Board::Side) {
        let Some(card) = info.get(&c.oracle_id) else {
            missing += c.qty;
            needed_missing += c.qty;
            continue;
        };
        for role in inferred_roles(card) {
            roles.entry(role).or_default().push(card.name.clone());
        }
        let real = real_remaining.entry(c.oracle_id.clone()).or_default();
        let owned = c.qty.min(*real);
        *real -= owned;
        let proxy = proxy_remaining.entry(c.oracle_id.clone()).or_default();
        let proxies = (c.qty - owned).min(*proxy);
        *proxy -= proxies;
        let needed = c.qty - owned - proxies;
        let (usd, date, printing) = cheapest(st, &c.oracle_id).await?;
        if let Some(usd) = usd {
            priced += c.qty;
            total += usd * c.qty as f64;
            needed_priced += needed;
            needed_total += usd * needed as f64;
            if let Some(date) = &date {
                dates.insert(date.clone());
            }
        } else {
            missing += c.qty;
            needed_missing += needed;
        }
        rows.push(json!({"name": c.name, "quantity": c.qty, "board": c.board, "owned_real": owned, "covered_by_proxies": proxies,
            "needed": needed, "cheapest_nonfoil_usd": usd, "price_date": date, "printing": printing}));
    }
    let total_cards: i64 = list
        .cards
        .iter()
        .filter(|c| c.board != Board::Side)
        .map(|c| c.qty)
        .sum();
    let budget = args
        .get("budget_usd")
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or_else(|| AppError::bad("budget_usd must be a nonnegative number"))
        })
        .transpose()?;
    let mut policy = json!({"declared_bracket": null, "note": "Game Changers and combo flags do not determine a bracket. Intent, speed, consistency and pregame agreement still matter."});
    if let Some(id) = &list.deck_id {
        policy["declared_bracket"] = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT bracket FROM decks WHERE id = ? AND owner_id = ?",
        )
        .bind(id)
        .bind(&user.id)
        .fetch_one(&st.pool)
        .await?
        .into();
    }
    // The deck page's analysis, with combos from a saved version's stored bracket check;
    // reading never starts a check.
    let reserved_list = crate::decks::reserved_list(&list.cards, &info);
    let check = match &list.version {
        Some(v) => crate::deck_checks::view(&st.pool, Some(v), false).await?.result,
        None => None,
    };
    let produced = crate::decks::produced_mana(&st.pool, &list.cards.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = crate::analysis::facts_for(&list.cards, &info, &produced);
    let entries: Vec<crate::analysis::Entry> = list.cards.iter().map(|c| crate::analysis::Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
    let mut power = list.cards.iter().any(|c| c.qty > 0).then(|| crate::analysis::analyze(&entries, check.as_ref(), &mut crate::analysis::Cache::default()));
    // A pasted name that matched no card is a card the analysis couldn't score.
    if let Some(a) = power.as_mut() {
        crate::analysis::add_unresolved(a, &list.unknown);
    }
    let commander_record = crate::public_commanders::record_for(&st.pool, &list.cards).await;
    Ok(
        json!({"computed_at": crate::util::now(), "deck_id": list.deck_id, "version": list.version,
        "validation": crate::decks::validate(&list.cards,&info), "unknown_names": list.unknown,
        "game_changers": crate::decks::game_changers(&list.cards,&info),
        "reserved_list": reserved_list, "policy": policy,
        "commander_record": commander_record,
        "commander_record_note": "The commander's record over every list recorded under it on the public sources Yama reads (/commanders): share of games won, stock and tuned lists and all pod sizes together, so compare it with `typical` (the middle placed commander), not 25%. `place` ranks it among the `placed` commanders with `min_games` or more games. It describes the commander, not this list, and isn't part of the power level.",
        "analysis": power, "analysis_note": "Yama's unofficial deck analysis, as the deck page and shared deck page show it: each card earns points for what its text does in categories under five vectors (Speed, Consistency, Interaction, Mana base, Threats; 0-100, about 40 a typical stock precon and 75 a typical Bracket 4 build), Commander Spellbook's combos from the stored check add to Threats (a saved version only; combos.checked says whether there was one), and the weighted vectors map to the older 1-10 power-level scale with a ± margin and caps. The margin starts at a measured ±0.7; `confidence` says how complete the inputs were (high: every card read with a combo check), not how right the score is. `bracket` holds two readings kept apart: `plays_like` [low, high], the brackets power ± margin reaches, and `rules`, the least bracket Wizards' card rules allow (Game Changers, and what the Spellbook check flags, listed in `flags`; null when it can't be read). A list can be Bracket 3 by the rules and still play like Bracket 2. Card-text signals, not played performance; other sites' numbers aren't directly comparable.",
        "statistics": {"cards": total_cards,"lands": stats.lands,"nonlands": stats.nonlands,"curve_0_through_7_plus": stats.curve.map(|(c, o)| c + o),
            "average_mana_value": stats.average_mana_value().map(round),
            "average_nonland_mana_value": stats.average_nonland_mana_value().map(round), "colored_pips": stats.pips,
            "potential_land_access": stats.sources.as_ref().map_or(Value::Null, |s| json!(s)), "lands_without_mana_data": stats.lands_without_mana_data,
            "mana_note": "Pips count hybrid colors separately. Land access includes land faces and fetch targets; these are descriptive counts, not a castability verdict."},
        "inferred_roles": roles, "role_note": "Text-based hints may overlap or miss conditional effects. Review Oracle text; absence here is not proof of a role gap.",
        "market": {"source": "Scryfall / TCGplayer market", "known_subtotal_usd": (priced>0).then(|| round(total)), "priced_copies":priced,
            "missing_copies":missing,"cost_to_finish_known_usd": (needed_priced>0).then(|| round(needed_total)),"needed_without_price":needed_missing,
            "oldest_price_date":dates.first(),"newest_price_date":dates.last(),"budget_usd":budget,
            "budget_status": budget.map(|b| if total > b {"over_budget"} else if missing > 0 || !list.unknown.is_empty() {"unknown_missing_prices"} else {"within_budget"}),
            "note":"Nonfoil paper market references, including basics. Ownership across the collection is not proof that copies are free to move. Missing prices stay unknown; no store stock or quote is implied."},
        "cards": rows, "list": exported(&list.cards)}),
    )
}

fn inferred_roles(card: &Card) -> Vec<&'static str> {
    let text = card.oracle_text.to_lowercase();
    let mut out = Vec::new();
    if text.contains("draw") && (text.contains("card") || text.contains("cards")) {
        out.push("card_draw");
    }
    if !card.type_line.contains("Land")
        && (text.contains("add {")
            || (text.contains("search your library")
                && text.contains("land card")
                && text.contains("battlefield")))
    {
        out.push("ramp");
    }
    if text.contains("destroy target")
        || text.contains("exile target")
        || text.contains("counter target spell")
    {
        out.push("interaction");
    }
    if text.contains("destroy all")
        || text.contains("exile all")
        || text.contains("each creature") && text.contains("damage")
    {
        out.push("sweeper");
    }
    if text.contains("your graveyard") && (text.contains("return") || text.contains("cast")) {
        out.push("recursion");
    }
    out
}

pub async fn cheapest(
    st: &AppState,
    id: &str,
) -> AppResult<(Option<f64>, Option<String>, Option<String>)> {
    Ok(sqlx::query_as("WITH eligible AS MATERIALIZED (
        SELECT ps.usd, ps.date, p.scryfall_id FROM printings p JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
        WHERE p.oracle_id = ? AND p.finishes LIKE '%nonfoil%' AND IFNULL(p.digital,0) = 0
        AND p.set_code NOT IN ('wc97','wc98','wc99','wc00','wc01','wc02','wc03','wc04','ptc','ced','cei','30a','olgc','ovnt')
        AND p.set_name NOT LIKE '%Oversized%' AND p.set_name NOT LIKE '%Display Commanders%')
        SELECT usd,date,scryfall_id FROM eligible WHERE usd IS NOT NULL
        AND date >= date((SELECT MAX(date) FROM eligible), '-3 days')
        ORDER BY usd, date DESC, scryfall_id LIMIT 1").bind(id).fetch_optional(&st.pool).await?.unwrap_or((None,None,None)))
}

pub async fn history(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let id = deck_id(&st.pool, &user.id, arg::text_max(args, "deck", 200)?).await?;
    let rows: Vec<(String,Option<String>,String)> = sqlx::query_as("SELECT id,note,created_at FROM deck_versions WHERE deck_id = ? ORDER BY rowid DESC LIMIT 100").bind(&id).fetch_all(&st.pool).await?;
    Ok(
        json!({"deck_id":id,"versions":rows.into_iter().map(|(id,note,at)|json!({"id":id,"note":note,"created_at":at})).collect::<Vec<_>>(),
        "note":"Use get_deck_analysis with deck and version to inspect or export a historical list. save_deck stages restoring that list as a new version."}),
    )
}

pub async fn compare(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let left = args
        .get("left")
        .ok_or_else(|| AppError::bad("left is missing"))?;
    let right = args
        .get("right")
        .ok_or_else(|| AppError::bad("right is missing"))?;
    let a = load(st, user, left).await?;
    let b = load(st, user, right).await?;
    let mut differences = BTreeMap::<(String, String), i64>::new();
    for (list, sign) in [(&a.cards, -1), (&b.cards, 1)] {
        for c in list {
            *differences
                .entry((format!("{:?}", c.board), c.name.clone()))
                .or_default() += sign * c.qty;
        }
    }
    Ok(
        json!({"left":analyze(st,user,left).await?,"right":analyze(st,user,right).await?,
        "changes":differences.into_iter().filter(|(_,n)| *n!=0).map(|((board,name),quantity)|json!({"board":board,"name":name,"quantity_change":quantity})).collect::<Vec<_>>(),
        "note":"A structural comparison. An improvement in win rate needs real games or a paired lab experiment; no power score was invented."}),
    )
}

pub struct Random(pub u64);
impl Random {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut x = self.0;
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
        x ^ (x >> 31)
    }
    pub fn shuffle<T>(&mut self, cards: &mut [T]) {
        for i in (1..cards.len()).rev() {
            let bound = (i + 1) as u64;
            let threshold = bound.wrapping_neg() % bound;
            let j = loop {
                let n = self.next();
                if n >= threshold {
                    break (n % bound) as usize;
                }
            };
            cards.swap(i, j);
        }
    }
}

pub async fn hands(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let list = load(st, user, args).await?;
    if !list.unknown.is_empty() {
        return Err(AppError::bad(
            "Resolve unknown card names before sampling hands.",
        ));
    }
    let copies: i64 = list
        .cards
        .iter()
        .filter(|c| c.board == Board::Main)
        .map(|c| c.qty)
        .sum();
    if !(7..=250).contains(&copies) {
        return Err(AppError::bad("The library must contain 7 to 250 cards."));
    }
    let count = arg::int(args, "hands", 5, 1, 10)?;
    let size = arg::int(args, "draw", 7, 1, 20)? as usize;
    let mulligans = arg::int(args, "mulligans", 0, 0, 6)?;
    let seed = arg::int(args, "seed", 1, 0, i64::MAX)? as u64;
    let mut random = Random(seed);
    let library: Vec<_> = list
        .cards
        .iter()
        .filter(|c| c.board == Board::Main)
        .flat_map(|c| std::iter::repeat_n(c.name.clone(), c.qty as usize))
        .collect();
    if size > library.len() {
        return Err(AppError::bad("draw exceeds the library size"));
    }
    let mut hands = Vec::new();
    for _ in 0..count {
        let mut cards = library.clone();
        random.shuffle(&mut cards);
        hands.push(json!({"drawn":&cards[..size],"bottom_after_london_mulligan":mulligans}));
    }
    Ok(
        json!({"seed":seed,"library_size":library.len(),"hands":hands,"note":"Seeded draws without replacement, commanders excluded. Choose which cards to bottom yourself; keep/ship and mana quality are not inferred."}),
    )
}

/// Exact hypergeometric tail; no Monte Carlo error or independent-source assumption.
pub fn probability(population: u64, successes: u64, draws: u64, at_least: u64) -> f64 {
    if at_least == 0 {
        return 1.0;
    }
    if at_least > draws || at_least > successes {
        return 0.0;
    }
    let low = draws.saturating_sub(population - successes);
    let high = draws.min(successes);
    let log_choose = |n: u64, k: u64| -> f64 {
        let k = k.min(n - k);
        (0..k)
            .map(|i| ((n - i) as f64).ln() - ((i + 1) as f64).ln())
            .sum()
    };
    (low.max(at_least)..=high)
        .map(|k| {
            (log_choose(successes, k) + log_choose(population - successes, draws - k)
                - log_choose(population, draws))
            .exp()
        })
        .sum::<f64>()
        .clamp(0.0, 1.0)
}

pub fn mana_probability(args: &Value) -> AppResult<Value> {
    let n = arg::int(args, "library", 99, 1, 250)? as u64;
    let s = arg::int(args, "sources", 0, 0, n as i64)? as u64;
    let draws = arg::int(args, "seen", 7, 0, n as i64)? as u64;
    let need = arg::int(args, "at_least", 1, 0, 250)? as u64;
    Ok(
        json!({"library":n,"sources":s,"cards_seen":draws,"at_least":need,"probability":probability(n,s,draws,need),
        "model":"Exact draws without replacement. Caller supplies qualifying sources. No mulligans, sequencing, tapped lands, activation costs, ramp, or source-color overlap are modeled; this is not the probability of casting a spell."}),
    )
}

fn round(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_stats::colored_pips;
    #[test]
    fn probabilities_match_small_enumerations_and_boundaries() {
        assert!((probability(4, 2, 2, 1) - 5.0 / 6.0).abs() < 1e-12);
        assert_eq!(probability(99, 0, 7, 1), 0.0);
        assert_eq!(probability(99, 99, 7, 7), 1.0);
        assert_eq!(probability(10, 4, 0, 0), 1.0);
        assert_eq!(probability(10, 4, 2, 3), 0.0);
    }
    #[test]
    fn hybrid_pips_and_seeded_draws_are_explicit() {
        assert_eq!(
            colored_pips("{2}{W/U}{W/P}{2/R}"),
            BTreeMap::from([('W', 2), ('U', 1), ('R', 1)])
        );
        let mut a: Vec<_> = (0..99).collect();
        let mut b = a.clone();
        Random(91).shuffle(&mut a);
        Random(91).shuffle(&mut b);
        assert_eq!(a, b);
        a.sort();
        assert_eq!(a, (0..99).collect::<Vec<_>>());
    }
}
