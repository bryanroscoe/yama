//! Swappable spares: linking and making the box, the deck's list never counting them, what each
//! swaps for (plan bags and the owner's note), owner isolation, and the migration of the old
//! "<deck> swap bag" boxes.

use super::*;
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};

async fn cards(pool: &SqlitePool) {
    for (oid, name) in [("o-cmd", "Éowyn, Shieldmaiden"), ("o-vessel", "Thought Vessel"), ("o-tal", "Talisman of Creativity"), ("o-banner", "Vanquisher's Banner"), ("o-ring", "The One Ring")] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, default_printing, updated_at) VALUES (?,?,'Artifact',?,'now')")
            .bind(oid)
            .bind(name)
            .bind(format!("p-{oid}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?,?,?,'tst','Test','1','en','now')")
            .bind(format!("p-{oid}"))
            .bind(oid)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn deck(pool: &SqlitePool, owner: &str, name: &str) -> String {
    let card = |oid: &str, name: &str, board| DeckCard { oracle_id: oid.into(), name: name.into(), qty: 1, board };
    let list = vec![card("o-cmd", "Éowyn, Shieldmaiden", Board::Commander), card("o-vessel", "Thought Vessel", Board::Main), card("o-ring", "The One Ring", Board::Main)];
    crate::decks::create_deck_with_cards(pool, owner, name, None, list).await.unwrap()
}

async fn container(pool: &SqlitePool, owner: &str, kind: &str, name: &str) -> String {
    let id = new_id();
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,?,?,'now')").bind(&id).bind(owner).bind(kind).bind(name).execute(pool).await.unwrap();
    id
}

