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
                "acquisition": {"buys": [{"card": "Swords to Plowshares", "store": "Hidden Hobby Shop", "price": 3.5}]},
                "swaps": [{"id": "stp", "card_in": "Swords to Plowshares", "card_out": "Stick Together", "why": "One-mana exile.", "why_out": "Symmetrical.", "pairing_note": "Swap together with the land change.",
                           "acquisition": {"store": "Hidden Hobby Shop", "price": 3.5}}]
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
    for hidden in ["my private review note", "secret price ceiling", "Secret Store", "Hidden Hobby Shop", "Secret shopping list", "secret binder", "Installed secretly", "3.5"] {
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
        "as of 30 Oct 2026",
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
