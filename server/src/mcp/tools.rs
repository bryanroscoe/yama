//! The tools (docs/mcp-design.md). Each takes the caller and its JSON arguments and returns text for
//! Claude, built only from the caller's own rows (or shared card and precon data). Read-only in
//! this slice.
//!
//! The longer summaries reuse the advisor's context builders (`advisor::context::build`), so a
//! plan or a lab run reads the same to Ask Claude and to an outside client.

use crate::advisor::context;
use crate::auth::User;
use crate::cards::{CARD_COLUMNS, Card, SearchCard};
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Names one `card` call may ask about.
const MAX_NAMES: usize = 20;
/// Lines one `check_list` call may send.
const MAX_LIST_LINES: usize = 300;

struct Tool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "overview",
        title: "Your decks and plans",
        description: "List this person's decks in Yama (with commanders) and their upgrade plans (with plan keys). Start here.",
        schema: no_args,
    },
    Tool {
        name: "deck",
        title: "One deck",
        description: "One of their Yama decks: the current list, the bracket they declared, Commander legality problems \
                      (size, singleton, color identity, banned cards), Game Changers and real game results. \
                      Give the deck's name (as `overview` lists it) or its id.",
        schema: || obj(&[("deck", "string", "The deck's name or id.")], &["deck"]),
    },
    Tool {
        name: "plan_deck",
        title: "One upgrade plan",
        description: "One upgrade plan: the stock list and the now and after lists as differences, every planned and \
                      proposed swap with its reasons and their review answers, their shopping rules, the newest \
                      paired lab run, and real games. Give the plan key from `overview`.",
        schema: || obj(&[("key", "string", "The plan key, for example \"riders-of-rohan\".")], &["key"]),
    },
    Tool {
        name: "review_queue",
        title: "Proposals to review",
        description: "Every proposed swap still waiting for their answer, deck by deck.",
        schema: no_args,
    },
    Tool {
        name: "find_cards",
        title: "Search cards",
        description: "Search Magic cards with Yama's Scryfall-style syntax: o:\"draw a card\", t:artifact, id<=rw \
                      (fits a Boros commander), mv<=3, f:commander (legal), is:gamechanger, -t:creature, or, \
                      parentheses, !\"Exact Name\". 60 results a page, each with cost, type, color identity, Commander \
                      legality, Game Changer, a dated market price and how many copies they own.",
        schema: || {
            obj(
                &[
                    ("query", "string", "The search, for example: id<=rw t:artifact o:treasure f:commander"),
                    ("order", "string", "name (default), mv, edhrec (most played first) or color."),
                    ("page", "integer", "Page number, from 1."),
                ],
                &["query"],
            )
        },
    },
    Tool {
        name: "card",
        title: "Card details",
        description: "Full details for up to 20 cards by name: Oracle text, cost, type, color identity, Commander legality, \
                      Game Changer, EDHREC rank, the latest market price with its date, and the copies they own (where, \
                      and which are proxies). Optionally the official rulings.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string"}, "description": "Card names (any face).", "maxItems": MAX_NAMES},
                    "rulings": {"type": "boolean", "description": "Include the official rulings."},
                },
                "required": ["names"],
                "additionalProperties": false,
            })
        },
    },
    Tool {
        name: "check_list",
        title: "Check a deck list",
        description: "Check a proposed Commander list without saving it: the 100-card count, singleton, color identity, \
                      commander eligibility, cards banned in Commander, Game Changers, and names Yama doesn't know. \
                      One card per line (\"1 Sol Ring\"); a \"Commander\" header, or else the first card is the commander. \
                      Legality is Scryfall's as of Yama's last card import.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "list": {"type": "string", "description": "The list, one card per line."},
                    "first_is_commander": {"type": "boolean", "description": "With no Commander header, treat the first card as the commander (default true)."},
                },
                "required": ["list"],
                "additionalProperties": false,
            })
        },
    },
    Tool {
        name: "lab_runs",
        title: "Your lab experiments",
        description: "Their simulation experiments (\"Try a change\"), newest first, with ids for `lab_run`.",
        schema: no_args,
    },
    Tool {
        name: "lab_run",
        title: "One lab experiment",
        description: "One simulation experiment: the base and changed lists, opponents, and the paired result with its interval and warnings.",
        schema: || obj(&[("id", "string", "The experiment id from `lab_runs`.")], &["id"]),
    },
    Tool {
        name: "precon",
        title: "A precon",
        description: "A Commander precon from Yama's catalog: list, real results from playgroup.gg, the simulated rating and matchups. \
                      Give its name (or part of it) or id.",
        schema: || obj(&[("precon", "string", "The precon's name, part of it, or its id.")], &["precon"]),
    },
];

