//! A small, explicit lands-only sequencing model. Unknown or conditional sources stay visible;
//! this is not the Phase engine, a gameplay simulator, or an actual spell-cast probability.

use super::super::args as arg;
use super::analysis;
use crate::auth::User;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone)]
struct Land {
    colors: Vec<char>,
    tapped: bool,
}

fn cost(text: &str) -> AppResult<(usize, Vec<char>)> {
    let mut generic = 0usize;
    let mut colored = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let Some(body) = rest.strip_prefix('{') else {
            return Err(AppError::bad("Use a mana cost such as {2}{W}{W}."));
        };
        let Some((symbol, tail)) = body.split_once('}') else {
            return Err(AppError::bad("Unclosed mana symbol."));
        };
        if let Ok(n) = symbol.parse::<usize>() {
            generic = generic
                .checked_add(n)
                .filter(|n| *n <= 100)
                .ok_or_else(|| AppError::bad("Generic mana cost exceeds 100."))?;
        } else if symbol.len() == 1 && "WUBRGC".contains(symbol) {
            colored.push(symbol.chars().next().unwrap());
        } else {
            return Err(AppError::bad(
                "This model supports generic mana and W/U/B/R/G/C only. X, hybrid, Phyrexian and alternative costs need separate assumptions.",
            ));
        }
        if colored.len() > 20 {
            return Err(AppError::bad("Too many colored symbols for this model."));
        }
        rest = tail.trim();
    }
    Ok((generic, colored))
}

/// Match each required symbol to a distinct land. A dual land cannot satisfy two symbols.
fn assign(
    required: &[char],
    sources: &[&Land],
    index: usize,
    seen: &mut u16,
    matched: &mut [Option<usize>],
) -> bool {
    for (i, source) in sources.iter().enumerate() {
        if *seen & (1 << i) != 0 || !source.colors.contains(&required[index]) {
            continue;
        }
        *seen |= 1 << i;
        if matched[i].is_none() || assign(required, sources, matched[i].unwrap(), seen, matched) {
            matched[i] = Some(index);
            return true;
        }
    }
    false
}
fn pays(generic: usize, colored: &[char], sources: &[&Land]) -> bool {
    if generic + colored.len() > sources.len() {
        return false;
    }
    let mut required = colored.to_vec();
    required.sort_by_key(|c| sources.iter().filter(|s| s.colors.contains(c)).count());
    let mut matched = vec![None; sources.len()];
    (0..required.len()).all(|i| assign(&required, sources, i, &mut 0, &mut matched))
}

fn source(card: &crate::cards::Card, mana: Option<String>, identity: &str) -> Option<Land> {
    let ty = card.type_line.split(" // ").next().unwrap_or("");
    if !ty.contains("Land") {
        return None;
    }
    let text = card.oracle_text.to_lowercase();
    let produced = mana?;
    let mut colors: Vec<_> = produced.chars().filter(|c| "WUBRGC".contains(*c)).collect();
    if text.contains("commander's color identity") {
        colors.retain(|c| identity.contains(*c));
    }
    if colors.is_empty() {
        return None;
    }
    let basic = ty.contains("Basic");
    if !basic {
        if !text.contains("{t}: add ")
            || [
                "unless",
                "only",
                "if ",
                "that a land",
                "for each",
                "sacrifice",
                "pay ",
                "remove ",
                "choose ",
                "roll ",
                "flip ",
                "{e}",
            ]
            .iter()
            .any(|s| text.contains(s))
        {
            return None;
        }
        // Two or more mana from one source needs a different payment model.
        if text.split("add ").skip(1).any(|s| {
            s.split('.').next().unwrap_or("").contains("}{")
                || s.starts_with("two ")
                || s.starts_with("three ")
        }) {
            return None;
        }
    }
    Some(Land {
        colors,
        tapped: text.contains("enters tapped") || text.contains("enters the battlefield tapped"),
    })
}

