//! Independently authored Commander research tools, based on public data contracts and Yama's
//! own domain code. Other MCP projects are capability references, not implementation sources.

pub mod analysis;
pub mod client;
mod mana;
mod rules;

use crate::auth::User;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::deck_import::links::Site;
use client::Provider;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use url::Url;

fn string(description: &str) -> Value {
    json!({"type":"string","description":description,"maxLength":1000})
}
fn number(description: &str, default: i64, min: i64, max: i64) -> Value {
    json!({"type":"integer","description":description,"default":default,"minimum":min,"maximum":max})
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn selector() -> Value {
    json!({"deck":string("Your saved deck's name or id; give deck or list, exactly one."),"list":{"type":"string","maxLength":30000,"description":"A pasted list with Commander and Deck sections."},"version":string("Optional historical version of your saved deck."),"first_is_commander":{"type":"boolean","default":true}})
}
fn tool(
    name: &str,
    title: &str,
    description: &str,
    input: Value,
    network: bool,
    stage: bool,
) -> Value {
    json!({"name":name,"title":title,"description":description,"inputSchema":input,
        "annotations":{"readOnlyHint":!stage,"destructiveHint":false,"idempotentHint":!stage,"openWorldHint":network}})
}

pub fn catalog() -> Vec<Value> {
    let mut analyze = selector();
    analyze["budget_usd"] = json!({"type":"number","minimum":0,"description":"Optional total singles budget; unknown prices prevent a within-budget claim."});
    let mut combos = selector();
    combos["query"] = string("Spellbook syntax for public combo search, instead of deck/list.");
    combos["share_list"] = json!({"type":"boolean","description":"Must be true to send the selected list's card names and quantities to Commander Spellbook. No collection, notes or deck name are sent."});
    combos["limit"] = number("Results per category", 10, 1, 20);
    combos["offset"] = number("Public search offset", 0, 0, 10000);
    let mut hands = selector();
    for (k, d, v, min, max) in [
        ("seed", "Reproducible shuffle seed", 1, 0, i64::MAX),
        ("hands", "Independent samples", 5, 1, 10),
        ("draw", "Cards to draw", 7, 1, 20),
        (
            "mulligans",
            "Cards the caller must choose to bottom after a London mulligan",
            0,
            0,
            6,
        ),
    ] {
        hands[k] = number(d, v, min, max);
    }
    let mut save = selector();
    save["name"] = string(
        "A name when creating a new deck; omit deck to create, give deck to replace its current list.",
    );
    save["note"] = string("Why this list, including its public source when applicable.");
    save["source_url"] = string(
        "Optional public deck URL to record as provenance; this argument never causes a fetch.",
    );
    // A save takes a replacement list and optional target deck, unlike a read selector.
    save["deck"] = string("Optional existing deck to replace; absent means create a new deck.");
    save.as_object_mut().unwrap().remove("version");
    vec![
        tool(
            "search_scryfall",
            "Full online card search",
            "Search Scryfall's complete current syntax, beyond Yama's offline subset. Public query only; no deck or collection is uploaded. Results include per-format legality, Oracle text, image URLs and dated price observations, enriched with only this person's ownership. Follow the returned next page/offset to exhaust a provider page without skipping cards.",
            schema(
                json!({"query":string("Full Scryfall query"),"page":number("Provider page",1,1,1000),"offset":number("Offset within that provider page",0,0,1000),"limit":number("Cards to return",20,1,60),"order":{"type":"string","enum":["name","cmc","edhrec","usd","released"],"default":"name"}}),
                &["query"],
            ),
            true,
            false,
        ),
        tool(
            "card_printings",
            "Printings and image links",
            "Find a card's paper printings by exact name, from Yama's own copy of Scryfall's card data (no outside request): each with its latest TCGplayer, Cardmarket and Cardhoarder market prices, the date of those prices and their source, and original Scryfall image URLs. Images are never downloaded or bundled. A market price is a dated reference, not a store quote; a missing price is unknown.",
            schema(
                json!({"name":string("Exact card name"),"order":{"type":"string","enum":["usd","released"],"description":"Cheapest US price first (default) or newest first"},"offset":number("Printings to skip",0,0,1000),"limit":number("Printings to show",20,1,60)}),
                &["name"],
            ),
            true,
            false,
        ),
        tool(
            "commander_recommendations",
            "Commander recommendations",
            "Read EDHREC's community recommendations and sample sizes. Optionally exclude cards already in your saved deck or filter to owned cards, locally. Only the public commander/theme is sent to EDHREC. Synergy and popularity are research signals, not proof a swap improves a deck.",
            schema(
                json!({"commander":string("Commander name"),"slug":string("Optional exact EDHREC commander slug, for unusual names or partners"),"theme":string("Optional EDHREC theme/tag slug"),"budget":{"type":"string","enum":["budget","expensive"]},"deck":string("Optional own saved deck to exclude its cards"),"owned_only":{"type":"boolean","default":false},"limit":number("Suggestions",20,1,60)}),
                &["commander"],
            ),
            true,
            false,
        ),
        tool(
            "find_combos",
            "Combos and missing pieces",
            "Search Commander Spellbook with query, or find combos in a deck/list. Deck mode requires share_list=true and deck checks enabled: it sends card names and quantities to Spellbook, never the name, notes or inventory. Keeps quantities, zones, commander/face requirements, prerequisites and steps. Included cards do not establish that a combo can execute; provider bracket tags are not a declared bracket.",
            schema(combos, &[]),
            true,
            false,
        ),
        tool(
            "public_deck",
            "Read a public deck URL",
            "Fetch a public Moxfield or Archidekt list by URL and return an importable list and source timestamp. Nothing is saved. Only supported HTTPS deck hosts are accepted; never private credentials. Automated access may be blocked; failure stays explicit.",
            schema(
                json!({"url":string("https://moxfield.com/decks/... or https://archidekt.com/decks/... ")}),
                &["url"],
            ),
            true,
            false,
        ),
        tool(
            "rules_lookup",
            "Current official rules",
            "Look up a numbered Comprehensive Rule with its subrules, a glossary term, or a keyword. Discovers the current official document on Wizards' rules page at runtime. Includes its effective edition and source. No rules document is shipped, and unknown rule numbers are never invented.",
            schema(
                json!({"query":string("Rule number such as 702.19, a glossary term, or search text"),"limit":number("Matches",10,1,20)}),
                &["query"],
            ),
            true,
            false,
        ),
        tool(
            "deck_analysis",
            "Deck health, ownership and budget",
            "Analyze your saved deck or a proposed list without saving: Commander validation, curve, land access, role hints, Game Changers, Reserve List cards, the deck page's deck analysis (an unofficial 1-10 power level with its margin, five 0-100 vectors with every card's points, themes, and Spellbook combos from a saved version's stored check), quantities owned and needed, and cheapest eligible dated nonfoil market references. Missing names/prices stay unknown. No deck or inventory leaves Yama. Role and mana-access counts are descriptive, not a power or castability score.",
            schema(analyze, &[]),
            false,
            false,
        ),
        tool(
            "compare_decks",
            "Compare two lists",
            "Compare any two of your saved decks/versions or pasted proposals: exact additions and cuts, structural stats, ownership and dated budget. No invented win-rate or power prediction. Each side takes deck or list, and optionally version and first_is_commander.",
            schema(
                json!({"left":schema(selector(),&[]),"right":schema(selector(),&[])}),
                &["left", "right"],
            ),
            false,
            false,
        ),
        tool(
            "sample_hands",
            "Reproducible hands and mulligans",
            "Draw seeded sample hands from a saved or pasted library, commanders excluded, without changing it. London mulligans say how many cards to bottom, leaving the choice to the caller. No keep/ship verdict or game simulation is inferred.",
            schema(hands, &[]),
            false,
            false,
        ),
        tool(
            "mana_probability",
            "Exact source-draw probability",
            "Exact hypergeometric probability of seeing a caller-defined number of qualifying sources. The caller specifies which cards qualify; source counts alone do not model casting, overlapping colors, ramp, tapped lands or mulligans.",
            schema(
                json!({"library":number("Library size",99,1,250),"sources":number("Qualifying copies in that library",0,0,250),"seen":number("Cards seen",7,0,250),"at_least":number("Required qualifying copies",1,0,250)}),
                &["sources"],
            ),
            false,
            false,
        ),
        tool(
            "mana_test",
            "Seeded early land sequencing",
            "Test a saved or pasted library against a mana cost under an explicit lands-only model. Shuffles without replacement, draws and plays at most one land each turn, respects modeled tapped lands and assigns each source to at most one mana symbol. Reports coverage, unsupported sources, policy and sampling intervals. No acceleration, fetches, filters, life payments, mulligans or spell availability are modeled; these rates are not actual castability probabilities.",
            {
                let mut p = selector();
                p["cost"] = string(
                    "Target cost using generic integers and W/U/B/R/G/C, e.g. {2}{W}{W}. Target is assumed available.",
                );
                p["turns"] = number("Turns", 7, 1, 10);
                p["trials"] = number("Seeded trials", 1000, 100, 5000);
                p["seed"] = number("Seed", 1, 0, i64::MAX);
                p["draw_on_turn_one"] = json!({"type":"boolean","default":true});
                schema(p, &["cost"])
            },
            false,
            false,
        ),
        tool(
            "deck_history",
            "Saved versions",
            "List your deck's saved versions. Inspect/export one with deck_analysis, compare two with compare_decks, or stage a historical list with save_deck. Other users' versions are not accessible.",
            schema(json!({"deck":string("Your deck name or id")}), &["deck"]),
            false,
            false,
        ),
        tool(
            "collection_cards",
            "Owned cards and locations",
            "Read your collection, including quantities, proxies and containers. Filter by card-name text or to copies outside deck containers. Outside a deck box does not establish that a copy is unreserved in an upgrade plan.",
            schema(
                json!({"query":string("Optional card-name substring"),"outside_decks":{"type":"boolean","default":false},"page":number("Page",1,1,10000),"limit":number("Rows",40,1,100)}),
                &[],
            ),
            false,
            false,
        ),
        tool(
            "save_deck",
            "Stage a complete deck list",
            "Stage creating a deck or replacing one of your own decks with a complete proposed list. Nothing changes until reviewed and applied. Requires a resolvable Commander-legal 100-card list. Replacement records the current version and refuses stale application. New decks and version saves are atomic with the change record. Use this after construction, public_deck, or restoring a historical list.",
            schema(save, &["list"]),
            false,
            true,
        ),
        tool(
            "research_sources",
            "Sources and freshness",
            "Show local card/import freshness, source attribution, public research capabilities and limitations. This does not contact providers or claim that every provider is currently reachable.",
            schema(json!({}), &[]),
            false,
            false,
        ),
    ]
}

pub fn offered(name: &str) -> bool {
    catalog().iter().any(|t| t["name"] == name)
}

pub fn optional_text<'a>(args: &'a Value, key: &str, max: usize) -> AppResult<Option<&'a str>> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= max => {
            Ok(Some(s.trim()))
        }
        _ => Err(AppError::bad(format!(
            "{key} must be nonempty text of at most {max} characters"
        ))),
    }
}
pub fn required_text<'a>(args: &'a Value, key: &str, max: usize) -> AppResult<&'a str> {
    optional_text(args, key, max)?.ok_or_else(|| AppError::bad(format!("{key} is missing")))
}
pub fn integer(args: &Value, key: &str, default: i64, min: i64, max: i64) -> AppResult<i64> {
    let n = match args.get(key) {
        None => default,
        Some(v) => v
            .as_i64()
            .ok_or_else(|| AppError::bad(format!("{key} must be an integer")))?,
    };
    if !(min..=max).contains(&n) {
        return Err(AppError::bad(format!(
            "{key} must be between {min} and {max}"
        )));
    }
    Ok(n)
}
pub fn boolean(args: &Value, key: &str, default: bool) -> AppResult<bool> {
    args.get(key)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| AppError::bad(format!("{key} must be true or false")))
        })
        .unwrap_or(Ok(default))
}

