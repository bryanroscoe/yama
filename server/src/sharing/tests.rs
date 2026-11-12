use super::{SharedCard, export, export_file, export_file_name};
use crate::decks::Board;
use crate::testutil::{app, deck, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::json;
use sqlx::SqlitePool;
use tower::ServiceExt;

/// A signed-out GET: (status, headers, body text).
async fn page(app: &Router, path: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = app.clone().oneshot(Request::builder().uri(path).body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).into_owned())
}

async fn token_of(pool: &SqlitePool, deck: &str) -> String {
    sqlx::query_scalar("SELECT share_token FROM decks WHERE id = ?").bind(deck).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn acquisition_is_owner_metadata_not_collection_or_public_data() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "owner@example.com").await;
    let (_, other) = user(&pool, "other@example.com").await;
    let (id, version) = deck(&pool, &owner, "A planned deck").await;
    let path = format!("/api/decks/{id}");
    for status in ["planned", "owned"] {
        assert_eq!(send(&app, Method::PATCH, &path, Some(&auth), Some(json!({"acquisition_status": status}))).await.0, StatusCode::OK);
        let (_, d) = send(&app, Method::GET, &path, Some(&auth), None).await;
        assert_eq!(d["acquisition_status"], status);
        assert_eq!(d["version_id"], version);
        let (_, decks) = send(&app, Method::GET, "/api/decks", Some(&auth), None).await;
        assert_eq!(decks[0]["acquisition_status"], status);
    }
    assert_eq!(send(&app, Method::PATCH, &path, Some(&other), Some(json!({"acquisition_status":"planned"}))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::PATCH, &path, Some(&auth), Some(json!({"acquisition_status":"arriving"}))).await.0, StatusCode::BAD_REQUEST);
    send(&app, Method::PATCH, &path, Some(&auth), Some(json!({"visibility":"public"}))).await;
    let token = token_of(&pool, &id).await;
    let (_, public) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
    assert!(public.get("acquisition_status").is_none());
    let copies: i64 = sqlx::query_scalar("SELECT count(*) FROM collection_items WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(copies, 0);
    let (_, config) = send(&app, Method::POST, &format!("{path}/configurations"), Some(&auth), Some(json!({"configuration":"Bracket 3","op_id":"acquisition-config"}))).await;
    let child = format!("/api/decks/{}", config["id"].as_str().unwrap());
    send(&app, Method::PATCH, &path, Some(&auth), Some(json!({"acquisition_status":"planned"}))).await;
    assert_eq!(send(&app, Method::GET, &child, Some(&auth), None).await.1["acquisition_status"], "planned");
    assert_eq!(send(&app, Method::PATCH, &child, Some(&auth), Some(json!({"acquisition_status":"owned"}))).await.0, StatusCode::BAD_REQUEST);
    let (_, summaries) = send(&app, Method::GET, "/api/decks", Some(&auth), None).await;
    assert!(summaries.as_array().unwrap().iter().all(|d| d["acquisition_status"] == "planned"));
    assert_eq!(send(&app, Method::PATCH, &path, Some(&auth), Some(json!({"acquisition_status":null}))).await.0, StatusCode::OK);
    assert!(send(&app, Method::GET, &path, Some(&auth), None).await.1["acquisition_status"].is_null());
}

#[tokio::test]
async fn profiles_prioritize_current_stock_and_brackets_over_old_snapshots() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "builds@example.com").await;
    let (root, _) = deck(&pool, &owner, "Builds").await;
    sqlx::query("UPDATE users SET handle = 'builds' WHERE id = ?").bind(&owner).execute(&pool).await.unwrap();
    send(&app, Method::PATCH, &format!("/api/decks/{root}"), Some(&auth), Some(json!({"visibility":"public"}))).await;
    for label in ["stock", "after prints", "Bracket 2", "Bracket 3", "Bracket 4"] {
        send(&app, Method::POST, &format!("/api/decks/{root}/configurations"), Some(&auth), Some(json!({"configuration":label,"op_id":label}))).await;
    }
    let (_, _, html) = page(&app, "/u/builds").await;
    let nav = html.split("class=\"share-deck-configs\"").nth(1).unwrap().split("</nav>").next().unwrap();
    for label in ["Current", "Stock", "[2]", "[3]", "[4]"] { assert!(nav.contains(label), "{label}"); }
    assert!(!nav.contains("after prints"));
    assert!(html.contains("<summary>Older snapshots</summary>"));
    assert!(html.contains("after prints"));
}

async fn card(pool: &SqlitePool, oracle: &str, name: &str, type_line: &str, printing: &str, set: &str, number: &str) {
    sqlx::query("INSERT OR IGNORE INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES (?, ?, ?, 'W', '{}', 'now')")
        .bind(oracle)
        .bind(name)
        .bind(type_line)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oracle).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
         VALUES (?, ?, ?, ?, 'Test Set', ?, 'en', 'now')",
    )
    .bind(printing)
    .bind(oracle)
    .bind(name)
    .bind(set)
    .bind(number)
    .execute(pool)
    .await
    .unwrap();    sqlx::query("UPDATE cards SET default_printing = ? WHERE oracle_id = ?").bind(printing).bind(oracle).execute(pool).await.unwrap();
}

#[tokio::test]
async fn decks_are_private_until_shared_and_links_can_be_reset() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (id, _) = deck(&pool, &bryan, "Riders of Rohan").await;
    let token = token_of(&pool, &id).await;
    sqlx::query("UPDATE users SET handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();

    // Private: the link and its exports are not found, and so is the JSON for "Save a copy".
    let (status, headers, body) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("Riders of Rohan"));
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(page(&app, &format!("/d/{token}/moxfield.txt")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await.0, StatusCode::NOT_FOUND);

    // Link only: the link works, signed out, but the profile doesn't list it.
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "link" }))).await;
    assert_eq!(s, StatusCode::OK);
    let (status, headers, body) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Riders of Rohan") && body.contains("Test Commander"));
    assert!(body.contains("noindex"));
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("default-src 'none'"));
    let (_, _, profile) = page(&app, "/u/saget").await;
    assert!(profile.contains("@saget") && profile.contains("No public decks yet."), "{profile}");
    assert!(!profile.contains(&token));

    // Public: listed on the profile too.
    send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "public" }))).await;
    let (_, _, profile) = page(&app, "/u/SAGET").await;
    assert!(profile.contains(&format!("/d/{token}")) && profile.contains("Riders of Rohan"));

    // A new link ends the old one.
    let (_, reset) = send(&app, Method::POST, &format!("/api/decks/{id}/share-link"), Some(&bt), None).await;
    let fresh = reset["share_token"].as_str().unwrap().to_string();
    assert_ne!(fresh, token);
    assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, &format!("/d/{fresh}")).await.0, StatusCode::OK);

    // Someone else can't change it.
    let (_, other) = user(&pool, "sam@example.com").await;
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&other), Some(json!({ "visibility": "private" }))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{id}/share-link"), Some(&other), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Archived decks and disabled accounts share nothing.
    sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    assert_eq!(page(&app, &format!("/d/{fresh}")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, "/u/saget").await.0, StatusCode::NOT_FOUND);
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    assert_eq!(send(&app, Method::DELETE, &format!("/api/decks/{id}"), Some(&bt), None).await.0, StatusCode::OK);
    assert_eq!(page(&app, &format!("/d/{fresh}")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, "/d/not-a-token").await.0, StatusCode::NOT_FOUND);
}

/// A public deck saved before its owner has a handle is public by link: its page works and names
/// nobody. It joins the profile once a handle is chosen, with nothing else to do.
#[tokio::test]
async fn a_public_deck_without_a_handle_is_public_by_link_and_joins_the_profile_later() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (id, _) = deck(&pool, &bryan, "Riders of Rohan").await;
    let token = token_of(&pool, &id).await;
    // A Google name nothing else on a page could spell.
    sqlx::query("UPDATE users SET display_name = 'Zebediah Quillfeather' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    let nameless = |text: &str| !text.contains("Zebediah") && !text.contains("Quillfeather") && !text.contains("bryan@example.com");
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "public" }))).await;
    assert_eq!(s, StatusCode::OK);

    // No handle yet: the link works, signed out, and carries no handle, name or email.
    let (status, _, body) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Riders of Rohan"));
    assert!(body.contains("Shared on Yama") && !body.contains("Shared by") && nameless(&body), "{body}");
    let (s, shared) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
    assert_eq!((s, &shared["handle"]), (StatusCode::OK, &json!(null)));
    assert!(nameless(&shared.to_string()), "{shared}");

    // Choosing a handle lists it on the profile; the deck itself was not touched.
    let before: (String, String) = sqlx::query_as("SELECT visibility, updated_at FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    let (s, v) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "handle": "saget" }))).await;
    assert_eq!((s, &v["handle"]), (StatusCode::OK, &json!("saget")));
    let after: (String, String) = sqlx::query_as("SELECT visibility, updated_at FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(before, after);
    let (status, _, profile) = page(&app, "/u/saget").await;
    assert_eq!(status, StatusCode::OK);
    assert!(profile.contains(&format!("/d/{token}")) && profile.contains("Riders of Rohan") && nameless(&profile), "{profile}");
    let (_, _, body) = page(&app, &format!("/d/{token}")).await;
    assert!(body.contains("Shared by <a href=\"/u/saget\">@saget</a>") && nameless(&body), "{body}");
}

/// Every shared page names a card from card data by its id. A list stored before saves checked
/// their rows (written straight to the table here) could hold any name beside a real id.
#[tokio::test]
async fn shared_pages_name_cards_from_card_data_not_from_the_stored_row() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "sharer@example.com").await;
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    let (id, version) = deck(&pool, &owner, "Old list").await;
    let stored = json!([
        { "oracle_id": "o-sol", "name": "Black Lotus, free at this link", "qty": 1, "board": "commander" },
        { "oracle_id": "o-bolt", "name": "Mox Sapphire giveaway", "qty": 4, "board": "main" },
        { "oracle_id": "o-gone", "name": "A card data no longer has", "qty": 1, "board": "main" },
    ]);
    sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?").bind(stored.to_string()).bind(&version).execute(&pool).await.unwrap();
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "sharer" }))).await;
    send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&auth), Some(json!({ "visibility": "public" }))).await;
    let token = token_of(&pool, &id).await;
    let (status, _, deck_page) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, profile) = page(&app, "/u/sharer").await;
    let (_, _, export) = page(&app, &format!("/d/{token}/moxfield.txt")).await;
    let (_, api) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
    for (what, body) in [("deck page", &deck_page), ("profile", &profile), ("export", &export), ("public API", &api.to_string())] {
        assert!(body.contains("Sol Ring"), "{what} names the commander from card data");
        assert!(!body.contains("Black Lotus") && !body.contains("Mox Sapphire"), "{what} shows a stored name");
    }
    assert!(deck_page.contains("Lightning Bolt") && deck_page.contains("A card data no longer has"));
}

/// A shared collection's CSV is opened in spreadsheets by other people. Condition and language
/// are the only columns a client or an imported file chose.
#[tokio::test]
async fn the_shared_collection_csv_defuses_spreadsheet_formulas() {
    let (app, pool) = app().await;
    let (bryan, _) = user(&pool, "bryan@example.com").await;
    sqlx::query("UPDATE users SET handle = 'saget', collection_public = 1 WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    // Rows as an older client or an imported file could have left them.
    for (id, printing, condition, lang) in [("i1", "p-sol", "=HYPERLINK(\"https://evil.example\",\"x\")", "@SUM(1)"), ("i2", "p-bolt", "+1", "-2")] {
        sqlx::query(
            "INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, finish, lang, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, 'nonfoil', ?, 'now', 'now')",
        )
        .bind(id).bind(&bryan).bind(printing).bind(condition).bind(lang).execute(&pool).await.unwrap();
    }
    let (status, _, csv) = page(&app, "/u/saget/collection.csv").await;
    assert_eq!(status, StatusCode::OK);
    let mut reader = csv::Reader::from_reader(csv.as_bytes());
    let rows: Vec<csv::StringRecord> = reader.records().map(|r| r.unwrap()).collect();
    assert_eq!(rows.len(), 2);
    for row in &rows {
        for (i, field) in row.iter().enumerate() {
            assert!(!field.starts_with(['=', '+', '-', '@', '\t', '\r']), "column {i} is a live formula: {field:?}");
        }
    }
    assert_eq!(&rows[0][1], "Lightning Bolt");
    assert_eq!((&rows[0][5], &rows[0][6]), ("'+1", "'-2"));
    assert_eq!((&rows[1][5], &rows[1][6]), ("'=HYPERLINK(\"https://evil.example\",\"x\")", "'@SUM(1)"));
}

/// The public collection page reads one page of lines from the database, however large the
/// collection, and searches there too.
#[tokio::test]
async fn the_shared_collection_page_pages_and_searches_in_the_database() {
    let (app, pool) = app().await;
    let (bryan, _) = user(&pool, "bryan@example.com").await;
    sqlx::query("UPDATE users SET handle = 'saget', collection_public = 1 WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    // 450 different cards, two copies each, plus one with characters LIKE treats specially and
    // one whose name starts with a letter outside ASCII.
    for i in 0..450 {
        card(&pool, &format!("o{i}"), &format!("Card {i:03}"), "Artifact", &format!("p{i}"), "tst", &i.to_string()).await;
    }
    card(&pool, "o-odd", "100% Pure_Gold", "Artifact", "p-odd", "tst", "odd").await;
    card(&pool, "o-eowyn", "Éowyn, Shieldmaiden", "Legendary Creature", "p-eowyn", "tst", "eowyn").await;
    card(&pool, "o-proxy", "Proxy Only", "Artifact", "p-proxy", "tst", "proxy").await;
    sqlx::query(
        "INSERT INTO collection_items (id, owner_id, scryfall_id, qty, proxy, created_at, updated_at)
         SELECT 'i-' || scryfall_id, ?, scryfall_id, 2, scryfall_id = 'p-proxy', 'now', 'now' FROM printings",
    )
    .bind(&bryan)
    .execute(&pool)
    .await
    .unwrap();
    let rows = |html: &str| html.matches("class=\"public-card-ref\"").count();
    let total = "904 copies";

    let (status, _, first) = page(&app, "/u/saget/collection").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows(&first), 200);
    assert!(first.contains(total) && first.contains("Page 1 of 3") && first.contains(">100% Pure_Gold<") && !first.contains("Proxy Only"));
    let (_, _, last) = page(&app, "/u/saget/collection?page=2").await;
    assert_eq!(rows(&last), 52);
    assert!(last.contains("Page 3 of 3") && last.contains(">Card 449<") && !last.contains(">Card 000<"));
    // A page past the end is the last one, not an error or an empty table.
    let (status, _, beyond) = page(&app, "/u/saget/collection?page=99999999").await;
    assert_eq!((status, rows(&beyond)), (StatusCode::OK, 52));
    // No line is on two pages.
    let (_, _, middle) = page(&app, "/u/saget/collection?page=1").await;
    assert_eq!(rows(&middle), 200);
    assert!(middle.contains(">Card 200<") && !first.contains(">Card 200<") && !last.contains(">Card 200<"));

    // Searching: anywhere in the name, any case, with the whole collection's count unchanged.
    let (_, _, found) = page(&app, "/u/saget/collection?q=CARD+44").await;
    assert_eq!(rows(&found), 10);
    assert!(found.contains(total) && found.contains(">Card 440<") && !found.contains("Page 1 of"));
    let (_, _, paged) = page(&app, "/u/saget/collection?q=card&page=2").await;
    assert_eq!(rows(&paged), 50);
    assert!(paged.contains("page=1&amp;q=card"));
    // % and _ are ordinary characters in a search.
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=100%25").await.2), 1);
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=e_g").await.2), 1);
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=%25").await.2), 1);
    // Case is ignored outside ASCII too, as it was when the page searched in memory: SQLite's
    // LIKE alone would miss the first of these.
    for q in ["%C3%A9owyn", "%C3%89OWYN", "%C3%89owyn,+shield", "OWYN"] {
        let (_, _, found) = page(&app, &format!("/u/saget/collection?q={q}")).await;
        assert_eq!(rows(&found), 1, "{q}");
        assert!(found.contains("Éowyn, Shieldmaiden") && found.contains(total), "{q}");
    }
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=%C3%A9").await.2), 1);
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=eowyn").await.2), 0, "an accent isn't dropped");
    // A NUL ends a LIKE pattern early (it would match everything); it finds nothing, as before.
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=%00").await.2), 0);
    assert_eq!(rows(&page(&app, "/u/saget/collection?q=9%00zz").await.2), 0);
    let (_, _, none) = page(&app, "/u/saget/collection?q=no+such+card").await;
    assert_eq!(rows(&none), 0);
    assert!(none.contains("No cards match."));
}

/// The want list's cache key no longer reads the collection. It must still change whenever
/// the copies do, or a container's kind does.
#[tokio::test]
async fn the_want_list_follows_the_collection_without_reading_all_of_it() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "wants-key@example.com").await;
    card(&pool, "ring", "Sol Ring", "Artifact", "p-ring", "tst", "1").await;
    let (_, v) = deck(&pool, &owner, "Needs a ring").await;
    sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?")
        .bind(json!([{"oracle_id": "ring", "name": "Sol Ring", "qty": 1, "board": "main"}]).to_string())
        .bind(v)
        .execute(&pool)
        .await
        .unwrap();
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({"handle": "wants-key", "wants_public": true}))).await;
    let wanted = || async { page(&app, "/u/wants-key/wants.txt").await.2 };
    assert_eq!(wanted().await, "1 Sol Ring\n");
    // A copy arrives: nothing is wanted.
    copies(&app, &auth, "spare", "p-ring", 1, false, None).await;
    assert_eq!(wanted().await, "");
    // It goes into another deck's box: spoken for, so one is wanted again.
    let (_, box_) = send(&app, Method::POST, "/api/containers", Some(&auth), Some(json!({"kind": "deck", "name": "Another deck"}))).await;
    let item: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
    let moved = json!([{ "op_id": "move", "kind": "update", "item_id": item, "container_id": box_["id"] }]);
    assert_eq!(send(&app, Method::POST, "/api/collection/ops", Some(&auth), Some(moved)).await.0, StatusCode::OK);
    assert_eq!(wanted().await, "1 Sol Ring\n");
    // The box becomes a plain box without any op (nothing in Yama does this to a deck's box; the
    // key guards against it all the same): free again.
    sqlx::query("UPDATE containers SET kind = 'box' WHERE owner_id = ?").bind(&owner).execute(&pool).await.unwrap();
    assert_eq!(wanted().await, "");
}

