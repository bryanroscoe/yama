use super::*;
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};

fn doc() -> Value {
    json!({"schema":"yama-research/1","id":"audit","title":"Private audit","generated_at":"2026-10-27T00:00:00Z","decks":[{"key":"energy","name":"Energy","commander":"Saheeli","recommended_build":"b3","builds":[{"id":"b3","label":"Bracket 3","bracket":3,"list":"Commander\n1 Saheeli\nDeck\n99 Island","swaps":[{"id":"monitor","card_in":"Thought Monitor","card_out":"Glimmer of Genius"}]}]}],"extra_evidence":{"kept":true}})
}

#[tokio::test]
async fn isolated_idempotent_storage_never_changes_a_deck() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    let (_, other) = user(&pool, "b@example.com").await;
    let (s, r) = send(
        &app,
        Method::POST,
        "/api/research",
        Some(&session),
        Some(doc()),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["revision"], 1);
    assert_eq!(r["changed"], true);
    let (_, r) = send(
        &app,
        Method::POST,
        "/api/research",
        Some(&session),
        Some(doc()),
    )
    .await;
    assert_eq!(r["changed"], false);
    assert_eq!(r["revision"], 1);
    let (s, r) = send(
        &app,
        Method::GET,
        "/api/research/audit",
        Some(&session),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(r["document"]["extra_evidence"]["kept"], true);
    assert_eq!(
        send(&app, Method::GET, "/api/research/audit", Some(&other), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(&app, Method::GET, "/api/research", Some(&other), None)
            .await
            .1,
        json!([])
    );
    assert_eq!(
        send(&app, Method::GET, "/api/research", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM decks WHERE owner_id=?")
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn review_retry_conflicts_and_reimport_preserve_answers() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    let mut d = doc();
    save(&pool, &owner, &d).await.unwrap();
    let hash = targets(&d).unwrap()["swap:energy:b3:monitor"].clone();
    let mut op = ReviewOp {
        op_id: "first-op".into(),
        target: "swap:energy:b3:monitor".into(),
        decision: Some("want".into()),
        note: Some("Keep this idea".into()),
        expected_version: 0,
        target_hash: hash.clone(),
    };
    let first = review(&pool, &owner, "audit", &op).await.unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(
        review(&pool, &owner, "audit", &op).await.unwrap().version,
        1
    );
    op.decision = Some("no".into());
    assert!(matches!(
        review(&pool, &owner, "audit", &op).await,
        Err(AppError::Conflict(_))
    ));
    op.op_id = "second-op".into();
    assert!(matches!(
        review(&pool, &owner, "audit", &op).await,
        Err(AppError::Conflict(_))
    ));
    op.expected_version = 1;
    review(&pool, &owner, "audit", &op).await.unwrap();
    d["decks"][0]["builds"][0]["swaps"][0]["why"] = json!("New evidence");
    save(&pool, &owner, &d).await.unwrap();
    let loaded = load(&pool, &owner, "audit").await.unwrap();
    assert_eq!(loaded["reviews"][0]["decision"], "no");
    assert_ne!(
        loaded["target_hashes"]["swap:energy:b3:monitor"],
        loaded["reviews"][0]["target_hash"]
    );
    op.op_id = "third-op".into();
    op.expected_version = 2;
    assert!(matches!(
        review(&pool, &owner, "audit", &op).await,
        Err(AppError::Conflict(_))
    ));
    d["decks"][0]["builds"][0]["swaps"] = json!([]);
    save(&pool, &owner, &d).await.unwrap();
    let loaded = load(&pool, &owner, "audit").await.unwrap();
    assert_eq!(loaded["reviews"].as_array().unwrap().len(), 1);
    assert!(
        loaded["target_hashes"]
            .get("swap:energy:b3:monitor")
            .is_none()
    );
}

#[tokio::test]
async fn preferred_build_is_a_preference_not_an_install() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "a@example.com").await;
    let d = doc();
    save(&pool, &owner, &d).await.unwrap();
    let mut op = ReviewOp {
        op_id: "choose".into(),
        target: "deck:energy".into(),
        decision: Some("b4".into()),
        note: None,
        expected_version: 0,
        target_hash: targets(&d).unwrap()["deck:energy"].clone(),
    };
    assert!(review(&pool, &owner, "audit", &op).await.is_err());
    op.decision = Some("b3".into());
    review(&pool, &owner, "audit", &op).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plan_swaps")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn rejects_malformed_duplicate_and_oversized_documents() {
    let mut d = doc();
    d["decks"][0]["builds"][0]["power"] = json!({"range":42});
    assert!(targets(&d).is_err());
    let mut d = doc();
    let duplicate = d["decks"][0].clone();
    d["decks"].as_array_mut().unwrap().push(duplicate);
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["decks"][0]["builds"][0]["id"] = json!("../escape");
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["extra"] = json!("a".repeat(MAX_BYTES + 1));
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["decks"][0]["builds"][0]["acquisition"] = json!({"buys":[{"price":"free"}]});
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["power_scale"] = json!("not an array");
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["local_checks"] = json!({"Card":{"local_checks":"not an array"}});
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["decks"][0]["builds"][0]["combos"] =
        json!([{"id":"x","name":"Bad line","missing_cards":"wrong"}]);
    assert!(targets(&d).is_err());
}

#[test]
fn validates_delivery_fixture_when_supplied() {
    if let Ok(path) = std::env::var("YAMA_RESEARCH_FIXTURE") {
        let d: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let keys = targets(&d).expect("delivery fixture must meet the server contract");
        assert!(keys.len() > 100);
    }
}

#[tokio::test]
async fn mcp_can_save_and_read_private_research_without_apply() {
    let st = crate::testutil::state().await;
    let (id, _) = user(&st.pool, "a@example.com").await;
    let user = crate::auth::user_by_id(&st, &id).await.unwrap().unwrap();
    let via = crate::mcp::Via::OAuth;
    let r = crate::mcp::tools::call(
        &st,
        &user,
        &via,
        "save_research",
        &json!({"document":doc()}),
    )
    .await
    .unwrap();
    assert!(r.contains("Research saved"));
    let text = crate::mcp::tools::call(
        &st,
        &user,
        &via,
        "research",
        &json!({"id":"audit","deck":"energy","build":"b3"}),
    )
    .await
    .unwrap();
    let r: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(r["document"]["decks"][0]["builds"][0]["id"], "b3");
    let text = crate::mcp::tools::call(&st, &user, &via, "research", &json!({"id":"audit"}))
        .await
        .unwrap();
    let overview: Value = serde_json::from_str(&text).unwrap();
    assert!(
        overview["document"]["decks"][0]["builds"][0]
            .get("list")
            .is_none()
    );
    let op = json!({"id":"audit","op_id":"mcp-review","target":"deck:energy","decision":"b3","note":"Friends build","expected_version":0,"target_hash":targets(&doc()).unwrap()["deck:energy"]});
    let text = crate::mcp::tools::call(&st, &user, &via, "review_research", &op)
        .await
        .unwrap();
    let review: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(review["decision"], "b3");
    let other = crate::auth::User {
        id: "other".into(),
        ..user.clone()
    };
    assert!(
        crate::mcp::tools::call(&st, &other, &via, "research", &json!({"id":"audit"}))
            .await
            .is_err()
    );
    let tools = crate::mcp::tools::list(&via);
    let save = tools.iter().find(|t| t["name"] == "save_research").unwrap();
    assert_eq!(save["annotations"]["idempotentHint"], true);
}

#[test]
fn complete_accounting_and_new_rendered_fields_are_checked() {
    let mut d = doc();
    let a = json!({"total":100,"commander":1,"main":99,"basics":99,"nonbasic":1,"unchanged":100,"added":0,"removed":0,"owned":1,"local_buys":0,"prints":0});
    d["decks"][0]["builds"][0]["accounting"] = a;
    assert!(targets(&d).is_ok());
    d["decks"][0]["builds"][0]["accounting"]["owned"] = json!(0);
    assert!(targets(&d).is_err(), "missing supply cannot look complete");
    d["decks"][0]["builds"][0]["accounting"]["projected_stock"] = json!(1);
    assert!(
        targets(&d).is_ok(),
        "projected stock stays separate from owned"
    );
    d["decks"][0]["builds"][0]["list"] = json!("Commander\n1 Saheeli\nDeck\n98 Island");
    assert!(
        targets(&d).is_err(),
        "a reported total cannot hide a short list"
    );
    for (path, value) in [
        (
            "/decks/0/competitive_path",
            json!({"status":[],"summary":"x"}),
        ),
        (
            "/decks/0/combo_playbook",
            json!([{"id":"x","name":"x","cards":false}]),
        ),
        ("/decks/0/builds/0/gameplay_profile", json!({"plan":42})),
        (
            "/decks/0/builds/0/gc_choices",
            json!([{"card":"x","reason":[]}]),
        ),
    ] {
        let mut malformed = doc();
        let (prefix, field) = path.rsplit_once('/').unwrap();
        malformed
            .pointer_mut(prefix)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(field.into(), value);
        assert!(targets(&malformed).is_err(), "{path}");
    }
    let mut d = doc();
    d["default_scenario_id"] = json!("missing");
    assert!(targets(&d).is_err());
    let mut d = doc();
    d["scenarios"] = json!([{"id":"buy","label":"Buy","sealed_purchases":[{"price":"free"}]}]);
    assert!(targets(&d).is_err());
}