pub async fn call(
    st: &AppState,
    user: &User,
    via: &super::Via,
    name: &str,
    args: &Value,
) -> AppResult<String> {
    if !args.is_object() {
        return Err(AppError::bad("arguments must be an object"));
    }
    let value = match name {
        "search_scryfall" => search(st, user, args).await?,
        "card_printings" => printings(st, user, args).await?,
        "commander_recommendations" => recommendations(st, user, args).await?,
        "find_combos" => combos(st, user, args).await?,
        "public_deck" => public_deck(st, user, required_text(args, "url", 1000)?).await?,
        "rules_lookup" => {
            rules::lookup(
                &st.research,
                Some(&user.id),
                required_text(args, "query", 200)?,
                integer(args, "limit", 10, 1, 20)? as usize,
            )
            .await?
        }
        "deck_analysis" => analysis::analyze(st, user, args).await?,
        "compare_decks" => analysis::compare(st, user, args).await?,
        "sample_hands" => analysis::hands(st, user, args).await?,
        "mana_probability" => analysis::mana_probability(args)?,
        "mana_test" => mana::test(st, user, args).await?,
        "deck_history" => analysis::history(st, user, args).await?,
        "collection_cards" => collection(st, user, args).await?,
        "research_sources" => sources(st).await?,
        "save_deck" => return super::changes::save_deck(st, user, via, args).await,
        _ => return Err(AppError::bad(format!("unknown tool \"{name}\""))),
    };
    let result = serde_json::to_string_pretty(&value).map_err(anyhow::Error::from)?;
    if result.len() > 100_000 {
        return Err(AppError::bad(
            "The result exceeded Yama's tool limit. Request fewer results or a narrower query.",
        ));
    }
    Ok(result)
}

