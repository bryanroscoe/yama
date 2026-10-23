//! The admin area: who may reach it, deleting an account completely, last-seen times, global lab
//! runs, and the usage and server pages.

use super::delete::{USER_COLUMNS, delete_rows};
use crate::testutil::{app, deck, send, user};
use crate::util::now;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn admin(pool: &SqlitePool, email: &str) -> (String, String) {
    let (id, token) = user(pool, email).await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&id).execute(pool).await.unwrap();
    (id, token)
}

/// Every admin route, with a body where it takes one.
fn admin_routes() -> Vec<(Method, &'static str, Option<Value>)> {
    vec![
        (Method::GET, "/api/admin/users", None),
        (Method::POST, "/api/admin/users/someone/disable", None),
        (Method::POST, "/api/admin/users/someone/enable", None),
        (Method::DELETE, "/api/admin/users/someone", Some(json!({"confirm_email": "x@example.com"}))),
        (Method::POST, "/api/admin/users/someone/invite", None),
        (Method::DELETE, "/api/admin/users/someone/invite", None),
        (Method::GET, "/api/admin/usage", None),
        (Method::GET, "/api/admin/server", None),
        (Method::POST, "/api/admin/watch/some-game/stop", None),
        (Method::GET, "/api/admin/lab-runs", None),
        (Method::PATCH, "/api/admin/lab-runs/some-run", Some(json!({"name": "x"}))),
        (Method::DELETE, "/api/admin/lab-runs/some-run", None),
        (Method::GET, "/api/invites", None),
        (Method::POST, "/api/invites", Some(json!({"email": "friend@example.com"}))),
        (Method::DELETE, "/api/invites/friend@example.com", None),
        (Method::POST, "/api/admin/users/someone/view", None),
        (Method::GET, "/api/admin/views", None),
        (Method::GET, "/api/admin/advisor-shared", None),
        (Method::PUT, "/api/admin/users/someone/advisor-shared", Some(json!({"daily_limit": null}))),
        (Method::DELETE, "/api/admin/users/someone/advisor-shared", None),
    ]
}

