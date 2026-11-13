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

#[tokio::test]
async fn the_newest_commander_figure_across_sources_stands_in() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&pool, &owner, "Other tracker").await.unwrap();
    precon(&pool, "new-deck", "New Deck", None, Some(42)).await;
    import(
        &pool,
        &owner,
        &document("playgroup-history", vec![commander_obs(42, 180, "2026-10-01", 300, 27.5)]),
    )
    .await;
    let mut other = document("other-history", vec![commander_obs(42, 180, "2026-10-28", 120, 31.0)]);
    other["source"] = json!({"name":"Other tracker","url":"https://example.com","attribution":"Other tracker","license":"Private"});
    import(&pool, &owner, &other).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let c = ev.by_precon["new-deck"].commander.as_ref().unwrap();
    assert_eq!((c.source.name.as_str(), c.games), ("Other tracker", 120));
    assert_eq!(c.source.license, "Private", "the stand-in carries its source's provenance");
}

#[tokio::test]
async fn conflicting_commander_figures_are_set_aside() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "new-deck", "New Deck", None, Some(42)).await;
    import(
        &pool,
        &owner,
        &document(
            "playgroup-history",
            vec![
                commander_obs(42, 180, "2026-10-28", 300, 27.5),
                commander_obs(42, 180, "2026-10-01", 250, 26.0),
                commander_obs(42, 365, "2026-10-28", 600, 26.0),
            ],
        ),
    )
    .await;
    // Same source, same window and date, different figure.
    let mut clash = commander_obs(42, 180, "2026-10-28", 310, 29.0);
    clash["id"] = json!("clash");
    import(&pool, &owner, &document("playgroup-other", vec![clash])).await;
    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let c = ev.by_precon["new-deck"].commander.as_ref().unwrap();
    assert_eq!(
        (c.window_days, c.games),
        (180, 250),
        "the disputed figure gives way to the window's earlier agreed one"
    );
}

#[tokio::test]
async fn calibration_finds_a_chain_in_the_splits_secondary_cohort() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    // At the split a short-lived cohort is newest; it stops before today, when the long chain is newest again.
    let mut records = rohan(SHA_A);
    let mut brief = precon_obs("test-riders", "Riders of Rohan", "2026-09-10", 50, 30.0, SHA_A);
    brief["data"]["cohort"] = json!("https://playgroup.gg/commander/precons/brief");
    brief["id"] = json!("brief");
    records.push(brief);
    import(&pool, &owner, &document("playgroup-history", records)).await;
    let at_split = load(&pool, at("2026-09-15")).await.unwrap();
    assert_eq!(
        at_split.by_precon["test-riders"].real.as_ref().unwrap().cohort,
        "https://playgroup.gg/commander/precons/brief"
    );
    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(
        report.precons_with_holdout, 1,
        "the long chain is found behind the split's newest cohort"
    );
}

#[tokio::test]
async fn a_reset_after_the_split_keeps_the_held_out_games_before_it() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    precon(&pool, "test-riders", "Riders of Rohan", None, None).await;
    // Aug and Sep before the split, Oct 17 after it, then the count resets on Oct 25.
    let mut records = rohan(SHA_A);
    records.push(precon_obs("test-riders", "Riders of Rohan", "2026-10-25", 30, 25.0, SHA_A));
    import(&pool, &owner, &document("playgroup-history", records)).await;
    let today = load(&pool, at("2026-10-29")).await.unwrap();
    assert_eq!(
        today.by_precon["test-riders"].real.as_ref().unwrap().latest.games,
        30,
        "the page shows the new chain"
    );
    let report = calibrate(&pool, None, at("2026-09-15"), at("2026-10-29")).await.unwrap();
    assert_eq!(report.precons_with_holdout, 1, "Sep 6 to Oct 17 is still the held-out set");
}