fn no_args() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": false})
}

fn obj(props: &[(&str, &str, &str)], required: &[&str]) -> Value {
    let mut p = serde_json::Map::new();
    for (name, ty, description) in props {
        p.insert((*name).into(), json!({"type": ty, "description": description}));
    }
    json!({"type": "object", "properties": p, "required": required, "additionalProperties": false})
}

pub fn list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": {"readOnlyHint": true, "openWorldHint": false},
            })
        })
        .collect()
}

pub fn exists(name: &str) -> bool {
    TOOLS.iter().any(|t| t.name == name)
}

pub async fn call(st: &AppState, user: &User, name: &str, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    match name {
        "overview" => context::build(pool, user, "general", None).await,
        "deck" => deck(pool, user, text_arg(args, "deck")?).await,
        "plan_deck" => context::build(pool, user, "plan_deck", Some(text_arg(args, "key")?)).await,
        "review_queue" => context::build(pool, user, "review", None).await,
        "find_cards" => {
            st.limits.search.check_user(user)?;
            find_cards(pool, user, args).await
        }
        "card" => {
            st.limits.search.check_user(user)?;
            card(pool, user, args).await
        }
        "check_list" => check_list(pool, args).await,
        "lab_runs" => lab_runs(pool, user).await,
        "lab_run" => context::build(pool, user, "experiment", Some(text_arg(args, "id")?)).await,
        "precon" => precon(pool, user, text_arg(args, "precon")?).await,
        other => Err(AppError::bad(format!("unknown tool \"{other}\""))),
    }
}

fn text_arg<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.len() <= 300).ok_or_else(|| AppError::bad(format!("{key} is missing")))
}

fn price(usd: Option<f64>, date: Option<&str>) -> String {
    match (usd, date) {
        (Some(p), Some(d)) => format!("${p:.2} market ({d})"),
        (Some(p), None) => format!("${p:.2} market"),
        _ => "no price".into(),
    }
}

fn legality(card: &Card) -> String {
    match card.legalities.get("commander").map(String::as_str) {
        Some("legal") => "legal in Commander".into(),
        Some("banned") => "BANNED in Commander".into(),
        Some(other) => format!("{} in Commander", other.replace('_', " ")),
        None => "Commander legality unknown".into(),
    }
}

fn game_changer(card: &Card) -> &'static str {
    match card.game_changer {
        Some(true) => ", Game Changer",
        _ => "",
    }
}

fn identity(ci: &str) -> String {
    if ci.is_empty() { "colorless".into() } else { ci.to_string() }
}

// ── decks ───────────────────────────────────────────────────────────────────

