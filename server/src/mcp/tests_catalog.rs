//! The tool catalog as a contract: what each kind of caller is offered, that every tool answers
//! cleanly whatever it is sent, that no tool reads another account's rows, and that the public
//! guide lists the same tools.

use super::tests::{call, key, rpc, seed_cards};
use super::{Question, QuestionToken, Via, tools};
use crate::auth::User;
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, power_user, send, user};
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::BTreeSet;
use std::path::PathBuf;

fn who(power: bool) -> User {
    User { id: "snapshot".into(), email: "snapshot@example.com".into(), display_name: "Snapshot".into(), is_admin: false, limited: false, power }
}

/// Every kind of caller: how they got in, and whether they may start simulations.
fn callers() -> Vec<(&'static str, User, Via)> {
    vec![
        ("script key, power user", who(true), Via::Key),
        ("OAuth sign-in, power user", who(true), Via::OAuth),
        ("script key", who(false), Via::Key),
        ("OAuth sign-in", who(false), Via::OAuth),
        ("Ask Claude, power user", who(true), Via::Question(Question::default())),
    ]
}

fn repo_file(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn names(tools: &[Value]) -> Vec<&str> {
    tools.iter().map(|t| t["name"].as_str().unwrap()).collect()
}

#[test]
fn every_tool_is_well_formed() {
    let full = tools::list(&who(true), &Via::Key);
    let mut seen = BTreeSet::new();
    for t in &full {
        let name = t["name"].as_str().expect("a name");
        assert!(seen.insert(name), "{name} is listed twice");
        assert!(!name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "{name}: tool names are lower_snake_case");
        assert!(t["title"].as_str().is_some_and(|s| !s.trim().is_empty()), "{name} has no title");
        assert!(t["description"].as_str().is_some_and(|s| !s.trim().is_empty()), "{name} has no description");
        let schema = &t["inputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        assert!(schema["properties"].is_object(), "{name} has no properties object");
        assert_eq!(schema["additionalProperties"], false, "{name} accepts unknown arguments");
        for required in schema["required"].as_array().into_iter().flatten() {
            assert!(schema["properties"].get(required.as_str().unwrap()).is_some(), "{name} requires {required}, which it doesn't define");
        }
        assert!(schema.get("required").is_none_or(|r| r.as_array().is_some_and(|r| !r.is_empty())), "{name}: an empty required list");
        unbounded_text(schema, name, "");
        assert!(t["annotations"]["readOnlyHint"].is_boolean() && t["annotations"]["openWorldHint"].is_boolean(), "{name} lacks annotations");
        if t["annotations"]["readOnlyHint"] == false {
            assert!(t["annotations"]["destructiveHint"].is_boolean() && t["annotations"]["idempotentHint"].is_boolean(), "{name}: a write says whether it destroys and repeats");
        }
    }
    // What each caller may not have.
    for (label, user, via) in callers() {
        let tools = tools::list(&user, &via);
        let names = names(&tools);
        let decides = names.contains(&"apply_change") || names.contains(&"discard_change");
        assert_eq!(decides, via.may_apply(), "{label}: only outside clients apply and discard");
        let simulates = ["start_lab_run", "more_lab_games", "run_lab_again"].iter().any(|n| names.contains(n));
        assert_eq!(simulates, user.power, "{label}: only power users start simulations");
    }
}

/// Every text argument, at any depth, says how long it may be or which values it takes.
fn unbounded_text(schema: &Value, tool: &str, path: &str) {
    let text = match &schema["type"] {
        Value::String(t) => t == "string",
        Value::Array(types) => types.iter().any(|t| t == "string"),
        _ => false,
    };
    assert!(!text || schema.get("enum").is_some() || schema["maxLength"].as_u64().is_some_and(|n| n > 0), "{tool}: {path} is text with no maxLength and no enum");
    for (name, property) in schema["properties"].as_object().into_iter().flatten() {
        unbounded_text(property, tool, &format!("{path}.{name}"));
    }
    if let Some(items) = schema.get("items") {
        unbounded_text(items, tool, &format!("{path}[]"));
    }
}

#[test]
fn annotations_say_where_a_tool_reaches() {
    let full = tools::list(&who(true), &Via::Key);
    let outside = |name: &str| full.iter().find(|t| t["name"] == name).unwrap()["annotations"]["openWorldHint"] == true;
    // card_printings reads Yama's own printings and prices (since 2026-11-02): no outside request.
    assert!(!outside("card_printings"));
    // check_stores only stages, but applying it reads the stores' sites.
    assert!(outside("check_stores"));
    for reaches in ["search_scryfall", "commander_recommendations", "find_combos", "public_deck", "rules_lookup"] {
        assert!(outside(reaches), "{reaches}");
    }
    for local in ["find_cards", "card", "deck", "deck_analysis", "edit_deck", "apply_change", "save_research", "store_stock"] {
        assert!(!outside(local), "{local}");
    }
    // A read says nothing about destroying or repeating: those hints are for writes.
    for t in &full {
        if t["annotations"]["readOnlyHint"] == true {
            assert!(t["annotations"].get("destructiveHint").is_none() && t["annotations"].get("idempotentHint").is_none(), "{}", t["name"]);
        }
    }
}

// ── every tool answers cleanly ──────────────────────────────────────────────

/// What `tool_error` says for a fault that isn't the caller's: a tool must never answer with it
/// for arguments alone.
const SERVER_FAULT: &str = "a server error";

async fn listed(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, r) = send(app, Method::POST, "/mcp", Some(token), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    r["result"]["tools"].as_array().unwrap().clone()
}

/// One call, checked for a clean answer: a result with text, never a protocol error or a fault.
async fn clean_call(app: &axum::Router, token: &str, tool: &str, args: Value) -> (bool, String) {
    let (status, r) = send(app, Method::POST, "/mcp", Some(token), Some(rpc("tools/call", json!({"name": tool, "arguments": args})))).await;
    assert_eq!(status, StatusCode::OK, "{tool} {args}: {r}");
    assert!(r.get("error").is_none(), "{tool} {args} is a protocol error: {r}");
    let text = r["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("{tool} {args} has no text: {r}")).to_string();
    let is_error = r["result"]["isError"].as_bool().unwrap_or_else(|| panic!("{tool} {args} has no isError: {r}"));
    assert!(!text.trim().is_empty(), "{tool} {args} answers with nothing");
    assert!(!text.contains(SERVER_FAULT), "{tool} {args} is a server fault: {text}");
    (is_error, text)
}

/// A value of the wrong type for a property, by its schema.
fn wrong(schema: &Value) -> Value {
    let types: Vec<&str> = match &schema["type"] {
        Value::String(t) => vec![t.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    if types.contains(&"string") { json!(12345) } else if types.contains(&"object") || types.contains(&"array") { json!("neither a list nor an object") } else { json!({"wrong": ["type"]}) }
}

#[tokio::test]
async fn every_tool_answers_empty_and_wrong_arguments_cleanly() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    // Each pass is its own account, so no pass meets the per-account call limit.
    let (_, empty) = power_user(&pool, "empty@example.com").await;
    let empty = key(&app, &empty, Some("mcp")).await;
    let (_, typed) = power_user(&pool, "typed@example.com").await;
    let typed = key(&app, &typed, Some("mcp")).await;
    let (asker, _) = power_user(&pool, "asker@example.com").await;
    let ask = QuestionToken::mint(&asker, Question { conversation_id: "c".into(), message_id: "m".into() });
    let (_, plain) = user(&pool, "plain@example.com").await;
    let plain = key(&app, &plain, Some("mcp")).await;

    let tools = listed(&app, &empty).await;
    assert!(tools.len() >= 64, "{} tools", tools.len());
    for t in &tools {
        let name = t["name"].as_str().unwrap();
        clean_call(&app, &empty, name, json!({})).await;
        // Every argument present and of the wrong type: refused or ignored, never a fault.
        let mut args = serde_json::Map::new();
        for (property, schema) in t["inputSchema"]["properties"].as_object().unwrap() {
            // `chunk` is the registry's and is refused before the tool runs; it has its own test.
            if property != "chunk" {
                args.insert(property.clone(), wrong(schema));
            }
        }
        clean_call(&app, &typed, name, Value::Object(args)).await;
    }
    for token in [ask.token.as_str(), plain.as_str()] {
        for t in listed(&app, token).await {
            clean_call(&app, token, t["name"].as_str().unwrap(), json!({})).await;
        }
    }
    // A closed set of values is checked, not quietly replaced by the default.
    let (err, text) = clean_call(&app, &plain, "find_cards", json!({"query": "t:artifact", "order": "price"})).await;
    assert!(err && text.contains("isn't name, mv, edhrec or color"), "{text}");
    for order in ["name", "mv", "cmc", "edhrec", "color"] {
        let (err, text) = clean_call(&app, &plain, "find_cards", json!({"query": "t:artifact", "order": order})).await;
        assert!(!err, "{order}: {text}");
    }
    // An open question can be long, and its answer too: the schema says what the plan takes.
    let listed_tools = listed(&app, &plain).await;
    let approve = listed_tools.iter().find(|t| t["name"] == "approve_plan").unwrap();
    assert_eq!(approve["inputSchema"]["properties"]["answers"]["items"]["properties"]["question"]["maxLength"], 2000);
    assert_eq!(approve["inputSchema"]["properties"]["answers"]["items"]["properties"]["answer"]["maxLength"], 2000);
    let (err, text) = clean_call(&app, &plain, "find_cards", json!({"query": "t:artifact", "page": 0})).await;
    assert!(!err, "page 0 is the first page, as before: {text}");
    let (err, text) = clean_call(&app, &plain, "deck", json!({"deck": "x".repeat(400)})).await;
    assert!(err && text == "deck is too long: at most 300 characters", "{text}");
    // The limit a schema states is the limit applied, also where a handler had none of its own.
    let (err, text) = clean_call(&app, &plain, "check_list", json!({"list": format!("{}1 Sol Ring", " x".repeat(40_000))})).await;
    assert!(err && text == "list is too long: at most 65536 characters", "{text}");
    let (err, text) = clean_call(&app, &plain, "card", json!({"names": ["Sol Ring", "y".repeat(301)]})).await;
    assert!(err && text == "names: each one is at most 300 characters", "{text}");
    let (err, text) = clean_call(&app, &plain, "games", json!({"search": "z".repeat(1001)})).await;
    assert!(err && text == "search is too long: at most 1000 characters", "{text}");
    // Arguments that aren't an object at all.
    for args in [Value::Null, json!([]), json!("text")] {
        clean_call(&app, &plain, "overview", args.clone()).await;
        clean_call(&app, &plain, "deck_analysis", args).await;
    }
}

// ── no tool reads another account's rows ────────────────────────────────────

/// Arguments that name something an account owns. (`note` isn't here: on most tools it is a
/// sentence of free text, and the one tool where it is a note's id, `track_build`, also takes
/// `deck`.) A tool with one of these must be in
/// `isolation_cases` (or `ISOLATION_ELSEWHERE`), so a new tool that takes an id can't ship
/// without its two-account check.
const OWNED: [&str; 13] = ["id", "deck", "plan", "key", "store", "stores", "container", "from", "to", "other", "entrants", "left", "right"];

/// Tools with an owned argument whose isolation is tested where their fixtures live.
const ISOLATION_ELSEWHERE: [(&str, &str); 1] = [("dataset", "datasets/tests.rs, mcp_reads_are_owner_scoped_and_never_offer_dataset_import_permissions")];

/// Text only account A's rows hold. None of the ids and names B sends contains it.
const SECRET: &str = "SECRET";

struct Fixture {
    deck: String,
    change: String,
}

/// One of everything for account A, each carrying `SECRET` in text that only reading A's rows
/// can produce.
async fn one_of_everything(app: &axum::Router, pool: &SqlitePool, owner: &str, token: &str) -> Fixture {
    let card = |id: &str, name: &str, board| DeckCard { oracle_id: id.into(), name: name.into(), qty: 1, board };
    let cards = vec![card("o-cmd", "Test Commander", Board::Commander), card("o-sol", "Sol Ring", Board::Main), card("o-forest", "Forest", Board::Main)];
    let deck = crate::decks::create_deck_with_cards(pool, owner, "SECRET elves", None, cards).await.unwrap();
    sqlx::query(
        "INSERT INTO plan_decks (id, owner_id, key, name, source, status, commander, created_at, updated_at)
         VALUES ('plan-row-a', ?, 'plan-a', 'SECRET plan', 'import', 'active', '[\"Test Commander\"]', 't', 't')",
    )
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, out_name, in_name, why, created_at, updated_at)
         VALUES ('swap-a', ?, 'plan-row-a', 'swap-key-a', 'proposed', 'swap', 'buy', 'Forest', 'Arcane Signet', 'SECRET reason', 't', 't')",
    )
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO plan_stores (id, owner_id, key, name, kind, origin, created_at, updated_at)
         VALUES ('store-row-a', ?, 'store-a', 'SECRET Games', 'local', 'yama', 't', 't')",
    )
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    let note = json!({"schema": "yama-research/1", "id": "note-a", "title": "SECRET audit", "generated_at": "2026-11-01T00:00:00Z",
        "decks": [{"key": "energy", "name": "SECRET energy", "commander": "Saheeli", "recommended_build": "b3",
                   "builds": [{"id": "b3", "label": "Bracket 3", "bracket": 3, "list": "Commander\n1 Saheeli\nDeck\n99 Island",
                               "swaps": [{"id": "monitor", "card_in": "Thought Monitor", "card_out": "Glimmer of Genius"}]}]}]});
    crate::deck_research::save(pool, owner, &note).await.unwrap();
    sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat, note) VALUES ('game-a', 'in_person', ?, 'finished', '2026-11-01', 9, 0, 'SECRET game')")
        .bind(owner)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO game_seats (game_id, seat, guest_name, commander_name) VALUES ('game-a', 0, 'SECRET Kelly', 'Atraxa')").execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO lab_experiments (id, owner_id, name, status, spec, games_total, games_done, engine, card_data, runner, difficulty, created_at, updated_at)
         VALUES ('run-a', ?, 'SECRET experiment', 'done', '{}', 100, 100, 'phase', 'x', 'x', 'Easy', '2026-11-01T00:00:00Z', 't')",
    )
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES ('group-a', 'SECRET night', ?, 'JOINA', 't')").bind(owner).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, guest_name, created_at) VALUES ('member-a', 'group-a', ?, NULL, 't')").bind(owner).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES ('box-a', ?, 'binder', 'Box A', 't')").bind(owner).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, container_id, note, created_at, updated_at) VALUES ('item-a', ?, 'p-o-sol', 3, 'box-a', 'SECRET copy', 't', 't')")
        .bind(owner)
        .execute(pool)
        .await
        .unwrap();
    let (err, staged) = call(app, token, "edit_deck", json!({"deck": deck, "add": ["Arcane Signet"], "note": "SECRET change"})).await;
    assert!(!err, "{staged}");
    let change = staged.lines().find_map(|l| l.strip_prefix("Change id: ")).unwrap().trim().to_string();
    Fixture { deck, change }
}

