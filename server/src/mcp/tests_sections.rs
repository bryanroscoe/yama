//! Sections over MCP: containers named by path, made inside another, moved, and many moves of
//! cards staged as one change.

use super::tests::{call, key, seed_cards};
use crate::testutil::{app, user};
use serde_json::{Value, json};

fn change_id(text: &str) -> String {
    text.lines().find_map(|l| l.strip_prefix("Change id: ")).expect("a change id").trim().to_string()
}

#[tokio::test]
async fn sections_by_path_and_many_moves_as_one_change() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, session) = user(&pool, "bryan@example.com").await;
    let (_, other_session) = user(&pool, "someone@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;
    let other = key(&app, &other_session, Some("mcp")).await;
    let stage_apply = |tool: &'static str, args: Value| {
        let (app, mcp) = (app.clone(), mcp.clone());
        async move {
            let (err, text) = call(&app, &mcp, tool, args).await;
            assert!(!err, "{text}");
            let (err, done) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
            assert!(!err, "{done}");
            text
        }
    };

    // A box, a section in it, a sub-section in that: kind comes from the parent.
    stage_apply("create_container", json!({"name": "Big box", "kind": "box"})).await;
    let text = stage_apply("create_container", json!({"name": "Bulk Basic", "parent": "Big box"})).await;
    assert!(text.contains("Make a box called Bulk Basic in Big box"), "{text}");
    stage_apply("create_container", json!({"name": "Plains", "parent": "Big box/Bulk Basic"})).await;
    stage_apply("create_container", json!({"name": "Spares", "kind": "box"})).await;
    let text = stage_apply("create_container", json!({"name": "Plains", "parent": "Spares"})).await;
    assert!(text.contains("in Spares"), "{text}");
    let (err, text) = call(&app, &mcp, "create_container", json!({"name": "Plains", "parent": "Big box › Bulk Basic"})).await;
    assert!(err && text.contains("already have a box called Plains in Big box › Bulk Basic"), "{text}");
    let (err, text) = call(&app, &mcp, "create_container", json!({"name": "Loose box"})).await;
    assert!(err && text.contains("kind"), "{text}");
    let (err, text) = call(&app, &other, "create_container", json!({"name": "X", "parent": "Big box"})).await;
    assert!(err && text.contains("no binder, deck box or list called"), "someone else's box: {text}");

    // The summary is a tree, with paths and rolled-up totals.
    for (qty, to) in [(6, "Big box/Bulk Basic/Plains"), (2, "Spares/Plains")] {
        stage_apply("add_to_collection", json!({"card": "Forest", "qty": qty, "container": to})).await;
    }
    let (err, text) = call(&app, &mcp, "get_collection_summary", json!({})).await;
    assert!(!err, "{text}");
    let summary: Value = serde_json::from_str(&text).unwrap();
    let rows = summary["containers"].as_array().unwrap();
    let paths: Vec<&str> = rows.iter().map(|r| r["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["Big box", "Big box › Bulk Basic", "Big box › Bulk Basic › Plains", "Spares", "Spares › Plains"]);
    assert_eq!((rows[0]["copies"].as_i64(), rows[0]["total_copies"].as_i64(), rows[2]["depth"].as_i64()), (Some(0), Some(6), Some(2)));

    // A name two sections share needs its path; the path finds one.
    let (err, text) = call(&app, &mcp, "move_cards", json!({"card": "Forest", "from": "Plains", "to": "Big box"})).await;
    assert!(err && text.contains("Several of their containers are called \"Plains\"") && text.contains("Big box › Bulk Basic › Plains"), "{text}");
    let text = stage_apply("move_cards", json!({"card": "Forest", "qty": 2, "from": "Bulk Basic/Plains", "to": "Big box"})).await;
    assert!(text.contains("Move 2 Forest from Big box › Bulk Basic › Plains to Big box"), "{text}");
    let (err, text) = call(&app, &mcp, "list_collection_cards", json!({"container": "Big box"})).await;
    assert!(!err, "{text}");
    let listed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().iter().map(|i| i["qty"].as_i64().unwrap()).sum::<i64>(), 6, "{listed}");
    assert!(text.contains("\"container_path\":\"Big box › Bulk Basic › Plains\""), "{text}");
    let (_, text) = call(&app, &mcp, "list_collection_cards", json!({"container": "Big box", "include_sections": false})).await;
    let listed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().iter().map(|i| i["qty"].as_i64().unwrap()).sum::<i64>(), 2, "{listed}");

    // Many moves as one change: a later move may take what an earlier one brought.
    let moves = json!({"moves": [
        {"card": "Forest", "qty": 4, "from": "Big box/Bulk Basic/Plains", "to": "Spares/Plains"},
        {"card": "Forest", "qty": 5, "from": "Spares/Plains", "to": "Loose"},
        {"card": "Forest", "qty": 2, "from": "Big box", "to": "Spares", "finish": "nonfoil", "set": "tst", "number": "1"},
    ]});
    let (err, text) = call(&app, &mcp, "move_cards", moves.clone()).await;
    assert!(!err && text.contains("Move 11 cards in 3 moves") && text.contains("- 5 Forest from Spares › Plains to Loose"), "{text}");
    let held = || async {
        sqlx::query_as::<_, (Option<String>, i64)>(
            "SELECT ct.name, i.qty FROM collection_items i LEFT JOIN containers ct ON ct.id = i.container_id WHERE i.owner_id = ? AND i.qty > 0 ORDER BY ct.name, ct.parent_id",
        )
        .bind(&a)
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    let before = held().await;
    // Staged, so nothing moved. Then something moves out from under it: applying it refuses, and
    // nothing of the change happens (the first two moves could still have been made).
    sqlx::query("UPDATE collection_items SET qty = 1 WHERE owner_id = ? AND container_id = (SELECT id FROM containers WHERE name = 'Big box')").bind(&a).execute(&pool).await.unwrap();
    let after_edit = held().await;
    let (err, done) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(err && done.contains("no longer holds 2 Forest"), "{done}");
    assert_eq!(held().await, after_edit, "all or nothing");
    assert_ne!(before, after_edit);
    sqlx::query("UPDATE collection_items SET qty = 2 WHERE owner_id = ? AND container_id = (SELECT id FROM containers WHERE name = 'Big box')").bind(&a).execute(&pool).await.unwrap();
    stage_apply("move_cards", moves).await;
    assert_eq!(held().await, [(None, 5), (Some("Plains".into()), 1), (Some("Spares".into()), 2)], "Big box › Bulk Basic › Plains keeps 0 of 4, Spares › Plains 1");

    // Staging follows the copies each move takes: two foils brought into Loose can't be taken
    // out again as regular copies, but they can as foils.
    sqlx::query("UPDATE collection_items SET finish = 'foil' WHERE owner_id = ? AND container_id = (SELECT id FROM containers WHERE name = 'Spares')").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "move_cards", json!({"moves": [
        {"card": "Forest", "qty": 2, "from": "Spares", "to": "Loose"},
        {"card": "Forest", "qty": 6, "from": "Loose", "to": "Spares", "finish": "nonfoil"},
    ]})).await;
    assert!(err && text.contains("Move 2: Loose (in no binder or box) holds 5 Forest like that, not 6"), "{text}");
    let (err, text) = call(&app, &mcp, "move_cards", json!({"moves": [
        {"card": "Forest", "qty": 2, "from": "Spares", "to": "Loose"},
        {"card": "Forest", "qty": 2, "from": "Loose", "to": "Spares", "finish": "foil"},
    ]})).await;
    assert!(!err, "{text}");
    sqlx::query("UPDATE collection_items SET finish = 'nonfoil' WHERE owner_id = ?").bind(&a).execute(&pool).await.unwrap();
    // A row partly taken is read again in the apply's order (the biggest first): after the first
    // move Loose holds 4 regular and 3 foil, so the second takes 3 regular and leaves 1.
    sqlx::query("UPDATE collection_items SET finish = 'foil' WHERE owner_id = ? AND container_id IS NULL").bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, finish, created_at, updated_at) VALUES ('loose-reg', ?, 'p-o-forest', 4, 'nonfoil', 'now', 'now')").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "move_cards", json!({"moves": [
        {"card": "Forest", "qty": 2, "from": "Loose", "to": "Spares"},
        {"card": "Forest", "qty": 3, "from": "Loose", "to": "Spares"},
        {"card": "Forest", "qty": 2, "from": "Loose", "to": "Spares", "finish": "nonfoil"},
    ]})).await;
    assert!(err && text.contains("Move 3: Loose (in no binder or box) holds 1 Forest like that, not 2"), "{text}");
    sqlx::query("DELETE FROM collection_items WHERE id = 'loose-reg'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE collection_items SET finish = 'nonfoil' WHERE owner_id = ?").bind(&a).execute(&pool).await.unwrap();

    // A batch that can't happen is refused whole, naming the move.
    let (err, text) = call(&app, &mcp, "move_cards", json!({"moves": [
        {"card": "Forest", "from": "Loose", "to": "Spares"},
        {"card": "Forest", "qty": 50, "from": "Loose", "to": "Spares"},
    ]})).await;
    assert!(err && text.contains("Move 2: Loose (in no binder or box) holds 4 Forest, not 50"), "{text}");
    let (err, text) = call(&app, &mcp, "move_cards", json!({"card": "Forest", "from": "Loose", "to": "Spares", "moves": []})).await;
    assert!(err && text.contains("not both"), "{text}");
    let too_many: Vec<Value> = (0..501).map(|_| json!({"card": "Forest", "from": "Loose", "to": "Spares"})).collect();
    let (err, text) = call(&app, &mcp, "move_cards", json!({"moves": too_many})).await;
    assert!(err, "{text}");

    // Moving a section: not into itself or its own section; with its cards, to another box.
    let (err, text) = call(&app, &mcp, "update_container", json!({"container": "Big box", "parent": "Big box/Bulk Basic"})).await;
    assert!(err && text.contains("one of its own sections"), "{text}");
    let (err, text) = call(&app, &mcp, "update_container", json!({"container": "Spares/Plains", "parent": "Big box/Bulk Basic"})).await;
    assert!(err && text.contains("already have a box called Plains in Big box › Bulk Basic"), "{text}");
    let text = stage_apply("update_container", json!({"container": "Spares/Plains", "parent": "Big box/Bulk Basic", "name": "Plains 2"})).await;
    assert!(text.contains("Spares › Plains: rename it Plains 2 and move it into Big box › Bulk Basic"), "{text}");
    let text = stage_apply("update_container", json!({"container": "Bulk Basic", "top_level": true})).await;
    assert!(text.contains("Big box › Bulk Basic: move it to the top level"), "{text}");
    let (_, text) = call(&app, &mcp, "get_collection_summary", json!({})).await;
    let summary: Value = serde_json::from_str(&text).unwrap();
    let paths: Vec<&str> = summary["containers"].as_array().unwrap().iter().map(|r| r["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["Big box", "Bulk Basic", "Bulk Basic › Plains", "Bulk Basic › Plains 2", "Spares"]);
    let (err, text) = call(&app, &mcp, "update_container", json!({"container": "Spares"})).await;
    assert!(err && text.contains("Say what changes"), "{text}");
}