async fn ownership(st: &AppState, user: &User) -> AppResult<HashMap<String, (i64, i64)>> {
    let mut counts = HashMap::new();
    for i in crate::collection::items_for_owner(&st.pool, &user.id).await? {
        if let Some(id) = i.oracle_id {
            let row = counts.entry(id).or_insert((0, 0));
            if i.proxy {
                row.1 += i.qty;
            } else {
                row.0 += i.qty;
            }
        }
    }
    Ok(counts)
}

pub fn card_summary(card: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "id",
        "oracle_id",
        "name",
        "mana_cost",
        "cmc",
        "type_line",
        "oracle_text",
        "color_identity",
        "legalities",
        "game_changer",
        "produced_mana",
        "keywords",
        "set",
        "collector_number",
        "lang",
        "prices",
        "released_at",
        "scryfall_uri",
        "image_uris",
        "card_faces",
        "artist",
    ] {
        if let Some(v) = card.get(key) {
            out[key] = v.clone();
        }
    }
    out
}

async fn search(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let query = required_text(args, "query", 1000)?.to_string();
    let page = integer(args, "page", 1, 1, 1000)?;
    let limit = integer(args, "limit", 20, 1, 60)? as usize;
    let offset = integer(args, "offset", 0, 0, 1000)? as usize;
    let order = optional_text(args, "order", 20)?.unwrap_or("name");
    if !["name", "cmc", "edhrec", "usd", "released"].contains(&order) {
        return Err(AppError::bad("unsupported search order"));
    }
    let doc = st
        .research
        .get(
            Some(&user.id),
            Provider::Scryfall,
            "/cards/search",
            &[
                ("q", query),
                ("page", page.to_string()),
                ("order", order.into()),
                ("unique", "cards".into()),
            ],
        )
        .await?;
    let data = doc.json()?;
    let rows = data["data"].as_array().ok_or_else(|| {
        AppError::Unavailable("Scryfall returned an unfamiliar card list.".into())
    })?;
    let owned = ownership(st, user).await?;
    if offset > rows.len() {
        return Err(AppError::bad("offset exceeds this provider page"));
    }
    let cards: Vec<_> = rows
        .iter()
        .skip(offset)
        .take(limit)
        .map(|c| {
            let mut c = card_summary(c);
            let count = c["oracle_id"]
                .as_str()
                .and_then(|id| owned.get(id))
                .copied()
                .unwrap_or_default();
            c["owned_real"] = count.0.into();
            c["owned_proxies"] = count.1.into();
            c
        })
        .collect();
    let end = offset + cards.len();
    let next = if end < rows.len() {
        json!({"page":page,"offset":end})
    } else if data["has_more"] == true && page < 1000 {
        json!({"page":page+1,"offset":0})
    } else {
        Value::Null
    };
    Ok(
        json!({"provenance":doc.provenance(),"total_cards":data["total_cards"],"page":page,"offset":offset,"next":next,"provider_has_more":data["has_more"],
        "cards":cards,
        "price_source":"Scryfall / TCGplayer and Cardmarket market references","price_observed_at":doc.fetched_at,"provider_price_date":null,
        "note":"This is a dated observation of provider market data, not a store quote or proof of stock. Missing price fields remain null. Follow next using the same query/order/limit. Card images load from their original URLs; retain artist and copyright credits."}),
    )
}

