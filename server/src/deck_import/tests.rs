//! Deck import: every format's shape (fixtures in fixtures/), name matching, commanders, links,
//! printings kept with a deck, and privacy.

use super::formats::{Format, parse_any, parse_text};
use crate::decks::Board;
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

fn board_of<'a>(p: &'a super::formats::Parsed, name: &str) -> Option<&'a super::formats::ImportLine> {
    p.decks[0].lines.iter().find(|l| l.name == name)
}

#[test]
fn moxfield_export_keeps_printings_foils_and_the_sideboard() {
    let p = parse_any(include_str!("fixtures/moxfield.txt"), None);
    assert_eq!(p.format, Format::Moxfield);
    let d = &p.decks[0];
    assert_eq!(d.lines.len(), 6);
    let signet = board_of(&p, "Arcane Signet").unwrap();
    assert_eq!((signet.set_code.as_deref(), signet.collector_number.as_deref(), signet.finish.as_deref()), (Some("cmm"), Some("371"), Some("foil")));
    assert_eq!(board_of(&p, "Sol Ring").unwrap().finish.as_deref(), Some("etched"));
    assert_eq!(board_of(&p, "Swords to Plowshares").unwrap().board, Board::Side);
    assert!(board_of(&p, "Delver of Secrets // Insectile Aberration").is_some());
    // No commander section: the preview guesses from the cards (see the route test).
    assert!(!d.commander_marked);
}

#[test]
fn arena_style_exports_have_sections_a_name_and_a_companion() {
    let p = parse_any(include_str!("fixtures/moxfield-mtga.txt"), None);
    assert!(p.decks[0].commander_marked);
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);
    assert_eq!(board_of(&p, "Sol Ring").unwrap().board, Board::Main);

    let p = parse_any(include_str!("fixtures/arena.txt"), None);
    assert_eq!(p.format, Format::Arena);
    assert_eq!(p.decks[0].name.as_deref(), Some("Atraxa Superfriends"));
    assert_eq!(board_of(&p, "Island").unwrap().qty, 4);
    assert_eq!(board_of(&p, "Lurrus of the Dream-Den").unwrap().board, Board::Side, "a companion sits outside the deck");
    assert_eq!(board_of(&p, "Swords to Plowshares").unwrap().board, Board::Side);
    assert!(p.skipped.is_empty(), "{:?}", p.skipped);
}

#[test]
fn archidekt_categories_mark_commander_side_and_maybe() {
    let p = parse_any(include_str!("fixtures/archidekt.txt"), None);
    assert_eq!(p.format, Format::Archidekt);
    let atraxa = board_of(&p, "Atraxa, Praetors' Voice").unwrap();
    assert_eq!((atraxa.board.clone(), atraxa.set_code.as_deref(), atraxa.collector_number.as_deref()), (Board::Commander, Some("2x2"), Some("190")));
    assert_eq!(board_of(&p, "Sol Ring").unwrap().board, Board::Main);
    let signet = board_of(&p, "Arcane Signet").unwrap();
    assert_eq!((signet.board.clone(), signet.finish.as_deref()), (Board::Main, Some("foil")));
    let greaves = board_of(&p, "Lightning Greaves").unwrap();
    assert!(greaves.maybe && greaves.board == Board::Side);
    let swords = board_of(&p, "Swords to Plowshares").unwrap();
    assert!(!swords.maybe && swords.board == Board::Side);
    // A category without a printing in front is still a category, a code with digits a printing.
    let p = parse_text("1x Sol Ring [Ramp]\n1x Arcane Signet [C21]\n1 Command Tower [CMM#414]");
    assert_eq!(board_of(&p, "Sol Ring").unwrap().set_code, None);
    assert_eq!(board_of(&p, "Arcane Signet").unwrap().set_code.as_deref(), Some("c21"));
    let tower = board_of(&p, "Command Tower").unwrap();
    assert_eq!((tower.set_code.as_deref(), tower.collector_number.as_deref()), (Some("cmm"), Some("414")));
}

