//! Browse (`/api/public/browse`): what is listed, in what order, and the filters.
use super::browse::{Filter, listed};
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, send, user};
use axum::Router;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

async fn seed_cards(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO cards(oracle_id,name,type_line,color_identity,legalities,image_art_crop,image_normal,artist,updated_at) VALUES
         ('atraxa','Atraxa, Praetors'' Voice','Legendary Creature','WUBG','{}','https://cards.scryfall.io/art/atraxa.jpg',NULL,'Victor Adame Minguez','now'),
         ('krenko','Krenko, Mob Boss','Legendary Creature','R','{}','https://cards.scryfall.io/art/krenko.jpg',NULL,'Karl Kopinski','now'),
         ('karn','Karn, Silver Golem','Legendary Artifact Creature','','{}','https://example.com/not-scryfall.jpg',NULL,'Mark Zug','now')",
    )
    .execute(pool)
    .await
    .unwrap();
    // A precon led by Krenko: forty cards of its own and ten Mountains.
    let mut cards = vec![json!({"name": "Krenko, Mob Boss", "oracle_id": "krenko", "qty": 1, "board": "commander"})];
    cards.extend((1..40).map(|i| json!({"name": format!("Goblin {i:02}"), "oracle_id": format!("goblin-{i:02}"), "qty": 1, "board": "main"})));
    cards.push(json!({"name": "Mountain", "oracle_id": "mountain", "qty": 10, "board": "main"}));
    sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at) VALUES ('goblin-precon','precons/goblin-precon','Goblin Precon','CMD','[\"Krenko, Mob Boss\"]','R',?,'test','sha','2026-10-27T00:00:00Z')")
        .bind(Value::Array(cards).to_string())
        .execute(pool)
        .await
        .unwrap();
}

fn card(oracle: &str, name: &str, board: Board) -> DeckCard {
    DeckCard { oracle_id: oracle.into(), name: name.into(), qty: 1, board }
}

/// `kept` of the precon's own cards after the commander, then enough other cards for 50.
fn krenko_list(kept: usize) -> Vec<DeckCard> {
    let mut cards = vec![card("krenko", "Krenko, Mob Boss", Board::Commander)];
    cards.extend((1..=kept).map(|i| card(&format!("goblin-{i:02}"), &format!("Goblin {i:02}"), Board::Main)));
    cards.extend((cards.len()..40).map(|i| card(&format!("brew-{i:02}"), &format!("Brew {i:02}"), Board::Main)));
    cards.push(DeckCard { oracle_id: "mountain".into(), name: "Mountain".into(), qty: 10, board: Board::Main });
    cards
}