/// What account A must get from a call, so a case can't pass only because its arguments are wrong.
#[derive(Clone, Copy, PartialEq)]
enum ForOwner {
    /// A's own rows come back: the answer holds `SECRET`.
    Shows,
    /// The call works for A (a staged change, or an answer with nothing secret in it).
    Works,
    /// Not checked: the tool needs more than this fixture has (an outside service, a finished
    /// lab run with games), so for A it may refuse for another reason.
    Unchecked,
}
use ForOwner::{Shows, Unchecked, Works};

/// Every tool that takes something an account owns, named with account A's ids.
fn isolation_cases(f: &Fixture) -> Vec<(&'static str, Value, ForOwner)> {
    let deck = &f.deck;
    let list = "Commander\n1 Test Commander\nDeck\n1 Sol Ring\n98 Forest";
    vec![
        ("deck", json!({"deck": deck}), Shows),
        ("deck_analysis", json!({"deck": deck}), Works),
        ("deck_history", json!({"deck": deck}), Works),
        ("sample_hands", json!({"deck": deck}), Unchecked),
        ("mana_test", json!({"deck": deck, "cost": "{1}{G}"}), Unchecked),
        ("compare_decks", json!({"left": {"deck": deck}, "right": {"list": list}}), Works),
        ("compare_decks", json!({"left": {"list": list}, "right": {"deck": deck}}), Works),
        ("find_combos", json!({"deck": deck, "share_list": true}), Unchecked),
        ("commander_recommendations", json!({"commander": "Test Commander", "deck": deck}), Unchecked),
        ("edit_deck", json!({"deck": deck, "add": ["Arcane Signet"]}), Works),
        ("delete_deck", json!({"deck": deck}), Works),
        ("save_deck", json!({"deck": deck, "list": list}), Unchecked),
        ("start_lab_run", json!({"deck": deck, "add": ["Arcane Signet"]}), Unchecked),
        ("start_lab_run", json!({"mode": "compare", "list": list, "other": deck}), Unchecked),
        ("start_lab_run", json!({"mode": "versus", "entrants": [deck, deck]}), Unchecked),
        ("add_wish", json!({"name": "Sol Ring", "deck": deck}), Works),
        ("plan_deck", json!({"key": "plan-a"}), Unchecked),
        ("review_queue", json!({"plan": "plan-a"}), Shows),
        ("propose_swap", json!({"plan": "plan-a", "card_in": "Sol Ring"}), Works),
        ("answer_review", json!({"plan": "plan-a", "card_in": "Arcane Signet", "decision": "want"}), Works),
        ("mark_bought", json!({"plan": "plan-a", "card_in": "Arcane Signet"}), Unchecked),
        ("mark_installed", json!({"plan": "plan-a", "card_in": "Arcane Signet"}), Unchecked),
        ("swap_in_prints", json!({"plan": "plan-a"}), Unchecked),
        ("approve_plan", json!({"plan": "plan-a"}), Unchecked),
        ("research", json!({"id": "note-a"}), Shows),
        ("research", json!({"id": "note-a", "deck": "energy"}), Shows),
        ("review_research", json!({"id": "note-a", "op_id": "op-1", "target": "deck:energy", "decision": "b3", "note": null, "expected_version": 0, "target_hash": "x"}), Unchecked),
        ("track_build", json!({"note": "note-a", "deck": "energy", "build": "b3"}), Works),
        ("game", json!({"id": "game-a"}), Shows),
        ("playgroups", json!({"id": "group-a"}), Works),
        ("lab_run", json!({"id": "run-a"}), Unchecked),
        ("lab_games", json!({"id": "run-a"}), Unchecked),
        ("lab_games", json!({"id": "run-a", "deck": "e0"}), Unchecked),
        ("more_lab_games", json!({"id": "run-a"}), Unchecked),
        ("run_lab_again", json!({"id": "run-a"}), Unchecked),
        ("cancel_lab_run", json!({"id": "run-a"}), Unchecked),
        ("store_stock", json!({"store": "store-a", "cards": ["Sol Ring"]}), Shows),
        ("set_store_preference", json!({"store": "store-a", "preference": "never"}), Works),
        ("check_stores", json!({"stores": ["store-a"]}), Unchecked),
        ("shopping_trip", json!({"stores": ["store-a"]}), Works),
        ("add_to_collection", json!({"card": "Sol Ring", "container": "Box A"}), Works),
        ("move_cards", json!({"card": "Sol Ring", "from": "Box A", "to": "Box A"}), Unchecked),
        ("set_condition", json!({"container": "Box A", "condition": "LP"}), Works),
        ("changes", json!({"id": f.change}), Shows),
        ("discard_change", json!({"id": f.change}), Works),
        ("apply_change", json!({"id": f.change}), Unchecked),
    ]
}