/// A card's paper printings from Yama's own copy of Scryfall's default cards, with each one's
/// latest prices (`price_latest`), their date and their source. Nothing is fetched.
async fn printings(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let name = required_text(args, "name", 200)?;
    let limit = integer(args, "limit", 20, 1, 60)? as usize;
    let offset = integer(args, "offset", 0, 0, 1000)? as usize;
    let order = match optional_text(args, "order", 20)?.unwrap_or("usd") {
        "usd" => "ps.usd IS NULL, ps.usd, p.released_at DESC, p.scryfall_id",
        "released" => "p.released_at DESC, p.scryfall_id",
        _ => return Err(AppError::bad("card_printings orders by usd or released")),
    };
    let Some(oracle_id) = crate::cards::resolve_names(&st.pool, &[name.to_string()]).await?.remove(name) else {
        return Err(AppError::NotFound("a card by that exact name"));
    };
    let card: Option<String> = sqlx::query_scalar(
        "SELECT json_object('oracle_id', oracle_id, 'name', name, 'mana_cost', mana_cost, 'cmc', cmc, 'type_line', type_line,
                'oracle_text', oracle_text, 'color_identity', color_identity, 'legalities', json(legalities), 'keywords', json(keywords),
                'game_changer', json(CASE game_changer WHEN 1 THEN 'true' WHEN 0 THEN 'false' END), 'produced_mana', produced_mana)
           FROM cards WHERE oracle_id = ?",
    )
    .bind(&oracle_id)
    .fetch_optional(&st.pool)
    .await?;
    let card: Value = card.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or(Value::Null);
    let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT json_object('id', p.scryfall_id, 'set', p.set_code, 'set_name', p.set_name, 'set_type', p.set_type,
                'collector_number', p.collector_number, 'lang', p.lang, 'rarity', p.rarity, 'finishes', json(p.finishes),
                'released_at', p.released_at, 'artist', p.artist,
                'scryfall_uri', 'https://scryfall.com/card/' || p.set_code || '/' || p.collector_number,
                'image_uris', json_object('normal', p.image_normal, 'small', p.image_small, 'art_crop', p.image_art_crop),
                'back_image_normal', p.back_image_normal,
                'prices', json_object('usd', ps.usd, 'usd_foil', ps.usd_foil, 'usd_etched', ps.usd_etched, 'eur', ps.eur,
                                      'eur_foil', ps.eur_foil, 'eur_etched', ps.eur_etched, 'tix', ps.tix),
                'price_date', ps.date)
           FROM printings p LEFT JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
          WHERE p.oracle_id = ? AND IFNULL(p.digital, 0) = 0
          ORDER BY {order}"
    )))
    .bind(&oracle_id)
    .fetch_all(&st.pool)
    .await?;
    let total = rows.len();
    let shown: Vec<Value> = rows.iter().skip(offset).take(limit).filter_map(|r| serde_json::from_str(r).ok()).collect();
    let end = offset + shown.len();
    // Which market each price is, from the series the history keeps.
    let labels: Vec<(i64, String)> = sqlx::query_as("SELECT id, label FROM price_series WHERE feed = ? ORDER BY id")
        .bind(crate::prices::SCRYFALL)
        .fetch_all(&st.pool)
        .await?;
    let sources: serde_json::Map<String, Value> = crate::prices::SCRYFALL_SERIES
        .iter()
        .filter_map(|(id, column)| labels.iter().find(|(l, _)| l == id).map(|(_, label)| (column.to_string(), Value::from(label.as_str()))))
        .collect();
    let (real, proxies) = ownership(st, user).await?.get(&oracle_id).copied().unwrap_or_default();
    let cards_at = crate::cards::import::cards_changed_at(&st.pool).await?;
    let prices_at = crate::cards::import::latest_price_date(&st.pool).await?;
    Ok(json!({
        "provenance": {"provider": "Yama", "source": "Yama's copy of Scryfall's default cards (English, or a card's only language)", "retrieved_at": cards_at, "cached": true},
        "card": card, "owned_real": real, "owned_proxies": proxies,
        "total_printings": total, "offset": offset, "next": if end < total { json!({"offset": end}) } else { Value::Null },
        "printings": shown, "price_sources": sources, "prices_as_of": prices_at,
        "note": "Paper printings only. Each printing's prices are market references dated by its price_date (the newest Scryfall file Yama read that listed it, or found it missing), not store quotes or proof of stock; a missing price is unknown, never zero. Card images load from their original URLs; retain artist and copyright credits."
    }))
}

