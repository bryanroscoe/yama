use super::*;
use crate::testutil;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request};
use serde_json::json;
use tower::ServiceExt;

const PRIVATE: &str = "private-sentinel-DoNotPublish";

async fn fixture() -> (AppState, tempfile::TempDir, String) {
    let mut cfg = testutil::config();
    cfg.public_url = Some("https://yama.saget.org".into());
    let st = testutil::state_with(cfg, crate::db::test_pool().await).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("precons")).unwrap();
    let mut index = Vec::new();
    for (slug, name, color) in [
        ("forest-deck", "Forest <Deck>", "G"),
        ("island-deck", "Island Deck", "U"),
    ] {
        let cards = json!([
            {"name":"Commander", "oracle_id":"commander", "qty":1, "board":"commander"},
            {"name":"Forest", "oracle_id":"forest", "qty":99, "board":"main"}
        ]);
        sqlx::query("INSERT INTO precons(id, lab_id, name, set_code, set_name, released, commanders, color_identity, cards, source, content_sha256, imported_at, notes, engine_support, playgroup) VALUES (?,?,?,'CMD','Commander','2026-01-01','[\"Commander\"]',?, ?,?, 'original','2026-10-27T00:00:00Z', ?, ?, ?)")
            .bind(slug).bind(format!("precons/{slug}")).bind(name).bind(color).bind(cards.to_string())
            .bind(format!("MTGJSON https://mtgjson.com/api/v5/decks/Test_CMD.json, via /Users/{PRIVATE}"))
            .bind(json!([PRIVATE]).to_string())
            .bind(json!({"partly_unimplemented":["Forest", PRIVATE], "internal":PRIVATE}).to_string())
            .bind(json!({"win_rate_4p":24.2,"games":50,"rank":1,"of":2,"url":"javascript:alert(1)","source":PRIVATE,"fetched":"2026-10-25","method":PRIVATE,"owner":PRIVATE}).to_string())
            .execute(&st.pool).await.unwrap();
        std::fs::write(
            dir.path().join(format!("precons/{slug}.txt")),
            "Commander\n1 Commander\n\nDeck\n99 Forest\n",
        )
        .unwrap();
        index.push(
            json!({"id":format!("precons/{slug}"),"kind":"precon","commanders":["Commander"]}),
        );
    }
    std::fs::write(
        dir.path().join("index.json"),
        json!({"generated":"2026-10-26","decks":index}).to_string(),
    )
    .unwrap();
    sqlx::query("INSERT INTO cards(oracle_id,name,type_line,color_identity,legalities,image_art_crop,image_normal,artist,updated_at) VALUES ('commander','Commander','Legendary Creature','G','{}','https://cards.scryfall.io/art/commander.webp','https://cards.scryfall.io/normal/commander.webp','Test Artist','now'), ('forest','Forest','Basic Land','G','{}',NULL,'javascript:alert(1)',NULL,'now')").execute(&st.pool).await.unwrap();
    let (_, token) = testutil::user(&st.pool, "person@example.com").await;
    let (owner, _) = testutil::user(&st.pool, "private@example.com").await;
    testutil::deck(&st.pool, &owner, PRIVATE).await;
    let raw = summary();
    sqlx::query("INSERT INTO lab_runs(id,owner_id,name,kind,engine,card_data,runner,difficulty,games,created_at,analysed_at,imported_at,summary,summary_sha256) VALUES ('global',NULL,?,'precon-ratings','phase-rs v0.113.0','abcdef','runner-1','Easy',40,'2026-10-26T00:00:00Z','2026-10-27T00:00:00Z','2026-10-27T00:00:00Z',?,'hash')")
        .bind(PRIVATE).bind(raw.to_string()).execute(&st.pool).await.unwrap();
    sqlx::query("INSERT INTO lab_runs(id,owner_id,name,kind,engine,card_data,runner,difficulty,games,created_at,analysed_at,imported_at,summary,summary_sha256) SELECT 'owned',?,name,kind,engine,card_data,runner,difficulty,games,created_at,analysed_at,imported_at,summary,summary_sha256 FROM lab_runs WHERE id='global'")
        .bind(owner).execute(&st.pool).await.unwrap();
    (st, dir, token)
}