#[tokio::test]
async fn shared_pages_carry_no_private_details() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan.secret@example.com").await;
    sqlx::query("UPDATE users SET display_name = 'Bryan Fullname', handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    let (_, container) = send(&app, Method::POST, "/api/containers", Some(&bt), Some(json!({ "kind": "binder", "name": "Secret binder" }))).await;
    let ops = json!([
        { "op_id": "a", "kind": "add", "scryfall_id": "p-sol", "qty": 2, "container_id": container["id"], "purchase_price": 77.25, "purchase_currency": "USD" },
        { "op_id": "b", "kind": "add", "scryfall_id": "p-bolt", "qty": 1, "proxy": true },
    ]);
    assert_eq!(send(&app, Method::POST, "/api/collection/ops", Some(&bt), Some(ops)).await.0, StatusCode::OK);
    sqlx::query("UPDATE collection_items SET note = 'from Dave'").execute(&pool).await.unwrap();
    let text = "Commander\n1 Sol Ring\nDeck\n1 Lightning Bolt";
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Shared", "text": text }))).await;
    let id = made["id"].as_str().unwrap().to_string();
    let token = token_of(&pool, &id).await;
    sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, note, created_at) VALUES ('v-note', ?, '[]', 'private version note', 'now')")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "public" }))).await;

    // The collection is private until shared, then lists real copies only.
    assert_eq!(page(&app, "/u/saget/collection").await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, "/u/saget/collection.csv").await.0, StatusCode::NOT_FOUND);
    let (_, sharing) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "collection_public": true }))).await;
    assert_eq!(sharing["collection_public"], true);
    assert_eq!(sharing["share_lab_results"], false, "simulated results stay off shared pages until turned on");
    let (_, sharing) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "share_lab_results": true }))).await;
    assert_eq!(sharing["share_lab_results"], true);
    let (status, _, collection) = page(&app, "/u/saget/collection").await;
    assert_eq!(status, StatusCode::OK);
    assert!(collection.contains("Sol Ring") && !collection.contains("Lightning Bolt"), "proxies aren't listed");
    let (_, headers, csv) = page(&app, "/u/saget/collection.csv").await;
    assert_eq!(csv, "Count,Name,Edition,Collector Number,Foil,Condition,Language\n2,Sol Ring,cmm,410,,NM,en\n");
    assert!(headers[header::CONTENT_DISPOSITION].to_str().unwrap().contains("saget-collection.csv"));
    assert_eq!(page(&app, "/u/saget/collection.txt").await.2, "2 Sol Ring (CMM) 410\n");

    let (_, _, deck_page) = page(&app, &format!("/d/{token}")).await;
    let (_, _, profile) = page(&app, "/u/saget").await;
    let (_, export) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
    for body in [&deck_page, &profile, &collection, &csv, &export.to_string()] {
        for secret in ["bryan.secret", "Fullname", "77.25", "Secret binder", "from Dave", "private version note", &bryan] {
            assert!(!body.contains(secret), "{secret} leaked");
        }
    }
    assert_eq!(export["handle"], "saget");
    assert_eq!(export["text"], "Commander\n1 Sol Ring (CMM) 410\n\nDeck\n1 Lightning Bolt (LEA) 161\n");
}

#[tokio::test]
async fn a_decks_description_shows_on_its_shared_page_as_text_and_nowhere_else() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    sqlx::query("UPDATE users SET handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Described", "text": "Commander\n1 Sol Ring" }))).await;
    let id = made["id"].as_str().unwrap().to_string();
    let path = format!("/api/decks/{id}");
    let token = token_of(&pool, &id).await;
    // A version's note is private. It is never the description, and never copied into it.
    sqlx::query("UPDATE deck_versions SET note = 'private version note' WHERE deck_id = ?").bind(&id).execute(&pool).await.unwrap();
    let text = "Lands matter.\nPlay <b>big</b> things & \"win\".\n\n<script>alert(1)</script>";
    let (status, _) = send(&app, Method::PATCH, &path, Some(&bt), Some(json!({ "description": text }))).await;
    assert_eq!(status, StatusCode::OK);

    // The owner reads it back on the deck's own page, as typed.
    let (_, own) = send(&app, Method::GET, &path, Some(&bt), None).await;
    assert_eq!(own["description"], text);

    // While the deck is private, nobody signed out sees the deck, so nobody sees its description.
    assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::NOT_FOUND);

    // Shared by link: a signed-out visitor reads it, and everything in it is text, not markup.
    send(&app, Method::PATCH, &path, Some(&bt), Some(json!({ "visibility": "link" }))).await;
    let (status, _, html) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    let shown = "<h2 id=\"about-head\">About this deck</h2><p>Lands matter.<br>Play &lt;b&gt;big&lt;/b&gt; things &amp; &quot;win&quot;.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></section>";
    assert!(html.contains(shown), "{html}");
    assert!(!html.contains("<script>alert(1)</script>") && !html.contains("<b>big</b>"), "{html}");
    assert!(!html.contains("private version note"), "{html}");

    // The deck's own page is the only public place it shows: not the profile's list of decks,
    // the list a copy is made from, or a download.
    send(&app, Method::PATCH, &path, Some(&bt), Some(json!({ "visibility": "public" }))).await;
    let (status, _, profile) = page(&app, "/u/saget").await;
    assert_eq!(status, StatusCode::OK);
    assert!(profile.contains("Described"), "{profile}");
    let (status, copy) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
    assert_eq!(status, StatusCode::OK, "{copy}");
    assert_eq!(copy["name"], "Described");
    let (status, _, names) = page(&app, &format!("/d/{token}/names.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(names.contains("Sol Ring"), "{names}");
    for body in [&profile, &copy.to_string(), &names] {
        assert!(!body.contains("Lands matter") && !body.contains("private version note"), "{body}");
    }
    assert!(page(&app, &format!("/d/{token}")).await.2.contains(shown), "sharing more widely keeps the description");

    // Another signed-in person can't read the owner's deck page data, description included.
    let (_, other) = user(&pool, "other@example.com").await;
    assert_eq!(send(&app, Method::GET, &path, Some(&other), None).await.0, StatusCode::NOT_FOUND);

    // An apostrophe is escaped too.
    send(&app, Method::PATCH, &path, Some(&bt), Some(json!({ "description": "It's Omo's deck." }))).await;
    assert!(page(&app, &format!("/d/{token}")).await.2.contains("<p>It&#39;s Omo&#39;s deck.</p>"));

    // Cleared, the section goes.
    send(&app, Method::PATCH, &path, Some(&bt), Some(json!({ "description": null }))).await;
    let (_, _, html) = page(&app, &format!("/d/{token}")).await;
    assert!(!html.contains("About this deck") && !html.contains("Omo&#39;s deck"), "{html}");
}

#[tokio::test]
async fn exports_match_the_deck_pages_formats() {
    let (app, pool) = app().await;
    let (_, bt) = user(&pool, "bryan@example.com").await;
    card(&pool, "o-fable", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "Enchantment — Saga // Enchantment Creature — Goblin Shaman", "p-fable", "neo", "141").await;
    sqlx::query("UPDATE cards SET layout = 'transform' WHERE oracle_id = 'o-fable'").execute(&pool).await.unwrap();
    card(&pool, "o-cmd", "Éowyn, Shieldmaiden", "Legendary Creature — Human Knight", "p-cmd", "ltc", "1").await;
    let text = "Commander\n1 Éowyn, Shieldmaiden\nDeck\n1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki (NEO) 141 *F*";
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Riders of Rohan (stock)", "text": text,
        "prints": [{ "oracle_id": "o-fable", "set_code": "neo", "collector_number": "141", "finish": "foil" }] }))).await;
    let id = made["id"].as_str().unwrap().to_string();
    sqlx::query("UPDATE decks SET visibility = 'link' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    let token = token_of(&pool, &id).await;
    let (status, headers, mox) = page(&app, &format!("/d/{token}/moxfield.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"riders-of-rohan-stock-moxfield.txt\"");
    assert_eq!(mox, "Commander\n1 Éowyn, Shieldmaiden (LTC) 1\n\nDeck\n1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki (NEO) 141 *F*\n");
    assert_eq!(page(&app, &format!("/d/{token}/arena.txt")).await.2, "Commander\n1 Éowyn, Shieldmaiden\n\nDeck\n1 Fable of the Mirror-Breaker\n");
    assert_eq!(
        page(&app, &format!("/d/{token}/names.txt")).await.2,
        "Commander\n1 Éowyn, Shieldmaiden\n\nDeck\n1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki\n"
    );
    assert_eq!(page(&app, &format!("/d/{token}/other.txt")).await.0, StatusCode::NOT_FOUND);

    // The deck page's other formats (packages/core/src/deckExport.ts), each under its own ending
    // and media type.
    let (status, headers, archidekt) = page(&app, &format!("/d/{token}/archidekt.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"riders-of-rohan-stock-archidekt.txt\"");
    assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(
        archidekt,
        "1x Éowyn, Shieldmaiden (ltc) 1 [Commander{top}]\n1x Fable of the Mirror-Breaker // Reflection of Kiki-Jiki (neo) 141 *F*\n"
    );

    // Magic Online and Cockatrice keep the commander in the sideboard, and name a double-faced
    // card by its front.
    let (status, headers, dek) = page(&app, &format!("/d/{token}/mtgo.dek")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"riders-of-rohan-stock.dek\"");
    assert_eq!(headers[header::CONTENT_TYPE], "application/xml; charset=utf-8");
    assert!(dek.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<Deck "), "{dek}");
    let main = r#"  <Cards CatID="0" Quantity="1" Sideboard="false" Name="Fable of the Mirror-Breaker" Annotation="0" />"#;
    let commander = r#"  <Cards CatID="0" Quantity="1" Sideboard="true" Name="Éowyn, Shieldmaiden" Annotation="0" />"#;
    assert!(dek.ends_with(&format!("{main}\n{commander}\n</Deck>\n")), "{dek}");

    let (status, headers, cod) = page(&app, &format!("/d/{token}/cockatrice.cod")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"riders-of-rohan-stock.cod\"");
    assert_eq!(headers[header::CONTENT_TYPE], "application/xml; charset=utf-8");
    assert_eq!(
        cod,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<cockatrice_deck version="1">
    <deckname>Riders of Rohan (stock)</deckname>
    <comments></comments>
    <zone name="main">
        <card number="1" name="Fable of the Mirror-Breaker"/>
    </zone>
    <zone name="side">
        <card number="1" name="Éowyn, Shieldmaiden"/>
    </zone>
</cockatrice_deck>
"#
    );

    let (status, headers, csv) = page(&app, &format!("/d/{token}/csv.csv")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"riders-of-rohan-stock.csv\"");
    assert_eq!(headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert_eq!(
        csv,
        "Quantity,Name,Board,Set code,Collector number,Finish\n1,\"Éowyn, Shieldmaiden\",Commander,LTC,1,nonfoil\n1,Fable of the Mirror-Breaker // Reflection of Kiki-Jiki,Main,NEO,141,foil\n"
    );

    // A format under another format's ending, or a file that is neither, is nothing.
    for wrong in ["mtgo.txt", "cockatrice.dek", "csv.txt", "archidekt.csv", "dek", ".dek"] {
        assert_eq!(page(&app, &format!("/d/{token}/{wrong}")).await.0, StatusCode::NOT_FOUND, "{wrong}");
    }

    // The page links every format: the three most used as buttons, the rest under More formats.
    let (_, _, html) = page(&app, &format!("/d/{token}")).await;
    assert!(html.contains(&format!("href=\"/d/{token}/moxfield.txt\" download>Download for Moxfield</a>")), "{html}");
    for link in ["archidekt.txt\" download>Archidekt</a>", "mtgo.dek\" download>Magic Online (.dek)</a>", "cockatrice.cod\" download>Cockatrice (.cod)</a>", "csv.csv\" download>CSV</a>"] {
        assert!(html.contains(&format!("href=\"/d/{token}/{link}")), "{link}: {html}");
    }
}

/// A deck's printings are what a client sent with the list. They reach public downloads, so one
/// that isn't a plain set code, number and finish is never written into them.
#[tokio::test]
async fn a_printing_the_owner_made_up_never_reaches_a_public_download() {
    let (app, pool) = app().await;
    let (_, bt) = user(&pool, "bryan@example.com").await;
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    card(&pool, "o-opt", "Opt", "Instant", "p-opt", "eld", "59").await;
    let prints = json!([
        { "oracle_id": "o-sol", "set_code": "a\n=2+5", "collector_number": "1", "finish": "nonfoil" },
        { "oracle_id": "o-bolt", "set_code": "lea", "collector_number": "1,=7*7", "finish": "foil" },
        { "oracle_id": "o-opt", "set_code": "eld", "collector_number": "59", "finish": "foil\n9 Black Lotus" },
    ]);
    let text = "Commander\n1 Sol Ring\nDeck\n1 Lightning Bolt\n1 Opt";
    let (status, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Tricks", "text": text, "prints": prints }))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    sqlx::query("UPDATE decks SET visibility = 'link' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    let token = token_of(&pool, &id).await;

    // Each card names the printing Yama picks instead, in every download.
    let (_, _, csv) = page(&app, &format!("/d/{token}/csv.csv")).await;
    assert_eq!(csv, "Quantity,Name,Board,Set code,Collector number,Finish\n1,Sol Ring,Commander,CMM,410,nonfoil\n1,Lightning Bolt,Main,LEA,161,nonfoil\n1,Opt,Main,ELD,59,nonfoil\n");
    let (_, _, archidekt) = page(&app, &format!("/d/{token}/archidekt.txt")).await;
    assert_eq!(archidekt, "1x Sol Ring (cmm) 410 [Commander{top}]\n1x Lightning Bolt (lea) 161\n1x Opt (eld) 59\n");
    let (_, _, moxfield) = page(&app, &format!("/d/{token}/moxfield.txt")).await;
    assert_eq!(moxfield, "Commander\n1 Sol Ring (CMM) 410\n\nDeck\n1 Lightning Bolt (LEA) 161\n1 Opt (ELD) 59\n");
    let (_, _, html) = page(&app, &format!("/d/{token}")).await;
    for made_up in ["=2+5", "=7*7", "Black Lotus"] {
        assert!(!csv.contains(made_up) && !archidekt.contains(made_up) && !moxfield.contains(made_up) && !html.contains(made_up), "{made_up}");
    }
}

/// Which printing of a card someone owns is collection data. A shared deck names the owner's
/// copy as a card's printing only when they share their collection; otherwise it is read as if
/// they owned none of its cards. A proxy never names one. The owner's own view doesn't change.
#[tokio::test]
async fn a_shared_deck_names_its_owners_printings_only_when_the_collection_is_shared() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    // Each card's default printing, and another printing the owner has: Sol Ring for real, in
    // foil; Lightning Bolt only as a proxy.
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    for (id, oracle, name, set, number) in [("p-sol-ltc", "o-sol", "Sol Ring", "ltc", "284"), ("p-bolt-m11", "o-bolt", "Lightning Bolt", "m11", "149")] {
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?, ?, ?, ?, 'Other Set', ?, 'en', 'now')")
            .bind(id)
            .bind(oracle)
            .bind(name)
            .bind(set)
            .bind(number)
            .execute(&pool)
            .await
            .unwrap();
    }
    let ops = json!([
        { "op_id": "own-sol", "kind": "add", "scryfall_id": "p-sol-ltc", "qty": 1, "proxy": false, "container_id": null, "finish": "foil" },
        { "op_id": "proxy-bolt", "kind": "add", "scryfall_id": "p-bolt-m11", "qty": 1, "proxy": true, "container_id": null, "finish": "nonfoil" },
    ]);
    assert_eq!(send(&app, Method::POST, "/api/collection/ops", Some(&bt), Some(ops)).await.0, StatusCode::OK);
    let (status, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Tricks", "text": "Commander\n1 Sol Ring\nDeck\n1 Lightning Bolt", "visibility": "public" }))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    let token = token_of(&pool, &id).await;
    let shared = || async {
        let (_, _, moxfield) = page(&app, &format!("/d/{token}/moxfield.txt")).await;
        let (_, _, csv) = page(&app, &format!("/d/{token}/csv.csv")).await;
        let (_, _, html) = page(&app, &format!("/d/{token}")).await;
        let (_, api) = send(&app, Method::GET, &format!("/api/public/decks/{token}"), None, None).await;
        (moxfield, csv, html, api["text"].as_str().unwrap().to_string())
    };
    // What the owner sees on their own deck page: their copies, whatever they share.
    let own = || async {
        let (_, deck) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&bt), None).await;
        let printing = |name: &str| {
            let c = deck["cards"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
            format!("{} {} {} {}", c["printing"]["set_code"].as_str().unwrap(), c["printing"]["collector_number"].as_str().unwrap(), c["printing"]["finish"].as_str().unwrap(), c["printing"]["from"].as_str().unwrap())
        };
        (printing("Sol Ring"), printing("Lightning Bolt"))
    };

    // The collection is not shared (the default, for a new account too): every card names a
    // paper printing, as for a card the owner doesn't have, in the page, the downloads and the API.
    let private: bool = sqlx::query_scalar("SELECT collection_public FROM users WHERE id = ?").bind(&bryan).fetch_one(&pool).await.unwrap();
    assert!(!private);
    let (moxfield, csv, html, text) = shared().await;
    assert_eq!(moxfield, "Commander\n1 Sol Ring (CMM) 410\n\nDeck\n1 Lightning Bolt (LEA) 161\n");
    assert_eq!(text, moxfield);
    assert_eq!(csv, "Quantity,Name,Board,Set code,Collector number,Finish\n1,Sol Ring,Commander,CMM,410,nonfoil\n1,Lightning Bolt,Main,LEA,161,nonfoil\n");
    for theirs in ["LTC", "ltc", "284", "M11", "m11", "149", ",foil", "*F*"] {
        assert!(!moxfield.contains(theirs) && !csv.contains(theirs), "{theirs}");
    }
    // The page writes a printing as "CMM 410" (", foil" after a foil one).
    assert!(html.contains("CMM 410") && html.contains("LEA 161"), "{html}");
    assert!(!html.contains("LTC 284") && !html.contains("M11 149"), "{html}");
    assert_eq!(own().await, ("ltc 284 foil owned".to_string(), "m11 149 nonfoil owned".to_string()));

    // The collection is shared: their real copy names Sol Ring's printing and finish. The proxy
    // names nothing: sharing never shows proxies.
    send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "collection_public": true }))).await;
    let (moxfield, csv, html, text) = shared().await;
    assert_eq!(moxfield, "Commander\n1 Sol Ring (LTC) 284 *F*\n\nDeck\n1 Lightning Bolt (LEA) 161\n");
    assert_eq!(text, moxfield);
    assert!(csv.contains("1,Sol Ring,Commander,LTC,284,foil") && csv.contains("1,Lightning Bolt,Main,LEA,161,nonfoil"), "{csv}");
    assert!(html.contains("LTC 284, foil") && html.contains("LEA 161") && !html.contains("M11 149"), "{html}");
    // What a browser that saw the page and a download while the collection was shared holds.
    let seen = |path: String| {
        let app = app.clone();
        async move {
            let res = app.oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap()).await.unwrap();
            res.headers()[header::ETAG].to_str().unwrap().to_string()
        }
    };
    let (page_tag, file_tag) = (seen(format!("/d/{token}")).await, seen(format!("/d/{token}/moxfield.txt")).await);

    // Turned off again, it takes effect at once; a printing the deck itself names (an import's)
    // still shows either way, since the deck names it, not the collection.
    send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "collection_public": false }))).await;
    assert_eq!(shared().await.0, "Commander\n1 Sol Ring (CMM) 410\n\nDeck\n1 Lightning Bolt (LEA) 161\n");
    // A browser asking again with what it has gets the new page, not "unchanged".
    for (path, tag, theirs) in [(format!("/d/{token}"), &page_tag, "LTC 284"), (format!("/d/{token}/moxfield.txt"), &file_tag, "(LTC) 284")] {
        let res = app.clone().oneshot(Request::builder().uri(&path).header(header::IF_NONE_MATCH, tag.as_str()).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        let body = String::from_utf8_lossy(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).into_owned();
        assert!(!body.contains(theirs), "{path}: {body}");
    }
    assert_eq!(own().await, ("ltc 284 foil owned".to_string(), "m11 149 nonfoil owned".to_string()));
    let (_, named) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Named", "text": "Commander\n1 Sol Ring", "visibility": "link",
        "prints": [{ "oracle_id": "o-sol", "set_code": "ltc", "collector_number": "284", "finish": "foil" }] }))).await;
    let named = token_of(&pool, named["id"].as_str().unwrap()).await;
    assert_eq!(page(&app, &format!("/d/{named}/moxfield.txt")).await.2, "Commander\n1 Sol Ring (LTC) 284 *F*\n");
}