async fn copies(pool: &SqlitePool, owner: &str, scryfall: &str, qty: i64, container: &str) {
    sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, container_id, created_at, updated_at) VALUES (?,?,?,?,?,'now','now')")
        .bind(new_id())
        .bind(owner)
        .bind(scryfall)
        .bind(qty)
        .bind(container)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_deck_keeps_swappable_spares_apart_from_its_list() {
    let (app, pool) = app().await;
    cards(&pool).await;
    let (ann, token) = user(&pool, "ann@example.com").await;
    let (_, bob) = user(&pool, "bob@example.com").await;
    let id = deck(&pool, &ann, "Riders of Rohan").await;
    let deck_box = container(&pool, &ann, "deck", "Riders of Rohan").await;
    sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(&deck_box).bind(&id).execute(&pool).await.unwrap();
    let path = format!("/api/decks/{id}/spares");

    // None yet: an empty answer, and nobody else can read or set it.
    let (status, none) = send(&app, Method::GET, &path, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{none}");
    assert!(none["container_id"].is_null() && none["cards"].as_array().unwrap().is_empty(), "{none}");
    assert_eq!(send(&app, Method::GET, &path, Some(&bob), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::PUT, &path, Some(&bob), Some(json!({"create": true}))).await.0, StatusCode::NOT_FOUND);

    // The deck's own box can't be its spares.
    let (status, refused) = send(&app, Method::PUT, &path, Some(&token), Some(json!({"container_id": deck_box}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");

    // Making them links the box by the bag's name, with its copies where they are.
    let bag = container(&pool, &ann, "box", "Riders of Rohan swap bag").await;
    copies(&pool, &ann, "p-o-tal", 1, &bag).await;
    copies(&pool, &ann, "p-o-banner", 1, &bag).await;
    let (status, made) = send(&app, Method::PUT, &path, Some(&token), Some(json!({"create": true}))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    assert_eq!(made["container_id"], json!(bag), "{made}");
    assert_eq!(made["copies"], 2);
    assert_eq!(made["place"], "in Riders of Rohan's box (swappable)");

    // The list is untouched: still three cards, and the deck page's check counts only them.
    let (_, view) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&token), None).await;
    let listed: i64 = view["cards"].as_array().unwrap().iter().map(|c| c["qty"].as_i64().unwrap()).sum();
    assert_eq!(listed, 3, "{view}");

    // The collection says where those copies are.
    let (_, items) = send(&app, Method::GET, "/api/collection", Some(&token), None).await;
    let tal = items.as_array().unwrap().iter().find(|i| i["name"] == "Talisman of Creativity").unwrap();
    assert_eq!(tal["spares_of_deck"], "Riders of Rohan", "{tal}");
    assert_eq!(tal["spares_of_deck_id"], json!(id));
    let (_, boxes) = send(&app, Method::GET, "/api/containers", Some(&token), None).await;
    let b = boxes.as_array().unwrap().iter().find(|c| c["id"] == json!(bag)).unwrap();
    assert_eq!(b["spares_of_deck"], "Riders of Rohan", "{b}");

    // What a spare swaps for: the plan's bracket bag, and the owner's own note.
    sqlx::query(
        "INSERT INTO plan_decks (id, owner_id, key, name, source, commander, bracket, deck_id, created_at, updated_at)
         VALUES ('pd', ?, 'riders-of-rohan', 'Riders of Rohan', 'import', '[]', ?, ?, 'now', 'now')",
    )
    .bind(&ann)
    .bind(json!({"bags": {"2": [{"in": "Vanquisher's Banner", "out": "The One Ring"}, {"in": "Heirloom Blade", "out": "Smothering Tithe"}]}}).to_string())
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    let (status, set) = send(&app, Method::PUT, &format!("{path}/swaps"), Some(&token), Some(json!({"oracle_id": "o-tal", "swaps_out": "Thought Vessel", "bracket": 4}))).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let card = |v: &Value, name: &str| v["cards"].as_array().unwrap().iter().find(|c| c["name"] == name).cloned().unwrap();
    assert_eq!(card(&set, "Talisman of Creativity")["swaps"], json!([{"out": "Thought Vessel", "bracket": 4, "note": null, "from": "owner"}]));
    assert_eq!(card(&set, "Vanquisher's Banner")["swaps"], json!([{"out": "The One Ring", "bracket": 2, "note": null, "from": "plan"}]));
    assert_eq!(set["planned_missing"], json!([{"name": "Heirloom Blade", "swaps": [{"out": "Smothering Tithe", "bracket": 2, "note": null, "from": "plan"}]}]));
    let (status, _) = send(&app, Method::PUT, &format!("{path}/swaps"), Some(&token), Some(json!({"oracle_id": "o-tal", "bracket": 9}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, cleared) = send(&app, Method::PUT, &format!("{path}/swaps"), Some(&token), Some(json!({"oracle_id": "o-tal"}))).await;
    assert_eq!(card(&cleared, "Talisman of Creativity")["swaps"], json!([]));

    // A configuration shares its main deck's spares.
    let child = deck(&pool, &ann, "Riders of Rohan (bracket 3)").await;
    sqlx::query("UPDATE decks SET parent_id = ? WHERE id = ?").bind(&id).bind(&child).execute(&pool).await.unwrap();
    let (_, from_child) = send(&app, Method::GET, &format!("/api/decks/{child}/spares"), Some(&token), None).await;
    assert_eq!(from_child["deck_id"], json!(id), "{from_child}");
    assert_eq!(from_child["copies"], 2);

    // Another deck can't take the same box.
    let other = deck(&pool, &ann, "World Shaper").await;
    let (status, _) = send(&app, Method::PUT, &format!("/api/decks/{other}/spares"), Some(&token), Some(json!({"container_id": bag}))).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Nor can a deck keep its 100 in it.
    let (status, refused) = send(&app, Method::PATCH, &format!("/api/decks/{other}"), Some(&token), Some(json!({"container_id": bag}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");

    // Unlinking keeps the box and its copies.
    let (status, off) = send(&app, Method::PUT, &path, Some(&token), Some(json!({"container_id": null}))).await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert!(off["container_id"].is_null());
    let kept: i64 = sqlx::query_scalar("SELECT SUM(qty) FROM collection_items WHERE container_id = ?").bind(&bag).fetch_one(&pool).await.unwrap();
    assert_eq!(kept, 2);

    // With no bag box free, making them makes one; deleting it unlinks the deck.
    let (_, again) = send(&app, Method::PUT, &format!("/api/decks/{other}/spares"), Some(&token), Some(json!({"create": true}))).await;
    assert_eq!(again["container_name"], "World Shaper swap bag", "{again}");
    let made = again["container_id"].as_str().unwrap().to_string();
    assert_eq!(send(&app, Method::DELETE, &format!("/api/containers/{made}"), Some(&token), None).await.0, StatusCode::OK);
    let linked: Option<String> = sqlx::query_scalar("SELECT spares_container_id FROM decks WHERE id = ?").bind(&other).fetch_one(&pool).await.unwrap();
    assert_eq!(linked, None);
}

/// The migration's link step, run again on seeded rows: a box "<deck> swap bag" becomes that
/// deck's spares when exactly one live main deck has the name; nothing else changes.
#[tokio::test]
async fn the_migration_links_each_swap_bag_to_its_one_deck() {
    let (_, pool) = app().await;
    cards(&pool).await;
    let (ann, _) = user(&pool, "ann@example.com").await;
    let (bob, _) = user(&pool, "bob@example.com").await;
    let riders = deck(&pool, &ann, "Riders of Rohan").await;
    let shaper = deck(&pool, &ann, "World Shaper").await;
    let twin_a = deck(&pool, &ann, "Twins").await;
    let twin_b = deck(&pool, &ann, "Twins").await;
    let bobs = deck(&pool, &bob, "Riders of Rohan").await;
    let bag = container(&pool, &ann, "box", "Riders of Rohan swap bag").await;
    copies(&pool, &ann, "p-o-tal", 1, &bag).await;
    let shaper_bag = container(&pool, &ann, "box", "world shaper SWAP BAG").await;
    container(&pool, &ann, "box", "Twins swap bag").await;
    let held = deck(&pool, &ann, "Held").await;
    let held_box = container(&pool, &ann, "box", "Held swap bag").await;
    sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(&held_box).bind(&held).execute(&pool).await.unwrap();
    let before: Vec<(String, Option<String>, i64)> = sqlx::query_as("SELECT id, container_id, qty FROM collection_items ORDER BY id").fetch_all(&pool).await.unwrap();

    let sql = include_str!("../../../migrations/0096_deck_swappable_spares.sql");
    let update = &sql[sql.find("UPDATE decks SET spares_container_id = (").unwrap()..];
    sqlx::query(sqlx::AssertSqlSafe(update.to_string())).execute(&pool).await.unwrap();

    let link = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, Option<String>>("SELECT spares_container_id FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    assert_eq!(link(riders).await, Some(bag));
    assert_eq!(link(shaper).await, Some(shaper_bag));
    assert_eq!(link(twin_a).await, None, "two decks share the name");
    assert_eq!(link(twin_b).await, None);
    assert_eq!(link(bobs).await, None, "never another account's box");
    assert_eq!(link(held).await, None, "never a box that holds a deck's 100");
    let after: Vec<(String, Option<String>, i64)> = sqlx::query_as("SELECT id, container_id, qty FROM collection_items ORDER BY id").fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "no copy moves");
}

use serde_json::json;
