use super::*;
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn at(day: &str) -> DateTime<Utc> {
    format!("{day}T16:00:00Z").parse().unwrap()
}

fn precon_obs(slug: &str, name: &str, day: &str, games: u64, rate: f64, source: &str) -> Value {
    let entity = format!("playgroup:precon:{slug}");
    json!({"id":format!("{slug}-{day}-{games}"),"kind":"performance","entity":entity,"sources":[source],"data":{
        "entity_id":entity,"entity_name":name,"entity_kind":"precon","metric":"source_reported_normalized_4p_win_rate_percent",
        "value":rate,"source_reported_games":games,"cohort":"https://playgroup.gg/commander/precons",
        "source_entity_url":format!("https://playgroup.gg/sets/test-set/precons/{slug}"),
        "observation_period":{"kind":"cumulative_snapshot","source_as_of":format!("{day}T16:00:00Z"),"start":null},"quality_flags":[]}})
}

fn commander_obs(id: i64, days: u32, day: &str, games: u64, rate: f64) -> Value {
    let entity = format!("playgroup:commander:{id}");
    json!({"id":format!("c{id}-{days}-{day}"),"kind":"performance","entity":entity,"sources":[SHA_A],"data":{
        "entity_id":entity,"entity_name":"Test Commander","entity_kind":"commander","metric":"source_reported_normalized_4p_win_rate_percent",
        "value":rate,"source_reported_games":games,"cohort":format!("https://playgroup.gg/commanders/tier-list/{days}-days"),
        "source_entity_url":format!("https://playgroup.gg/commanders/{id}"),
        "observation_period":{"kind":"rolling_window","lookback_days":days,"source_as_of":format!("{day}T17:00:00Z")},"quality_flags":[]}})
}

fn document(id: &str, records: Vec<Value>) -> Value {
    json!({"schema":"yama-dataset/1","id":id,"title":"Playgroup history","generated_at":"2026-10-28T00:00:00Z",
        "source":{"name":"Playgroup.gg","url":"https://playgroup.gg/research","attribution":"Playgroup.gg / Arcane Digital B.V.","license":"CC BY 4.0"},
        "method":"Recovered dated aggregate snapshots","coverage":{},
        "sources":[{"sha256":SHA_A,"url":"https://playgroup.gg/commander/precons","retrieved_at":"2026-10-28T00:00:00Z","source_as_of":null,"captured_at":null,"flags":[],"transformation":null,"original_response_sha256":null},
                   {"sha256":SHA_B,"url":"https://web.archive.org/x","retrieved_at":"2026-10-28T00:00:00Z","source_as_of":null,"captured_at":null,"flags":["partial_archive_capture"],"transformation":null,"original_response_sha256":null}],
        "records":records})
}

fn rohan(source: &str) -> Vec<Value> {
    vec![
        precon_obs("test-riders", "Riders of Rohan", "2026-08-06", 263, 23.81, source),
        precon_obs("test-riders", "Riders of Rohan", "2026-09-06", 331, 22.02, source),
        precon_obs("test-riders", "Riders of Rohan", "2026-10-17", 447, 20.47, source),
    ]
}

async fn import(pool: &SqlitePool, owner: &str, doc: &Value) {
    crate::datasets::import(pool, owner, &serde_json::to_vec(doc).unwrap(), false)
        .await
        .unwrap();
}

async fn precon(pool: &SqlitePool, id: &str, name: &str, playgroup: Option<(&str, &str)>, playgroup_id: Option<i64>) {
    let pg = playgroup.map(|(_, url)| json!({"win_rate_4p": 20.0, "games": 400, "url": url}).to_string());
    sqlx::query(
        "INSERT INTO precons(id, lab_id, name, set_code, commanders, cards, source, content_sha256, imported_at, notes, playgroup, playgroup_name, playgroup_id)
         VALUES (?, ?, ?, 'TST', '[\"Test Commander\"]', '[]', 'MTGJSON', 'hash', '2026-10-27', '[]', ?, ?, ?)",
    )
    .bind(id)
    .bind(format!("precons/{id}"))
    .bind(name)
    .bind(pg)
    .bind(playgroup.map(|p| p.0))
    .bind(playgroup_id)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn nothing_is_shared_until_an_operator_chooses_a_source() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    assert!(ev.by_precon.is_empty());
    assert_eq!(ev.report.catalog_without_real_games, 1);

    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let real = ev.by_precon["test-riders"].real.as_ref().unwrap();
    assert_eq!(real.matched_by, "name");
    assert_eq!(real.latest.games, 447);
    assert_eq!(real.source.datasets[0].id, "playgroup-history");
    assert_eq!(real.history.intervals.len(), 2);

    // A different source name enables nothing; stopping removes it again.
    enable(&pool, &owner, "Another source").await.unwrap();
    disable(&pool, &owner, "Playgroup.gg").await.unwrap();
    assert!(load(&pool, at("2026-10-29")).await.unwrap().by_precon.is_empty());
}

