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
        comparisons: Vec::new(),
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
    let result = html.split("<h3>Model win rate</h3>").nth(1).unwrap();
    let (visible, explanation) = result.split_once("<details>").unwrap();
    assert!(visible.contains("Engine caution"));
    assert!(visible.contains("40 games"));
    assert!(visible.contains("Analysed"));
    assert!(!visible.contains("Rank range"));
    assert!(explanation.starts_with("<summary>Result details &amp; limitations</summary>"));
    assert!(
        explanation
            .split("</details>")
            .next()
            .unwrap()
            .contains("Rank range")
    );
    assert!(!result.starts_with("<details open"));

    assert!(html.contains("All rights reserved"));
    assert!(html.contains("Third-party content belongs"));
    assert!(html.contains("/precons/forest-deck/decklist.txt"));
    assert!(html.contains("https://yama.saget.org/precons/forest-deck"));
    assert!(!html.contains("<script>alert"));
    assert!(html.contains("<script defer src=\"/card-preview-v1.js\"></script>"));
    assert!(html.contains("data-card-name=\"Commander\""));
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
    assert!(xml.contains("/docs/mcp/"));
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
    assert!(html.contains("No matching precons"));
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

#[tokio::test]
async fn consensus_uses_one_common_cohort_keeps_warnings_and_does_not_change_with_filters() {
    let (st, _, _) = fixture().await;
    let mut rows = Vec::new();
    for (i, (real, strength)) in [(10., 1.), (20., 2.), (30., 3.), (40., 4.), (50., 5.)]
        .into_iter()
        .enumerate()
    {
        let mut p = catalog(&st.pool).await.unwrap().precons.remove(0);
        p.id = format!("deck-{i}");
        p.real_games.as_mut().unwrap().win_rate_4p = real;
        let mut r: Rating = serde_json::from_value(json!({"games":40,"rank":1,"rank_interval":null,"strength":strength,"strength_interval":null,"model_win_rate":0.3,"model_interval":null,"observed_win_rate":null,"observed_interval":null,"confidence":"unreliable","reasons":["warning"]})).unwrap();
        if i == 4 {
            r.games = 19;
        } // Missing adequate evidence does not become a bad score.
        let mut opposite = r.clone();
        opposite.strength = Some(6.0 - strength);
        p.simulations = vec![
            Simulation {
                publication_id: "phase".into(),
                engine: "phase-rs v1".into(),
                rating: r.clone(),
            },
            Simulation {
                publication_id: "forge".into(),
                engine: "forge 2".into(),
                rating: opposite,
            },
        ];
        rows.push(p);
    }
    assert_eq!(consensus::assign(&mut rows, 2), 4);
    assert_eq!(rows[0].meta.as_ref().unwrap().score, 25.);
    assert_eq!(rows[3].meta.as_ref().unwrap().score, 75.);
    assert_eq!(rows[3].meta.as_ref().unwrap().rank, 1);
    assert!(rows[3].meta.as_ref().unwrap().flagged);
    assert_eq!(rows[3].meta.as_ref().unwrap().components.len(), 2);
    assert!(rows[4].meta.is_none());
    Filters {
        q: "Forest".into(),
        ..Default::default()
    }
    .apply(&mut rows)
    .unwrap();
    assert_eq!(rows[0].meta.as_ref().unwrap().cohort, 4);
    assert_eq!(rows[0].meta.as_ref().unwrap().score, 75.);
}