#[tokio::test]
async fn no_tool_reads_or_changes_another_accounts_rows() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, a_session) = power_user(&pool, "owner@example.com").await;
    let (_, b_session) = power_user(&pool, "other@example.com").await;
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;
    let fixture = one_of_everything(&app, &pool, &a, &a_key).await;
    let cases = isolation_cases(&fixture);

    // Every tool that takes something owned has a case here, or its test elsewhere.
    let covered: BTreeSet<&str> = cases.iter().map(|c| c.0).chain(ISOLATION_ELSEWHERE.iter().map(|e| e.0)).collect();
    for t in listed(&app, &a_key).await {
        let name = t["name"].as_str().unwrap().to_string();
        let owned: Vec<&String> = t["inputSchema"]["properties"].as_object().unwrap().keys().filter(|p| OWNED.contains(&p.as_str())).collect();
        assert!(owned.is_empty() || covered.contains(name.as_str()), "{name} takes {owned:?} and has no two-account case in isolation_cases");
    }

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_changes").fetch_one(&pool).await.unwrap();
    // Account B, with A's ids: refused, or an answer from B's own (empty) account. Never A's rows.
    for (tool, args, _) in &cases {
        let (err, text) = clean_call(&app, &b_key, tool, args.clone()).await;
        assert!(!text.contains(SECRET), "{tool} {args} showed another account's data: {text}");
        // Only a wish may go through for B: an unknown deck is a label there, by design.
        assert!(err || *tool == "add_wish", "{tool} {args} worked on another account's rows: {text}");
    }
    // B's calls never touched A's rows: nothing staged for A, nothing of A's applied or discarded.
    let a_changes: Vec<(String, String)> = sqlx::query_as("SELECT id, status FROM assistant_changes WHERE owner_id = ? ORDER BY created_at").bind(&a).fetch_all(&pool).await.unwrap();
    assert_eq!(a_changes, vec![(fixture.change.clone(), "pending".to_string())]);
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_changes").fetch_one(&pool).await.unwrap();
    assert_eq!(after, before + 1, "only B's own wish was staged");

    // Account A, same arguments: the ids are real, so the refusals above were about the owner.
    for (tool, args, expect) in &cases {
        if *expect == Unchecked {
            continue;
        }
        let (err, text) = clean_call(&app, &a_key, tool, args.clone()).await;
        assert!(!err, "{tool} {args} fails for the owner too, so the case proves nothing: {text}");
        if *expect == Shows {
            assert!(text.contains(SECRET), "{tool} {args} doesn't show the owner's own data: {text}");
        }
    }
}