fn summary() -> Value {
    json!({
        "run":PRIVATE, "warnings":[PRIVATE], "notes":[PRIVATE],
        "inputs":{"index":"2026-10-26","path":PRIVATE},
        "run_meta":{"pod":4,"filter":{"ids":[]}},
        "versions":{"engine":{"phase-rs v0.113.0":40},"card_data":{"abcdef":40},"runner":{"runner-1":40}},
        "analysis":{"model":MODEL,"time_caps_scored":false,"drop_capped":false,"bootstrap":{"level":0.9,"cluster":"game"}},
        "counts":{"games_in_model":40,"failed_games":2,"unscored_time_caps":1,"by_pod_size":{"4":40},"by_end":{"draw":3,"action_cap":1}},
        "decks":[
            {"id":"precons/forest-deck","kind":"precon","commanders":["Commander"],"games":40,"rank":1,"rank_ci":[1,2],"strength":1.3,"strength_ci":[0.9,1.6],"p4_field":0.35,"p4_field_ci":[0.2,0.5],"main":{"win_rate":0.4,"wilson":[0.2,0.6]},"confidence":{"level":"unreliable","reasons":[PRIVATE]}},
            {"id":"precons/island-deck","kind":"precon","commanders":["Commander"],"games":40,"rank":2,"rank_ci":[1,2],"strength":0.7,"p4_field":0.15,"p4_field_ci":[0.1,0.2],"confidence":{"level":"ok","reasons":[PRIVATE]}}
        ],
        "matrix":{"ids":["precons/forest-deck","precons/island-deck"],"p":[[0.5,0.8],[0.2,0.5]],"note":PRIVATE}
    })
}

fn manifest() -> Manifest {
    Manifest {
        run_id: "global".into(),
        stock_index: "index.json".into(),
        title: "Reviewed benchmark".into(),
        engine: "phase-rs v0.113.0".into(),
        card_data: "abcdef".into(),
        runner: "runner-1".into(),
        difficulty: "Easy".into(),
        notes: vec!["Public reviewed note".into()],
        reasons: BTreeMap::new(),
    }
}