#[test]
fn a_csv_cell_a_spreadsheet_would_run_is_defused() {
    let printing = |number: &str| Some(crate::decks::PrintRef { set_code: "plst".into(), collector_number: number.into(), finish: "nonfoil".into(), from: "default" });
    let cards = vec![SharedCard { name: "Sol Ring".into(), qty: 1, board: Board::Main, type_line: None, cmc: 0.0, layout: None, image: None, printing: printing("-12") }];
    assert_eq!(export_file(&cards, "csv", ""), "Quantity,Name,Board,Set code,Collector number,Finish\n1,Sol Ring,Main,PLST,'-12,nonfoil\n");
}

#[test]
fn file_exports_escape_names_and_leave_the_sideboard_out_of_program_files() {
    let card = |name: &str, board: Board| SharedCard { name: name.into(), qty: 2, board, type_line: None, cmc: 0.0, layout: None, image: None, printing: None };
    let mut cards = vec![card("Ach! Hans, Run! <\"&\">", Board::Main), card("Negate", Board::Side), card("Nothing", Board::Main)];
    cards[2].qty = 0;

    let dek = export_file(&cards, "mtgo", "Tom & Jerry");
    assert!(dek.contains("Quantity=\"2\" Sideboard=\"false\" Name=\"Ach! Hans, Run! &lt;&quot;&amp;&quot;&gt;\""), "{dek}");
    assert!(!dek.contains("Negate") && !dek.contains("Nothing"), "{dek}");

    let cod = export_file(&cards, "cockatrice", "Tom & Jerry <3");
    assert!(cod.contains("<deckname>Tom &amp; Jerry &lt;3</deckname>"), "{cod}");
    assert!(cod.contains("<card number=\"2\" name=\"Ach! Hans, Run! &lt;&quot;&amp;&quot;&gt;\"/>"), "{cod}");
    // No commander: no side zone at all.
    assert!(!cod.contains("zone name=\"side\"") && !cod.contains("Negate"), "{cod}");

    // An empty deck is an empty file, as the app writes it.
    assert_eq!(export_file(&[], "archidekt", ""), "");
    // The text formats keep the sideboard; a card with no printing goes by name alone.
    assert_eq!(export_file(&cards, "archidekt", ""), "2x Ach! Hans, Run! <\"&\">\n2x Negate [Sideboard{noDeck}{noPrice}]\n");
    assert_eq!(
        export_file(&cards, "csv", ""),
        "Quantity,Name,Board,Set code,Collector number,Finish\n2,\"Ach! Hans, Run! <\"\"&\"\">\",Main,,,\n2,Negate,Sideboard,,,\n"
    );
    // Any other format is the page's own text export.
    assert_eq!(export_file(&cards, "names", ""), export(&cards, "names"));

    assert_eq!(export_file_name("Riders of Rohan (stock)", "mtgo"), "riders-of-rohan-stock.dek");
    assert_eq!(export_file_name("???", "cockatrice"), "deck.cod");
    assert_eq!(export_file_name("Riders", "archidekt"), "riders-archidekt.txt");
    assert_eq!(export_file_name("Riders", "moxfield"), "riders-moxfield.txt");
}

#[tokio::test]
async fn handles_and_defaults() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, st) = user(&pool, "sam@example.com").await;
    for bad in ["ab", "1abc", "has space", "admin", "trailing-", "Ünicode"] {
        let (s, _) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "handle": bad }))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (s, v) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "handle": "@Saget" }))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["handle"], "saget");
    let (s, v) = send(&app, Method::PUT, "/api/me/sharing", Some(&st), Some(json!({ "handle": "SAGET" }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    // Keeping your own handle is fine; clearing it ends the profile.
    assert_eq!(send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "handle": "saget" }))).await.0, StatusCode::OK);
    assert_eq!(page(&app, "/u/saget").await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "handle": null }))).await.0, StatusCode::OK);
    assert_eq!(page(&app, "/u/saget").await.0, StatusCode::NOT_FOUND);

    // New decks start as the owner's default; "share all" changes every live deck.
    let (old, _) = deck(&pool, &bryan, "Old").await;
    let (s, v) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "new_deck_visibility": "public" }))).await;
    assert_eq!((s, &v["new_deck_visibility"]), (StatusCode::OK, &json!("public")));
    assert_eq!(send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "new_deck_visibility": "everyone" }))).await.0, StatusCode::BAD_REQUEST);
    let (new, _) = deck(&pool, &bryan, "New").await;
    let vis = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, String>("SELECT visibility FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    assert_eq!(vis(old.clone()).await, "private");
    assert_eq!(vis(new.clone()).await, "public");
    let (_, v) = send(&app, Method::POST, "/api/me/sharing/decks", Some(&bt), Some(json!({ "visibility": "public" }))).await;
    assert_eq!(v["decks"], json!({ "private": 0, "link": 0, "public": 2 }));
    assert_ne!(token_of(&pool, &old).await, token_of(&pool, &new).await);
    let (_, list) = send(&app, Method::GET, "/api/decks", Some(&bt), None).await;
    assert!(list.as_array().unwrap().iter().all(|d| d["visibility"] == "public" && d["share_token"].is_string()));
}

/// The save step's choice (Public, Link only, Private) sets the new deck's visibility and is
/// remembered as what the account's next decks start as.
#[tokio::test]
async fn the_save_steps_choice_sets_the_deck_and_is_remembered() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (sam, st) = user(&pool, "sam@example.com").await;
    let vis = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, String>("SELECT visibility FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    let default_of = |user: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, String>("SELECT new_deck_visibility FROM users WHERE id = ?").bind(user).fetch_one(&pool).await.unwrap() }
    };
    let make = |name: &'static str, extra: serde_json::Value| {
        let (app, bt) = (app.clone(), bt.clone());
        async move {
            let mut body = json!({ "name": name, "cards": [] });
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            send(&app, Method::POST, "/api/decks", Some(&bt), Some(body)).await
        }
    };

    // No choice sent: the account's default, which stays what it was.
    let (s, plain) = make("Plain", json!({})).await;
    assert_eq!(s, StatusCode::OK, "{plain}");
    assert_eq!(vis(plain["id"].as_str().unwrap().into()).await, "private");
    assert_eq!(default_of(bryan.clone()).await, "private");

    // A choice: that deck gets it, with a link of its own, and the next deck without a choice follows it.
    let (s, linked) = make("Linked", json!({ "visibility": "link" })).await;
    assert_eq!(s, StatusCode::OK, "{linked}");
    let linked = linked["id"].as_str().unwrap().to_string();
    assert_eq!(vis(linked.clone()).await, "link");
    assert!(super::valid_token(&token_of(&pool, &linked).await));
    assert_eq!(default_of(bryan.clone()).await, "link");
    let (_, next) = make("Next", json!({})).await;
    assert_eq!(vis(next["id"].as_str().unwrap().into()).await, "link");
    let (_, v) = send(&app, Method::GET, "/api/me/sharing", Some(&bt), None).await;
    assert_eq!(v["new_deck_visibility"], "link");

    // Choosing Private again is remembered too, and earlier decks keep what they were saved as.
    let (_, hidden) = make("Hidden", json!({ "visibility": "private" })).await;
    assert_eq!(vis(hidden["id"].as_str().unwrap().into()).await, "private");
    assert_eq!(default_of(bryan.clone()).await, "private");
    assert_eq!(vis(linked.clone()).await, "link");

    // Anything else is refused, and makes no deck and changes no default.
    let (s, _) = make("Wrong", json!({ "visibility": "everyone" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let wrong: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE name = 'Wrong'").fetch_one(&pool).await.unwrap();
    assert_eq!((wrong, default_of(bryan.clone()).await.as_str()), (0, "private"));

    // A request sent again makes one deck, even when the choice changed in between: it names
    // the deck already made, as it was saved, and changes nothing.
    let (_, first) = make("Once", json!({ "visibility": "public", "op_id": "save-1" })).await;
    let (s, again) = make("Once", json!({ "visibility": "link", "op_id": "save-1" })).await;
    assert_eq!((s, &again["id"]), (StatusCode::OK, &first["id"]));
    assert_eq!(vis(first["id"].as_str().unwrap().into()).await, "public");
    assert_eq!(default_of(bryan.clone()).await, "public");
    let once: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE name = 'Once'").fetch_one(&pool).await.unwrap();
    assert_eq!(once, 1);

    // One account's choice is its own: another account's default and decks are untouched.
    assert_eq!(default_of(sam.clone()).await, "private");
    let (_, theirs) = send(&app, Method::POST, "/api/decks", Some(&st), Some(json!({ "name": "Sam's", "cards": [] }))).await;
    assert_eq!(vis(theirs["id"].as_str().unwrap().into()).await, "private");
}

#[tokio::test]
async fn configurations_group_one_level_deep() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (main, _) = deck(&pool, &bryan, "Riders of Rohan").await;
    let (other, _) = deck(&pool, &bryan, "Tricky Terrain").await;

    // A new configuration copies the list, and a retry makes no second deck.
    let body = json!({ "configuration": "stock", "op_id": "cfg-1" });
    let (s, made) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&bt), Some(body.clone())).await;
    assert_eq!(s, StatusCode::OK, "{made}");
    let stock = made["id"].as_str().unwrap().to_string();
    let (_, again) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&bt), Some(body)).await;
    assert_eq!(again["id"], made["id"]);
    let (_, view) = send(&app, Method::GET, &format!("/api/decks/{stock}"), Some(&bt), None).await;
    assert_eq!(view["name"], "Riders of Rohan (stock)");
    assert_eq!(view["parent_id"], json!(main));
    assert_eq!(view["configuration"], "stock");
    assert_eq!(view["cards"][0]["name"], "Test Commander");
    let names: Vec<&str> = view["configurations"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Riders of Rohan", "Riders of Rohan (stock)"]);

    // A configuration of a configuration, or of itself, is refused; so is moving a main deck
    // that has configurations under another.
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{other}"), Some(&bt), Some(json!({ "parent_id": stock }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{main}"), Some(&bt), Some(json!({ "parent_id": other }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = send(&app, Method::PATCH, &format!("/api/decks/{other}"), Some(&bt), Some(json!({ "parent_id": other }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (_, sam) = user(&pool, "sam@example.com").await;
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&sam), Some(json!({ "configuration": "x", "op_id": "s" }))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Shared pages list only the shared configurations.
    sqlx::query("UPDATE decks SET visibility = 'public' WHERE id IN (?, ?)").bind(&main).bind(&stock).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    let (s, tech) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&bt), Some(json!({ "configuration": "secret tech", "op_id": "cfg-2" }))).await;
    assert_eq!(s, StatusCode::OK);
    // A configuration copies its source's visibility (public here); shared by link only, it's
    // never listed from another deck's page or the profile.
    let tech = tech["id"].as_str().unwrap().to_string();
    let vis: String = sqlx::query_scalar("SELECT visibility FROM decks WHERE id = ?").bind(&tech).fetch_one(&pool).await.unwrap();
    assert_eq!(vis, "public");
    send(&app, Method::PATCH, &format!("/api/decks/{tech}"), Some(&bt), Some(json!({ "visibility": "link" }))).await;
    // Its own page still works, and lists itself.
    let (status, _, own) = page(&app, &format!("/d/{}", token_of(&pool, &tech).await)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(own.contains("secret tech"));
    let (_, _, shared) = page(&app, &format!("/d/{}", token_of(&pool, &main).await)).await;
    assert!(shared.contains("Configurations") && shared.contains(">Current<") && shared.contains(">Stock<"));
    assert!(!shared.contains("secret tech"));
    let (_, _, profile) = page(&app, "/u/saget").await;
    assert!(profile.contains(">Current<") && profile.contains(">Stock<") && !profile.contains("secret tech"));

    // A configuration of a private deck stays private, even when new decks start public.
    send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "new_deck_visibility": "public" }))).await;
    let (s, budget) = send(&app, Method::POST, &format!("/api/decks/{other}/configurations"), Some(&bt), Some(json!({ "configuration": "budget", "op_id": "cfg-3" }))).await;
    assert_eq!(s, StatusCode::OK);
    let vis: String = sqlx::query_scalar("SELECT visibility FROM decks WHERE id = ?").bind(budget["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(vis, "private");
    // An op_id used for another kind of write isn't replayed as this one.
    sqlx::query("INSERT INTO applied_ops (op_id, owner_id, kind, payload, applied_at) VALUES ('used', ?, 'collection.add', '{}', 'now')")
        .bind(&bryan)
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{other}/configurations"), Some(&bt), Some(json!({ "configuration": "x", "op_id": "used" }))).await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Deleting a deck with its configurations takes them all out of the list.
    let budget = budget["id"].as_str().unwrap().to_string();
    let (s, done) = send(&app, Method::DELETE, &format!("/api/decks/{other}?configurations=true"), Some(&bt), None).await;
    assert_eq!(s, StatusCode::OK, "{done}");
    assert_eq!(done["deleted"], json!([other, budget]));
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE id IN (?, ?) AND archived = 1").bind(&other).bind(&budget).fetch_one(&pool).await.unwrap();
    assert_eq!(gone, 2);

    // Deleting the main deck alone leaves its configurations as main decks.
    let (_, done) = send(&app, Method::DELETE, &format!("/api/decks/{main}"), Some(&bt), None).await;
    let mut kept: Vec<&str> = done["kept"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    kept.sort();
    let mut expected = [stock.as_str(), tech.as_str()];
    expected.sort();
    assert_eq!(kept, expected);
    let tech_parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM decks WHERE id = ?").bind(&tech).fetch_one(&pool).await.unwrap();
    assert_eq!(tech_parent, None);
    let parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM decks WHERE id = ?").bind(&stock).fetch_one(&pool).await.unwrap();
    assert_eq!(parent, None);
}

#[tokio::test]
async fn the_migration_groups_name_suffix_configurations() {
    let pool = crate::db::test_pool().await;
    let (bryan, _) = user(&pool, "bryan@example.com").await;
    let (sam, _) = user(&pool, "sam@example.com").await;
    let mut ids = std::collections::HashMap::new();
    for (owner, name) in [
        (&bryan, "Riders of Rohan"),
        (&bryan, "Riders of Rohan (stock)"),
        (&bryan, "Riders of Rohan (after prints)"),
        (&bryan, "Lone (stock)"),
        (&bryan, "Odd (a) (b)"),
        (&bryan, "Odd"),
        (&sam, "Riders of Rohan (mine)"),
    ] {
        ids.insert(format!("{owner}{name}"), deck(&pool, owner, name).await.0);
    }
    sqlx::query("UPDATE decks SET parent_id = NULL, configuration = NULL").execute(&pool).await.unwrap();
    let sql = include_str!("../../migrations/0035_sharing.sql");
    let grouping = &sql[sql.find("-- Group what").unwrap()..];
    sqlx::raw_sql(sqlx::AssertSqlSafe(grouping)).execute(&pool).await.unwrap();
    let row = |key: String| {
        let pool = pool.clone();
        let id = ids[&key].clone();
        async move { sqlx::query_as::<_, (Option<String>, Option<String>)>("SELECT parent_id, configuration FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    let main = ids[&format!("{bryan}Riders of Rohan")].clone();
    assert_eq!(row(format!("{bryan}Riders of Rohan (stock)")).await, (Some(main.clone()), Some("stock".into())));
    assert_eq!(row(format!("{bryan}Riders of Rohan (after prints)")).await, (Some(main), Some("after prints".into())));
    assert_eq!(row(format!("{bryan}Riders of Rohan")).await, (None, None));
    assert_eq!(row(format!("{bryan}Lone (stock)")).await, (None, None), "no main deck to group under");
    assert_eq!(row(format!("{bryan}Odd (a) (b)")).await, (None, None), "nested parentheses stay as they are");
    assert_eq!(row(format!("{sam}Riders of Rohan (mine)")).await, (None, None), "never across owners");
}

#[test]
fn public_api_paths() {
    assert!(super::is_public_api("/api/public/decks/0123456789abcdef01234567"));
    assert!(!super::is_public_api("/api/public/decks/../me"));
    assert!(!super::is_public_api("/api/public/decks/"));
    let t = super::new_token();
    assert_eq!(t.len(), 24);
    assert!(super::valid_token(&t));
}

#[tokio::test]
async fn sharing_settings_need_the_owner() {
    let (app, _pool) = app().await;
    let (s, _) = send(&app, Method::GET, "/api/me/sharing", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = send(&app, Method::POST, "/api/me/sharing/decks", None, Some(json!({ "visibility": "public" }))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_shared_deck_page_says_what_the_deck_page_says() {
    let (app, pool) = app().await;
    let (_, bt) = user(&pool, "bryan@example.com").await;
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    sqlx::query("UPDATE cards SET cmc = 1, mana_cost = '{1}' WHERE oracle_id = 'o-sol'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE cards SET cmc = 1, mana_cost = '{R}' WHERE oracle_id = 'o-bolt'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-sol', '2026-10-26', 1.5), ('p-bolt', '2026-10-26', 2.25)").execute(&pool).await.unwrap();
    let text = "Commander\n1 Sol Ring\nDeck\n1 Lightning Bolt";
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Shared", "text": text }))).await;
    let id = made["id"].as_str().unwrap().to_string();
    send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "link", "bracket": 3 }))).await;
    let token = token_of(&pool, &id).await;

    // Before any check: legality, the declared bracket, stats and the list's market value.
    let (status, _, body) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Not legal yet"), "a two-card deck isn't legal");
    assert!(body.contains("Bracket 3 declared") && body.contains("Upgraded"));
    assert!(body.contains("Not checked yet"));
    assert!(body.contains("Deck stats") && body.contains("Mana curve"));
    assert!(body.contains("$3.75") && body.contains("in singles"), "{body}");
    assert!(body.contains("id=\"layout-stacks\"") && body.contains("public-stack-card"));
    assert!(!body.contains("Simulated games"), "no plan, no lab results");
    assert!(body.contains("Reserve List flags aren't loaded"), "unknown flags aren't read as none");
    sqlx::query("UPDATE cards SET reserved = (oracle_id = 'o-bolt')").execute(&pool).await.unwrap();
    let (_, _, body) = page(&app, &format!("/d/{token}")).await;
    assert!(body.contains("<b>1 card</b>: Lightning Bolt"), "{body}");

    // A stored check shows Yama's suggestion with its reasons; viewing never starts one.
    let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    sqlx::query(
        "UPDATE deck_version_checks SET checked_at = '2026-10-27T00:00:00Z', bracket_tag = 'P', game_changers = '[\"Sol Ring\"]', mld = '[]', extra_turns = '[]', combos = '[]', unrecognized = '[]' WHERE version_id = ?",
    )
    .bind(&version)
    .execute(&pool)
    .await
    .unwrap();
    let (_, _, body) = page(&app, &format!("/d/{token}")).await;
    assert!(body.contains("Suggested 3") && body.contains("Why this suggestion?"), "{body}");
    assert!(body.contains("Game Changers: 1") && body.contains("within bracket 3"));
}

#[tokio::test]
async fn a_shared_deck_page_shows_the_power_level_and_how_it_adds_up() {
    let (app, pool) = app().await;
    let (_, bt) = user(&pool, "bryan@example.com").await;
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    sqlx::query("UPDATE cards SET cmc = 1, oracle_text = '{T}: Add {C}{C}.', produced_mana = 'C' WHERE oracle_id = 'o-sol'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE cards SET cmc = 1, oracle_text = 'Lightning Bolt deals 3 damage to any target.', produced_mana = '' WHERE oracle_id = 'o-bolt'").execute(&pool).await.unwrap();
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&bt), Some(json!({ "name": "Shared", "text": "Commander\n1 Sol Ring\nDeck\n1 Lightning Bolt" }))).await;
    let id = made["id"].as_str().unwrap().to_string();
    send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&bt), Some(json!({ "visibility": "link" }))).await;
    let token = token_of(&pool, &id).await;

    // The power level needs no Spellbook check; without one, combos just don't count yet.
    let (_, _, body) = page(&app, &format!("/d/{token}")).await;
    assert!(body.contains("<h2 id=\"analysis-head\">Power level</h2>"), "{body}");
    assert!(body.contains("unofficial Yama estimate"), "{body}");
    for v in ["Speed", "Consistency", "Interaction", "Mana base", "Threats"] {
        assert!(body.contains(&format!("<span class=\"vector-label\">{v}</span>")), "{v}: {body}");
    }
    // Sol Ring is fast mana, half again as the commander; Lightning Bolt is instant removal.
    assert!(body.contains("How it adds up") && body.contains("<b>Fast mana</b>") && body.contains("Sol Ring 13.5"), "{body}");
    assert!(body.contains("<b>Spot removal</b>") && body.contains("Lightning Bolt 6.8"), "{body}");
    // The page's Content-Security-Policy allows no inline styles, so nothing may rely on one.
    assert!(!body.contains("style="), "an inline style the page can't use: {body}");
}

