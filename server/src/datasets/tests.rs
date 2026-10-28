use super::*;
use crate::testutil::{app, send, user};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use tower::ServiceExt;

fn observation(id: &str, month: u32, value: f64) -> Value {
    let start = NaiveDate::from_ymd_opt(2026, month, 1).unwrap();
    let end = NaiveDate::from_ymd_opt(2026, month + 1, 1)
        .unwrap()
        .pred_opt()
        .unwrap();
    json!({"id":id,"kind":"performance","entity":"playgroup:commander:1","sources":["a".repeat(64)],"data":{
        "entity_id":"playgroup:commander:1","entity_name":"Test Commander","entity_kind":"commander",
        "metric":"source_reported_normalized_4p_win_rate_percent","value":value,"source_reported_games":100,
        "cohort":"same-monthly-cohort","observation_period":{"kind":"calendar_month","start":start,"end":end},"quality_flags":[]}})
}
fn document() -> Value {
    json!({"schema":"yama-dataset/1","id":"playgroup-history","title":"Private historical evidence",
        "generated_at":"2026-10-28T00:00:00Z","source":{"name":"Test source","url":"https://example.com/data","attribution":"Test fixture","license":"Private fixture"},
        "method":"Frozen source facts; not a performance claim","coverage":{"partial":true},
        "sources":[{"sha256":"a".repeat(64),"url":"https://example.com/data","retrieved_at":"2026-10-28T00:00:00Z","source_as_of":null,"captured_at":null,
            "flags":[],"transformation":null,"original_response_sha256":null}],
        "records":[observation("old",1,10.0),observation("new",7,50.0)]})
}
async fn store(pool: &SqlitePool, owner: &str, doc: &Value) -> Value {
    import(pool, owner, &serde_json::to_vec(doc).unwrap(), false)
        .await
        .unwrap()
}