#[tokio::test]
async fn a_new_revision_or_a_second_dataset_updates_the_history() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    let before = load(&pool, at("2026-10-29"))
        .await
        .unwrap()
        .by_precon
        .remove("test-riders")
        .unwrap()
        .real
        .unwrap();
    assert_eq!(before.latest.games, 447);

    // A later upload of the same dataset adds a snapshot: the history follows the active revision.
    let mut newer = rohan(SHA_A);
    newer.push(precon_obs("test-riders", "Riders of Rohan", "2026-10-28", 477, 19.81, SHA_A));
    import(&pool, &owner, &document("playgroup-history", newer)).await;
    let after = load(&pool, at("2026-10-29"))
        .await
        .unwrap()
        .by_precon
        .remove("test-riders")
        .unwrap()
        .real
        .unwrap();
    assert_eq!(after.latest.games, 477);
    assert_eq!(after.source.datasets[0].revision, 2);
    assert_eq!(after.history.recent.as_ref().unwrap().games, 214);

    // A separate dataset from the same source merges; a snapshot both hold counts once.
    let later = vec![
        precon_obs("test-riders", "Riders of Rohan", "2026-10-28", 477, 19.81, SHA_A),
        precon_obs("test-riders", "Riders of Rohan", "2026-12-01", 600, 19.0, SHA_A),
    ];
    let mut december = document("playgroup-december", later);
    december["source"]["license"] = json!("CC BY 4.0 (December terms)");
    import(&pool, &owner, &december).await;
    let merged = load(&pool, at("2026-12-02"))
        .await
        .unwrap()
        .by_precon
        .remove("test-riders")
        .unwrap()
        .real
        .unwrap();
    assert_eq!(merged.latest.games, 600);
    assert_eq!(merged.history.snapshots.len(), 5);
    assert_eq!(merged.source.datasets.len(), 2);
    assert_eq!(
        merged.source.license, "CC BY 4.0 (December terms); CC BY 4.0",
        "every dataset's licence is kept"
    );
}

