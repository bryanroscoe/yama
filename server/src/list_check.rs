//! Checking a list nobody has saved: the MCP tool `check_deck_list`, and the `/check` page that
//! anyone may use without an account (`POST /api/public/deck-check`; Bryan, 12 Nov 2026: "A lot
//! of these sites let you just type in decks… you can sign in to save stuff").
//!
//! Both read the list the same way ([`read`]: `decks::parse_list`, then each name looked up) and
//! check it with the rules a saved deck gets (`decks::validate`, the Game Changer and Reserve
//! List flags). The page gets more beside that: each card with its market price, the list's
//! market value and the deck analysis, from the functions the deck page and a shared deck's page
//! use.
//!
//! The public route:
//! - **binds no owner.** It takes no session and answers the same whoever asks, signed in or
//!   not: nothing of anyone's collection, decks, plans or stored checks is read, only card data
//!   and market prices.
//! - **stores nothing.** The list lives in the visitor's browser (`web/src/check/guestDeck.ts`)
//!   and comes back with each request. Request bodies are never logged (`request_log.rs`).
//! - **sends the list nowhere.** A saved deck is checked by Commander Spellbook in the
//!   background (`deck_checks.rs`); an anonymous list isn't, and no account's stored answer is
//!   read for it, so the analysis has no combos (`combos.checked` is false) and says so. The
//!   privacy page (`web/public/privacy/index.html`) states this.
//! - **is bounded.** [`MAX_BYTES`] of body, [`MAX_LINES`] lines, the caps a stored list has, two
//!   indexed lookups per line (the name, then the card's own name), a per-address limit
//!   (`Limits::public_deck_checks`) and one for every address together
//!   (`Limits::public_deck_checks_all`). It is off with `YAMA_GUEST_MODE=0`, like card search
//!   without an account.

use crate::cards::Card;
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use axum::extract::{DefaultBodyLimit, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;

/// Lines one unsaved list may have.
pub const MAX_LINES: usize = 300;
/// The public route's whole request, in bytes (a 100-card list with printings is about 4 KB).
pub const MAX_BYTES: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/public/deck-check", post(check).layer(DefaultBodyLimit::max(MAX_BYTES)))
}

/// An unsaved list, read: the cards Yama knows (merged per board, under their own names), the
/// names it doesn't, and the card data of the known ones.
pub struct Read {
    pub cards: Vec<DeckCard>,
    pub unknown: Vec<String>,
    pub info: HashMap<String, Card>,
}

/// Read a pasted list for checking. One card per line ("1 Sol Ring"), with the headings and
/// printing notes `decks::parse_list` understands; with no Commander heading,
/// `first_is_commander` makes the first card the commander.
pub async fn read(pool: &SqlitePool, text: &str, first_is_commander: bool) -> AppResult<Read> {
    if text.lines().count() > MAX_LINES {
        return Err(AppError::bad(format!("a list can be at most {MAX_LINES} lines")));
    }
    let lines = crate::decks::capped_lines(crate::decks::parse_list(text, first_is_commander))?;
    let parsed = crate::decks::resolve(pool, lines).await?;
    crate::decks::within_caps(&parsed.cards)?;
    let info = crate::decks::card_info(pool, &parsed.cards).await?;
    Ok(Read { cards: parsed.cards, unknown: parsed.unknown, info })
}

#[derive(Deserialize)]
struct CheckRequest {
    text: String,
    /// The commander (or two) the visitor picked on the page, by oracle id. Without it, a list
    /// with no Commander heading gets Yama's guess ([`guess_commander`]).
    #[serde(default)]
    commanders: Vec<String>,
}

/// The printing behind a card's market price, as the deck page names it.
#[derive(Serialize)]
struct Printing {
    scryfall_id: String,
    set_code: String,
    set_name: String,
    collector_number: String,
    date: String,
}

/// One card of the list, shaped like the deck page's entry without anything of an account's.
#[derive(Serialize)]
struct Entry {
    #[serde(flatten)]
    entry: DeckCard,
    card: Option<Card>,
    /// The cheapest eligible printing's market price; `None` when Yama has none (never 0).
    cheapest_usd: Option<f64>,
    cheapest_printing: Option<Printing>,
    produced_mana: Option<String>,
    /// It could be the commander, so the page can offer it.
    can_lead: bool,
}