#[tokio::test]
async fn revisions_are_idempotent_immutable_private_and_old_retries_do_not_rollback() {
    let (app, pool) = app().await;
    let (a, token) = user(&pool, "a@example.com").await;
    let (_, other) = user(&pool, "b@example.com").await;
    let d = document();
    let first = store(&pool, &a, &d).await;
    assert_eq!(first["revision"], 1);
    assert_eq!(first["changed"], true);
    assert_eq!(store(&pool, &a, &d).await["changed"], false);
    let mut changed = d.clone();
    changed["title"] = json!("New source revision");
    assert_eq!(store(&pool, &a, &changed).await["revision"], 2);
    let retried = store(&pool, &a, &d).await;
    assert_eq!(retried["revision"], 1);
    assert_eq!(retried["active_revision"], 2);
    assert_eq!(retried["changed"], false);
    let (status, head) = send(
        &app,
        Method::GET,
        "/api/datasets/playgroup-history",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(head["dataset"]["title"], "New source revision");
    let (_, old) = send(
        &app,
        Method::GET,
        "/api/datasets/playgroup-history?revision=1",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(old["dataset"]["title"], "Private historical evidence");
    for path in [
        "/api/datasets/playgroup-history",
        "/api/datasets/playgroup-history?revision=1",
        "/api/datasets/playgroup-history/export",
    ] {
        assert_eq!(
            send(&app, Method::GET, path, Some(&other), None).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            send(&app, Method::GET, path, None, None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        send(&app, Method::GET, "/api/datasets", Some(&other), None)
            .await
            .1,
        json!([])
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evidence_dataset_records")
            .fetch_one(&pool)
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM games")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM decks")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn admin_upload_binds_owner_and_validates_before_any_write() {
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "admin@example.com").await;
    assert_eq!(
        send(
            &app,
            Method::POST,
            "/api/datasets/import",
            Some(&token),
            Some(document())
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE users SET is_admin=1 WHERE id=?")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let mut bad = document();
    bad["owner_id"] = json!("another-account");
    assert_eq!(
        send(
            &app,
            Method::POST,
            "/api/datasets/import",
            Some(&token),
            Some(bad)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (s, receipt) = send(
        &app,
        Method::POST,
        "/api/datasets/import",
        Some(&token),
        Some(document()),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["revision"], 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM evidence_datasets WHERE owner_id=?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&serde_json::to_vec(&document()).unwrap())
        .unwrap();
    let gz = gz.finish().unwrap();
    for (content_type, body, expected) in [
        (
            "text/plain",
            document().to_string().into_bytes(),
            StatusCode::BAD_REQUEST,
        ),
        ("application/gzip", gz, StatusCode::OK),
    ] {
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/datasets/import")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap();
        let response = app.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM evidence_dataset_revisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "gzip retry must use the same content hash");
}

#[tokio::test]
async fn dry_run_and_rejected_imports_leave_no_partial_data() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    let d = document();
    let r = import(&pool, &owner, &serde_json::to_vec(&d).unwrap(), true)
        .await
        .unwrap();
    assert_eq!(r["dry_run"], true);
    for mutate in 0..6 {
        let mut bad = d.clone();
        match mutate {
            0 => bad["records"][0]["data"]["value"] = json!(101),
            1 => bad["records"][0]["sources"] = json!(["b".repeat(64)]),
            2 => bad["records"][0]["data"]["observation_period"]["end"] = json!("2026-01-30"),
            3 => bad["records"][0]["data"]["entity_id"] = json!("other"),
            4 => bad["records"][1]["id"] = json!("old"),
            _ => bad["source"]["url"] = json!("http://user:secret@example.com"),
        }
        assert!(
            import(&pool, &owner, &serde_json::to_vec(&bad).unwrap(), false)
                .await
                .is_err()
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evidence_datasets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn monthly_weighting_excludes_snapshots_deduplicates_months_and_rejects_conflicts() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    let mut d = document();
    let mut duplicate = d["records"][1].clone();
    duplicate["id"] = json!("duplicate");
    let mut snapshot = observation("snapshot", 7, 99.0);
    snapshot["data"]["source_reported_games"] = json!(999999);
    snapshot["data"]["observation_period"] =
        json!({"kind":"cumulative_snapshot","source_as_of":"2026-07-31T00:00:00Z"});
    d["records"]
        .as_array_mut()
        .unwrap()
        .extend([duplicate, snapshot]);
    store(&pool, &owner, &d).await;
    let query = || ReadQuery {
        entity: Some("playgroup:commander:1".into()),
        as_of: Some(NaiveDate::from_ymd_opt(2026, 7, 31).unwrap()),
        ..Default::default()
    };
    let view = read(&pool, &owner, "playgroup-history", query())
        .await
        .unwrap();
    let s = &view["monthly_summaries"][0];
    assert_eq!(s["months"], 2);
    assert_eq!(s["source_reported_games"], 200);
    assert_eq!(s["half_life_days"], 180);
    assert!((s["weighted_source_rate_percent"].as_f64().unwrap() - 36.7).abs() < 0.1);
    d["records"][2]["data"]["value"] = json!(75.0);
    store(&pool, &owner, &d).await;
    let view = read(&pool, &owner, "playgroup-history", query())
        .await
        .unwrap();
    let s = &view["monthly_summaries"][0];
    assert_eq!(s["months"], 1);
    assert_eq!(s["excluded_months"], 1);
    assert_eq!(s["weighted_source_rate_percent"], 10.0);
}

#[tokio::test]
async fn recency_average_keeps_its_scale_for_old_data_and_short_half_lives() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    store(&pool, &owner, &document()).await;
    for half in [1, 180] {
        let query = |year| ReadQuery {
            entity: Some("playgroup:commander:1".into()),
            as_of: Some(NaiveDate::from_ymd_opt(year, 7, 31).unwrap()),
            half_life_days: Some(half),
            ..Default::default()
        };
        let current = read(&pool, &owner, "playgroup-history", query(2026))
            .await
            .unwrap();
        let historical = read(&pool, &owner, "playgroup-history", query(2036))
            .await
            .unwrap();
        let a = current["monthly_summaries"][0]["weighted_source_rate_percent"]
            .as_f64()
            .unwrap();
        let b = historical["monthly_summaries"][0]["weighted_source_rate_percent"]
            .as_f64()
            .unwrap();
        assert!(
            (a - b).abs() < 1e-10,
            "common decay must cancel even for a one-day half-life"
        );
        assert_eq!(historical["monthly_summaries"][0]["months"], 2);
        assert_eq!(
            historical["monthly_summaries"][0]["source_reported_games"],
            200
        );
    }
}

#[tokio::test]
async fn partial_source_captures_exclude_months_even_without_record_flags() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    let mut d = document();
    d["sources"][0]["flags"] = json!(["partial_archive_capture"]);
    store(&pool, &owner, &d).await;
    let view = read(
        &pool,
        &owner,
        "playgroup-history",
        ReadQuery {
            entity: Some("playgroup:commander:1".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let summary = &view["monthly_summaries"][0];
    assert_eq!(summary["months"], 0);
    assert_eq!(summary["excluded_months"], 2);
    assert!(summary["weighted_source_rate_percent"].is_null());
    assert_eq!(
        view["records"].as_array().unwrap().len(),
        2,
        "excluded evidence remains readable"
    );
}

#[tokio::test]
async fn paging_bounds_provenance_export_and_account_deletion_cover_children() {
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "a@example.com").await;
    let d = document();
    store(&pool, &owner, &d).await;
    let (_, page) = send(
        &app,
        Method::GET,
        "/api/datasets/playgroup-history?limit=1&search=test%20commander",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["next_offset"], 1);
    let (_, sources) = send(
        &app,
        Method::GET,
        "/api/datasets/playgroup-history?section=sources",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(sources["sources"][0]["sha256"], "a".repeat(64));
    for bad in [
        "limit=0",
        "limit=51",
        "offset=-1",
        "half_life_days=0",
        "section=private",
    ] {
        assert_eq!(
            send(
                &app,
                Method::GET,
                &format!("/api/datasets/playgroup-history?{bad}"),
                Some(&token),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let row: Vec<u8> = sqlx::query_scalar("SELECT document_gz FROM evidence_dataset_revisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&decode(&row).unwrap()).unwrap(),
        d
    );
    sqlx::query("DELETE FROM users WHERE id=?")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evidence_dataset_records")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evidence_dataset_revisions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[test]
fn gzip_concatenation_cannot_hide_unvalidated_content() {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(b"not json").unwrap();
    let a = gz.finish().unwrap();
    let mut together = a.clone();
    together.extend_from_slice(&a);
    assert_eq!(decode(&together).unwrap(), b"not jsonnot json");
    assert!(decode(b"\x1f\x8bnot gzip").is_err());
}

#[tokio::test]
async fn mcp_reads_are_owner_scoped_and_never_offer_dataset_import_permissions() {
    let (app, pool) = app().await;
    let (owner, session) = user(&pool, "a@example.com").await;
    let (other, _) = user(&pool, "b@example.com").await;
    sqlx::query("UPDATE users SET is_admin=1 WHERE id=?")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    store(&pool, &owner, &document()).await;
    let (status, key) = send(
        &app,
        Method::POST,
        "/api/me/tokens",
        Some(&session),
        Some(json!({"name":"Dataset test","scope":"mcp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let key = key["token"].as_str().unwrap();
    let a = crate::mcp::QuestionToken::mint(&owner, crate::mcp::Question::default());
    let b = crate::mcp::QuestionToken::mint(&other, crate::mcp::Question::default());
    let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let (status, tools) = send(
        &app,
        Method::POST,
        "/mcp",
        Some(&a.token),
        Some(rpc("tools/list", json!({}))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t["name"] == "dataset" && t["annotations"]["readOnlyHint"] == true)
    );
    assert!(!tools.iter().any(|t| t["name"] == "import_dataset"));
    for (token, failed) in [
        (a.token.as_str(), false),
        (b.token.as_str(), true),
        (key, false),
    ] {
        let (status, r) = send(
            &app,
            Method::POST,
            "/mcp",
            Some(token),
            Some(rpc(
                "tools/call",
                json!({"name":"dataset","arguments":{"id":"playgroup-history"}}),
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{r}");
        assert_eq!(r["result"]["isError"], failed, "{r}");
    }
    assert_eq!(
        send(
            &app,
            Method::POST,
            "/api/datasets/import",
            Some(&a.token),
            Some(document())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(
            &app,
            Method::POST,
            "/api/datasets/import",
            Some(key),
            Some(document())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
#[ignore = "needs YAMA_DATASET_FIXTURE pointing to a recovered canonical gzip bundle"]
async fn recovered_bundle_imports_all_sections_without_duplicate_records() {
    let path = std::env::var("YAMA_DATASET_FIXTURE").expect("YAMA_DATASET_FIXTURE");
    let bytes = decode(&std::fs::read(path).unwrap()).unwrap();
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "fixture@example.com").await;
    let preview = import(&pool, &owner, &bytes, true).await.unwrap();
    let first = import(&pool, &owner, &bytes, false).await.unwrap();
    let second = import(&pool, &owner, &bytes, false).await.unwrap();
    assert_eq!(first["records"], preview["records"]);
    assert_eq!(second["changed"], false);
    let expected: u64 = first["records"]
        .as_object()
        .unwrap()
        .values()
        .map(|n| n.as_u64().unwrap())
        .sum();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM evidence_dataset_records")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count as u64, expected);
    assert!(first["records"]["performance"].as_u64().unwrap() > 12000);
    assert!(first["records"]["weekly_activity"].as_u64().unwrap() > 29000);
    assert_eq!(first["records"]["commander_history"], 179);
    let id = first["id"].as_str().unwrap();
    let view = read(
        &pool,
        &owner,
        id,
        ReadQuery {
            entity: Some("playgroup:commander:2978".into()),
            as_of: Some(NaiveDate::from_ymd_opt(2026, 10, 28).unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!view["records"].as_array().unwrap().is_empty());
    let summary = &view["monthly_summaries"][0];
    assert_eq!(summary["months"], 2);
    assert_eq!(summary["source_reported_games"], 436);
    assert!((22.3..24.5).contains(&summary["weighted_source_rate_percent"].as_f64().unwrap()));
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "ok"
    );
    println!("RECOVERED_DATASET_VALIDATED {}", first);
}