async fn request(
    app: &Router,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, String) {
    let mut req = Request::builder().uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let text = String::from_utf8(
        to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    (status, headers, text)
}

#[tokio::test]
async fn anonymous_catalog_is_independent_of_unpublished_and_private_runs() {
    let (st, _, token) = fixture().await;
    let app = crate::routes::app(st.clone());
    for path in [
        "/api/public/precons",
        "/api/public/precons/forest-deck",
        "/precons",
        "/precons/forest-deck",
        "/precons/methodology",
    ] {
        let (status, h, body) = request(&app, path, &[]).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(!body.contains(PRIVATE), "{path}");
        assert!(!body.contains("javascript:"), "{path}");
        assert!(!h.contains_key(header::SET_COOKIE));
        let signed = request(
            &app,
            path,
            &[
                ("authorization", &format!("Bearer {token}")),
                ("cookie", "yama_view=stale"),
            ],
        )
        .await;
        assert_eq!(body, signed.2, "{path}");
        assert!(!signed.1.contains_key(header::SET_COOKIE), "{path}");
    }
    let (_, _, json) = request(&app, "/api/public/precons", &[]).await;
    let json: Value = serde_json::from_str(&json).unwrap();
    assert!(json["publication"].is_null());
    assert!(json["precons"][0]["rating"].is_null());
    assert_eq!(json["precons"][0]["real_games"]["source"], "Playgroup.gg");
    assert!(json["precons"][0]["singles_value"]["usd"].is_null());
    // Even a malformed latest summary cannot break the public stock catalog.
    sqlx::query("UPDATE lab_runs SET summary='not JSON' WHERE id='global'")
        .execute(&st.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "/api/public/precons", &[]).await.0,
        StatusCode::OK
    );
    for path in [
        "/api/precons",
        "/api/lab/runs",
        "/api/lab/runs/global",
        "/api/decks",
        "/api/collection",
        "/api/plan/bundle",
    ] {
        assert_eq!(
            request(&app, path, &[]).await.0,
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
    for path in ["/api/precons/forest-deck/deck", "/api/lab/experiments"] {
        let (status, _) = testutil::send(&app, Method::POST, path, None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn publication_is_an_immutable_public_projection_and_withdrawal_revalidates_caches() {
    let (st, dir, _) = fixture().await;
    let id = publish(&st.pool, manifest(), dir.path()).await.unwrap();
    let app = crate::routes::app(st.clone());
    let (_, headers, before) = request(&app, "/api/public/precons", &[]).await;
    assert!(!before.contains(PRIVATE));
    let value: Value = serde_json::from_str(&before).unwrap();
    assert_eq!(value["publication"]["id"], id);
    assert_eq!(
        value["precons"][0]["id"], "island-deck",
        "known unreliable deck is outside trusted ordering"
    );
    let etag = headers[header::ETAG].to_str().unwrap();
    let cached = request(&app, "/api/public/precons", &[("if-none-match", etag)]).await;
    assert_eq!(cached.0, StatusCode::NOT_MODIFIED);
    assert!(cached.2.is_empty());
    assert!(
        headers[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .starts_with("public,")
    );
    // Global imports can overwrite runs in place; published results are copied, not live joins.
    sqlx::query(
        "UPDATE lab_runs SET summary = ?, games = 999, engine = 'changed' WHERE id='global'",
    )
    .bind(json!({"private":PRIVATE}).to_string())
    .execute(&st.pool)
    .await
    .unwrap();
    assert_eq!(request(&app, "/api/public/precons", &[]).await.2, before);
    sqlx::query("DELETE FROM lab_runs WHERE id='global'")
        .execute(&st.pool)
        .await
        .unwrap();
    assert_eq!(request(&app, "/api/public/precons", &[]).await.2, before);
    withdraw(&st.pool).await.unwrap();
    let after = request(&app, "/api/public/precons", &[("if-none-match", etag)]).await;
    assert_eq!(after.0, StatusCode::OK);
    assert!(!after.2.contains("Reviewed benchmark"));
    assert_eq!(
        serde_json::from_str::<Value>(&after.2).unwrap()["precons"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn changed_stock_loses_its_old_rating_and_new_decks_are_unrated() {
    let (st, dir, _) = fixture().await;
    publish(&st.pool, manifest(), dir.path()).await.unwrap();
    sqlx::query(
        "UPDATE precons SET cards = replace(cards, 'Forest', 'Island') WHERE id='forest-deck'",
    )
    .execute(&st.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,commanders,cards,source,content_sha256,imported_at) SELECT 'new-deck','precons/new-deck','New deck',set_code,commanders,cards,source,content_sha256,imported_at FROM precons WHERE id='island-deck'").execute(&st.pool).await.unwrap();
    let data = catalog(&st.pool).await.unwrap();
    let changed = data.precons.iter().find(|p| p.id == "forest-deck").unwrap();
    assert!(changed.rating.is_none());
    assert_eq!(changed.rating_status, "stock_list_changed");
    let added = data.precons.iter().find(|p| p.id == "new-deck").unwrap();
    assert!(added.rating.is_none());
    assert_eq!(added.rating_status, "not_rated");
}

#[tokio::test]
async fn owned_mixed_forged_or_inconsistent_fields_cannot_be_published() {
    let (st, dir, _) = fixture().await;
    let id = publish(&st.pool, manifest(), dir.path()).await.unwrap();
    let mut owned = manifest();
    owned.run_id = "owned".into();
    assert!(
        publish(&st.pool, owned, dir.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("stay private")
    );
    for altered in [
        {
            let mut v = summary();
            v["matrix"]["ids"][1] = json!("private/deck");
            v
        },
        {
            let mut v = summary();
            v["decks"][1]["id"] = json!("precons/not-in-catalog");
            v
        },
        {
            let mut v = summary();
            v["decks"][1]["kind"] = json!("personal");
            v
        },
        {
            let mut v = summary();
            v["run_meta"]["filter"]["ids"] = json!(["private/deck"]);
            v
        },
        {
            let mut v = summary();
            v["inputs"]["index"] = json!("different-date");
            v
        },
        {
            let mut v = summary();
            v["counts"]["deck_mismatch_with_schedule"] = json!(1);
            v
        },
        {
            let mut v = summary();
            v["versions"]["engine"]["second-build"] = json!(2);
            v
        },
        {
            let mut v = summary();
            v["analysis"]["time_caps_scored"] = json!(true);
            v
        },
        {
            let mut v = summary();
            v["analysis"]["drop_capped"] = json!(true);
            v
        },
        {
            let mut v = summary();
            v["counts"]["by_pod_size"]["2"] = json!(10);
            v
        },
    ] {
        sqlx::query("UPDATE lab_runs SET summary=? WHERE id='global'")
            .bind(altered.to_string())
            .execute(&st.pool)
            .await
            .unwrap();
        assert!(publish(&st.pool, manifest(), dir.path()).await.is_err());
        let head: String = sqlx::query_scalar("SELECT publication_id FROM precon_publication_head")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(head, id);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM precon_publications")
        .fetch_one(&st.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn original_stock_lists_and_reviewed_version_labels_are_required() {
    let (st, dir, _) = fixture().await;
    let mut m = manifest();
    m.engine = "made up".into();
    assert!(
        publish(&st.pool, m, dir.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("exactly match")
    );
    std::fs::write(
        dir.path().join("precons/forest-deck.txt"),
        "Commander\n1 Commander\nDeck\n99 Island\n",
    )
    .unwrap();
    assert!(
        publish(&st.pool, manifest(), dir.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("differs")
    );
}

#[tokio::test]
async fn public_html_is_complete_escaped_and_links_only_public_catalog_in_sitemap() {
    let (st, dir, _) = fixture().await;
    let mut m = manifest();
    m.notes = vec!["A <script>alert('x')</script> reviewed note".into()];
    publish(&st.pool, m, dir.path()).await.unwrap();
    let app = crate::routes::app(st);
    let (_, headers, html) = request(&app, "/precons/forest-deck", &[]).await;
    assert!(html.contains("Forest &lt;Deck&gt;"));
    assert!(html.contains("Art by Test Artist"));
    assert!(html.contains("All rights reserved"));
    assert!(html.contains("Third-party content belongs"));
    assert!(html.contains("/precons/forest-deck/decklist.txt"));
    assert!(html.contains("https://yama.saget.org/precons/forest-deck"));
    assert!(!html.contains("<script"));
    assert!(!html.contains(PRIVATE));
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
    let (_, _, method) = request(&app, "/precons/methodology", &[]).await;
    assert!(method.contains("&lt;script&gt;"));
    let (status, h, text) = request(&app, "/precons/forest-deck/decklist.txt", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(h.contains_key(header::CONTENT_DISPOSITION));
    assert!(text.contains("Commander\n1 Commander\n"));
    assert!(text.contains("99 Forest"));
    let (_, _, xml) = request(&app, "/sitemap.xml", &[]).await;
    assert!(xml.contains("/precons/forest-deck"));
    assert!(!xml.contains("/decks/"));
    assert!(!xml.contains(PRIVATE));
    for path in ["/precons/no-such-deck", "/api/public/precons/no-such-deck"] {
        assert_eq!(request(&app, path, &[]).await.0, StatusCode::NOT_FOUND);
    }
    assert_eq!(
        request(&app, "/precons/style.css", &[]).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn filtering_handles_colors_names_years_and_unknown_prices() {
    let (st, _, _) = fixture().await;
    let app = crate::routes::app(st);
    for query in [
        "c=g&m=exact",
        "c=GU&m=within&q=Forest",
        "y=2026&q=Forest",
        "set=cmd&q=Forest",
    ] {
        let (_, _, body) = request(&app, &format!("/api/public/precons?{query}"), &[]).await;
        let rows: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(rows["precons"].as_array().unwrap().len(), 1, "{query}");
        assert_eq!(rows["precons"][0]["id"], "forest-deck");
    }
    assert_eq!(
        request(&app, "/api/public/precons?c=Z", &[]).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, _, html) = request(&app, "/precons?q=nothing", &[]).await;
    assert!(html.contains("No precons match"));
}

#[tokio::test]
async fn public_reads_have_per_address_limits_and_no_account_exemption() {
    let (st, _, token) = fixture().await;
    for _ in 0..120 {
        st.limits.public_precons.check("unknown").unwrap();
    }
    let app = crate::routes::app(st);
    let (status, headers, _) = request(
        &app,
        "/api/public/precons",
        &[("authorization", &format!("Bearer {token}"))],
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key(header::RETRY_AFTER));
    assert!(!headers.contains_key(header::CACHE_CONTROL));
}