#[derive(Serialize)]
struct ListCheck {
    cards: Vec<Entry>,
    /// Names that matched no card, as written. Not counted anywhere.
    unknown: Vec<String>,
    /// The list had no Commander heading and the visitor picked none: `cards` has Yama's guess,
    /// or no commander when it couldn't tell.
    commander_guessed: bool,
    validation: crate::decks::Validation,
    game_changers: Option<Vec<String>>,
    game_changers_as_of: Option<String>,
    reserved_list: Option<Vec<String>>,
    reserved_list_as_of: Option<String>,
    singles_value: crate::deck_prices::SinglesValue,
    /// `None` only for a list with no cards Yama knows.
    analysis: Option<crate::analysis::DeckAnalysis>,
}

/// With no Commander heading: the first card when it can lead a deck (the convention in most
/// lists), else the only card of the list that can. More than one candidate and none first is
/// left for the visitor to pick.
fn guess_commander(cards: &mut [DeckCard], info: &HashMap<String, Card>) {
    let can = |c: &DeckCard| c.board == Board::Main && c.qty == 1 && info.get(&c.oracle_id).is_some_and(crate::decks::can_lead);
    if cards.first().is_some_and(can) {
        cards[0].board = Board::Commander;
        return;
    }
    let able: Vec<usize> = (0..cards.len()).filter(|&i| can(&cards[i])).collect();
    if let [only] = able[..] {
        cards[only].board = Board::Commander;
    }
}

/// Make the picked cards the commanders: whatever the list called its commander goes back to the
/// main deck, and one copy of each picked card that is in the list leads it. A pick that isn't in
/// the list is ignored.
fn set_commanders(cards: Vec<DeckCard>, picked: &[String]) -> Vec<DeckCard> {
    let mut out: Vec<DeckCard> = Vec::with_capacity(cards.len() + picked.len());
    for mut c in cards {
        if c.board == Board::Commander {
            c.board = Board::Main;
        }
        match out.iter_mut().find(|x| x.oracle_id == c.oracle_id && x.board == c.board) {
            Some(same) => same.qty += c.qty,
            None => out.push(c),
        }
    }
    let mut leading: Vec<DeckCard> = Vec::new();
    for id in picked {
        if leading.iter().any(|c| &c.oracle_id == id) {
            continue;
        }
        let Some(at) = out.iter().position(|c| &c.oracle_id == id && c.board == Board::Main) else { continue };
        leading.push(DeckCard { board: Board::Commander, qty: 1, ..out[at].clone() });
        if out[at].qty > 1 {
            out[at].qty -= 1;
        } else {
            out.remove(at);
        }
    }
    leading.extend(out);
    leading
}

async fn check(State(st): State<AppState>, ClientAddress(address): ClientAddress, Json(req): Json<CheckRequest>) -> AppResult<Json<ListCheck>> {
    if !st.cfg.guest_mode {
        // Said to everyone alike: the route doesn't know whether the caller is signed in.
        return Err(AppError::Forbidden("Checking a deck without saving it is off right now. Import it into your decks instead.".into()));
    }
    // The address's own count first: one address at its limit doesn't use up everyone's.
    st.limits.public_deck_checks.check(&address_key(address))?;
    st.limits.public_deck_checks_all.check("all")?;
    if req.text.trim().is_empty() {
        return Err(AppError::bad("paste a deck list"));
    }
    if req.commanders.len() > 2 {
        return Err(AppError::bad("a deck has at most two commanders"));
    }
    Ok(Json(check_list(&st.pool, &req.text, &req.commanders).await?))
}

