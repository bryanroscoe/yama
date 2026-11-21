//! One plan per deck, and nobody approves it (`versions.rs`, 20 Nov 2026): changes go in when they
//! arrive, clashing cuts are left out with why, answers and edits settle again, archive and restore,
//! through the real router on the synthetic plan file in `tests.rs`.

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

/// The fixture with a card to cut for alpha-owned, so every one of alpha's proposals goes in.
fn doc_with_cuts() -> Value {
    let mut d = doc();
    swap_mut(&mut d, "alpha-owned")["out"] = json!("Spare Cut");
    d
}

fn deck<'a>(b: &'a Value, key: &str) -> &'a Value {
    b["decks"].as_array().unwrap().iter().find(|d| d["key"] == key).unwrap()
}

async fn ops(app: &Router, token: &str, ops: Value) -> Value {
    let (status, r) = send(app, Method::POST, "/api/plan/inputs", Some(token), Some(ops)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    r
}

fn plan_op(id: &str, deck: &str, action: &str, version: Option<i64>) -> Value {
    json!({"op_id": id, "kind": "plan", "deck_key": deck, "action": action, "version": version, "keys": [], "skip": [], "answers": [],
           "hash": "seen", "at": crate::util::now()})
}

async fn answer(pool: &SqlitePool, owner: &str, key: &str) -> (Option<String>, Option<String>, Option<String>) {
    sqlx::query_as("SELECT decision, note, cut FROM plan_reviews WHERE owner_id = ? AND swap_key = ?")
        .bind(owner)
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or((None, None, None))
}

async fn decision(pool: &SqlitePool, owner: &str, key: &str) -> Option<String> {
    answer(pool, owner, key).await.0
}

/// Make a swap's content newer than its answer, as a plan file or note save editing it would.
async fn edit(pool: &SqlitePool, owner: &str, key: &str) {
    sqlx::query("UPDATE plan_swaps SET why = 'Edited', updated_at = '2099-01-01T00:00:00Z' WHERE owner_id = ? AND ext_key = ?")
        .bind(owner)
        .bind(key)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plan_meta SET revision = revision + 1 WHERE owner_id = ?").bind(owner).execute(pool).await.unwrap();
}

#[tokio::test]
async fn a_plan_file_goes_straight_into_the_plan() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let b = bundle(&app, &token).await;

    // Alpha had planned swaps from the plan file (version 1); its two proposals went in as
    // version 2, except alpha-owned, which names no card to cut.
    let alpha = &deck(&b, "alpha")["plan"];
    assert_eq!(alpha["state"], "in_progress", "{alpha}");
    assert_eq!(alpha["version"], 2);
    assert_eq!(alpha["next"], Value::Null);
    assert_eq!(alpha["changes"], 3, "two planned swaps and alpha-idea, not the stand-in: {alpha}");
    assert_eq!(alpha["questions"], json!(["Where did this come from?"]), "open questions stay, for the assistant");
    assert_eq!(decision(&pool, &owner, "alpha-idea").await.as_deref(), Some("want"));
    let (d, note, _) = answer(&pool, &owner, "alpha-owned").await;
    assert_eq!((d.as_deref(), note.as_deref()), (Some("unsure"), Some("Yama left this out: Spare Card names no card to cut.")));

    // Beta was only proposals: both went in as version 1 (two Island cuts don't clash).
    let beta = &deck(&b, "beta")["plan"];
    assert_eq!(beta["state"], "in_progress", "{beta}");
    assert_eq!((beta["version"].as_i64(), beta["changes"].as_i64()), (Some(1), Some(2)), "{beta}");
    assert_eq!(beta["next"], Value::Null);
    assert!(b["decks"].as_array().unwrap().iter().all(|d| d["plan"]["state"] != "waiting"), "nothing waits");

    let versions = b["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2, "{versions:?}");
    let a = versions.iter().find(|v| v["deck"] == "alpha").unwrap();
    assert_eq!((a["n"].as_i64(), a["status"].as_str()), (Some(2), Some("approved")));
    assert_eq!(a["changes"][0]["in"], "Proposal Card");
    assert_eq!(a["skipped"][0]["key"], "alpha-owned");
    assert_eq!(a["skipped"][0]["left_out"], "Spare Card names no card to cut.");
    assert_eq!(a["source"]["app"], "commander-decks");

    // The export side's inbox has each answer, then the plan op, marked as Yama's own.
    let inbox = super::super::inputs::inbox(&pool, &owner, None).await.unwrap();
    let plans: Vec<&super::super::inputs::InboxOp> = inbox.ops.iter().filter(|o| o.kind == "plan").collect();
    assert_eq!(plans.len(), 2);
    assert!(plans.iter().all(|o| o.record["action"] == "approve" && o.record["auto"] == true), "{:?}", plans[0].record);
    let reviews: Vec<(Option<&str>, Option<&str>)> =
        inbox.ops.iter().filter(|o| o.kind == "review").map(|o| (o.key.as_deref(), o.record["decision"].as_str())).collect();
    for want in [(Some("alpha-idea"), Some("want")), (Some("alpha-owned"), Some("unsure")), (Some("beta-1"), Some("want")), (Some("beta-2"), Some("want"))] {
        assert!(reviews.contains(&want), "{want:?} in {reviews:?}");
    }
    assert_eq!(b["reviews"]["beta-1"]["origin"], "yama");

    // The same file again changes nothing: no new versions.
    let mut again = doc_with_beta_plan();
    again["meta"]["guide_version"] = json!(7);
    import(&app, &token, &again).await;
    assert_eq!(bundle(&app, &token).await["versions"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn approve_keep_and_undo_from_an_old_page_are_refused() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    for (id, action) in [("p1", "approve"), ("p2", "keep"), ("p3", "undo")] {
        let r = ops(&app, &token, json!([plan_op(id, "beta", action, Some(1))])).await;
        assert_eq!(r["results"][0]["status"], "rejected", "{action}: {r}");
        assert!(r["results"][0]["error"].as_str().unwrap().contains("Plans don't wait for approval"), "{r}");
    }
    // Nothing changed: beta's changes are still in.
    assert_eq!(decision(&pool, &owner, "beta-2").await.as_deref(), Some("want"));
    assert_eq!(deck(&bundle(&app, &token).await, "beta")["plan"]["changes"], 2);
}

#[tokio::test]
async fn archiving_takes_a_plan_out_and_restoring_takes_in_what_came_meanwhile() {
    let (app, _pool, _owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let r = ops(&app, &token, json!([plan_op("a1", "beta", "archive", None)])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let b = bundle(&app, &token).await;
    assert_eq!(deck(&b, "beta")["status"], "archived");
    assert_eq!(deck(&b, "beta")["plan"]["state"], "archived");
    // A later plan file brings a new proposal; the archived plan doesn't take it in or come back.
    let mut d = doc_with_beta_plan();
    d["meta"]["guide_version"] = json!(7);
    d["plan"]["swaps"].as_array_mut().unwrap().push(json!({"key": "beta-3", "deck": "beta", "stage": "proposed", "role": "swap", "src": "buy",
        "out": "Sol Ring", "in": "Third Card"}));
    import(&app, &token, &d).await;
    let beta = deck(&bundle(&app, &token).await, "beta")["plan"].clone();
    assert_eq!(beta["state"], "archived", "{beta}");
    // Bring it back: the new proposal goes in with it.
    let r = ops(&app, &token, json!([plan_op("a2", "beta", "restore", None)])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let beta = deck(&bundle(&app, &token).await, "beta")["plan"].clone();
    assert_eq!((beta["state"].as_str(), beta["version"].as_i64(), beta["changes"].as_i64()), (Some("in_progress"), Some(2), Some(3)), "{beta}");
}

#[tokio::test]
async fn an_answer_you_give_stands_and_clearing_it_puts_the_change_back() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    // No to beta-2: it leaves the plan and stays out.
    let r = ops(&app, &token, json!([{"op_id": "n1", "kind": "review", "swap_key": "beta-2", "decision": "no", "at": crate::util::now()}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let b = bundle(&app, &token).await;
    assert_eq!(deck(&b, "beta")["plan"]["changes"], 1);
    assert_eq!(b["versions"].as_array().unwrap().iter().filter(|v| v["deck"] == "beta").count(), 1, "a no isn't a new version");
    // Unsure keeps it out too.
    let r = ops(&app, &token, json!([{"op_id": "n2", "kind": "review", "swap_key": "beta-2", "decision": "unsure", "at": "2099-01-01T00:00:00Z"}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(deck(&bundle(&app, &token).await, "beta")["plan"]["changes"], 1);
    assert_eq!(decision(&pool, &owner, "beta-2").await.as_deref(), Some("unsure"));
    // Clearing the answer makes it new again, and it goes back in as version 2.
    let r = ops(&app, &token, json!([{"op_id": "n3", "kind": "review", "swap_key": "beta-2", "decision": null, "at": "2099-01-02T00:00:00Z"}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(decision(&pool, &owner, "beta-2").await.as_deref(), Some("want"));
    let beta = deck(&bundle(&app, &token).await, "beta")["plan"].clone();
    assert_eq!((beta["version"].as_i64(), beta["changes"].as_i64()), (Some(2), Some(2)), "{beta}");
}

#[tokio::test]
async fn a_no_you_gave_stays_out_when_the_change_is_edited_later() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    let r = ops(&app, &token, json!([{"op_id": "e1", "kind": "review", "swap_key": "beta-2", "decision": "no", "note": "Not this one", "at": crate::util::now()}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    // The plan file rewords it: nobody looks before it would go in, so the no stands.
    edit(&pool, &owner, "beta-2").await;
    assert_eq!(super::super::versions::settle_all(&pool).await.unwrap(), 1);
    assert_eq!(answer(&pool, &owner, "beta-2").await, (Some("no".into()), Some("Not this one".into()), None));
    let beta = deck(&bundle(&app, &token).await, "beta")["plan"].clone();
    assert_eq!((beta["changes"].as_i64(), beta["next"].is_null()), (Some(1), true), "{beta}");
    assert_eq!(super::super::versions::settle_all(&pool).await.unwrap(), 0, "and it stays settled");
}

#[tokio::test]
async fn yamas_own_left_out_is_looked_at_again_when_its_change_is_fixed() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    assert_eq!(decision(&pool, &owner, "alpha-owned").await.as_deref(), Some("unsure"), "no card named to cut");
    // The plan file gives it a cut.
    sqlx::query("UPDATE plan_swaps SET out_name = 'Spare Cut', updated_at = '2099-01-01T00:00:00Z' WHERE owner_id = ? AND ext_key = 'alpha-owned'")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(super::super::versions::settle_all(&pool).await.unwrap(), 1);
    let (d, note, _) = answer(&pool, &owner, "alpha-owned").await;
    assert_eq!((d.as_deref(), note), (Some("want"), None), "Yama's reason goes with it");
}

#[tokio::test]
async fn a_change_edited_later_goes_in_again_keeping_the_note_and_cut() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_cuts()).await;
    // An answer saved under an old key that reaches alpha-idea through an alias, with a note and
    // a chosen cut, newer than what the import wrote.
    sqlx::query("INSERT INTO plan_key_aliases (owner_id, old_key, new_key, created_at) VALUES (?, 'old-idea', 'alpha-idea', '2026-11-01T00:00:00Z')")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, at, origin, op_id)
         VALUES (?, 'old-idea', 'want', 'Only if cheap', 'Other Card', '2098-01-01T00:00:00Z', 'yama', 'o-1')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    // The plan file edits alpha-idea under the same key: its old answer no longer stands, so it
    // is new again, and the next write takes it in as version 3.
    edit(&pool, &owner, "alpha-idea").await;
    let alpha = deck(&bundle(&app, &token).await, "alpha")["plan"].clone();
    assert_eq!(alpha["next"]["keys"], json!(["alpha-idea"]), "{alpha}");
    assert_eq!(alpha["changes"], 3, "alpha-idea is out until it's taken in again: {alpha}");
    let mut conn = pool.acquire().await.unwrap();
    let settled = super::super::versions::settle(&mut conn, &owner).await.unwrap();
    drop(conn);
    assert_eq!(settled.iter().map(|s| (s.deck_key.as_str(), s.version, s.kept)).collect::<Vec<_>>(), vec![("alpha", 3, 1)]);
    let (d, note, cut) = answer(&pool, &owner, "alpha-idea").await;
    assert_eq!((d.as_deref(), note.as_deref(), cut.as_deref()), (Some("want"), Some("Only if cheap"), Some("Other Card")));
    let alpha = deck(&bundle(&app, &token).await, "alpha")["plan"].clone();
    assert_eq!((alpha["version"].as_i64(), alpha["changes"].as_i64(), alpha["next"].is_null()), (Some(3), Some(4), true), "{alpha}");
}

#[tokio::test]
async fn settling_never_dates_its_answer_after_a_fast_device_clock() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    // A device a few minutes fast clears beta-2's answer; settling takes it in again, at now.
    let ahead = (chrono::Utc::now() + chrono::Duration::minutes(4)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let r = ops(&app, &token, json!([{"op_id": "f1", "kind": "review", "swap_key": "beta-2", "decision": null, "at": ahead}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    let at: String = sqlx::query_scalar("SELECT at FROM plan_reviews WHERE owner_id = ? AND swap_key = 'beta-2'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert!(at < ahead, "{at} is not after the device's {ahead}");
    // So a correctly timed answer right after still counts.
    let r = ops(&app, &token, json!([{"op_id": "f2", "kind": "review", "swap_key": "beta-2", "decision": "no", "at": crate::util::now()}])).await;
    assert_eq!(r["results"][0]["status"], "applied", "{r}");
    assert_eq!(decision(&pool, &owner, "beta-2").await.as_deref(), Some("no"));
}

#[tokio::test]
async fn the_server_settles_what_was_waiting_when_it_starts() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc_with_beta_plan()).await;
    // A proposal left unsettled, as every plan was before 20 Nov 2026.
    edit(&pool, &owner, "beta-1").await;
    assert_eq!(deck(&bundle(&app, &token).await, "beta")["plan"]["next"]["keys"], json!(["beta-1"]));
    assert_eq!(super::super::versions::settle_all(&pool).await.unwrap(), 1);
    let beta = deck(&bundle(&app, &token).await, "beta")["plan"].clone();
    assert_eq!((beta["version"].as_i64(), beta["changes"].as_i64(), beta["next"].is_null()), (Some(2), Some(2), true), "{beta}");
    // Again, nothing to do.
    assert_eq!(super::super::versions::settle_all(&pool).await.unwrap(), 0);
}

#[tokio::test]
async fn clashing_cuts_are_left_out_with_why() {
    let (app, pool, owner, token) = setup().await;
    let mut d = doc();
    let swaps = d["plan"]["swaps"].as_array_mut().unwrap();
    // A cut the plan in force already takes out (Print Card replaces Old Card), and a change that
    // cuts Sol Ring after alpha-idea does. alpha-owned names no cut at all.
    swaps.push(json!({"key": "alpha-gone", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Old Card", "in": "Late Card"}));
    swaps.push(json!({"key": "alpha-same", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Sol Ring", "in": "Rival Card"}));
    // A cut already made, with the plan file's fallback cut: the fallback is used, and it goes in.
    swaps.push(json!({"key": "alpha-later", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Old Card",
                      "later_out": "Fallback Card", "in": "Patient Card"}));
    // Basic lands: two changes may each take one out, and so may a change after the plan in force
    // cut one.
    swaps.push(json!({"key": "alpha-basic-planned", "deck": "alpha", "stage": "planned", "role": "swap", "src": "buy", "out": "Island", "in": "Planned Land"}));
    swaps.push(json!({"key": "alpha-land-1", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Island", "in": "Land One"}));
    swaps.push(json!({"key": "alpha-land-2", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Island", "in": "Land Two"}));
    // An optional extra cuts nothing: nothing is bought for a slot that isn't there.
    swaps.push(json!({"key": "alpha-extra", "deck": "alpha", "stage": "proposed", "role": "optional", "src": "buy", "out": null, "in": "Extra Card"}));
    import(&app, &token, &d).await;

    for key in ["alpha-idea", "alpha-later", "alpha-land-1", "alpha-land-2"] {
        assert_eq!(decision(&pool, &owner, key).await.as_deref(), Some("want"), "{key}");
    }
    for (key, why) in [
        ("alpha-owned", "Spare Card names no card to cut."),
        ("alpha-gone", "Old Card already goes out for Print Card."),
        ("alpha-same", "Proposal Card already takes out Sol Ring."),
        ("alpha-extra", "Extra Card is an optional extra: it names no card to cut."),
    ] {
        let (d, note, _) = answer(&pool, &owner, key).await;
        assert_eq!((d.as_deref(), note), (Some("unsure"), Some(format!("Yama left this out: {why}"))), "{key}");
    }
    // The change kept on its fallback cut keeps that cut, so the plan in force reads it.
    assert_eq!(answer(&pool, &owner, "alpha-later").await.2.as_deref(), Some("Fallback Card"));
    let b = bundle(&app, &token).await;
    let alpha = &deck(&b, "alpha")["plan"];
    assert_eq!((alpha["changes"].as_i64(), alpha["next"].is_null()), (Some(7), true), "three planned and four taken in: {alpha}");
    let v = b["versions"].as_array().unwrap().iter().find(|v| v["deck"] == "alpha").unwrap();
    let left: Vec<(&str, &str)> = v["skipped"].as_array().unwrap().iter().map(|s| (s["key"].as_str().unwrap(), s["left_out"].as_str().unwrap())).collect();
    assert_eq!(left.len(), 4, "{left:?}");
    assert!(left.contains(&("alpha-same", "Proposal Card already takes out Sol Ring.")), "{left:?}");
}

#[test]
fn left_out_names_each_clash_and_ignores_copies_basics_and_answers() {
    use super::super::versions::{Cut, Next, left_out};
    let cut = |key: &str, card_in: &str, out: Option<&str>| Cut { key: key.into(), card_in: card_in.into(), out: out.map(str::to_string), instead_of: None, gone_for: None };
    let next = Next {
        n: 1,
        keys: vec![],
        skipped: vec!["d".into()],
        proposed_at: None,
        source: json!({"kind": "yama"}),
        hash: String::new(),
        cuts: vec![
            cut("a", "One", Some("Thing")),
            cut("b", "Two", Some("thing")),
            cut("c", "Three", Some("Thing")),
            // Answered already: it stays as answered, whatever it cuts.
            cut("d", "Four", None),
            cut("n|x", "Copy", Some("Rats")),
            cut("n|x#2", "Copy", Some("Rats")),
            cut("s", "Snowy", Some("Snow-Covered Forest")),
            cut("t", "Snowy Two", Some("Snow-Covered Forest")),
            cut("u", "Nothing", Some(" ")),
            Cut { gone_for: Some("Earlier".into()), ..cut("g", "Gone", Some("Old")) },
        ],
    };
    let out = left_out(&next);
    assert_eq!(
        out,
        vec![
            ("b".to_string(), "One already takes out thing.".to_string()),
            ("c".to_string(), "One already takes out Thing.".to_string()),
            ("u".to_string(), "Nothing names no card to cut.".to_string()),
            ("g".to_string(), "Old already goes out for Earlier.".to_string()),
        ]
    );
    // Two changes (not copies of one) putting in the same card for the same cut: the second waits.
    let twice = Next { skipped: vec![], cuts: vec![cut("p", "Port Town", Some("Restless Anchorage")), cut("q", "Port Town", Some("Restless Anchorage"))], ..next };
    assert_eq!(left_out(&twice), vec![("q".to_string(), "Port Town already takes out Restless Anchorage.".to_string())]);
}
