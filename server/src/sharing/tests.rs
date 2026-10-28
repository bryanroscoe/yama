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
    assert!(shared.contains("Configurations") && shared.contains(">Main<") && shared.contains(">stock<"));
    assert!(!shared.contains("secret tech"));
    let (_, _, profile) = page(&app, "/u/saget").await;
    assert!(profile.contains(">Main<") && profile.contains(">stock<") && !profile.contains("secret tech"));

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

    // Archiving the main deck leaves its configurations as main decks.
    send(&app, Method::DELETE, &format!("/api/decks/{main}"), Some(&bt), None).await;
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

#[test]
fn configurations_stand_for_plan_states() {
    assert_eq!(super::plan_state(None), "now");
    assert_eq!(super::plan_state(Some("stock")), "stock");
    assert_eq!(super::plan_state(Some("After prints")), "after");
    assert_eq!(super::plan_state(Some("proposed bracket 3")), "proposed-bracket-3");
    assert_eq!(crate::lab::variant_state("bryan/riders-of-rohan-after", "riders-of-rohan").as_deref(), Some("after"));
    assert_eq!(crate::lab::variant_state("bryan/riders-of-rohan2-after", "riders-of-rohan"), None);
}