#[tokio::test]
async fn links_prefer_the_source_url_then_name_and_operators_can_correct_them() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    // The catalog's own playgroup.gg URL links it, whatever its slug.
    precon(
        &pool,
        "rohan-ltc",
        "Riders of Rohan",
        Some(("Riders of Rohan", "https://playgroup.gg/sets/test-set/precons/test-riders/")),
        None,
    )
    .await;
    // Two catalog decks share a name: matching that name alone is ambiguous.
    precon(&pool, "limit-break-a", "Limit Break", None, None).await;
    precon(&pool, "limit-break-b", "Limit Break", None, None).await;
    let mut records = rohan(SHA_A);
    records.push(precon_obs("limit-break", "Limit Break", "2026-10-17", 300, 25.0, SHA_A));
    records.push(precon_obs("unknown-deck", "Unknown Deck", "2026-10-17", 300, 25.0, SHA_A));
    // Names differ, but the slugs agree.
    precon(&pool, "odd-slug", "Catalog Name", None, None).await;
    records.push(precon_obs("odd-slug", "Source Name", "2026-10-17", 300, 25.0, SHA_A));
    // Snapshots resting on a partial archive capture are left out.
    records.push(precon_obs("test-riders", "Riders of Rohan", "2026-10-20", 900, 50.0, SHA_B));
    import(&pool, &owner, &document("playgroup-history", records)).await;

    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let real = ev.by_precon["rohan-ltc"].real.as_ref().unwrap();
    assert_eq!(real.matched_by, "url");
    assert_eq!(real.latest.games, 447, "the partial capture isn't used");
    assert!(!ev.by_precon.contains_key("limit-break-a"));
    assert_eq!(ev.by_precon["odd-slug"].real.as_ref().unwrap().matched_by, "slug");
    let reasons: Vec<(&str, &str)> = ev.report.unmatched.iter().map(|u| (u.entity.as_str(), u.reason.as_str())).collect();
    assert!(
        reasons
            .iter()
            .any(|(e, r)| *e == "playgroup:precon:limit-break" && r.contains("fits 2 catalog precons")),
        "{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|(e, r)| *e == "playgroup:precon:unknown-deck" && r.contains("no catalog precon")),
        "{reasons:?}"
    );

    set_link(
        &pool,
        None,
        "limit-break-b",
        "playgroup:precon:limit-break",
        Some("manual"),
        Some("FINAL FANTASY VII"),
    )
    .await
    .unwrap();
    // An exclusion scoped to another source changes nothing here.
    set_link(
        &pool,
        Some("Other tracker"),
        "rohan-ltc",
        "playgroup:precon:test-riders",
        Some("exclude"),
        None,
    )
    .await
    .unwrap();
    assert!(load(&pool, at("2026-10-29")).await.unwrap().by_precon.contains_key("rohan-ltc"));
    set_link(
        &pool,
        Some("Playgroup.gg"),
        "rohan-ltc",
        "playgroup:precon:test-riders",
        Some("exclude"),
        None,
    )
    .await
    .unwrap();
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    assert_eq!(ev.by_precon["limit-break-b"].real.as_ref().unwrap().matched_by, "manual");
    assert!(!ev.by_precon.contains_key("rohan-ltc"));
    assert!(set_link(&pool, None, "no-such-precon", "x", Some("manual"), None).await.is_err());
    set_link(&pool, Some("Playgroup.gg"), "rohan-ltc", "playgroup:precon:test-riders", None, None)
        .await
        .unwrap();
    assert!(load(&pool, at("2026-10-29")).await.unwrap().by_precon.contains_key("rohan-ltc"));
}

#[tokio::test]
async fn precons_without_real_games_get_their_commanders_figure_separately() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "new-deck", "New Deck", None, Some(42)).await;
    precon(&pool, "test-riders", "Riders of Rohan", None, Some(7)).await;
    let mut records = rohan(SHA_A);
    records.push(commander_obs(42, 90, "2026-10-28", 120, 30.0));
    records.push(commander_obs(42, 180, "2026-10-28", 300, 27.5));
    records.push(commander_obs(7, 180, "2026-10-28", 900, 40.0));
    import(&pool, &owner, &document("playgroup-history", records)).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let c = ev.by_precon["new-deck"].commander.as_ref().unwrap();
    assert_eq!((c.window_days, c.games), (180, 300), "the 180-day window is preferred");
    assert!(ev.by_precon["new-deck"].real.is_none());
    assert!(
        ev.by_precon["test-riders"].commander.is_none(),
        "a precon with its own games doesn't show the commander's"
    );
}