// ── the public guide ────────────────────────────────────────────────────────

#[test]
fn the_public_guide_lists_the_real_catalog() {
    let guide = std::fs::read_to_string(repo_file("../web/public/docs/mcp/index.html")).unwrap();
    let catalog = guide.split("<section id=\"catalog\">").nth(1).expect("the guide's catalog section").split("</section>").next().unwrap();
    let listed: Vec<&str> = catalog.split("<dt><code>").skip(1).map(|rest| rest.split("</code>").next().unwrap()).collect();
    let in_guide: BTreeSet<&str> = listed.iter().copied().collect();
    assert_eq!(in_guide.len(), listed.len(), "the guide lists a tool twice");
    let full = tools::list(&who(true), &Via::Key);
    let real: BTreeSet<&str> = names(&full).into_iter().collect();
    let missing: Vec<&&str> = real.difference(&in_guide).collect();
    let gone: Vec<&&str> = in_guide.difference(&real).collect();
    assert!(missing.is_empty() && gone.is_empty(), "web/public/docs/mcp/index.html is out of step with the tools: not in the guide {missing:?}; in the guide but not a tool {gone:?}");

    // The counts the guide states by hand: the total, and each group's.
    let digits = |text: &str| text.chars().filter(char::is_ascii_digit).collect::<String>().parse::<usize>().ok();
    let total = catalog.split("<p>").nth(1).and_then(|p| digits(p.split(" tools").next().unwrap_or_default())).expect("\"<n> tools\" at the top of the catalog");
    assert_eq!(total, real.len(), "the guide says {total} tools");
    let mut groups = 0;
    for group in catalog.split("<details>").skip(1) {
        let summary = group.split("<summary>").nth(1).and_then(|s| s.split("</summary>").next()).expect("a group summary");
        // The prompts and resources are a group too, with no tools in it and no count.
        if !group.contains("<dt><code>") {
            continue;
        }
        let stated = summary.rsplit('(').next().and_then(digits).unwrap_or_else(|| panic!("no count in {summary:?}"));
        assert_eq!(stated, group.matches("<dt><code>").count(), "the guide's count for {summary:?}");
        groups += 1;
    }
    assert!(groups >= 5, "{groups} groups");
}
