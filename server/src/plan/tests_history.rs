//! A plan's history (`history.rs`, 21 Nov 2026): what assistants record about where a plan and its
//! changes came from, read back with Yama's own record of the plan, through the real router and
//! the MCP on the synthetic plan file in `tests.rs`.

use super::*;

fn rpc(tool: &str, args: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
}

async fn call(app: &Router, key: &str, tool: &str, args: Value) -> (bool, String) {
    let (status, r) = send(app, Method::POST, "/mcp", Some(key), Some(rpc(tool, args))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
}

async fn mcp_key(app: &Router, session: &str) -> String {
    let (status, made) = send(app, Method::POST, "/api/me/tokens", Some(session), Some(json!({"name": "Claude", "scope": "mcp"}))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    made["token"].as_str().unwrap().to_string()
}

async fn entries(pool: &SqlitePool, owner: &str) -> Vec<(String, String, Option<String>, String)> {
    sqlx::query_as("SELECT on_date, what, group_label, cards FROM plan_history WHERE owner_id = ? ORDER BY on_date, recorded_at")
        .bind(owner)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_plans_history_says_where_it_and_each_change_came_from() {
    let (app, pool, owner, session) = setup().await;
    import(&app, &session, &doc()).await;
    let key = mcp_key(&app, &session).await;

    // Before anyone records anything: Yama's own record, and a prompt to record the request.
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Where it came from: the commander-decks plan file, guide version 6 (dated 2026-10-18, commit abc1234)"), "{text}");
    assert!(text.contains("Nobody has recorded the request behind it"), "{text}");
    assert!(text.contains("- Core: 1 change, 1 in the plan, 0 left out. Nobody has recorded where it came from."), "{text}");
    assert!(text.contains("Version 2 went in, from the commander-decks plan file, guide version 6") && text.contains("Proposal Card for Sol Ring"), "{text}");
    assert!(text.contains("Left out: Spare Card (Spare Card names no card to cut)."), "{text}");
    let (err, text) = call(&app, &key, "get_plan", json!({"plan": "alpha"})).await;
    assert!(!err && text.contains("History: nobody has recorded the request behind this plan"), "{text}");

    // An entry about one group and one change, as the plan names them whatever the case.
    let entry = json!({"plan": "alpha", "on": "2026-10-18", "what": "Proposals for answers to flyers.", "asked": "Can we add answers to flyers?",
                       "conversation": "T3 thread: Riders flyers", "work": "commander-decks 1d931794", "group": "core", "cards": ["proposal card"],
                       "op_id": "history-0001"});
    let (err, text) = call(&app, &key, "record_plan_history", entry.clone()).await;
    assert!(!err && text.contains("Recorded in Alpha Deck's history (plan key alpha, entry ") && text.contains("about the group \"Core\": Proposal Card"), "{text}");
    let first = text.split("entry ").nth(1).unwrap().split(')').next().unwrap().to_string();
    // A retry records nothing new; the same op_id for something else is refused.
    let (err, text) = call(&app, &key, "record_plan_history", entry.clone()).await;
    assert!(!err && text.contains("already in Alpha Deck's history") && text.contains(&first), "{text}");
    let mut other = entry.clone();
    other["what"] = json!("Something else");
    let (err, text) = call(&app, &key, "record_plan_history", other).await;
    assert!(err && text.contains("op_id history-0001 was used for another entry"), "{text}");
    // Without an op_id, the very same entry is still recorded once.
    let mut again = entry.clone();
    again.as_object_mut().unwrap().remove("op_id");
    let (err, text) = call(&app, &key, "record_plan_history", again).await;
    assert!(!err && text.contains("already in"), "{text}");
    let want: Vec<(String, String, Option<String>, String)> =
        vec![("2026-10-18".into(), "Proposals for answers to flyers.".into(), Some("Core".into()), "[\"Proposal Card\"]".into())];
    assert_eq!(entries(&pool, &owner).await, want);

    // What isn't in the plan is refused, naming what is.
    for (args, says) in [
        (json!({"plan": "alpha", "on": "2026-10-18", "what": "x", "group": "Bracket 9"}), "its groups are Core"),
        (json!({"plan": "alpha", "on": "2026-10-18", "what": "x", "cards": ["Not A Card"]}), "no change in Alpha Deck's plan puts in or takes out Not A Card"),
        (json!({"plan": "alpha", "on": "2099-01-01", "what": "x"}), "is in the future"),
        (json!({"plan": "alpha", "on": "18 Oct", "what": "x"}), "isn't a YYYY-MM-DD date"),
        (json!({"plan": "alpha", "on": "2026-10-18", "what": "x", "replaces": "no-such-entry", "op_id": "history-x001"}), "has no entry no-such-entry"),
        (json!({"plan": "alpha", "on": "2026-10-18", "what": "x", "replaces": "no-such-entry"}), "replaces needs an op_id"),
        (json!({"plan": "nobody", "on": "2026-10-18", "what": "x"}), "not found"),
    ] {
        let (err, text) = call(&app, &key, "record_plan_history", args.clone()).await;
        assert!(err && text.to_lowercase().contains(&says.to_lowercase()), "{args}: {text}");
    }
    assert_eq!(entries(&pool, &owner).await.len(), 1, "nothing refused was recorded");

    // The request behind the whole plan, then a correction of it.
    let (err, text) = call(&app, &key, "record_plan_history", json!({"plan": "Alpha Deck", "on": "2026-10-01", "what": "The precon upgrade began.", "asked": "Upgrade Alpha"})).await;
    assert!(!err, "{text}");
    let plan_entry = text.split("entry ").nth(1).unwrap().split(')').next().unwrap().to_string();
    let (err, text) = call(
        &app,
        &key,
        "record_plan_history",
        json!({"plan": "alpha", "on": "2026-10-02", "what": "The precon upgrade began.", "asked": "Upgrade Alpha, please", "replaces": plan_entry,
               "op_id": "history-fix1"}),
    )
    .await;
    assert!(!err && text.contains(&format!("replacing entry {plan_entry}")), "{text}");
    // Its retry after a lost reply is recognised, though the entry it replaced is gone.
    let (err, text) = call(
        &app,
        &key,
        "record_plan_history",
        json!({"plan": "alpha", "on": "2026-10-02", "what": "The precon upgrade began.", "asked": "Upgrade Alpha, please", "replaces": plan_entry,
               "op_id": "history-fix1"}),
    )
    .await;
    assert!(!err && text.contains("already in Alpha Deck's history"), "{text}");
    // The same op_id for a correction of another entry is another operation: refused.
    let (err, text) = call(
        &app,
        &key,
        "record_plan_history",
        json!({"plan": "alpha", "on": "2026-10-02", "what": "The precon upgrade began.", "asked": "Upgrade Alpha, please", "replaces": "another-entry",
               "op_id": "history-fix1"}),
    )
    .await;
    assert!(err && text.contains("op_id history-fix1 was used for another entry"), "{text}");
    let all = entries(&pool, &owner).await;
    assert_eq!(all.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), vec!["2026-10-02", "2026-10-18"], "the corrected entry replaced the first");

    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("The request behind it: 2026-10-02 (recorded ") && text.contains("They asked: \"Upgrade Alpha, please\""), "{text}");
    assert!(text.contains("- Core: 1 change, 1 in the plan, 0 left out. 1 recorded entry below."), "{text}");
    assert!(text.contains("- 2026-10-18: Recorded (entry ") && text.contains("Conversation: T3 thread: Riders flyers. Work: commander-decks 1d931794."), "{text}");
    let (err, text) = call(&app, &key, "get_plan", json!({"plan": "alpha"})).await;
    assert!(!err && text.contains("History: 2 recorded entries."), "{text}");

    // One change's story: where it came from, the version that took it in, every answer.
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha", "card": "Proposal Card"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Proposal Card for Sol Ring (proposal, group \"Core\"):"), "{text}");
    assert!(text.contains("from the commander-decks plan file, guide version 6") && text.contains("- When (as the plan says): Now"), "{text}");
    assert!(text.contains("- Version 2 (") && text.contains(") took it in"), "{text}");
    assert!(text.contains("want (Yama, taking a version in)"), "{text}");
    assert!(text.contains("They asked: \"Can we add answers to flyers?\""), "{text}");
    // Their own answer joins the trail.
    let (err, text) = call(&app, &key, "answer_review", json!({"plan": "alpha", "card_in": "Proposal Card", "decision": "no", "note": "Superseded"})).await;
    assert!(!err, "{text}");
    let id = text.split("Change id: ").nth(1).unwrap().split_whitespace().next().unwrap().to_string();
    let (err, text) = call(&app, &key, "apply_change", json!({"id": id})).await;
    assert!(!err, "{text}");
    let (_, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha", "card": "proposal"})).await;
    assert!(text.contains("want (Yama, taking a version in); ") && text.contains("no \"Superseded\" (through an assistant)"), "{text}");
    let (_, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(text.contains(": Answered no on Proposal Card for Sol Ring: \"Superseded\" (through an assistant)."), "the plan's timeline has their answers too: {text}");
    assert!(!text.contains("Answered want on"), "Yama's own answers are its versions: {text}");
    let (_, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha", "card": "Spare Card"})).await;
    assert!(text.contains("Spare Card (nothing named to cut)") && text.contains("left it out: Spare Card names no card to cut.") && text.contains("Nobody has recorded where this change came from"), "{text}");

    // An archived plan's history is still read, and still takes entries.
    sqlx::query("UPDATE plan_decks SET archived_at = '2026-11-21T00:00:00Z', archived_note = 'Archived by you' WHERE owner_id = ? AND key = 'alpha'")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(!err && text.contains("(plan key alpha, archived)") && text.contains("- 2026-11-21: Archived: Archived by you."), "{text}");
    let (err, text) = call(&app, &key, "record_plan_history", json!({"plan": "alpha", "on": "2026-11-21", "what": "Archived for now."})).await;
    assert!(!err, "{text}");
}

#[tokio::test]
async fn the_history_follows_renamed_keys_and_knows_the_cards_a_change_cuts() {
    let (app, pool, owner, session) = setup().await;
    import(&app, &session, &doc()).await;
    let key = mcp_key(&app, &session).await;
    // alpha-idea was renamed from old-idea: the old row stays, retired, as an import leaves it.
    {
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("CREATE TEMP TABLE renamed AS SELECT * FROM plan_swaps WHERE owner_id = ? AND ext_key = 'alpha-idea'")
            .bind(&owner)
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("UPDATE renamed SET id = 'old-idea-row', ext_key = 'old-idea', retired_at = '2026-11-01T00:00:00Z'").execute(&mut *conn).await.unwrap();
        sqlx::query("INSERT INTO plan_swaps SELECT * FROM renamed").execute(&mut *conn).await.unwrap();
        sqlx::query("DROP TABLE renamed").execute(&mut *conn).await.unwrap();
    }
    // An answer saved under the older key, newer than the one settling wrote: the plan's state
    // follows the alias to the live change, and so do the history's counts.
    sqlx::query("INSERT INTO plan_key_aliases (owner_id, old_key, new_key, created_at) VALUES (?, 'old-idea', 'alpha-idea', '2026-11-01T00:00:00Z')")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, at, origin, op_id)
         VALUES (?, 'old-idea', 'no', 'Not this one', NULL, '2098-01-01T00:00:00Z', 'yama', 'o-1')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(!err && text.contains("- Core: 1 change, 0 in the plan, 1 left out.") && !text.contains("not taken in yet"), "{text}");
    // The plan file's own answer (its review site's) is never an op: when it stands, the change's
    // story still ends with it.
    sqlx::query(
        "UPDATE plan_reviews SET decision = 'want', note = 'From the review site', at = '2098-06-01T00:00:00Z', origin = 'import'
         WHERE owner_id = ? AND swap_key = 'alpha-owned'",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha", "card": "Spare Card"})).await;
    assert!(!err && text.contains("(Yama, taking a version in); 2098-06-01 want \"From the review site\" (from the plan file)."), "{text}");
    let (_, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha"})).await;
    assert!(text.contains("- 2098-06-01: The plan file's answer on Spare Card (nothing named to cut): want \"From the review site\"."), "{text}");
    // An entry naming the card a change takes out is part of that change's story.
    let (err, text) = call(&app, &key, "record_plan_history", json!({"plan": "alpha", "on": "2026-10-20", "what": "Sol Ring comes out for a proposal.", "cards": ["sol ring"]})).await;
    assert!(!err && text.contains("It is about Sol Ring."), "{text}");
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha", "card": "Sol Ring"})).await;
    assert!(!err && text.contains("Proposal Card for Sol Ring (proposal") && text.contains("- Recorded 2026-10-20 (recorded ") && text.contains("Sol Ring comes out for a proposal."), "{text}");
    // A retry with its op_id is the entry stored, even after the plan renamed a card it names.
    let entry = json!({"plan": "alpha", "on": "2026-10-21", "what": "Before a rename.", "cards": ["Spare Card"], "op_id": "history-0002"});
    let (err, text) = call(&app, &key, "record_plan_history", entry.clone()).await;
    assert!(!err && text.contains("Recorded in"), "{text}");
    sqlx::query("UPDATE plan_swaps SET in_name = 'Spare Card Renamed' WHERE owner_id = ? AND ext_key = 'alpha-owned'").bind(&owner).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &key, "record_plan_history", entry).await;
    assert!(!err && text.contains("already in Alpha Deck's history"), "{text}");
    // And after an import moved the plan to another key, the old key's retry still finds it.
    let entry = json!({"plan": "alpha", "on": "2026-10-22", "what": "Before a move.", "op_id": "history-0003"});
    let (err, text) = call(&app, &key, "record_plan_history", entry.clone()).await;
    assert!(!err && text.contains("Recorded in"), "{text}");
    sqlx::query("UPDATE plan_decks SET key = 'alpha-moved', name = 'Alpha Moved' WHERE owner_id = ? AND key = 'alpha'").bind(&owner).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &key, "record_plan_history", entry.clone()).await;
    assert!(!err && text.contains("already in Alpha Moved's history"), "{text}");
    // Even once another plan has taken the old key, as an import does after moving a note's plan.
    sqlx::query("UPDATE plan_decks SET key = 'alpha' WHERE owner_id = ? AND key = 'beta'").bind(&owner).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &key, "record_plan_history", entry).await;
    assert!(!err && text.contains("already in Alpha Moved's history"), "{text}");
    // Two archived plans with one deck's name: the name alone doesn't say which.
    sqlx::query("UPDATE plan_decks SET name = 'Alpha Moved', archived_at = '2026-11-21T00:00:00Z' WHERE owner_id = ? AND key = 'alpha'")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plan_decks SET archived_at = '2026-11-21T00:00:00Z' WHERE owner_id = ? AND key = 'alpha-moved'").bind(&owner).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "Alpha Moved"})).await;
    assert!(err && text.contains("Several plans match \"Alpha Moved\": alpha, alpha-moved. Give the plan key."), "{text}");
    let (err, text) = call(&app, &key, "get_plan_history", json!({"plan": "alpha-moved"})).await;
    assert!(!err && text.contains("(plan key alpha-moved, archived)"), "{text}");
}