#[tokio::test]
async fn multiple_engines_publish_atomically_and_private_or_duplicate_engines_are_rejected() {
    let (st, dir, _) = fixture().await;
    let original = publish(&st.pool, manifest(), dir.path()).await.unwrap();
    let mut forge = summary();
    forge["versions"] = json!({"engine":{"forge 2.0.15":40},"card_data":{"forge cards":40},"runner":{"forge-runner":40}});
    sqlx::query("INSERT INTO lab_runs(id,owner_id,name,kind,engine,card_data,runner,difficulty,games,created_at,analysed_at,imported_at,summary,summary_sha256) SELECT 'forge',NULL,'Reviewed Forge fixture',kind,'forge 2.0.15','forge cards','forge-runner',difficulty,games,created_at,analysed_at,imported_at,?,'hash' FROM lab_runs WHERE id='global'")
        .bind(forge.to_string()).execute(&st.pool).await.unwrap();
    let other = json!({"run_id":"forge","stock_index":"index.json","title":"Reviewed Forge","engine":"forge 2.0.15","card_data":"forge cards","runner":"forge-runner","difficulty":"Easy"});
    std::fs::write(dir.path().join("forge.json"), other.to_string()).unwrap();
    let mut m = manifest();
    m.comparisons = vec!["forge.json".into()];
    publish(&st.pool, m, dir.path()).await.unwrap();
    let data = catalog(&st.pool).await.unwrap();
    assert_eq!(data.comparisons.len(), 1);
    assert!(data.precons.iter().all(|p| p.simulations.len() == 2));
    let published = data.publication.unwrap().id;
    assert_ne!(original, published);
    // A later import cannot mutate either frozen source.
    sqlx::query("DELETE FROM lab_runs WHERE id='forge'")
        .execute(&st.pool)
        .await
        .unwrap();
    assert_eq!(
        catalog(&st.pool).await.unwrap().precons[0]
            .simulations
            .len(),
        2
    );
    let mut invalid = other;
    invalid["run_id"] = json!("owned");
    std::fs::write(dir.path().join("forge.json"), invalid.to_string()).unwrap();
    let mut m = manifest();
    m.comparisons = vec!["forge.json".into()];
    assert!(publish(&st.pool, m, dir.path()).await.is_err());
    assert_eq!(
        catalog(&st.pool).await.unwrap().publication.unwrap().id,
        published
    );
    let duplicate = json!({"run_id":"global","stock_index":"index.json","title":"Duplicate Phase","engine":"phase-rs v0.113.0","card_data":"abcdef","runner":"runner-1","difficulty":"Easy"});
    std::fs::write(dir.path().join("forge.json"), duplicate.to_string()).unwrap();
    let mut m = manifest();
    m.comparisons = vec!["forge.json".into()];
    assert!(
        publish(&st.pool, m, dir.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("one reviewed run")
    );
    assert_eq!(
        catalog(&st.pool).await.unwrap().publication.unwrap().id,
        published
    );
    withdraw(&st.pool).await.unwrap();
    let data = catalog(&st.pool).await.unwrap();
    assert!(data.comparisons.is_empty());
    assert!(
        data.precons
            .iter()
            .all(|p| p.simulations.is_empty() && p.meta.is_none())
    );
}

#[tokio::test]
async fn html_pagination_preserves_encoded_filters_and_clamps_large_pages() {
    let (st, _, _) = fixture().await;
    for i in 0..26 {
        sqlx::query("INSERT INTO precons(id,lab_id,name,set_code,set_name,released,commanders,color_identity,cards,source,content_sha256,imported_at) SELECT ?,?,?,'CMD',set_name,released,commanders,color_identity,cards,source,content_sha256,imported_at FROM precons WHERE id='forest-deck'")
            .bind(format!("fleet-{i:02}")).bind(format!("precons/fleet-{i:02}")).bind(format!("Fleet & {i:02}")).execute(&st.pool).await.unwrap();
    }
    let app = crate::routes::app(st);
    let (_, _, first) = request(&app, "/precons?q=Fleet%20%26&c=G&m=exact&s=name", &[]).await;
    assert_eq!(first.matches("class=\"deck-link\"").count(), 24);
    assert!(first.contains("q=Fleet+%26&amp;c=G&amp;m=exact&amp;s=name&amp;page=2"));
    assert!(first.contains("Fleet &amp; 00"));
    assert!(!first.contains("Fleet &amp; 25"));
    let (_, _, last) = request(
        &app,
        "/precons?q=Fleet%20%26&c=G&m=exact&s=name&page=999999",
        &[],
    )
    .await;
    assert_eq!(last.matches("class=\"deck-link\"").count(), 2);
    assert!(last.contains("Fleet &amp; 25"));
    assert!(last.contains("Page 2 of 2"));
    assert!(!last.contains("Fleet &amp; 00"));
    // public-list-v1.js swaps and extends #results: the count, the rows and the Next link
    // all sit inside it, and the form says it can be filtered live.
    assert!(first.contains(&format!("<script defer src=\"{}\"></script>", html::list_script().1)));
    assert!(first.contains("action=\"/precons\" data-live"));
    let results = first.split("<div id=\"results\" data-matched=\"26\">").nth(1).expect("results container");
    assert!(results.starts_with("<p class=\"table-note\">26 of "));
    assert!(results.contains("</div></nav></div></main>"));
    assert!(results.split("</main>").next().unwrap().contains("rel=\"next\""));
    let (_, _, none) = request(&app, "/precons?q=nothing-matches", &[]).await;
    assert!(none.contains("<div id=\"results\" data-matched=\"0\"><p class=\"table-note\">"));
    assert!(none.contains("No matching precons"));
}

#[tokio::test]
async fn a_missing_interval_is_not_drawn_as_zero_uncertainty() {
    let (st, dir, _) = fixture().await;
    let mut raw = summary();
    raw["decks"][0]["p4_field_ci"] = Value::Null;
    sqlx::query("UPDATE lab_runs SET summary=? WHERE id='global'")
        .bind(raw.to_string())
        .execute(&st.pool)
        .await
        .unwrap();
    publish(&st.pool, manifest(), dir.path()).await.unwrap();
    let app = crate::routes::app(st);
    let (_, _, html) = request(&app, "/precons/forest-deck", &[]).await;
    assert!(html.contains("Interval unavailable"));
    assert!(!html.contains("class=\"interval\""));
}

#[tokio::test]
async fn changed_layout_bypasses_a_still_fresh_legacy_stylesheet_cache() {
    let (st, _, _) = fixture().await;
    let app = crate::routes::app(st);
    // Reproduce a returning visitor whose browser still considers the old URL fresh.
    // Cloudflare's browser TTL is longer than the HTML TTL, so no HTTP request for
    // that URL would be made. New markup must select a different cache key.
    let old = "/* previous release */ .public-run { padding: 24px; }";
    let mut browser_cache = BTreeMap::from([("/precons/style.css".to_string(), old.to_string())]);
    let mut selected = String::new();
    for page in ["/precons", "/precons/forest-deck", "/precons/methodology"] {
        let (status, _, html) = request(&app, page, &[]).await;
        assert_eq!(status, StatusCode::OK);
        let path = html
            .split_once("<link rel=\"stylesheet\" href=\"")
            .unwrap()
            .1
            .split_once('"')
            .unwrap()
            .0;
        assert_ne!(path, "/precons/style.css");
        if selected.is_empty() {
            selected = path.to_string();
        }
        assert_eq!(
            selected, path,
            "all public pages use the same stylesheet version"
        );
    }
    assert!(!browser_cache.contains_key(&selected));
    let (status, headers, css) = request(&app, &selected, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let digest = sha256_hex(&css);
    assert_eq!(
        selected,
        format!("/precons/assets/style-{digest}.css"),
        "hash includes both shared tokens and public layout rules"
    );
    assert_eq!(headers[header::CONTENT_TYPE], "text/css; charset=utf-8");
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert!(css.contains(".public-hero") && css.contains("@font-face"));
    assert!(css.contains("--display:"));
    browser_cache.insert(selected.clone(), css.clone());
    assert_eq!(
        browser_cache["/precons/style.css"], old,
        "no cache clearing is required"
    );
    let (_, _, legacy) = request(&app, "/precons/style.css", &[]).await;
    assert_eq!(legacy, css, "existing stylesheet links remain readable");
    let etag = headers[header::ETAG].to_str().unwrap();
    let (status, headers, body) = request(&app, &selected, &[("if-none-match", etag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    let bad = format!("/precons/assets/style-{}.css", "0".repeat(64));
    assert_eq!(request(&app, &bad, &[]).await.0, StatusCode::NOT_FOUND);

    // The live-list script is content-addressed the same way: Cloudflare once cached the app
    // shell under the fixed /public-list-v1.js before that file was deployed.
    let (_, _, page) = request(&app, "/precons", &[]).await;
    let script = page.split("<script defer src=\"/precons/assets/list-").nth(1).and_then(|s| s.split('"').next()).expect("hashed list script");
    let (status, headers, js) = request(&app, &format!("/precons/assets/list-{script}"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(script, format!("{}.js", sha256_hex(&js)));
    assert_eq!(headers[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert!(js.contains("form.public-filters[data-live]"));
    let bad = format!("/precons/assets/list-{}.js", "0".repeat(64));
    assert_eq!(request(&app, &bad, &[]).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rating_v2_ranks_the_public_pages_once_a_real_game_source_is_enabled() {
    let (st, dir, _) = fixture().await;
    publish(&st.pool, manifest(), dir.path()).await.unwrap();
    let (owner, _) = testutil::user(&st.pool, "bryan@example.com").await;
    let sha = "a".repeat(64);
    let snapshot = |day: &str, games: u64, rate: f64| {
        json!({"id":format!("island-{day}"),"kind":"performance","entity":"playgroup:precon:island-deck","sources":[sha],"data":{
            "entity_id":"playgroup:precon:island-deck","entity_name":"Island Deck","entity_kind":"precon",
            "metric":"source_reported_normalized_4p_win_rate_percent","value":rate,"source_reported_games":games,
            "cohort":"https://playgroup.gg/commander/precons","source_entity_url":"https://playgroup.gg/sets/cmd/precons/island-deck",
            "observation_period":{"kind":"cumulative_snapshot","source_as_of":format!("{day}T16:00:00Z"),"start":null},"quality_flags":[]}})
    };
    let doc = json!({"schema":"yama-dataset/1","id":"playgroup-history","title":"Playgroup history","generated_at":"2026-10-28T00:00:00Z",
        "source":{"name":"Playgroup.gg","url":"https://playgroup.gg/research","attribution":"Playgroup.gg / Arcane Digital B.V. <script>x</script>","license":"CC BY 4.0"},
        "method":"Recovered dated aggregate snapshots","coverage":{},
        "sources":[{"sha256":sha,"url":"https://playgroup.gg/commander/precons","retrieved_at":"2026-10-28T00:00:00Z","source_as_of":null,"captured_at":null,"flags":[],"transformation":null,"original_response_sha256":null}],
        "records":[snapshot("2026-08-06", 263, 23.81), snapshot("2026-09-06", 331, 22.02), snapshot("2026-10-17", 447, 20.47)]});
    crate::datasets::import(&st.pool, &owner, &serde_json::to_vec(&doc).unwrap(), false).await.unwrap();

    // Imported but not chosen: the pages keep meta rank v1.
    let c = catalog(&st.pool).await.unwrap();
    assert!(c.rating_v2.is_none());
    assert!(c.precons.iter().all(|p| p.v2.is_none()));

    crate::precon_evidence::enable(&st.pool, &owner, "Playgroup.gg").await.unwrap();
    let c = catalog(&st.pool).await.unwrap();
    let info = c.rating_v2.as_ref().expect("an enabled source ranks the pages");
    assert_eq!(info.sources[0].license, "CC BY 4.0");
    assert_eq!(info.simulation, None, "the published Phase benchmark doesn't feed rating v2");
    let island = c.precons.iter().find(|p| p.id == "island-deck").unwrap();
    let v = island.v2.as_ref().unwrap();
    let real = v.real.as_ref().unwrap();
    assert_eq!(real.games, 447);
    assert!(real.recent.is_some());
    // With no simulation chosen, real games carry the estimate.
    assert!(!info.gate_passed);
    assert_eq!(v.real_share, 1.0);
    assert_eq!(c.precons[0].id, "island-deck", "the default order follows rating v2");
    assert!(c.precons.iter().all(|p| p.meta.is_none()), "no v1 ranks beside v2");
    assert!(info.sources[0].stock_lists);
    assert!(c.precons.iter().all(|p| p.commander_games.is_empty()), "a stock-list source isn't repeated by commander");

    // Mythic Tools rates commanders, not stock lists: it never changes a precon with stock games.
    let mythic = json!({"schema":"yama-dataset/1","id":"mythic-commander-scores","title":"Mythic Tools commander scores","generated_at":"2026-11-02T00:00:00Z",
        "source":{"name":"Mythic Tools","url":"https://mythic.tools","attribution":"Derived from Mythic Tools' aggregate per-commander game records.","license":"No published terms; derived rates and scores only"},
        "method":"Clean-room derivation","coverage":{},
        "sources":[{"sha256":"b".repeat(64),"url":null,"retrieved_at":"2026-11-02T00:00:00Z","source_as_of":null,"captured_at":null,"flags":[],"transformation":null,"original_response_sha256":null}],
        "records":[
            {"id":"mythic:commander:commander","kind":"commander","entity":"mythic:commander:commander","sources":["b".repeat(64)],"data":{
                "name":"Commander","oracle_ids":["commander"],"score_0_100":65.66,"interval_low":61.65,"interval_high":69.43,
                "games":7984,"decks":3077,"win_rate":0.4435,"baseline":0.36,"prior_strength":100.0,"confidence":"moderate","notes":""}},
            {"id":"mythic:commander:other","kind":"commander","entity":"mythic:commander:other","sources":["b".repeat(64)],"data":{
                "name":"Someone Else","oracle_ids":["commander","other"],"score_0_100":50.0,"interval_low":40.0,"interval_high":60.0,
                "games":10,"decks":5,"win_rate":0.9}}
        ]});
    crate::datasets::import(&st.pool, &owner, &serde_json::to_vec(&mythic).unwrap(), false).await.unwrap();
    crate::precon_evidence::enable(&st.pool, &owner, "Mythic Tools").await.unwrap();
    let c = catalog(&st.pool).await.unwrap();
    let info = c.rating_v2.as_ref().unwrap();
    let source = |n: &str| info.sources.iter().find(|s| s.name == n).unwrap();
    assert!(source("Playgroup.gg").stock_lists);
    assert!(!source("Mythic Tools").stock_lists, "Mythic is credited, but as a commander-only source");
    let island = c.precons.iter().find(|p| p.id == "island-deck").unwrap();
    assert_eq!(island.commander_games.len(), 1, "only the exact commander set matches, never a partner pair");
    let m = &island.commander_games[0];
    assert_eq!((m.source.as_str(), m.commander.as_str(), m.games, m.decks), ("Mythic Tools", "Commander", 7984, Some(3077)));
    assert!((m.rate - 44.35).abs() < 1e-9);
    let v2_before = island.v2.as_ref().unwrap();
    assert_eq!((v2_before.rank, v2_before.real_share), (1, 1.0), "Mythic never enters the rank");

    // Each evidence column sorts, best first, decks without it last.
    let sorted = |s: &str| {
        let mut rows = c.precons.clone();
        Filters { s: s.into(), ..Default::default() }.apply(&mut rows).unwrap();
        rows.into_iter().map(|p| p.id).collect::<Vec<_>>()
    };
    // The forest deck's cached Playgroup.gg figure (24.2%) beats the island's dataset figure (20.5%).
    assert_eq!(sorted("real"), ["forest-deck", "island-deck"]);
    assert_eq!(sorted("rank"), ["island-deck", "forest-deck"], "the Phase rank, the unreliable result last");
    assert_eq!(sorted("commander")[0], "forest-deck", "equal commander figures fall back to name order");

    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (_, _, json) = request(&app, "/api/public/precons", &[]).await;
    assert!(json.contains("CC BY 4.0"));
    assert!(!json.contains("playgroup-history"), "private dataset ids stay private");
    assert!(!json.contains("bryan@example.com"), "the owner stays private");
    let (_, _, html) = request(&app, "/precons", &[]).await;
    assert!(html.contains("Meta rank (rating v2) ranks 1 precon by"), "only the island deck has real games");
    assert!(html.contains("real games of stock lists (Playgroup.gg)"), "Mythic isn't named as an input to the rank");
    assert!(html.contains("Playgroup.gg: Playgroup.gg / Arcane Digital B.V. &lt;script&gt;x&lt;/script&gt;. Licence: CC BY 4.0."));
    assert!(html.contains("<span class=\"source-chip\">Mythic Tools, by commander</span>"));
    assert!(html.contains("<strong>44.4%</strong> Mythic Tools, any list: 7,984 games"));
    assert!(html.contains("<option value=\"commander\">Real games, any list (Mythic Tools)</option>"));
    assert!(html.contains("<option value=\"rank\">Phase model</option>"));
    assert!(html.contains("aria-sort=\"descending\"><a class=\"sort-link is-sorted\" href=\"/precons?s=meta\">Meta rank"));
    assert!(html.contains("href=\"/precons?s=real\">Real games</a>"));
    let (_, _, html) = request(&app, "/precons?s=real&q=deck", &[]).await;
    assert!(html.contains("<option value=\"real\" selected>"));
    assert!(html.contains("href=\"/precons?q=deck&amp;s=rank\">Phase model</a>"), "a heading keeps the filters");
    assert!(!html.contains("<script>x"));
    let (_, _, html) = request(&app, "/precons/island-deck", &[]).await;
    assert!(html.contains("all-time 20.5% over 447 games"));
    assert!(html.contains("20.5%</a><small>447 stock games, Playgroup.gg</small>"), "the dataset's newer figure, not the cached one");
    assert!(html.contains("Mythic Tools, any list: 7,984 games from 3,077 decks"));
    let (_, _, html) = request(&app, "/precons/methodology", &[]).await;
    assert!(html.contains("id=\"v2\""));

    // Stopping the source is seen on the next request, despite the cache.
    crate::precon_evidence::disable(&pool, &owner, "Playgroup.gg").await.unwrap();
    let c = catalog(&pool).await.unwrap();
    assert!(c.rating_v2.is_none());
    // Mythic alone ranks nothing, but its figures keep their credit and their sort.
    assert_eq!(c.real_sources.iter().map(|s| (s.name.as_str(), s.stock_lists)).collect::<Vec<_>>(), [("Mythic Tools", false)]);
    assert!(c.precons.iter().all(|p| p.commander_games.len() == 1));
    let (_, _, html) = request(&app, "/precons", &[]).await;
    assert!(html.contains("<option value=\"commander\">Real games, any list (Mythic Tools)</option>"));
    assert!(html.contains("<span class=\"source-chip\">Mythic Tools, by commander</span>"));
    assert!(!html.contains("<span class=\"source-chip\">Playgroup.gg</span>"), "no fallback chip for a source that's off");
    assert!(html.contains("Mythic Tools: Derived from Mythic Tools"));
    let (_, _, html) = request(&app, "/precons/island-deck", &[]).await;
    assert!(html.contains("It isn’t part of this deck’s rank."));
}

#[tokio::test]
async fn a_card_data_import_refreshes_rating_v2() {
    // A commander record named only by printing or name may resolve after a card data import.
    let pool = crate::db::test_pool().await;
    let before = v2::key(&pool).await.unwrap();
    sqlx::query("INSERT INTO import_runs (id, kind, source_url, started_at, finished_at) VALUES ('run', 'scryfall', 'https://example.com', '2026-11-08T00:00:00Z', '2026-11-08T00:05:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    assert_ne!(v2::key(&pool).await.unwrap(), before);
}