#[tokio::test]
async fn a_commander_only_source_shows_every_list_under_the_exact_commanders() {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&pool, &owner, "Mythic Tools").await.unwrap();
    let cards = |ids: &[&str]| {
        serde_json::to_string(
            &ids.iter().map(|id| json!({"name": id, "oracle_id": id, "qty": 1, "board": "commander"})).collect::<Vec<_>>(),
        )
        .unwrap()
    };
    for (id, commanders) in [("test-riders", cards(&["solo"])), ("pair-deck", cards(&["b-partner", "a-partner"])), ("other-pair", cards(&["a-partner", "c-partner"]))] {
        precon(&pool, id, id, None, None).await;
        sqlx::query("UPDATE precons SET cards = ? WHERE id = ?").bind(commanders).bind(id).execute(&pool).await.unwrap();
    }
    import(&pool, &owner, &document("playgroup-history", rohan(SHA_A))).await;
    // A Playgroup.gg-style commander record by printing: Playgroup rates stock lists, so it's never repeated by commander.
    let mut playgroup = document("playgroup-commanders", vec![json!({"id":"commander:1","kind":"commander","entity":"playgroup:commander:1","sources":[SHA_A],
        "data":{"name":"solo","oracle_ids":["solo"],"game_played_count":100,"game_win_count":30}})]);
    playgroup["id"] = json!("playgroup-commanders");
    import(&pool, &owner, &playgroup).await;
    let record = |key: &str, ids: &[&str], games: u64, rate: f64| {
        json!({"id":format!("mythic:commander:{key}"),"kind":"commander","entity":format!("mythic:commander:{key}"),"sources":[SHA_A],
            "data":{"name":key,"oracle_ids":ids,"score_0_100":55.0,"interval_low":50.0,"interval_high":60.0,"games":games,"decks":games / 3,"win_rate":rate}})
    };
    let mut mythic = document("mythic-commander-scores", vec![
        record("solo", &["solo"], 900, 0.41),
        record("pair", &["a-partner", "b-partner"], 300, 0.3),
        record("a-only", &["a-partner"], 5000, 0.5),
        json!({"id":"mythic:commander:score-only","kind":"commander","entity":"mythic:commander:score-only","sources":[SHA_A],
            "data":{"name":"score only","oracle_ids":["c-partner"],"score_0_100":55.0,"interval_low":50.0,"interval_high":60.0,"games":0}}),
    ]);
    mythic["source"] = json!({"name":"Mythic Tools","url":"https://mythic.tools","attribution":"Derived from Mythic Tools.","license":"Derived rates only"});
    import(&pool, &owner, &mythic).await;

    let ev = load(&pool, at("2026-10-29")).await.unwrap();
    let riders = &ev.by_precon["test-riders"];
    assert!(riders.real.is_some(), "the stock figure is unchanged");
    assert_eq!(riders.all_lists.len(), 1, "Playgroup.gg rates stock lists, so only Mythic shows by commander");
    let m = &riders.all_lists[0];
    assert_eq!((m.source.name.as_str(), m.games, m.decks), ("Mythic Tools", 900, Some(300)));
    assert!((m.rate - 41.0).abs() < 1e-9);
    let pair = &ev.by_precon["pair-deck"].all_lists;
    assert_eq!(pair.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["pair"], "partners match as a pair, never one of them alone");
    assert!(!ev.by_precon.contains_key("other-pair"), "no pair record and a score alone give nothing");
    assert!(ev.report.catalog_without_real_games >= 2, "a commander figure is not a real-game rate");

    // Too few precons with stock games to test it, so the rating doesn't read it.
    let v2 = rating_v2_with(&pool, at("2026-10-29"), ev).await.unwrap();
    assert_eq!(v2.precons.iter().map(|p| p.precon.as_str()).collect::<Vec<_>>(), ["test-riders"]);
}

/// Twelve precons with stock games and a Mythic figure each, plus two with Mythic alone (deck-12
/// and deck-13). `mythic` gives precon i's Mythic win share from its stock rate; `strength`, when
/// given, puts precon i in a global simulation run.
async fn commander_field(mythic: impl Fn(usize, f64) -> f64) -> (SqlitePool, RatingV2) {
    commander_field_with(mythic, None).await
}