#[tokio::test]
async fn admin_routes_look_like_unknown_routes_to_everyone_else() {
    let (app, pool) = app().await;
    let (_, token) = user(&pool, "pat@example.com").await;
    for (method, path, body) in admin_routes() {
        let (status, answer) = send(&app, method.clone(), path, Some(&token), body.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        assert_eq!(answer["error"], "API route not found", "{method} {path}");
        let (status, _) = send(&app, method.clone(), path, None, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path} signed out");
    }
    // Nothing changed on the way.
    let invites: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites").fetch_one(&pool).await.unwrap();
    assert_eq!(invites, 0);
    let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM advisor_shared_access").fetch_one(&pool).await.unwrap();
    assert_eq!(grants, 0);
}

#[tokio::test]
async fn admins_reach_the_pages() {
    let (app, pool) = app().await;
    let (_, token) = admin(&pool, "bryan@example.com").await;
    let (_, _) = user(&pool, "pat@example.com").await;
    let (status, usage) = send(&app, Method::GET, "/api/admin/usage", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{usage}");
    assert_eq!(usage["totals"]["accounts"], 2);
    let pat = usage["accounts"].as_array().unwrap().iter().find(|a| a["email"] == "pat@example.com").unwrap();
    assert_eq!(pat["limits"]["advisor_per_day"], crate::advisor::DAILY_INVITED);
    assert_eq!(pat["advisor_reason"], "off", "no advisor on a test server");
    let me = usage["accounts"].as_array().unwrap().iter().find(|a| a["email"] == "bryan@example.com").unwrap();
    assert!(me["limits"]["advisor_per_day"].is_null(), "admins have no limits");

    let (status, server) = send(&app, Method::GET, "/api/admin/server", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{server}");
    assert_eq!(server["engine"]["label"], yama_play::lab::ENGINE);
    assert!(!server["version"].as_str().unwrap().is_empty());
    assert_eq!(server["advisor"]["enabled"], false);
    assert!(server["advisor"]["reachable"].is_null());

    let (status, _) = send(&app, Method::GET, "/api/admin/lab-runs", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, Method::POST, "/api/admin/watch/no-such-game/stop", Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ── last seen ──────────────────────────────────────────────────────────────

async fn last_seen(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT last_seen_at FROM users WHERE id = ?").bind(id).fetch_one(pool).await.unwrap()
}

async fn set_last_seen(pool: &SqlitePool, id: &str, minutes_ago: i64) -> String {
    let t = (chrono::Utc::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(&t).bind(id).execute(pool).await.unwrap();
    t
}

#[tokio::test]
async fn last_seen_is_written_at_most_once_an_hour() {
    let (app, pool) = app().await;
    let (id, token) = user(&pool, "pat@example.com").await;
    assert_eq!(last_seen(&pool, &id).await, None);
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&token), None).await.0, StatusCode::OK);
    assert!(last_seen(&pool, &id).await.is_some());

    let recent = set_last_seen(&pool, &id, 30).await;
    send(&app, Method::GET, "/api/decks", Some(&token), None).await;
    assert_eq!(last_seen(&pool, &id).await, Some(recent), "within the hour: no write");

    let old = set_last_seen(&pool, &id, 61).await;
    send(&app, Method::GET, "/api/decks", Some(&token), None).await;
    let now_seen = last_seen(&pool, &id).await.unwrap();
    assert!(now_seen > old, "{now_seen} should be after {old}");

    // The admin list carries it.
    let (_, token_admin) = admin(&pool, "bryan@example.com").await;
    let (_, list) = send(&app, Method::GET, "/api/admin/users", Some(&token_admin), None).await;
    let row = list.as_array().unwrap().iter().find(|u| u["email"] == "pat@example.com").unwrap();
    assert_eq!(row["last_seen_at"], json!(now_seen));
}

// ── global lab runs ────────────────────────────────────────────────────────

async fn lab_run(pool: &SqlitePool, owner: Option<&str>, name: &str) -> String {
    let id = crate::util::new_id();
    sqlx::query(
        "INSERT INTO lab_runs (id, owner_id, name, kind, games, created_at, imported_at, summary, summary_sha256)
         VALUES (?, ?, ?, 'precon-ratings', 10, ?, ?, '{}', 'x')",
    )
    .bind(&id)
    .bind(owner)
    .bind(name)
    .bind(now())
    .bind(now())
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn admins_rename_and_delete_global_runs_only() {
    let (app, pool) = app().await;
    let (_, token) = admin(&pool, "bryan@example.com").await;
    let (pat, _) = user(&pool, "pat@example.com").await;
    let a = lab_run(&pool, None, "precons-1").await;
    let b = lab_run(&pool, None, "precons-2").await;
    let mine = lab_run(&pool, Some(&pat), "pat-run").await;

    let (_, list) = send(&app, Method::GET, "/api/admin/lab-runs", Some(&token), None).await;
    let names: Vec<&str> = list.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), 2, "{list}");
    assert!(!names.contains(&"pat-run"));

    let rename = |id: &str| format!("/api/admin/lab-runs/{id}");
    assert_eq!(send(&app, Method::PATCH, &rename(&a), Some(&token), Some(json!({"name": "precons-2"}))).await.0, StatusCode::CONFLICT);
    assert_eq!(send(&app, Method::PATCH, &rename(&a), Some(&token), Some(json!({"name": "  "}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::PATCH, &rename(&a), Some(&token), Some(json!({"name": "precons-1 (old engine)"}))).await.0, StatusCode::NO_CONTENT);
    let name: String = sqlx::query_scalar("SELECT name FROM lab_runs WHERE id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(name, "precons-1 (old engine)");
    // Someone's own run isn't the admin's to rename or delete here.
    assert_eq!(send(&app, Method::PATCH, &rename(&mine), Some(&token), Some(json!({"name": "x"}))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::DELETE, &rename(&mine), Some(&token), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::DELETE, &rename(&b), Some(&token), None).await.0, StatusCode::NO_CONTENT);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_runs").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 2);
}

// ── invites by account ─────────────────────────────────────────────────────

#[tokio::test]
async fn admins_invite_and_uninvite_an_account() {
    let (app, pool) = app().await;
    let (_, token) = admin(&pool, "bryan@example.com").await;
    let (pat, pat_token) = user(&pool, "Pat@Example.com").await;
    let path = format!("/api/admin/users/{pat}/invite");
    assert_eq!(send(&app, Method::POST, &path, Some(&token), None).await.0, StatusCode::NO_CONTENT);
    let invited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE email = 'pat@example.com'").fetch_one(&pool).await.unwrap();
    assert_eq!(invited, 1);
    assert_eq!(send(&app, Method::DELETE, &path, Some(&token), None).await.0, StatusCode::NO_CONTENT);
    let invited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites").fetch_one(&pool).await.unwrap();
    assert_eq!(invited, 0);
    // Withdrawing an invite signs the person out, as it always has.
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&pat_token), None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, Method::POST, "/api/admin/users/no-such-id/invite", Some(&token), None).await.0, StatusCode::NOT_FOUND);
}

// ── deleting an account ────────────────────────────────────────────────────

#[tokio::test]
async fn the_delete_route_needs_the_email_and_spares_admins() {
    let (app, pool) = app().await;
    let (me, token) = admin(&pool, "bryan@example.com").await;
    let (other_admin, _) = admin(&pool, "second@example.com").await;
    let (pat, pat_token) = user(&pool, "pat@example.com").await;
    let del = |id: &str| format!("/api/admin/users/{id}");

    let (status, _) = send(&app, Method::DELETE, &del(&me), Some(&token), Some(json!({"confirm_email": "bryan@example.com"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "not yourself");
    let (status, _) = send(&app, Method::DELETE, &del(&other_admin), Some(&token), Some(json!({"confirm_email": "second@example.com"}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "not another admin");
    let (status, _) = send(&app, Method::DELETE, &del(&pat), Some(&token), Some(json!({"confirm_email": "pat@exampel.com"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a typo doesn't delete");
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&pat_token), None).await.0, StatusCode::OK);

    let (status, report) = send(&app, Method::DELETE, &del(&pat), Some(&token), Some(json!({"confirm_email": " PAT@example.com "}))).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["email"], "pat@example.com");
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&pat_token), None).await.0, StatusCode::UNAUTHORIZED);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?").bind(&pat).fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
    let (status, _) = send(&app, Method::DELETE, &del(&pat), Some(&token), Some(json!({"confirm_email": "pat@example.com"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Every column in the schema that can hold an account id: foreign keys to `users`, and columns
/// whose names say they hold one.
async fn schema_user_columns(pool: &SqlitePool) -> BTreeSet<(String, String)> {
    let fks: Vec<(String, String)> = sqlx::query_as(
        "SELECT m.name, p.\"from\" FROM sqlite_master m, pragma_foreign_key_list(m.name) p
          WHERE m.type = 'table' AND p.\"table\" = 'users'",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let named: Vec<(String, String)> = sqlx::query_as(
        "SELECT m.name, p.name FROM sqlite_master m, pragma_table_info(m.name) p
          WHERE m.type = 'table' AND m.name NOT IN ('users', '_sqlx_migrations') AND m.name NOT LIKE 'sqlite_%'
            AND (p.name IN ('user_id', 'owner_id', 'created_by', 'host_id', 'invited_by', 'account_id')
                 OR p.name LIKE '%\\_user\\_id' ESCAPE '\\' OR p.name LIKE '%\\_owner\\_id' ESCAPE '\\')",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    fks.into_iter().chain(named).collect()
}

#[tokio::test]
async fn every_column_that_can_hold_an_account_is_handled_by_deletion() {
    let pool = crate::db::test_pool().await;
    let schema = schema_user_columns(&pool).await;
    let listed: BTreeSet<(String, String)> = USER_COLUMNS.iter().map(|(t, c)| (t.to_string(), c.to_string())).collect();
    let missing: Vec<_> = schema.difference(&listed).collect();
    let stale: Vec<_> = listed.difference(&schema).collect();
    assert!(
        missing.is_empty() && stale.is_empty(),
        "server/src/admin/delete.rs must handle every column that can hold an account id.\n\
         In the schema but not in USER_COLUMNS (decide what deleting an account does to it, handle it, list it, \
         and add a row for it to the fixture in deleting_an_account_leaves_nothing_of_it): {missing:?}\n\
         In USER_COLUMNS but not in the schema: {stale:?}"
    );
}

// A generic row writer for the deletion fixture: it fills every NOT NULL column without a default
// with a placeholder (the first value of a `CHECK (col IN (...))` list, a number, or a unique
// string), so a new column doesn't break the fixture; columns given in `set` win.

#[derive(Clone)]
enum V {
    T(String),
    I(i64),
    B(Vec<u8>),
    Null,
}

fn t(s: impl Into<String>) -> V {
    V::T(s.into())
}

static SERIAL: AtomicUsize = AtomicUsize::new(0);

/// The first value of `CHECK (col IN ('a', ...))` in a table's SQL, if there is one.
fn check_value(table_sql: &str, col: &str) -> Option<String> {
    let flat: String = table_sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let needle = format!("CHECK ({col} IN ('");
    let at = flat.find(&needle)? + needle.len();
    Some(flat[at..].split('\'').next()?.to_string())
}

/// Insert one row; returns its `id` column when it has one.
async fn fill(pool: &SqlitePool, table: &str, set: &[(&str, V)]) -> String {
    let sql: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).fetch_one(pool).await.unwrap();
    let cols: Vec<(String, String, bool, Option<String>, i64)> =
        sqlx::query_as("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)").bind(table).fetch_all(pool).await.unwrap();
    let mut names = Vec::new();
    let mut values = Vec::new();
    let mut id = String::new();
    for (name, ty, notnull, default, pk) in cols {
        let value = if let Some((_, v)) = set.iter().find(|(c, _)| *c == name) {
            v.clone()
        } else if (notnull && default.is_none() && !(pk == 1 && ty.eq_ignore_ascii_case("INTEGER"))) || (name == "id" && ty.eq_ignore_ascii_case("TEXT")) {
            let n = SERIAL.fetch_add(1, Ordering::SeqCst);
            let upper = ty.to_ascii_uppercase();
            if let Some(v) = check_value(&sql, &name) {
                t(v)
            } else if upper.contains("INT") || upper.contains("REAL") {
                V::I(1)
            } else if upper.contains("BLOB") {
                V::B(vec![0])
            } else if name.ends_with("_at") || name == "at" {
                t(now())
            } else {
                t(format!("{table}-{name}-{n}"))
            }
        } else {
            continue;
        };
        if name == "id"
            && let V::T(s) = &value
        {
            id = s.clone();
        }
        names.push(name);
        values.push(value);
    }
    let marks = vec!["?"; names.len()].join(", ");
    let insert = format!("INSERT INTO {table} ({}) VALUES ({marks})", names.join(", "));
    let mut q = sqlx::query(sqlx::AssertSqlSafe(insert.clone()));
    for v in values {
        q = match v {
            V::T(s) => q.bind(s),
            V::I(i) => q.bind(i),
            V::B(b) => q.bind(b),
            V::Null => q.bind(None::<String>),
        };
    }
    q.execute(pool).await.unwrap_or_else(|e| panic!("{insert}: {e}"));
    id
}

async fn count(pool: &SqlitePool, table: &str, column: &str, id: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?"))).bind(id).fetch_one(pool).await.unwrap()
}

async fn scalar(pool: &SqlitePool, sql: &str, bind: &str) -> Option<String> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(bind).fetch_optional(pool).await.unwrap().flatten()
}

fn seat_json(seat: u8, user: &str, name: &str) -> Value {
    json!({"seat": seat, "kind": "human", "user_id": user, "name": name, "deck_id": null, "deck_version_id": null,
           "deck_name": null, "color_identity": "", "commander": null, "difficulty": null})
}

#[tokio::test]
async fn deleting_an_account_leaves_nothing_of_it() {
    let pool = crate::db::test_pool().await;
    let (v, _) = user(&pool, "victim@example.com").await;
    let (b, _) = user(&pool, "bystander@example.com").await;
    let later = "2099-01-01T00:00:00Z";

    // Invites: its own (removed with it), and one it sent (kept, without its name).
    fill(&pool, "invites", &[("email", t("victim@example.com")), ("invited_by", V::Null)]).await;
    fill(&pool, "invites", &[("email", t("friend@example.com")), ("invited_by", t(&v))]).await;

    // Decks, collection, synced ops.
    let (v_deck, v_version) = deck(&pool, &v, "Victim's deck").await;
    let (b_deck, b_version) = deck(&pool, &b, "Bystander's deck").await;
    fill(&pool, "deck_version_checks", &[("version_id", t(&v_version))]).await;
    let container = fill(&pool, "containers", &[("owner_id", t(&v))]).await;
    fill(&pool, "collection_items", &[("owner_id", t(&v)), ("container_id", t(&container))]).await;
    fill(&pool, "applied_ops", &[("owner_id", t(&v))]).await;
    fill(&pool, "item_aliases", &[("owner_id", t(&v))]).await;

    // Playgroups: one it owns with the bystander in it (passes on), one with only a guest
    // (deleted), and the bystander's with the victim in it (membership becomes a guest).
    let pg_shared = fill(&pool, "playgroups", &[("owner_id", t(&v))]).await;
    let m_v_shared = fill(&pool, "playgroup_members", &[("playgroup_id", t(&pg_shared)), ("user_id", t(&v)), ("created_at", t("2026-01-01T00:00:00Z"))]).await;
    fill(&pool, "playgroup_members", &[("playgroup_id", t(&pg_shared)), ("user_id", t(&b)), ("created_at", t(later))]).await;
    let pg_solo = fill(&pool, "playgroups", &[("owner_id", t(&v))]).await;
    let guest = fill(&pool, "playgroup_members", &[("playgroup_id", t(&pg_solo)), ("guest_name", t("Sam"))]).await;
    let pg_b = fill(&pool, "playgroups", &[("owner_id", t(&b))]).await;
    let m_v_in_b = fill(&pool, "playgroup_members", &[("playgroup_id", t(&pg_b)), ("user_id", t(&v))]).await;

    // Games. g1: logged by the victim in the shared group with the bystander seated (kept).
    let game = |created_by: &str, mode: &str, status: &str| {
        vec![("created_by", t(created_by)), ("mode", t(mode)), ("status", t(status))]
    };
    let mut g1_cols = game(&v, "in_person", "finished");
    g1_cols.push(("playgroup_id", t(&pg_shared)));
    let g1 = fill(&pool, "games", &g1_cols).await;
    fill(&pool, "game_seats", &[("game_id", t(&g1)), ("seat", V::I(0)), ("user_id", t(&v)), ("member_id", t(&m_v_shared)), ("deck_version_id", t(&v_version))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g1)), ("seat", V::I(1)), ("user_id", t(&b)), ("deck_version_id", t(&b_version))]).await;
    // g2: logged by the victim, nobody else with an account (deleted, with its events).
    let g2 = fill(&pool, "games", &game(&v, "in_person", "finished")).await;
    fill(&pool, "game_seats", &[("game_id", t(&g2)), ("seat", V::I(0)), ("user_id", t(&v))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g2)), ("seat", V::I(1)), ("guest_name", t("Alex"))]).await;
    fill(&pool, "game_events", &[("game_id", t(&g2))]).await;
    // g3: logged by the bystander with the victim seated on its own deck (kept, seat anonymised).
    let g3 = fill(&pool, "games", &game(&b, "in_person", "finished")).await;
    fill(&pool, "game_seats", &[("game_id", t(&g3)), ("seat", V::I(0)), ("user_id", t(&v)), ("deck_version_id", t(&v_version)), ("commander_name", t("Test Commander"))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g3)), ("seat", V::I(1)), ("user_id", t(&b))]).await;
    // g4: logged by the victim in the guest-only group (deleted with the group).
    let mut g4_cols = game(&v, "in_person", "finished");
    g4_cols.push(("playgroup_id", t(&pg_solo)));
    let g4 = fill(&pool, "games", &g4_cols).await;
    fill(&pool, "game_seats", &[("game_id", t(&g4)), ("seat", V::I(0)), ("member_id", t(&guest))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g4)), ("seat", V::I(1)), ("user_id", t(&v))]).await;
    // g5: an online game the victim hosts, live, with the bystander seated (kept, abandoned).
    let g5 = fill(&pool, "games", &game(&v, "online", "in_progress")).await;
    fill(&pool, "game_seats", &[("game_id", t(&g5)), ("seat", V::I(0)), ("user_id", t(&v))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g5)), ("seat", V::I(1)), ("user_id", t(&b))]).await;
    let seats5 = json!([seat_json(0, &v, "victim"), seat_json(1, &b, "bystander")]).to_string();
    fill(&pool, "online_games", &[("game_id", t(&g5)), ("host_id", t(&v)), ("stage", t("live")), ("seats", t(seats5))]).await;
    // g6: the bystander's finished online game with the victim seated (kept, replay removed).
    let g6 = fill(&pool, "games", &game(&b, "online", "finished")).await;
    fill(&pool, "game_seats", &[("game_id", t(&g6)), ("seat", V::I(0)), ("user_id", t(&b))]).await;
    fill(&pool, "game_seats", &[("game_id", t(&g6)), ("seat", V::I(1)), ("user_id", t(&v))]).await;
    let seats6 = json!([seat_json(0, &b, "bystander"), seat_json(1, &v, "victim")]).to_string();
    fill(&pool, "online_games", &[("game_id", t(&g6)), ("host_id", t(&b)), ("stage", t("over")), ("seats", t(seats6))]).await;

    // Plans.
    fill(&pool, "plan_meta", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_imports", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_settings", &[("owner_id", t(&v))]).await;
    let store = fill(&pool, "plan_stores", &[("owner_id", t(&v))]).await;
    let plan_deck = fill(&pool, "plan_decks", &[("owner_id", t(&v)), ("deck_id", t(&v_deck)), ("base_version_id", t(&v_version))]).await;
    fill(&pool, "plan_states", &[("owner_id", t(&v)), ("plan_deck_id", t(&plan_deck))]).await;
    let order = fill(&pool, "plan_orders", &[("owner_id", t(&v)), ("store_id", t(&store))]).await;
    let item = fill(&pool, "plan_order_items", &[("owner_id", t(&v)), ("order_id", t(&order))]).await;
    let swap = fill(
        &pool,
        "plan_swaps",
        &[("owner_id", t(&v)), ("plan_deck_id", t(&plan_deck)), ("order_item_id", t(&item)), ("print_order_id", t(&order))],
    )
    .await;
    fill(&pool, "plan_quotes", &[("owner_id", t(&v)), ("swap_id", t(&swap)), ("store_id", t(&store))]).await;
    fill(&pool, "plan_key_aliases", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_inputs", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_reviews", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_marks", &[("owner_id", t(&v))]).await;
    fill(&pool, "plan_meta", &[("owner_id", t(&b))]).await;

    // Keys, watches, the lab and the advisor.
    fill(&pool, "api_tokens", &[("owner_id", t(&v))]).await;
    let client = fill(&pool, "oauth_clients", &[]).await;
    let grant = fill(&pool, "oauth_grants", &[("user_id", t(&v)), ("client_id", t(&client))]).await;
    fill(&pool, "oauth_tokens", &[("grant_id", t(&grant))]).await;
    fill(&pool, "oauth_codes", &[("user_id", t(&v)), ("client_id", t(&client)), ("grant_id", t(&grant))]).await;
    fill(&pool, "calendar_watches", &[("user_id", t(&v))]).await;
    let run = fill(&pool, "lab_runs", &[("owner_id", t(&v))]).await;
    fill(&pool, "lab_ratings", &[("run_id", t(&run))]).await;
    let global_run = fill(&pool, "lab_runs", &[("owner_id", V::Null)]).await;
    let experiment = fill(&pool, "lab_experiments", &[("owner_id", t(&v))]).await;
    fill(&pool, "lab_experiment_games", &[("experiment_id", t(&experiment))]).await;
    fill(&pool, "lab_usage", &[("owner_id", t(&v)), ("experiment_id", t(&experiment))]).await;
    fill(&pool, "advisor_keys", &[("user_id", t(&v))]).await;
    fill(&pool, "advisor_settings", &[("user_id", t(&v))]).await;
    let conversation = fill(&pool, "advisor_conversations", &[("owner_id", t(&v))]).await;
    fill(&pool, "advisor_messages", &[("owner_id", t(&v)), ("conversation_id", t(&conversation))]).await;
    fill(&pool, "advisor_usage", &[("owner_id", t(&v))]).await;
    // The victim's own shared-key grant (goes), and one it made for the bystander (stays, unsigned).
    fill(&pool, "advisor_shared_access", &[("user_id", t(&v)), ("granted_by", V::Null)]).await;
    fill(&pool, "advisor_shared_access", &[("user_id", t(&b)), ("granted_by", t(&v))]).await;
    // "View as": the bystander (an admin here) viewed the victim, and the victim viewed the bystander.
    fill(&pool, "view_sessions", &[("admin_id", t(&b)), ("target_id", t(&v))]).await;
    fill(&pool, "view_sessions", &[("admin_id", t(&v)), ("target_id", t(&b))]).await;

    // The fixture must reach every column the deletion handles, or this test proves nothing for it.
    let mut bystander_before = Vec::new();
    for (table, column) in USER_COLUMNS {
        assert!(count(&pool, table, column, &v).await > 0, "the fixture has no {table}.{column} row for the victim; add one");
        bystander_before.push(count(&pool, table, column, &b).await);
    }

    let mut tx = pool.begin().await.unwrap();
    let report = delete_rows(&mut tx, &v).await.unwrap();
    tx.commit().await.unwrap();

    // Nothing of the victim's is left anywhere.
    for (table, column) in USER_COLUMNS {
        assert_eq!(count(&pool, table, column, &v).await, 0, "{table}.{column} still names the deleted account");
    }
    let in_seats: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM online_games o, json_each(o.seats) j WHERE json_extract(j.value, '$.user_id') = ?",
    )
    .bind(&v)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(in_seats, 0);
    assert_eq!(count(&pool, "users", "id", &v).await, 0);
    assert_eq!(count(&pool, "invites", "email", "victim@example.com").await, 0);
    assert_eq!(count(&pool, "decks", "id", &v_deck).await, 0);
    assert_eq!(count(&pool, "deck_versions", "id", &v_version).await, 0);
    let seats_on_its_deck: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM game_seats WHERE deck_version_id = ?").bind(&v_version).fetch_one(&pool).await.unwrap();
    assert_eq!(seats_on_its_deck, 0);
    let names: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_seats WHERE guest_name LIKE '%victim%'").fetch_one(&pool).await.unwrap();
    assert_eq!(names, 0);

    // Other people's records still add up.
    assert_eq!(scalar(&pool, "SELECT invited_by FROM invites WHERE email = ?", "friend@example.com").await, None);
    assert_eq!(count(&pool, "invites", "email", "friend@example.com").await, 1);
    assert_eq!(scalar(&pool, "SELECT granted_by FROM advisor_shared_access WHERE user_id = ?", &b).await, None);
    assert_eq!(count(&pool, "advisor_shared_access", "user_id", &b).await, 1);
    assert_eq!(scalar(&pool, "SELECT owner_id FROM playgroups WHERE id = ?", &pg_shared).await, Some(b.clone()));
    assert_eq!(count(&pool, "playgroups", "id", &pg_solo).await, 0);
    assert_eq!(count(&pool, "playgroup_members", "id", &guest).await, 0);
    assert_eq!(scalar(&pool, "SELECT guest_name FROM playgroup_members WHERE id = ?", &m_v_in_b).await.as_deref(), Some("Former member"));
    assert_eq!(scalar(&pool, "SELECT guest_name FROM playgroup_members WHERE id = ?", &m_v_shared).await.as_deref(), Some("Former member"));

    assert_eq!(scalar(&pool, "SELECT created_by FROM games WHERE id = ?", &g1).await, Some(b.clone()));
    assert_eq!(scalar(&pool, "SELECT member_id FROM game_seats WHERE game_id = ? AND seat = 0", &g1).await, Some(m_v_shared.clone()));
    assert_eq!(scalar(&pool, "SELECT deck_version_id FROM game_seats WHERE game_id = ? AND seat = 1", &g1).await, Some(b_version.clone()));
    assert_eq!(count(&pool, "games", "id", &g2).await, 0);
    assert_eq!(count(&pool, "game_events", "game_id", &g2).await, 0);
    assert_eq!(scalar(&pool, "SELECT guest_name FROM game_seats WHERE game_id = ? AND seat = 0", &g3).await.as_deref(), Some("Former player"));
    assert_eq!(scalar(&pool, "SELECT commander_name FROM game_seats WHERE game_id = ? AND seat = 0", &g3).await.as_deref(), Some("Test Commander"));
    assert_eq!(count(&pool, "games", "id", &g4).await, 0);
    assert_eq!(scalar(&pool, "SELECT created_by FROM games WHERE id = ?", &g5).await, Some(b.clone()));
    assert_eq!(scalar(&pool, "SELECT status FROM games WHERE id = ?", &g5).await.as_deref(), Some("abandoned"));
    assert_eq!(count(&pool, "online_games", "game_id", &g5).await, 0);
    assert_eq!(scalar(&pool, "SELECT status FROM games WHERE id = ?", &g6).await.as_deref(), Some("finished"));
    assert_eq!(count(&pool, "online_games", "game_id", &g6).await, 0);
    assert_eq!(count(&pool, "decks", "id", &b_deck).await, 1);
    assert_eq!(count(&pool, "lab_runs", "id", &global_run).await, 1);
    for ((table, column), before) in USER_COLUMNS.iter().zip(bystander_before) {
        let after = count(&pool, table, column, &b).await;
        // The one deliberate loss: the bystander's online game the victim sat in loses its replay
        // and log (they name the victim); the game's result stays (g6 above).
        // Likewise the audit rows of views between the two accounts go with the victim.
        let expected = match (*table, *column) {
            ("online_games", "host_id") | ("view_sessions", "admin_id") | ("view_sessions", "target_id") => before - 1,
            _ => before,
        };
        assert!(after >= expected, "the bystander lost {table}.{column} rows ({before} before, {after} after)");
    }

    assert_eq!(report.playgroups_passed_on, 1);
    assert_eq!(report.playgroups_deleted, 1);
    assert_eq!(report.games_kept, 2, "{report:?}");
    assert_eq!(report.games_deleted, 2, "{report:?}");
    assert_eq!(report.online_games_removed, 2, "{report:?}");
    assert!(report.rows_deleted >= 25, "{report:?}");
}