#[test]
fn tappedout_and_deckstats_tags() {
    let p = parse_any(include_str!("fixtures/tappedout.txt"), None);
    assert_eq!(p.format, Format::TappedOut);
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);
    assert_eq!(board_of(&p, "Arcane Signet").unwrap().finish.as_deref(), Some("foil"));

    let p = parse_any(include_str!("fixtures/deckstats.txt"), None);
    assert_eq!(p.format, Format::Deckstats);
    let atraxa = board_of(&p, "Atraxa, Praetors' Voice").unwrap();
    assert_eq!((atraxa.board.clone(), atraxa.set_code.as_deref(), atraxa.collector_number.as_deref()), (Board::Commander, Some("2x2"), Some("190")));
    assert_eq!(board_of(&p, "Swords to Plowshares").unwrap().board, Board::Side);
}

#[test]
fn mtgo_lists_and_files_put_the_commander_after_a_blank_line() {
    let p = parse_any(include_str!("fixtures/mtgo.txt"), None);
    assert_eq!(p.format, Format::MtgoText);
    let atraxa = board_of(&p, "Atraxa, Praetors' Voice").unwrap();
    assert_eq!(atraxa.board, Board::Commander);
    assert!(!atraxa.marked_commander, "a guess, checked once names are matched");

    let p = parse_any(include_str!("fixtures/mtgo.dek"), Some("Atraxa Superfriends.dek"));
    assert_eq!(p.format, Format::MtgoDek);
    assert_eq!(p.decks[0].name.as_deref(), Some("Atraxa Superfriends"));
    assert_eq!(board_of(&p, "Island").unwrap().qty, 97);
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);

    // A short block after a blank line is a sideboard; many blocks are a hand-grouped list.
    let p = parse_text(&format!("{}\n\n1 Swords to Plowshares\n1 Lightning Greaves", "50 Island"));
    assert_eq!(board_of(&p, "Swords to Plowshares").unwrap().board, Board::Side);
    let p = parse_text("1 Sol Ring\n1 Arcane Signet\n\n1 Island\n\n1 Swords to Plowshares");
    assert!(p.decks[0].lines.iter().all(|l| l.board == Board::Main));
    // The commander alone first, then the deck (EDHREC and others).
    let p = parse_text("1 Atraxa, Praetors' Voice\n\n95 Island\n1 Sol Ring");
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);
}

#[test]
fn plain_lists_and_headers() {
    let p = parse_text("Sol Ring\n2x Island\nx3 Swamp\n1\tArcane Signet\nCreatures (2)\n1 Commander's Sphere (CMR) 306\n// a comment\n");
    assert_eq!(board_of(&p, "Sol Ring").unwrap().qty, 1);
    assert_eq!(board_of(&p, "Island").unwrap().qty, 2);
    assert_eq!(board_of(&p, "Swamp").unwrap().qty, 3);
    assert_eq!(board_of(&p, "Arcane Signet").unwrap().qty, 1);
    // "Commander's Sphere" is a card, not a Commander header.
    let sphere = board_of(&p, "Commander's Sphere").unwrap();
    assert_eq!((sphere.board.clone(), sphere.set_code.as_deref()), (Board::Main, Some("cmr")));
    assert!(!p.decks[0].commander_marked);
    // A card name with parentheses that aren't a printing stays whole.
    let p = parse_text("1 B.F.M. (Big Furry Monster)");
    assert_eq!(p.decks[0].lines[0].name, "B.F.M. (Big Furry Monster)");
    // Windows line endings and a byte-order mark.
    let p = parse_any("\u{feff}Commander\r\n1 Atraxa, Praetors' Voice\r\nDeck\r\n1 Sol Ring\r\n", Some("my_deck.txt"));
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);
    assert_eq!(p.decks[0].name.as_deref(), Some("my deck"));
}