async fn commander_field_with(mythic: impl Fn(usize, f64) -> f64, strength: Option<&dyn Fn(usize) -> Option<f64>>) -> (SqlitePool, RatingV2) {
    let (_, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    enable(&pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&pool, &owner, "Mythic Tools").await.unwrap();
    let mut stock = Vec::new();
    let mut figures = Vec::new();
    let mut strengths = Vec::new();
    for i in 0..14 {
        let id = format!("deck-{i:02}");
        if let Some(s) = strength.and_then(|f| f(i)) {
            strengths.push((id.clone(), s));
        }
        precon(&pool, &id, &id, None, None).await;
        let cards = json!([{"name": format!("c{i}"), "oracle_id": format!("c{i}"), "qty": 1, "board": "commander"}]).to_string();
        sqlx::query("UPDATE precons SET cards = ? WHERE id = ?").bind(cards).bind(&id).execute(&pool).await.unwrap();
        let rate = 14.0 + 1.5 * i as f64;
        if i < 12 {
            stock.push(precon_obs(&id, &id, "2026-10-17", 2000, rate, SHA_A));
        }
        figures.push(json!({"id":format!("mythic:commander:c{i}"),"kind":"commander","entity":format!("mythic:commander:c{i}"),"sources":[SHA_A],
            "data":{"name":format!("c{i}"),"oracle_ids":[format!("c{i}")],"score_0_100":50.0,"interval_low":40.0,"interval_high":60.0,"games":3000,"decks":900,"win_rate":mythic(i, rate)}}));
    }
    import(&pool, &owner, &document("playgroup-history", stock)).await;
    let mut doc = document("mythic-commander-scores", figures);
    doc["source"] = json!({"name":"Mythic Tools","url":"https://mythic.tools","attribution":"Derived from Mythic Tools.","license":"Derived rates only"});
    import(&pool, &owner, &doc).await;
    if strength.is_some() {
        let pairs: Vec<(&str, f64)> = strengths.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        global_run(&pool, &pairs).await;
    }
    let v2 = rating_v2_with(&pool, at("2026-10-29"), load(&pool, at("2026-10-29")).await.unwrap()).await.unwrap();
    (pool, v2)
}

#[tokio::test]
async fn a_commander_figure_that_predicts_stock_games_ranks_precons_without_them() {
    // Mythic's rate runs about twice the stock rate (mixed pod sizes), with a little wobble.
    let (_, v2) = commander_field(|i, rate| (2.0 * rate + [0.5, -0.5, 0.3][i % 3]) / 100.0).await;
    let t = v2.commander.as_ref().unwrap();
    assert_eq!((t.source.as_str(), t.precons), ("Mythic Tools", 12));
    assert!(t.used, "{t:?}");
    assert!(t.error_with.unwrap() < t.error_without.unwrap());
    let new = v2.precons.iter().find(|p| p.precon == "deck-12").expect("ranked from its commander figure");
    assert_eq!((new.real_share, new.commander_source.as_deref()), (0.0, Some("Mythic Tools")));
    assert!((new.rate - 32.0).abs() < 1.5, "mapped onto the stock scale: {}", new.rate);
    assert!(new.hi - new.lo < 10.0);
    let stocked = v2.precons.iter().find(|p| p.precon == "deck-11").unwrap();
    assert_eq!((stocked.real_share, stocked.commander_source.as_deref()), (1.0, None), "stock games stand alone");
    // Standing: the twelve with stock games are the field (14% to 30.5% on 2,000 games each);
    // its ends stand apart, and a precon rated from its commander's figure has no standing.
    use calibration::Standing;
    let field = v2.field.expect("twelve precons with stock games make a field");
    assert_eq!(field.precons, 12);
    assert!((field.mean - 22.25).abs() < 1e-6 && field.spread > 4.5 && field.spread < 6.0, "{field:?}");
    let standing = |id: &str| v2.precons.iter().find(|p| p.precon == id).unwrap().standing;
    assert_eq!(standing("deck-00"), Some(Standing::Behind));
    assert_eq!(standing("deck-11"), Some(Standing::Ahead));
    assert_eq!(standing("deck-06"), Some(Standing::Pack), "22.25% against a 23% precon is no difference");
    assert_eq!(standing("deck-12"), None);
}

#[test]
fn a_thin_recent_rate_gives_way_to_the_all_time_figure_at_no_more_than_forty_games() {
    let recent = |games: u64, rate: f64| history::Recent { rate, games, effective_games: games as f64 * 0.8, from: at("2026-08-06"), to: at("2026-10-28"), half_life_days: 180 };
    // Enough new games: the recent rate, at its own weight.
    assert_eq!(real_estimate(Some(&recent(60, 30.0)), 20.0, 500), calibration::Real { rate: 30.0, effective_games: 48.0 });
    // Two new games on top of 70: the all-time figure, trusted as 40 games, not 2 and not 72.
    assert_eq!(real_estimate(Some(&recent(2, 100.0)), 24.3, 72), calibration::Real { rate: 24.3, effective_games: 40.0 });
    // A long record with few new games isn't counted in full either, and a short one isn't padded.
    assert_eq!(real_estimate(Some(&recent(16, 28.0)), 27.6, 184).effective_games, 40.0);
    assert_eq!(real_estimate(Some(&recent(6, 20.0)), 17.1, 35).effective_games, 35.0);
    // One snapshot, so nothing to say how new the games are: the all-time figure as it is.
    assert_eq!(real_estimate(None, 21.0, 306), calibration::Real { rate: 21.0, effective_games: 306.0 });
}

#[tokio::test]
async fn a_commander_figure_that_predicts_nothing_stays_out() {
    let (_, v2) = commander_field(|i, _| [0.30, 0.55, 0.42, 0.61, 0.25, 0.48][i % 6]).await;
    let t = v2.commander.as_ref().unwrap();
    assert!(!t.used, "{t:?}");
    assert!(v2.precons.iter().all(|p| p.commander_source.is_none()));
    assert!(!v2.precons.iter().any(|p| p.precon == "deck-12"), "no simulation and no stock games: unranked");
}

#[tokio::test]
async fn with_a_simulation_the_commander_figure_joins_it_and_never_stands_alone() {
    // The simulation knows little (a wobble around 1); Mythic tracks the stock rates. deck-13 has no strength.
    let wobble = |i: usize| (i != 13).then(|| [0.9, 1.1, 1.0, 1.2, 0.8][i % 5]);
    let (_, v2) = commander_field_with(|i, rate| (2.0 * rate + [0.5, -0.5, 0.3][i % 3]) / 100.0, Some(&wobble)).await;
    assert!(v2.simulation.is_some());
    let t = v2.commander.as_ref().unwrap();
    assert!(t.used, "{t:?}");
    assert_eq!(t.precons, 12, "tested on the precons with stock games and a strength");
    let new = v2.precons.iter().find(|p| p.precon == "deck-12").expect("ranked from the simulation and its commander figure");
    assert_eq!(new.commander_source.as_deref(), Some("Mythic Tools"));
    assert!((new.rate - 32.0).abs() < 2.0, "{}", new.rate);
    assert!(
        !v2.precons.iter().any(|p| p.precon == "deck-13"),
        "a precon the simulation doesn't rate isn't estimated from an untested commander-only fit"
    );
}
