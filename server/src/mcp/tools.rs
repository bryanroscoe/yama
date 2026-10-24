//! The tools (docs/mcp-design.md). Each takes the caller and its JSON arguments and returns text for
//! Claude, built only from the caller's own rows (or shared card and precon data). The read tools
//! are here; the write tools only stage a change for the person to review (`changes.rs`).
//!
//! The longer summaries reuse the advisor's context builders (`advisor::context::build`), so a
//! plan or a lab run reads the same to Ask Claude and to an outside client.

use super::{Via, changes};
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Does {
    Read,
    /// Stores a pending change and changes nothing else.
    Stage,
    /// Applies or discards a staged change: outside clients only, never Ask Claude.
    Decide,
}

struct Tool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    does: Does,
}

/// Said by every write tool: what staging means.
macro_rules! staged {
    ($what:literal) => {
        concat!(
            $what,
            " This only stages the change for their review: it shows in Yama with Apply and Discard, and nothing changes until they apply it. \
              Stage a change when they ask for it or agree to it, not as a guess."
        )
    };
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "overview",
        title: "Your decks and plans",
        description: "List this person's decks in Yama (with commanders) and their upgrade plans (with plan keys). Start here.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "deck",
        title: "One deck",
        description: "One of their Yama decks: the current list, the bracket they declared, Commander legality problems \
                      (size, singleton, color identity, banned cards), Game Changers and real game results. \
                      Give the deck's name (as `overview` lists it) or its id.",
        schema: || obj(&[("deck", "string", "The deck's name or id.")], &["deck"]),
        does: Does::Read,
    },
    Tool {
        name: "plan_deck",
        title: "One upgrade plan",
        description: "One upgrade plan: the stock list and the now and after lists as differences, every planned and \
                      proposed swap with its reasons and their review answers, their shopping rules, the newest \
                      paired lab run, and real games. Give the plan key from `overview`.",
        schema: || obj(&[("key", "string", "The plan key, for example \"riders-of-rohan\".")], &["key"]),
        does: Does::Read,
    },
    Tool {
        name: "review_queue",
        title: "Proposals to review",
        description: "Every proposed swap still waiting for their answer, deck by deck.",
        schema: no_args,
        does: Does::Read,
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
        does: Does::Read,
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
        does: Does::Read,
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
        does: Does::Read,
    },
    Tool {
        name: "lab_runs",
        title: "Your lab experiments",
        description: "Their simulation experiments (\"Try a change\"), newest first, with ids for `lab_run`.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "lab_run",
        title: "One lab experiment",
        description: "One simulation experiment: the base and changed lists, opponents, and the paired result with its interval and warnings.",
        schema: || obj(&[("id", "string", "The experiment id from `lab_runs`.")], &["id"]),
        does: Does::Read,
    },
    Tool {
        name: "precon",
        title: "A precon",
        description: "A Commander precon from Yama's catalog: list, real results from playgroup.gg, the simulated rating and matchups. \
                      Give its name (or part of it) or id.",
        schema: || obj(&[("precon", "string", "The precon's name, part of it, or its id.")], &["precon"]),
        does: Does::Read,
    },
    Tool {
        name: "changes",
        title: "Changes waiting for review",
        description: "The changes you (or another Claude) staged that they haven't applied or discarded yet, with ids. \
                      Check here before staging the same change twice.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "edit_deck",
        title: "Change a deck's list",
        description: staged!(
            "Change one of their Yama decks: add cards to the main deck and remove cards from it, one copy per name \
             (name a card twice for two copies). Applying saves a new version of the deck, with your note; the old \
             version stays in its history. If the deck changes before they apply it, it won't apply."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "deck": {"type": "string", "description": "The deck's name or id."},
                    "add": {"type": "array", "items": {"type": "string"}, "description": "Card names to add."},
                    "remove": {"type": "array", "items": {"type": "string"}, "description": "Card names to remove."},
                    "note": {"type": "string", "description": "Why, in a sentence; saved with the version."},
                },
                "required": ["deck"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "propose_swap",
        title: "Suggest a swap for a plan",
        description: staged!(
            "Suggest a swap for one of their upgrade plans: a card to put in and, usually, the card it replaces. \
             Applying saves it as an idea in the plan, where it goes through their usual review."
        ),
        schema: || {
            obj(
                &[
                    ("plan", "string", "The plan key or deck name from `overview`."),
                    ("card_in", "string", "The card to put in."),
                    ("card_out", "string", "The card it replaces, if any."),
                    ("why", "string", "Why, in a sentence or two."),
                ],
                &["plan", "card_in"],
            )
        },
        does: Does::Stage,
    },
    Tool {
        name: "answer_review",
        title: "Answer a proposal in Review",
        description: staged!(
            "Answer a swap in one of their plans the way they would on the Review page: want, unsure or no, with an \
             optional note and a different card to cut. Only when they've told you their answer."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string", "description": "The plan key or deck name."},
                    "card_in": {"type": "string", "description": "The card the swap puts in."},
                    "card_out": {"type": "string", "description": "The card it takes out, when several swaps put in the same card."},
                    "decision": {"type": "string", "enum": ["want", "unsure", "no"]},
                    "note": {"type": "string"},
                    "cut": {"type": "string", "description": "A different card to cut instead."},
                },
                "required": ["plan", "card_in", "decision"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "mark_bought",
        title: "Mark a plan card bought",
        description: staged!(
            "Mark a swap's card as bought in one of their plans, as \"Bought it\" does: when, how many, the price and \
             the store. It's their claim, not an order. value false clears the mark."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string"},
                    "card_in": {"type": "string"},
                    "card_out": {"type": "string"},
                    "value": {"type": "boolean", "description": "true (the default) marks it, false clears it."},
                    "on": {"type": "string", "description": "YYYY-MM-DD; today if left out."},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "price_paid": {"type": "number", "minimum": 0},
                    "store": {"type": "string"},
                },
                "required": ["plan", "card_in"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "mark_installed",
        title: "Mark a plan swap installed",
        description: staged!("Mark a swap in one of their plans as installed in the real deck (value false clears it)."),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string"},
                    "card_in": {"type": "string"},
                    "card_out": {"type": "string"},
                    "value": {"type": "boolean"},
                },
                "required": ["plan", "card_in"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "start_lab_run",
        title: "Test a change in the lab",
        description: staged!(
            "Simulate a change: one of their decks (or a whole list) against the same list with cards added and cut, in \
             paired games against the strongest precons or their own decks. Applying queues it under their lab \
             allowance; results come in over the next while (see lab_run)."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "deck": {"type": "string", "description": "One of their decks, by name or id."},
                    "list": {"type": "string", "description": "Or a whole list, one card per line, commander first."},
                    "label": {"type": "string", "description": "A name for a pasted list."},
                    "add": {"type": "array", "items": {"type": "string"}},
                    "cut": {"type": "array", "items": {"type": "string"}},
                    "games": {"type": "integer", "description": "100 (the default), 200 or 400."},
                    "opponents": {"type": "string", "enum": ["strongest", "my_decks"]},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "add_to_collection",
        title: "Add cards to the collection",
        description: staged!(
            "Add copies of a card to their collection, in a binder, deck box or list they already have (or loose). \
             Without a set, Yama's default printing."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "card": {"type": "string"},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "set": {"type": "string", "description": "Set code, such as \"cmm\"."},
                    "number": {"type": "string", "description": "Collector number in that set."},
                    "container": {"type": "string", "description": "Their binder, deck box or list, by name."},
                    "proxy": {"type": "boolean"},
                    "finish": {"type": "string", "enum": ["nonfoil", "foil", "etched"]},
                },
                "required": ["card"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "move_cards",
        title: "Move cards between binders and boxes",
        description: staged!("Move copies of a card from one of their binders, deck boxes or lists to another."),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "card": {"type": "string"},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                },
                "required": ["card", "from", "to"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "set_condition",
        title: "Set the condition of cards",
        description: staged!(
            "Set the condition of every copy in one of their binders, deck boxes or lists, or only the copies of one card there: \
             NM (near mint), LP (lightly played), MP (moderately played), HP (heavily played) or DMG (damaged)."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "container": {"type": "string", "description": "Their binder, deck box or list, by name."},
                    "card": {"type": "string", "description": "Only this card's copies; every card there if left out."},
                    "condition": {"type": "string", "enum": ["NM", "LP", "MP", "HP", "DMG"]},
                },
                "required": ["container", "condition"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "apply_change",
        title: "Apply a staged change",
        description: "Apply one staged change. Call it only after they have said yes to that exact change in this conversation; \
                      otherwise let them apply it in Yama. If the deck or plan moved on, it fails with the reason and stays waiting.",
        schema: || obj(&[("id", "string", "The change id from staging or `changes`.")], &["id"]),
        does: Does::Decide,
    },
    Tool {
        name: "discard_change",
        title: "Discard a staged change",
        description: "Discard one staged change, when they say no to it or you staged it by mistake.",
        schema: || obj(&[("id", "string", "The change id.")], &["id"]),
        does: Does::Decide,
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

/// The tools this caller gets: Ask Claude can stage changes but not apply them.
fn for_caller(via: &Via) -> impl Iterator<Item = &'static Tool> {
    let decide = via.may_apply();
    TOOLS.iter().filter(move |t| decide || t.does != Does::Decide)
}

pub fn list(via: &Via) -> Vec<Value> {
    for_caller(via)
        .map(|t| {
            let annotations = match t.does {
                Does::Read => json!({"readOnlyHint": true, "openWorldHint": false}),
                // Staging adds a pending row and nothing else: harmless to repeat, never destructive.
                Does::Stage => json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}),
                Does::Decide => json!({"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}),
            };
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": annotations,
            })
        })
        .collect()
}

pub fn offered(name: &str, via: &Via) -> bool {
    for_caller(via).any(|t| t.name == name)
}

pub async fn call(st: &AppState, user: &User, via: &Via, name: &str, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    match name {
        "changes" => changes_text(pool, user).await,
        "edit_deck" => changes::edit_deck(st, user, via, args).await,
        "propose_swap" => changes::propose_swap(st, user, via, args).await,
        "answer_review" => changes::answer_review(st, user, via, args).await,
        "mark_bought" => changes::mark_bought(st, user, via, args).await,
        "mark_installed" => changes::mark_installed(st, user, via, args).await,
        "start_lab_run" => changes::start_lab_run(st, user, via, args).await,
        "add_to_collection" => changes::add_to_collection(st, user, via, args).await,
        "move_cards" => changes::move_cards(st, user, via, args).await,
        "set_condition" => changes::set_condition(st, user, via, args).await,
        "apply_change" => {
            let c = changes::apply(st, user, text_arg(args, "id")?).await?;
            match (c.status.as_str(), c.error) {
                ("applied", _) => Ok(format!("Applied: {}. {}", c.summary, c.result.and_then(|r| r["label"].as_str().map(String::from)).unwrap_or_default())),
                (_, Some(e)) => Err(AppError::Conflict(format!("Not applied: {e}"))),
                (status, None) => Err(AppError::Conflict(format!("Not applied; the change is {status}."))),
            }
        }
        "discard_change" => {
            let c = changes::discard(pool, &user.id, text_arg(args, "id")?).await?;
            Ok(format!("Discarded: {}", c.summary))
        }
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

pub(super) fn text_arg<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
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
pub(super) async fn deck_id(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<String> {
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

pub(super) async fn card_info(pool: &SqlitePool, cards: &[DeckCard]) -> AppResult<HashMap<String, Card>> {
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
pub(super) fn checks(cards: &[DeckCard], info: &HashMap<String, Card>) -> String {
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
pub(super) async fn near_names(pool: &SqlitePool, name: &str) -> AppResult<Vec<String>> {
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

// ── staged changes ──────────────────────────────────────────────────────────

async fn changes_text(pool: &SqlitePool, user: &User) -> AppResult<String> {
    let waiting = changes::list(pool, &user.id, true, None).await?;
    if waiting.is_empty() {
        return Ok("No changes are waiting for their review.".into());
    }
    let mut out = format!("{} change{} waiting for their review, newest first:\n", waiting.len(), if waiting.len() == 1 { " is" } else { "s are" });
    for c in waiting {
        let _ = write!(out, "- {} (id {}, staged {}", c.summary, c.id, c.created_at.get(..10).unwrap_or(&c.created_at));
        if let Some(e) = &c.error {
            let _ = write!(out, "; the last try to apply it failed: {e}");
        }
        out.push_str(")\n");
    }
    Ok(out)
}