pub async fn test(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let list = analysis::load(st, user, args).await?;
    if !list.unknown.is_empty() {
        return Err(AppError::bad(
            "Resolve unknown card names before testing mana.",
        ));
    }
    let info = super::super::tools::card_info(&st.pool, &list.cards).await?;
    let identity = crate::decks::validate(&list.cards, &info).color_identity;
    let target = arg::text_max(args, "cost", 100)?;
    let (generic, colored) = cost(target)?;
    let turns = arg::int(args, "turns", 7, 1, 10)? as usize;
    let trials = arg::int(args, "trials", 1000, 100, 5000)? as usize;
    let seed = arg::int(args, "seed", 1, 0, i64::MAX)? as u64;
    let draw_first = arg::flag(args, "draw_on_turn_one", true)?;
    let (mut deck, mut lands) = (Vec::new(), Vec::new());
    let mut unsupported = BTreeSet::new();
    for c in list
        .cards
        .iter()
        .filter(|c| c.board == crate::decks::Board::Main)
    {
        if c.qty < 1 || c.qty > 250 {
            return Err(AppError::bad("Invalid library quantity."));
        }
        let Some(card) = info.get(&c.oracle_id) else {
            return Err(AppError::bad(
                "A library card is missing from the local card data.",
            ));
        };
        let mana: Option<String> =
            sqlx::query_scalar("SELECT produced_mana FROM cards WHERE oracle_id=?")
                .bind(&c.oracle_id)
                .fetch_one(&st.pool)
                .await?;
        let land = source(card, mana.clone(), &identity);
        if land.is_none()
            && (card.type_line.contains("Land")
                || mana.as_ref().is_some_and(|m| !m.is_empty())
                || card
                    .oracle_text
                    .to_lowercase()
                    .contains("search your library"))
        {
            unsupported.insert(c.name.clone());
        }
        let index = land.map(|land| {
            let id = lands.len();
            lands.push(land);
            id
        });
        deck.extend(std::iter::repeat_n(index, c.qty as usize));
    }
    if deck.len() < 7 + turns || deck.len() > 250 {
        return Err(AppError::bad(
            "The library must contain at least 7 + turns cards, and at most 250.",
        ));
    }
    let mut rng = analysis::Random(seed);
    let mut successes = vec![0usize; turns];
    let mut trace = Vec::new();
    for trial in 0..trials {
        let mut library = deck.clone();
        rng.shuffle(&mut library);
        let mut hand: Vec<usize> = library[..7].iter().flatten().copied().collect();
        let mut draw = 7;
        let mut played: Vec<(usize, usize)> = Vec::new();
        let mut succeeded = false;
        for turn in 1..=turns {
            if turn > 1 || draw_first {
                if let Some(land) = library[draw] {
                    hand.push(land);
                }
                draw += 1;
            }
            // Fixed greedy policy: first a land that allows payment now, then coverage of target
            // colors, then untapped access. This does not claim an optimal future play policy.
            let best = hand
                .iter()
                .enumerate()
                .map(|(i, land)| {
                    let mut sources: Vec<_> = played.iter().map(|(id, _)| &lands[*id]).collect();
                    if !lands[*land].tapped {
                        sources.push(&lands[*land]);
                    }
                    let paid = pays(generic, &colored, &sources);
                    let coverage = colored
                        .iter()
                        .filter(|c| sources.iter().any(|s| s.colors.contains(c)))
                        .count();
                    (
                        i,
                        (
                            usize::from(paid),
                            coverage,
                            usize::from(!lands[*land].tapped),
                        ),
                    )
                })
                .max_by_key(|(i, score)| (*score, std::cmp::Reverse(*i)))
                .map(|(i, _)| i);
            let chosen = best.map(|i| {
                let id = hand.remove(i);
                played.push((id, turn));
                id
            });
            let sources: Vec<_> = played
                .iter()
                .filter(|(id, entered)| *entered < turn || !lands[*id].tapped)
                .map(|(id, _)| &lands[*id])
                .collect();
            succeeded |= pays(generic, &colored, &sources);
            if succeeded {
                successes[turn - 1] += 1;
            }
            if trial == 0 {
                trace.push(json!({"turn":turn,"land_played":chosen.map(|id|json!({"colors":lands[id].colors,"enters_tapped":lands[id].tapped})),"available_land_count":sources.len(),"can_pay_now":pays(generic,&colored,&sources)}));
            }
        }
    }
    let rates:Vec<_>=successes.iter().enumerate().map(|(i,&n)| {
        let p=n as f64/trials as f64;let z=1.96;let den=1.0+z*z/trials as f64;
        let mid=(p+z*z/(2.0*trials as f64))/den;
        let margin=z*(p*(1.0-p)/trials as f64+z*z/(4.0*(trials*trials) as f64)).sqrt()/den;
        json!({"by_turn":i+1,"modeled_successes":n,"trials":trials,"rate":p,"sampling_interval_95":[(mid-margin).max(0.0),(mid+margin).min(1.0)]})
    }).collect();
    Ok(
        json!({"target_cost":target,"seed":seed,"library_size":deck.len(),"modeled_land_copies":deck.iter().flatten().count(),
        "coverage_complete":unsupported.is_empty(),"unsupported_sources_or_search_cards":unsupported,"by_turn":rates,"first_trial_trace":trace,
        "assumptions":["Target is always available; no commander tax.","Seven-card opening hand; no mulligans.","Draw one each turn, subject to draw_on_turn_one; one land play per turn.","Basic and supported unconditional lands produce exactly one mana; modeled tapped lands wait a turn.","Each land pays at most one symbol; overlapping dual-land colors cannot be double-counted.","No ramp, fetch/filter sequencing, life totals, conditional mana or nonland abilities.","Fixed greedy land policy; not optimal sequencing. Unsupported cards remain in the draws but supply no modeled mana."],
        "note":"These seeded rates describe this simplified policy and coverage only. Sampling intervals exclude model error and do not establish actual casting reliability. For gameplay evidence, use the lab with its engine coverage and paired comparisons."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duals_cannot_pay_two_pips_and_colorless_is_a_requirement() {
        let dual = Land {
            colors: vec!['W', 'U'],
            tapped: false,
        };
        let plains = Land {
            colors: vec!['W'],
            tapped: false,
        };
        assert!(!pays(0, &['W', 'U'], &[&dual]));
        assert!(pays(0, &['W', 'U'], &[&dual, &plains]));
        assert!(!pays(0, &['C'], &[&dual]));
        assert!(cost("{2}{W}{W}").is_ok());
        assert!(cost("{W/U}").is_err());
    }
}