#[test]
fn csv_exports_by_their_columns() {
    let p = parse_any(include_str!("fixtures/moxfield.csv"), Some("deck.csv"));
    assert_eq!(p.format, Format::Csv);
    let atraxa = board_of(&p, "Atraxa, Praetors' Voice").unwrap();
    assert_eq!((atraxa.set_code.as_deref(), atraxa.collector_number.as_deref(), atraxa.finish.as_deref()), (Some("2x2"), Some("190"), Some("foil")));

    let p = parse_any(include_str!("fixtures/manabox.csv"), None);
    assert_eq!(board_of(&p, "Sol Ring").unwrap().finish.as_deref(), Some("etched"));
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().finish, None);

    // Mythic Tools: one deck per "deck" container; boxes are left out.
    let p = parse_any(include_str!("fixtures/mythic.csv"), Some("mythic-tools-export.csv"));
    assert_eq!(p.decks.len(), 2);
    assert_eq!(p.decks[0].name.as_deref(), Some("Atraxa"));
    assert_eq!(p.decks[0].lines.len(), 2);
    assert_eq!(p.decks[1].name.as_deref(), Some("Second deck"));
    assert!(p.decks.iter().all(|d| d.lines.iter().all(|l| l.name != "Island")));

    // A collection export with no deck containers says where to take it.
    let boxes = "Card Name,English Name,Set Code,Collector Number,Quantity,Finish,Container Type,Container Name\nSol Ring,Sol Ring,c21,263,1,nonfoil,box,bulk\n";
    let p = parse_any(boxes, Some("export.csv"));
    assert!(p.decks.is_empty());
    assert!(p.skipped[0].contains("Collection page"));
}

#[test]
fn archidekt_json() {
    let p = parse_any(include_str!("fixtures/archidekt.json"), None);
    assert_eq!(p.format, Format::ArchidektJson);
    assert_eq!(p.decks[0].name.as_deref(), Some("Atraxa Superfriends"));
    assert_eq!(board_of(&p, "Atraxa, Praetors' Voice").unwrap().board, Board::Commander);
    assert_eq!(board_of(&p, "Sol Ring").unwrap().finish.as_deref(), Some("foil"));
    assert!(board_of(&p, "Lightning Greaves").unwrap().maybe);
}

// ── through the route, with cards in the database ──────────────────────────

async fn card(pool: &SqlitePool, oid: &str, name: &str, type_line: &str, ci: &str, text: &str, aliases: &[&str], layout: &str) {
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, oracle_text, layout, image_small, image_normal, updated_at) VALUES (?,?,?,?,?,?,?,?, 'now')")
        .bind(oid)
        .bind(name)
        .bind(type_line)
        .bind(ci)
        .bind(text)
        .bind(layout)
        .bind(format!("https://img/{oid}-small.jpg"))
        .bind(format!("https://img/{oid}.jpg"))
        .execute(pool)
        .await
        .unwrap();
    for n in std::iter::once(&name).chain(aliases.iter()) {
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(n).bind(oid).execute(pool).await.unwrap();
    }
}

async fn seed(pool: &SqlitePool) {
    card(pool, "o-atraxa", "Atraxa, Praetors' Voice", "Legendary Creature — Phyrexian Angel Horror", "WUBG", "Flying, vigilance, deathtouch, lifelink", &[], "normal").await;
    card(pool, "o-unifier", "Atraxa, Grand Unifier", "Legendary Creature — Phyrexian Angel", "WUBG", "Flying", &[], "normal").await;
    card(pool, "o-sol", "Sol Ring", "Artifact", "", "{T}: Add {C}{C}.", &[], "normal").await;
    card(pool, "o-signet", "Arcane Signet", "Artifact", "", "", &[], "normal").await;
    card(pool, "o-tower", "Command Tower", "Land", "", "", &[], "normal").await;
    card(pool, "o-island", "Island", "Basic Land — Island", "U", "", &[], "normal").await;
    card(pool, "o-swords", "Swords to Plowshares", "Instant", "W", "", &[], "normal").await;
    card(pool, "o-vault", "Lim-Dûl's Vault", "Instant", "UB", "", &[], "normal").await;
    card(pool, "o-fire", "Fire // Ice", "Instant // Instant", "UR", "", &["Fire", "Ice"], "split").await;
    card(pool, "o-rats", "Relentless Rats", "Creature — Rat", "B", "A deck can have any number of cards named Relentless Rats.", &[], "normal").await;
    card(pool, "o-soldier", "Soldier", "Token Creature — Soldier", "W", "", &[], "token").await;
    sqlx::query(
        "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, image_normal, updated_at)
         VALUES ('p-sol', 'o-sol', 'Sol Ring', 'c21', 'Commander 2021', '263', 'en', '[\"nonfoil\"]', 'https://img/p-sol.jpg', 'now')",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn preview(app: &axum::Router, token: &str, text: &str) -> (StatusCode, Value) {
    send(app, Method::POST, "/api/decks/import/preview", Some(token), Some(json!({ "text": text }))).await
}

fn card_in<'a>(deck: &'a Value, name: &str) -> &'a Value {
    deck["cards"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name} not in {deck}"))
}