#[test]
fn configurations_stand_for_plan_states() {
    assert_eq!(super::plan_state(None), "now");
    assert_eq!(super::plan_state(Some("stock")), "stock");
    assert_eq!(super::plan_state(Some("After prints")), "after");
    assert_eq!(super::plan_state(Some("proposed bracket 3")), "proposed-bracket-3");
    assert_ne!(super::plan_state(Some("Now")), "now", "only the main deck is the plan's now list");
    assert_eq!(crate::lab::variant_state("bryan/riders-of-rohan-after", "riders-of-rohan").as_deref(), Some("after"));
    assert_eq!(crate::lab::variant_state("bryan/riders-of-rohan2-after", "riders-of-rohan"), None);
}

#[test]
fn a_deck_matches_a_plan_list_by_cards_not_label() {
    let deck = [("Éowyn", 1, "commander"), ("Sol Ring", 1, "main"), ("Island", 2, "main"), ("Spare", 1, "side")];
    let plan = [("island", 1, "main"), ("sol ring", 1, ""), ("Island", 1, "main"), ("éowyn", 1, "commander")];
    assert_eq!(super::list_key(deck.iter().copied()), super::list_key(plan.iter().copied()), "names, copies, roles; sideboard and order aside");
    assert_ne!(super::list_key(deck.iter().copied()), super::list_key([("Éowyn", 1, "commander"), ("Sol Ring", 1, "main")].iter().copied()));
    let swapped = [("Éowyn", 1, "main"), ("Sol Ring", 1, "commander"), ("Island", 2, "main")];
    assert_ne!(super::list_key(deck.iter().copied()), super::list_key(swapped.iter().copied()), "a different commander is a different list");
}

#[test]
fn a_build_compares_with_another_build_card_by_card() {
    use super::research::{Change, compare};
    let sw = |i: &str, o: &str| json!({"card_in": i, "card_out": o, "why": format!("{i} is better."), "why_out": format!("{o} is worse.")});
    let list = |cards: &[&str], plains: i64| format!("Commander\n1 Nalia\nDeck\n{}\n{plains} Plains", cards.iter().map(|c| format!("1 {c}")).collect::<Vec<_>>().join("\n"));
    let row = |add: &str, cut: &str, why: &str, notes: &[&str]| Change { add: add.into(), cut: cut.into(), n: 1, why: why.into(), notes: notes.iter().map(|n| n.to_string()).collect() };
    // Starting list: A B C D and 10 Plains.
    let (b2, b2s) = (list(&["X", "B", "C", "D"], 10), vec![sw("X", "A")]);
    let (b3, b3s) = (list(&["X", "Y", "Z", "D"], 10), vec![sw("X", "A"), sw("Y", "B"), sw("Z", "C")]);
    let b4s = vec![sw("X", "A"), sw("Y", "B"), sw("W", "C"), sw("V", "D"), json!({"card_in": "Sol Ring", "card_out": "Plains", "why": "Fast mana."})];
    let b4 = list(&["X", "Y", "W", "V", "Sol Ring"], 9);

    // Up a bracket: the higher build's own swaps, with their reasons.
    assert_eq!(compare(&b3, &b3s, &b2, &b2s, "B2"), vec![row("Y", "B", "Y is better.", &["Cut: B is worse."]), row("Z", "C", "Z is better.", &["Cut: C is worse."])]);
    // Down a bracket: the starting cards come back, and the other build says why it swaps them.
    assert_eq!(
        compare(&b2, &b2s, &b3, &b3s, "B3"),
        vec![
            row("B", "Y", "Keeps the starting list's card; B3 swaps it for Y.", &["Y: Y is better."]),
            row("C", "Z", "Keeps the starting list's card; B3 swaps it for Z.", &["Z: Z is better."]),
        ]
    );
    // Copies count (a Plains for Sol Ring), and two builds replacing one card differently pair up.
    assert_eq!(
        compare(&b4, &b4s, &b3, &b3s, "B3"),
        vec![
            row("V", "D", "V is better.", &["Cut: D is worse."]),
            row("Sol Ring", "Plains", "Fast mana.", &[]),
            row("W", "Z", "W is better.", &["Both builds cut C for these."]),
        ]
    );
    // Differences no swap explains still show, each on its own.
    let loose = compare(&list(&["X", "Q"], 10), &[], &list(&["X"], 12), &[], "B2");
    assert_eq!(loose, vec![Change { add: "Q".into(), n: 1, ..Default::default() }, Change { cut: "Plains".into(), n: 2, ..Default::default() }]);
    assert!(compare(&b3, &b3s, &b3, &b3s, "B3").is_empty());
    // Names compare as the card lookup matches them: ASCII case aside.
    assert!(compare(&list(&["Sol Ring", "Fire // Ice"], 10), &[], &list(&["sol ring", "Fire"], 10), &[], "B2").is_empty());
    // A pairing note stays with its swap when both builds replace the same card.
    let mut noted = b4s.clone();
    noted[2]["pairing_note"] = json!("Swap with the land change.");
    assert_eq!(compare(&b4, &noted, &b3, &b3s, "B3")[2].notes, vec!["Both builds cut C for these.".to_string(), "Swap with the land change.".to_string()]);
    // Many swaps replacing one card in both builds: each pairs once, in order, without a scan per pair.
    let many = |prefix: &str| (0..2000).map(|i| json!({"card_in": format!("{prefix}{i}"), "card_out": "Plains", "why": ""})).collect::<Vec<_>>();
    let many_list = |prefix: &str| format!("Commander\n1 Nalia\nDeck\n{}", (0..2000).map(|i| format!("1 {prefix}{i}")).collect::<Vec<_>>().join("\n"));
    let rows = compare(&many_list("New "), &many("New "), &many_list("Old "), &many("Old "), "B3");
    assert_eq!(rows.len(), 2000);
    assert_eq!((rows[0].add.as_str(), rows[0].cut.as_str(), rows[1999].cut.as_str()), ("New 0", "Old 0", "Old 1999"));
    // Two one-copy swaps of the same card each keep their own row and reason.
    let two = |a: &str, b: &str| vec![json!({"card_in": a, "card_out": "Forest", "why": "First."}), json!({"card_in": b, "card_out": "Forest", "why": "Second."})];
    let plains = format!("Commander\n1 Nalia\nDeck\n2 Plains\n8 Forest");
    let other = format!("Commander\n1 Nalia\nDeck\n1 Mountain\n1 Island\n8 Forest");
    let rows = compare(&plains, &two("Plains", "Plains"), &other, &two("Mountain", "Island"), "B3");
    assert_eq!(rows.iter().map(|r| (r.cut.as_str(), r.why.as_str(), r.n)).collect::<Vec<_>>(), vec![("Mountain", "First.", 1), ("Island", "Second.", 1)]);
    // A swap that only adds a card keeps its pairing note when nothing pairs with it.
    let add_only = vec![json!({"id": "x", "card_in": "Extra", "why": "More.", "pairing_note": "Cut a land for it."})];
    let rows = compare(&list(&["Extra"], 10), &add_only, &list(&[], 10), &[], "B2");
    assert_eq!(rows, vec![Change { add: "Extra".into(), n: 1, why: "More.".into(), notes: vec!["Cut a land for it.".into()], ..Default::default() }]);
    // The whole lists: builds that differ only past the page's list cap still differ.
    let long = |last: &str| format!("Commander\n1 Nalia\nDeck\n{}\n1 {last}", (0..300).map(|i| format!("1 Card {i}")).collect::<Vec<_>>().join("\n"));
    assert_eq!(compare(&long("Late A"), &[], &long("Late B"), &[], "B2"), vec![Change { add: "Late A".into(), n: 1, ..Default::default() }, Change { cut: "Late B".into(), n: 1, ..Default::default() }]);
}

fn note() -> serde_json::Value {
    json!({
        "schema": "yama-research/1", "id": "upgrades", "title": "Precon upgrade notes", "generated_at": "2026-10-31T00:00:00Z",
        "summary": "Stronger builds for the stock lists.",
        "method": ["Buy locally under $2; secret price ceiling."],
        "scenarios": [{"id": "shop", "label": "Secret shopping list", "buys": [{"card": "Sol Ring", "store": "Secret Store", "price": 1.25}]}],
        "decks": [{
            "key": "party", "name": "Party Time", "commander": "Nalia de'Arnise", "recommended_build": "b3",
            "ownership": "Owner holds a secret binder", "installed_state": "Installed secretly",
            "pilot": "Play a party member every turn.",
            "sources": [{"title": "EDHREC guide", "url": "https://edhrec.com/x"}, {"title": "Bad link", "url": "javascript:alert(1)"}],
            "builds": [{
                "id": "b3", "label": "Bracket 3 · Upgraded", "bracket": 3, "why": "Cleaner removal.",
                "list": "Commander\n1 Nalia de'Arnise\nDeck\n1 Swords to Plowshares\n98 Plains",
                "acquisition": {"buys": [{"card": "Swords to Plowshares", "store": "Hidden Hobby Shop", "price": 37.77}]},
                "swaps": [{"id": "stp", "card_in": "Swords to Plowshares", "card_out": "Stick Together", "why": "One-mana exile.", "why_out": "Symmetrical.", "pairing_note": "Swap together with the land change.",
                           "acquisition": {"store": "Hidden Hobby Shop", "price": 37.77}}]
            }]
        }]
    })
}

#[tokio::test]
async fn research_notes_are_private_until_shared_and_show_only_the_guide() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, other) = user(&pool, "other@example.com").await;
    sqlx::query("UPDATE users SET handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    crate::deck_research::save(&pool, &bryan, &note()).await.unwrap();
    let (s, _) = send(&app, Method::POST, "/api/research/upgrades/reviews", Some(&bt), Some(json!({
        "op_id": "op1", "target": "swap:party:b3:stp", "decision": "want", "note": "my private review note",
        "expected_version": 0,
        "target_hash": crate::util::sha256_hex(&note()["decks"][0]["builds"][0]["swaps"][0].to_string())
    }))).await;
    assert_eq!(s, StatusCode::OK);

    // Private: no link yet, and the owner list says so.
    let (_, list) = send(&app, Method::GET, "/api/research", Some(&bt), None).await;
    assert_eq!(list[0]["visibility"], "private");
    assert!(list[0]["share_token"].is_null());

    // Someone else can't share it; it isn't theirs.
    let (s, _) = send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&other), Some(json!({"visibility": "public"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "everyone"}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Link: the note, its deck page and the download work signed out; the profile doesn't list it.
    let (s, shared) = send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "link"}))).await;
    assert_eq!(s, StatusCode::OK);
    let token = shared["share_token"].as_str().unwrap().to_string();
    assert_eq!(shared["link"], format!("/r/{token}"));
    let (status, headers, body) = page(&app, &format!("/r/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Precon upgrade notes") && body.contains("Party Time") && body.contains("@saget"));
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    let (status, _, deck) = page(&app, &format!("/r/{token}/party")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(deck.contains("href=\"https://edhrec.com/x\"") && deck.contains("Bad link") && !deck.contains("javascript:"));
    assert!(deck.contains("1 in, 1 out from the starting list"));
    for shown in ["Swap together with the land change.", "Cleaner removal.", "Play a party member every turn.", "One-mana exile.", "Symmetrical.", "Swords to Plowshares", "Stick Together"] {
        assert!(deck.contains(shown), "{shown}");
    }
    // The price paid is a number no page draws for any other reason (the frame's icons have
    // plenty of small decimals in their shapes).
    for hidden in ["my private review note", "secret price ceiling", "Secret Store", "Hidden Hobby Shop", "Secret shopping list", "secret binder", "Installed secretly", "37.77"] {
        assert!(!body.contains(hidden) && !deck.contains(hidden), "{hidden}");
    }
    // A cut card isn't in the build's list; its row still gets its image for the preview.
    card(&pool, "o-stick", "Stick Together", "Sorcery", "p-stick", "afc", "1").await;
    sqlx::query("UPDATE cards SET image_normal = 'https://cards.scryfall.io/normal/stick.jpg' WHERE oracle_id = 'o-stick'").execute(&pool).await.unwrap();
    let with_cut = page(&app, &format!("/r/{token}/party")).await.2;
    assert!(with_cut.contains("data-card-name=\"Stick Together\" data-card-image=\"https://cards.scryfall.io/normal/stick.jpg\""), "cut card's image");
    let (status, _, file) = page(&app, &format!("/r/{token}/party/b3-names.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(file.starts_with("Commander\n1 Nalia de'Arnise\n"), "{file}");
    assert!(file.contains("98 Plains"));
    // Names resolve as written, accents included, in one lookup.
    card(&pool, "o-eowyn", "Éowyn, Lady of Rohan", "Legendary Creature — Human Noble", "p-eowyn", "ltr", "10").await;
    sqlx::query("UPDATE cards SET image_normal = 'https://cards.scryfall.io/normal/eowyn.jpg' WHERE oracle_id = 'o-eowyn'").execute(&pool).await.unwrap();
    let mut with_eowyn = note();
    with_eowyn["decks"][0]["builds"][0]["list"] = json!("Commander\n1 Nalia de'Arnise\nDeck\n1 Éowyn, Lady of Rohan\n98 Plains");
    with_eowyn["decks"][0]["builds"][0]["swaps"] = json!([]);
    crate::deck_research::save(&pool, &bryan, &with_eowyn).await.unwrap();
    let eowyn = page(&app, &format!("/r/{token}/party")).await.2;
    assert!(eowyn.contains("https://cards.scryfall.io/normal/eowyn.jpg"), "Éowyn's image");
    assert!(!eowyn.contains("Not in Yama's card data: Nalia de&#39;Arnise, Éowyn"));
    // Changes from another build: the heading picks it, and the rows compare the two lists.
    let mut two = note();
    two["decks"][0]["builds"] = json!([
        {"id": "b2", "label": "Bracket 2 · Core", "list": "Commander\n1 Nalia de'Arnise\nDeck\n1 Stick Together\n98 Plains", "swaps": []},
        note()["decks"][0]["builds"][0].clone(),
    ]);
    crate::deck_research::save(&pool, &bryan, &two).await.unwrap();
    let start = page(&app, &format!("/r/{token}/party")).await.2;
    assert!(start.contains("Compare with: the starting list") && start.contains(&format!("href=\"/r/{token}/party?build=b3&amp;vs=b2#changes-head\">Bracket 2 · Core</a>")), "{start}");
    let (status, _, up) = page(&app, &format!("/r/{token}/party?build=b3&vs=b2")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(up.contains("<summary aria-label=\"Compare with: Bracket 2 · Core\">Bracket 2 · Core</summary>"));
    assert!(up.contains("One-mana exile.") && up.contains("Cut: Symmetrical.") && up.contains("Swap together with the land change."));
    assert!(up.contains(&format!("href=\"/r/{token}/party?build=b2\">")), "switching to the compared build drops the comparison");
    let down = page(&app, &format!("/r/{token}/party?build=b2&vs=b3")).await.2;
    assert!(down.contains("Keeps the starting list&#39;s card; Bracket 3 · Upgraded swaps it for Swords to Plowshares.") && down.contains("Swords to Plowshares: One-mana exile.") && down.contains("Swap together with the land change."), "{down}");
    assert!(down.contains(&format!("href=\"/r/{token}/party?build=b3\">")), "no build is compared with itself");
    for bad in ["vs=b3", "vs=b9"] {
        assert_eq!(page(&app, &format!("/r/{token}/party?build=b3&{bad}")).await.0, StatusCode::NOT_FOUND, "{bad}");
    }
    crate::deck_research::save(&pool, &bryan, &note()).await.unwrap();
    assert_eq!(page(&app, &format!("/r/{token}/nope")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, &format!("/r/{token}/party?build=b9")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, &format!("/r/{token}/party/b9-names.txt")).await.0, StatusCode::NOT_FOUND);
    assert!(!page(&app, "/u/saget").await.2.contains(&format!("/r/{token}")));

    // Public: listed on the profile. Refreshing the note keeps its sharing and link.
    send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "public"}))).await;
    assert!(page(&app, "/u/saget").await.2.contains(&format!("/r/{token}")));
    let mut changed = note();
    changed["title"] = json!("Upgrades, revised");
    crate::deck_research::save(&pool, &bryan, &changed).await.unwrap();
    let (_, bundle) = send(&app, Method::GET, "/api/research/upgrades", Some(&bt), None).await;
    assert_eq!((bundle["visibility"].as_str(), bundle["share_token"].as_str()), (Some("public"), Some(token.as_str())));
    assert!(page(&app, &format!("/r/{token}")).await.2.contains("Upgrades, revised"));

    // A new link ends the old one; private ends both; a disabled account shares nothing.
    let (_, reset) = send(&app, Method::POST, "/api/research/upgrades/share-link", Some(&bt), None).await;
    let fresh_token = reset["share_token"].as_str().unwrap().to_string();
    assert_ne!(fresh_token, token);
    assert_eq!(page(&app, &format!("/r/{token}")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, &format!("/r/{fresh_token}")).await.0, StatusCode::OK);
    sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    assert_eq!(page(&app, &format!("/r/{fresh_token}")).await.0, StatusCode::NOT_FOUND);
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "private"}))).await;
    let (status, _, body) = page(&app, &format!("/r/{fresh_token}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("Precon upgrade notes"));
    assert!(!page(&app, "/u/saget").await.2.contains("/r/"));
}

#[test]
fn the_public_view_of_a_note_is_an_allow_list() {
    let view = crate::deck_research::public_view(&note());
    let text = view.to_string();
    for hidden in ["scenarios", "acquisition", "ownership", "installed_state", "method", "Hidden Hobby Shop", "Secret"] {
        assert!(!text.contains(hidden), "{hidden}");
    }
    assert_eq!(view["decks"][0]["builds"][0]["swaps"][0]["why"], "One-mana exile.");
    assert_eq!(view["decks"][0]["pilot"], "Play a party member every turn.");
}

#[tokio::test]
async fn a_shared_note_can_be_copied_without_its_private_parts() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, ft) = user(&pool, "friend@example.com").await;
    crate::deck_research::save(&pool, &bryan, &note()).await.unwrap();
    let copy = |t: &str| json!({"token": t});
    // Private: nothing to copy, the same as no note at all.
    assert_eq!(send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy("0123456789abcdef01234567"))).await.0, StatusCode::NOT_FOUND);
    let (_, shared) = send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "link"}))).await;
    let token = shared["share_token"].as_str().unwrap().to_string();
    assert_eq!(send(&app, Method::POST, "/api/research/copy", None, Some(copy(&token))).await.0, StatusCode::UNAUTHORIZED);

    let (s, copied) = send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy(&token))).await;
    assert_eq!(s, StatusCode::OK, "{copied}");
    assert_eq!(copied["id"], "upgrades");
    let (_, mine) = send(&app, Method::GET, "/api/research/upgrades", Some(&ft), None).await;
    let doc = &mine["document"];
    assert_eq!(doc["copied_from"]["link"], format!("/r/{token}"));
    assert_eq!(doc["decks"][0]["builds"][0]["swaps"][0]["card_in"], "Swords to Plowshares");
    assert!(doc.get("method").is_none() && doc.get("scenarios").is_none(), "{doc}");
    assert!(doc["decks"][0].get("ownership").is_none() && doc["decks"][0]["builds"][0].get("acquisition").is_none());
    assert!(mine["reviews"].as_array().is_none_or(Vec::is_empty), "the sharer's answers stay theirs");
    // A copy never replaces a note already there, the sharer's own included.
    assert_eq!(send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy(&token))).await.1["id"], "upgrades-copy");
    assert_eq!(send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy(&token))).await.1["id"], "upgrades-copy-2");
    assert_eq!(send(&app, Method::POST, "/api/research/copy", Some(&bt), Some(copy(&token))).await.1["id"], "upgrades-copy");
    let (_, own) = send(&app, Method::GET, "/api/research/upgrades", Some(&bt), None).await;
    assert!(own["document"].get("method").is_some(), "the original is untouched");
    // The insert decides: a note that appeared since the ids were read is refused, not replaced.
    let mut late = note();
    late["title"] = json!("Replaced?");
    assert!(crate::deck_research::save_new(&pool, &bryan, &late, None).await.unwrap().is_none());
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades", Some(&bt), None).await.1["document"]["title"], "Precon upgrade notes");
    // Copies at the same moment each get their own note.
    let (a, b) = tokio::join!(
        send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy(&token))),
        send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(copy(&token)))
    );
    assert_eq!((a.0, b.0), (StatusCode::OK, StatusCode::OK), "{} {}", a.1, b.1);
    assert_ne!(a.1["id"], b.1["id"]);
    // One Save-a-copy action retried (a lost answer, a reload) gets the copy it already made.
    let once = json!({"token": token, "op": "op-123"});
    let first = send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(once.clone())).await.1;
    let again = send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(once)).await.1;
    assert_eq!((first["id"].clone(), again["changed"].clone()), (again["id"].clone(), json!(false)), "{first} {again}");
    assert_eq!(send(&app, Method::POST, "/api/research/copy", Some(&ft), Some(json!({"token": token, "op": "bad op!"}))).await.0, StatusCode::BAD_REQUEST);
    // Its pages offer the copy.
    let link = format!("href=\"/decks/research?copy={token}\"");
    assert!(page(&app, &format!("/r/{token}")).await.2.contains(&link));
    assert!(page(&app, &format!("/r/{token}/party")).await.2.contains(&link));
}