/// Everything the `/check` page shows for a list, from card data and market prices alone.
async fn check_list(pool: &SqlitePool, text: &str, picked: &[String]) -> AppResult<ListCheck> {
    // Only a Commander heading names the commander here; with none, the guess below.
    let Read { mut cards, unknown, info } = read(pool, text, false).await?;
    let marked = cards.iter().any(|c| c.board == Board::Commander);
    if !picked.is_empty() {
        cards = set_commanders(cards, picked);
    } else if !marked {
        guess_commander(&mut cards, &info);
    }
    let ids: Vec<&str> = cards.iter().map(|c| c.oracle_id.as_str()).collect();
    let cheapest = crate::deck_prices::cheapest_for(pool, &ids).await?;
    let singles_value = crate::deck_prices::singles(&serde_json::to_value(&cards).map_err(anyhow::Error::from)?, &crate::deck_prices::as_prices(&cheapest));
    let produced = crate::decks::produced_mana(pool, &ids).await?;
    let facts = crate::analysis::facts_for(&cards, &info, &produced);
    let analysis = cards.iter().any(|c| c.board != Board::Side && c.qty > 0).then(|| {
        let entries: Vec<crate::analysis::Entry> = cards.iter().map(|c| crate::analysis::Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
        // No Commander Spellbook check: an anonymous list is sent nowhere (module notes).
        let mut a = crate::analysis::analyze(&entries, None, &mut crate::analysis::Cache::default());
        crate::analysis::add_unresolved(&mut a, &unknown);
        a
    });
    let entries = cards
        .iter()
        .map(|c| {
            let card = info.get(&c.oracle_id);
            // A sideboard card is outside the deck's value, as on the deck page.
            let price = cheapest.get(&c.oracle_id).filter(|_| c.board != Board::Side);
            Entry {
                entry: c.clone(),
                card: card.cloned(),
                cheapest_usd: price.map(|p| p.usd),
                cheapest_printing: price.map(|p| Printing {
                    scryfall_id: p.scryfall_id.clone(),
                    set_code: p.set_code.clone(),
                    set_name: p.set_name.clone(),
                    collector_number: p.collector_number.clone(),
                    date: p.date.clone(),
                }),
                produced_mana: produced.get(&c.oracle_id).cloned().flatten(),
                can_lead: card.is_some_and(crate::decks::can_lead),
            }
        })
        .collect();
    Ok(ListCheck {
        validation: crate::decks::validate(&cards, &info),
        game_changers: crate::decks::game_changers(&cards, &info),
        game_changers_as_of: crate::cards::import::game_changers_date(pool).await?,
        reserved_list: crate::decks::reserved_list(&cards, &info),
        reserved_list_as_of: crate::cards::import::reserved_list_date(pool).await?,
        commander_guessed: picked.is_empty() && !marked,
        cards: entries,
        unknown,
        singles_value,
        analysis,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{app, config, send, state_with, user};
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    const PATH: &str = "/api/public/deck-check";

    async fn card(pool: &SqlitePool, oracle: &str, name: &str, type_line: &str, identity: &str, game_changer: bool) {
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, type_line, oracle_text, color_identity, legalities, game_changer, reserved, updated_at)
             VALUES (?, ?, ?, '', ?, '{\"commander\":\"legal\"}', ?, 0, 'now')",
        )
        .bind(oracle)
        .bind(name)
        .bind(type_line)
        .bind(identity)
        .bind(game_changer)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oracle).execute(pool).await.unwrap();
    }

    async fn cards(pool: &SqlitePool) {
        card(pool, "o-omo", "Omo, Queen of Vesuva", "Legendary Creature — Shapeshifter Noble", "GU", false).await;
        card(pool, "o-sol", "Sol Ring", "Artifact", "", false).await;
        card(pool, "o-tutor", "Demonic Tutor", "Sorcery", "B", true).await;
        card(pool, "o-forest", "Forest", "Basic Land — Forest", "G", false).await;
        card(pool, "o-tana", "Tana, the Bloodsower", "Legendary Creature — Elf Druid", "RG", false).await;
    }

    async fn check(app: &Router, body: Value) -> (StatusCode, Value) {
        send(app, Method::POST, PATH, None, Some(body)).await
    }

    fn boards(v: &Value) -> Vec<(String, i64, String)> {
        v["cards"].as_array().unwrap().iter().map(|c| (c["name"].as_str().unwrap().to_string(), c["qty"].as_i64().unwrap(), c["board"].as_str().unwrap().to_string())).collect()
    }

    #[tokio::test]
    async fn anyone_can_check_a_list_and_gets_legality_flags_value_and_analysis() {
        let (app, pool) = app().await;
        cards(&pool).await;
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
             VALUES ('p-sol', 'o-sol', 'Sol Ring', 'cmm', 'Commander Masters', '410', 'en', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO price_latest (scryfall_id, date, usd) VALUES ('p-sol', '2026-11-10', 1.5)").execute(&pool).await.unwrap();

        // No session at all.
        let (status, v) = check(&app, json!({ "text": "Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n1 Demonic Tutor\n97 Forest\n1 Not A Real Card" })).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        assert_eq!(boards(&v)[0], ("Omo, Queen of Vesuva".into(), 1, "commander".into()));
        assert_eq!(v["commander_guessed"], false, "the list named its commander");
        assert_eq!(v["unknown"], json!(["Not A Real Card"]));
        assert_eq!(v["validation"]["total"], 100);
        assert_eq!(v["validation"]["color_identity"], "UG");
        // Demonic Tutor is black: outside a blue-green commander's identity.
        assert_eq!(v["validation"]["ok"], false);
        assert!(v["validation"]["errors"].as_array().unwrap().iter().any(|e| e.as_str().unwrap().contains("Demonic Tutor is outside")), "{v}");
        assert_eq!(v["game_changers"], json!(["Demonic Tutor"]));
        assert_eq!(v["reserved_list"], json!([]));
        // A price has its date and printing; a card with none stays without (never 0).
        let sol = v["cards"].as_array().unwrap().iter().find(|c| c["name"] == "Sol Ring").unwrap();
        assert_eq!(sol["cheapest_usd"], 1.5);
        assert_eq!(sol["cheapest_printing"]["date"], "2026-11-10");
        assert_eq!(sol["cheapest_printing"]["set_code"], "cmm");
        let forest = v["cards"].as_array().unwrap().iter().find(|c| c["name"] == "Forest").unwrap();
        assert_eq!(forest["cheapest_usd"], Value::Null);
        assert_eq!(v["singles_value"]["usd"], 1.5);
        assert_eq!(v["singles_value"]["priced_copies"], 1);
        assert_eq!(v["singles_value"]["unpriced_copies"], 99);
        assert_eq!(v["singles_value"]["newest_date"], "2026-11-10");
        // The analysis is the deck page's, with no outside combo check behind it.
        assert!(v["analysis"]["power"].as_f64().is_some_and(|p| (1.0..=10.0).contains(&p)), "{v}");
        assert_eq!(v["analysis"]["combos"]["checked"], false);
        assert_eq!(v["analysis"]["unknown_cards"], json!(["Not A Real Card"]));
        assert_eq!(v["cards"][0]["can_lead"], true);
        assert_eq!(sol["can_lead"], false);
    }

    #[tokio::test]
    async fn the_commander_is_the_first_card_that_can_lead_the_only_one_that_can_or_the_visitors_pick() {
        let (app, pool) = app().await;
        cards(&pool).await;
        // First card can lead.
        let (_, v) = check(&app, json!({ "text": "1 Omo, Queen of Vesuva\n1 Sol Ring" })).await;
        assert_eq!(v["commander_guessed"], true);
        assert_eq!(boards(&v)[0], ("Omo, Queen of Vesuva".into(), 1, "commander".into()));
        // First card can't; exactly one other can.
        let (_, v) = check(&app, json!({ "text": "1 Sol Ring\n1 Omo, Queen of Vesuva\n3 Forest" })).await;
        assert_eq!(boards(&v), vec![("Sol Ring".into(), 1, "main".into()), ("Omo, Queen of Vesuva".into(), 1, "commander".into()), ("Forest".into(), 3, "main".into())]);
        // Two could, and neither is first: left to the visitor.
        let (_, v) = check(&app, json!({ "text": "1 Sol Ring\n1 Omo, Queen of Vesuva\n1 Tana, the Bloodsower" })).await;
        assert_eq!(v["commander_guessed"], true);
        assert!(boards(&v).iter().all(|c| c.2 == "main"), "{v}");
        assert!(v["validation"]["errors"].as_array().unwrap().contains(&json!("no commander chosen")));
        // Their pick wins over a heading, and a pick that isn't in the list changes nothing.
        let (_, v) = check(&app, json!({ "text": "Commander\n1 Omo, Queen of Vesuva\nDeck\n1 Tana, the Bloodsower\n1 Sol Ring", "commanders": ["o-tana", "o-nowhere"] })).await;
        assert_eq!(v["commander_guessed"], false);
        assert_eq!(boards(&v), vec![("Tana, the Bloodsower".into(), 1, "commander".into()), ("Omo, Queen of Vesuva".into(), 1, "main".into()), ("Sol Ring".into(), 1, "main".into())]);
        // A sideboard card is never the guess.
        let (_, v) = check(&app, json!({ "text": "1 Sol Ring\nSideboard\n1 Omo, Queen of Vesuva" })).await;
        assert!(boards(&v).iter().all(|c| c.2 != "commander"), "{v}");
    }

    /// The route takes no session: an account's own copies, decks and stored checks play no part,
    /// and nothing is written anywhere for the request.
    #[tokio::test]
    async fn a_check_reads_nothing_of_an_account_and_stores_nothing() {
        let (app, pool) = app().await;
        cards(&pool).await;
        let (owner, token) = user(&pool, "owner@example.com").await;
        // The owner saved this very list, and Commander Spellbook answered for it.
        let list = vec![
            DeckCard { oracle_id: "o-omo".into(), name: "Omo, Queen of Vesuva".into(), qty: 1, board: Board::Commander },
            DeckCard { oracle_id: "o-sol".into(), name: "Sol Ring".into(), qty: 1, board: Board::Main },
        ];
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Mine", None, list.clone()).await.unwrap();
        let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&deck).fetch_one(&pool).await.unwrap();
        let estimate = json!({ "bracketTag": "R", "cards": [], "combos": [] }).to_string();
        sqlx::query("UPDATE deck_version_checks SET bracket_tag = 'R', checked_at = requested_at, estimate = ?, list_hash = ? WHERE version_id = ?")
            .bind(&estimate)
            .bind(crate::deck_checks::list_hash(&list))
            .bind(&version)
            .execute(&pool)
            .await
            .unwrap();
        assert!(crate::deck_checks::stored_for_list(&pool, &list).await.unwrap().is_some(), "the owner's deck has a stored answer for this list");

        let counts = |pool: SqlitePool| async move {
            let mut out = Vec::new();
            for table in ["users", "sessions", "decks", "deck_versions", "deck_version_checks", "applied_ops", "collection_items"] {
                let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(&pool).await.unwrap();
                out.push((table, n));
            }
            out
        };
        let before = counts(pool.clone()).await;
        let body = json!({ "text": "Commander\n1 Omo, Queen of Vesuva\nDeck\n1 Sol Ring" });
        let (status, anonymous) = check(&app, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{anonymous}");
        // The same answer with the owner's session: the route doesn't look at who asks.
        let (_, as_owner) = send(&app, Method::POST, PATH, Some(&token), Some(body)).await;
        assert_eq!(anonymous, as_owner);
        assert_eq!(anonymous["analysis"]["combos"]["checked"], false, "the owner's stored Spellbook answer isn't read for an anonymous list");
        let text = anonymous.to_string();
        for private in ["owned", "locations", "proxies", "in_deck_container", "needed", "buylist", "share_token", "owner"] {
            assert!(!text.contains(&format!("\"{private}\"")), "the answer has no {private} field: {text}");
        }
        assert_eq!(counts(pool.clone()).await, before, "a check writes no row");
    }

    #[tokio::test]
    async fn a_check_is_bounded_in_size_lines_and_copies() {
        let (app, pool) = app().await;
        cards(&pool).await;
        let (status, v) = check(&app, json!({ "text": "   \n" })).await;
        assert_eq!((status, v["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "paste a deck list"));
        let (status, v) = check(&app, json!({ "text": "1 Sol Ring\n".repeat(MAX_LINES + 1) })).await;
        assert_eq!((status, v["error"].as_str().unwrap()), (StatusCode::BAD_REQUEST, "a list can be at most 300 lines"));
        let (status, v) = check(&app, json!({ "text": "5000 Forest" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
        let (status, v) = check(&app, json!({ "text": "1 Sol Ring", "commanders": ["a", "b", "c"] })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
        // The whole request is capped before it is read.
        let big = json!({ "text": "x".repeat(MAX_BYTES) }).to_string();
        let req = Request::builder().method(Method::POST).uri(PATH).header(header::CONTENT_TYPE, "application/json").body(Body::from(big)).unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
        // Reading only: the address has no GET.
        let (status, _) = send(&app, Method::GET, PATH, None, None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn checks_are_limited_per_address_and_off_with_guest_mode() {
        let pool = crate::db::test_pool().await;
        cards(&pool).await;
        let mut st = state_with(config(), pool.clone()).await;
        st.limits = std::sync::Arc::new(crate::limits::Limits { public_deck_checks: crate::limits::RateLimiter::new("deck checks from this address", 2, std::time::Duration::from_secs(600)), ..Default::default() });
        let app = crate::routes::app(st);
        let body = json!({ "text": "1 Sol Ring" });
        assert_eq!(check(&app, body.clone()).await.0, StatusCode::OK);
        // A refused request counts too: the limit is on asking.
        assert_eq!(check(&app, json!({ "text": "" })).await.0, StatusCode::BAD_REQUEST);
        let (status, v) = check(&app, body.clone()).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
        assert!(v["error"].as_str().unwrap().starts_with("Too many deck checks from this address."), "{v}");

        // Every address together has a ceiling too, and an address at its own limit doesn't
        // count toward it.
        let mut st = state_with(config(), pool.clone()).await;
        st.limits = std::sync::Arc::new(crate::limits::Limits { public_deck_checks_all: crate::limits::RateLimiter::new("deck checks on Yama just now", 1, std::time::Duration::from_secs(600)), ..Default::default() });
        let app = crate::routes::app(st);
        assert_eq!(check(&app, body.clone()).await.0, StatusCode::OK);
        let (status, v) = check(&app, body.clone()).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
        assert!(v["error"].as_str().unwrap().starts_with("Too many deck checks on Yama just now."), "{v}");

        // Off for everyone, signed in or not: the route never looks at a session.
        let mut cfg = config();
        cfg.guest_mode = false;
        let off = crate::routes::app(state_with(cfg, pool.clone()).await);
        let (_, token) = user(&pool, "someone@example.com").await;
        for who in [None, Some(token.as_str())] {
            let (status, v) = send(&off, Method::POST, PATH, who, Some(body.clone())).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{v}");
            assert_eq!(v["error"], "Checking a deck without saving it is off right now. Import it into your decks instead.");
        }
    }

    /// The MCP tool reads a list through the same function, so the two agree on what a list holds.
    #[tokio::test]
    async fn the_mcp_tool_and_the_page_read_a_list_the_same_way() {
        let pool = crate::db::test_pool().await;
        cards(&pool).await;
        let text = "Commander\n1 Omo, Queen of Vesuva\nDeck\n2x Forest (CMM) 410 *F*\n1 Forest\n1 Mystery Card";
        let r = read(&pool, text, true).await.unwrap();
        assert_eq!(r.cards.iter().map(|c| (c.name.as_str(), c.qty)).collect::<Vec<_>>(), vec![("Omo, Queen of Vesuva", 1), ("Forest", 3)]);
        assert_eq!(r.unknown, vec!["Mystery Card"]);
        assert!(r.info.contains_key("o-forest"));
        let page = check_list(&pool, text, &[]).await.unwrap();
        assert_eq!(page.cards.iter().map(|c| (c.entry.name.as_str(), c.entry.qty)).collect::<Vec<_>>(), vec![("Omo, Queen of Vesuva", 1), ("Forest", 3)]);
        assert_eq!(page.unknown, r.unknown);
        // Too many copies of one card is refused before anything is added up.
        assert!(read(&pool, "2000 Forest", true).await.is_err());
    }
}