/// An account with a handle whose public decks are listed. Returns (id, token).
async fn lister(app: &Router, pool: &SqlitePool, handle: &str) -> (String, String) {
    let (id, auth) = user(pool, &format!("{handle}@example.com")).await;
    assert_eq!(send(app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": handle }))).await.0, StatusCode::OK);
    super::list_publicly(pool, &id).await.unwrap();
    (id, auth)
}

/// A deck saved at `saved` and shared as `visibility`. Returns its id.
async fn deck(app: &Router, pool: &SqlitePool, owner: &(String, String), name: &str, cards: Vec<DeckCard>, visibility: &str, saved: &str) -> String {
    let id = crate::decks::create_deck_with_cards(pool, &owner.0, name, None, cards).await.unwrap();
    sqlx::query("UPDATE deck_versions SET created_at = ? WHERE deck_id = ?").bind(saved).bind(&id).execute(pool).await.unwrap();
    assert_eq!(send(app, Method::PATCH, &format!("/api/decks/{id}"), Some(&owner.1), Some(json!({ "visibility": visibility }))).await.0, StatusCode::OK);
    id
}

/// The names on a page of Browse, signed out.
async fn names(app: &Router, query: &str) -> Vec<String> {
    let (status, body) = send(app, Method::GET, &format!("/api/public/browse{query}"), None, None).await;
    assert_eq!(status, StatusCode::OK, "{query}: {body}");
    body["decks"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn browse_lists_only_what_is_listed_publicly_newest_first() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    let atraxa = || vec![card("atraxa", "Atraxa, Praetors' Voice", Board::Commander), card("x", "Some Card", Board::Main)];
    let first = deck(&app, &pool, &ann, "Atraxa Counters", atraxa(), "public", "2026-11-01T00:00:00Z").await;
    deck(&app, &pool, &ann, "By link only", atraxa(), "link", "2026-11-02T00:00:00Z").await;
    deck(&app, &pool, &ann, "Private", atraxa(), "private", "2026-11-03T00:00:00Z").await;
    let second = deck(&app, &pool, &ann, "Krenko Goblins", krenko_list(0), "public", "2026-11-04T00:00:00Z").await;
    // An account from before public-by-default that hasn't answered: public means its profile only.
    let old = user(&pool, "old@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&old.1), Some(json!({ "handle": "oldtimer" }))).await;
    deck(&app, &pool, &old, "Old meaning of public", atraxa(), "public", "2026-11-05T00:00:00Z").await;
    // A new account without a handle yet: public by link until it picks one.
    let nameless = user(&pool, "nameless@example.com").await;
    super::list_publicly(&pool, &nameless.0).await.unwrap();
    deck(&app, &pool, &nameless, "No handle yet", atraxa(), "public", "2026-11-06T00:00:00Z").await;

    // Signed out: only the listed decks, the newest list first, with what a tile shows.
    let (status, body) = send(&app, Method::GET, "/api/public/browse", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((&body["total"], &body["page"], &body["pages"]), (&json!(2), &json!(0), &json!(1)));
    let decks = body["decks"].as_array().unwrap();
    assert_eq!(decks.iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["Krenko Goblins", "Atraxa Counters"]);
    let tile = &decks[1];
    assert_eq!(tile["handle"], "ann");
    assert_eq!(tile["commanders"], json!(["Atraxa, Praetors' Voice"]));
    assert_eq!(tile["color_identity"], "WUBG");
    assert_eq!(tile["card_count"], 2);
    assert_eq!(tile["updated_at"], "2026-11-01T00:00:00Z");
    // The art is shown only with its artist, for the credit.
    assert_eq!(tile["art"], json!({ "url": "https://cards.scryfall.io/art/atraxa.jpg", "artist": "Victor Adame Minguez", "card": "Atraxa, Praetors' Voice" }));
    let token: String = sqlx::query_scalar("SELECT share_token FROM decks WHERE id = ?").bind(&first).fetch_one(&pool).await.unwrap();
    assert_eq!(tile["token"], token.as_str());
    // Nothing of the account but its handle.
    let text = body.to_string();
    for private in [ann.0.as_str(), "ann@example.com", first.as_str(), second.as_str()] {
        assert!(!text.contains(private), "the listing must not carry {private}");
    }

    // Once the owner agrees, the old account's public deck is listed; once the other picks a handle, so is theirs.
    super::list_publicly(&pool, &old.0).await.unwrap();
    send(&app, Method::PUT, "/api/me/sharing", Some(&nameless.1), Some(json!({ "handle": "named" }))).await;
    assert_eq!(names(&app, "").await, ["No handle yet", "Old meaning of public", "Krenko Goblins", "Atraxa Counters"]);

    // Leaving the listing takes effect at once: made private, taken down, archived, account turned off.
    send(&app, Method::PATCH, &format!("/api/decks/{second}"), Some(&ann.1), Some(json!({ "visibility": "link" }))).await;
    assert_eq!(names(&app, "").await, ["No handle yet", "Old meaning of public", "Atraxa Counters"]);
    sqlx::query("UPDATE decks SET taken_down_at = '2026-11-12T00:00:00Z' WHERE id = ?").bind(&first).execute(&pool).await.unwrap();
    assert_eq!(names(&app, "").await, ["No handle yet", "Old meaning of public"]);
    sqlx::query("UPDATE users SET disabled_at = '2026-11-12T00:00:00Z' WHERE id = ?").bind(&old.0).execute(&pool).await.unwrap();
    sqlx::query("UPDATE decks SET archived = 1 WHERE owner_id = ?").bind(&nameless.0).execute(&pool).await.unwrap();
    assert_eq!(names(&app, "").await, Vec::<String>::new());
    let (_, empty) = send(&app, Method::GET, "/api/public/browse?page=7", None, None).await;
    assert_eq!((&empty["total"], &empty["page"], &empty["pages"]), (&json!(0), &json!(0), &json!(1)));
}

#[tokio::test]
async fn a_configuration_is_listed_only_when_its_main_deck_is_not() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    let main = deck(&app, &pool, &ann, "Goblins", krenko_list(0), "public", "2026-11-01T00:00:00Z").await;
    let stock = deck(&app, &pool, &ann, "Goblins (stock)", krenko_list(39), "public", "2026-11-02T00:00:00Z").await;
    sqlx::query("UPDATE decks SET parent_id = ?, configuration = 'stock' WHERE id = ?").bind(&main).bind(&stock).execute(&pool).await.unwrap();
    assert_eq!(names(&app, "").await, ["Goblins"]);
    send(&app, Method::PATCH, &format!("/api/decks/{main}"), Some(&ann.1), Some(json!({ "visibility": "private" }))).await;
    assert_eq!(names(&app, "").await, ["Goblins (stock)"]);
}

#[tokio::test]
async fn browse_filters_by_commander_colors_bracket_precon_and_search() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    let bob = lister(&app, &pool, "bob").await;
    let atraxa = deck(&app, &pool, &ann, "Counters 100%", vec![card("atraxa", "Atraxa, Praetors' Voice", Board::Commander)], "public", "2026-11-01T00:00:00Z").await;
    // Thirty of the precon's forty own cards are still in it: it started from the precon.
    let upgraded = deck(&app, &pool, &bob, "Upgraded goblins", krenko_list(29), "public", "2026-11-02T00:00:00Z").await;
    // Five in common is a brew that shares staples, not the precon.
    deck(&app, &pool, &bob, "Faggot goblin brew", krenko_list(5), "public", "2026-11-03T00:00:00Z").await;
    deck(&app, &pool, &ann, "Golem", vec![card("karn", "Karn, Silver Golem", Board::Commander)], "public", "2026-11-04T00:00:00Z").await;
    send(&app, Method::PATCH, &format!("/api/decks/{atraxa}"), Some(&ann.1), Some(json!({ "bracket": 3 }))).await;
    send(&app, Method::PATCH, &format!("/api/decks/{upgraded}"), Some(&bob.1), Some(json!({ "bracket": 2 }))).await;

    // The name goes through the public text filter.
    assert_eq!(names(&app, "").await, ["Golem", "*** goblin brew", "Upgraded goblins", "Counters 100%"]);
    // Search: part of a deck's name or a commander's, whatever its case; LIKE's own characters are just characters.
    assert_eq!(names(&app, "?q=GOBLINS").await, ["Upgraded goblins"]);
    assert_eq!(names(&app, "?q=mob%20boss").await, ["*** goblin brew", "Upgraded goblins"]);
    assert_eq!(names(&app, "?q=100%25").await, ["Counters 100%"]);
    assert_eq!(names(&app, "?q=_").await, Vec::<String>::new());
    // The name is searched as its tile shows it: a word the filter masks finds nothing.
    assert_eq!(names(&app, "?q=faggot").await, Vec::<String>::new());
    assert_eq!(names(&app, "?q=goblin%20brew").await, ["*** goblin brew"]);
    // Commander: part of a commander's name only.
    assert_eq!(names(&app, "?commander=atraxa").await, ["Counters 100%"]);
    assert_eq!(names(&app, "?commander=goblins").await, Vec::<String>::new());
    // Colors: decks whose identity includes every color asked for, in any order; C alone is colorless.
    assert_eq!(names(&app, "?colors=r").await, ["*** goblin brew", "Upgraded goblins"]);
    assert_eq!(names(&app, "?colors=GBUW").await, ["Counters 100%"]);
    assert_eq!(names(&app, "?colors=WU").await, ["Counters 100%"]);
    assert_eq!(names(&app, "?colors=RG").await, Vec::<String>::new());
    assert_eq!(names(&app, "?colors=C").await, ["Golem"]);
    // Bracket: as declared.
    assert_eq!(names(&app, "?bracket=3").await, ["Counters 100%"]);
    assert_eq!(names(&app, "?bracket=2&colors=R").await, ["Upgraded goblins"]);
    // Started from a precon: any, or one.
    assert_eq!(names(&app, "?precon=any").await, ["Upgraded goblins"]);
    assert_eq!(names(&app, "?precon=goblin-precon").await, ["Upgraded goblins"]);
    assert_eq!(names(&app, "?precon=another-precon").await, Vec::<String>::new());
    // A reprint with the same hundred cards shares the first printing's decks.
    sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,same_list_as) SELECT 'goblin-reprint','precons/goblin-reprint','Goblin Reprint',set_code,commanders,color_identity,cards,source,content_sha256,imported_at,'goblin-precon' FROM precons WHERE id = 'goblin-precon'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(names(&app, "?precon=goblin-reprint").await, ["Upgraded goblins"]);
    let (_, body) = send(&app, Method::GET, "/api/public/browse?precon=any", None, None).await;
    assert_eq!(body["decks"][0]["precon"], json!({ "id": "goblin-precon", "name": "Goblin Precon" }));
    assert_eq!(body["decks"][0]["bracket"], 2);
    let (_, body) = send(&app, Method::GET, "/api/public/browse?colors=C", None, None).await;
    assert_eq!(body["decks"][0]["art"], Value::Null, "art that isn't Scryfall's is never shown");
    assert_eq!(body["decks"][0]["precon"], Value::Null);
    // Empty filters are no filters; a filter that makes no sense is refused, not ignored.
    assert_eq!(names(&app, "?q=&commander=&colors=&bracket=&precon=&page=").await.len(), 4);
    for bad in ["?colors=X", "?colors=WUBRGX", "?bracket=9", "?bracket=two", "?page=-1"] {
        assert_eq!(send(&app, Method::GET, &format!("/api/public/browse{bad}"), None, None).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }

    // Pages: a page past the end is the last one.
    let page = |n: &'static str| {
        let pool = pool.clone();
        async move { listed(&pool, &Filter { page: Some(n.into()), ..Filter::default() }, 3).await.unwrap() }
    };
    let (p0, p1, p9) = (page("0").await, page("1").await, page("9").await);
    assert_eq!((p0.decks.len(), p0.page, p0.pages, p0.total), (3, 0, 2, 4));
    assert_eq!((p1.decks.len(), p1.page, p1.decks[0].name.as_str()), (1, 1, "Counters 100%"));
    assert_eq!((p9.page, p9.decks.len()), (1, 1));
}

#[tokio::test]
async fn a_kept_face_is_read_again_after_a_week() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    deck(&app, &pool, &ann, "Goblins", krenko_list(0), "public", "2026-11-01T00:00:00Z").await;
    let artist = || async { send(&app, Method::GET, "/api/public/browse", None, None).await.1["decks"][0]["art"]["artist"].clone() };
    assert_eq!(artist().await, "Karl Kopinski");
    // Card data changes: the kept face stands until it is a week old.
    sqlx::query("UPDATE cards SET artist = 'Someone Else' WHERE oracle_id = 'krenko'").execute(&pool).await.unwrap();
    assert_eq!(artist().await, "Karl Kopinski");
    sqlx::query("UPDATE deck_version_faces SET made_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    assert_eq!(artist().await, "Someone Else");
    let faces: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_version_faces").fetch_one(&pool).await.unwrap();
    assert_eq!(faces, 1);
}

/// SQLite's LIKE folds ASCII case only, so a search with other letters is matched in Rust.
#[tokio::test]
async fn search_ignores_case_for_letters_outside_ascii_too() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    sqlx::query("INSERT INTO cards(oracle_id,name,type_line,color_identity,legalities,image_art_crop,image_normal,artist,updated_at) VALUES ('eowyn','Éowyn, Shieldmaiden','Legendary Creature','WUR','{}',NULL,NULL,NULL,'now')")
        .execute(&pool)
        .await
        .unwrap();
    let ann = lister(&app, &pool, "ann").await;
    deck(&app, &pool, &ann, "Riders", vec![card("eowyn", "Éowyn, Shieldmaiden", Board::Commander)], "public", "2026-11-01T00:00:00Z").await;
    deck(&app, &pool, &ann, "ÉLAN goblins", krenko_list(0), "public", "2026-11-02T00:00:00Z").await;
    deck(&app, &pool, &ann, "Private Éowyn", vec![card("eowyn", "Éowyn, Shieldmaiden", Board::Commander)], "link", "2026-11-03T00:00:00Z").await;
    // é and É, percent-encoded as a browser sends them.
    assert_eq!(names(&app, "?q=%C3%A9owyn").await, ["Riders"]);
    assert_eq!(names(&app, "?q=%C3%89OWYN").await, ["Riders"]);
    assert_eq!(names(&app, "?q=%C3%A9lan").await, ["ÉLAN goblins"]);
    assert_eq!(names(&app, "?commander=%C3%A9owyn").await, ["Riders"]);
    assert_eq!(names(&app, "?commander=%C3%A9lan").await, Vec::<String>::new());
    assert_eq!(names(&app, "?q=%C3%A9owyn&colors=R").await, ["Riders"]);
    assert_eq!(names(&app, "?q=%C3%A9owyn&colors=G").await, Vec::<String>::new());
    assert_eq!(names(&app, "?q=%C3%B1").await, Vec::<String>::new());
}

/// Every listed deck is in the listing on the first request, however many had no kept face.
#[tokio::test]
async fn the_first_listing_after_many_decks_are_listed_is_complete() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    for i in 0..205 {
        let id = crate::decks::create_deck_with_cards(&pool, &ann.0, &format!("Deck {i:03}"), None, vec![card("krenko", "Krenko, Mob Boss", Board::Commander)]).await.unwrap();
        sqlx::query("UPDATE decks SET visibility = 'public' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    }
    let (_, body) = send(&app, Method::GET, "/api/public/browse", None, None).await;
    assert_eq!((&body["total"], &body["pages"]), (&json!(205), &json!(9)));
    assert_eq!(names(&app, "?q=Deck%20000").await, ["Deck 000"]);

#[tokio::test]
async fn a_precons_page_lists_the_public_decks_started_from_it() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    // A later precon with the same hundred cards shares the first one's decks.
    sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,color_identity,cards,source,content_sha256,imported_at,same_list_as) SELECT 'goblin-reprint','precons/goblin-reprint','Goblin Reprint',set_code,commanders,color_identity,cards,source,content_sha256,imported_at,'goblin-precon' FROM precons WHERE id = 'goblin-precon'")
        .execute(&pool)
        .await
        .unwrap();
    let section = |precon: &'static str| {
        let pool = pool.clone();
        async move { super::browse::precon_section(&pool, precon).await.unwrap() }
    };
    // Nobody has built on it yet: the page says nothing.
    assert_eq!(section("goblin-precon").await, "");
    let bob = lister(&app, &pool, "bob").await;
    let token = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, String>("SELECT share_token FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    let upgraded = deck(&app, &pool, &bob, "Upgraded <goblins>", krenko_list(29), "public", "2026-11-02T00:00:00Z").await;
    deck(&app, &pool, &bob, "Goblin brew", krenko_list(5), "public", "2026-11-03T00:00:00Z").await;
    let private = deck(&app, &pool, &bob, "Private upgrade", krenko_list(30), "link", "2026-11-04T00:00:00Z").await;
    let html = section("goblin-precon").await;
    assert!(html.contains("1 public deck</p>") && html.contains("Decks started from this precon"), "{html}");
    assert!(html.contains(&format!("href=\"/d/{}\"", token(upgraded.clone()).await)));
    assert!(html.contains("Upgraded &lt;goblins&gt;") && html.contains("by @bob") && html.contains("50 cards"), "what its owner typed is escaped: {html}");
    assert!(html.contains("href=\"/decks/browse?precon=goblin-precon\""));
    assert!(html.contains("Krenko, Mob Boss. Art by Karl Kopinski, © Wizards of the Coast."), "the art is credited");
    assert!(!html.contains("Goblin brew") && !html.contains("Private upgrade") && !html.contains(&token(private).await));
    assert!(!html.contains("style="), "public pages allow no inline styles");
    assert_eq!(section("goblin-reprint").await, html.replace("precon=goblin-precon", "precon=goblin-reprint"));
    assert_eq!(section("no-such-precon").await, "");

    // More than a page's worth: the newest six, and a link to all of them.
    for i in 0..6 {
        deck(&app, &pool, &bob, &format!("Upgrade {i}"), krenko_list(25 + i), "public", &format!("2026-11-1{i}T00:00:00Z")).await;
    }
    let html = section("goblin-precon").await;
    assert!(html.contains("7 public decks</p>") && html.contains("Browse all 7 ↗"), "{html}");
    assert_eq!(html.matches("class=\"share-deck\"").count(), 6);
    assert!(html.contains("Upgrade 5") && !html.contains("Upgraded &lt;goblins&gt;"));

    // Leaving the listing takes the deck off the page at once.
    send(&app, Method::POST, "/api/me/sharing/decks", Some(&bob.1), Some(json!({ "visibility": "private" }))).await;
    assert_eq!(section("goblin-precon").await, "");
}

#[tokio::test]
async fn the_commander_ranking_counts_public_decks_per_commander() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let ann = lister(&app, &pool, "ann").await;
    let old = user(&pool, "old@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&old.1), Some(json!({ "handle": "oldtimer" }))).await;
    deck(&app, &pool, &ann, "Goblins one", krenko_list(0), "public", "2026-11-01T00:00:00Z").await;
    deck(&app, &pool, &ann, "Goblins two", krenko_list(3), "public", "2026-11-02T00:00:00Z").await;
    deck(&app, &pool, &ann, "Counters", vec![card("atraxa", "Atraxa, Praetors' Voice", Board::Commander)], "public", "2026-11-03T00:00:00Z").await;
    deck(&app, &pool, &ann, "Hidden goblins", krenko_list(1), "link", "2026-11-04T00:00:00Z").await;
    deck(&app, &pool, &old, "Unlisted goblins", krenko_list(2), "public", "2026-11-05T00:00:00Z").await;
    let counts = super::browse::commander_counts(&pool).await.unwrap();
    assert_eq!(counts.get("krenko, mob boss"), Some(&2));
    assert_eq!(counts.get("atraxa, praetors' voice"), Some(&1));
    assert_eq!(counts.len(), 2);
    let line = super::browse::commander_link("Krenko, Mob Boss", &counts);
    assert!(line.contains("href=\"/decks/browse?commander=Krenko%2C+Mob+Boss\"") && line.contains("2 public decks</a>"), "{line}");
    assert!(super::browse::commander_link("Atraxa, Praetors' Voice", &counts).contains("1 public deck</a>"));
    assert_eq!(super::browse::commander_link("Karn, Silver Golem", &counts), "");
    // The link's filter finds the same decks.
    assert_eq!(names(&app, "?commander=Krenko%2C+Mob+Boss").await, ["Goblins two", "Goblins one"]);
}