#[tokio::test]
async fn shared_notes_price_the_cards_to_get() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    card(&pool, "o-stp", "Swords to Plowshares", "Instant", "p-stp", "sta", "10").await;
    card(&pool, "o-signet", "Arcane Signet", "Artifact", "p-signet", "cmm", "20").await;
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-stp', '2026-10-30', 4.25), ('p-signet', '2026-10-30', 0.5)").execute(&pool).await.unwrap();
    let mut doc = note();
    doc["decks"][0]["builds"][0]["swaps"] = json!([
        {"id": "stp", "card_in": "Swords to Plowshares", "card_out": "Stick Together", "why": "One-mana exile."},
        {"id": "signet", "card_in": "Arcane Signet", "card_out": "Plains", "why": "Ramp."},
        {"id": "mystery", "card_in": "Mystery Card", "card_out": "Plains", "why": "Unknown to Yama."}
    ]);
    crate::deck_research::save(&pool, &bryan, &doc).await.unwrap();
    let (_, shared) = send(&app, Method::PUT, "/api/research/upgrades/sharing", Some(&bt), Some(json!({"visibility": "link"}))).await;
    let token = shared["share_token"].as_str().unwrap().to_string();

    // A deck page: each added card, how to get it and what it comes to.
    let deck = page(&app, &format!("/r/{token}/party")).await.2;
    for shown in [
        "3 cards to add to the starting list",
        "1 to buy locally: about $0.50",
        "1 to print: about $0.30",
        "Worth $4.75",
        "About $0.80 to get",
        "as of Oct 30, 2026",
        "1 card without a market price in Yama is out of the worth.",
        "<td class=\"get\">Buy locally</td><td class=\"num\">$0.50</td>",
        "<td class=\"get\">Print</td><td class=\"num\">$4.25</td><td class=\"num\">$0.30</td>",
        "<td class=\"get\">No price</td>",
        // The list as text to copy, a box per way of getting the cards.
        "id=\"shop-buy\" readonly rows=\"8\" aria-label=\"Buy locally (1 card)\">1 Arcane Signet\n</textarea>",
        "id=\"shop-print\" readonly rows=\"8\" aria-label=\"Print (1 card)\">1 Swords to Plowshares\n</textarea>",
        ">1 Mystery Card\n</textarea>",
        "data-copy=\"shop-buy\" hidden>Copy</button>",
        // The decklist to copy, in the standard format.
        "id=\"decklist\" readonly rows=\"12\" aria-label=\"Standard list (Commander, then Deck)\">Commander\n1 Nalia de&#39;Arnise\n\nDeck\n",
    ] {
        assert!(deck.contains(shown), "{shown}");
    }
    // Print every card, or buy every card: the totals follow.
    let print = page(&app, &format!("/r/{token}/party?get=print")).await.2;
    assert!(print.contains(&format!("class=\"back-link\" href=\"/r/{token}?get=print\"")), "the way back keeps the choice");
    assert!(print.contains("3 to print: about $0.90") && print.contains("About $0.90 to get") && !print.contains("to buy locally"), "{print}");
    let buy = page(&app, &format!("/r/{token}/party?get=buy")).await.2;
    assert!(buy.contains("3 to buy locally: about $4.75 + 1 without a price") && buy.contains("About $4.75 to get") && buy.contains("1 card without a known cost is out of the cost."), "{buy}");
    // The choice stays when switching builds or comparisons.
    assert!(buy.contains("&amp;get=buy"), "{buy}");
    assert!(buy.contains("aria-current=\"page\" href=\"/r/") && buy.contains(">Buy every card locally</a>"));
    assert_eq!(page(&app, &format!("/r/{token}/party?get=steal")).await.0, StatusCode::NOT_FOUND);
    // The reader sets the split's limit: a form under the choices, $2.00 to start.
    assert!(
        deck.contains(&format!("<form class=\"share-upto\" method=\"get\" action=\"/r/{token}/party#shop-head\"><input type=\"hidden\" name=\"build\" value=\"b3\">"))
            && deck.contains("name=\"upto\" type=\"number\"")
            && deck.contains("value=\"2.00\"></span><button type=\"submit\">Update</button></form>"),
        "{deck}"
    );
    assert!(!print.contains("class=\"share-upto\""), "only the split has a limit");
    let five = page(&app, &format!("/r/{token}/party?upto=5")).await.2;
    assert!(five.contains(">Buy up to $5.00, print the rest</a>") && five.contains("2 to buy locally: about $4.75") && five.contains("0 to print: about $0.00"), "{five}");
    assert!(five.contains("A card at $5.00 or less is bought at a local store") && five.contains("Yama suggests $2.00.") && five.contains("value=\"5.00\">"), "{five}");
    // The limit stays in the page's links, under every way of getting the cards.
    assert!(five.contains(&format!("class=\"back-link\" href=\"/r/{token}?upto=5.00\"")), "{five}");
    assert!(five.contains("&amp;get=buy&amp;upto=5.00#shop-head\">Buy every card locally</a>"), "{five}");
    let printing = page(&app, &format!("/r/{token}/party?get=print&upto=5")).await.2;
    assert!(printing.contains("&amp;upto=5.00#shop-head\">Buy up to $5.00, print the rest</a>"), "switching back keeps the limit");
    let cheap = page(&app, &format!("/r/{token}/party?upto=0.25")).await.2;
    assert!(cheap.contains("0 to buy locally: about $0.00") && cheap.contains("2 to print: about $0.60"), "{cheap}");
    // At the limit is bought; an empty limit is the suggested one; anything else isn't a limit.
    assert!(page(&app, &format!("/r/{token}/party?upto=%244.25")).await.2.contains("2 to buy locally"));
    assert!(page(&app, &format!("/r/{token}/party?upto=")).await.2.contains("About $0.80 to get"));
    assert!(page(&app, &format!("/r/{token}/party?upto=1000")).await.2.contains(">Buy up to $1,000.00, print the rest</a>"), "the top of the range");
    assert!(page(&app, &format!("/r/{token}/party?upto=.5")).await.2.contains("value=\"0.50\">"));
    for bad in ["-1", "abc", "1e3", "2000", "1000.004", "1000.01", "2.005", "1.2.3", ".", "%2B2", "inf", "NaN"] {
        assert_eq!(page(&app, &format!("/r/{token}/party?upto={bad}")).await.0, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(page(&app, &format!("/r/{token}?upto={bad}")).await.0, StatusCode::NOT_FOUND, "{bad}");
    }
    let note_five = page(&app, &format!("/r/{token}?build=b3&upto=5")).await.2;
    assert!(note_five.contains("About $4.75 to get") && note_five.contains(&format!("<a href=\"/r/{token}/party?build=b3&amp;upto=5.00\">Party Time</a>")), "{note_five}");
    assert!(note_five.contains(&format!("action=\"/r/{token}#shop-head\"><input type=\"hidden\" name=\"build\" value=\"b3\">")), "{note_five}");
    // The note page: per deck, overall, and every card with the decks it goes in.
    let (status, _, body) = page(&app, &format!("/r/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("3 cards to get across 1 deck<") && body.contains("About $0.80 to get") && body.contains("<td class=\"dim\">Party Time</td>"), "{body}");
    assert!(body.contains("id=\"lists-head\">Deck lists</h2>") && body.contains("// Party Time: Bracket 3 · Upgraded\nCommander\n"), "{body}");
    let printed = page(&app, &format!("/r/{token}?get=print")).await.2;
    assert!(printed.contains(&format!("<a href=\"/r/{token}/party?get=print\">Party Time</a>")), "deck rows keep the choice");
    assert!(printed.contains(&format!("<a class=\"share-deck-main\" href=\"/r/{token}/party?get=print\">")), "deck tiles keep the choice");
    assert!(page(&app, &format!("/r/{token}?build=b3&get=print")).await.2.contains(&format!("<a href=\"/r/{token}/party?build=b3&amp;get=print\">Party Time</a>")));
    assert_eq!(page(&app, &format!("/r/{token}?get=steal")).await.0, StatusCode::NOT_FOUND);
    assert!(body.contains("<td class=\"num\">1, $0.30</td>"), "the print column");
    // One build across the decks; one no deck has is not found.
    let (status, _, b3) = page(&app, &format!("/r/{token}?build=b3")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(b3.contains("About $0.80 to get"));
    assert_eq!(page(&app, &format!("/r/{token}?build=b9")).await.0, StatusCode::NOT_FOUND);
    // Every build as its own deck, from one precon: shared cards count once per build.
    let mut both = note();
    both["decks"][0]["recommended_build"] = json!("b3");
    both["decks"][0]["builds"] = json!([
        {"id": "b2", "label": "Bracket 2", "list": "Commander\n1 Nalia de'Arnise\nDeck\n1 Stick Together\n1 Arcane Signet",
         "swaps": [{"id": "signet", "card_in": "Arcane Signet", "card_out": "Plains"}]},
        {"id": "b3", "label": "Bracket 3", "list": "Commander\n1 Nalia de'Arnise\nDeck\n1 Swords to Plowshares\n1 Arcane Signet",
         "swaps": [{"id": "signet", "card_in": "Arcane Signet", "card_out": "Plains"}, {"id": "stp", "card_in": "Swords to Plowshares", "card_out": "Stick Together"}]}
    ]);
    crate::deck_research::save(&pool, &bryan, &both).await.unwrap();
    let all = page(&app, &format!("/r/{token}?builds=all")).await.2;
    assert_eq!(page(&app, &format!("/r/{token}?builds=some")).await.0, StatusCode::NOT_FOUND);
    // Nalia once more, two Signets, one Swords; the Stick Together b2 keeps is the precon's.
    assert!(all.contains("4 cards to get across 1 deck<") && all.contains("<td>All 2 builds<br><small>") && all.contains("2 to buy locally: about $1.00"), "{all}");
    assert!(all.contains(&format!("<a href=\"/r/{token}/party?build=b2\">Bracket 2</a>, <a href=\"/r/{token}/party?build=b3\">Bracket 3</a>")), "each build counted links to its page");
    assert!(all.contains("id=\"shop-buy\" readonly rows=\"8\" aria-label=\"Buy locally (2 cards)\">2 Arcane Signet\n</textarea>"), "{all}");
    assert!(all.contains("// Party Time: Bracket 2\n") && all.contains("// Party Time: Bracket 3\n") && all.contains("aria-label=\"Every list (2)\""), "{all}");
    assert!(all.contains(">All builds</a>") && all.contains("aria-current=\"page\" href=\"/r/"), "{all}");
    crate::deck_research::save(&pool, &bryan, &doc).await.unwrap();
    // A list too long to copy on the page is a download instead, and there's no one-text box.
    let mut long = both.clone();
    long["decks"][0]["builds"][0]["list"] = json!(format!("Commander\n1 Nalia de'Arnise\nDeck\n{}", (0..400).map(|i| format!("1 Card {i}")).collect::<Vec<_>>().join("\n")));
    crate::deck_research::save(&pool, &bryan, &long).await.unwrap();
    let longer = page(&app, &format!("/r/{token}?builds=all")).await.2;
    assert!(longer.contains(&format!("href=\"/r/{token}/party/b2-names.txt\" download>Download</a>")) && !longer.contains("id=\"lists-all\"") && longer.contains("id=\"list-1\""), "{longer}");
    // Counts too large to add up saturate rather than wrap or panic.
    let mut huge = both.clone();
    huge["decks"][0]["builds"][0]["list"] = json!(format!("Commander\n1 Nalia de'Arnise\nDeck\n{} Plains", i64::MAX));
    huge["decks"][0]["builds"][1]["list"] = json!(format!("Commander\n1 Nalia de'Arnise\nDeck\n{} Plains", i64::MAX));
    crate::deck_research::save(&pool, &bryan, &huge).await.unwrap();
    assert_eq!(page(&app, &format!("/r/{token}?builds=all")).await.0, StatusCode::OK);
    // A build may be called "all": the every-build view has its own parameter.
    let mut named = both.clone();
    named["decks"][0]["builds"][0]["id"] = json!("all");
    crate::deck_research::save(&pool, &bryan, &named).await.unwrap();
    assert!(page(&app, &format!("/r/{token}?builds=all")).await.2.contains("<td>All 2 builds<br>"));
    assert!(page(&app, &format!("/r/{token}?build=all")).await.2.contains("<td>Bracket 2</td>"));
    crate::deck_research::save(&pool, &bryan, &doc).await.unwrap();
    // Nothing priced: worth and cost are unknown, never $0.
    doc["decks"][0]["builds"][0]["swaps"] = json!([{"id": "mystery", "card_in": "Mystery Card", "card_out": "Plains"}]);
    crate::deck_research::save(&pool, &bryan, &doc).await.unwrap();
    let unpriced = page(&app, &format!("/r/{token}/party")).await.2;
    assert!(unpriced.contains("Worth unknown") && unpriced.contains("Cost unknown") && !unpriced.contains("Worth $0.00"), "{unpriced}");
}

/// The app's plan pages read the shared pages' own computations for the owner, from the whole
/// note, private or not; nobody else gets them.
#[tokio::test]
async fn the_owners_plan_pages_get_what_the_shared_pages_work_out() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, other) = user(&pool, "other@example.com").await;
    card(&pool, "o-stp", "Swords to Plowshares", "Instant", "p-stp", "sta", "10").await;
    card(&pool, "o-signet", "Arcane Signet", "Artifact", "p-signet", "cmm", "20").await;
    card(&pool, "o-nalia", "Nalia de'Arnise", "Legendary Creature — Human Fighter", "p-nalia", "clb", "30").await;
    sqlx::query("UPDATE cards SET image_art_crop = 'https://cards.scryfall.io/art_crop/nalia.jpg', artist = 'John Stanko', color_identity = 'WB' WHERE oracle_id = 'o-nalia'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-stp', '2026-10-30', 4.25), ('p-signet', '2026-10-30', 0.5)").execute(&pool).await.unwrap();
    let mut doc = note();
    doc["decks"][0]["builds"][0]["swaps"] = json!([
        {"id": "stp", "card_in": "Swords to Plowshares", "card_out": "Stick Together", "why": "One-mana exile."},
        {"id": "signet", "card_in": "Arcane Signet", "card_out": "Plains", "why": "Ramp."},
        {"id": "mystery", "card_in": "Mystery Card", "card_out": "Plains", "why": "Unknown to Yama."}
    ]);
    crate::deck_research::save(&pool, &bryan, &doc).await.unwrap();

    // The note's content hash comes with it: Track this build sends it back, so a note changed
    // since the page loaded isn't tracked.
    let (_, bundle) = send(&app, Method::GET, "/api/research/upgrades", Some(&bt), None).await;
    assert_eq!(bundle["content_hash"].as_str().map(str::len), Some(64), "{bundle}");
    // Private, and still the owner's to read; nobody else's, and not signed out.
    let (s, view) = send(&app, Method::GET, "/api/research/upgrades/view", Some(&bt), None).await;
    assert_eq!(s, StatusCode::OK, "{view}");
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view", Some(&other), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view/party", Some(&other), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view", None, None).await.0, StatusCode::UNAUTHORIZED);

    // The note page: the same totals the shared page shows, cards to buy first.
    let total = &view["shopping"]["total"];
    assert_eq!((total["cards"].as_i64(), total["buy"].as_i64(), total["print"].as_i64(), total["unpriced"].as_i64()), (Some(3), Some(1), Some(1), Some(1)));
    assert_eq!((total["worth"].as_f64(), total["cost"].as_f64()), (Some(4.75), Some(0.8)));
    let items: Vec<(&str, &str)> = view["shopping"]["items"].as_array().unwrap().iter().map(|i| (i["name"].as_str().unwrap(), i["get"].as_str().unwrap())).collect();
    assert_eq!(items, [("Arcane Signet", "buy"), ("Swords to Plowshares", "print"), ("Mystery Card", "unknown")]);
    assert_eq!(view["shopping"]["prices_from"], "2026-10-30");
    assert_eq!(view["shopping"]["get"], "split");
    assert_eq!(view["decks"][0]["key"], "party");
    assert_eq!(view["decks"][0]["label"], "Bracket 3 · Upgraded");
    assert_eq!(view["decks"][0]["identity"], "WB");
    assert_eq!(view["decks"][0]["art"]["artist"], "John Stanko");
    // The choices: print everything; a build no deck has; a way of getting cards that isn't one.
    let print = send(&app, Method::GET, "/api/research/upgrades/view?get=print", Some(&bt), None).await.1;
    assert_eq!((print["shopping"]["total"]["print"].as_i64(), print["shopping"]["get"].as_str()), (Some(3), Some("print")));
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view?build=b9", Some(&bt), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view?get=steal", Some(&bt), None).await.0, StatusCode::BAD_REQUEST);
    // The owner's Plans page sets the split's limit the same way (`?upto=`).
    assert_eq!((view["shopping"]["up_to"].as_f64(), view["shopping"]["up_to_suggested"].as_f64(), view["shopping"]["up_to_max"].as_f64()), (Some(2.0), Some(2.0), Some(1000.0)));
    let five = send(&app, Method::GET, "/api/research/upgrades/view?upto=5", Some(&bt), None).await.1;
    assert_eq!((five["shopping"]["up_to"].as_f64(), five["shopping"]["total"]["print"].as_i64()), (Some(5.0), Some(0)), "{five}");
    assert_eq!(five["shopping"]["gets"][0]["label"], "Buy up to $5.00, print the rest");
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view/party?upto=5", Some(&bt), None).await.1["shopping"]["up_to"].as_f64(), Some(5.0));
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view?upto=1000.01", Some(&bt), None).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view?builds=all", Some(&bt), None).await.1["which"], "all");

    // A deck's page: the changes with their reasons, what the added cards come to, the list as cards.
    let (s, deck) = send(&app, Method::GET, "/api/research/upgrades/view/party", Some(&bt), None).await;
    assert_eq!(s, StatusCode::OK, "{deck}");
    let changes: Vec<(&str, &str, &str)> = deck["changes"].as_array().unwrap().iter().map(|c| (c["add"].as_str().unwrap(), c["cut"].as_str().unwrap(), c["why"].as_str().unwrap())).collect();
    assert_eq!(changes[0], ("Swords to Plowshares", "Stick Together", "One-mana exile."));
    assert_eq!(changes.len(), 3);
    assert_eq!(deck["vs_label"], "the starting list");
    assert_eq!(deck["shopping"]["total"]["cost"].as_f64(), Some(0.8));
    assert_eq!(deck["cards"][0]["name"], "Nalia de'Arnise");
    assert_eq!(deck["cards"][0]["board"], "commander");
    assert_eq!(deck["art"]["image"], "https://cards.scryfall.io/art_crop/nalia.jpg");
    // Each row from the starting list names its swap, for the owner's answer beside it.
    assert_eq!(deck["changes"][1]["swap"], "signet");
    assert!(deck["text"].as_str().unwrap().starts_with("Commander\n1 Nalia de'Arnise\n\nDeck\n"));
    assert_eq!(view["lists"][0]["deck"], "party");
    assert!(view["lists"][0]["text"].as_str().unwrap().contains("98 Plains"));
    // Comparing a build with itself, an unknown build or deck: not found.
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view/party?vs=b3", Some(&bt), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view/party?build=b9", Some(&bt), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::GET, "/api/research/upgrades/view/nobody", Some(&bt), None).await.0, StatusCode::NOT_FOUND);

    // The Plans page's tiles: each note's deck count and commanders' art, only the owner's.
    let (_, plans) = send(&app, Method::GET, "/api/research-plans", Some(&bt), None).await;
    assert_eq!(plans[0]["id"], "upgrades");
    assert_eq!(plans[0]["decks"], 1);
    assert_eq!(plans[0]["art"][0]["commander"], "Nalia de'Arnise");
    assert!(plans[0]["copied_by"].is_null());
    // And a tile per deck plan: its name, commander art, the build to make.
    let party = &plans[0]["deck_plans"][0];
    assert_eq!((party["key"].as_str(), party["name"].as_str()), (Some("party"), Some("Party Time")));
    assert_eq!(party["builds"], json!([{"id": "b3", "label": "Bracket 3 · Upgraded"}]));
    assert_eq!(party["recommended"], "b3");
    assert!(party["preferred"].is_null());
    // Review's count: the build's three changes, none answered yet.
    assert_eq!(party["to_answer"], 3);
    assert_eq!(party["art"]["artist"], "John Stanko");
    assert_eq!(party["identity"], "WB");
    // The owner's pick of a build shows once they've made one.
    let hash = bundle["target_hashes"]["deck:party"].as_str().unwrap().to_string();
    let (s, _) = send(&app, Method::POST, "/api/research/upgrades/reviews", Some(&bt), Some(json!({"op_id": "pick", "target": "deck:party", "decision": "b3", "note": null, "expected_version": 0, "target_hash": hash}))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, plans) = send(&app, Method::GET, "/api/research-plans", Some(&bt), None).await;
    assert_eq!(plans[0]["deck_plans"][0]["preferred"], "b3");
    // An answer (not a bare note) takes a change off the count.
    let swap_hash = bundle["target_hashes"]["swap:party:b3:stp"].as_str().unwrap().to_string();
    let answer = |op: &str, decision: Option<&str>| json!({"op_id": op, "target": "swap:party:b3:stp", "decision": decision, "note": "later", "expected_version": if op == "a1" { 0 } else { 1 }, "target_hash": swap_hash});
    assert_eq!(send(&app, Method::POST, "/api/research/upgrades/reviews", Some(&bt), Some(answer("a1", None))).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::GET, "/api/research-plans", Some(&bt), None).await.1[0]["deck_plans"][0]["to_answer"], 3);
    assert_eq!(send(&app, Method::POST, "/api/research/upgrades/reviews", Some(&bt), Some(answer("a2", Some("want")))).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::GET, "/api/research-plans", Some(&bt), None).await.1[0]["deck_plans"][0]["to_answer"], 2);
    // The assistant changes that swap: the answer is to a swap that's gone, so it's open again,
    // as the plan's page asks for a new answer.
    let mut changed = doc.clone();
    changed["decks"][0]["builds"][0]["swaps"][0]["why"] = json!("One-mana exile, and it hits anything.");
    crate::deck_research::save(&pool, &bryan, &changed).await.unwrap();
    assert_eq!(send(&app, Method::GET, "/api/research-plans", Some(&bt), None).await.1[0]["deck_plans"][0]["to_answer"], 3);
    assert_eq!(send(&app, Method::GET, "/api/research-plans", Some(&other), None).await.1, json!([]));
}