#[tokio::test]
async fn preview_matches_names_forgivingly_and_suggests_the_rest() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (_, token) = user(&pool, "a@example.com").await;
    let (status, body) = preview(&app, &token, "1 Atraxa, Praetors' Voice\n1 sol ring\n1 Lim-Dul’s Vault\n1 Fire/Ice\n1 Sol Rnig\n1 Atraxa\n1 Soldier\n1 Zzzzzz Qqqq").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let d = &body["decks"][0];
    // Any case, accents, curly quotes and split-card spellings match.
    assert_eq!(card_in(d, "Sol Ring")["qty"], 1);
    assert_eq!(card_in(d, "Lim-Dûl's Vault")["written_as"], "Lim-Dul’s Vault");
    assert_eq!(card_in(d, "Fire // Ice")["oracle_id"], "o-fire");
    let unknown = d["unknown"].as_array().unwrap();
    let find = |n: &str| unknown.iter().find(|u| u["name"] == n).unwrap_or_else(|| panic!("{n} not unknown in {d}"));
    // A typo gets the card; a short name gets the cards it starts.
    assert_eq!(find("Sol Rnig")["suggestions"][0]["name"], "Sol Ring");
    let atraxas: Vec<&str> = find("Atraxa")["suggestions"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert!(atraxas.contains(&"Atraxa, Praetors' Voice") && atraxas.contains(&"Atraxa, Grand Unifier"), "{atraxas:?}");
    // Tokens aren't deck cards.
    assert_eq!(find("Soldier")["suggestions"].as_array().unwrap().len(), 0);
    assert_eq!(find("Zzzzzz Qqqq")["suggestions"].as_array().unwrap().len(), 0);
    // The first card leads the deck when nothing said otherwise, as a guess to confirm.
    assert_eq!(card_in(d, "Atraxa, Praetors' Voice")["board"], "commander");
    assert_eq!(d["commander_guessed"], true);
    assert_eq!(d["commander_marked"], false);
}

#[tokio::test]
async fn preview_commanders_printings_and_card_facts() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (_, token) = user(&pool, "a@example.com").await;
    // MTGO: the card after the blank line leads the deck only if it can.
    let (_, body) = preview(&app, &token, "1 Sol Ring\n97 Island\n1 Command Tower\n\n1 Atraxa, Praetors' Voice").await;
    let d = &body["decks"][0];
    assert_eq!(card_in(d, "Atraxa, Praetors' Voice")["board"], "commander");
    assert_eq!(d["commander_guessed"], true);
    assert_eq!(body["format"], "mtgo_text");
    let (_, body) = preview(&app, &token, "1 Arcane Signet\n97 Island\n1 Command Tower\n\n1 Swords to Plowshares").await;
    let d = &body["decks"][0];
    assert_eq!(card_in(d, "Swords to Plowshares")["board"], "main", "an instant can't lead a deck");
    assert_eq!(d["commander_guessed"], false);
    // No marks, the first card can't lead, but exactly one card can: that's the guess.
    let (_, body) = preview(&app, &token, "1 Sol Ring\n1 Atraxa, Praetors' Voice\n98 Island").await;
    let d = &body["decks"][0];
    assert_eq!(card_in(d, "Atraxa, Praetors' Voice")["board"], "commander");
    assert_eq!(d["commander_guessed"], true);
    // Two that could: the person picks.
    let (_, body) = preview(&app, &token, "1 Sol Ring\n1 Atraxa, Praetors' Voice\n1 Atraxa, Grand Unifier\n97 Island").await;
    assert!(body["decks"][0]["cards"].as_array().unwrap().iter().all(|c| c["board"] != "commander"));
    // Printings: found ones bring their image; unknown ones are flagged, never dropped.
    let (_, body) = preview(&app, &token, "Commander\n1 Atraxa, Praetors' Voice (2X2) 190\nDeck\n1 Sol Ring (C21) 263 *F*\n1 Arcane Signet (ZZZ) 1\n2 Relentless Rats\n3 Island").await;
    let d = &body["decks"][0];
    assert_eq!(d["commander_marked"], true);
    let sol = card_in(d, "Sol Ring");
    assert_eq!((sol["print_found"].as_bool(), sol["print_image"].as_str(), sol["finish"].as_str()), (Some(true), Some("https://img/p-sol.jpg"), Some("foil")));
    assert_eq!(card_in(d, "Arcane Signet")["print_found"], false);
    assert_eq!(card_in(d, "Relentless Rats")["any_number"], true);
    assert_eq!(card_in(d, "Island")["any_number"], true);
    assert_eq!(card_in(d, "Atraxa, Praetors' Voice")["can_be_commander"], true);
    assert_eq!(card_in(d, "Atraxa, Praetors' Voice")["color_identity"], "WUBG");
}