fn slug(s: &str) -> String {
    let mut result = String::new();
    for c in s.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            _ => c,
        };
        if c.is_ascii_alphanumeric() {
            result.push(c);
        } else if c.is_whitespace() || c == '-' {
            if !result.ends_with('-') {
                result.push('-');
            }
        }
    }
    result.trim_matches('-').to_string()
}
fn segment(s: &str) -> AppResult<&str> {
    if !s.is_empty() && s.len() <= 120 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(s)
    } else {
        Err(AppError::bad(
            "Use an alphanumeric source slug with hyphens.",
        ))
    }
}

async fn recommendations(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let commander = required_text(args, "commander", 200)?;
    let commander_slug = optional_text(args, "slug", 120)?
        .map(String::from)
        .unwrap_or_else(|| slug(commander));
    segment(&commander_slug)?;
    let mut path = format!("/pages/commanders/{commander_slug}");
    if let Some(theme) = optional_text(args, "theme", 120)? {
        path.push('/');
        path.push_str(segment(theme)?);
    }
    if let Some(budget) = optional_text(args, "budget", 20)? {
        if !["budget", "expensive"].contains(&budget) {
            return Err(AppError::bad("budget must be budget or expensive"));
        }
        path.push('/');
        path.push_str(budget);
    }
    path.push_str(".json");
    let limit = integer(args, "limit", 20, 1, 60)? as usize;
    let only_owned = boolean(args, "owned_only", false)?;
    let excluded = if let Some(deck) = optional_text(args, "deck", 200)? {
        analysis::load(st, user, &json!({"deck":deck}))
            .await?
            .cards
            .into_iter()
            .map(|c| c.oracle_id)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let doc = st.research.get(Some(&user.id), Provider::Edhrec, &path, &[]).await?;
    let data = doc.json()?;
    let lists = data
        .pointer("/container/json_dict/cardlists")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::Unavailable("EDHREC returned an unfamiliar recommendations page.".into())
        })?;
    let owned = ownership(st, user).await?;
    let mut candidates = BTreeMap::<String, Value>::new();
    for list in lists {
        for row in list["cardviews"].as_array().into_iter().flatten() {
            let Some(name) = row["name"].as_str() else {
                continue;
            };
            let entry=candidates.entry(name.into()).or_insert_with(||json!({"name":name,"synergy":row["synergy"],"num_decks":row["num_decks"],"potential_decks":row["potential_decks"],"categories":[]}));
            if let Some(categories) = entry["categories"].as_array_mut() {
                categories.push(list["header"].clone());
            }
        }
    }
    let names = candidates.keys().cloned().collect::<Vec<_>>();
    let ids = crate::cards::resolve_names(&st.pool, &names).await?;
    let mut results = Vec::new();
    for (name, mut row) in candidates {
        let id = ids.get(&name);
        if id.is_some_and(|id| excluded.contains(id)) {
            continue;
        }
        let count = id.and_then(|id| owned.get(id)).copied().unwrap_or_default();
        if only_owned && count.0 + count.1 == 0 {
            continue;
        }
        row["owned_real"] = count.0.into();
        row["owned_proxies"] = count.1.into();
        row["known_to_yama"] = id.is_some().into();
        row["inclusion_rate"] = match (row["num_decks"].as_f64(), row["potential_decks"].as_f64()) {
            (Some(n), Some(d)) if d > 0.0 => json!(n / d),
            _ => Value::Null,
        };
        results.push(row);
    }
    results.sort_by(|a, b| {
        b["synergy"]
            .as_f64()
            .unwrap_or(-1.0)
            .total_cmp(&a["synergy"].as_f64().unwrap_or(-1.0))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    let total = results.len();
    results.truncate(limit);
    Ok(
        json!({"provenance":doc.provenance(),"attribution":"EDHREC","url":format!("https://edhrec.com/commanders/{commander_slug}"),"commander":commander,
        "matches":total,"truncated":total>limit,"recommendations":results,"theme_counts":data["tag_counts"],
        "note":"Community inclusion and synergy are suggestions, not causal performance evidence. Filters against your list and collection ran locally. Check each candidate's Oracle text, identity, legality, price and bracket implications before proposing it."}),
    )
}

fn combo_summary(combo: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "id",
        "identity",
        "produces",
        "requires",
        "manaNeeded",
        "manaValueNeeded",
        "easyPrerequisites",
        "notablePrerequisites",
        "description",
        "notes",
        "bracketTag",
        "legalities",
        "popularity",
    ] {
        if let Some(v) = combo.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(uses) = combo["uses"].as_array() {
        out["uses"]=uses.iter().map(|u| {
        let mut u=u.clone();
        u["card"]=json!({"name":u["card"]["name"],"oracleId":u["card"]["oracleId"],"faces":u["card"]["faces"]});u
    }).collect::<Vec<_>>().into();
    }
    if let Some(id) = combo["id"].as_str() {
        out["url"] = json!(format!("https://commanderspellbook.com/combo/{id}/"));
    }
    out
}

async fn combos(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let limit = integer(args, "limit", 10, 1, 20)? as usize;
    if let Some(query) = optional_text(args, "query", 1000)? {
        if args.get("deck").is_some() || args.get("list").is_some() {
            return Err(AppError::bad("Use query or deck/list, not both."));
        }
        let offset = integer(args, "offset", 0, 0, 10000)?;
        let doc = st
            .research
            .get(
                Some(&user.id),
                Provider::Spellbook,
                "/variants/",
                &[
                    ("q", query.into()),
                    ("limit", limit.to_string()),
                    ("offset", offset.to_string()),
                ],
            )
            .await?;
        let data = doc.json()?;
        let results = data["results"].as_array().ok_or_else(|| {
            AppError::Unavailable("Spellbook returned an unfamiliar combo list.".into())
        })?;
        return Ok(
            json!({"provenance":doc.provenance(),"attribution":"Commander Spellbook","count":data["count"],"offset":offset,
            "has_more":!data["next"].is_null(),"combos":results.iter().take(limit).map(combo_summary).collect::<Vec<_>>(),"note":"Preserve every quantity, zone, face and prerequisite; card inclusion alone does not prove execution."}),
        );
    }
    let list = analysis::load(st, user, args).await?; // Owner checks happen before any source request.
    if !list.unknown.is_empty() {
        return Err(AppError::bad(
            "Resolve unknown names before searching this list's combos.",
        ));
    }
    if !boolean(args, "share_list", false)? {
        return Err(AppError::bad(
            "Deck combo lookup sends the card list to Commander Spellbook. Set share_list=true only when the person requested that lookup.",
        ));
    }
    if !st.cfg.deck_checks {
        return Err(AppError::Unavailable("Sending deck lists to Spellbook is disabled on this server (YAMA_DECK_CHECKS=0). Public query searches remain available.".into()));
    }
    let entries = |board| {
        list.cards
            .iter()
            .filter(|c| c.board == board)
            .map(|c| json!({"card":c.name,"quantity":c.qty}))
            .collect::<Vec<_>>()
    };
    let doc=st.research.post(Some(&user.id),Provider::Spellbook,"/find-my-combos",json!({"commanders":entries(crate::decks::Board::Commander),"main":entries(crate::decks::Board::Main)})).await?;
    let data = doc.json()?;
    let data = data
        .get("results")
        .filter(|r| r.is_object())
        .unwrap_or(&data);
    let mut groups = json!({});
    for name in [
        "included",
        "includedByChangingCommanders",
        "almostIncluded",
        "almostIncludedByAddingColors",
        "almostIncludedByChangingCommanders",
        "almostIncludedByAddingColorsAndChangingCommanders",
    ] {
        if data.get(name).is_none()
            && !["included", "almostIncluded", "almostIncludedByAddingColors"].contains(&name)
        {
            continue;
        }
        let group = data.get(name).ok_or_else(|| {
            AppError::Unavailable("Spellbook returned an unfamiliar deck-combo response.".into())
        })?;
        let rows = group
            .as_array()
            .or_else(|| group["results"].as_array())
            .ok_or_else(|| {
                AppError::Unavailable("Spellbook returned an unfamiliar combo category.".into())
            })?;
        groups[name] = json!({"count":group.get("count").cloned().unwrap_or_else(||json!(rows.len())),"returned":rows.iter().take(limit).map(combo_summary).collect::<Vec<_>>(),"truncated":rows.len()>limit || group.get("next").is_some_and(|v|!v.is_null())});
    }
    Ok(
        json!({"provenance":doc.provenance(),"attribution":"Commander Spellbook","groups":groups,
        "note":"This card list was explicitly sent to Spellbook and the result was not cached. Inclusion does not verify zones, setup, timing, access to missing pieces, or ability to execute. These tags do not assign a Commander bracket."}),
    )
}

pub fn deck_url(raw: &str) -> AppResult<(Provider, String, String)> {
    let url = Url::parse(raw).map_err(|_| AppError::bad("Use a full public HTTPS deck URL."))?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::bad(
            "Use a public HTTPS deck URL without credentials or a custom port.",
        ));
    }
    let provider = match url.host_str() {
        Some("moxfield.com" | "www.moxfield.com") => Provider::Moxfield,
        Some("archidekt.com" | "www.archidekt.com") => Provider::Archidekt,
        _ => {
            return Err(AppError::bad(
                "Only Moxfield and Archidekt public deck URLs are supported.",
            ));
        }
    };
    let path = url
        .path_segments()
        .map(|s| s.filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if path.len() < 2 || path[0] != "decks" {
        return Err(AppError::bad("The URL needs /decks/<id>."));
    }
    let id = path[1];
    if id.len() > 80
        || id.is_empty()
        || !id.bytes().all(|b| {
            if provider == Provider::Archidekt {
                b.is_ascii_digit()
            } else {
                b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
            }
        })
    {
        return Err(AppError::bad("Invalid public deck id."));
    }
    let host = if provider == Provider::Archidekt {
        "archidekt.com"
    } else {
        "moxfield.com"
    };
    Ok((provider, id.into(), format!("https://{host}/decks/{id}")))
}