#[test]
fn builds_are_named_by_bracket_one_way() {
    use super::research::build_title;
    assert_eq!(build_title("[2] Buildable now"), "Bracket 2: Buildable now");
    assert_eq!(build_title("[3]"), "Bracket 3");
    assert_eq!(build_title("B4 - Combo"), "Bracket 4: Combo");
    assert_eq!(build_title("Bracket 3 · Upgraded"), "Bracket 3 · Upgraded");
    assert_eq!(build_title("Budget build"), "Budget build");
    assert_eq!(build_title("B52 bomber"), "B52 bomber");
    assert_eq!(build_title("Current"), "Current");
}

/// Adds copies through the collection's own ops: (scryfall id, qty, proxy, container).
async fn copies(app: &Router, auth: &str, op: &str, printing: &str, qty: i64, proxy: bool, container: Option<&serde_json::Value>) {
    let ops = json!([{ "op_id": op, "kind": "add", "scryfall_id": printing, "qty": qty, "proxy": proxy, "container_id": container, "finish": "nonfoil" }]);
    assert_eq!(send(app, Method::POST, "/api/collection/ops", Some(auth), Some(ops)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_want_list_is_private_until_shared_and_shows_only_cards() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan.secret@example.com").await;
    sqlx::query("UPDATE users SET display_name = 'Bryan Fullname', handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-signet", "Arcane Signet", "Artifact", "p-signet", "cmm", "395").await;
    let want = |body: serde_json::Value| send(&app, Method::POST, "/api/plan/wants", Some(&bt), Some(body));
    assert_eq!(want(json!({"name": "sol ring", "qty": 2, "deck_name": "Secret Deck", "why": "a private reason"})).await.0, StatusCode::OK);
    assert_eq!(want(json!({"name": "Arcane Signet", "priority": "along"})).await.0, StatusCode::OK);

    // Off by default: the page and its download are the same "not found" as an unknown profile.
    let (status, headers, body) = page(&app, "/u/saget/wants").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("Sol Ring"));
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(page(&app, "/u/saget/wants.txt").await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, "/u/nobody/wants").await.0, StatusCode::NOT_FOUND);
    assert!(!page(&app, "/u/saget").await.2.contains("/u/saget/wants"));

    let (_, sharing) = send(&app, Method::GET, "/api/me/sharing", Some(&bt), None).await;
    assert_eq!(sharing["wants_public"], false);
    let (_, sharing) = send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "wants_public": true }))).await;
    assert_eq!(sharing["wants_public"], true);

    let (status, headers, html) = page(&app, "/u/saget/wants").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert!(html.contains("noindex"));
    // Needed cards first, then the ones along the way; a missing price is said, never $0.
    assert!(html.find("data-name=\"Sol Ring\"").unwrap() < html.find("data-name=\"Arcane Signet\"").unwrap());
    assert!(html.contains("data-kind=\"needed\"") && html.contains("data-kind=\"wishlist\""));
    assert!(html.contains("No market price") && !html.contains("$0.00"));
    assert!(html.contains("href=\"/sharing/compare/saget\""));
    let (_, headers, txt) = page(&app, "/u/saget/wants.txt").await;
    assert_eq!(txt, "2 Sol Ring\n1 Arcane Signet\n");
    assert!(headers[header::CONTENT_DISPOSITION].to_str().unwrap().contains("saget-wants.txt"));
    // The same card written another way is one line under its own name, and a changed list is
    // read again rather than served from the cache.
    sqlx::query("INSERT INTO shopping_wants (id, owner_id, kind, name, qty, priority, source, added_at) VALUES ('w-lower', ?, 'card', 'sol ring', 1, 'need', 'page', 'now')")
        .bind(&bryan)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(page(&app, "/u/saget/wants.txt").await.2, "3 Sol Ring\n1 Arcane Signet\n");
    let (_, _, html) = page(&app, "/u/saget/wants").await;
    assert!(html.contains("2 cards, 4 copies"), "{html}");
    sqlx::query("DELETE FROM shopping_wants WHERE id = 'w-lower'").execute(&pool).await.unwrap();
    let (_, _, profile) = page(&app, "/u/saget").await;
    assert!(profile.contains("href=\"/u/saget/wants\""));
    for body in [&html, &txt, &profile] {
        for secret in ["bryan.secret", "Fullname", "Secret Deck", "a private reason", &bryan] {
            assert!(!body.contains(secret), "{secret} leaked");
        }
    }

    // A retired want leaves the list.
    let id: String = sqlx::query_scalar("SELECT id FROM shopping_wants WHERE name = 'Arcane Signet'").fetch_one(&pool).await.unwrap();
    assert_eq!(send(&app, Method::DELETE, &format!("/api/plan/wants/{id}"), Some(&bt), None).await.0, StatusCode::OK);
    assert_eq!(page(&app, "/u/saget/wants.txt").await.2, "2 Sol Ring\n");

    // A disabled account shares nothing.
    sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    assert_eq!(page(&app, "/u/saget/wants").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn comparing_with_a_friend_reads_only_what_they_share() {
    let (app, pool) = app().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (friend, ft) = user(&pool, "friend@example.com").await;
    sqlx::query("UPDATE users SET handle = 'saget' WHERE id = ?").bind(&bryan).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET handle = 'pal' WHERE id = ?").bind(&friend).execute(&pool).await.unwrap();
    card(&pool, "o-sol", "Sol Ring", "Artifact", "p-sol", "cmm", "410").await;
    card(&pool, "o-tower", "Command Tower", "Land", "p-tower", "cmm", "1000").await;
    card(&pool, "o-bolt", "Lightning Bolt", "Instant", "p-bolt", "lea", "161").await;
    // Bryan wants two Sol Rings and owns a Command Tower in a private binder.
    send(&app, Method::POST, "/api/plan/wants", Some(&bt), Some(json!({"name": "Sol Ring", "qty": 2}))).await;
    let (_, binder) = send(&app, Method::POST, "/api/containers", Some(&bt), Some(json!({ "kind": "binder", "name": "Secret binder" }))).await;
    copies(&app, &bt, "b1", "p-tower", 1, false, Some(&binder["id"])).await;
    // The friend wants a Command Tower and a Lightning Bolt, and owns three real Sol Rings (one in a
    // deck box) and a proxy, which doesn't count.
    send(&app, Method::POST, "/api/plan/wants", Some(&ft), Some(json!({"name": "Command Tower"}))).await;
    send(&app, Method::POST, "/api/plan/wants", Some(&ft), Some(json!({"name": "Lightning Bolt", "priority": "along"}))).await;
    let (_, deck_box) = send(&app, Method::POST, "/api/containers", Some(&ft), Some(json!({ "kind": "deck", "name": "Their deck" }))).await;
    copies(&app, &ft, "f1", "p-sol", 2, false, None).await;
    copies(&app, &ft, "f2", "p-sol", 1, false, Some(&deck_box["id"])).await;
    copies(&app, &ft, "f3", "p-sol", 1, true, None).await;

    // Signed in only; an unknown handle is not found.
    assert_eq!(send(&app, Method::GET, "/api/sharing/compare/saget", None, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, Method::GET, "/api/sharing/compare/nobody", Some(&ft), None).await.0, StatusCode::NOT_FOUND);

    // Nothing shared yet: the friend learns nothing of Bryan's list or collection.
    let (status, c) = send(&app, Method::GET, "/api/sharing/compare/@saget", Some(&ft), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((c["wants_public"].clone(), c["collection_public"].clone()), (json!(false), json!(false)));
    assert_eq!((c["their_wants"].clone(), c["you_have"].clone(), c["they_have"].clone()), (json!(0), json!([]), json!([])));
    assert_eq!(c["your_wants"], 2);

    // His list shared: the friend has 3 real Sol Rings for it, 1 in a deck box.
    send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "wants_public": true }))).await;
    let (_, c) = send(&app, Method::GET, "/api/sharing/compare/saget", Some(&ft), None).await;
    assert_eq!(c["their_wants"], 1);
    let have = &c["you_have"][0];
    assert_eq!((have["name"].as_str(), have["qty"].as_i64(), have["copies"].as_i64(), have["in_decks"].as_i64()), (Some("Sol Ring"), Some(2), Some(3), Some(1)));
    assert!(have["market"].is_null());
    assert_eq!(c["they_have"], json!([]), "his collection isn't shared");

    // His collection shared too: his Command Tower matches the friend's list, by printing, never
    // by where he keeps it.
    send(&app, Method::PUT, "/api/me/sharing", Some(&bt), Some(json!({ "collection_public": true }))).await;
    let (_, c) = send(&app, Method::GET, "/api/sharing/compare/saget", Some(&ft), None).await;
    assert_eq!(c["they_have"].as_array().unwrap().len(), 1);
    let has = &c["they_have"][0];
    assert_eq!((has["name"].as_str(), has["copies"].as_i64()), (Some("Command Tower"), Some(1)));
    assert!(has.get("in_decks").is_none());
    assert_eq!(has["printings"], json!([{"set_code": "cmm", "set_name": "Test Set", "collector_number": "1000", "finish": "nonfoil", "lang": "en", "condition": "NM", "qty": 1}]));
    let body = c.to_string();
    for secret in ["Secret binder", "bryan@example.com", &bryan, &binder["id"].as_str().unwrap().to_string()] {
        assert!(!body.contains(secret), "{secret} leaked");
    }

    // Claude's tool says the same.
    let text = crate::sharing::wants::text(&crate::sharing::wants::compare(&pool, &friend, "saget").await.unwrap());
    assert!(text.contains("- Sol Ring (2 wanted; no market price): owns 3, 1 in deck boxes"), "{text}");
    assert!(text.contains("- Command Tower (1 wanted; no market price): @saget has 1 (1 CMM 1000 NM)"), "{text}");
}

#[tokio::test]
async fn want_list_derives_deck_gaps_once_and_invalidates_on_collection_changes() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "list-owner@example.com").await;
    let (other, _) = user(&pool, "other-list-owner@example.com").await;
    card(&pool, "o-ring", "Sol Ring", "Artifact", "p-ring", "cmm", "410").await;
    card(&pool, "o-basic", "Plains", "Basic Land — Plains", "p-basic", "cmm", "1").await;
    for (who, title) in [(&owner,"First"),(&owner,"Second"),(&owner,"Alternate"),(&other,"Not yours")] {
        let (id,v) = deck(&pool, who, title).await;
        let cards = json!([{"oracle_id":"o-ring","name":"Sol Ring","qty":1,"board":"main"},
                           {"oracle_id":"o-basic","name":"Plains","qty":20,"board":"main"}]);
        sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?").bind(cards.to_string()).bind(v).execute(&pool).await.unwrap();
        if title == "Alternate" {
            let parent: String = sqlx::query_scalar("SELECT id FROM decks WHERE name = 'First' AND owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
            sqlx::query("UPDATE decks SET parent_id = ? WHERE id = ?").bind(parent).bind(id).execute(&pool).await.unwrap();
        }
    }
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({"handle":"list-owner","wants_public":true}))).await;
    assert_eq!(page(&app,"/u/list-owner/wants.txt").await.2,"2 Sol Ring\n");
    copies(&app,&auth,"one-real","p-ring",1,false,None).await;
    copies(&app,&auth,"many-proxies","p-ring",3,true,None).await;
    assert_eq!(page(&app,"/u/list-owner/wants.txt").await.2,"1 Sol Ring\n");
    copies(&app,&auth,"second-real","p-ring",1,false,None).await;
    assert_eq!(page(&app,"/u/list-owner/wants.txt").await.2,"");
    let (_,overlay)=send(&app,Method::GET,"/api/sharing/wants/list-owner/owned",Some(&auth),None).await;
    assert_eq!(overlay["public"],json!([])); // old browser rows can be removed with the same refresh
}

#[tokio::test]
async fn want_list_includes_print_upgrades_and_keeps_pending_and_rejected_private() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool,"upgrade-list@example.com").await;
    for (oid,n,pid) in [("print","Print upgrade","p-print"),("pending","Pending upgrade","p-pending"),("no","Rejected upgrade","p-no"),("old","Old card","p-old")] {
        card(&pool,oid,n,"Artifact",pid,"tst",oid).await;
    }
    let b = json!({"decks":[{"key":"d","states":{"now":{"cards":[{"name":"Old card","qty":1}]}},
        "plan":{"state":"in_progress","next":{"keys":["later","rejected"],"skipped":["rejected"]}}}],
        "swaps":[{"key":"print","deck":"d","role":"swap","stage":"planned","src":"print","in":"Print upgrade","out":"Old card"},
                  {"key":"later","deck":"d","role":"swap","stage":"proposed","src":"buy","in":"Pending upgrade"},
                  {"key":"rejected","deck":"d","role":"swap","stage":"proposed","src":"buy","in":"Rejected upgrade"}],
        "reviews":{"rejected":{"decision":"no"}}});
    let public = super::want_sources::needs(&pool,&owner,&b,false).await.unwrap();
    assert_eq!(public,vec![("Print upgrade".into(),1,false)]);
    let owner_view = super::want_sources::needs(&pool,&owner,&b,true).await.unwrap();
    assert!(owner_view.contains(&("Pending upgrade".into(),1,true)));
    assert!(!owner_view.iter().any(|r|r.0 == "Rejected upgrade" || r.0 == "Old card"));
}

#[tokio::test]
async fn want_list_inventory_overlay_is_private_and_owner_scoped() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"overlay-owner@example.com").await;
    let (_,friend) = user(&pool,"overlay-viewer@example.com").await;
    card(&pool,"ring","Sol Ring","Artifact","p-ring","tst","1").await;
    send(&app,Method::POST,"/api/plan/wants",Some(&auth),Some(json!({"name":"Sol Ring","qty":2}))).await;
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"overlay-owner","wants_public":true}))).await;
    let (_,box_) = send(&app,Method::POST,"/api/containers",Some(&friend),Some(json!({"kind":"deck","name":"Secret deck"}))).await;
    copies(&app,&friend,"deck-copy","p-ring",1,false,Some(&box_["id"])).await;
    copies(&app,&friend,"spare-copy","p-ring",2,false,None).await;
    copies(&app,&friend,"proxy-copy","p-ring",4,true,None).await;
    let path = "/api/sharing/wants/overlay-owner/owned";
    assert_eq!(send(&app,Method::GET,path,None,None).await.0,StatusCode::UNAUTHORIZED);
    let (_,mine) = send(&app,Method::GET,path,Some(&auth),None).await;
    assert_eq!(mine["cards"],json!([]));
    let (_,theirs) = send(&app,Method::GET,path,Some(&friend),None).await;
    assert_eq!(theirs["owner"],false);
    assert_eq!(theirs["cards"][0],json!({"name":"Sol Ring","copies":3,"in_decks":1,"proxies":4}));
    let req = Request::builder().uri(path).header(header::AUTHORIZATION,format!("Bearer {friend}")).body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.headers()[header::CACHE_CONTROL],"private, no-store");
    let public = page(&app,"/u/overlay-owner/wants?q=missing").await.2;
    assert!(public.contains("<li hidden class=\"want-row\""));
    for secret in ["Secret deck","You own 3","proxy-copy",&owner] { assert!(!public.contains(secret)); }
}