#[tokio::test]
async fn links_explain_what_to_do_and_nothing_is_fetched_by_default() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (_, token) = user(&pool, "a@example.com").await;
    let (status, body) = preview(&app, &token, "https://www.moxfield.com/decks/abcDEF123").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["link"]["site"], "moxfield");
    assert_eq!(body["link"]["fetched"], false);
    assert!(body["link"]["message"].as_str().unwrap().contains("Copy the list"));
    assert_eq!(body["decks"].as_array().unwrap().len(), 0);
    if std::env::var("YAMA_DECK_LINK_SOURCES").is_err() {
        let (_, body) = preview(&app, &token, "https://archidekt.com/decks/1234567/atraxa").await;
        assert_eq!((body["link"]["site"].as_str(), body["link"]["fetched"].as_bool()), (Some("archidekt"), Some(false)));
    }
}

#[tokio::test]
async fn preview_refuses_empty_huge_and_signed_out() {
    let (app, pool) = app().await;
    let (_, token) = user(&pool, "a@example.com").await;
    assert_eq!(preview(&app, &token, "   ").await.0, StatusCode::BAD_REQUEST);
    // Over the 2 MB request limit: refused before it's read.
    let big = preview(&app, &token, &"1 Island\n".repeat(300_000)).await.0;
    assert!(big == StatusCode::BAD_REQUEST || big == StatusCode::PAYLOAD_TOO_LARGE, "{big}");
    let (status, _) = send(&app, Method::POST, "/api/decks/import/preview", None, Some(json!({ "text": "1 Island" }))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn printings_are_kept_with_the_deck_and_used_for_exports() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (_, token) = user(&pool, "a@example.com").await;
    let cards = json!([
        {"oracle_id": "o-atraxa", "name": "Atraxa, Praetors' Voice", "qty": 1, "board": "commander"},
        {"oracle_id": "o-sol", "name": "Sol Ring", "qty": 1, "board": "main"},
    ]);
    let prints = json!([{"oracle_id": "o-sol", "set_code": "C21", "collector_number": "263", "finish": "foil"}]);
    let (status, created) = send(&app, Method::POST, "/api/decks", Some(&token), Some(json!({ "name": "Atraxa", "cards": cards, "prints": prints }))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    let (_, deck) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&token), None).await;
    let sol = deck["cards"].as_array().unwrap().iter().find(|c| c["name"] == "Sol Ring").unwrap();
    assert_eq!(sol["printing"], json!({"set_code": "c21", "collector_number": "263", "finish": "foil", "from": "chosen"}));
    // A new version can change it.
    let prints = json!([{"oracle_id": "o-sol", "set_code": "cmm", "collector_number": "410", "finish": "nonfoil"}]);
    let (status, _) = send(&app, Method::PUT, &format!("/api/decks/{id}"), Some(&token), Some(json!({ "cards": cards, "note": "imported", "prints": prints }))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, deck) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&token), None).await;
    let sol = deck["cards"].as_array().unwrap().iter().find(|c| c["name"] == "Sol Ring").unwrap();
    assert_eq!(sol["printing"]["set_code"], "cmm");
    // Someone else can't write printings (or anything) into this deck.
    let (_, other) = user(&pool, "b@example.com").await;
    let (status, _) = send(&app, Method::PUT, &format!("/api/decks/{id}"), Some(&other), Some(json!({ "cards": cards, "prints": prints }))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_prints WHERE deck_id = ?").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1);
}
