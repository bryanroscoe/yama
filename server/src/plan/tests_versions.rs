//! One plan per deck, approved whole (`versions.rs`): states, versions, skips, open questions,
//! keep, undo and archive, through the real router on the synthetic plan file in `tests.rs`.

use super::*;

/// The fixture with two proposals for Beta, the deck that is only proposals.
fn doc_with_beta_plan() -> Value {
    let mut d = doc();
    let swaps = d["plan"]["swaps"].as_array_mut().unwrap();
    swaps.push(json!({"key": "beta-1", "deck": "beta", "stage": "proposed", "role": "swap", "src": "buy", "out": "Island",
                      "in": "Proposal Card", "group": "Bracket 4", "why": "Faster"}));
    swaps.push(json!({"key": "beta-2", "deck": "beta", "stage": "proposed", "role": "swap", "src": "print", "out": "Island",
                      "in": "Print Card", "group": "Bracket 4"}));
    d
}

fn deck<'a>(b: &'a Value, key: &str) -> &'a Value {
    b["decks"].as_array().unwrap().iter().find(|d| d["key"] == key).unwrap()
}

/// Post ops; an approve or keep without a hash gets the waiting version's, as the page sends it.
async fn ops(app: &Router, token: &str, mut ops: Value) -> Value {
    for op in ops.as_array_mut().unwrap() {
        if op["kind"] == "plan" && (op["action"] == "approve" || op["action"] == "keep") && op.get("hash").is_none() {
            let b = bundle(app, token).await;
            let h = deck(&b, op["deck_key"].as_str().unwrap())["plan"]["next"]["hash"].clone();
            op["hash"] = if h.is_null() { json!("none") } else { h };
        }
    }
    let (status, r) = send(app, Method::POST, "/api/plan/inputs", Some(token), Some(ops)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    r
}

fn plan_op(id: &str, deck: &str, action: &str, version: i64, keys: &[&str], skip: &[&str], answers: Value) -> Value {
    json!({"op_id": id, "kind": "plan", "deck_key": deck, "action": action, "version": version, "keys": keys, "skip": skip,
           "answers": answers, "at": crate::util::now()})
}

async fn decision(pool: &SqlitePool, owner: &str, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT decision FROM plan_reviews WHERE owner_id = ? AND swap_key = ?").bind(owner).bind(key).fetch_optional(pool).await.unwrap().flatten()
}

#[tokio::test]
async fn a_plan_has_one_state_and_waits_for_your_ok() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let b = bundle(&app, &token).await;

    // Alpha has planned swaps from the plan file: version 1 in progress, its two unanswered
    // proposals are version 2, waiting, with the deck's open question to answer first.
    let alpha = &deck(&b, "alpha")["plan"];
    assert_eq!(alpha["state"], "in_progress", "{alpha}");
    assert_eq!(alpha["version"], 1);
    assert_eq!(alpha["next"]["n"], 2);
    assert_eq!(alpha["next"]["keys"], json!(["alpha-idea", "alpha-owned"]));
    assert_eq!(alpha["questions"], json!(["Where did this come from?"]));
    assert_eq!(alpha["next"]["source"]["app"], "commander-decks");
    assert_eq!(alpha["changes"], 2, "planned swaps, not the stand-in");

    // Beta is only proposals: version 1 waits for your OK, and nothing is approved yet.
    let beta = &deck(&b, "beta")["plan"];
    assert_eq!(beta["state"], "waiting", "{beta}");
    assert_eq!(beta["version"], Value::Null);
    assert_eq!(beta["next"]["n"], 1);
    assert_eq!(beta["next"]["keys"], json!(["beta-1", "beta-2"]));
    assert_eq!(b["versions"], json!([]));
}