/// The caller's deck by id or (case-insensitive) name. Several matches is a 400 naming them.
async fn deck_id(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<String> {
    let by_id: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE id = ? AND owner_id = ? AND archived = 0").bind(wanted).bind(owner).fetch_optional(pool).await?;
    if let Some(id) = by_id {
        return Ok(id);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM decks WHERE owner_id = ? AND archived = 0 AND (lower(name) = lower(?1) OR instr(lower(name), lower(?2)) > 0)
         ORDER BY lower(name) = lower(?2) DESC, name LIMIT 10",
    )
    .bind(owner)
    .bind(wanted)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [] => Err(AppError::NotFound("deck")),
        [(id, _)] => Ok(id.clone()),
        [(id, name), ..] if name.eq_ignore_ascii_case(wanted) => Ok(id.clone()),
        many => Err(AppError::bad(format!("Several decks match \"{wanted}\": {}. Say which.", many.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")))),
    }
}

async fn card_info(pool: &SqlitePool, cards: &[DeckCard]) -> AppResult<HashMap<String, Card>> {
    let mut info = HashMap::new();
    for c in cards {
        if info.contains_key(&c.oracle_id) {
            continue;
        }
        if let Some(card) = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id = ?")))
            .bind(&c.oracle_id)
            .fetch_optional(pool)
            .await?
        {
            info.insert(c.oracle_id.clone(), card);
        }
    }
    Ok(info)
}

/// Legality and Game Changers for a list, as lines.
fn checks(cards: &[DeckCard], info: &HashMap<String, Card>) -> String {
    let v = crate::decks::validate(cards, info);
    let mut out = String::new();
    let _ = writeln!(out, "Cards (commander and main): {}. Color identity: {}.", v.total, identity(&v.color_identity));
    if v.errors.is_empty() {
        out.push_str("Commander checks: no problems found.\n");
    }
    for e in &v.errors {
        let _ = writeln!(out, "Problem: {e}");
    }
    for w in &v.warnings {
        let _ = writeln!(out, "Warning: {w}");
    }
    match crate::decks::game_changers(cards, info) {
        Some(g) if g.is_empty() => out.push_str("Game Changers: none.\n"),
        Some(g) => {
            let _ = writeln!(out, "Game Changers ({}): {}", g.len(), g.join(", "));
        }
        None => out.push_str("Game Changers: unknown (the list isn't loaded for every card).\n"),
    }
    out
}

async fn deck(pool: &SqlitePool, user: &User, wanted: &str) -> AppResult<String> {
    let id = deck_id(pool, &user.id, wanted).await?;
    let mut out = context::build(pool, user, "deck", Some(&id)).await?;
    let version: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(pool).await?;
    if let Some(v) = version {
        let cards = crate::decks::load_version_cards(pool, &v).await?;
        let info = card_info(pool, &cards).await?;
        out.push('\n');
        out.push_str(&checks(&cards, &info));
    }
    let _ = writeln!(out, "Deck id: {id}");
    Ok(out)
}

async fn check_list(pool: &SqlitePool, args: &Value) -> AppResult<String> {
    let text = args.get("list").and_then(Value::as_str).ok_or_else(|| AppError::bad("list is missing"))?;
    if text.lines().count() > MAX_LIST_LINES {
        return Err(AppError::bad(format!("a list can be at most {MAX_LIST_LINES} lines")));
    }
    let first = args.get("first_is_commander").and_then(Value::as_bool).unwrap_or(true);
    let parsed = crate::decks::resolve(pool, crate::decks::parse_list(text, first)).await?;
    let info = card_info(pool, &parsed.cards).await?;
    let mut out = String::new();
    let commanders: Vec<&str> = parsed.cards.iter().filter(|c| c.board == Board::Commander).map(|c| c.name.as_str()).collect();
    let _ = writeln!(out, "Commander: {}", if commanders.is_empty() { "none found".into() } else { commanders.join(" and ") });
    out.push_str(&checks(&parsed.cards, &info));
    if !parsed.unknown.is_empty() {
        let _ = writeln!(out, "Names Yama doesn't know (not counted): {}", parsed.unknown.join(", "));
    }
    Ok(out)
}

// ── cards ───────────────────────────────────────────────────────────────────

fn search_line(c: &SearchCard) -> String {
    let card = &c.card;
    let owned = match (c.owned, &c.owned_in) {
        (0, _) => String::new(),
        (n, Some(place)) => format!(", they own {n} (in {place})"),
        (n, None) => format!(", they own {n}"),
    };
    format!(
        "- {} {} | {} | {} | {}{} | {}{}",
        card.name,
        card.mana_cost.as_deref().unwrap_or(""),
        card.type_line,
        identity(&card.color_identity),
        legality(card),
        game_changer(card),
        price(c.usd, c.price_date.as_deref()),
        owned
    )
}

async fn find_cards(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let query = args.get("query").and_then(Value::as_str).map(str::trim).filter(|q| !q.is_empty()).ok_or_else(|| AppError::bad("query is missing"))?;
    let order = args.get("order").and_then(Value::as_str);
    let page = args.get("page").and_then(Value::as_u64).unwrap_or(1).clamp(1, 1000) as u32;
    let r = crate::cards::search(pool, &user.id, query, order, page).await?;
    let mut out = format!("{} cards match `{query}`", r.total);
    let first = (r.page - 1) * r.page_size;
    if r.total > r.page_size as i64 {
        let _ = write!(out, "; this is page {} ({} to {})", r.page, first + 1, first + r.cards.len() as u32);
    }
    out.push_str(":\n");
    for c in &r.cards {
        out.push_str(&search_line(c));
        out.push('\n');
    }
    Ok(out)
}

/// Close names for one Yama doesn't know, for "did you mean": the whole name inside a longer one,
/// else cards sharing one of its longer words (so a typo in one word still finds it).
async fn near_names(pool: &SqlitePool, name: &str) -> AppResult<Vec<String>> {
    let clean = name.trim().replace(['%', '_'], "");
    let mut out: Vec<String> = sqlx::query_scalar("SELECT name FROM cards WHERE name LIKE ? ORDER BY length(name) LIMIT 5").bind(format!("%{clean}%")).fetch_all(pool).await?;
    for word in clean.split_whitespace().filter(|w| w.chars().count() >= 4).take(4) {
        if out.len() >= 5 {
            break;
        }
        let more: Vec<String> = sqlx::query_scalar("SELECT name FROM cards WHERE name LIKE ? ORDER BY edhrec_rank IS NULL, edhrec_rank LIMIT 5").bind(format!("%{word}%")).fetch_all(pool).await?;
        for n in more {
            if out.len() < 5 && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    Ok(out)
}

async fn card(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let names: Vec<String> = args
        .get("names")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() <= 200).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return Err(AppError::bad("names is missing"));
    }
    if names.len() > MAX_NAMES {
        return Err(AppError::bad(format!("at most {MAX_NAMES} names at a time")));
    }
    let with_rulings = args.get("rulings").and_then(Value::as_bool).unwrap_or(false);
    let ids = crate::cards::resolve_names(pool, &names).await?;
    let items = crate::collection::items_for_owner(pool, &user.id).await?;
    let mut out = String::new();
    for name in &names {
        let Some(oid) = ids.get(name) else {
            let near = near_names(pool, name).await?;
            let _ = writeln!(
                out,
                "## {name}\nYama doesn't know this name.{}\n",
                if near.is_empty() { String::new() } else { format!(" Close: {}.", near.join(", ")) }
            );
            continue;
        };
        let Some(card) = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id = ?"))).bind(oid).fetch_optional(pool).await? else {
            continue;
        };
        let _ = writeln!(out, "## {} {}", card.name, card.mana_cost.as_deref().unwrap_or(""));
        let _ = writeln!(out, "{} (mana value {})", card.type_line, card.cmc);
        if !card.oracle_text.is_empty() {
            let _ = writeln!(out, "{}", card.oracle_text);
        }
        if let (Some(p), Some(t)) = (&card.power, &card.toughness) {
            let _ = writeln!(out, "{p}/{t}");
        }
        if let Some(l) = &card.loyalty {
            let _ = writeln!(out, "Loyalty {l}");
        }
        let rank = card.edhrec_rank.map(|r| format!(", EDHREC rank {r}")).unwrap_or_default();
        let _ = writeln!(out, "Color identity {}; {}{}{}", identity(&card.color_identity), legality(&card), game_changer(&card), rank);
        let latest: Option<(Option<f64>, String, String, String)> = sqlx::query_as(
            "SELECT COALESCE(ps.usd, ps.usd_foil, ps.usd_etched), ps.date, p.set_name, p.collector_number
             FROM printings p JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
             WHERE p.scryfall_id = ? ORDER BY ps.date DESC LIMIT 1",
        )
        .bind(card.default_printing.as_deref().unwrap_or(""))
        .fetch_optional(pool)
        .await?;
        // Gold-bordered, digital and novelty printings aren't playable in a sanctioned game.
        let cheapest: Option<(f64, String, String, String)> = sqlx::query_as(
            "SELECT ps.usd, ps.date, p.set_name, p.collector_number FROM printings p JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
             WHERE p.oracle_id = ? AND ps.usd IS NOT NULL AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
               AND IFNULL(p.digital, 0) = 0 AND IFNULL(p.set_type, '') NOT IN ('memorabilia', 'funny', 'token', 'minigame')
             ORDER BY ps.usd LIMIT 1",
        )
        .bind(oid)
        .fetch_optional(pool)
        .await?;
        match latest {
            Some((usd, date, set, num)) => {
                let _ = writeln!(out, "Price (Scryfall market, default printing: {set} #{num}): {}", price(usd, Some(&date)));
            }
            None => out.push_str("Price: none known\n"),
        }
        if let Some((usd, date, set, num)) = cheapest {
            let _ = writeln!(out, "Cheapest printing: {set} #{num}, {}", price(Some(usd), Some(&date)));
        }
        let mine: Vec<_> = items.iter().filter(|i| i.oracle_id.as_deref() == Some(oid.as_str()) && i.qty > 0).collect();
        if mine.is_empty() {
            out.push_str("They own: none\n");
        } else {
            let places: Vec<String> = mine
                .iter()
                .map(|i| {
                    format!(
                        "{} from {} #{}{}{}",
                        i.qty,
                        i.set_name.as_deref().unwrap_or("an unknown set"),
                        i.collector_number.as_deref().unwrap_or("?"),
                        if i.proxy { " (proxy)" } else { "" },
                        i.container_name.as_deref().map(|n| format!(" in {n}")).unwrap_or_else(|| " (not in a binder or deck box)".into())
                    )
                })
                .collect();
            let _ = writeln!(out, "They own: {}", places.join("; "));
        }
        if with_rulings {
            let rulings: Vec<(String, String)> =
                sqlx::query_as("SELECT published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at, rowid").bind(oid).fetch_all(pool).await?;
            for (date, text) in rulings {
                let _ = writeln!(out, "Ruling ({date}): {text}");
            }
        }
        out.push('\n');
    }
    Ok(out)
}

// ── lab and precons ─────────────────────────────────────────────────────────

async fn lab_runs(pool: &SqlitePool, user: &User) -> AppResult<String> {
    let rows: Vec<(String, String, String, i64, i64, String)> = sqlx::query_as(
        "SELECT id, name, status, games_done, games_total, created_at FROM lab_experiments WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30",
    )
    .bind(&user.id)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok("No lab experiments yet.".into());
    }
    let mut out = String::from("Their lab experiments, newest first:\n");
    for (id, name, status, done, total, created) in rows {
        let _ = writeln!(out, "- {name} ({status}, {done} of {total} games, made {}) id {id}", created.get(..10).unwrap_or(&created));
    }
    Ok(out)
}

async fn precon(pool: &SqlitePool, user: &User, wanted: &str) -> AppResult<String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM precons WHERE id = ?1 OR lower(name) = lower(?1) OR instr(lower(name), lower(?1)) > 0
         ORDER BY id = ?1 DESC, lower(name) = lower(?1) DESC, released DESC LIMIT 10",
    )
    .bind(wanted)
    .fetch_all(pool)
    .await?;
    let id = match rows.as_slice() {
        [] => return Err(AppError::NotFound("precon")),
        [(id, _)] => id.clone(),
        [(id, name), ..] if id == wanted || name.eq_ignore_ascii_case(wanted) => id.clone(),
        many => {
            return Err(AppError::bad(format!(
                "Several precons match \"{wanted}\": {}. Say which.",
                many.iter().map(|(id, n)| format!("{n} ({id})")).collect::<Vec<_>>().join(", ")
            )));
        }
    };
    context::build(pool, user, "precon", Some(&id)).await
}