pub fn parse_public(provider: Provider, data: &Value) -> AppResult<Value> {
    if data["private"].as_bool() == Some(true) || data["isPrivate"].as_bool() == Some(true) {
        return Err(AppError::NotFound("public deck"));
    }
    let mut entries = Vec::new();
    if provider == Provider::Archidekt {
        let premier: Vec<_> = data["categories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["isPremier"].as_bool() == Some(true))
            .filter_map(|c| c["name"].as_str())
            .collect();
        let rows = data["cards"].as_array().ok_or_else(|| {
            AppError::Unavailable("Archidekt returned an unfamiliar deck.".into())
        })?;
        for row in rows {
            let name = row
                .pointer("/card/oracleCard/name")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Unavailable(
                        "An Archidekt card has no name; the list was not silently shortened."
                            .into(),
                    )
                })?;
            let categories = row["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let board = if categories
                .iter()
                .any(|c| c.eq_ignore_ascii_case("Commander") || premier.contains(c))
            {
                "Commander"
            } else if categories.iter().any(|c| {
                c.eq_ignore_ascii_case("Sideboard") || c.eq_ignore_ascii_case("Maybeboard")
            }) {
                "Sideboard"
            } else {
                "Deck"
            };
            entries.push((
                board.to_string(),
                name.to_string(),
                row["quantity"].as_i64().unwrap_or(0),
            ));
        }
    } else {
        for (zone, board) in [
            ("commanders", "Commander"),
            ("mainboard", "Deck"),
            ("sideboard", "Sideboard"),
            ("maybeboard", "Sideboard"),
        ] {
            let value = data.get(zone).or_else(|| {
                data.get("boards")
                    .and_then(|b| b.get(zone))
                    .and_then(|b| b.get("cards"))
            });
            if let Some(value) = value {
                let rows = value.as_object().ok_or_else(|| {
                    AppError::Unavailable("Moxfield returned an unfamiliar board.".into())
                })?;
                for row in rows.values() {
                    let name = row
                        .pointer("/card/name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AppError::Unavailable(
                                "A Moxfield card has no name; the list was not silently shortened."
                                    .into(),
                            )
                        })?;
                    entries.push((
                        board.to_string(),
                        name.to_string(),
                        row["quantity"].as_i64().unwrap_or(0),
                    ));
                }
            }
        }
    }
    if entries.is_empty()
        || entries.len() > 300
        || entries
            .iter()
            .any(|(_, n, q)| n.contains(['\n', '\r']) || n.len() > 300 || *q < 1 || *q > 250)
        || entries.iter().map(|(_, _, q)| q).sum::<i64>() > 500
    {
        return Err(AppError::bad(
            "The public deck is empty, oversized, or contains an invalid card entry.",
        ));
    }
    let mut list = String::new();
    for heading in ["Commander", "Deck", "Sideboard"] {
        if !entries.iter().any(|(b, _, _)| b == heading) {
            continue;
        }
        list.push_str(heading);
        list.push('\n');
        for (_, name, qty) in entries.iter().filter(|(b, _, _)| b == heading) {
            list.push_str(&format!("{qty} {name}\n"));
        }
        list.push('\n');
    }
    Ok(
        json!({"name":data["name"],"source_updated_at":data.get("updatedAt").or_else(||data.get("lastUpdatedAtUtc")).or_else(||data.get("lastUpdatedAt")),"list":list,
        "note":"Public list only. Sideboard and maybeboard cards are kept under Sideboard and excluded from Commander totals. No private credentials, purchase or save occurred."}),
    )
}