#[tokio::test]
async fn approving_writes_an_answer_per_change_and_a_version() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;

    // A key list that isn't the plan's is refused: what you saw isn't what's waiting.
    let r = ops(&app, &token, json!([plan_op("p0", "beta", "approve", 1, &["beta-1"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");
    // The wrong version too.
    let r = ops(&app, &token, json!([plan_op("p0b", "beta", "approve", 2, &["beta-1"], &["beta-2"], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");

    let r = ops(&app, &token, json!([plan_op("p1", "beta", "approve", 1, &["beta-1"], &["beta-2"], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(decision(&pool, &owner, "beta-1").await.as_deref(), Some("want"));
    assert_eq!(decision(&pool, &owner, "beta-2").await.as_deref(), Some("no"));
    // A retry is a no-op.
    let r = ops(&app, &token, json!([plan_op("p1", "beta", "approve", 1, &["beta-1"], &["beta-2"], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "duplicate", "{r}");

    let b = bundle(&app, &token).await;
    let beta = &deck(&b, "beta")["plan"];
    assert_eq!(beta["state"], "in_progress", "{beta}");
    assert_eq!(beta["version"], 1);
    assert_eq!(beta["next"], Value::Null);
    assert_eq!(beta["changes"], 1);
    let v = &b["versions"][0];
    assert_eq!((v["deck"].as_str(), v["n"].as_i64(), v["status"].as_str()), (Some("beta"), Some(1), Some("approved")));
    assert_eq!(v["changes"][0]["in"], "Proposal Card");
    assert_eq!(v["skipped"][0]["key"], "beta-2");
    // The answers reach the export side's inbox as review answers, then the plan op.
    let inbox = super::super::inputs::inbox(&pool, &owner, None).await.unwrap();
    let kinds: Vec<(&str, Option<&str>)> = inbox.ops.iter().map(|o| (o.kind.as_str(), o.record["decision"].as_str())).collect();
    assert_eq!(kinds, vec![("review", Some("want")), ("review", Some("no")), ("plan", None)]);
    assert_eq!(inbox.ops[0].stage.as_deref(), Some("proposed"));
    assert_eq!(inbox.ops[2].record["action"], "approve");
    assert_eq!(b["reviews"]["beta-1"]["seq"], json!(inbox.ops[0].seq), "the answer knows its inbox op");
}

#[tokio::test]
async fn open_questions_need_answers_and_undo_restores() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let keys = ["alpha-idea", "alpha-owned"];
    let r = ops(&app, &token, json!([plan_op("q1", "alpha", "approve", 2, &keys, &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected");
    assert!(r["results"][0]["error"].as_str().unwrap().contains("Where did this come from?"), "{r}");
    let answers = json!([{"question": "Where did this come from?", "answer": "A booster"}]);
    let r = ops(&app, &token, json!([plan_op("q2", "alpha", "approve", 2, &keys, &[], answers.clone())])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let b = bundle(&app, &token).await;
    let alpha = &deck(&b, "alpha")["plan"];
    assert_eq!((alpha["version"].as_i64(), alpha["changes"].as_i64()), (Some(2), Some(4)), "{alpha}");
    assert_eq!(b["versions"][0]["answers"], answers);

    // Undo the newest decision: the answers go back to none, and version 2 waits again.
    let r = ops(&app, &token, json!([plan_op("q3", "alpha", "undo", 2, &[], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(decision(&pool, &owner, "alpha-idea").await, None);
    let b = bundle(&app, &token).await;
    assert_eq!(deck(&b, "alpha")["plan"]["next"]["n"], 2);
    assert_eq!(b["versions"], json!([]));

    // Keep version 1 instead: every proposal is a no, and nothing waits.
    let r = ops(&app, &token, json!([plan_op("q4", "alpha", "keep", 2, &keys, &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(decision(&pool, &owner, "alpha-owned").await.as_deref(), Some("no"));
    let b = bundle(&app, &token).await;
    assert_eq!(deck(&b, "alpha")["plan"]["next"], Value::Null);
    assert_eq!(b["versions"][0]["status"], "kept");
}

#[tokio::test]
async fn archiving_takes_a_plan_out_until_you_bring_it_back() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let r = ops(&app, &token, json!([{"op_id": "a1", "kind": "plan", "deck_key": "beta", "action": "archive", "at": "2026-11-06T10:00:00Z"}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let b = bundle(&app, &token).await;
    assert_eq!(deck(&b, "beta")["status"], "archived");
    assert_eq!(deck(&b, "beta")["plan"]["state"], "archived");
    // An archived plan can't be approved; another import doesn't bring it back.
    let r = ops(&app, &token, json!([plan_op("a2", "beta", "approve", 1, &["beta-1", "beta-2"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected");
    let mut d = doc_with_beta_plan();
    d["meta"]["guide_version"] = json!(7);
    import(&app, &token, &d).await;
    assert_eq!(deck(&bundle(&app, &token).await, "beta")["plan"]["state"], "archived");
    let r = ops(&app, &token, json!([{"op_id": "a3", "kind": "plan", "deck_key": "beta", "action": "restore", "at": "2026-11-06T10:00:00Z"}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(deck(&bundle(&app, &token).await, "beta")["plan"]["state"], "waiting");
}

#[tokio::test]
async fn keep_and_approve_refuse_changes_you_didnt_see() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    // Keep with only one of the two waiting changes named: refused, nothing answered.
    let r = ops(&app, &token, json!([plan_op("k1", "alpha", "keep", 2, &["alpha-idea"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");
    let r = ops(&app, &token, json!([plan_op("k2", "alpha", "keep", 2, &["alpha-idea", "alpha-owned"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
}

#[tokio::test]
async fn approving_keeps_an_answer_an_alias_holds_and_undo_brings_it_back() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    // An answer saved under an old key that now reaches alpha-idea through an alias.
    sqlx::query("INSERT INTO plan_key_aliases (owner_id, old_key, new_key, created_at) VALUES (?, 'old-idea', 'alpha-idea', '2026-11-01T00:00:00Z')")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, at, origin, op_id)
         VALUES (?, 'old-idea', 'unsure', 'Only if cheap', 'Old Card', '2026-11-01T00:00:00Z', 'yama', 'o-1')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let answers = json!([{"question": "Where did this come from?", "answer": "A booster"}]);
    let r = ops(&app, &token, json!([plan_op("al1", "alpha", "approve", 2, &["alpha-idea", "alpha-owned"], &[], answers)])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let (d, note, cut): (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("SELECT decision, note, cut FROM plan_reviews WHERE owner_id = ? AND swap_key = 'alpha-idea'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!((d.as_deref(), note.as_deref(), cut.as_deref()), (Some("want"), Some("Only if cheap"), Some("Old Card")));
    let r = ops(&app, &token, json!([plan_op("al2", "alpha", "undo", 2, &[], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let (d, note): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT decision, note FROM plan_reviews WHERE owner_id = ? AND swap_key = 'alpha-idea'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!((d.as_deref(), note.as_deref()), (Some("unsure"), Some("Only if cheap")));
}

#[tokio::test]
async fn a_change_edited_after_you_looked_is_never_approved_unseen() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let seen = deck(&bundle(&app, &token).await, "beta")["plan"]["next"]["hash"].as_str().unwrap().to_string();
    // The plan file edits beta-1's cut under the same key.
    let mut d = doc_with_beta_plan();
    swap_mut(&mut d, "beta-1")["why"] = json!("Even faster");
    import(&app, &token, &d).await;
    let mut op = plan_op("h1", "beta", "approve", 1, &["beta-1", "beta-2"], &[], json!([]));
    op["hash"] = json!(seen);
    let r = ops(&app, &token, json!([op])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");
    assert!(r["results"][0]["error"].as_str().unwrap().contains("edited since you opened it"), "{r}");

    // Approved, then edited again: the change waits as a new version and leaves the plan in force.
    let r = ops(&app, &token, json!([plan_op("h2", "beta", "approve", 1, &["beta-1", "beta-2"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    sqlx::query("UPDATE plan_swaps SET why = 'Edited', updated_at = '2099-01-01T00:00:00Z' WHERE owner_id = ? AND ext_key = 'beta-1'")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plan_meta SET revision = revision + 1 WHERE owner_id = ?").bind(&owner).execute(&pool).await.unwrap();
    let b = bundle(&app, &token).await;
    let beta = &deck(&b, "beta")["plan"];
    assert_eq!(beta["next"]["keys"], json!(["beta-1"]), "{beta}");
    assert_eq!(beta["changes"], 1, "only beta-2 is in force: {beta}");
}

#[tokio::test]
async fn an_archived_plans_decisions_stay_as_they_were() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let r = ops(&app, &token, json!([plan_op("u1", "beta", "approve", 1, &["beta-1", "beta-2"], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let r = ops(&app, &token, json!([{"op_id": "u2", "kind": "plan", "deck_key": "beta", "action": "archive", "at": crate::util::now()}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let r = ops(&app, &token, json!([plan_op("u3", "beta", "undo", 1, &[], &[], json!([]))])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");
}

#[tokio::test]
async fn an_approval_made_before_a_newer_answer_is_refused() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let seen = deck(&bundle(&app, &token).await, "beta")["plan"]["next"]["hash"].as_str().unwrap().to_string();
    // Another device says no to beta-2 after this page loaded.
    let r = ops(&app, &token, json!([{"op_id": "n1", "kind": "review", "swap_key": "beta-2", "decision": "no", "at": crate::util::now()}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let mut op = plan_op("n2", "beta", "approve", 1, &["beta-1", "beta-2"], &[], json!([]));
    op["hash"] = json!(seen);
    let r = ops(&app, &token, json!([op])).await;
    assert_eq!(r["results"][0]["status"], "rejected", "{r}");
}