#[tokio::test]
async fn want_targets_use_aliases_stock_relative_counts_and_real_inventory() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"target-edges@example.com").await;
    card(&pool,"old","Old card","Artifact","p-old","tst","1").await;
    card(&pool,"new","New card","Artifact","p-new","tst","2").await;
    let (root,version) = deck(&pool,&owner,"Partially installed").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"old","name":"Old card","qty":1,"board":"main"},{"oracle_id":"new","name":"New card","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    let base = json!({"decks":[{"key":"d","yama_deck":{"id":root},"states":{"stock":{"cards":[{"name":"Old card"}]},
        "now":{"cards":[{"name":"Old card"},{"name":"New card"}]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"renamed","deck":"d","role":"swap","stage":"proposed","src":"buy","in":"New card","out":"Old card","deck_installed":false}],
        "aliases":{"original":"renamed"},"reviews":{"original":{"decision":"want","at":"2030"}}});
    // Incoming already exists while its cut remains: target has one new card, not two.
    assert_eq!(super::want_sources::needs(&pool,&owner,&base,false).await.unwrap(),vec![("New card".into(),1,false)]);
    let mut acquired = base.clone();
    acquired["marks"] = json!({"original":{"bought":{"value":true,"at":"2031","op_id":"b"}}});
    assert_eq!(super::want_sources::needs(&pool,&owner,&acquired,false).await.unwrap(),vec![("New card".into(),1,false)]);
    // A rejected proposal leaves the current saved list authoritative.
    let mut rejected = base.clone();
    rejected["reviews"]["original"]["decision"] = json!("no");
    let needs = super::want_sources::needs(&pool,&owner,&rejected,false).await.unwrap();
    assert_eq!(needs.len(),2); // current deck still has both; no unapproved replacement applied
    copies(&app,&auth,"actual-bought-card","p-new",1,false,None).await;
    assert!(super::want_sources::needs(&pool,&owner,&acquired,false).await.unwrap().is_empty());
}

#[tokio::test]
async fn manually_requested_copies_remain_extra_and_unrelated_deck_boxes_are_reserved() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"extra-list@example.com").await;
    card(&pool,"ring","Sol Ring","Artifact","p-ring","tst","1").await;
    let (_,v) = deck(&pool,&owner,"Needs a ring").await;
    sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?").bind(json!([{"oracle_id":"ring","name":"Sol Ring","qty":1,"board":"main"}]).to_string()).bind(v).execute(&pool).await.unwrap();
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"extras","wants_public":true}))).await;
    let (_,box_) = send(&app,Method::POST,"/api/containers",Some(&auth),Some(json!({"kind":"deck","name":"Another deck, not saved"}))).await;
    copies(&app,&auth,"reserved","p-ring",1,false,Some(&box_["id"])).await;
    assert_eq!(page(&app,"/u/extras/wants.txt").await.2,"1 Sol Ring\n");
    send(&app,Method::POST,"/api/plan/wants",Some(&auth),Some(json!({"name":"Sol Ring","qty":1,"deck_name":"One more"}))).await;
    assert_eq!(page(&app,"/u/extras/wants.txt").await.2,"2 Sol Ring\n");
}

#[tokio::test]
async fn owner_overlay_keeps_pending_copies_when_card_also_has_confirmed_demand() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"pending-copies@example.com").await;
    let (_,friend) = user(&pool,"pending-friend@example.com").await;
    card(&pool,"ring","Sol Ring","Artifact","p-ring","tst","1").await;
    let (_,v) = deck(&pool,&owner,"Needs one").await;
    sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?").bind(json!([{"oracle_id":"ring","name":"Sol Ring","qty":1,"board":"main"}]).to_string()).bind(v).execute(&pool).await.unwrap();
    let doc = json!({"format":"yama-plan/1","plan":{"decks":[{"key":"pending","name":"A future deck","status":"proposals_only","commander":["Test Commander"]}],
        "swaps":[{"key":"pending-ring","deck":"pending","stage":"proposed","role":"swap","src":"print","in":"Sol Ring","out":"Plains"}]}});
    let (status,result) = send(&app,Method::POST,"/api/plan/import",Some(&auth),Some(doc)).await;
    assert_eq!(status,StatusCode::OK,"{result}");
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"pending-copies","wants_public":true}))).await;
    assert_eq!(page(&app,"/u/pending-copies/wants.txt").await.2,"1 Sol Ring\n");
    let (_,view) = send(&app,Method::GET,"/api/sharing/wants/pending-copies/owned",Some(&auth),None).await;
    assert_eq!(view["pending"][0]["name"],"Sol Ring");
    assert_eq!(view["pending"][0]["qty"],1);
    let (_,view) = send(&app,Method::GET,"/api/sharing/wants/pending-copies/owned",Some(&friend),None).await;
    assert_eq!(view["pending"],json!([]));
    let (_,settings) = send(&app,Method::GET,"/api/me/sharing",Some(&auth),None).await;
    assert_eq!(settings["wants_include_pending"],false);
    assert_eq!(send(&app,Method::PUT,"/api/sharing/wants/pending-copies/pending",Some(&friend),Some(json!({"enabled":true}))).await.0,StatusCode::FORBIDDEN);
    let before = send(&app,Method::GET,"/api/plan/bundle",Some(&auth),None).await.1;
    let (status,_) = send(&app,Method::PUT,"/api/sharing/wants/pending-copies/pending",Some(&auth),Some(json!({"enabled":true}))).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(page(&app,"/u/pending-copies/wants.txt").await.2,"2 Sol Ring\n");
    let html = page(&app,"/u/pending-copies/wants").await.2;
    assert!(html.contains("includes pending upgrades"));
    assert!(html.contains("data-kind=\"needed\" data-pending=\"true\""));
    let (_,lines) = super::wants::shared_wants(&pool,"pending-copies").await.unwrap();
    assert!(lines[0].needed);
    assert_eq!(lines[0].pending_qty,1);
    let after = send(&app,Method::GET,"/api/plan/bundle",Some(&auth),None).await.1;
    assert_eq!(before["decks"][0]["plan"],after["decks"][0]["plan"]);
    assert_eq!(before["reviews"],after["reviews"]);
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"wants_include_pending":false}))).await;
    assert_eq!(page(&app,"/u/pending-copies/wants.txt").await.2,"1 Sol Ring\n");
}

#[tokio::test]
async fn want_upgrade_chains_are_order_independent_and_owned_moves_apply_cuts() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"chains@example.com").await;
    for n in ["A","B","C"] {card(&pool,n,n,"Artifact",&format!("p-{n}"),"tst",n).await;}
    let b = json!({"decks":[{"key":"d","states":{"stock":{"cards":[{"name":"A"}]},"now":{"cards":[{"name":"A"}]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"bc","deck":"d","stage":"proposed","role":"swap","src":"print","in":"C","out":"B"},
                  {"key":"ab","deck":"d","stage":"planned","role":"swap","src":"print","in":"B","out":"A"}],
        "reviews":{"bc":{"decision":"want","at":"2030"}}});
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("C".into(),1,false)]);
    let mut owned = b.clone(); owned["swaps"][0]["src"]=json!("owned");
    assert_eq!(super::want_sources::needs(&pool,&owner,&owned,false).await.unwrap(),vec![("C".into(),1,false)]);
    copies(&app,&auth,"proxy-owned","p-C",1,true,None).await;
    assert_eq!(super::want_sources::needs(&pool,&owner,&owned,false).await.unwrap(),vec![("C".into(),1,false)]);
    copies(&app,&auth,"real-owned","p-C",1,false,None).await;
    assert!(super::want_sources::needs(&pool,&owner,&owned,false).await.unwrap().is_empty());
    // A separate owner keeps this later assertion independent of the fulfillment above.
    let (owner,_) = user(&pool,"changed-chain@example.com").await;
    let mut changed = b.clone(); changed["swaps"][0]["updated_at"]=json!("2031");
    changed["reviews"]["bc"]["decision"]=json!("no");
    changed["decks"][0]["plan"]["next"]=json!({"keys":["bc"],"skipped":[]});
    assert!(super::want_sources::needs(&pool,&owner,&changed,true).await.unwrap().contains(&("C".into(),1,true)));
}

#[tokio::test]
async fn orders_are_not_inventory_and_accepted_transfers_consume_only_spares() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"acquired-targets@example.com").await;
    card(&pool,"old","Old","Artifact","p-old","tst","1").await;
    card(&pool,"new","New","Artifact","p-new","tst","2").await;
    let (a,av) = deck(&pool,&owner,"First target").await;
    let (b,bv) = deck(&pool,&owner,"Second target").await;
    for (v,id,n) in [(av,"old","Old"),(bv,"new","New")] {
        sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":id,"name":n,"qty":1,"board":"main"}]).to_string()).bind(v).execute(&pool).await.unwrap();
    }
    let (_,box_) = send(&app,Method::POST,"/api/containers",Some(&auth),Some(json!({"kind":"deck","name":"Second target"}))).await;
    sqlx::query("UPDATE decks SET container_id=? WHERE id=?").bind(box_["id"].as_str().unwrap()).bind(&b).execute(&pool).await.unwrap();
    copies(&app,&auth,"already-in-second","p-new",1,false,Some(&box_["id"])).await;
    let plan = json!({"decks":[{"key":"a","yama_deck":{"id":a},"states":{"stock":{"cards":[{"name":"Old"}]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"ordered","deck":"a","stage":"planned","role":"swap","src":"buy","out":"Old","in":"New","order_item":{"order":"o","line":1}}]});
    assert_eq!(super::want_sources::needs(&pool,&owner,&plan,false).await.unwrap(),vec![("New".into(),1,false)]);
    let mut moved = plan.clone();
    moved["swaps"][0]["src"] = json!("owned"); moved["swaps"][0]["order_item"] = json!(null);
    moved["swaps"][0]["got"] = json!({"how":"deck","deck":"second"});
    // Reusing the second deck's only copy cannot fulfill both physical deck targets.
    assert_eq!(super::want_sources::needs(&pool,&owner,&moved,false).await.unwrap(),vec![("New".into(),1,false)]);
    moved["decks"].as_array_mut().unwrap().push(json!({"key":"second","yama_deck":{"id":b},"states":{"stock":{"cards":[{"name":"New"}]}},"plan":{"state":"in_progress"}}));
    moved["swaps"].as_array_mut().unwrap().push(json!({"key":"donor-cut","deck":"second","stage":"planned","role":"swap","src":"print","in":"Old","out":"New"}));
    copies(&app,&auth,"donor-replacement","p-old",1,false,None).await;
    // Its approved cut releases the real boxed New for the destination; no second copy needed.
    assert!(super::want_sources::needs(&pool,&owner,&moved,false).await.unwrap().is_empty());
}

#[tokio::test]
async fn pending_owned_note_cards_never_enter_the_approved_baseline() {
    let (_,pool) = app().await;
    let (owner,_) = user(&pool,"pending-note-baseline@example.com").await;
    card(&pool,"stock","Stock card","Artifact","p-stock","tst","1").await;
    card(&pool,"private","Pending proxy upgrade","Artifact","p-private","tst","2").await;
    let b = json!({"decks":[{"key":"d","states":{"stock":{"cards":[{"name":"Stock card"}]},"now":{"cards":[{"name":"Pending proxy upgrade"}]}},
        "plan":{"state":"waiting","next":{"keys":["p"],"skipped":[]}}}],
        "swaps":[{"key":"p","deck":"d","stage":"proposed","role":"swap","src":"owned","in":"Pending proxy upgrade","out":"Stock card","got":{"how":"owned","detail":"Your print, arrived"}}]});
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Stock card".into(),1,false)]);
    assert!(super::want_sources::needs(&pool,&owner,&b,true).await.unwrap().contains(&("Pending proxy upgrade".into(),1,true)));
}

#[tokio::test]
async fn pending_repeated_nonbasic_additions_keep_every_copy() {
    let (_,pool) = app().await;
    let (owner,_) = user(&pool,"pending-rats@example.com").await;
    card(&pool,"rat","Rat Colony","Creature — Rat","p-rat","tst","1").await;
    let b = json!({"decks":[{"key":"d","states":{"stock":{"cards":[{"name":"Rat Colony"}]}},
        "plan":{"state":"in_progress","next":{"keys":["r1","r2"],"skipped":[]}}}],
        "swaps":[{"key":"r1","deck":"d","stage":"proposed","role":"swap","src":"print","in":"Rat Colony","out":"Plains"},
                  {"key":"r2","deck":"d","stage":"proposed","role":"swap","src":"print","in":"Rat Colony","out":"Plains"}]});
    let rows = super::want_sources::needs(&pool,&owner,&b,true).await.unwrap();
    assert_eq!(rows.len(),2);
    assert!(rows.contains(&("Rat Colony".into(),1,false)));
    assert!(rows.contains(&("Rat Colony".into(),2,true)));
}

#[tokio::test]
async fn wishlist_and_derived_gaps_merge_canonical_faces_but_manual_wishes_stay_extra() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"canonical-wants@example.com").await;
    let full = "Delver of Secrets // Insectile Aberration";
    card(&pool,"delver",full,"Creature — Human Wizard","p-delver","isd","51").await;
    // The production card import indexes each face as well as the full card name.
    sqlx::query("INSERT INTO card_names (name,oracle_id) VALUES ('Delver of Secrets','delver')").execute(&pool).await.unwrap();
    let (_,version) = deck(&pool,&owner,"Needs Delver").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"delver","name":full,"qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    let document = json!({"scenarios":[{"id":"wish","purpose":"permanent_real_wishlist","buys":[{"card":"Delver of Secrets"}]}]});
    sqlx::query("INSERT INTO research_reports (owner_id,id,title,content_hash,document,updated_at) VALUES (?,'wish','Wish','h',?,'2026-11-09')").bind(&owner).bind(document.to_string()).execute(&pool).await.unwrap();
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"canonical-wants","wants_public":true}))).await;
    assert_eq!(page(&app,"/u/canonical-wants/wants.txt").await.2,format!("1 {full}\n"));
    assert_eq!(send(&app,Method::POST,"/api/plan/wants",Some(&auth),Some(json!({"name":"Delver of Secrets"}))).await.0,StatusCode::OK);
    assert_eq!(page(&app,"/u/canonical-wants/wants.txt").await.2,format!("2 {full}\n"));
}

#[tokio::test]
async fn pending_overlay_keeps_intent_when_the_watchlist_already_covers_its_quantity() {
    let (app,pool) = app().await;
    let (owner,auth) = user(&pool,"pending-watchlist@example.com").await;
    card(&pool,"ring","Sol Ring","Artifact","p-ring","tst","1").await;
    let document = json!({"scenarios":[{"id":"wish","purpose":"permanent_real_wishlist","buys":[{"card":"Sol Ring"}]}]});
    sqlx::query("INSERT INTO research_reports (owner_id,id,title,content_hash,document,updated_at) VALUES (?,'wish','Wish','h',?,'2026-11-09')").bind(&owner).bind(document.to_string()).execute(&pool).await.unwrap();
    let doc = json!({"format":"yama-plan/1","plan":{"decks":[{"key":"d","name":"Future","status":"proposals_only","commander":["Test Commander"]}],
        "swaps":[{"key":"p","deck":"d","stage":"proposed","role":"swap","src":"print","in":"Sol Ring","out":"Plains"}]}});
    assert_eq!(send(&app,Method::POST,"/api/plan/import",Some(&auth),Some(doc)).await.0,StatusCode::OK);
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"pending-watchlist","wants_public":true}))).await;
    assert_eq!(page(&app,"/u/pending-watchlist/wants.txt").await.2,"1 Sol Ring\n");
    let path="/api/sharing/wants/pending-watchlist/owned";
    let (_,view)=send(&app,Method::GET,path,Some(&auth),None).await;
    assert_eq!(view["pending"][0]["qty"],1);
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"wants_include_pending":true}))).await;
    assert_eq!(page(&app,"/u/pending-watchlist/wants.txt").await.2,"1 Sol Ring\n");
    let (_,view)=send(&app,Method::GET,path,Some(&auth),None).await;
    assert_eq!(view["pending"],json!([]));
}

#[tokio::test]
async fn plan_only_targets_apply_owner_changes_but_saved_lists_stay_authoritative() {
    let (_,pool)=app().await;
    let (owner,_)=user(&pool,"owner-baseline@example.com").await;
    for (id,n) in [("stock","Stock"),("mine","My change"),("upgrade","Upgrade"),("current","Actual list")] {
        card(&pool,id,n,"Artifact",&format!("p-{id}"),"tst",id).await;
    }
    let mut b=json!({"decks":[{"key":"d","owner_changes":[{"out":"Stock","in":"My change"}],
        "states":{"stock":{"cards":[{"name":"Stock"}]}},"plan":{"state":"in_progress"}}]});
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("My change".into(),1,false)]);
    b["swaps"]=json!([{"key":"u","deck":"d","stage":"planned","role":"swap","src":"print","out":"My change","in":"Upgrade"}]);
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Upgrade".into(),1,false)]);
    let (root,version)=deck(&pool,&owner,"Real list").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"current","name":"Actual list","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    b["decks"][0]["yama_deck"]=json!({"id":root}); b["swaps"]=json!([]);
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Actual list".into(),1,false)]);
}