pub async fn public_deck(st: &AppState, user: &User, raw: &str) -> AppResult<Value> {
    let (provider, id, url) = deck_url(raw)?;
    // The same rule as deck import (docs/deck-import.md): Moxfield's robots.txt disallows
    // automated access and Archidekt's terms bar automated requests without permission, so Yama
    // fetches from a site only where the server enables it (YAMA_DECK_LINK_SOURCES).
    let site = if provider == Provider::Archidekt { Site::Archidekt } else { Site::Moxfield };
    if !crate::deck_import::links::enabled(site) {
        return Err(AppError::Forbidden(format!(
            "Yama doesn't fetch {} decks: {}. Copy the list from the site and paste it instead.",
            site.name(),
            if site == Site::Moxfield { "Moxfield's robots.txt disallows automated access" } else { "Archidekt's terms bar automated requests without permission" }
        )));
    }
    let path = if provider == Provider::Archidekt {
        format!("/api/decks/{id}/")
    } else {
        format!("/v2/decks/all/{id}")
    };
    let doc = st.research.get(Some(&user.id), provider, &path, &[]).await?;
    let mut result = parse_public(provider, &doc.json()?)?;
    result["url"] = url.into();
    result["provenance"] = doc.provenance();
    Ok(result)
}

async fn collection(st: &AppState, user: &User, args: &Value) -> AppResult<Value> {
    let query = optional_text(args, "query", 200)?
        .unwrap_or("")
        .to_lowercase();
    let outside = boolean(args, "outside_decks", false)?;
    let limit = integer(args, "limit", 40, 1, 100)? as usize;
    let page = integer(args, "page", 1, 1, 10000)? as usize;
    let mut rows = crate::collection::items_for_owner(&st.pool, &user.id).await?;
    rows.retain(|i| {
        i.name
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains(&query)
            && (!outside || i.container_kind.as_deref() != Some("deck"))
    });
    rows.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    let total = rows.len();
    Ok(
        json!({"total_rows":total,"page":page,"has_more":page*limit<total,"items":rows.into_iter().skip((page-1)*limit).take(limit).collect::<Vec<_>>(),
        "note":"Only your copies. A copy elsewhere in your collection may be committed to another deck or plan."}),
    )
}

