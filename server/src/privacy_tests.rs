//! What an account that joined through open sign-up (a stranger) can see of someone else's
//! things: nothing, unless they hold a playgroup join code. Through the whole router, from the
//! stranger's own session. Plans (`plan::tests::plans_are_per_user`), lab experiments
//! (`lab::experiment_tests::other_users_experiments_and_decks_are_not_found`), search ownership
//! (`cards::tests::search_hits_carry_price_and_ownership`) and game exports
//! (`game_export::tests::other_players_deck_names_and_notes_stay_private`) have their own tests.

use crate::testutil::{config, deck, send, state_with, user};
use axum::Router;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

async fn open_server() -> (Router, SqlitePool) {
    let pool = crate::db::test_pool().await;
    let mut cfg = config();
    cfg.open_signup = true;
    let st = state_with(cfg, pool.clone()).await;
    (crate::routes::app(st), pool)
}

async fn get(app: &Router, token: &str, path: &str) -> (StatusCode, Value) {
    send(app, Method::GET, path, Some(token), None).await
}

#[tokio::test]
async fn a_stranger_sees_none_of_another_accounts_things() {
    let (app, pool) = open_server().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (stranger, st) = user(&pool, "stranger@gmail.com").await;
    sqlx::query("UPDATE users SET google_sub = 'g-stranger' WHERE id = ?").bind(&stranger).execute(&pool).await.unwrap();
    assert_eq!(get(&app, &st, "/api/me").await.1["limited"], true, "the stranger joined without an invite");

    // Bryan's things: a deck, a box with a card he paid for, a logged game, a playgroup, an online
    // game, a script key and a lab run of his own.
    let (deck_id, version) = deck(&pool, &bryan, "Riders of Rohan").await;
    sqlx::query(
        "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
         VALUES ('p1', 'o-sol', 'Sol Ring', 'cmm', 'Commander Masters', '410', 'en', 'now')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (_, container) = send(&app, Method::POST, "/api/containers", Some(&bt), Some(json!({ "kind": "binder", "name": "Trade binder" }))).await;
    let container = container["id"].as_str().unwrap().to_string();
    let add = json!([{ "op_id": "op-1", "kind": "add", "scryfall_id": "p1", "qty": 1, "container_id": container, "purchase_price": 12.5, "purchase_currency": "USD" }]);
    assert_eq!(send(&app, Method::POST, "/api/collection/ops", Some(&bt), Some(add)).await.0, StatusCode::OK);
    let (_, items) = get(&app, &bt, "/api/collection").await;
    assert_eq!(items.as_array().unwrap().len(), 1, "{items}");
    let item = items[0]["id"].as_str().unwrap().to_string();
    let game = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0aaa";
    let new_game = json!({ "id": game, "started_at": "2026-10-18T01:00:00Z", "note": "Bryan's private note",
        "seats": [{ "seat": 0, "user_id": bryan, "deck_version_id": version }, { "seat": 1, "guest_name": "Sam" }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(new_game)).await.0, StatusCode::OK);
    let (_, group) = send(&app, Method::POST, "/api/playgroups", Some(&bt), Some(json!({ "name": "Thursday" }))).await;
    let (group_id, code) = (group["id"].as_str().unwrap().to_string(), group["join_code"].as_str().unwrap().to_string());
    sqlx::query("INSERT INTO games (id, mode, created_by, format, status, starting_life, started_at) VALUES ('online-1', 'online', ?, 'commander', 'in_progress', 40, 'now')")
        .bind(&bryan)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES ('online-1', 'ABCDEF', ?, 'lobby', '[]', 'now', 'now')")
        .bind(&bryan)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(send(&app, Method::POST, "/api/me/tokens", Some(&bt), Some(json!({ "name": "laptop" }))).await.0, StatusCode::OK);
    sqlx::query(
        "INSERT INTO lab_runs (id, owner_id, name, kind, games, created_at, imported_at, summary, summary_sha256)
         VALUES ('bryans-run', ?, 'mine', 'precon-ratings', 100, 'now', 'now', '{}', 'x')",
    )
    .bind(&bryan)
    .execute(&pool)
    .await
    .unwrap();

    // Lists show the stranger nothing of Bryan's.
    for path in ["/api/decks", "/api/collection", "/api/containers", "/api/games", "/api/playgroups", "/api/play", "/api/me/tokens", "/api/plan/imports"] {
        let (status, body) = get(&app, &st, path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(body, json!([]), "{path}");
    }
    let (_, runs) = get(&app, &st, "/api/lab/runs").await;
    assert!(!runs.to_string().contains("bryans-run"), "{runs}");
    let (_, bundle) = get(&app, &st, "/api/plan/bundle").await;
    assert_eq!(bundle["decks"], json!([]));
    // The CSV export and the game export carry none of Bryan's rows, prices or notes.
    let (status, csv) = send(&app, Method::GET, "/api/collection/export.csv", Some(&st), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!csv.to_string().contains("12.5") && !csv.to_string().contains("Sol Ring"));
    let (_, export) = get(&app, &st, "/api/games/export.json").await;
    assert!(!export.to_string().contains(game) && !export.to_string().contains("private note"), "{export}");
    let (_, summary) = get(&app, &st, "/api/collection/summary").await;
    assert!(!summary.to_string().contains("12.5"), "{summary}");

    // Bryan's things by id are "not found", read or write.
    let d = format!("/api/decks/{deck_id}");
    let not_found = [
        (Method::GET, d.clone(), None),
        (Method::GET, format!("{d}/versions"), None),
        (Method::GET, format!("{d}/versions/{version}"), None),
        (Method::GET, format!("{d}/check"), None),
        (Method::POST, format!("{d}/check"), None),
        (Method::GET, format!("{d}/results"), None),
        (Method::PUT, d.clone(), Some(json!({ "cards": [] }))),
        (Method::PATCH, d.clone(), Some(json!({ "name": "Mine now" }))),
        (Method::DELETE, d.clone(), None),
        (Method::PATCH, format!("/api/containers/{container}"), Some(json!({ "name": "Mine now" }))),
        (Method::GET, format!("/api/games/{game}"), None),
        (Method::POST, format!("/api/games/{game}/events"), Some(json!([]))),
        (Method::DELETE, format!("/api/games/{game}"), None),
        (Method::GET, format!("/api/playgroups/{group_id}"), None),
        (Method::GET, format!("/api/playgroups/{group_id}/stats"), None),
        (Method::POST, format!("/api/playgroups/{group_id}/guests"), Some(json!({ "name": "Me" }))),
        (Method::GET, "/api/play/online-1".to_string(), None),
        (Method::GET, "/api/play/online-1/view".to_string(), None),
        (Method::GET, "/api/lab/runs/bryans-run".to_string(), None),
    ];
    for (method, path, body) in not_found {
        let (status, res) = send(&app, method.clone(), &path, Some(&st), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {res}");
    }
    // Deleting Bryan's box or naming his card in an op changes nothing (the delete answers 200
    // because it is scoped to the caller's own boxes, of which this isn't one).
    let _ = send(&app, Method::DELETE, &format!("/api/containers/{container}"), Some(&st), None).await;
    let (_, boxes) = get(&app, &bt, "/api/containers").await;
    assert_eq!(boxes.as_array().unwrap().len(), 1, "{boxes}");
    let remove = json!([{ "op_id": "op-x", "kind": "remove", "item_id": item }]);
    let _ = send(&app, Method::POST, "/api/collection/ops", Some(&st), Some(remove)).await;
    let (_, items) = get(&app, &bt, "/api/collection").await;
    assert_eq!(items.as_array().unwrap().len(), 1);
    assert_eq!(items[0]["purchase_price"], 12.5);
    let name: String = sqlx::query_scalar("SELECT name FROM decks WHERE id = ?").bind(&deck_id).fetch_one(&pool).await.unwrap();
    assert_eq!(name, "Riders of Rohan");

    // A join code is an invitation: with it, the stranger sees the playgroup, and still none of
    // Bryan's own decks, collection or keys.
    assert_eq!(send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await.0, StatusCode::OK);
    assert_eq!(get(&app, &st, &format!("/api/playgroups/{group_id}")).await.0, StatusCode::OK);
    assert_eq!(get(&app, &st, "/api/decks").await.1, json!([]));
    assert_eq!(get(&app, &st, "/api/collection").await.1, json!([]));
    assert_eq!(get(&app, &st, &d).await.0, StatusCode::NOT_FOUND);

    // Nor can a stranger use admin routes.
    for path in ["/api/invites", "/api/admin/users", "/api/admin/usage", "/api/admin/server", "/api/admin/lab-runs"] {
        assert_eq!(get(&app, &st, path).await.0, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn join_codes_and_searches_are_rate_limited_per_account() {
    let (app, pool) = open_server().await;
    let (_, st) = user(&pool, "stranger@gmail.com").await;
    for i in 0..20 {
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": format!("WRONG{i}") }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (status, body) = send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": "WRONG" }))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    // Online game codes share the count.
    let (status, _) = send(&app, Method::POST, "/api/play/join", Some(&st), Some(json!({ "code": "WRONG", "deck_id": "d" }))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Someone else has their own count.
    let (_, other) = user(&pool, "other@example.com").await;
    assert_eq!(send(&app, Method::POST, "/api/playgroups/join", Some(&other), Some(json!({ "code": "WRONG" }))).await.0, StatusCode::NOT_FOUND);

    for _ in 0..120 {
        assert_eq!(get(&app, &st, "/api/cards/search?q=sol").await.0, StatusCode::OK);
    }
    assert_eq!(get(&app, &st, "/api/cards/search?q=sol").await.0, StatusCode::TOO_MANY_REQUESTS);
    let long = format!("/api/cards/search?q={}", "a".repeat(1001));
    assert_eq!(get(&app, &other, &long).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn online_games_a_stranger_can_host_are_capped() {
    let (app, pool) = open_server().await;
    let (stranger, st) = user(&pool, "stranger@gmail.com").await;
    sqlx::query("UPDATE users SET google_sub = 'g-stranger' WHERE id = ?").bind(&stranger).execute(&pool).await.unwrap();
    let (member, mt) = user(&pool, "friend@example.com").await;
    let host = |id: String, owner: String, stage: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query("INSERT INTO games (id, mode, created_by, format, status, starting_life, started_at) VALUES (?, 'online', ?, 'commander', 'in_progress', 40, 'now')")
                .bind(&id)
                .bind(&owner)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'now', 'now')")
                .bind(&id)
                .bind(&id)
                .bind(&owner)
                .bind(stage)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let body = json!({ "seats": [{ "kind": "me", "deck_id": "d" }, { "kind": "ai", "deck_id": "d" }] });
    host("s1".into(), stranger.clone(), "live").await;
    host("s2".into(), stranger.clone(), "lobby").await;
    host("s3".into(), stranger.clone(), "over").await;
    let (status, res) = send(&app, Method::POST, "/api/play", Some(&st), Some(body.clone())).await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    assert!(res["error"].as_str().unwrap().contains("2 online games that haven't finished"), "{res}");
    // A member may host more (here online play is off, which is the next thing it says).
    for i in 0..3 {
        host(format!("m{i}"), member.clone(), "live").await;
    }
    let (status, res) = send(&app, Method::POST, "/api/play", Some(&mt), Some(body.clone())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert!(res["error"].as_str().unwrap().starts_with("online play is off"), "{res}");
    for i in 3..crate::play::MAX_OPEN_GAMES {
        host(format!("m{i}"), member.clone(), "lobby").await;
    }
    assert_eq!(send(&app, Method::POST, "/api/play", Some(&mt), Some(body)).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn only_whoever_recorded_a_table_game_can_delete_it() {
    let (app, pool) = open_server().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_alex, at) = user(&pool, "alex@example.com").await;
    // Alex is in Bryan's playgroup, and the game is a playgroup game.
    let (_, group) = send(&app, Method::POST, "/api/playgroups", Some(&bt), Some(json!({ "name": "Thursday" }))).await;
    let (group_id, code) = (group["id"].as_str().unwrap().to_string(), group["join_code"].as_str().unwrap().to_string());
    assert_eq!(send(&app, Method::POST, "/api/playgroups/join", Some(&at), Some(json!({ "code": code }))).await.0, StatusCode::OK);
    let game = "0b5a3d1e-2f4c-4e8a-9a51-7c2d9e1f0b11";
    let new_game = json!({ "id": game, "playgroup_id": group_id, "started_at": "2026-10-31T01:00:00Z",
        "seats": [{ "seat": 0, "user_id": bryan }, { "seat": 1, "guest_name": "Alex" }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(new_game)).await.0, StatusCode::OK);
    let event = json!([{ "seq": 1, "actor_seat": 0, "kind": "life", "payload": { "type": "life", "seat": 0, "delta": -3 }, "created_at": "2026-10-31T01:01:00Z" }]);
    assert_eq!(send(&app, Method::POST, &format!("/api/games/{game}/events"), Some(&bt), Some(event)).await.0, StatusCode::OK);
    let path = format!("/api/games/{game}");

    // Alex can read it through the playgroup, but it's Bryan's record.
    let (status, detail) = get(&app, &at, &path).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["can_delete"], false);
    assert_eq!(send(&app, Method::DELETE, &path, Some(&at), None).await.0, StatusCode::NOT_FOUND);

    let (_, detail) = get(&app, &bt, &path).await;
    assert_eq!(detail["can_delete"], true);
    assert_eq!(send(&app, Method::DELETE, &path, Some(&bt), None).await.0, StatusCode::OK);
    assert_eq!(get(&app, &bt, &path).await.0, StatusCode::NOT_FOUND);
    // Another device that still has it can't put it back.
    let again = json!({ "id": game, "started_at": "2026-10-31T01:00:00Z", "seats": [{ "seat": 0, "user_id": bryan }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(again)).await.0, StatusCode::GONE);
    // Its seats and events go with it.
    let left: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM game_seats WHERE game_id = ?1) + (SELECT COUNT(*) FROM game_events WHERE game_id = ?1)")
        .bind(game)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn deleting_a_game_never_uploaded_stops_it_being_uploaded_later() {
    let (app, pool) = open_server().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, st) = user(&pool, "sam@example.com").await;
    let game = "5d0c7a2b-8e1f-4b3a-9c6d-2a1e0f9b8c77";
    assert_eq!(send(&app, Method::DELETE, &format!("/api/games/{game}"), Some(&bt), None).await.0, StatusCode::OK);
    let upload = json!({ "id": game, "started_at": "2026-10-31T01:00:00Z", "seats": [{ "seat": 0, "user_id": bryan }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(upload)).await.0, StatusCode::GONE);

    // Someone else's game is still "not found" to Sam, and stays undeleted.
    let other = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
    let upload = json!({ "id": other, "started_at": "2026-10-31T01:00:00Z", "seats": [{ "seat": 0, "user_id": bryan }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(upload)).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::DELETE, &format!("/api/games/{other}"), Some(&st), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(get(&app, &bt, &format!("/api/games/{other}")).await.0, StatusCode::OK);
    let fenced: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deleted_games WHERE id = ?").bind(other).fetch_one(&pool).await.unwrap();
    assert_eq!(fenced, 0);
    // Sam deleting an id Bryan hasn't uploaded yet (it's in the join link) doesn't block Bryan.
    let early = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    assert_eq!(send(&app, Method::DELETE, &format!("/api/games/{early}"), Some(&st), None).await.0, StatusCode::OK);
    let upload = json!({ "id": early, "started_at": "2026-10-31T01:00:00Z", "seats": [{ "seat": 0, "user_id": bryan }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(upload)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn private_tables_only_reveal_the_cloudflare_key_to_their_creator() {
    let (app, pool) = open_server().await;
    let (bryan, bt) = user(&pool, "bryan@example.com").await;
    let (_, st) = user(&pool, "sam@example.com").await;
    let game = "7e2a9c1d-4b3f-4d8e-a6c5-1f0e9d8c7b66";
    let live = format!("/api/table/{game}/live");
    let key = "0123456789abcdef0123456789abcdef";
    let new_game = json!({ "id": game, "started_at": "2026-11-01T01:00:00Z", "seats": [{ "seat": 0, "user_id": bryan }] });
    assert_eq!(send(&app, Method::POST, "/api/games", Some(&bt), Some(new_game)).await.0, StatusCode::OK);

    // Someone else can neither leave a key for it nor read Bryan's.
    assert_eq!(send(&app, Method::PUT, &live, Some(&st), Some(json!({ "key": key }))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&app, Method::PUT, &live, Some(&bt), Some(json!({ "key": "not-a-key" }))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::PUT, &live, Some(&bt), Some(json!({ "key": key }))).await.0, StatusCode::OK);
    let (_, theirs) = get(&app, &st, &live).await;
    assert_eq!(theirs, json!({ "hosting": false }));
    // Sam stopping it changes nothing.
    assert_eq!(send(&app, Method::DELETE, &live, Some(&st), None).await.0, StatusCode::OK);

    let (_, mine) = get(&app, &bt, &live).await;
    assert_eq!(mine, json!({ "hosting": true, "key": key, "relay": "edge" }));
    assert_eq!(send(&app, Method::DELETE, &live, Some(&bt), None).await.0, StatusCode::OK);
    let (_, mine) = get(&app, &bt, &live).await;
    assert_eq!(mine, json!({ "hosting": false }));
}