#[tokio::test]
async fn sources_are_admin_only_and_owned_by_the_admin() {
    let (app, pool) = app().await;
    let (admin, admin_token) = user(&pool, "admin@example.com").await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?")
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
    let (_, token) = user(&pool, "pat@example.com").await;
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/admin/precon-evidence/sources/Playgroup.gg",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/admin/precon-evidence/sources/Playgroup.gg",
        Some(&admin_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["sources"][0]["owner"], "admin@example.com");
    let (status, body) = send(
        &app,
        Method::DELETE,
        "/api/admin/precon-evidence/sources/Playgroup.gg",
        Some(&admin_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sources"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn the_lab_precon_pages_carry_the_evidence() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    let list = crate::lab::precon_list(&pool).await.unwrap();
    let summary = list.precons[0].evidence.as_ref().unwrap().real.as_ref().unwrap();
    assert!(
        summary.history.snapshots.is_empty() && summary.history.recent.is_some(),
        "the list carries the summary only"
    );
    let detail = crate::lab::precon_detail(&pool, "test-riders").await.unwrap();
    assert_eq!(detail.precon.evidence.as_ref().unwrap().real.as_ref().unwrap().latest.games, 447);
}

/// A global precon-ratings run giving each listed precon a strength.
async fn global_run(pool: &SqlitePool, strengths: &[(&str, f64)]) {
    sqlx::query(
        "INSERT INTO lab_runs(id, owner_id, name, kind, engine, games, created_at, imported_at, summary, summary_sha256)
         VALUES ('run-1', NULL, 'precons-test', 'precon-ratings', 'phase-rs test', 1000, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '{}', 'x')",
    )
    .execute(pool)
    .await
    .unwrap();
    for (id, s) in strengths {
        sqlx::query("INSERT INTO lab_ratings(run_id, deck_ref, strength, games) VALUES ('run-1', ?, ?, 100)")
            .bind(format!("precons/{id}"))
            .bind(s)
            .execute(pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn calibration_and_rating_v2_follow_the_snapshots_and_the_run() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    // Twelve precons whose real rate rises with their simulated strength, before and after the split.
    let mut records = Vec::new();
    let mut strengths = Vec::new();
    let names: Vec<String> = (0..12).map(|i| format!("deck-{i:02}")).collect();
    for (i, slug) in names.iter().enumerate() {
        precon(&pool, slug, slug, None, None).await;
        let rate = 15.0 + i as f64;
        records.push(precon_obs(slug, slug, "2026-08-01", 200, rate + 2.0, SHA_A));
        records.push(precon_obs(slug, slug, "2026-09-01", 400, rate, SHA_A));
        // 200 later games at the deck's true rate minus the early noise.
        let later = rate - 1.0;
        records.push(precon_obs(
            slug,
            slug,
            "2026-10-20",
            600,
            (400.0 * rate + 200.0 * later) / 600.0,
            SHA_A,
        ));
        strengths.push((slug.as_str(), ((rate - 20.0) / 6.0f64).exp()));
    }
    // One precon the source doesn't rate: only the simulation speaks for it.
    precon(&pool, "unrated", "Unrated", None, None).await;
    strengths.push(("unrated", 2.0));
    import(&pool, &owner, &document("playgroup-history", records)).await;
    global_run(&pool, &strengths).await;

    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(report.precons_with_holdout, 12);
    let source = &report.sources[0];
    // The run was made on 1 Oct, after the split: scored, but it can't pass the gate.
    assert!(!source.predates_split && !source.evaluation.gate_passed);
    assert!(source.evaluation.verdict.starts_with("Made after the split"));
    assert!(calibrate(&pool, None, at("2026-10-02"), at("2026-10-29")).await.unwrap().sources[0].predates_split);
    assert_eq!(source.source.kind, "global run");
    assert_eq!(source.source.precons, 13);
    assert_eq!(source.evaluation.cases, 12);
    assert!(
        source.evaluation.scores[1].spearman.unwrap() > 0.99,
        "{:?}",
        source.evaluation.scores
    );
    assert!(source.spearman_all_time.unwrap() > 0.99);
    assert!(calibrate(&pool, None, at("2026-10-29"), at("2026-10-29")).await.is_err());

    let v2 = rating_v2(&pool, at("2026-10-29")).await.unwrap();
    assert_eq!(v2.ranked, 13);
    let unrated = v2.precons.iter().find(|e| e.precon == "unrated").unwrap();
    assert_eq!(unrated.real_share, 0.0);
    let top = v2.precons.iter().find(|e| e.precon == "deck-11").unwrap();
    assert!(top.real_share > 0.0 && top.real_share <= 1.0);
    assert!(top.rank_lo <= top.rank && top.rank <= top.rank_hi);
    if !v2.gate_passed {
        assert_eq!(top.real_share, 1.0, "without a passed gate real games stand alone");
    }
}

#[tokio::test]
async fn each_enabled_source_is_derived_and_labelled_on_its_own() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&pool, &owner, "Other tracker").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    // Another source using the same entity id with its own, newer and incompatible counts.
    let mut other = document(
        "other-history",
        vec![
            precon_obs("test-riders", "Riders of Rohan", "2026-10-01", 50, 40.0, SHA_A),
            precon_obs("test-riders", "Riders of Rohan", "2026-10-25", 120, 35.0, SHA_A),
        ],
    );
    other["source"] = json!({"name":"Other tracker","url":"https://example.com","attribution":"Other tracker","license":"Private"});
    import(&pool, &owner, &other).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let e = &ev.by_precon["test-riders"];
    let real = e.real.as_ref().unwrap();
    assert_eq!(real.source.name, "Other tracker", "the newest snapshot speaks first");
    assert_eq!(real.history.snapshots.len(), 2, "the sources' snapshots never mix");
    assert_eq!(e.also.len(), 1);
    assert_eq!(e.also[0].source.name, "Playgroup.gg");
    assert_eq!(e.also[0].latest.games, 447);
    assert_eq!(ev.report.source_labels.len(), 2);
    assert_eq!(ev.report.matched["test-riders"].len(), 2);
    // Calibration pairs the split's history with later games from the same source.
    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(report.precons_with_holdout, 1);
}

#[tokio::test]
async fn a_changed_stock_list_keeps_no_simulated_result_in_rating_v2() {
    let (_, pool) = app().await;
    // riders-of-rohan is in the frozen upgradeability data; an empty list no longer matches it.
    precon(&pool, "riders-of-rohan", "Riders of Rohan", None, None).await;
    global_run(&pool, &[("riders-of-rohan", 2.0)]).await;
    let sources = sim_sources(&pool, None, None).await.unwrap();
    assert!(sources[0].strengths.is_empty());
    assert!(rating_v2(&pool, at("2026-10-29")).await.unwrap().precons.is_empty());
}

#[tokio::test]
async fn a_future_cohort_does_not_hide_todays_history() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    let mut records = rohan(SHA_A);
    let mut later = precon_obs("test-riders", "Riders of Rohan", "2026-12-01", 900, 30.0, SHA_A);
    later["data"]["cohort"] = json!("https://playgroup.gg/commander/precons/180-days");
    later["id"] = json!("later-cohort");
    records.push(later);
    import(&pool, &owner, &document("playgroup-history", records)).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let real = ev.by_precon["test-riders"].real.as_ref().unwrap();
    assert_eq!(real.latest.games, 447);
    assert_eq!(real.cohort, "https://playgroup.gg/commander/precons");
}

#[tokio::test]
async fn calibration_follows_a_cohort_that_spans_the_split() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    let mut records = rohan(SHA_A);
    // A new cohort begins after the split and is newer today.
    let mut newer = precon_obs("test-riders", "Riders of Rohan", "2026-10-25", 90, 30.0, SHA_A);
    newer["data"]["cohort"] = json!("https://playgroup.gg/commander/precons/new-method");
    newer["id"] = json!("new-cohort");
    records.push(newer);
    import(&pool, &owner, &document("playgroup-history", records)).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    assert_eq!(
        ev.by_precon["test-riders"].real.as_ref().unwrap().cohort,
        "https://playgroup.gg/commander/precons/new-method"
    );
    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(report.precons_with_holdout, 1, "the old cohort's later games are the held-out set");
}

#[tokio::test]
async fn calibration_prefers_a_chain_that_spans_the_split() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&pool, &owner, "Other tracker").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    // The other source had a pre-split history but reset its counts after the split, and is newer.
    let mut other = document(
        "other-history",
        vec![
            precon_obs("test-riders", "Riders of Rohan", "2026-08-01", 300, 30.0, SHA_A),
            precon_obs("test-riders", "Riders of Rohan", "2026-09-01", 400, 30.0, SHA_A),
            precon_obs("test-riders", "Riders of Rohan", "2026-10-25", 60, 25.0, SHA_A),
        ],
    );
    other["source"] = json!({"name":"Other tracker","url":"https://example.com","attribution":"Other tracker","license":"Private"});
    import(&pool, &owner, &other).await;
    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(
        report.precons_with_holdout, 1,
        "Playgroup.gg's unbroken chain supplies the held-out games"
    );
}