async fn sources(st: &AppState) -> AppResult<Value> {
    let latest = crate::cards::import::cards_changed_at(&st.pool).await?;
    let prices = crate::cards::import::latest_price_date(&st.pool).await?;
    Ok(
        json!({"cards_updated_at":latest,"latest_price_date":prices,"spellbook_list_sharing_enabled":st.cfg.deck_checks,
        "sources":[{"name":"Scryfall","url":"https://scryfall.com/docs/api","data":"Card facts, full search, printings, rulings and market observations"},
        {"name":"EDHREC","url":"https://edhrec.com","data":"Community recommendations; undocumented endpoints may change"},
        {"name":"Commander Spellbook","url":"https://commanderspellbook.com","data":"Combos and prerequisites; explicit consent for deck list matching"},
        {"name":"Wizards","url":"https://magic.wizards.com/en/rules","data":"Official current rules, discovered and fetched at runtime"},
        {"name":"Moxfield / Archidekt","url":"https://moxfield.com","data":"Public deck lists; automated access can be blocked"}],
        "note":"A capability inventory, not a live provider health check. Public GET results are kept and shared for as long as each provider's answers stay useful (Scryfall 6 hours, public decks 3 hours, EDHREC and Spellbook searches a day, the rules page a day and a dated rules text 30 days), each with its provider and retrieval time; deck POSTs are never cached. Public deck links are fetched only from sites this server enables. Source retrieval timestamps do not assert an upstream price snapshot date. Yama remains unofficial and not endorsed by Wizards."}),
    )
}

#[cfg(test)]
mod tests;