#[tokio::test]
async fn boxed_real_copies_are_allocated_once_regardless_of_purchase_marks() {
    let (app,pool)=app().await;
    let (owner,auth)=user(&pool,"stock-and-bought@example.com").await;
    card(&pool,"rat","Rat Colony","Creature — Rat","p-rat","tst","1").await;
    let (root,version)=deck(&pool,&owner,"Rats").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"rat","name":"Rat Colony","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    let (_,box_)=send(&app,Method::POST,"/api/containers",Some(&auth),Some(json!({"kind":"deck","name":"Rats"}))).await;
    sqlx::query("UPDATE decks SET container_id=? WHERE id=?").bind(box_["id"].as_str().unwrap()).bind(&root).execute(&pool).await.unwrap();
    copies(&app,&auth,"stock-rat","p-rat",1,false,Some(&box_["id"])).await;
    let mut b=json!({"decks":[{"key":"d","yama_deck":{"id":root},"states":{"stock":{"cards":[{"name":"Rat Colony"}]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"second","deck":"d","stage":"planned","role":"swap","src":"buy","in":"Rat Colony","out":"Plains","order_item":{"order":"bought","line":1}}]});
    // A purchase claim does not add a second physical copy to the collection.
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Rat Colony".into(),1,false)]);
    copies(&app,&auth,"entered-purchase","p-rat",1,false,Some(&box_["id"])).await;
    assert!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap().is_empty());
    // Entering that purchase cannot also cover a third, unacquired copy.
    b["swaps"].as_array_mut().unwrap().push(json!({"key":"third","deck":"d","stage":"planned","role":"swap","src":"print","in":"Rat Colony","out":"Plains"}));
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Rat Colony".into(),1,false)]);
}

#[tokio::test]
async fn loose_real_copies_are_allocated_once_regardless_of_purchase_marks() {
    let (app,pool)=app().await;
    let (owner,auth)=user(&pool,"loose-stock@example.com").await;
    card(&pool,"rat","Rat Colony","Creature — Rat","p-rat","tst","1").await;
    let (root,version)=deck(&pool,&owner,"Loose rats").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"rat","name":"Rat Colony","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    copies(&app,&auth,"loose-stock","p-rat",1,false,None).await;
    let mut b=json!({"decks":[{"key":"d","yama_deck":{"id":root},"states":{"stock":{"cards":[{"name":"Rat Colony"}]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"second","deck":"d","stage":"planned","role":"swap","src":"buy","in":"Rat Colony","out":"Plains","order_item":{"order":"bought","line":1}}]});
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Rat Colony".into(),1,false)]);
    copies(&app,&auth,"entered-loose-purchase","p-rat",1,false,None).await;
    assert!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap().is_empty());
    b["swaps"].as_array_mut().unwrap().push(json!({"key":"third","deck":"d","stage":"planned","role":"swap","src":"print","in":"Rat Colony","out":"Plains"}));
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Rat Colony".into(),1,false)]);
}

#[tokio::test]
async fn batched_want_name_resolution_preserves_card_priority_and_faces() {
    let (_,pool)=app().await;
    card(&pool,"split","Fire // Ice","Instant","p-split","tst","1").await;
    card(&pool,"exact","Fire","Instant","p-exact","tst","2").await;
    card(&pool,"token","Fire token","Token","p-token","tst","3").await;
    sqlx::query("UPDATE cards SET layout='token' WHERE oracle_id='token'").execute(&pool).await.unwrap();
    for (name,id) in [("Fire","split"),("Ice","split"),("Fire","token")] {
        sqlx::query("INSERT INTO card_names (name,oracle_id) VALUES (?,?)").bind(name).bind(id).execute(&pool).await.unwrap();
    }
    let mut names=vec!["Fire".to_string();200]; names.extend(["fire".into(),"Ice".into(),"Fire // Ice".into(),"Unknown".into(),"\tFire\t".into(),"\u{2003}Fire\u{2003}".into()]);
    let resolved=super::want_sources::resolve_names(&pool,&names).await.unwrap();
    assert_eq!(resolved["Fire"],"exact"); assert_eq!(resolved["fire"],"exact");
    assert_eq!(resolved["Ice"],"split"); assert_eq!(resolved["Fire // Ice"],"split");
    assert_eq!(resolved["\tFire\t"],"exact"); assert_eq!(resolved["\u{2003}Fire\u{2003}"],"exact");
    assert!(!resolved.contains_key("Unknown")); assert_eq!(resolved.len(),6);
}

#[tokio::test]
async fn a_loose_purchased_copy_cannot_fulfill_two_saved_deck_targets() {
    let (app,pool)=app().await;
    let (owner,auth)=user(&pool,"one-copy-two-targets@example.com").await;
    card(&pool,"ring","Sol Ring","Artifact","p-ring","tst","1").await;
    let (first,version)=deck(&pool,&owner,"First").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"ring","name":"Sol Ring","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    let (second,second_version)=deck(&pool,&owner,"Second").await;
    sqlx::query("UPDATE deck_versions SET cards='[]' WHERE id=?").bind(second_version).execute(&pool).await.unwrap();
    let b=json!({"decks":[{"key":"second","yama_deck":{"id":second},"states":{"stock":{"cards":[]}},"plan":{"state":"in_progress"}}],
        "swaps":[{"key":"buy-ring","deck":"second","stage":"planned","role":"swap","src":"buy","in":"Sol Ring","out":"Plains","order_item":{"order":"bought","line":1}}]});
    let _=first;
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Sol Ring".into(),2,false)]);
    copies(&app,&auth,"entered-purchase-once","p-ring",1,false,None).await;
    assert_eq!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap(),vec![("Sol Ring".into(),1,false)]);
    copies(&app,&auth,"another-real-copy","p-ring",1,false,None).await;
    assert!(super::want_sources::needs(&pool,&owner,&b,false).await.unwrap().is_empty());
}

#[tokio::test]
async fn target_counts_keep_distinct_oracles_and_resolve_face_aliases_before_swaps() {
    let (_,pool)=app().await;
    let (owner,_)=user(&pool,"distinct-card-oracles@example.com").await;
    card(&pool,"split","Fire // Ice","Instant","p-split","tst","1").await;
    card(&pool,"standalone","Fire","Instant","p-standalone","tst","2").await;
    card(&pool,"other","Other card","Artifact","p-other","tst","3").await;
    sqlx::query("INSERT INTO card_names (name,oracle_id) VALUES ('Ice','split'),('Fire','split')").execute(&pool).await.unwrap();
    let mut b=json!({"decks":[{"key":"d","states":{"stock":{"cards":[{"name":"Fire"},{"name":"Fire // Ice"}]}},"plan":{"state":"in_progress"}}]});
    let rows=super::want_sources::needs(&pool,&owner,&b,false).await.unwrap();
    assert_eq!(rows.len(),2);
    assert!(rows.contains(&("Fire".into(),1,false)));
    assert!(rows.contains(&("Fire // Ice".into(),1,false)));
    b["swaps"]=json!([{"key":"replace-split","deck":"d","stage":"planned","role":"swap","src":"print","out":"Ice","in":"Other card"}]);
    let rows=super::want_sources::needs(&pool,&owner,&b,false).await.unwrap();
    assert_eq!(rows.len(),2);
    assert!(rows.contains(&("Fire".into(),1,false)));
    assert!(rows.contains(&("Other card".into(),1,false)));
}

#[tokio::test]
async fn unresolved_planned_cards_stay_on_the_want_list_without_invented_prices() {
    let (app,pool)=app().await;
    let (owner,auth)=user(&pool,"future-want@example.com").await;
    let (_,version)=deck(&pool,&owner,"A future deck").await;
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(json!([{"oracle_id":"not-imported-yet","name":"Future Card","qty":1,"board":"main"}]).to_string()).bind(version).execute(&pool).await.unwrap();
    send(&app,Method::PUT,"/api/me/sharing",Some(&auth),Some(json!({"handle":"future-want","wants_public":true}))).await;
    assert_eq!(page(&app,"/u/future-want/wants.txt").await.2,"1 Future Card\n");
    let html=page(&app,"/u/future-want/wants").await.2;
    assert!(html.contains("Future Card") && html.contains("No market price") && !html.contains("$0.00"));
    let (_,lines)=super::wants::shared_wants(&pool,"future-want").await.unwrap();
    assert!(lines[0].oracle_id.is_none());
    // Importing the card resolves its existing need, not a duplicate or a lost name.
    card(&pool,"future-id","Future Card","Artifact","p-future","tst","1").await;
    sqlx::query("INSERT INTO import_runs (id,kind,started_at,finished_at) VALUES ('future-import','cards','2031','2031')").execute(&pool).await.unwrap();
    let (_,lines)=super::wants::shared_wants(&pool,"future-want").await.unwrap();
    assert_eq!(lines.len(),1);
    assert_eq!(lines[0].oracle_id.as_deref(),Some("future-id"));
}

/// "Listed publicly" (`sharing::LISTED`) is the one answer to whether a deck may appear in Browse,
/// the commander and precon listings and the sitemap, and be indexed. People made decks public
/// when that meant "on my profile, not indexed": theirs stay unlisted until they answer the
/// prompt, which is what `public_listed_at` records.
#[tokio::test]
async fn a_deck_is_listed_publicly_only_when_public_and_its_owner_took_the_new_meaning() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "lister@example.com").await;
    let (id, _) = deck(&pool, &owner, "Listed or not").await;
    let listed = || async { super::deck_listed(&pool, &id).await.unwrap() };
    let set = |sql: &'static str| {
        let pool = pool.clone();
        let owner = owner.clone();
        async move {
            sqlx::query(sql).bind(&owner).execute(&pool).await.unwrap();
        }
    };
    let path = format!("/api/decks/{id}");

    // An account from before the change: public with a handle is still the old meaning.
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "lister" }))).await;
    send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": "public" }))).await;
    let (_, me) = send(&app, Method::GET, "/api/me/sharing", Some(&auth), None).await;
    assert!(me["public_listed_at"].is_null(), "{me}");
    assert!(!listed().await, "an account that never agreed is not listed");
    assert_eq!(page(&app, "/u/lister").await.0, StatusCode::OK, "its profile still shows the deck");

    // Its owner says yes: listed, and the first yes is the one kept.
    super::list_publicly(&pool, &owner).await.unwrap();
    let (_, me) = send(&app, Method::GET, "/api/me/sharing", Some(&auth), None).await;
    assert!(me["public_listed_at"].is_string(), "{me}");
    assert!(listed().await);
    // (An older time than any clock gives now, so a second yes that overwrote it would show.)
    set("UPDATE users SET public_listed_at = '2026-01-01T00:00:00Z' WHERE id = ?").await;
    super::list_publicly(&pool, &owner).await.unwrap();
    let again: String = sqlx::query_scalar("SELECT public_listed_at FROM users WHERE id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(again, "2026-01-01T00:00:00Z");

    // Only a public deck: by link, private and archived are never listed.
    for v in ["link", "private"] {
        send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": v }))).await;
        assert!(!listed().await, "{v}");
    }
    send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": "public" }))).await;
    assert!(listed().await);
    sqlx::query("UPDATE decks SET archived = 1 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    assert!(!listed().await, "archived");
    sqlx::query("UPDATE decks SET archived = 0 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();

    // The owner: no handle (public by link until one is chosen), turned off, or a guest player.
    set("UPDATE users SET handle = NULL WHERE id = ?").await;
    assert!(!listed().await, "no handle");
    set("UPDATE users SET handle = 'lister', disabled_at = '2026-11-12T00:00:00Z' WHERE id = ?").await;
    assert!(!listed().await, "account turned off");
    set("UPDATE users SET disabled_at = NULL, guest = 1 WHERE id = ?").await;
    assert!(!listed().await, "guest player");
    set("UPDATE users SET guest = 0 WHERE id = ?").await;
    assert!(listed().await);

    assert!(!super::deck_listed(&pool, "no-such-deck").await.unwrap());
}

/// The one-time question for accounts from before public-by-default: "Yama decks are now public
/// by default. Make yours public?" Either answer takes on the new meaning of "public"; the
/// answer sets what new decks start as; existing decks change only when the answer says so.
#[tokio::test]
async fn the_public_default_question_is_answered_once_and_never_changes_decks_unasked() {
    let (app, pool) = app().await;
    let vis = |id: &str| {
        let (pool, id) = (pool.clone(), id.to_string());
        async move { sqlx::query_scalar::<_, String>("SELECT visibility FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    let listed_at = |user: &str| {
        let (pool, user) = (pool.clone(), user.to_string());
        async move { sqlx::query_scalar::<_, Option<String>>("SELECT public_listed_at FROM users WHERE id = ?").bind(user).fetch_one(&pool).await.unwrap() }
    };
    // An account from before the change with a private, a link-only and a public deck, and a handle.
    let old_account = |email: &'static str, handle: &'static str| {
        let (app, pool) = (app.clone(), pool.clone());
        async move {
            let (id, auth) = user(&pool, email).await;
            send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": handle }))).await;
            let (private, _) = deck(&pool, &id, "Kept private").await;
            let (link, _) = deck(&pool, &id, "By link").await;
            let (public, _) = deck(&pool, &id, "On the profile").await;
            send(&app, Method::PATCH, &format!("/api/decks/{link}"), Some(&auth), Some(json!({ "visibility": "link" }))).await;
            send(&app, Method::PATCH, &format!("/api/decks/{public}"), Some(&auth), Some(json!({ "visibility": "public" }))).await;
            (id, auth, private, link, public)
        }
    };
    let answer = |auth: &str, body: serde_json::Value| {
        let (app, auth) = (app.clone(), auth.to_string());
        async move { send(&app, Method::POST, "/api/me/sharing/public-default", Some(&auth), Some(body)).await }
    };

    // Nobody signed in: no answer.
    assert_eq!(
        send(&app, Method::POST, "/api/me/sharing/public-default", None, Some(json!({ "new_decks": "public", "existing": "keep", "public_decks": 0 }))).await.0,
        StatusCode::UNAUTHORIZED
    );

    // An account that never answers, made before anyone else does: nothing below may touch it.
    let (quiet, quiet_auth, q_private, q_link, q_public) = old_account("quiet@example.com", "quiet").await;
    let untouched = || {
        let (pool, quiet, ids) = (pool.clone(), quiet.clone(), [q_private.clone(), q_link.clone(), q_public.clone()]);
        async move {
            let (default, listed): (String, Option<String>) = sqlx::query_as("SELECT new_deck_visibility, public_listed_at FROM users WHERE id = ?").bind(&quiet).fetch_one(&pool).await.unwrap();
            assert_eq!((default.as_str(), listed), ("private", None));
            let mut seen = vec![];
            for id in &ids {
                seen.push(sqlx::query_scalar::<_, String>("SELECT visibility FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap());
            }
            assert_eq!(seen, ["private", "link", "public"]);
            assert!(!super::deck_listed(&pool, &ids[2]).await.unwrap());
        }
    };

    // No: link only. The default changes, no deck does, and the account has the new meaning, so
    // the deck its owner had already made public and chose to keep is now listed.
    let (no, no_auth, private, link, public) = old_account("no@example.com", "nope").await;
    assert_eq!(listed_at(&no).await, None);
    assert!(!super::deck_listed(&pool, &public).await.unwrap());
    // An answer that is wrong or incomplete is refused and leaves the question open. What
    // happens to existing decks has to be said: keeping lists the public ones, so it is never assumed.
    for bad in [
        json!({ "new_decks": "everyone", "existing": "keep", "public_decks": 1 }),
        json!({ "new_decks": "link", "existing": "public", "public_decks": 1 }),
        json!({ "new_decks": "public", "existing": "all", "public_decks": 1 }),
        json!({ "new_decks": "link", "public_decks": 1 }),
        json!({ "new_decks": "link", "existing": "keep" }),
        json!({}),
    ] {
        let (s, _) = answer(&no_auth, bad.clone()).await;
        assert!(s == StatusCode::BAD_REQUEST || s == StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {s}");
    }
    // An answer about another number of public decks than the account has now (one was shared
    // on another device after the question opened) is refused too, and nothing is recorded.
    for seen in [0, 2] {
        let (s, v) = answer(&no_auth, json!({ "new_decks": "link", "existing": "keep", "public_decks": seen })).await;
        assert_eq!(s, StatusCode::CONFLICT, "{v}");
    }
    assert_eq!(listed_at(&no).await, None);
    let default: String = sqlx::query_scalar("SELECT new_deck_visibility FROM users WHERE id = ?").bind(&no).fetch_one(&pool).await.unwrap();
    assert_eq!(default, "private");
    let (s, v) = answer(&no_auth, json!({ "new_decks": "link", "existing": "keep", "public_decks": 1 })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["new_deck_visibility"], "link");
    assert!(v["public_listed_at"].is_string(), "{v}");
    assert_eq!((vis(&private).await.as_str(), vis(&link).await.as_str(), vis(&public).await.as_str()), ("private", "link", "public"));
    assert!(super::deck_listed(&pool, &public).await.unwrap());
    assert!(!super::deck_listed(&pool, &link).await.unwrap());
    untouched().await;
    // Asked once: a second answer, even "yes, and all my decks", is refused and changes nothing.
    let since = listed_at(&no).await;
    let (s, _) = answer(&no_auth, json!({ "new_decks": "public", "existing": "public", "public_decks": 1 })).await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (_, v) = send(&app, Method::GET, "/api/me/sharing", Some(&no_auth), None).await;
    assert_eq!(v["new_deck_visibility"], "link");
    assert_eq!((vis(&private).await.as_str(), vis(&link).await.as_str(), vis(&public).await.as_str()), ("private", "link", "public"));
    assert_eq!(listed_at(&no).await, since);

    // Yes, without the tick: new decks are public from now on, existing decks stay as they were.
    let (yes, yes_auth, private, link, public) = old_account("yes@example.com", "yesplease").await;
    let (s, v) = answer(&yes_auth, json!({ "new_decks": "public", "existing": "keep", "public_decks": 1 })).await;
    assert_eq!((s, &v["new_deck_visibility"]), (StatusCode::OK, &json!("public")));
    assert_eq!((vis(&private).await.as_str(), vis(&link).await.as_str(), vis(&public).await.as_str()), ("private", "link", "public"));
    let (_, made) = send(&app, Method::POST, "/api/decks", Some(&yes_auth), Some(json!({ "name": "Made after", "cards": [] }))).await;
    assert_eq!(vis(made["id"].as_str().unwrap()).await, "public");
    assert!(listed_at(&yes).await.is_some());
    untouched().await;

    // Yes, with the tick: every live deck becomes public, each with its own link; a deleted deck doesn't.
    let (all, all_auth, private, link, public) = old_account("all@example.com", "allofthem").await;
    let (gone, _) = deck(&pool, &all, "Deleted").await;
    assert_eq!(send(&app, Method::DELETE, &format!("/api/decks/{gone}"), Some(&all_auth), None).await.0, StatusCode::OK);
    let (s, v) = answer(&all_auth, json!({ "new_decks": "public", "existing": "public", "public_decks": 1 })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["decks"], json!({ "private": 0, "link": 0, "public": 3 }));
    for id in [&private, &link, &public] {
        assert!(super::deck_listed(&pool, id).await.unwrap());
    }
    assert_eq!(vis(&gone).await, "private");
    assert_ne!(token_of(&pool, &private).await, token_of(&pool, &link).await);
    untouched().await;

    // No, and take my public decks off the lists: they become link only, the rest stay. Only
    // the live decks the question counted: one deleted while public is left as it was.
    let (off, off_auth, private, link, public) = old_account("off@example.com", "offlist").await;
    let token = token_of(&pool, &public).await;
    let (deleted, _) = deck(&pool, &off, "Deleted while public").await;
    send(&app, Method::PATCH, &format!("/api/decks/{deleted}"), Some(&off_auth), Some(json!({ "visibility": "public" }))).await;
    assert_eq!(send(&app, Method::DELETE, &format!("/api/decks/{deleted}"), Some(&off_auth), None).await.0, StatusCode::OK);
    let (s, v) = answer(&off_auth, json!({ "new_decks": "private", "existing": "link", "public_decks": 1 })).await;
    assert_eq!((s, &v["new_deck_visibility"]), (StatusCode::OK, &json!("private")));
    assert_eq!((vis(&private).await.as_str(), vis(&link).await.as_str(), vis(&public).await.as_str()), ("private", "link", "link"));
    assert!(!super::deck_listed(&pool, &public).await.unwrap());
    assert_eq!(vis(&deleted).await, "public");
    assert!(!super::deck_listed(&pool, &deleted).await.unwrap());
    assert!(listed_at(&off).await.is_some());
    // Its link keeps working; the profile no longer lists it.
    assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::OK);
    assert!(!page(&app, "/u/offlist").await.2.contains(&token));
    untouched().await;

    // An account made after the change was never asked: an answer is refused and changes nothing.
    let (newer, newer_auth) = user(&pool, "newer@example.com").await;
    sqlx::query("UPDATE users SET public_listed_at = '2026-11-12T00:00:00Z', new_deck_visibility = 'public' WHERE id = ?").bind(&newer).execute(&pool).await.unwrap();
    let (mine, _) = deck(&pool, &newer, "Chosen private").await;
    send(&app, Method::PATCH, &format!("/api/decks/{mine}"), Some(&newer_auth), Some(json!({ "visibility": "private" }))).await;
    let (s, _) = answer(&newer_auth, json!({ "new_decks": "public", "existing": "public", "public_decks": 0 })).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(vis(&mine).await, "private");
    assert_eq!(listed_at(&newer).await.as_deref(), Some("2026-11-12T00:00:00Z"));

    // The quiet account can still answer for itself.
    untouched().await;
    let (s, _) = answer(&quiet_auth, json!({ "new_decks": "private", "existing": "keep", "public_decks": 1 })).await;
    assert_eq!(s, StatusCode::OK);
    assert!(listed_at(&quiet).await.is_some());
}
